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
    const captureSourceNodeId = params.captureSourceNodeId || nodeId;
    const rangePart = params.rangePart || '';
    const hideChildren = !!params.hideChildren;
    const hideOwnText = !!params.hideOwnText;
    const rotationBaked = !!params.rotationBaked;
    const rotationOriginal = this._toNumber(params.rotationOriginal, 0);
    const mode = params.mode || 'clone';
    const neutralizeTransforms = !!params.neutralizeTransforms;
    const suppressAncestorPaint = !!params.suppressAncestorPaint;
    const preserveOwnTextGeometry = !!params.preserveOwnTextGeometry;
    const preserveSceneUnderlay = !!params.preserveSceneUnderlay;
    const suppressUnderlayFaintBorder = !!params.suppressUnderlayFaintBorder;
    const backgroundStackNodeIds = Array.isArray(params.backgroundStackNodeIds)
      ? params.backgroundStackNodeIds.filter((id) => typeof id === 'string' && id.trim().length > 0)
      : [];
    const decoupleOpacity = !!params.decoupleOpacity;
    const renderOpacity = this._clamp01(this._toNumber(params.renderOpacity, 1), 1);

    if (!nodeId) {
      return null;
    }

    if (mode === 'rangePart') {
      return this._captureRangePart(page, task, captureSourceNodeId, rangePart, rotationBaked, rotationOriginal);
    }

    if (mode === 'inPlace') {
      return this._captureNodeInPlace(
        page,
        task,
        captureSourceNodeId,
        hideChildren,
        hideOwnText,
        rotationBaked,
        rotationOriginal,
        neutralizeTransforms,
        suppressAncestorPaint,
        preserveOwnTextGeometry,
        preserveSceneUnderlay,
        suppressUnderlayFaintBorder,
        decoupleOpacity,
        renderOpacity,
      );
    }
    if (mode === 'backgroundStack') {
      return this._captureBackgroundStack(
        page,
        task,
        captureSourceNodeId,
        backgroundStackNodeIds,
        rotationBaked,
        rotationOriginal,
      );
    }

    return this._captureNodeClone(
      page,
      task,
      nodeId,
      hideChildren,
      hideOwnText,
      rotationBaked,
      rotationOriginal,
      decoupleOpacity,
      renderOpacity,
    );
  }

  async _captureNodeClone(
    page,
    task,
    nodeId,
    hideChildren,
    hideOwnText,
    rotationBaked,
    rotationOriginal,
    decoupleOpacity,
    renderOpacity,
  ) {
    const savePath = path.join(this.outputDir, `${task.outputName}.png`);

    await page.evaluate(this._browserCleanupLogic);

    let captureState = null;
    try {
      captureState = await page.evaluate(
        this._browserCaptureLogic,
        nodeId,
        hideChildren,
        hideOwnText,
        decoupleOpacity,
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
        return this._buildCloneCaptureMeta(
          captureState,
          normalizedClip,
          rotationBaked,
          rotationOriginal,
          decoupleOpacity,
          renderOpacity,
        );
      }
    } finally {
      await page.evaluate(this._browserCleanupLogic);
    }

    return null;
  }

  async _captureNodeInPlace(
    page,
    task,
    nodeId,
    hideChildren,
    hideOwnText,
    rotationBaked,
    rotationOriginal,
    neutralizeTransforms,
    suppressAncestorPaint,
    preserveOwnTextGeometry,
    preserveSceneUnderlay,
    suppressUnderlayFaintBorder,
    decoupleOpacity,
    renderOpacity,
  ) {
    const savePath = path.join(this.outputDir, `${task.outputName}.png`);

    await page.evaluate(this._browserCleanupLogic);

    let captureState = null;
    try {
      captureState = await page.evaluate(
        this._browserInPlaceSetupLogic,
        nodeId,
        hideChildren,
        hideOwnText,
        neutralizeTransforms,
        suppressAncestorPaint,
        preserveOwnTextGeometry,
        preserveSceneUnderlay,
        suppressUnderlayFaintBorder,
        decoupleOpacity,
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
        return this._buildInPlaceCaptureMeta(
          captureState,
          normalizedClip,
          rotationBaked,
          rotationOriginal,
          decoupleOpacity,
          renderOpacity,
        );
      }
    } finally {
      await page.evaluate(this._browserCleanupLogic);
    }

    return null;
  }

  async _captureBackgroundStack(
    page,
    task,
    sourceNodeId,
    backgroundStackNodeIds,
    rotationBaked,
    rotationOriginal,
  ) {
    const savePath = path.join(this.outputDir, `${task.outputName}.png`);
    if (!sourceNodeId) {
      return null;
    }

    await page.evaluate(this._browserCleanupLogic);

    let captureState = null;
    try {
      captureState = await page.evaluate(
        this._browserBackgroundStackSetupLogic,
        sourceNodeId,
        Array.isArray(backgroundStackNodeIds) ? backgroundStackNodeIds : [],
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
        const meta = this._buildInPlaceCaptureMeta(
          captureState,
          normalizedClip,
          rotationBaked,
          rotationOriginal,
          false,
          1,
        ) || {};
        meta.mode = 'backgroundStack';
        return meta;
      }
    } finally {
      await page.evaluate(this._browserCleanupLogic);
    }

    return null;
  }

  async _captureRangePart(page, task, sourceNodeId, rangePart, rotationBaked, rotationOriginal) {
    const savePath = path.join(this.outputDir, `${task.outputName}.png`);
    const normalizedPart = String(rangePart || '').trim().toLowerCase();
    if (!sourceNodeId || !normalizedPart) {
      return null;
    }

    await page.evaluate(this._browserCleanupLogic);

    let captureState = null;
    try {
      captureState = await page.evaluate(
        this._browserRangePartSetupLogic,
        sourceNodeId,
        normalizedPart,
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
        return this._buildInPlaceCaptureMeta(
          captureState,
          normalizedClip,
          rotationBaked,
          rotationOriginal,
          false,
          1,
        );
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

  _clamp01(value, fallback = 1) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    if (parsed < 0) return 0;
    if (parsed > 1) return 1;
    return parsed;
  }

  _round(value, digits = 3) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
  }

  _buildCloneCaptureMeta(
    captureState,
    normalizedClip,
    rotationBaked,
    rotationOriginal,
    decoupleOpacity,
    renderOpacity,
  ) {
    if (!captureState || !normalizedClip) return null;
    const dpr = this._getDpr();
    const contentOffsetX = Math.max(0, this._toNumber(captureState.contentOffsetX, 0));
    const contentOffsetY = Math.max(0, this._toNumber(captureState.contentOffsetY, 0));
    const contentWidth = this._toNumber(captureState.contentWidth, normalizedClip.width);
    const contentHeight = this._toNumber(captureState.contentHeight, normalizedClip.height);
    const meta = {
      mode: 'clone',
      imageWidth: this._round(normalizedClip.width * dpr),
      imageHeight: this._round(normalizedClip.height * dpr),
      contentOffsetX: this._round(contentOffsetX * dpr),
      contentOffsetY: this._round(contentOffsetY * dpr),
      contentWidth: this._round(contentWidth * dpr),
      contentHeight: this._round(contentHeight * dpr),
      rotationBaked: false,
      rotationOriginal: this._round(this._toNumber(rotationOriginal, 0), 6),
      requestedRotationBake: !!rotationBaked,
    };
    if (decoupleOpacity) {
      meta.opacityDecoupled = true;
      meta.renderOpacity = this._round(this._clamp01(renderOpacity, 1), 6);
    }
    return meta;
  }

  _buildInPlaceCaptureMeta(
    captureState,
    normalizedClip,
    rotationBaked,
    rotationOriginal,
    decoupleOpacity,
    renderOpacity,
  ) {
    if (!captureState || !normalizedClip) return null;
    const dpr = this._getDpr();
    const elementRect = captureState.elementRect || {};
    const elementX = this._toNumber(elementRect.x, normalizedClip.x);
    const elementY = this._toNumber(elementRect.y, normalizedClip.y);
    const elementWidth = this._toNumber(elementRect.width, normalizedClip.width);
    const elementHeight = this._toNumber(elementRect.height, normalizedClip.height);
    const contentOffsetX = Math.max(0, elementX - normalizedClip.x);
    const contentOffsetY = Math.max(0, elementY - normalizedClip.y);
    const meta = {
      mode: 'inPlace',
      imageWidth: this._round(normalizedClip.width * dpr),
      imageHeight: this._round(normalizedClip.height * dpr),
      contentOffsetX: this._round(contentOffsetX * dpr),
      contentOffsetY: this._round(contentOffsetY * dpr),
      contentWidth: this._round(elementWidth * dpr),
      contentHeight: this._round(elementHeight * dpr),
      rotationBaked: !!rotationBaked,
      rotationOriginal: this._round(this._toNumber(rotationOriginal, 0), 6),
    };
    if (decoupleOpacity) {
      meta.opacityDecoupled = true;
      meta.renderOpacity = this._round(this._clamp01(renderOpacity, 1), 6);
    }
    return meta;
  }

  _getDpr() {
    const config = this.context && this.context.config ? this.context.config : {};
    const dpr = Number(config.dpr);
    if (!Number.isFinite(dpr) || dpr <= 0) return 1;
    return dpr;
  }

  _browserInPlaceSetupLogic(
    nodeId,
    hideChildren,
    hideOwnText,
    neutralizeTransforms,
    suppressAncestorPaint,
    preserveOwnTextGeometry,
    preserveSceneUnderlay,
    suppressUnderlayFaintBorder,
    decoupleOpacity,
  ) {
    const root = window;
    const cleanupState = root.__bakeCleanupState || (root.__bakeCleanupState = {
      touchedNodes: [],
      hiddenTextNodes: [],
      hiddenControlValues: [],
    });
    if (!Array.isArray(cleanupState.hiddenTextNodes)) {
      cleanupState.hiddenTextNodes = [];
    }
    if (!Array.isArray(cleanupState.hiddenControlValues)) {
      cleanupState.hiddenControlValues = [];
    }

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

    const hideDirectTextNodes = (node) => {
      if (!node || !node.childNodes) return;
      const children = Array.from(node.childNodes);
      for (const child of children) {
        if (!child || child.nodeType !== Node.TEXT_NODE) continue;
        const raw = child.textContent || '';
        if (!raw.trim()) continue;
        cleanupState.hiddenTextNodes.push({
          node: child,
          text: raw,
        });
        child.textContent = '';
      }
    };

    const isTextualFormControl = (node) => {
      if (!node || node.nodeType !== 1) return false;
      const tag = String(node.tagName || '').trim().toLowerCase();
      if (tag === 'textarea') return true;
      if (tag !== 'input') return false;
      const type = String(node.getAttribute('type') || node.type || 'text').trim().toLowerCase() || 'text';
      const nonTextInputTypes = new Set([
        'button',
        'submit',
        'reset',
        'checkbox',
        'radio',
        'file',
        'range',
        'color',
        'image',
        'hidden',
      ]);
      return !nonTextInputTypes.has(type);
    };

    const hideFormControlText = (node) => {
      if (!isTextualFormControl(node)) return;
      cleanupState.hiddenControlValues.push({
        node,
        value: typeof node.value === 'string' ? node.value : '',
        hadValueAttr: node.hasAttribute('value'),
        valueAttr: node.getAttribute('value'),
        hadPlaceholderAttr: node.hasAttribute('placeholder'),
        placeholderAttr: node.getAttribute('placeholder'),
      });
      try {
        node.value = '';
      } catch (_) {
        // ignore runtime-only control value failures
      }
      if (node.hasAttribute('value')) {
        node.setAttribute('value', '');
      }
      if (node.hasAttribute('placeholder')) {
        node.setAttribute('placeholder', '');
      }
      setStyle(node, 'color', 'transparent');
      setStyle(node, '-webkit-text-fill-color', 'transparent');
      setStyle(node, 'text-shadow', 'none');
      setStyle(node, 'caret-color', 'transparent');
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
        // inset shadow stays inside element bounds and should not expand clip.
        if (/\binset\b/i.test(part)) {
          continue;
        }
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

    const parseBlurPad = (filterValue) => {
      if (!filterValue || filterValue === 'none') return 0;
      const matches = filterValue.match(/blur\(([^)]+)\)/g) || [];
      let maxPad = 0;
      for (const match of matches) {
        const inner = match.slice('blur('.length, -1).trim();
        const valueMatch = inner.match(/-?\d*\.?\d+px/);
        if (!valueMatch) continue;
        const blurRadius = Math.abs(parseFloat(valueMatch[0]));
        if (!Number.isFinite(blurRadius)) continue;
        const pad = blurRadius * 2;
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
    // RULE_GUARD: preserve-scene-underlay keeps scene pixels under translucent panels.
    styleTag.innerHTML = preserveSceneUnderlay
      ? [
          '*, *::before, *::after {',
          '  transition-property: none !important;',
          '  transition-duration: 0s !important;',
          '  transition-delay: 0s !important;',
          '  animation: none !important;',
          '}',
        ].join('\n')
      : [
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

    const revealChain = [];
    let revealCursor = el;
    while (revealCursor && revealCursor.nodeType === 1) {
      revealChain.push(revealCursor);
      setStyle(revealCursor, 'visibility', 'visible');
      revealCursor = revealCursor.parentElement;
    }

    if (suppressAncestorPaint) {
      // Keep ancestor geometry for clipping/transform context, but drop ancestor paints
      // to avoid baking unintended square backgrounds into child captures.
      for (const ancestor of revealChain) {
        if (!ancestor || ancestor === el) continue;
        setStyle(ancestor, 'background', 'transparent');
        setStyle(ancestor, 'background-color', 'transparent');
        setStyle(ancestor, 'background-image', 'none');
        setStyle(ancestor, 'border-color', 'transparent');
        setStyle(ancestor, 'box-shadow', 'none');
        setStyle(ancestor, 'filter', 'none');
        setStyle(ancestor, 'backdrop-filter', 'none');
        setStyle(ancestor, '-webkit-backdrop-filter', 'none');
      }
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

    if (hideOwnText) {
      if (preserveOwnTextGeometry) {
        const computed = window.getComputedStyle(el);
        const computedWidth = parseFloat(computed.width);
        const computedHeight = parseFloat(computed.height);
        const layoutWidth = Number.isFinite(computedWidth) && computedWidth > 0
          ? computedWidth
          : Math.max(1, (el.offsetWidth || 0));
        const layoutHeight = Number.isFinite(computedHeight) && computedHeight > 0
          ? computedHeight
          : Math.max(1, (el.offsetHeight || 0));
        if (computed.display === 'inline') {
          setStyle(el, 'display', 'inline-block');
        }
        setStyle(el, 'width', `${Math.max(1, layoutWidth)}px`);
        setStyle(el, 'height', `${Math.max(1, layoutHeight)}px`);
        setStyle(el, 'min-width', `${Math.max(1, layoutWidth)}px`);
        setStyle(el, 'min-height', `${Math.max(1, layoutHeight)}px`);
      }
      hideFormControlText(el);
      // Hide only direct text nodes; child elements keep their own capture logic.
      hideDirectTextNodes(el);
    }

    if (decoupleOpacity) {
      // RULE_GUARD: keep pixel color unattenuated, apply opacity later in Unity Image.color.a.
      setStyle(el, 'opacity', '1');
    }

    if (preserveSceneUnderlay && suppressUnderlayFaintBorder) {
      // RULE_GUARD: in underlay mode, suppress very faint borders to prevent halo artifacts.
      setStyle(el, 'border-width', '0');
      setStyle(el, 'border-style', 'none');
      setStyle(el, 'border-color', 'transparent');
      setStyle(el, 'border-top-color', 'transparent');
      setStyle(el, 'border-right-color', 'transparent');
      setStyle(el, 'border-bottom-color', 'transparent');
      setStyle(el, 'border-left-color', 'transparent');
      setStyle(el, 'border-image', 'none');
      setStyle(el, 'outline', 'none');
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
      parseBlurPad(style.filter),
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

  _browserRangePartSetupLogic(sourceNodeId, rangePart) {
    const root = window;
    const cleanupState = root.__bakeCleanupState || (root.__bakeCleanupState = { touchedNodes: [], hiddenTextNodes: [] });
    if (!Array.isArray(cleanupState.hiddenTextNodes)) {
      cleanupState.hiddenTextNodes = [];
    }

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

    const parsePx = (value, fallback = 0) => {
      if (!value || value === 'normal') return fallback;
      const match = String(value).match(/(-?\d*\.?\d+)px/);
      if (!match) return fallback;
      const parsed = parseFloat(match[1]);
      return Number.isFinite(parsed) ? parsed : fallback;
    };

    const parseNumber = (value, fallback = 0) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
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
        if (/\binset\b/i.test(part)) continue;
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

    const staleStyle = document.getElementById('bake-isolation-style');
    if (staleStyle) staleStyle.remove();

    const el = document.querySelector(`[data-bake-id="${sourceNodeId}"]`);
    if (!el) return null;

    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const normalizedPart = String(rangePart || '').trim().toLowerCase();
    if (normalizedPart !== 'track' && normalizedPart !== 'thumb') return null;
    const splitSelectorList = (selectorText) => {
      const text = String(selectorText || '');
      const list = [];
      let current = '';
      let parenDepth = 0;
      let bracketDepth = 0;
      for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (ch === '(') parenDepth += 1;
        if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);
        if (ch === '[') bracketDepth += 1;
        if (ch === ']') bracketDepth = Math.max(0, bracketDepth - 1);
        if (ch === ',' && parenDepth === 0 && bracketDepth === 0) {
          if (current.trim()) list.push(current.trim());
          current = '';
        } else {
          current += ch;
        }
      }
      if (current.trim()) list.push(current.trim());
      return list;
    };

    const collectPseudoRuleStyle = (pseudoName) => {
      const merged = {};
      const pseudoToken = `::${pseudoName}`;
      const applyRuleStyle = (styleDecl) => {
        if (!styleDecl) return;
        for (let i = 0; i < styleDecl.length; i += 1) {
          const prop = styleDecl[i];
          const value = styleDecl.getPropertyValue(prop);
          if (!prop || !value) continue;
          merged[String(prop).toLowerCase()] = String(value).trim();
        }
      };
      const matchSelector = (selectorText) => {
        const selectors = splitSelectorList(selectorText);
        for (const selector of selectors) {
          if (!selector || !selector.includes(pseudoToken)) continue;
          const idx = selector.indexOf(pseudoToken);
          const baseSelector = `${selector.slice(0, idx)}${selector.slice(idx + pseudoToken.length)}`.trim();
          if (!baseSelector) return true;
          try {
            if (el.matches(baseSelector)) return true;
          } catch (_) {
            // ignore invalid selector fragments
          }
        }
        return false;
      };
      const walkRules = (rules) => {
        if (!rules) return;
        for (const rule of Array.from(rules)) {
          if (!rule) continue;
          if (rule.type === CSSRule.STYLE_RULE) {
            if (matchSelector(rule.selectorText || '')) {
              applyRuleStyle(rule.style);
            }
            continue;
          }
          if (rule.cssRules) {
            walkRules(rule.cssRules);
          }
        }
      };
      for (const sheet of Array.from(document.styleSheets || [])) {
        try {
          walkRules(sheet.cssRules);
        } catch (_) {
          // ignore cross-origin/inaccessible style sheets
        }
      }
      return merged;
    };

    const parseBorderWidth = (styleMap, side) => {
      const sideKey = `border-${side}-width`;
      const sideValue = parsePx(styleMap[sideKey], NaN);
      if (Number.isFinite(sideValue)) return Math.max(0, sideValue);
      const borderValue = String(styleMap.border || '').trim();
      const borderMatch = borderValue.match(/(-?\d*\.?\d+)px/);
      if (!borderMatch) return 0;
      const parsed = parseFloat(borderMatch[1]);
      return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
    };

    const isTransparentColor = (value) => {
      if (!value) return true;
      const normalized = String(value).trim().toLowerCase();
      return normalized === 'transparent' ||
        normalized === 'rgba(0, 0, 0, 0)' ||
        normalized === 'rgba(0,0,0,0)';
    };

    const resolvePseudoStyle = (pseudoName, props) => {
      const computed = window.getComputedStyle(el, `::${pseudoName}`);
      const computedMap = {};
      for (const prop of props) {
        const key = String(prop).toLowerCase();
        computedMap[key] = computed.getPropertyValue(key) || '';
      }
      const ruleMap = collectPseudoRuleStyle(pseudoName);

      const computedWidth = parsePx(computedMap.width, NaN);
      const computedHeight = parsePx(computedMap.height, NaN);
      const borderSum = parseBorderWidth(computedMap, 'top') +
        parseBorderWidth(computedMap, 'right') +
        parseBorderWidth(computedMap, 'bottom') +
        parseBorderWidth(computedMap, 'left');
      const noVisualPaint = isTransparentColor(computedMap['background-color']) &&
        (!computedMap['background-image'] || computedMap['background-image'] === 'none') &&
        borderSum <= 0.01 &&
        parseBoxShadowPad(computedMap['box-shadow']) <= 0.01;
      const looksLikeInputRect = Number.isFinite(computedWidth) &&
        Number.isFinite(computedHeight) &&
        Math.abs(computedWidth - rect.width) <= 0.5 &&
        Math.abs(computedHeight - rect.height) <= 0.5;
      const useRuleFallback = looksLikeInputRect && noVisualPaint;

      const resolved = {};
      for (const prop of props) {
        const key = String(prop).toLowerCase();
        const computedValue = computedMap[key] || '';
        const ruleValue = ruleMap[key] || '';
        resolved[key] = useRuleFallback
          ? (ruleValue || computedValue)
          : (computedValue || ruleValue);
      }
      return resolved;
    };

    const trackStyle = resolvePseudoStyle('-webkit-slider-runnable-track', [
      'width',
      'height',
      'border',
      'border-top-width',
      'border-right-width',
      'border-bottom-width',
      'border-left-width',
      'box-shadow',
      'margin-top',
      'background',
      'background-color',
      'background-image',
    ]);
    const thumbStyle = resolvePseudoStyle('-webkit-slider-thumb', [
      'width',
      'height',
      'border',
      'border-top-width',
      'border-right-width',
      'border-bottom-width',
      'border-left-width',
      'box-shadow',
      'margin-top',
      'background',
      'background-color',
      'background-image',
    ]);

    const min = parseNumber(el.min, 0);
    const max = parseNumber(el.max, 100);
    const value = parseNumber(el.value, min);
    const span = Math.max(0.0001, max - min);
    const ratio = Math.min(1, Math.max(0, (value - min) / span));

    const trackHeightRaw = parsePx(trackStyle.height, rect.height);
    const trackBorderTop = parseBorderWidth(trackStyle, 'top');
    const trackBorderBottom = parseBorderWidth(trackStyle, 'bottom');
    const trackBorderLeft = parseBorderWidth(trackStyle, 'left');
    const trackBorderRight = parseBorderWidth(trackStyle, 'right');
    const trackHeight = Math.max(1, trackHeightRaw + trackBorderTop + trackBorderBottom);
    const trackWidth = Math.max(1, rect.width);
    const trackX = rect.left;
    const trackY = rect.top + (rect.height - trackHeight) / 2;

    const thumbBorderTop = parseBorderWidth(thumbStyle, 'top');
    const thumbBorderBottom = parseBorderWidth(thumbStyle, 'bottom');
    const thumbBorderLeft = parseBorderWidth(thumbStyle, 'left');
    const thumbBorderRight = parseBorderWidth(thumbStyle, 'right');
    const thumbWidthRaw = parsePx(thumbStyle.width, NaN);
    const thumbHeightRaw = parsePx(thumbStyle.height, NaN);
    const fallbackThumbWidth = Math.max(8, (trackHeightRaw > 0 ? trackHeightRaw : trackHeight) * 2);
    const fallbackThumbHeight = Math.max(12, (trackHeightRaw > 0 ? trackHeightRaw : trackHeight) * 3);
    let thumbWidth = thumbWidthRaw;
    let thumbHeight = thumbHeightRaw;
    if (!Number.isFinite(thumbWidth) || thumbWidth <= 0 || thumbWidth >= trackWidth * 0.8) {
      thumbWidth = fallbackThumbWidth;
    }
    if (!Number.isFinite(thumbHeight) || thumbHeight <= 0 || thumbHeight >= Math.max(rect.height * 4, trackHeight * 6)) {
      thumbHeight = fallbackThumbHeight;
    }
    thumbWidth += thumbBorderLeft + thumbBorderRight;
    thumbHeight += thumbBorderTop + thumbBorderBottom;
    const thumbMarginTop = parsePx(thumbStyle['margin-top'], 0);
    const safeThumbMarginTop =
      Number.isFinite(thumbMarginTop) && Math.abs(thumbMarginTop) <= Math.max(rect.height * 4, trackHeight * 6)
        ? thumbMarginTop
        : 0;
    const hasExplicitThumbMarginTop = Number.isFinite(thumbMarginTop) && Math.abs(thumbMarginTop) > 0.001;
    // RULE_GUARD: when author CSS specifies thumb margin-top, prefer that placement model.
    const trackContentTop = rect.top + (rect.height - trackHeightRaw) / 2 + trackBorderTop;
    const thumbTravel = Math.max(0, trackWidth - trackBorderLeft - trackBorderRight - thumbWidth);
    const thumbX = trackX + trackBorderLeft + ratio * thumbTravel;
    const thumbY = hasExplicitThumbMarginTop
      ? (trackContentTop + safeThumbMarginTop)
      : (trackY + (trackHeight - thumbHeight) / 2);

    const trackShadowPad = parseBoxShadowPad(trackStyle['box-shadow']);
    const thumbShadowPad = parseBoxShadowPad(thumbStyle['box-shadow']);

    const visualRect =
      normalizedPart === 'track'
        ? { x: trackX, y: trackY, width: trackWidth, height: trackHeight }
        : { x: thumbX, y: thumbY, width: thumbWidth, height: thumbHeight };
    const shadowPad = normalizedPart === 'track' ? trackShadowPad : thumbShadowPad;

    const clipRect = {
      x: visualRect.x - shadowPad,
      y: visualRect.y - shadowPad,
      width: visualRect.width + shadowPad * 2,
      height: visualRect.height + shadowPad * 2,
    };

    const rangeSelector = `[data-bake-id="${sourceNodeId}"]`;
    // RULE_GUARD: Do not use opacity:0 on runnable-track in thumb capture.
    // Chromium can propagate track opacity and make thumb pixels transparent.
    const rangePartRules =
      normalizedPart === 'track'
        ? [
            `${rangeSelector}::-webkit-slider-thumb {`,
            '  box-shadow: none !important;',
            '  border-color: transparent !important;',
            '  background: transparent !important;',
            '}',
          ]
        : [
            `${rangeSelector}::-webkit-slider-runnable-track {`,
            '  box-shadow: none !important;',
            '  border-color: transparent !important;',
            '  background: transparent !important;',
            '}',
          ];

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
      ...rangePartRules,
      'body * { visibility: hidden !important; }',
    ].join('\n');
    document.head.appendChild(styleTag);

    const revealChain = [];
    let revealCursor = el;
    while (revealCursor && revealCursor.nodeType === 1) {
      revealChain.push(revealCursor);
      setStyle(revealCursor, 'visibility', 'visible');
      revealCursor = revealCursor.parentElement;
    }

    for (const ancestor of revealChain) {
      if (!ancestor || ancestor === el) continue;
      setStyle(ancestor, 'background', 'transparent');
      setStyle(ancestor, 'background-color', 'transparent');
      setStyle(ancestor, 'background-image', 'none');
      setStyle(ancestor, 'border-color', 'transparent');
      setStyle(ancestor, 'box-shadow', 'none');
      setStyle(ancestor, 'filter', 'none');
      setStyle(ancestor, 'backdrop-filter', 'none');
      setStyle(ancestor, '-webkit-backdrop-filter', 'none');
    }

    setStyle(el, 'background', 'transparent');
    setStyle(el, 'background-color', 'transparent');
    setStyle(el, 'box-shadow', 'none');
    setStyle(el, 'border-color', 'transparent');

    return {
      clip: clipRect,
      elementRect: visualRect,
    };
  }

  _browserBackgroundStackSetupLogic(sourceNodeId, backgroundStackNodeIds) {
    const root = window;
    const cleanupState = root.__bakeCleanupState || (root.__bakeCleanupState = {
      touchedNodes: [],
      hiddenTextNodes: [],
      hiddenControlValues: [],
    });
    if (!Array.isArray(cleanupState.touchedNodes)) cleanupState.touchedNodes = [];

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

    const staleStyle = document.getElementById('bake-isolation-style');
    if (staleStyle) staleStyle.remove();

    const baseEl = document.querySelector(`[data-bake-id="${sourceNodeId}"]`);
    if (!baseEl) return null;
    const rect = baseEl.getBoundingClientRect();
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
      'body > * { visibility: hidden !important; }',
    ].join('\n');
    document.head.appendChild(styleTag);

    const revealChain = (node) => {
      let cursor = node;
      while (cursor && cursor.nodeType === 1) {
        setStyle(cursor, 'visibility', 'visible');
        cursor = cursor.parentElement;
      }
    };

    const includeIds = Array.from(new Set([
      sourceNodeId,
      ...(Array.isArray(backgroundStackNodeIds) ? backgroundStackNodeIds : []),
    ]));
    for (const id of includeIds) {
      const current = document.querySelector(`[data-bake-id="${id}"]`);
      if (!current) continue;
      revealChain(current);
    }
    revealChain(baseEl);

    return {
      clip: {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      },
      elementRect: {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      },
    };
  }

  _browserCaptureLogic(nodeId, hideChildren, hideOwnText, decoupleOpacity) {
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

    const isTextualFormControl = (node) => {
      if (!node || node.nodeType !== 1) return false;
      const tag = String(node.tagName || '').trim().toLowerCase();
      if (tag === 'textarea') return true;
      if (tag !== 'input') return false;
      const type = String(node.getAttribute('type') || node.type || 'text').trim().toLowerCase() || 'text';
      const nonTextInputTypes = new Set([
        'button',
        'submit',
        'reset',
        'checkbox',
        'radio',
        'file',
        'range',
        'color',
        'image',
        'hidden',
      ]);
      return !nonTextInputTypes.has(type);
    };

    const hideFormControlText = (node) => {
      if (!isTextualFormControl(node)) return;
      try {
        node.value = '';
      } catch (_) {
        // ignore runtime-only control value failures
      }
      node.setAttribute('value', '');
      if (node.hasAttribute('placeholder')) {
        node.setAttribute('placeholder', '');
      }
      node.style.color = 'transparent';
      node.style.webkitTextFillColor = 'transparent';
      node.style.textShadow = 'none';
      node.style.caretColor = 'transparent';
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
        // inset shadow stays inside element bounds and should not expand clip.
        if (/\binset\b/i.test(part)) {
          continue;
        }
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

    const parseBlurPad = (filterValue) => {
      if (!filterValue || filterValue === 'none') return 0;
      const matches = filterValue.match(/blur\(([^)]+)\)/g) || [];
      let maxPad = 0;
      for (const match of matches) {
        const inner = match.slice('blur('.length, -1).trim();
        const valueMatch = inner.match(/-?\d*\.?\d+px/);
        if (!valueMatch) continue;
        const blurRadius = Math.abs(parseFloat(valueMatch[0]));
        if (!Number.isFinite(blurRadius)) continue;
        const pad = blurRadius * 2;
        if (pad > maxPad) maxPad = pad;
      }
      return maxPad;
    };

    const shadowPad = Math.max(
      parseBoxShadowPad(style.boxShadow),
      parseDropShadowPad(style.filter),
      parseBlurPad(style.filter),
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
      'clipPath',
      'maskImage',
      'mask',
      'mixBlendMode',
      'backdropFilter',
      'webkitBackdropFilter',
      'overflow',
      'overflowX',
      'overflowY',
    ];

    for (const prop of propsToCopy) {
      clone.style[prop] = style[prop];
    }
    if (decoupleOpacity) {
      // RULE_GUARD: avoid baking CSS opacity into texture alpha.
      clone.style.opacity = '1';
    }

    if (hideChildren) {
      clone.innerHTML = '';
    }
    if (hideOwnText && !hideChildren) {
      hideFormControlText(clone);
      const directChildren = Array.from(clone.childNodes || []);
      for (const child of directChildren) {
        if (!child || child.nodeType !== Node.TEXT_NODE) continue;
        const raw = child.textContent || '';
        if (!raw.trim()) continue;
        child.textContent = '';
      }
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
    if (cleanupState && Array.isArray(cleanupState.hiddenTextNodes)) {
      for (const entry of cleanupState.hiddenTextNodes) {
        if (!entry || !entry.node || entry.node.nodeType !== Node.TEXT_NODE) continue;
        entry.node.textContent = entry.text || '';
      }
      cleanupState.hiddenTextNodes.length = 0;
    }

    if (cleanupState && Array.isArray(cleanupState.hiddenControlValues)) {
      for (const entry of cleanupState.hiddenControlValues) {
        if (!entry || !entry.node || entry.node.nodeType !== Node.ELEMENT_NODE) continue;
        const node = entry.node;
        try {
          node.value = typeof entry.value === 'string' ? entry.value : '';
        } catch (_) {
          // ignore runtime-only control value failures
        }
        if (entry.hadValueAttr) {
          node.setAttribute('value', entry.valueAttr != null ? String(entry.valueAttr) : '');
        } else {
          node.removeAttribute('value');
        }
        if (entry.hadPlaceholderAttr) {
          node.setAttribute('placeholder', entry.placeholderAttr != null ? String(entry.placeholderAttr) : '');
        } else {
          node.removeAttribute('placeholder');
        }
      }
      cleanupState.hiddenControlValues.length = 0;
    }

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
