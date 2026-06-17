const { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } = require('electron');
const fs = require('fs/promises');
const legacyFs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pathExists, scanBackupRoot } = require('./backupIndex');
const { createReceiverServer } = require('./receiverServer');
const { listPreviewPhotos } = require('./photoPreview');
const { VISIBLE_PHOTOS_DIR, mirrorExistingBackups } = require('./visibleBackup');

let mainWindow;
let settings;
let watcher;
let scanTimer;
let receiverServer;

const DEFAULT_SHARE_NAME = 'iCloudFriend';
const IOS_TARGET_FOLDER = 'Backup';

process.on('uncaughtException', (error) => {
  if (handleRecoverableMdnsError(error)) {
    return;
  }
  reportFatalError(error);
});

process.on('unhandledRejection', (reason) => {
  if (handleRecoverableMdnsError(reason)) {
    return;
  }
  reportFatalError(reason);
});

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
    const rawSettings = { ...defaultSettings(), ...JSON.parse(data) };
    const normalized = normalizeSettings(rawSettings);
    if (normalized.backupRoot !== rawSettings.backupRoot) {
      await fs.mkdir(app.getPath('userData'), { recursive: true });
      await fs.writeFile(configPath(), JSON.stringify(normalized, null, 2));
    }
    return normalized;
  } catch {
    return normalizeSettings(defaultSettings());
  }
}

async function writeSettings(nextSettings) {
  settings = normalizeSettings({ ...settings, ...nextSettings });
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await fs.writeFile(configPath(), JSON.stringify(settings, null, 2));
  await ensureBackupFolders();
  await mirrorBackupsToVisibleFolder();
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
    visiblePhotosRoot: path.join(backupTargetRoot(), VISIBLE_PHOTOS_DIR),
    targetFolderName: IOS_TARGET_FOLDER,
    smbUrl: `smb://${hostname}/${shareName}`,
    smbTargetUrl: `smb://${hostname}/${shareName}/${encodedTarget}`,
    uncPath: `\\\\${hostname}\\${shareName}`,
    receiver: receiverServer?.status() || null,
    platform: process.platform,
    username: os.userInfo().username
  };
}

function backupTargetRoot() {
  const backupRoot = normalizeBackupRootPath(settings.backupRoot);
  if (path.basename(backupRoot).toLowerCase() === IOS_TARGET_FOLDER.toLowerCase()) {
    return backupRoot;
  }
  return path.join(backupRoot, IOS_TARGET_FOLDER);
}

function normalizeSettings(value) {
  return {
    ...value,
    backupRoot: normalizeBackupRootPath(value.backupRoot || defaultSettings().backupRoot)
  };
}

function normalizeBackupRootPath(value) {
  let normalized = path.normalize(value);
  while (
    path.basename(normalized).toLowerCase() === IOS_TARGET_FOLDER.toLowerCase()
    && path.basename(path.dirname(normalized)).toLowerCase() === IOS_TARGET_FOLDER.toLowerCase()
  ) {
    normalized = path.dirname(normalized);
  }
  return normalized;
}

async function ensureBackupFolders() {
  await fs.mkdir(settings.backupRoot, { recursive: true });
  await fs.mkdir(backupTargetRoot(), { recursive: true });
  await fs.mkdir(path.join(backupTargetRoot(), VISIBLE_PHOTOS_DIR), { recursive: true });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 780,
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
  await mirrorBackupsToVisibleFolder();
  receiverServer = createReceiverServer({
    getBackupRoot: () => path.join(backupTargetRoot(), '.icloudfriend'),
    getPublicBackupRoot: () => backupTargetRoot(),
    certDirectory: path.join(app.getPath('userData'), 'receiver-cert'),
    onChanged: scheduleScan
  });
  await receiverServer.start();
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

app.on('before-quit', () => {
  receiverServer?.stop();
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

ipcMain.handle('photos:list', async () => {
  const photos = await listPreviewPhotos(backupTargetRoot());
  return Promise.all(photos.map(async (photo) => ({
    ...photo,
    thumbnailDataUrl: await thumbnailDataUrl(photo.filePath)
  })));
});

ipcMain.handle('photo:open', async (_event, filePath) => {
  const target = assertInsideVisiblePhotos(filePath);
  return shell.openPath(target);
});

ipcMain.handle('receiver:status', async () => receiverServer?.status() || null);

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

async function mirrorBackupsToVisibleFolder() {
  try {
    await mirrorExistingBackups({
      internalRoot: path.join(backupTargetRoot(), '.icloudfriend'),
      publicRoot: backupTargetRoot()
    });
  } catch (error) {
    console.warn(`Unable to prepare visible photo backups: ${error.message}`);
  }
}

async function thumbnailDataUrl(filePath) {
  try {
    const target = assertInsideVisiblePhotos(filePath);
    const thumbnail = await nativeImage.createThumbnailFromPath(target, {
      width: 320,
      height: 240
    });
    if (!thumbnail || thumbnail.isEmpty()) {
      return null;
    }
    return thumbnail.toDataURL();
  } catch {
    return null;
  }
}

function assertInsideVisiblePhotos(filePath) {
  const root = path.resolve(backupTargetRoot(), VISIBLE_PHOTOS_DIR);
  const target = path.resolve(String(filePath || ''));
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error('Photo path is outside the backup preview folder.');
  }
  return target;
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

function handleRecoverableMdnsError(reason) {
  if (!isMdnsNetworkError(reason)) {
    return false;
  }

  const message = reason?.message || String(reason);
  console.warn(`Bonjour auto-discovery unavailable: ${message}`);
  receiverServer?.markDiscoveryUnavailable?.(reason);
  return true;
}

function isMdnsNetworkError(reason) {
  if (!reason || typeof reason !== 'object') {
    return false;
  }

  const code = reason.code;
  const message = String(reason.message || reason);
  const address = String(reason.address || '');
  const port = Number(reason.port || 0);
  const recoverableCodes = new Set(['EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL']);
  const isMdnsTarget = port === 5353
    || address === '224.0.0.251'
    || message.includes('224.0.0.251:5353')
    || message.includes('ff02::fb')
    || message.includes(':5353');

  return recoverableCodes.has(code) && isMdnsTarget;
}

function reportFatalError(reason) {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  console.error(error);
  if (app.isReady()) {
    dialog.showErrorBox('iCloudFriend error', error.stack || error.message);
  }
  app.exit(1);
}

module.exports = {
  defaultSettings,
  psQuote
};
