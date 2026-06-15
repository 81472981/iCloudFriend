const fs = require('fs/promises');
const path = require('path');

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function scanBackupRoot(backupRoot) {
  const assetsRoot = path.join(backupRoot, '.icloudfriend', 'assets');
  const stats = {
    backupRoot,
    assetsRoot,
    exists: await pathExists(assetsRoot),
    assetCount: 0,
    resourceCount: 0,
    totalBytes: 0,
    recent: [],
    errors: [],
    disk: null
  };

  stats.disk = await readDiskStats(backupRoot);

  if (!stats.exists) {
    return stats;
  }

  const metadataFiles = [];
  await collectMetadataFiles(assetsRoot, metadataFiles);

  for (const metadataPath of metadataFiles) {
    try {
      const data = await fs.readFile(metadataPath, 'utf8');
      const sidecar = JSON.parse(data);
      const resources = Array.isArray(sidecar.resources) ? sidecar.resources : [];
      const byteCount = resources.reduce((sum, resource) => sum + Number(resource.byteCount || 0), 0);

      stats.assetCount += 1;
      stats.resourceCount += resources.length;
      stats.totalBytes += byteCount;
      stats.recent.push({
        metadataPath,
        assetFolder: path.relative(assetsRoot, path.dirname(metadataPath)),
        localIdentifier: sidecar.asset?.localIdentifier || '',
        mediaType: sidecar.asset?.mediaType || 'unknown',
        creationDate: sidecar.asset?.creationDate || null,
        backedUpAt: sidecar.backedUpAt || null,
        resourceCount: resources.length,
        byteCount,
        firstFilename: resources[0]?.storedFilename || path.basename(path.dirname(metadataPath))
      });
    } catch (error) {
      stats.errors.push({
        metadataPath,
        message: error.message
      });
    }
  }

  stats.recent.sort((left, right) => {
    const leftTime = Date.parse(left.backedUpAt || left.creationDate || 0);
    const rightTime = Date.parse(right.backedUpAt || right.creationDate || 0);
    return rightTime - leftTime;
  });
  stats.recent = stats.recent.slice(0, 20);

  return stats;
}

async function collectMetadataFiles(directory, output) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectMetadataFiles(fullPath, output);
    } else if (entry.isFile() && entry.name === 'metadata.json') {
      output.push(fullPath);
    }
  }
}

async function readDiskStats(backupRoot) {
  try {
    await fs.mkdir(backupRoot, { recursive: true });
    const stat = await fs.statfs(backupRoot);
    return {
      freeBytes: Number(stat.bavail) * Number(stat.bsize),
      totalBytes: Number(stat.blocks) * Number(stat.bsize)
    };
  } catch {
    return null;
  }
}

module.exports = {
  pathExists,
  scanBackupRoot
};
