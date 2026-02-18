const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');

function resolveWorkspaceRoot(start = process.cwd()) {
  let cursor = path.resolve(start);
  for (let depth = 0; depth < 6; depth += 1) {
    const hasAssets = fs.existsSync(path.join(cursor, 'Assets'));
    const hasTool = fs.existsSync(path.join(cursor, 'tool'));
    if (hasAssets && hasTool) {
      return cursor;
    }

    const next = path.dirname(cursor);
    if (next === cursor) break;
    cursor = next;
  }
  return path.resolve(start);
}

function sanitizeToken(value, fallback) {
  const normalized = String(value || '').trim();
  if (!normalized) return fallback;
  return normalized.replace(/[^a-zA-Z0-9_-]+/g, '_');
}

class ImagePatcher {
  constructor(options = {}) {
    this.workspaceRoot = path.resolve(options.workspaceRoot || resolveWorkspaceRoot());
    this.cacheDir = path.resolve(
      options.cacheDir || path.join(this.workspaceRoot, 'temp', 'repair'),
    );
  }

  async ensureCacheDir() {
    await fsPromises.mkdir(this.cacheDir, { recursive: true });
  }

  /**
   * @param {string} nodeId
   * @param {string} suffix
   * @param {string} [ext]
   * @returns {Promise<{ absolutePath: string, relativePath: string }>}
   */
  async allocateVariantPath(nodeId, suffix, ext = '.png') {
    await this.ensureCacheDir();
    const safeNodeId = sanitizeToken(nodeId, 'node');
    const safeSuffix = sanitizeToken(suffix, 'variant');
    const extension = String(ext || '.png').startsWith('.')
      ? String(ext || '.png')
      : `.${ext}`;

    let fileName = `${safeNodeId}_${safeSuffix}${extension}`;
    let absolutePath = path.join(this.cacheDir, fileName);
    let serial = 1;
    while (fs.existsSync(absolutePath)) {
      fileName = `${safeNodeId}_${safeSuffix}_${serial}${extension}`;
      absolutePath = path.join(this.cacheDir, fileName);
      serial += 1;
    }

    const relativePath = path.relative(this.workspaceRoot, absolutePath).replace(/\\/g, '/');
    return { absolutePath, relativePath };
  }

  /**
   * Copies a generated variant into cache. Use this for staged previews only.
   *
   * @param {string} sourcePath
   * @param {string} nodeId
   * @param {string} suffix
   * @returns {Promise<{ absolutePath: string, relativePath: string }>}
   */
  async stageFromFile(sourcePath, nodeId, suffix) {
    const target = await this.allocateVariantPath(nodeId, suffix, path.extname(sourcePath) || '.png');
    await fsPromises.copyFile(sourcePath, target.absolutePath);
    return target;
  }
}

module.exports = ImagePatcher;
