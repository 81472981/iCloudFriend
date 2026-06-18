const api = window.iCloudFriend;

const elements = {
  backupRoot: document.getElementById('backupRoot'),
  deviceName: document.getElementById('deviceName'),
  connectionState: document.getElementById('connectionState'),
  receiverState: document.getElementById('receiverState'),
  assetCount: document.getElementById('assetCount'),
  pendingAssets: document.getElementById('pendingAssets'),
  assetProgress: document.getElementById('assetProgress'),
  backupHint: document.getElementById('backupHint'),
  photoGrid: document.getElementById('photoGrid'),
  photoEmpty: document.getElementById('photoEmpty'),
  previewCount: document.getElementById('previewCount'),
  toast: document.getElementById('toast'),
  chooseFolderButton: document.getElementById('chooseFolderButton'),
  openFolderButton: document.getElementById('openFolderButton'),
  copyReceiverButton: document.getElementById('copyReceiverButton'),
  refreshButton: document.getElementById('refreshButton')
};

let currentSettings = null;
let currentStats = null;
let currentReceiver = null;
let currentPhotos = [];
let toastTimer = null;
let photoRefreshTimer = null;

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
    schedulePhotoRefresh();
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
  await Promise.all([refreshStats(), refreshReceiver(), refreshPhotos()]);
}

async function refreshStats() {
  currentStats = await api.scanBackup();
  renderDashboard();
}

async function refreshReceiver() {
  currentReceiver = await api.getReceiverStatus();
  renderDashboard();
}

async function refreshPhotos() {
  currentPhotos = await api.listPhotos();
  renderPhotos();
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

  const state = connectionState(sync, client);
  elements.connectionState.textContent = state.label;
  elements.connectionState.className = `state-pill ${state.tone}`;
}

function primaryReceiverUrl() {
  if (!currentReceiver?.running) {
    return '';
  }
  if (currentSettings?.platform === 'darwin' && currentReceiver.loopbackHttpUrl) {
    return currentReceiver.loopbackHttpUrl;
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
  const hasIosTotal = total > 0;
  const backedUp = Math.max(0, Number(currentStats?.visibleMediaCount ?? currentStats?.visiblePhotoCount ?? currentStats?.assetCount ?? 0));
  const pending = hasIosTotal ? Math.max(total - backedUp, 0) : null;
  const percent = hasIosTotal ? Math.min(100, Math.round((Math.min(backedUp, total) / total) * 100)) : 0;

  elements.assetCount.textContent = formatNumber(backedUp);
  elements.pendingAssets.textContent = pending === null ? '--' : formatNumber(pending);
  elements.assetProgress.style.width = `${percent}%`;

  if (hasIosTotal && pending > 0) {
    elements.backupHint.textContent = `Windows 目录已备份 ${formatNumber(backedUp)} 项，iOS 端还有 ${formatNumber(pending)} 项待备份。`;
  } else if (hasIosTotal) {
    elements.backupHint.textContent = `Windows 目录已备份 ${formatNumber(backedUp)} 项，iOS 端暂无待备份照片和视频。`;
  } else if (backedUp > 0) {
    elements.backupHint.textContent = `Windows 目录已备份 ${formatNumber(backedUp)} 项，等待 iOS 上报待备份数量。`;
  } else {
    elements.backupHint.textContent = '等待 iPhone 连接并开始备份。';
  }
}

function renderPhotos() {
  elements.previewCount.textContent = `${formatNumber(currentPhotos.length)} 项`;
  elements.photoGrid.replaceChildren();
  elements.photoEmpty.hidden = currentPhotos.length > 0;

  for (const photo of currentPhotos) {
    elements.photoGrid.appendChild(photoCard(photo));
  }
}

function photoCard(photo) {
  const card = document.createElement('button');
  card.className = 'photo-card';
  card.type = 'button';
  card.title = `打开 ${photo.filename}`;
  card.addEventListener('click', async () => {
    const message = await api.openPhoto(photo.filePath);
    if (message) {
      showToast(message);
    }
  });

  const thumb = document.createElement('div');
  thumb.className = 'photo-thumb';
  if (photo.thumbnailDataUrl) {
    const image = document.createElement('img');
    image.src = photo.thumbnailDataUrl;
    image.alt = photo.title || photo.filename || '媒体文件';
    thumb.appendChild(image);
  } else {
    const placeholder = document.createElement('span');
    placeholder.textContent = photo.mediaType === 'video' ? 'VIDEO' : 'PHOTO';
    thumb.appendChild(placeholder);
  }

  const title = document.createElement('strong');
  title.textContent = photo.title || photo.filename || '媒体文件';

  const date = document.createElement('span');
  date.className = 'photo-date';
  date.textContent = formatDate(photo.creationDate || photo.backedUpAt || photo.timestamp);

  card.append(thumb, title, date);
  return card;
}

function schedulePhotoRefresh() {
  clearTimeout(photoRefreshTimer);
  photoRefreshTimer = setTimeout(() => {
    refreshPhotos().catch((error) => showToast(error.message || String(error)));
  }, 650);
}

function latestSyncStatus() {
  return currentReceiver?.sync || currentStats?.syncStatus || null;
}

function connectionState(sync, client) {
  if (!currentReceiver?.running) {
    return { label: '未启动', tone: 'offline' };
  }

  const latestContact = latestConnectionTime(sync, client);
  if (!latestContact) {
    return { label: '未连接', tone: 'waiting' };
  }

  if (isFresh(latestContact)) {
    return { label: '已连接', tone: 'online' };
  }

  return { label: '已断开', tone: 'offline' };
}

function latestConnectionTime(sync, client) {
  return [client?.connectedAt, sync?.updatedAt].reduce((latest, value) => {
    const time = Date.parse(value || '');
    if (Number.isNaN(time)) {
      return latest;
    }
    if (!latest || time > latest.time) {
      return { value, time };
    }
    return latest;
  }, null)?.value || null;
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

function formatDate(value) {
  const date = new Date(value || '');
  if (Number.isNaN(date.getTime())) {
    return '未知时间';
  }
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
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
