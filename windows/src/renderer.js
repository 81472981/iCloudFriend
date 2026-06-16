const api = window.iCloudFriend;

const elements = {
  shareState: document.getElementById('shareState'),
  backupRoot: document.getElementById('backupRoot'),
  smbUrl: document.getElementById('smbUrl'),
  receiverUrl: document.getElementById('receiverUrl'),
  receiverState: document.getElementById('receiverState'),
  receiverFingerprint: document.getElementById('receiverFingerprint'),
  targetFolder: document.getElementById('targetFolder'),
  userHint: document.getElementById('userHint'),
  assetCount: document.getElementById('assetCount'),
  resourceCount: document.getElementById('resourceCount'),
  totalBytes: document.getElementById('totalBytes'),
  freeBytes: document.getElementById('freeBytes'),
  recentList: document.getElementById('recentList'),
  errorCount: document.getElementById('errorCount'),
  watchState: document.getElementById('watchState'),
  toast: document.getElementById('toast'),
  chooseFolderButton: document.getElementById('chooseFolderButton'),
  openFolderButton: document.getElementById('openFolderButton'),
  createShareButton: document.getElementById('createShareButton'),
  copyUrlButton: document.getElementById('copyUrlButton'),
  refreshButton: document.getElementById('refreshButton')
};

let currentSettings = null;
let toastTimer = null;

async function boot() {
  bindEvents();
  currentSettings = await api.getSettings();
  renderSettings(currentSettings);
  await refreshAll();
  setInterval(() => {
    refreshReceiver().catch((error) => showToast(error.message || String(error)));
  }, 5000);
  api.onBackupUpdate((stats) => renderStats(stats));
}

function bindEvents() {
  elements.chooseFolderButton.addEventListener('click', async () => {
    currentSettings = await api.chooseFolder();
    renderSettings(currentSettings);
    await refreshAll();
    showToast('Backup folder updated.');
  });

  elements.openFolderButton.addEventListener('click', async () => {
    const message = await api.openFolder();
    if (message) {
      showToast(message);
    }
  });

  elements.createShareButton.addEventListener('click', async () => {
    elements.createShareButton.disabled = true;
    elements.createShareButton.textContent = 'Waiting for Windows approval...';
    try {
      const result = await api.createShare();
      await refreshShare();
      showToast(result.ok ? 'SMB share is ready.' : result.message || 'Share creation needs attention.');
    } finally {
      elements.createShareButton.disabled = false;
      elements.createShareButton.textContent = 'Create or repair SMB share';
    }
  });

  elements.copyUrlButton.addEventListener('click', async () => {
    if (!currentSettings?.smbUrl) {
      return;
    }
    await navigator.clipboard.writeText(currentSettings.smbUrl);
    showToast('SMB address copied.');
  });

  elements.refreshButton.addEventListener('click', refreshAll);
}

async function refreshAll() {
  await Promise.all([refreshStats(), refreshShare(), refreshReceiver()]);
}

async function refreshStats() {
  elements.watchState.textContent = 'Scanning';
  const stats = await api.scanBackup();
  renderStats(stats);
}

async function refreshShare() {
  const status = await api.getShareStatus();
  renderShareStatus(status);
}

async function refreshReceiver() {
  const receiver = await api.getReceiverStatus();
  currentSettings = { ...currentSettings, receiver };
  renderReceiver(receiver);
}

function renderSettings(settings) {
  elements.backupRoot.textContent = settings.backupRoot;
  elements.smbUrl.textContent = settings.smbUrl;
  elements.targetFolder.textContent = settings.targetFolderName || 'Backup';
  elements.userHint.textContent = settings.platform === 'win32'
    ? `Windows account: ${settings.username}. iPhone can auto-discover this receiver when both devices are on the same Wi-Fi.`
    : 'Receiver preview is running locally. SMB share creation becomes active when this app runs on Windows.';
  renderReceiver(settings.receiver);
}

function renderShareStatus(status) {
  if (!status.supported) {
    elements.shareState.textContent = 'Preview mode';
    return;
  }
  if (status.exists) {
    elements.shareState.textContent = `Share ready: ${status.name}`;
    return;
  }
  elements.shareState.textContent = 'Share not created';
}

function renderReceiver(receiver) {
  elements.receiverState.classList.remove('warning', 'offline');

  if (!receiver?.running) {
    elements.receiverUrl.textContent = 'Receiver offline';
    elements.receiverState.textContent = 'Offline';
    elements.receiverState.classList.add('offline');
    elements.receiverFingerprint.textContent = '';
    return;
  }

  elements.receiverUrl.textContent = receiver.baseUrl || `Port ${receiver.port}`;
  elements.receiverState.textContent = receiver.discoveryAvailable === false ? 'Discovery limited' : 'TLS online';
  elements.receiverState.classList.toggle('warning', receiver.discoveryAvailable === false);

  const details = [`Certificate SHA-256: ${shortFingerprint(receiver.fingerprint)}`];
  if (receiver.discoveryAvailable === false && receiver.discoveryMessage) {
    details.push(receiver.discoveryMessage);
  }
  elements.receiverFingerprint.textContent = details.join(' | ');
}

function renderStats(stats) {
  elements.watchState.textContent = stats.exists ? 'Watching' : 'Waiting';
  elements.assetCount.textContent = formatNumber(stats.assetCount);
  elements.resourceCount.textContent = formatNumber(stats.resourceCount);
  elements.totalBytes.textContent = formatBytes(stats.totalBytes);
  elements.freeBytes.textContent = stats.disk ? formatBytes(stats.disk.freeBytes) : 'Unknown';

  if (stats.errors.length > 0) {
    elements.errorCount.textContent = `${stats.errors.length} metadata issue${stats.errors.length === 1 ? '' : 's'}`;
  } else {
    elements.errorCount.textContent = '';
  }

  if (!stats.exists) {
    elements.recentList.innerHTML = '<p class="muted">No backup index yet. Start a sync from the iPhone app.</p>';
    return;
  }

  if (stats.recent.length === 0) {
    elements.recentList.innerHTML = '<p class="muted">No completed assets yet.</p>';
    return;
  }

  elements.recentList.replaceChildren(...stats.recent.map(renderRecentItem));
}

function renderRecentItem(item) {
  const row = document.createElement('div');
  row.className = 'recent-item';

  const left = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = item.firstFilename || 'Photo asset';
  const detail = document.createElement('span');
  detail.textContent = `${item.mediaType} · ${item.resourceCount} resource${item.resourceCount === 1 ? '' : 's'} · ${formatBytes(item.byteCount)}`;
  left.append(title, detail);

  const right = document.createElement('small');
  right.textContent = formatDate(item.backedUpAt || item.creationDate);

  row.append(left, right);
  return row;
}

function formatBytes(value) {
  const number = Number(value || 0);
  if (number === 0) {
    return '0 MB';
  }
  return new Intl.NumberFormat(undefined, {
    style: 'unit',
    unit: bestByteUnit(number),
    unitDisplay: 'short',
    maximumFractionDigits: 1
  }).format(convertBytes(number));
}

function bestByteUnit(bytes) {
  if (bytes >= 1024 ** 3) {
    return 'gigabyte';
  }
  if (bytes >= 1024 ** 2) {
    return 'megabyte';
  }
  return 'kilobyte';
}

function convertBytes(bytes) {
  if (bytes >= 1024 ** 3) {
    return bytes / 1024 ** 3;
  }
  if (bytes >= 1024 ** 2) {
    return bytes / 1024 ** 2;
  }
  return Math.max(1, bytes / 1024);
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(value || 0);
}

function formatDate(value) {
  if (!value) {
    return 'Unknown';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'Unknown';
  }
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
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
  }, 3600);
}

function shortFingerprint(value) {
  if (!value) {
    return 'unknown';
  }
  return `${value.slice(0, 12)}...${value.slice(-12)}`;
}

boot().catch((error) => {
  showToast(error.message || String(error));
});
