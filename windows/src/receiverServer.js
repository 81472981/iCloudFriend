const crypto = require('crypto');
const fs = require('fs/promises');
const legacyFs = require('fs');
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
  let bonjour = null;
  let advertisement = null;
  let status = {
    running: false,
    port: null,
    serviceName: null,
    fingerprint: null,
    baseUrl: null,
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

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '0.0.0.0', () => {
        server.off('error', reject);
        resolve();
      });
    });

    const port = server.address().port;
    const hostname = os.hostname();
    const serviceName = `iCloudFriend ${hostname}`;
    bonjour = new Bonjour();
    advertisement = bonjour.publish({
      name: serviceName,
      type: SERVICE_TYPE,
      port,
      txt: {
        app: 'iCloudFriend',
        version: String(PROTOCOL_VERSION),
        tls: '1.3',
        fingerprint: credentials.fingerprint
      }
    });

    status = {
      running: true,
      port,
      serviceName,
      fingerprint: credentials.fingerprint,
      baseUrl: `https://${hostname}.local:${port}`,
      protocolVersion: PROTOCOL_VERSION
    };
    return status;
  }

  async function stop() {
    if (advertisement) {
      advertisement.stop();
      advertisement = null;
    }
    if (bonjour) {
      bonjour.destroy();
      bonjour = null;
    }
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
    status = {
      running: false,
      port: null,
      serviceName: null,
      fingerprint: null,
      baseUrl: null,
      protocolVersion: PROTOCOL_VERSION
    };
  }

  function getStatus() {
    return {
      ...status,
      backupRoot: getBackupRoot()
    };
  }

  async function handleRequest(request, response) {
    try {
      const requestUrl = new URL(request.url, 'https://localhost');

      if (request.method === 'GET' && requestUrl.pathname === '/api/hello') {
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
    status: getStatus
  };
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
    return { key, cert, fingerprint: certificateFingerprint(cert) };
  } catch {
    const attrs = [{ name: 'commonName', value: `${os.hostname()}.local` }];
    const pem = await selfsigned.generate(attrs, {
      days: 3650,
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
        { name: 'extKeyUsage', serverAuth: true },
        {
          name: 'subjectAltName',
          altNames: [
            { type: 2, value: `${os.hostname()}.local` },
            { type: 2, value: os.hostname() },
            { type: 7, ip: '127.0.0.1' }
          ]
        }
      ]
    });
    await Promise.all([
      fs.writeFile(keyPath, pem.private),
      fs.writeFile(certPath, pem.cert)
    ]);
    return { key: pem.private, cert: pem.cert, fingerprint: certificateFingerprint(pem.cert) };
  }
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
