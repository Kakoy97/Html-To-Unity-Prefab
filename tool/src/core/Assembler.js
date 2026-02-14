const path = require('path');

function resolveFsExtra() {
  try {
    return require('fs-extra');
  } catch (_) {
    return require(path.resolve(__dirname, '../../UIBaker/node_modules/fs-extra'));
  }
}

const fs = resolveFsExtra();

class Assembler {
  constructor(context) {
    this.context = context;
  }

  async run(analysisRoot, planTasks, bakeResult = null) {
    const config = this.context && this.context.config ? this.context.config : {};
    const outputDir = config.outputDir || path.resolve(process.cwd(), 'output');
    await fs.ensureDir(outputDir);

    const imageMap = new Map();
    const captureMap = new Map();
    const tasks = Array.isArray(planTasks) ? planTasks : [];
    for (const task of tasks) {
      if (!task || task.type !== 'CAPTURE_NODE' || !task.outputName) continue;
      const nodeId = (task.params && task.params.nodeId) || task.nodeId;
      if (!nodeId) continue;
      imageMap.set(nodeId, path.posix.join('images', `${task.outputName}.png`));
    }
    this._populateCaptureMap(captureMap, bakeResult);

    const layoutRoot = this._transformNode(analysisRoot, imageMap, captureMap);
    if (!layoutRoot) return null;

    const dpr = this._toPositiveNumber(config.dpr, 1);
    const logicalWidth = this._toPositiveNumber(
      config.contentLogicalWidth,
      this._toPositiveNumber(config.logicalWidth, 375),
    );
    const contentHeight = this._toPositiveNumber(
      this.context.contentHeight,
      this._toPositiveNumber(config.contentLogicalHeight, logicalWidth * (1624 / 750)),
    );

    layoutRoot.rect = layoutRoot.rect || { x: 0, y: 0, width: 0, height: 0 };
    layoutRoot.rect.x = 0;
    layoutRoot.rect.y = 0;
    layoutRoot.rect.width = Math.max(1, Math.round(logicalWidth * dpr));
    layoutRoot.rect.height = Math.max(1, Math.round(contentHeight * dpr));
    layoutRoot.imagePath = 'images/bg.png';

    this._computeContentBounds(layoutRoot);
    return layoutRoot;
  }

  _transformNode(node, imageMap, captureMap) {
    if (!node) return null;

    const layoutNode = {
      id: node.id || '',
      type: node.type || 'Container',
      tagName: node.tagName || '',
      htmlTag: node.htmlTag || '',
      role: node.role || '',
      inputType: node.inputType || '',
      classes: Array.isArray(node.classes) ? node.classes : [],
      attrs: Array.isArray(node.attrs) ? node.attrs : [],
      domPath: node.domPath || '',
      rect: this._copyRect(node.rect),
      contentBounds: node.contentBounds ? this._copyRect(node.contentBounds) : null,
      rotation: this._toNumber(node.rotation, 0),
      transformNeutralized: !!node.transformNeutralized,
      neutralizedAncestorCount: this._toInteger(node.neutralizedAncestorCount, 0),
      text: typeof node.text === 'string' ? node.text : '',
      style: this._extractStyle(node),
      imagePath: imageMap.get(node.id) || node.imagePath || null,
      capture: this._extractCaptureInfo(node, captureMap),
      rotationBaked: !!node.rotationBaked,
      rotationOriginal: this._toNumber(node.rotationOriginal, 0),
      children: [],
    };

    const children = Array.isArray(node.children) ? node.children : [];
    for (const child of children) {
      const childLayout = this._transformNode(child, imageMap, captureMap);
      if (childLayout) {
        layoutNode.children.push(childLayout);
      }
    }

    return layoutNode;
  }

  _populateCaptureMap(captureMap, bakeResult) {
    if (!captureMap || !bakeResult || typeof bakeResult !== 'object') return;
    const nodeCaptures = bakeResult.nodeCaptures;
    if (!nodeCaptures || typeof nodeCaptures !== 'object') return;
    for (const [nodeId, capture] of Object.entries(nodeCaptures)) {
      if (!nodeId || !capture || typeof capture !== 'object') continue;
      captureMap.set(nodeId, capture);
    }
  }

  _extractCaptureInfo(node, captureMap) {
    if (!node) return null;
    const fromBake = captureMap && captureMap.get ? captureMap.get(node.id) : null;
    const source = fromBake || node.capture;
    if (!source || typeof source !== 'object') return null;

    const imageWidth = this._toNumber(source.imageWidth, 0);
    const imageHeight = this._toNumber(source.imageHeight, 0);
    const contentOffsetX = this._toNumber(source.contentOffsetX, 0);
    const contentOffsetY = this._toNumber(source.contentOffsetY, 0);
    const contentWidth = this._toNumber(source.contentWidth, 0);
    const contentHeight = this._toNumber(source.contentHeight, 0);
    const mode = source.mode ? String(source.mode) : '';

    if (imageWidth <= 0 || imageHeight <= 0) return null;

    return {
      mode,
      imageWidth,
      imageHeight,
      contentOffsetX,
      contentOffsetY,
      contentWidth: contentWidth > 0 ? contentWidth : 0,
      contentHeight: contentHeight > 0 ? contentHeight : 0,
    };
  }

  _computeContentBounds(node) {
    if (!node) return null;

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    const traverse = (current) => {
      if (!current || !current.rect) return;

      const rect = current.rect;
      const x = this._toNumber(rect.x, 0);
      const y = this._toNumber(rect.y, 0);
      const width = this._toNumber(rect.width, 0);
      const height = this._toNumber(rect.height, 0);

      if (width > 0 && height > 0) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x + width);
        maxY = Math.max(maxY, y + height);
      }

      const children = Array.isArray(current.children) ? current.children : [];
      for (const child of children) {
        traverse(child);
      }
    };

    const children = Array.isArray(node.children) ? node.children : [];
    for (const child of children) {
      traverse(child);
    }

    if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
      node.contentBounds = this._copyRect(node.rect);
    } else {
      node.contentBounds = {
        x: minX,
        y: minY,
        width: Math.max(1, maxX - minX),
        height: Math.max(1, maxY - minY),
      };
    }

    return node.contentBounds;
  }

  _extractStyle(node) {
    if (!node) return null;
    if (node.style && typeof node.style === 'object') return node.style;
    if (node.font && typeof node.font === 'object') return node.font;
    if (node.styles && node.styles.font && typeof node.styles.font === 'object') {
      return node.styles.font;
    }
    return null;
  }

  _copyRect(rect) {
    if (!rect || typeof rect !== 'object') {
      return { x: 0, y: 0, width: 0, height: 0 };
    }
    return {
      x: this._toNumber(rect.x, 0),
      y: this._toNumber(rect.y, 0),
      width: this._toNumber(rect.width, 0),
      height: this._toNumber(rect.height, 0),
    };
  }

  _toNumber(value, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return parsed;
  }

  _toInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return parsed;
  }

  _toPositiveNumber(value, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return parsed;
  }
}

module.exports = Assembler;
