const api = window.iCloudFriend;

const elements = {
  backupRoot: document.getElementById('backupRoot'),
  deviceName: document.getElementById('deviceName'),
  connectionState: document.getElementById('connectionState'),
  receiverState: document.getElementById('receiverState'),
  assetCount: document.getElementById('assetCount'),
  totalAssets: document.getElementById('totalAssets'),
  assetProgress: document.getElementById('assetProgress'),
  backupHint: document.getElementById('backupHint'),
  toast: document.getElementById('toast'),
  chooseFolderButton: document.getElementById('chooseFolderButton'),
  openFolderButton: document.getElementById('openFolderButton'),
  copyReceiverButton: document.getElementById('copyReceiverButton'),
  refreshButton: document.getElementById('refreshButton')
};

let currentSettings = null;
let currentStats = null;
let currentReceiver = null;
let toastTimer = null;

async function boot() {
  bindEvents();
  currentSettings = await api.getSettings();
  currentReceiver = currentSettings.receiver;
  renderSettings(currentSettings);
  await refreshAll();
  setInterval(() => {
    refreshReceiver().catch((error) => showToast(error.message || String(error)));
  }, 3000);
  api.onBackupUpdate((stats) => {
    currentStats = stats;
    renderDashboard();
  });
}

function bindEvents() {
  elements.chooseFolderButton.addEventListener('click', async () => {
    currentSettings = await api.chooseFolder();
    currentReceiver = currentSettings.receiver;
    renderSettings(currentSettings);
    await refreshAll();
    showToast('备份目录已更新。');
  });

  elements.openFolderButton.addEventListener('click', async () => {
    const message = await api.openFolder();
    if (message) {
      showToast(message);
    }
  });

  elements.copyReceiverButton.addEventListener('click', async () => {
    const url = primaryReceiverUrl();
    if (!url) {
      showToast('接收服务还没有启动。');
      return;
    }
    await navigator.clipboard.writeText(url);
    showToast('连接地址已复制。');
  });

  elements.refreshButton.addEventListener('click', refreshAll);
}

async function refreshAll() {
  await Promise.all([refreshStats(), refreshReceiver()]);
}

async function refreshStats() {
  currentStats = await api.scanBackup();
  renderDashboard();
}

async function refreshReceiver() {
  currentReceiver = await api.getReceiverStatus();
  renderDashboard();
}

function renderSettings(settings) {
  elements.backupRoot.textContent = settings.backupTargetRoot || settings.backupRoot;
}

function renderDashboard() {
  renderDevice();
  renderCounts();
}

function renderDevice() {
  const sync = latestSyncStatus();
  const client = currentReceiver?.client || null;
  const clientIsLatest = client && (!sync || isNewer(client.connectedAt, sync.updatedAt));

  elements.deviceName.textContent = (clientIsLatest ? client.deviceName : sync?.deviceName) || client?.deviceName || '暂无设备';
  elements.receiverState.textContent = currentReceiver?.running ? primaryReceiverUrl() : '未启动';
  elements.copyReceiverButton.disabled = !currentReceiver?.running || !primaryReceiverUrl();

  const state = connectionState(sync, client, clientIsLatest);
  elements.connectionState.textContent = state.label;
  elements.connectionState.className = `state-pill ${state.tone}`;
}

function primaryReceiverUrl() {
  if (!currentReceiver?.running) {
    return '';
  }
  return currentReceiver.httpNetworkUrls?.[0]
    || currentReceiver.httpBaseUrl
    || currentReceiver.networkUrls?.[0]
    || currentReceiver.baseUrl
    || `端口 ${currentReceiver.httpPort || currentReceiver.port}`;
}

function renderCounts() {
  const sync = latestSyncStatus();
  const total = Number(sync?.totalAssets || 0);
  const displayTotal = total > 0 ? total : null;
  const scannedBackups = Number(currentStats?.assetCount || 0);
  const reportedCompleted = Number(sync?.completedAssets || 0);
  const rawBackedUp = Math.max(scannedBackups, reportedCompleted);
  const backedUp = displayTotal ? Math.min(rawBackedUp, displayTotal) : rawBackedUp;
  const percent = displayTotal ? Math.min(100, Math.round((backedUp / displayTotal) * 100)) : 0;

  elements.assetCount.textContent = formatNumber(backedUp);
  elements.totalAssets.textContent = displayTotal ? formatNumber(displayTotal) : '--';
  elements.assetProgress.style.width = `${percent}%`;

  if (displayTotal) {
    elements.backupHint.textContent = `已备份 ${formatNumber(backedUp)} / ${formatNumber(displayTotal)} 张，完成 ${percent}%。`;
  } else if (backedUp > 0) {
    elements.backupHint.textContent = `已备份 ${formatNumber(backedUp)} 张，等待 iOS 上报相册总数量。`;
  } else {
    elements.backupHint.textContent = '等待 iPhone 连接并开始备份。';
  }
}

function latestSyncStatus() {
  return currentReceiver?.sync || currentStats?.syncStatus || null;
}

function connectionState(sync, client, clientIsLatest) {
  if (!currentReceiver?.running) {
    return { label: '未启动', tone: 'offline' };
  }

  if (client && (!sync || clientIsLatest)) {
    return { label: isFresh(client.connectedAt) ? '已连接' : '最近连接', tone: 'online' };
  }

  if (!sync) {
    return { label: '未连接', tone: 'waiting' };
  }

  if (sync.runStatus === 'running') {
    return { label: isFresh(sync.updatedAt) ? '正在备份' : '最近连接', tone: 'online' };
  }

  if (sync.runStatus === 'finished') {
    return { label: '已完成', tone: 'online' };
  }

  if (sync.runStatus === 'failed') {
    return { label: '备份失败', tone: 'warning' };
  }

  if (sync.runStatus === 'cancelled') {
    return { label: '已取消', tone: 'waiting' };
  }

  return { label: '已连接', tone: 'online' };
}

function isFresh(value) {
  const time = Date.parse(value || '');
  if (Number.isNaN(time)) {
    return false;
  }
  return Date.now() - time < 45_000;
}

function isNewer(left, right) {
  const leftTime = Date.parse(left || '');
  const rightTime = Date.parse(right || '');
  if (Number.isNaN(leftTime)) {
    return false;
  }
  if (Number.isNaN(rightTime)) {
    return true;
  }
  return leftTime >= rightTime;
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(value || 0);
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    elements.toast.hidden = true;
  }, 3200);
}

boot().catch((error) => {
  showToast(error.message || String(error));
});
