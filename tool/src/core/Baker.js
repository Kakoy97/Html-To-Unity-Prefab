const path = require('path');

function resolveFsExtra() {
  try {
    return require('fs-extra');
  } catch (_) {
    return require(path.resolve(__dirname, '../../UIBaker/node_modules/fs-extra'));
  }
}

const fs = resolveFsExtra();

class Baker {
  constructor(context) {
    this.context = context;
    const config = this.context && this.context.config ? this.context.config : {};
    const rootOutputDir = config.outputDir || path.resolve(process.cwd(), 'output');
    this.outputDir = path.join(rootOutputDir, 'images');
  }

  async run(page, tasks) {
    if (!page) {
      throw new Error('Baker.run requires a valid Puppeteer page instance.');
    }

    const list = Array.isArray(tasks) ? tasks : [];
    await fs.ensureDir(this.outputDir);
    const nodeCaptures = {};

    for (const task of list) {
      if (!task || !task.type) continue;
      if (task.type === 'CAPTURE_PAGE') {
        await this._capturePage(page, task);
      } else if (task.type === 'CAPTURE_NODE') {
        const capture = await this._captureNode(page, task);
        const nodeId = task.nodeId || (task.params && task.params.nodeId);
        if (capture && nodeId) {
          nodeCaptures[nodeId] = capture;
        }
      }
    }

    return { nodeCaptures };
  }

  async _capturePage(page, task) {
    const params = task.params || {};
    const logicalWidth = this._toPositiveInt(params.logicalWidth, NaN);
    const logicalHeight = this._toPositiveInt(params.logicalHeight, NaN);
    const clip = {
      x: 0,
      y: 0,
      width: Number.isFinite(logicalWidth) ? logicalWidth : this._toPositiveInt(params.width, 1),
      height: Number.isFinite(logicalHeight) ? logicalHeight : this._toPositiveInt(params.height, 1),
    };

    const savePath = path.join(this.outputDir, `${task.outputName}.png`);
    await page.screenshot({
      path: savePath,
      clip,
      captureBeyondViewport: true,
      omitBackground: false,
    });
  }

  async _captureNode(page, task) {
    const params = task.params || {};
    const nodeId = task.nodeId || params.nodeId;
    const hideChildren = !!params.hideChildren;
    const mode = params.mode || 'clone';
    const neutralizeTransforms = !!params.neutralizeTransforms;

    if (!nodeId) {
      return null;
    }

    if (mode === 'inPlace') {
      return this._captureNodeInPlace(page, task, nodeId, hideChildren, neutralizeTransforms);
    }

    return this._captureNodeClone(page, task, nodeId, hideChildren);
  }

  async _captureNodeClone(page, task, nodeId, hideChildren) {
    const savePath = path.join(this.outputDir, `${task.outputName}.png`);

    await page.evaluate(this._browserCleanupLogic);

    let captureState = null;
    try {
      captureState = await page.evaluate(this._browserCaptureLogic, nodeId, hideChildren);
      const rawClip = captureState && captureState.clip ? captureState.clip : captureState;
      const normalizedClip = this._normalizeClip(rawClip);

      if (normalizedClip) {
        await page.screenshot({
          path: savePath,
          clip: normalizedClip,
          omitBackground: true,
          captureBeyondViewport: true,
        });
        return this._buildCloneCaptureMeta(captureState, normalizedClip);
      }
    } finally {
      await page.evaluate(this._browserCleanupLogic);
    }

    return null;
  }

  async _captureNodeInPlace(page, task, nodeId, hideChildren, neutralizeTransforms) {
    const savePath = path.join(this.outputDir, `${task.outputName}.png`);

    await page.evaluate(this._browserCleanupLogic);

    let captureState = null;
    try {
      captureState = await page.evaluate(
        this._browserInPlaceSetupLogic,
        nodeId,
        hideChildren,
        neutralizeTransforms,
      );
      const rawClip = captureState && captureState.clip ? captureState.clip : captureState;
      const normalizedClip = this._normalizeClip(rawClip);

      if (normalizedClip) {
        await page.screenshot({
          path: savePath,
          clip: normalizedClip,
          omitBackground: true,
          captureBeyondViewport: true,
        });
        return this._buildInPlaceCaptureMeta(captureState, normalizedClip);
      }
    } finally {
      await page.evaluate(this._browserCleanupLogic);
    }

    return null;
  }

  _normalizeClip(clip) {
    if (!clip || typeof clip !== 'object') return null;

    const width = Number(clip.width);
    const height = Number(clip.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return null;
    }

    const x = Number.isFinite(Number(clip.x)) ? Number(clip.x) : 0;
    const y = Number.isFinite(Number(clip.y)) ? Number(clip.y) : 0;

    const normalizedX = Math.max(0, x);
    const normalizedY = Math.max(0, y);
    const normalizedWidth = Math.max(1, width - (normalizedX - x));
    const normalizedHeight = Math.max(1, height - (normalizedY - y));

    return {
      x: Math.round(normalizedX),
      y: Math.round(normalizedY),
      width: Math.max(1, Math.round(normalizedWidth)),
      height: Math.max(1, Math.round(normalizedHeight)),
    };
  }

  _toPositiveInt(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return parsed;
  }

  _toNumber(value, fallback = 0) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return parsed;
  }

  _round(value, digits = 3) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
  }

  _buildCloneCaptureMeta(captureState, normalizedClip) {
    if (!captureState || !normalizedClip) return null;
    const dpr = this._getDpr();
    const contentOffsetX = Math.max(0, this._toNumber(captureState.contentOffsetX, 0));
    const contentOffsetY = Math.max(0, this._toNumber(captureState.contentOffsetY, 0));
    const contentWidth = this._toNumber(captureState.contentWidth, normalizedClip.width);
    const contentHeight = this._toNumber(captureState.contentHeight, normalizedClip.height);
    return {
      mode: 'clone',
      imageWidth: this._round(normalizedClip.width * dpr),
      imageHeight: this._round(normalizedClip.height * dpr),
      contentOffsetX: this._round(contentOffsetX * dpr),
      contentOffsetY: this._round(contentOffsetY * dpr),
      contentWidth: this._round(contentWidth * dpr),
      contentHeight: this._round(contentHeight * dpr),
    };
  }

  _buildInPlaceCaptureMeta(captureState, normalizedClip) {
    if (!captureState || !normalizedClip) return null;
    const dpr = this._getDpr();
    const elementRect = captureState.elementRect || {};
    const elementX = this._toNumber(elementRect.x, normalizedClip.x);
    const elementY = this._toNumber(elementRect.y, normalizedClip.y);
    const elementWidth = this._toNumber(elementRect.width, normalizedClip.width);
    const elementHeight = this._toNumber(elementRect.height, normalizedClip.height);
    const contentOffsetX = Math.max(0, elementX - normalizedClip.x);
    const contentOffsetY = Math.max(0, elementY - normalizedClip.y);
    return {
      mode: 'inPlace',
      imageWidth: this._round(normalizedClip.width * dpr),
      imageHeight: this._round(normalizedClip.height * dpr),
      contentOffsetX: this._round(contentOffsetX * dpr),
      contentOffsetY: this._round(contentOffsetY * dpr),
      contentWidth: this._round(elementWidth * dpr),
      contentHeight: this._round(elementHeight * dpr),
    };
  }

  _getDpr() {
    const config = this.context && this.context.config ? this.context.config : {};
    const dpr = Number(config.dpr);
    if (!Number.isFinite(dpr) || dpr <= 0) return 1;
    return dpr;
  }

  _browserInPlaceSetupLogic(nodeId, hideChildren, neutralizeTransforms) {
    const root = window;
    const cleanupState = root.__bakeCleanupState || (root.__bakeCleanupState = { touchedNodes: [] });

    const markNode = (node) => {
      if (!node || node.nodeType !== 1) return;
      if (node.__bakeMarked) return;
      node.__bakeMarked = true;
      cleanupState.touchedNodes.push(node);
      node.__bakePrevStyles = node.__bakePrevStyles || {};
    };

    const setStyle = (node, prop, value, priority = 'important') => {
      if (!node || node.nodeType !== 1) return;
      markNode(node);
      if (!Object.prototype.hasOwnProperty.call(node.__bakePrevStyles, prop)) {
        node.__bakePrevStyles[prop] = {
          value: node.style.getPropertyValue(prop),
          priority: node.style.getPropertyPriority(prop),
        };
      }
      if (value == null) {
        node.style.removeProperty(prop);
      } else {
        node.style.setProperty(prop, value, priority);
      }
    };

    const stripRotation = (transform) => {
      if (!transform || transform === 'none') return null;

      const matrix3d = transform.match(/matrix3d\(([^)]+)\)/);
      if (matrix3d) {
        return null;
      }

      const matrixMatch = transform.match(/matrix\(([^)]+)\)/);
      if (!matrixMatch) return null;

      const values = matrixMatch[1].split(',').map((v) => parseFloat(v.trim()));
      if (values.length < 6) return null;

      const [a, b, c, d, e, f] = values;
      const angle = Math.atan2(b, a);
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const a2 = cos * a + sin * b;
      const b2 = -sin * a + cos * b;
      const c2 = cos * c + sin * d;
      const d2 = -sin * c + cos * d;
      return `matrix(${a2}, ${b2}, ${c2}, ${d2}, ${e}, ${f})`;
    };

    const parseBoxShadowPad = (boxShadow) => {
      if (!boxShadow || boxShadow === 'none') return 0;
      const parts = [];
      let depth = 0;
      let current = '';
      for (const ch of boxShadow) {
        if (ch === '(') depth += 1;
        if (ch === ')') depth = Math.max(0, depth - 1);
        if (ch === ',' && depth === 0) {
          parts.push(current);
          current = '';
        } else {
          current += ch;
        }
      }
      if (current.trim()) parts.push(current);

      let maxPad = 0;
      for (const part of parts) {
        const values = part.match(/-?\d*\.?\d+px/g) || [];
        const nums = values.map((v) => parseFloat(v));
        const offsetX = nums[0] || 0;
        const offsetY = nums[1] || 0;
        const blur = nums[2] || 0;
        const spread = nums[3] || 0;
        const pad = Math.max(Math.abs(offsetX), Math.abs(offsetY)) + blur + spread;
        if (pad > maxPad) maxPad = pad;
      }
      return maxPad;
    };

    const parseDropShadowPad = (filterValue) => {
      if (!filterValue || filterValue === 'none') return 0;
      const matches = filterValue.match(/drop-shadow\(([^)]+)\)/g) || [];
      let maxPad = 0;
      for (const match of matches) {
        const inner = match.slice('drop-shadow('.length, -1);
        const values = inner.match(/-?\d*\.?\d+px/g) || [];
        const nums = values.map((v) => parseFloat(v));
        const offsetX = nums[0] || 0;
        const offsetY = nums[1] || 0;
        const blur = nums[2] || 0;
        const pad = Math.max(Math.abs(offsetX), Math.abs(offsetY)) + blur;
        if (pad > maxPad) maxPad = pad;
      }
      return maxPad;
    };

    const staleStyle = document.getElementById('bake-isolation-style');
    if (staleStyle) staleStyle.remove();

    const el = document.querySelector(`[data-bake-id="${nodeId}"]`);
    if (!el) return null;

    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    const styleTag = document.createElement('style');
    styleTag.id = 'bake-isolation-style';
    styleTag.innerHTML = [
      '*, *::before, *::after {',
      '  transition-property: none !important;',
      '  transition-duration: 0s !important;',
      '  transition-delay: 0s !important;',
      '  animation: none !important;',
      '}',
      'html, body {',
      '  background: transparent !important;',
      '  background-color: transparent !important;',
      '  background-image: none !important;',
      '}',
      'html::before, html::after, body::before, body::after {',
      '  content: none !important;',
      '  display: none !important;',
      '}',
      'body * { visibility: hidden !important; }',
    ].join('\n');
    document.head.appendChild(styleTag);

    let revealCursor = el;
    while (revealCursor && revealCursor.nodeType === 1) {
      setStyle(revealCursor, 'visibility', 'visible');
      revealCursor = revealCursor.parentElement;
    }

    if (hideChildren) {
      const descendants = el.querySelectorAll('*');
      for (const child of descendants) {
        setStyle(child, 'visibility', 'hidden');
      }
      setStyle(el, 'color', 'transparent');
      setStyle(el, '-webkit-text-fill-color', 'transparent');
      setStyle(el, 'text-shadow', 'none');
    }

    if (neutralizeTransforms) {
      let current = el;
      while (current && current.nodeType === 1) {
        const computed = window.getComputedStyle(current);
        const override = stripRotation(computed.transform);
        if (override) {
          setStyle(current, 'transform', override);
          setStyle(current, 'transform-origin', computed.transformOrigin || '0 0');
          setStyle(current, 'rotate', '0deg');
          setStyle(current, '--tw-rotate', '0deg');
          setStyle(current, '--tw-rotate-x', '0deg');
          setStyle(current, '--tw-rotate-y', '0deg');
        }
        current = current.parentElement;
      }
    }

    const style = window.getComputedStyle(el);
    const shadowPad = Math.max(
      parseBoxShadowPad(style.boxShadow),
      parseDropShadowPad(style.filter),
    );
    const finalRect = el.getBoundingClientRect();

    return {
      clip: {
        x: finalRect.left - shadowPad,
        y: finalRect.top - shadowPad,
        width: finalRect.width + shadowPad * 2,
        height: finalRect.height + shadowPad * 2,
      },
      elementRect: {
        x: finalRect.left,
        y: finalRect.top,
        width: finalRect.width,
        height: finalRect.height,
      },
    };
  }

  _browserCaptureLogic(nodeId, hideChildren) {
    const staleClones = document.querySelectorAll('[data-bake-clone="true"]');
    for (const stale of staleClones) {
      stale.remove();
    }
    const staleStyle = document.getElementById('bake-isolation-style');
    if (staleStyle) staleStyle.remove();

    const el = document.querySelector(`[data-bake-id="${nodeId}"]`);
    if (!el) return null;

    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    const style = window.getComputedStyle(el);
    const clone = el.cloneNode(true);
    const parseBoxShadowPad = (boxShadow) => {
      if (!boxShadow || boxShadow === 'none') return 0;
      const parts = [];
      let depth = 0;
      let current = '';
      for (const ch of boxShadow) {
        if (ch === '(') depth += 1;
        if (ch === ')') depth = Math.max(0, depth - 1);
        if (ch === ',' && depth === 0) {
          parts.push(current);
          current = '';
        } else {
          current += ch;
        }
      }
      if (current.trim()) parts.push(current);

      let maxPad = 0;
      for (const part of parts) {
        const values = part.match(/-?\d*\.?\d+px/g) || [];
        const nums = values.map((v) => parseFloat(v));
        const offsetX = nums[0] || 0;
        const offsetY = nums[1] || 0;
        const blur = nums[2] || 0;
        const spread = nums[3] || 0;
        const pad = Math.max(Math.abs(offsetX), Math.abs(offsetY)) + blur + spread;
        if (pad > maxPad) maxPad = pad;
      }
      return maxPad;
    };

    const parseDropShadowPad = (filterValue) => {
      if (!filterValue || filterValue === 'none') return 0;
      const matches = filterValue.match(/drop-shadow\(([^)]+)\)/g) || [];
      let maxPad = 0;
      for (const match of matches) {
        const inner = match.slice('drop-shadow('.length, -1);
        const values = inner.match(/-?\d*\.?\d+px/g) || [];
        const nums = values.map((v) => parseFloat(v));
        const offsetX = nums[0] || 0;
        const offsetY = nums[1] || 0;
        const blur = nums[2] || 0;
        const pad = Math.max(Math.abs(offsetX), Math.abs(offsetY)) + blur;
        if (pad > maxPad) maxPad = pad;
      }
      return maxPad;
    };

    const shadowPad = Math.max(
      parseBoxShadowPad(style.boxShadow),
      parseDropShadowPad(style.filter),
    );

    clone.style.position = 'fixed';
    clone.style.left = `${shadowPad}px`;
    clone.style.top = `${shadowPad}px`;
    clone.style.width = `${rect.width}px`;
    clone.style.height = `${rect.height}px`;
    clone.style.margin = '0';
    clone.style.transform = 'none';
    clone.style.transformOrigin = '0 0';
    clone.style.zIndex = '999999';

    const propsToCopy = [
      'backgroundColor',
      'backgroundImage',
      'backgroundSize',
      'backgroundPosition',
      'backgroundRepeat',
      'backgroundOrigin',
      'backgroundClip',
      'backgroundAttachment',
      'borderTopWidth',
      'borderRightWidth',
      'borderBottomWidth',
      'borderLeftWidth',
      'borderTopColor',
      'borderRightColor',
      'borderBottomColor',
      'borderLeftColor',
      'borderTopStyle',
      'borderRightStyle',
      'borderBottomStyle',
      'borderLeftStyle',
      'borderRadius',
      'boxShadow',
      'filter',
      'opacity',
    ];

    for (const prop of propsToCopy) {
      clone.style[prop] = style[prop];
    }

    if (hideChildren) {
      clone.innerHTML = '';
    }

    clone.setAttribute('data-bake-clone', 'true');
    document.body.appendChild(clone);

    const styleTag = document.createElement('style');
    styleTag.id = 'bake-isolation-style';
    styleTag.innerHTML = [
      'html, body {',
      '  background: transparent !important;',
      '  background-color: transparent !important;',
      '  background-image: none !important;',
      '}',
      'html::before, html::after, body::before, body::after {',
      '  content: none !important;',
      '  display: none !important;',
      '}',
      'body > *:not([data-bake-clone="true"]) {',
      '  visibility: hidden !important;',
      '}',
    ].join('\n');
    document.head.appendChild(styleTag);

    return {
      clip: {
        x: 0,
        y: 0,
        width: Math.max(1, Math.ceil(rect.width + shadowPad * 2)),
        height: Math.max(1, Math.ceil(rect.height + shadowPad * 2)),
      },
      contentOffsetX: shadowPad,
      contentOffsetY: shadowPad,
      contentWidth: rect.width,
      contentHeight: rect.height,
    };
  }

  _browserCleanupLogic() {
    const cleanupState = window.__bakeCleanupState;
    if (cleanupState && Array.isArray(cleanupState.touchedNodes)) {
      for (const node of cleanupState.touchedNodes) {
        if (!node || node.nodeType !== 1) continue;
        const prevStyles = node.__bakePrevStyles || {};
        for (const prop of Object.keys(prevStyles)) {
          const prev = prevStyles[prop];
          if (prev && prev.value) {
            node.style.setProperty(prop, prev.value, prev.priority || '');
          } else {
            node.style.removeProperty(prop);
          }
        }
        delete node.__bakePrevStyles;
        delete node.__bakeMarked;
      }
      cleanupState.touchedNodes.length = 0;
    }

    const clones = document.querySelectorAll('[data-bake-clone="true"]');
    for (const clone of clones) {
      clone.remove();
    }

    const styleTag = document.getElementById('bake-isolation-style');
    if (styleTag) {
      styleTag.remove();
    }
  }
}

module.exports = Baker;
