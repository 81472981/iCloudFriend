const crypto = require('crypto');
const fs = require('fs/promises');
const legacyFs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Bonjour } = require('bonjour-service');
const selfsigned = require('selfsigned');

const SERVICE_TYPE = 'icloudfriend';
const PROTOCOL_VERSION = 1;

function createReceiverServer({ getBackupRoot, certDirectory, onChanged }) {
  let server = null;
  let plainServer = null;
  let bonjour = null;
  let advertisement = null;
  let status = {
    running: false,
    port: null,
    httpPort: null,
    serviceName: null,
    fingerprint: null,
    baseUrl: null,
    httpBaseUrl: null,
    networkUrls: [],
    httpNetworkUrls: [],
    discoveryAvailable: false,
    discoveryMessage: null,
    client: null,
    sync: null,
    protocolVersion: PROTOCOL_VERSION
  };

  async function start() {
    if (server) {
      return status;
    }

    const credentials = await loadOrCreateCertificate(certDirectory);
    server = https.createServer({
      key: credentials.key,
      cert: credentials.cert,
      minVersion: 'TLSv1.3'
    }, handleRequest);
    plainServer = http.createServer(handleRequest);

    await listen(server);
    await listen(plainServer);

    const port = server.address().port;
    const httpPort = plainServer.address().port;
    const hostname = cleanHostname();
    const localName = localHostname();
    const serviceName = `iCloudFriend ${hostname}`;
    status = {
      running: true,
      port,
      httpPort,
      serviceName,
      fingerprint: credentials.fingerprint,
      baseUrl: `https://${localName}:${port}`,
      httpBaseUrl: `http://${localName}:${httpPort}`,
      networkUrls: localNetworkUrls(port),
      httpNetworkUrls: localNetworkUrls(httpPort, 'http'),
      discoveryAvailable: false,
      discoveryMessage: 'Auto-discovery is starting.',
      client: null,
      sync: null,
      protocolVersion: PROTOCOL_VERSION
    };

    try {
      bonjour = new Bonjour({}, markDiscoveryUnavailable);
      advertisement = bonjour.publish({
        name: serviceName,
        type: SERVICE_TYPE,
        port,
        txt: {
          app: 'iCloudFriend',
          version: String(PROTOCOL_VERSION),
          tls: '1.3',
          httpPort: String(httpPort),
          fingerprint: credentials.fingerprint
        }
      });
      if (typeof advertisement.on === 'function') {
        advertisement.on('error', markDiscoveryUnavailable);
      }
      status.discoveryAvailable = true;
      status.discoveryMessage = null;
    } catch (error) {
      markDiscoveryUnavailable(error);
    }

    return status;
  }

  async function stop() {
    stopBonjour();
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
    if (plainServer) {
      await new Promise((resolve) => plainServer.close(resolve));
      plainServer = null;
    }
    status = {
      running: false,
      port: null,
      httpPort: null,
      serviceName: null,
      fingerprint: null,
      baseUrl: null,
      httpBaseUrl: null,
      networkUrls: [],
      httpNetworkUrls: [],
      discoveryAvailable: false,
      discoveryMessage: null,
      client: null,
      sync: null,
      protocolVersion: PROTOCOL_VERSION
    };
  }

  function markDiscoveryUnavailable(error) {
    const message = error?.message || String(error || 'Bonjour auto-discovery is unavailable.');
    status = {
      ...status,
      discoveryAvailable: false,
      discoveryMessage: `Bonjour auto-discovery unavailable: ${message}`
    };
    stopBonjour();
  }

  function stopBonjour() {
    if (advertisement) {
      try {
        advertisement.stop();
      } catch {
        // Discovery is best-effort; failed cleanup should not stop the receiver.
      }
      advertisement = null;
    }
    if (bonjour) {
      try {
        bonjour.destroy();
      } catch {
        // Discovery is best-effort; failed cleanup should not stop the receiver.
      }
      bonjour = null;
    }
  }

  function getStatus() {
    return {
      ...status,
      networkUrls: status.port ? localNetworkUrls(status.port) : [],
      httpNetworkUrls: status.httpPort ? localNetworkUrls(status.httpPort, 'http') : [],
      backupRoot: getBackupRoot()
    };
  }

  async function handleRequest(request, response) {
    try {
      const requestUrl = new URL(request.url, 'http://localhost');

      if (request.method === 'GET' && requestUrl.pathname === '/api/hello') {
        markClientConnected(request);
        return sendJson(response, 200, {
          app: 'iCloudFriend',
          hostname: os.hostname(),
          platform: process.platform,
          protocolVersion: PROTOCOL_VERSION,
          receiver: getStatus()
        });
      }

      if (request.method === 'GET' && requestUrl.pathname === '/api/status') {
        return sendJson(response, 200, getStatus());
      }

      if (request.method === 'POST' && requestUrl.pathname === '/api/asset/status') {
        const body = await readJson(request);
        return sendJson(response, 200, await readAssetStatus(body));
      }

      if (request.method === 'POST' && requestUrl.pathname === '/api/resource/status') {
        const body = await readJson(request);
        return sendJson(response, 200, await readResourceStatus(body));
      }

      if (request.method === 'POST' && requestUrl.pathname === '/api/sync/status') {
        const body = await readJson(request);
        return sendJson(response, 200, await updateSyncStatus(body));
      }

      if (request.method === 'PUT' && requestUrl.pathname === '/api/resource') {
        return sendJson(response, 200, await receiveResource(request, requestUrl));
      }

      if (request.method === 'POST' && requestUrl.pathname === '/api/asset/commit') {
        const body = await readJson(request, 10 * 1024 * 1024);
        return sendJson(response, 200, await commitAsset(body));
      }

      sendJson(response, 404, { ok: false, message: 'Not found' });
    } catch (error) {
      sendJson(response, error.statusCode || 500, {
        ok: false,
        message: error.message || String(error)
      });
    }
  }

  function markClientConnected(request) {
    const deviceName = cleanText(request.headers['x-icloudfriend-device-name'], 'iOS 设备');
    const deviceIdentifier = cleanText(request.headers['x-icloudfriend-device-id'], null);
    status = {
      ...status,
      client: {
        deviceName,
        deviceIdentifier,
        remoteAddress: request.socket.remoteAddress || null,
        connectedAt: new Date().toISOString()
      }
    };
    onChanged?.();
  }

  async function readAssetStatus(body) {
    const backupRoot = getBackupRoot();
    const assetFolder = sanitizeRelativePath(body.assetFolder || '');
    const metadataPath = safeJoin(backupRoot, assetFolder, 'metadata.json');

    try {
      const data = await fs.readFile(metadataPath, 'utf8');
      const sidecar = JSON.parse(data);
      return {
        complete: sidecar.asset?.fingerprint === body.fingerprint,
        backedUpAt: sidecar.backedUpAt || null,
        resourceCount: Array.isArray(sidecar.resources) ? sidecar.resources.length : 0
      };
    } catch {
      return { complete: false };
    }
  }

  async function readResourceStatus(body) {
    const backupRoot = getBackupRoot();
    const relativePath = sanitizeRelativePath(body.relativePath || '');
    const expectedBytes = Number(body.byteCount || 0);
    const finalPath = safeJoin(backupRoot, relativePath);
    const partialPath = `${finalPath}.partial`;

    const finalSize = await fileSize(finalPath);
    if (expectedBytes > 0 && finalSize === expectedBytes) {
      return { complete: true, offset: expectedBytes };
    }

    const partialSize = await fileSize(partialPath);
    return { complete: false, offset: partialSize };
  }

  async function updateSyncStatus(body) {
    const nextStatus = {
      deviceName: cleanText(body.deviceName, 'iPhone'),
      deviceIdentifier: cleanText(body.deviceIdentifier, null),
      mode: cleanText(body.mode, 'incremental'),
      runStatus: cleanText(body.runStatus, 'running'),
      totalAssets: cleanCount(body.totalAssets),
      completedAssets: cleanCount(body.completedAssets),
      failedAssets: cleanCount(body.failedAssets),
      currentAssetName: cleanText(body.currentAssetName, null),
      message: cleanText(body.message, null),
      updatedAt: new Date().toISOString()
    };

    status = {
      ...status,
      sync: nextStatus
    };

    const syncPath = safeJoin(getBackupRoot(), 'index', 'sync-status.json');
    await fs.mkdir(path.dirname(syncPath), { recursive: true });
    await writeJsonAtomic(syncPath, nextStatus);
    onChanged?.();

    return { ok: true, sync: nextStatus };
  }

  async function receiveResource(request, requestUrl) {
    const backupRoot = getBackupRoot();
    const relativePath = sanitizeRelativePath(requestUrl.searchParams.get('relativePath') || '');
    const offset = Number(requestUrl.searchParams.get('offset') || 0);
    const expectedBytes = Number(request.headers['x-expected-bytes'] || 0);
    const finalPath = safeJoin(backupRoot, relativePath);
    const partialPath = `${finalPath}.partial`;

    await fs.mkdir(path.dirname(finalPath), { recursive: true });

    const finalSize = await fileSize(finalPath);
    if (expectedBytes > 0 && finalSize === expectedBytes) {
      drain(request);
      return { complete: true, offset: expectedBytes };
    }

    const partialSize = await fileSize(partialPath);
    if (partialSize !== offset) {
      drain(request);
      return { complete: false, offset: partialSize, retry: true };
    }

    const writeStream = legacyFs.createWriteStream(partialPath, {
      flags: offset === 0 ? 'w' : 'a'
    });
    await pipeline(request, writeStream);

    const nextSize = await fileSize(partialPath);
    if (expectedBytes > 0 && nextSize === expectedBytes) {
      await fs.rm(finalPath, { force: true });
      await fs.rename(partialPath, finalPath);
      onChanged?.();
      return { complete: true, offset: nextSize };
    }

    onChanged?.();
    return { complete: false, offset: nextSize };
  }

  async function commitAsset(body) {
    const backupRoot = getBackupRoot();
    const assetFolder = sanitizeRelativePath(body.assetFolder || '');
    const sidecar = body.sidecar;
    const event = body.event;
    if (!sidecar || !event) {
      throw badRequest('Missing sidecar or event.');
    }

    const assetFolderPath = safeJoin(backupRoot, assetFolder);
    await fs.mkdir(assetFolderPath, { recursive: true });

    const metadataPath = path.join(assetFolderPath, 'metadata.json');
    await writeJsonAtomic(metadataPath, sidecar);

    const eventsPath = safeJoin(backupRoot, 'index', 'events.ndjson');
    await fs.mkdir(path.dirname(eventsPath), { recursive: true });
    await fs.appendFile(eventsPath, `${JSON.stringify(event)}\n`);
    onChanged?.();

    return { ok: true, assetFolder };
  }

  return {
    start,
    stop,
    status: getStatus,
    markDiscoveryUnavailable
  };
}

function listen(targetServer) {
  return new Promise((resolve, reject) => {
    targetServer.once('error', reject);
    targetServer.listen(0, '0.0.0.0', () => {
      targetServer.off('error', reject);
      resolve();
    });
  });
}

async function loadOrCreateCertificate(certDirectory) {
  await fs.mkdir(certDirectory, { recursive: true });
  const keyPath = path.join(certDirectory, 'receiver.key.pem');
  const certPath = path.join(certDirectory, 'receiver.cert.pem');

  try {
    const [key, cert] = await Promise.all([
      fs.readFile(keyPath, 'utf8'),
      fs.readFile(certPath, 'utf8')
    ]);
    if (certificateMatchesCurrentNetwork(cert)) {
      return { key, cert, fingerprint: certificateFingerprint(cert) };
    }
  } catch {
    // Missing or unreadable certificates are regenerated below.
  }

  const attrs = [{ name: 'commonName', value: localHostname() }];
  const pem = await selfsigned.generate(attrs, {
    days: 397,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: certificateAltNames()
      }
    ]
  });
  await Promise.all([
    fs.writeFile(keyPath, pem.private),
    fs.writeFile(certPath, pem.cert)
  ]);
  return { key: pem.private, cert: pem.cert, fingerprint: certificateFingerprint(pem.cert) };
}

function cleanHostname() {
  return os.hostname().replace(/\.local$/i, '');
}

function localHostname() {
  const hostname = os.hostname();
  return hostname.endsWith('.local') ? hostname : `${hostname}.local`;
}

function localNetworkUrls(port, scheme = 'https') {
  return localNetworkCandidates()
    .map((candidate) => `${scheme}://${candidate.address}:${port}`);
}

function localIPv4Addresses() {
  return localNetworkCandidates()
    .map((candidate) => candidate.address);
}

function localNetworkCandidates() {
  const interfaces = os.networkInterfaces();
  const candidates = [];

  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries || []) {
      if (!isIPv4Entry(entry) || entry.internal || !entry.address) {
        continue;
      }
      candidates.push({
        address: entry.address,
        interfaceRank: virtualInterfaceRank(name, entry),
        networkRank: privateNetworkRank(entry.address)
      });
    }
  }

  return candidates
    .sort((left, right) => {
      return left.interfaceRank - right.interfaceRank
        || left.networkRank - right.networkRank
        || left.address.localeCompare(right.address);
    })
    .filter((candidate, index, list) => list.findIndex((item) => item.address === candidate.address) === index);
}

function isIPv4Entry(entry) {
  return entry?.family === 'IPv4' || entry?.family === 4;
}

function certificateAltNames() {
  const dnsNames = [...new Set([localHostname(), cleanHostname()])]
    .filter(Boolean)
    .map((value) => ({ type: 2, value }));
  const ipNames = [...new Set(['127.0.0.1', ...localIPv4Addresses()])]
    .map((ip) => ({ type: 7, ip }));
  return [...dnsNames, ...ipNames];
}

function certificateMatchesCurrentNetwork(cert) {
  try {
    const x509 = new crypto.X509Certificate(cert);
    const subjectAltName = x509.subjectAltName || '';
    return certificateAltNames().every((entry) => {
      if (entry.type === 2) {
        return subjectAltName.includes(`DNS:${entry.value}`);
      }
      if (entry.type === 7) {
        return subjectAltName.includes(`IP Address:${entry.ip}`);
      }
      return true;
    });
  } catch {
    return false;
  }
}

function virtualInterfaceRank(name, entry) {
  const text = String(name || '').toLowerCase();
  const mac = String(entry.mac || '').toLowerCase();
  if (/^(lo|utun|awdl|llw|bridge|gif|stf|p2p|tun|tap|wg|vmnet|vbox|docker|br-|anpi)/.test(text)) {
    return 10;
  }
  if (text.includes('virtual') || text.includes('vmware') || text.includes('hyper-v') || text.includes('vethernet')) {
    return 10;
  }
  if (mac === '00:00:00:00:00:00') {
    return 10;
  }
  return 0;
}

function privateNetworkRank(address) {
  if (address.startsWith('192.168.')) {
    return 0;
  }
  if (address.startsWith('10.')) {
    return 1;
  }
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(address)) {
    return 2;
  }
  return 3;
}

function certificateFingerprint(cert) {
  const body = cert
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');
  const der = Buffer.from(body, 'base64');
  return crypto.createHash('sha256').update(der).digest('hex');
}

async function readJson(request, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      throw badRequest('Request body is too large.');
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(response, statusCode, value) {
  const data = Buffer.from(JSON.stringify(value));
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': data.length
  });
  response.end(data);
}

function sanitizeRelativePath(value) {
  const normalized = path.normalize(String(value).replaceAll('\\0', '').replaceAll('\\', '/'));
  if (!normalized || normalized === '.' || path.isAbsolute(normalized) || normalized.startsWith('..')) {
    throw badRequest('Invalid relative path.');
  }
  return normalized;
}

function safeJoin(root, ...pieces) {
  const rootPath = path.resolve(root);
  const target = path.resolve(rootPath, ...pieces);
  if (target !== rootPath && !target.startsWith(`${rootPath}${path.sep}`)) {
    throw badRequest('Path escapes backup root.');
  }
  return target;
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function cleanText(value, fallback) {
  if (value === null || value === undefined) {
    return fallback;
  }
  const text = String(value).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!text) {
    return fallback;
  }
  return text.slice(0, 240);
}

function cleanCount(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) {
    return 0;
  }
  return Math.max(0, Math.floor(number));
}

async function fileSize(target) {
  try {
    const stat = await fs.stat(target);
    return stat.isFile() ? stat.size : 0;
  } catch {
    return 0;
  }
}

async function writeJsonAtomic(target, value) {
  const partial = `${target}.partial`;
  await fs.writeFile(partial, JSON.stringify(value, null, 2));
  await fs.rm(target, { force: true });
  await fs.rename(partial, target);
}

function drain(stream) {
  stream.resume();
}

module.exports = {
  createReceiverServer,
  SERVICE_TYPE
};
