const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { scanBackupRoot } = require('../src/backupIndex');

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
  console.log('Smoke test passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
