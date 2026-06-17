const fs = require('fs/promises');
const path = require('path');
const { VISIBLE_PHOTOS_DIR } = require('./visibleBackup');

const IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.heic',
  '.heif',
  '.webp',
  '.gif',
  '.tif',
  '.tiff',
  '.bmp'
]);

async function listPreviewPhotos(publicRoot, { limit = 60 } = {}) {
  const photosRoot = path.join(publicRoot, VISIBLE_PHOTOS_DIR);
  const metadataFiles = [];
  await collectMetadataFiles(photosRoot, metadataFiles);

  const photos = [];
  for (const metadataPath of metadataFiles) {
    try {
      const data = await fs.readFile(metadataPath, 'utf8');
      const sidecar = JSON.parse(data);
      const assetFolder = path.dirname(metadataPath);
      const resource = firstPreviewResource(sidecar.resources || []);
      if (!resource) {
        continue;
      }

      const filename = resource.storedFilename || resource.originalFilename;
      if (!filename) {
        continue;
      }
      const filePath = path.join(assetFolder, filename);
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) {
        continue;
      }

      const timestamp = sidecar.asset?.creationDate || sidecar.backedUpAt || stat.mtime.toISOString();
      photos.push({
        id: path.relative(photosRoot, filePath),
        filePath,
        filename,
        title: cleanTitle(filename),
        mediaType: sidecar.asset?.mediaType || 'image',
        creationDate: sidecar.asset?.creationDate || null,
        backedUpAt: sidecar.backedUpAt || null,
        timestamp,
        byteCount: Number(resource.byteCount || stat.size || 0),
        resourceType: resource.resourceType || null,
        relativeFolder: path.relative(publicRoot, assetFolder)
      });
    } catch {
      // Skip a broken preview entry; the scanner still owns detailed errors.
    }
  }

  photos.sort((left, right) => {
    const rightTime = Date.parse(right.timestamp || 0);
    const leftTime = Date.parse(left.timestamp || 0);
    return safeTime(rightTime) - safeTime(leftTime) || right.title.localeCompare(left.title);
  });

  return photos.slice(0, limit);
}

function firstPreviewResource(resources) {
  return resources.find(isImageResource) || null;
}

function isImageResource(resource) {
  const filename = resource.storedFilename || resource.originalFilename || '';
  const extension = path.extname(filename).toLowerCase();
  const uti = String(resource.uniformTypeIdentifier || '').toLowerCase();
  const type = String(resource.resourceType || '').toLowerCase();
  return IMAGE_EXTENSIONS.has(extension)
    || uti.startsWith('public.image')
    || uti.startsWith('image/')
    || type.includes('photo');
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

function cleanTitle(filename) {
  return path.basename(String(filename || 'Photo'), path.extname(String(filename || '')));
}

function safeTime(value) {
  return Number.isFinite(value) ? value : 0;
}

module.exports = {
  listPreviewPhotos
};
