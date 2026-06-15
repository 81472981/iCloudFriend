const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('fs/promises');
const legacyFs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pathExists, scanBackupRoot } = require('./backupIndex');

let mainWindow;
let settings;
let watcher;
let scanTimer;

const DEFAULT_SHARE_NAME = 'iCloudFriend';
const IOS_TARGET_FOLDER = 'Backup';

function defaultSettings() {
  return {
    backupRoot: path.join(app.getPath('pictures'), 'iCloudFriend Backups'),
    shareName: DEFAULT_SHARE_NAME
  };
}

function configPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

async function readSettings() {
  try {
    const data = await fs.readFile(configPath(), 'utf8');
    return { ...defaultSettings(), ...JSON.parse(data) };
  } catch {
    return defaultSettings();
  }
}

async function writeSettings(nextSettings) {
  settings = { ...settings, ...nextSettings };
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await fs.writeFile(configPath(), JSON.stringify(settings, null, 2));
  await ensureBackupFolders();
  restartWatcher();
  return settingsWithConnection();
}

function settingsWithConnection() {
  const hostname = os.hostname();
  const shareName = settings?.shareName || DEFAULT_SHARE_NAME;
  const encodedTarget = encodeURIComponent(IOS_TARGET_FOLDER);
  return {
    ...settings,
    hostname,
    backupTargetRoot: backupTargetRoot(),
    targetFolderName: IOS_TARGET_FOLDER,
    smbUrl: `smb://${hostname}/${shareName}`,
    smbTargetUrl: `smb://${hostname}/${shareName}/${encodedTarget}`,
    uncPath: `\\\\${hostname}\\${shareName}`,
    platform: process.platform,
    username: os.userInfo().username
  };
}

function backupTargetRoot() {
  return path.join(settings.backupRoot, IOS_TARGET_FOLDER);
}

async function ensureBackupFolders() {
  await fs.mkdir(settings.backupRoot, { recursive: true });
  await fs.mkdir(backupTargetRoot(), { recursive: true });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 940,
    minHeight: 640,
    title: 'iCloudFriend',
    backgroundColor: '#071620',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

async function initialize() {
  settings = await readSettings();
  await ensureBackupFolders();
  createWindow();
  restartWatcher();
}

app.whenReady().then(initialize);

app.on('window-all-closed', () => {
  stopWatcher();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

ipcMain.handle('settings:get', async () => settingsWithConnection());

ipcMain.handle('settings:update', async (_event, nextSettings) => {
  return writeSettings(nextSettings);
});

ipcMain.handle('dialog:choose-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose iCloudFriend backup folder',
    defaultPath: settings.backupRoot,
    properties: ['openDirectory', 'createDirectory']
  });

  if (result.canceled || result.filePaths.length === 0) {
    return settingsWithConnection();
  }

  return writeSettings({ backupRoot: result.filePaths[0] });
});

ipcMain.handle('folder:open', async () => {
  await ensureBackupFolders();
  return shell.openPath(backupTargetRoot());
});

ipcMain.handle('backup:scan', async () => {
  const stats = await scanBackupRoot(backupTargetRoot());
  return stats;
});

ipcMain.handle('share:status', async () => {
  return readShareStatus();
});

ipcMain.handle('share:create', async () => {
  await ensureBackupFolders();
  const result = await createOrRepairShare(settings.backupRoot, settings.shareName, IOS_TARGET_FOLDER);
  restartWatcher();
  return result;
});

function restartWatcher() {
  stopWatcher();

  const watchRoot = path.join(backupTargetRoot(), '.icloudfriend');
  fs.mkdir(watchRoot, { recursive: true }).then(() => {
    watcher = legacyFs.watch(watchRoot, { recursive: true }, () => {
      scheduleScan();
    });
    watcher.on('error', () => {
      stopWatcher();
    });
    scheduleScan();
  }).catch(() => {});
}

function stopWatcher() {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  if (scanTimer) {
    clearTimeout(scanTimer);
    scanTimer = null;
  }
}

function scheduleScan() {
  if (scanTimer) {
    clearTimeout(scanTimer);
  }
  scanTimer = setTimeout(async () => {
    scanTimer = null;
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    const stats = await scanBackupRoot(backupTargetRoot());
    mainWindow.webContents.send('backup:update', stats);
  }, 450);
}

async function readShareStatus() {
  if (process.platform !== 'win32') {
    return {
      supported: false,
      exists: false,
      message: 'SMB share creation is available when this app runs on Windows.'
    };
  }

  const shareName = settings.shareName || DEFAULT_SHARE_NAME;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$name = ${psQuote(shareName)}`,
    '$share = Get-SmbShare -Name $name -ErrorAction SilentlyContinue',
    'if ($null -eq $share) {',
    '  @{ exists = $false; name = $name } | ConvertTo-Json -Compress',
    '} else {',
    '  @{ exists = $true; name = $share.Name; path = $share.Path; description = $share.Description } | ConvertTo-Json -Compress',
    '}'
  ].join('\n');

  const result = await runPowerShellEncoded(script);
  if (result.code !== 0) {
    return {
      supported: true,
      exists: false,
      message: result.stderr || result.stdout || 'Unable to read SMB share status.'
    };
  }

  try {
    return {
      supported: true,
      ...JSON.parse(result.stdout.trim())
    };
  } catch {
    return {
      supported: true,
      exists: false,
      message: result.stdout.trim()
    };
  }
}

async function createOrRepairShare(backupRoot, shareName, targetFolderName) {
  if (process.platform !== 'win32') {
    return {
      ok: false,
      message: 'Run this action from Windows to create an SMB share.'
    };
  }

  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$path = ${psQuote(backupRoot)}`,
    `$targetPath = Join-Path $path ${psQuote(targetFolderName)}`,
    `$name = ${psQuote(shareName || DEFAULT_SHARE_NAME)}`,
    '$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name',
    'New-Item -ItemType Directory -Force -Path $path | Out-Null',
    'New-Item -ItemType Directory -Force -Path $targetPath | Out-Null',
    '$share = Get-SmbShare -Name $name -ErrorAction SilentlyContinue',
    'if ($null -eq $share) {',
    '  New-SmbShare -Name $name -Path $path -ChangeAccess $identity -Description "iCloudFriend photo backup target" | Out-Null',
    '} else {',
    '  Set-SmbShare -Name $name -Description "iCloudFriend photo backup target" -Force | Out-Null',
    '}',
    'Grant-SmbShareAccess -Name $name -AccountName $identity -AccessRight Change -Force | Out-Null',
    '@{ ok = $true; name = $name; path = $path; targetPath = $targetPath; identity = $identity } | ConvertTo-Json -Compress'
  ].join('\n');

  const result = await runElevatedPowerShell(script);
  const status = await readShareStatus();
  return {
    ok: result.code === 0 && status.exists,
    message: result.stderr || result.stdout || (status.exists ? 'SMB share is ready.' : 'Share command finished. Check Windows permissions.'),
    status
  };
}

function runElevatedPowerShell(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const wrapper = [
    "$ErrorActionPreference = 'Stop'",
    '$argsList = @(',
    "  '-NoProfile',",
    "  '-ExecutionPolicy', 'Bypass',",
    `  '-EncodedCommand', '${encoded}'`,
    ')',
    "$process = Start-Process -FilePath 'powershell.exe' -ArgumentList $argsList -Verb RunAs -Wait -PassThru",
    'exit $process.ExitCode'
  ].join('\n');
  return runPowerShellEncoded(wrapper);
}

function runPowerShellEncoded(script) {
  return new Promise((resolve) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encoded
    ], {
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    child.on('error', (error) => {
      resolve({ code: 1, stdout, stderr: error.message });
    });
    child.on('close', (code) => {
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

module.exports = {
  defaultSettings,
  psQuote
};
