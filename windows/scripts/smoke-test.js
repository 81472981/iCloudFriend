const assert = require('assert');
const fs = require('fs/promises');
const https = require('https');
const os = require('os');
const path = require('path');
const { scanBackupRoot } = require('../src/backupIndex');
const { createReceiverServer } = require('../src/receiverServer');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'icloudfriend-smoke-'));
  const assetDir = path.join(root, '.icloudfriend', 'assets', '2026', '06', 'asset-one');
  await fs.mkdir(path.join(assetDir, 'resources'), { recursive: true });
  await fs.writeFile(path.join(assetDir, 'metadata.json'), JSON.stringify({
    formatVersion: 1,
    backedUpAt: '2026-06-14T09:00:00Z',
    asset: {
      localIdentifier: 'abc',
      mediaType: 'image',
      creationDate: '2026-06-14T08:00:00Z'
    },
    resources: [
      {
        storedFilename: 'IMG_0001.HEIC',
        byteCount: 1024
      }
    ]
  }));

  const stats = await scanBackupRoot(root);
  assert.equal(stats.assetCount, 1);
  assert.equal(stats.resourceCount, 1);
  assert.equal(stats.totalBytes, 1024);
  assert.equal(stats.recent[0].firstFilename, 'IMG_0001.HEIC');

  await testReceiverServer();
  console.log('Smoke test passed.');
}

async function testReceiverServer() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'icloudfriend-receiver-'));
  const backupRoot = path.join(root, 'Backup', '.icloudfriend');
  const receiver = createReceiverServer({
    getBackupRoot: () => backupRoot,
    certDirectory: path.join(root, 'cert'),
    onChanged: () => {}
  });

  try {
    await receiver.start();
    const base = `https://127.0.0.1:${receiver.status().port}`;
    assert.ok(Array.isArray(receiver.status().networkUrls));
    const hello = await requestJson('GET', `${base}/api/hello`);
    assert.equal(hello.app, 'iCloudFriend');

    receiver.markDiscoveryUnavailable(Object.assign(new Error('send EHOSTUNREACH 224.0.0.251:5353'), {
      code: 'EHOSTUNREACH',
      address: '224.0.0.251',
      port: 5353
    }));
    const degraded = receiver.status();
    assert.equal(degraded.running, true);
    assert.equal(degraded.discoveryAvailable, false);
    assert.match(degraded.discoveryMessage, /Bonjour auto-discovery unavailable/);

    const helloAfterDiscoveryFailure = await requestJson('GET', `${base}/api/hello`);
    assert.equal(helloAfterDiscoveryFailure.receiver.running, true);

    const syncStatus = await requestJson('POST', `${base}/api/sync/status`, {
      deviceName: 'Linda iPhone',
      deviceIdentifier: 'device-1',
      mode: 'full',
      runStatus: 'running',
      totalAssets: 42,
      completedAssets: 7,
      failedAssets: 0,
      currentAssetName: 'IMG_0001.HEIC'
    });
    assert.equal(syncStatus.ok, true);
    assert.equal(receiver.status().sync.deviceName, 'Linda iPhone');
    assert.equal(receiver.status().sync.totalAssets, 42);

    const payload = Buffer.from('hello-photo');
    const relativePath = 'assets/2026/06/test-asset/resources/IMG_0001.HEIC';
    const initial = await requestJson('POST', `${base}/api/resource/status`, {
      relativePath,
      byteCount: payload.length
    });
    assert.equal(initial.complete, false);
    assert.equal(initial.offset, 0);

    const uploaded = await requestJson(
      'PUT',
      `${base}/api/resource?relativePath=${encodeURIComponent(relativePath)}&offset=0`,
      payload,
      {
        'content-type': 'application/octet-stream',
        'x-expected-bytes': String(payload.length)
      }
    );
    assert.equal(uploaded.complete, true);

    const sidecar = {
      formatVersion: 1,
      appName: 'iCloudFriend',
      backedUpAt: new Date().toISOString(),
      asset: {
        localIdentifier: 'receiver-asset',
        fingerprint: 'fingerprint',
        mediaType: 'image'
      },
      resources: [
        {
          storedFilename: 'IMG_0001.HEIC',
          byteCount: payload.length
        }
      ]
    };
    const event = {
      type: 'assetBackedUp',
      localIdentifier: 'receiver-asset',
      assetFolder: 'assets/2026/06/test-asset',
      resourceCount: 1,
      backedUpAt: new Date().toISOString()
    };

    await requestJson('POST', `${base}/api/asset/commit`, {
      assetFolder: 'assets/2026/06/test-asset',
      sidecar,
      event
    });

    const stats = await scanBackupRoot(path.join(root, 'Backup'));
    assert.equal(stats.assetCount, 1);
    assert.equal(stats.resourceCount, 1);
    assert.equal(stats.totalBytes, payload.length);
    assert.equal(stats.syncStatus.deviceName, 'Linda iPhone');
    assert.equal(stats.syncStatus.totalAssets, 42);
  } finally {
    await receiver.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
}

function requestJson(method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const isJson = body && !Buffer.isBuffer(body) && typeof body !== 'string';
    const data = body ? Buffer.from(isJson ? JSON.stringify(body) : body) : null;
    const request = https.request(url, {
      method,
      rejectUnauthorized: false,
      headers: {
        ...(isJson ? { 'content-type': 'application/json' } : {}),
        ...(data ? { 'content-length': data.length } : {}),
        ...headers
      }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`${response.statusCode}: ${text}`));
          return;
        }
        resolve(text ? JSON.parse(text) : {});
      });
    });
    request.on('error', reject);
    if (data) {
      request.write(data);
    }
    request.end();
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
