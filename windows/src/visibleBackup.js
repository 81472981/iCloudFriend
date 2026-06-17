const fs = require('fs/promises');
const path = require('path');

const VISIBLE_PHOTOS_DIR = 'Photos';

async function mirrorAssetToVisibleFolder({ internalRoot, publicRoot, assetFolder, sidecar, strict = true }) {
  if (!sidecar || !Array.isArray(sidecar.resources)) {
    return { mirrored: 0, skipped: 0, visibleFolder: null };
  }

  const safeAssetFolder = sanitizeRelativePath(assetFolder);
  const visibleFolder = visibleFolderForAsset(publicRoot, safeAssetFolder);
  await fs.mkdir(visibleFolder, { recursive: true });

  await writeJsonAtomic(path.join(visibleFolder, 'metadata.json'), sidecar);

  let mirrored = 0;
  let skipped = 0;
  for (const resource of sidecar.resources) {
    const sourceRelativePath = sanitizeRelativePath(
      resource.relativePath || path.posix.join(safeAssetFolder.replaceAll(path.sep, '/'), 'resources', resource.storedFilename || '')
    );
    const sourcePath = safeJoin(internalRoot, sourceRelativePath);
    const visibleName = cleanFileName(
      resource.storedFilename || resource.originalFilename || path.basename(sourceRelativePath),
      `resource-${mirrored + skipped + 1}`
    );
    const targetPath = safeJoin(visibleFolder, visibleName);
    const expectedBytes = Number(resource.byteCount || 0);

    try {
      await mirrorFile(sourcePath, targetPath, expectedBytes);
      mirrored += 1;
    } catch (error) {
      skipped += 1;
      if (strict) {
        throw error;
      }
      console.warn(`Unable to mirror ${sourceRelativePath}: ${error.message}`);
    }
  }

  return {
    mirrored,
    skipped,
    visibleFolder: path.relative(publicRoot, visibleFolder)
  };
}

async function mirrorExistingBackups({ internalRoot, publicRoot }) {
  const metadataFiles = [];
  await collectMetadataFiles(path.join(internalRoot, 'assets'), metadataFiles);

  let assets = 0;
  let resources = 0;
  for (const metadataPath of metadataFiles) {
    try {
      const data = await fs.readFile(metadataPath, 'utf8');
      const sidecar = JSON.parse(data);
      const assetFolder = toPosix(path.relative(internalRoot, path.dirname(metadataPath)));
      const result = await mirrorAssetToVisibleFolder({
        internalRoot,
        publicRoot,
        assetFolder,
        sidecar,
        strict: false
      });
      assets += 1;
      resources += result.mirrored;
    } catch (error) {
      console.warn(`Unable to mirror existing backup ${metadataPath}: ${error.message}`);
    }
  }

  return { assets, resources };
}

function visibleFolderForAsset(publicRoot, assetFolder) {
  const parts = toPosix(assetFolder).split('/').filter(Boolean);
  if (parts[0] === 'assets' && parts.length >= 4) {
    return safeJoin(publicRoot, VISIBLE_PHOTOS_DIR, parts[1], parts[2], parts.slice(3).join('-'));
  }
  return safeJoin(publicRoot, VISIBLE_PHOTOS_DIR, 'Unknown', parts.join('-') || 'asset');
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

async function mirrorFile(sourcePath, targetPath, expectedBytes) {
  const currentSize = await fileSize(targetPath);
  if (expectedBytes > 0 && currentSize === expectedBytes) {
    return;
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.rm(targetPath, { force: true });
  try {
    await fs.link(sourcePath, targetPath);
  } catch (error) {
    if (['EXDEV', 'EPERM', 'EACCES', 'EEXIST'].includes(error.code)) {
      await fs.copyFile(sourcePath, targetPath);
      return;
    }
    throw error;
  }
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

function sanitizeRelativePath(value) {
  const normalized = path.normalize(String(value || '').replaceAll('\0', '').replaceAll('\\', '/'));
  if (!normalized || normalized === '.' || path.isAbsolute(normalized) || normalized.startsWith('..')) {
    throw new Error('Invalid relative path.');
  }
  return normalized;
}

function safeJoin(root, ...pieces) {
  const rootPath = path.resolve(root);
  const target = path.resolve(rootPath, ...pieces);
  if (target !== rootPath && !target.startsWith(`${rootPath}${path.sep}`)) {
    throw new Error('Path escapes backup root.');
  }
  return target;
}

function cleanFileName(value, fallback) {
  const cleaned = String(value || fallback)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || fallback;
}

function toPosix(value) {
  return String(value || '').split(path.sep).join('/');
}

module.exports = {
  VISIBLE_PHOTOS_DIR,
  mirrorAssetToVisibleFolder,
  mirrorExistingBackups,
  visibleFolderForAsset
};
