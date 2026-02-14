class Planner {
  constructor(context) {
    this.context = context;
  }

  plan(analysisTree) {
    const tasks = [];
    const config = this.context && this.context.config ? this.context.config : {};

    const contentLogicalWidth = this._toPositiveInt(
      config.contentLogicalWidth,
      this._toPositiveInt(config.logicalWidth, 1),
    );
    const contentLogicalHeight = this._toPositiveInt(
      config.contentLogicalHeight,
      this._toPositiveInt(config.logicalHeight, 1),
    );
    const dpr = this._toPositiveNumber(config.dpr, 1);

    const contentPhysicalWidth = this._toPositiveInt(
      config.contentPhysicalWidth,
      Math.max(1, Math.round(contentLogicalWidth * dpr)),
    );
    const contentPhysicalHeight = this._toPositiveInt(
      config.contentPhysicalHeight,
      Math.max(1, Math.round(contentLogicalHeight * dpr)),
    );

    tasks.push({
      id: 'task-global-bg',
      type: 'CAPTURE_PAGE',
      outputName: 'bg',
      params: {
        width: contentPhysicalWidth,
        height: contentPhysicalHeight,
        logicalWidth: contentLogicalWidth,
        logicalHeight: contentLogicalHeight,
      },
    });

    if (analysisTree) {
      this._traverse(analysisTree, tasks, false, false);
    }

    return tasks;
  }

  _traverse(node, tasks, ancestorHasEffect, ancestorHasRotation) {
    if (!node || !tasks) return;

    const isImage = node.type === 'Image';
    const isContainer = node.type === 'Container';
    const hasVisual = !!(node.visual && node.visual.hasVisual);
    const isIconGlyph = !!(node.visual && node.visual.isIconGlyph);
    const selfHasEffect = this._hasCaptureEffect(node.styles);
    const selfHasRotation = this._hasRotation(node.rotation);

    const shouldCapture = isImage || (isContainer && hasVisual);

    if (shouldCapture) {
      const forceHideChildren = isContainer && node.tagName !== 'IMG';
      const needsContextEffects = selfHasEffect || ancestorHasEffect;
      let captureMode = 'clone';
      if (!forceHideChildren && !isIconGlyph && needsContextEffects) {
        captureMode = 'inPlace';
      }
      const serial = String(tasks.length).padStart(4, '0');
      const tagName = (node.tagName || 'node').toLowerCase();
      const outputName = `${serial}_${tagName}`;

      const task = {
        id: `task-${node.id}`,
        nodeId: node.id,
        type: 'CAPTURE_NODE',
        outputName,
        params: {
          nodeId: node.id,
          hideChildren: forceHideChildren,
          mode: captureMode,
          neutralizeTransforms: captureMode === 'inPlace' && (ancestorHasRotation || selfHasRotation),
        },
      };

      tasks.push(task);

      node.meta = node.meta || {};
      node.meta.imagePath = `images/${outputName}.png`;
    }

    const children = Array.isArray(node.children) ? node.children : [];
    const nextAncestorHasEffect = ancestorHasEffect || selfHasEffect;
    const nextAncestorHasRotation = ancestorHasRotation || selfHasRotation;
    for (const child of children) {
      this._traverse(child, tasks, nextAncestorHasEffect, nextAncestorHasRotation);
    }
  }

  _hasCaptureEffect(styles) {
    if (!styles || typeof styles !== 'object') return false;

    const hasNonVisibleOverflow = (value) => {
      if (!value) return false;
      return String(value).trim().toLowerCase() !== 'visible';
    };

    const overflowEffect =
      hasNonVisibleOverflow(styles.overflow) ||
      hasNonVisibleOverflow(styles.overflowX) ||
      hasNonVisibleOverflow(styles.overflowY);

    const clipPath = styles.clipPath && String(styles.clipPath).trim().toLowerCase();
    const maskImage = styles.maskImage && String(styles.maskImage).trim().toLowerCase();
    const mask = styles.mask && String(styles.mask).trim().toLowerCase();
    const filter = styles.filter && String(styles.filter).trim().toLowerCase();
    const backdropFilter = styles.backdropFilter && String(styles.backdropFilter).trim().toLowerCase();
    const webkitBackdropFilter =
      styles.webkitBackdropFilter && String(styles.webkitBackdropFilter).trim().toLowerCase();
    const mixBlendMode = styles.mixBlendMode && String(styles.mixBlendMode).trim().toLowerCase();

    const opacity = Number.parseFloat(styles.opacity);
    const opacityEffect = Number.isFinite(opacity) && opacity < 0.999;

    return (
      overflowEffect ||
      (!!clipPath && clipPath !== 'none') ||
      (!!maskImage && maskImage !== 'none') ||
      (!!mask && mask !== 'none') ||
      (!!filter && filter !== 'none') ||
      (!!backdropFilter && backdropFilter !== 'none') ||
      (!!webkitBackdropFilter && webkitBackdropFilter !== 'none') ||
      (!!mixBlendMode && mixBlendMode !== 'normal') ||
      opacityEffect
    );
  }

  _hasRotation(rotation) {
    const value = Number(rotation);
    return Number.isFinite(value) && Math.abs(value) > 0.001;
  }

  _toPositiveInt(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return parsed;
  }

  _toPositiveNumber(value, fallback) {
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return parsed;
  }
}

module.exports = Planner;
