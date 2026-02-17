class Planner {
  constructor(context) {
    this.context = context;
    this.ruleTrace = [];
    this._bgStackBaseNodeIds = new Set();
    this._bgStackSuppressedByNodeId = new Map();
    this._bgStackIncludeByBaseId = new Map();
  }

  plan(analysisTree) {
    this.ruleTrace = [];
    this._bgStackBaseNodeIds = new Set();
    this._bgStackSuppressedByNodeId = new Map();
    this._bgStackIncludeByBaseId = new Map();
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
      const enableBackgroundStackComposite = config.enableBackgroundStackComposite !== false;
      if (enableBackgroundStackComposite) {
        this._prepareBackgroundStackGroups(analysisTree);
      }
      this._traverse(analysisTree, tasks, {
        clippingAncestors: [],
        ancestorHasRotation: false,
        ancestorRotation: 0,
      });
    }

    return tasks;
  }

  getRuleTrace() {
    return Array.isArray(this.ruleTrace) ? this.ruleTrace.slice() : [];
  }

  _traverse(node, tasks, state) {
    if (!node || !tasks) return;

    const currentState = state || { clippingAncestors: [], ancestorHasRotation: false, ancestorRotation: 0 };
    const config = this.context && this.context.config ? this.context.config : {};
    const enableOpacityDecouple = config.enableOpacityDecouple !== false;
    const enableLowAlphaContextCapture = config.enableLowAlphaContextCapture !== false;
    const enableUnderlayFaintBorderSuppression =
      config.enableUnderlayFaintBorderSuppression !== false;
    const isImage = node.type === 'Image';
    const isContainer = node.type === 'Container';
    const hasVisual = !!(node.visual && node.visual.hasVisual);
    const isIconGlyph = !!(node.visual && node.visual.isIconGlyph);
    const selfHasRotation = this._hasRotation(node.rotation);
    const ancestorRotation = this._toNumber(currentState.ancestorRotation, 0);
    const hasAncestorRotation = this._hasRotation(ancestorRotation);
    const captureFrom = node && node.captureFrom && typeof node.captureFrom === 'object'
      ? node.captureFrom
      : null;
    const rangePart = captureFrom && captureFrom.rangePart ? String(captureFrom.rangePart) : '';
    const captureSourceNodeId =
      captureFrom && captureFrom.sourceNodeId ? String(captureFrom.sourceNodeId) : (node.id || '');
    const effectInfo = this._analyzeCaptureEffects(node.styles);
    const nearestClip = this._findNearestClipContext(node.rect, currentState.clippingAncestors);
    const backgroundStackBase = this._bgStackBaseNodeIds.has(node.id);
    const backgroundStackSuppressedBy = this._bgStackSuppressedByNodeId.get(node.id) || '';
    const backgroundStackNodeIds = backgroundStackBase
      ? (this._bgStackIncludeByBaseId.get(node.id) || [])
      : [];

    const shouldCapture = isImage || (isContainer && hasVisual);
    let captureResult = null;

    if (shouldCapture) {
      const isRangePartNode = !!rangePart;
      const forceHideChildren = isRangePartNode ? false : (isContainer && node.tagName !== 'IMG');
      // Direct text is emitted as a dedicated Text child in Analyzer.
      // Keep image captures text-free to avoid duplicate rendering.
      const hideOwnText = isRangePartNode
        ? false
        : (this._hasDirectTextChild(node) || this._isTextualFormControl(node));
      let rotationBaked = selfHasRotation;
      const captureReasons = [];
      let preserveSceneUnderlay = false;
      let suppressUnderlayFaintBorder = false;
      const resolvedOpacity = this._parseOpacity(node && node.styles ? node.styles.opacity : '', 1);
      const opacityDecouple = isRangePartNode
        ? { enabled: false, renderOpacity: 1 }
        : this._decideOpacityDecouple(node, effectInfo, resolvedOpacity, enableOpacityDecouple);
      const lowAlphaContextCapture = isRangePartNode
        ? false
        : this._shouldUseLowAlphaContextCapture(
          node,
          effectInfo,
          forceHideChildren,
          enableLowAlphaContextCapture,
        );
      if (backgroundStackBase) {
        captureReasons.push('background-stack-composite');
      }

      let captureMode = 'clone';
      let ancestorRotationContext = false;
      if (isRangePartNode) {
        captureMode = 'rangePart';
        captureReasons.push(`range-part:${rangePart}`);
      } else if (backgroundStackBase) {
        captureMode = 'backgroundStack';
      } else {
        if (lowAlphaContextCapture) {
          // RULE_GUARD: keep low-alpha background layers in in-place mode with ancestor paints,
          // so local glass/translucent tone is captured from layout context.
          captureReasons.push('low-alpha-context-capture');
          preserveSceneUnderlay = true;
          if (enableUnderlayFaintBorderSuppression && this._shouldSuppressUnderlayFaintBorder(node)) {
            // RULE_GUARD: under underlay mode, very faint borders become visible halo rings.
            suppressUnderlayFaintBorder = true;
          }
        }
        if (effectInfo.requiresInPlace) {
          captureReasons.push(...effectInfo.inPlaceReasons);
        }
        if (nearestClip && nearestClip.isOutside) {
          captureReasons.push(`ancestor-clip-outside:${nearestClip.ancestorId}`);
        }
        if (this._needsRoundedClipContext(nearestClip, effectInfo)) {
          captureReasons.push(`ancestor-rounded-clip:${nearestClip.ancestorId}`);
        }

        if (rotationBaked) {
          captureReasons.push('self-rotation-baked');
        }
        if (!rotationBaked && hasAncestorRotation) {
          ancestorRotationContext = true;
          rotationBaked = true;
          captureReasons.push(`ancestor-rotation-context:${this._round(ancestorRotation, 6)}`);
        }

        const needsContextCapture = captureReasons.length > 0;
        const forceInPlaceForRotation = rotationBaked || ancestorRotationContext;
        // RULE_GUARD: Keep icon glyphs in clone mode by default for clip-only context.
        if (!isIconGlyph || forceInPlaceForRotation) {
          if (needsContextCapture) captureMode = 'inPlace';
        } else if (needsContextCapture) {
          // RULE_GUARD: Explicitly trace this exception to avoid future "silent" heuristic drift.
          captureReasons.push('icon-glyph-context-exception');
        }
      }
      if (opacityDecouple.enabled && !backgroundStackBase) {
        // RULE_GUARD: decouple CSS opacity from pixels to avoid alpha being baked twice
        // (texture alpha + Unity Image alpha), which causes visible washout.
        captureReasons.push('opacity-decoupled');
      }

      const neutralizeTransforms =
        captureMode === 'inPlace' && !rotationBaked && currentState.ancestorHasRotation;
      // In inPlace mode, ancestors are usually needed only for geometry context (clip/transform).
      // Suppress ancestor paints to avoid background/frame contamination in child asset captures.
      const suppressAncestorPaint =
        captureMode === 'inPlace' && !effectInfo.requiresInPlace && !lowAlphaContextCapture;
      const preserveOwnTextGeometry =
        captureMode === 'inPlace' && hideOwnText;
      const effectiveOpacityDecouple = opacityDecouple.enabled && !backgroundStackBase;
      const effectiveRenderOpacity = effectiveOpacityDecouple ? opacityDecouple.renderOpacity : 1;

      const skipDecision = isRangePartNode
        ? { skip: false, reasons: [] }
        : this._evaluateSkipCapture(node, nearestClip);
      if (backgroundStackSuppressedBy && !isRangePartNode) {
        captureResult = {
          decision: 'skip',
          reasons: [...captureReasons, `captured-by-background-stack:${backgroundStackSuppressedBy}`],
          mode: 'backgroundStackSuppressed',
          hideChildren: forceHideChildren,
          hideOwnText,
          neutralizeTransforms,
          suppressAncestorPaint,
          preserveOwnTextGeometry,
          preserveSceneUnderlay,
          suppressUnderlayFaintBorder,
          rotationBaked,
          ancestorRotationContext,
          decoupleOpacity: false,
          renderOpacity: 1,
          outputName: null,
        };
      } else if (skipDecision.skip) {
        captureResult = {
          decision: 'skip',
          reasons: [...captureReasons, ...skipDecision.reasons],
          mode: captureMode,
          hideChildren: forceHideChildren,
          hideOwnText,
          neutralizeTransforms,
          suppressAncestorPaint,
          preserveOwnTextGeometry,
          preserveSceneUnderlay,
          suppressUnderlayFaintBorder,
          rotationBaked,
          ancestorRotationContext,
          decoupleOpacity: effectiveOpacityDecouple,
          renderOpacity: effectiveRenderOpacity,
          outputName: null,
        };
      } else {
        const serial = String(tasks.length).padStart(4, '0');
        const tagName = (node.tagName || 'node').toLowerCase();
        const outputName = `${serial}_${tagName}`;
        const taskReasons = this._buildTaskReasons({
          captureMode,
          captureReasons,
          hideChildren: forceHideChildren,
          hideOwnText,
          neutralizeTransforms,
          suppressAncestorPaint,
          preserveOwnTextGeometry,
          preserveSceneUnderlay,
          suppressUnderlayFaintBorder,
          rotationBaked,
          ancestorRotationContext,
        });

        const task = {
          id: `task-${node.id}`,
          nodeId: node.id,
          type: 'CAPTURE_NODE',
          outputName,
          params: {
            nodeId: node.id,
            captureSourceNodeId,
            rangePart,
            hideChildren: forceHideChildren,
            hideOwnText,
            mode: captureMode,
            neutralizeTransforms,
            suppressAncestorPaint,
            preserveOwnTextGeometry,
            preserveSceneUnderlay,
            suppressUnderlayFaintBorder,
            backgroundStackNodeIds,
            ancestorRotationContext,
            rotationBaked,
            rotationOriginal: rotationBaked
              ? this._toNumber(selfHasRotation ? node.rotation : ancestorRotation, 0)
              : 0,
            decoupleOpacity: !!effectiveOpacityDecouple,
            renderOpacity: this._round(this._toNumber(effectiveRenderOpacity, 1), 6),
            reasons: taskReasons,
          },
        };

        tasks.push(task);

        node.meta = node.meta || {};
        node.meta.imagePath = `images/${outputName}.png`;

        captureResult = {
          decision: 'capture',
          reasons: taskReasons,
          mode: captureMode,
          hideChildren: forceHideChildren,
          hideOwnText,
          neutralizeTransforms,
          suppressAncestorPaint,
          preserveOwnTextGeometry,
          preserveSceneUnderlay,
          suppressUnderlayFaintBorder,
          rotationBaked,
          ancestorRotationContext,
          decoupleOpacity: effectiveOpacityDecouple,
          renderOpacity: effectiveRenderOpacity,
          outputName,
        };
      }
    }

    this._pushRuleTrace(node, captureResult, nearestClip);

    const children = Array.isArray(node.children) ? node.children : [];
    const nextClippingAncestors = Array.isArray(currentState.clippingAncestors)
      ? currentState.clippingAncestors.slice()
      : [];
    const selfClipRect = this._buildClipRect(node, effectInfo);
    if (selfClipRect) {
      nextClippingAncestors.push(selfClipRect);
    }

    const nextState = {
      clippingAncestors: nextClippingAncestors,
      ancestorHasRotation: currentState.ancestorHasRotation || selfHasRotation,
      ancestorRotation: this._toNumber(currentState.ancestorRotation, 0) + (selfHasRotation ? this._toNumber(node.rotation, 0) : 0),
    };

    for (const child of children) {
      this._traverse(child, tasks, nextState);
    }
  }

  _pushRuleTrace(node, captureResult, nearestClip) {
    if (!node || !captureResult) return;
    const clipInfo = nearestClip
      ? {
          ancestorId: nearestClip.ancestorId,
          visibleRatio: this._round(nearestClip.visibleRatio, 4),
          isOutside: !!nearestClip.isOutside,
          touchesBoundary: !!nearestClip.touchesBoundary,
          roundedAncestor: !!nearestClip.hasRoundedCorners,
        }
      : null;

    this.ruleTrace.push({
      nodeId: node.id || '',
      type: node.type || '',
      tagName: node.tagName || '',
      decision: captureResult.decision,
      outputName: captureResult.outputName,
      mode: captureResult.mode,
      hideChildren: !!captureResult.hideChildren,
      hideOwnText: !!captureResult.hideOwnText,
      neutralizeTransforms: !!captureResult.neutralizeTransforms,
      suppressAncestorPaint: !!captureResult.suppressAncestorPaint,
      preserveOwnTextGeometry: !!captureResult.preserveOwnTextGeometry,
      preserveSceneUnderlay: !!captureResult.preserveSceneUnderlay,
      suppressUnderlayFaintBorder: !!captureResult.suppressUnderlayFaintBorder,
      rotationBaked: !!captureResult.rotationBaked,
      ancestorRotationContext: !!captureResult.ancestorRotationContext,
      decoupleOpacity: !!captureResult.decoupleOpacity,
      renderOpacity: this._round(this._toNumber(captureResult.renderOpacity, 1), 4),
      reasons: Array.isArray(captureResult.reasons) ? captureResult.reasons : [],
      nearestClip: clipInfo,
    });
  }

  _evaluateSkipCapture(node, nearestClip) {
    const result = { skip: false, reasons: [] };
    if (!node || !nearestClip) return result;
    if (nearestClip.visibleRatio > 0.05) return result;
    if (!this._hasStateLayerHints(node)) return result;
    if (this._hasTextContent(node)) return result;
    if (this._isInteractiveSemantic(node)) return result;

    result.skip = true;
    result.reasons.push('skip-low-visibility-state-layer');
    if (nearestClip.ancestorId) {
      result.reasons.push(`nearest-clip:${nearestClip.ancestorId}`);
    }
    return result;
  }

  _buildTaskReasons(options) {
    const data = options || {};
    const reasons = [];
    if (Array.isArray(data.captureReasons) && data.captureReasons.length > 0) {
      reasons.push(...data.captureReasons);
    }
    if (data.hideChildren) {
      reasons.push('hide-children');
    }
    if (data.hideOwnText) {
      reasons.push('hide-own-direct-text');
    }
    if (data.neutralizeTransforms) {
      reasons.push('neutralize-rotation-context');
    }
    if (data.suppressAncestorPaint) {
      reasons.push('suppress-ancestor-paint');
    }
    if (data.preserveOwnTextGeometry) {
      reasons.push('preserve-own-text-geometry');
    }
    if (data.preserveSceneUnderlay) {
      reasons.push('preserve-scene-underlay');
    }
    if (data.suppressUnderlayFaintBorder) {
      reasons.push('underlay-faint-border-suppressed');
    }
    if (data.ancestorRotationContext) {
      reasons.push('ancestor-rotation-context');
    }
    if (data.rotationBaked) {
      reasons.push('rotation-baked');
    }
    if (reasons.length === 0) {
      reasons.push(data.captureMode === 'inPlace' ? 'context-capture' : 'default-capture');
    }

    return Array.from(new Set(reasons));
  }

  _hasDirectTextChild(node) {
    const children = Array.isArray(node && node.children) ? node.children : [];
    return children.some((child) => {
      if (!child || child.type !== 'Text') return false;
      if (child.childIndex === -1) return true;
      const domPath = child.domPath || '';
      return typeof domPath === 'string' && domPath.endsWith('::text');
    });
  }

  _hasTextContent(node) {
    if (!node) return false;
    if (typeof node.text === 'string' && node.text.trim().length > 0) return true;
    return this._hasDirectTextChild(node);
  }

  _isTextualFormControl(node) {
    if (!node) return false;
    const tag = String(node.htmlTag || node.tagName || '').trim().toLowerCase();
    if (tag === 'textarea') return true;
    if (tag !== 'input') return false;

    const type = String(node.inputType || '').trim().toLowerCase() || 'text';
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
  }

  _hasStateLayerHints(node) {
    const classes = Array.isArray(node && node.classes) ? node.classes : [];
    const joined = classes.join(' ').toLowerCase();
    if (!joined) return false;
    if (
      joined.includes('group-hover:') ||
      joined.includes('hover:') ||
      joined.includes('active:') ||
      joined.includes('focus:') ||
      joined.includes('animate-') ||
      joined.includes('transition')
    ) {
      return true;
    }
    return joined.includes('translate') || joined.includes('skew') || joined.includes('opacity');
  }

  _isInteractiveSemantic(node) {
    if (!node) return false;
    const tag = String(node.htmlTag || node.tagName || '').toLowerCase();
    const role = String(node.role || '').toLowerCase();
    if (['button', 'input', 'textarea', 'select', 'option'].includes(tag)) return true;
    if (tag === 'a' && role === 'button') return true;
    if (['button', 'switch', 'checkbox', 'radio', 'tab', 'menuitem', 'link'].includes(role)) return true;
    return false;
  }

  _parseOpacity(value, fallback = 1) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    if (parsed < 0) return 0;
    if (parsed > 1) return 1;
    return parsed;
  }

  _parseColorAlpha(value) {
    if (!value) return 0;
    const normalized = String(value).trim().toLowerCase();
    if (!normalized || normalized === 'transparent') return 0;
    const match = normalized.match(/rgba?\(([^)]+)\)/i);
    if (!match) return 1;
    const parts = match[1].split(',').map((part) => part.trim());
    if (parts.length < 4) return 1;
    const alpha = Number(parts[3]);
    if (!Number.isFinite(alpha)) return 1;
    return Math.max(0, Math.min(1, alpha));
  }

  _isNoneLike(value) {
    if (value == null) return true;
    const normalized = String(value).trim().toLowerCase();
    return !normalized || normalized === 'none' || normalized === 'initial';
  }

  _hasComplexCompositingStyle(styles) {
    if (!styles || typeof styles !== 'object') return false;
    const mixBlendMode = String(styles.mixBlendMode || '').trim().toLowerCase();
    const backdropFilter = String(styles.backdropFilter || '').trim().toLowerCase();
    const webkitBackdropFilter = String(styles.webkitBackdropFilter || '').trim().toLowerCase();
    const clipPath = String(styles.clipPath || '').trim().toLowerCase();
    const maskImage = String(styles.maskImage || '').trim().toLowerCase();
    const mask = String(styles.mask || '').trim().toLowerCase();
    const filter = String(styles.filter || '').trim().toLowerCase();
    return (
      (!!mixBlendMode && mixBlendMode !== 'normal') ||
      (!!backdropFilter && backdropFilter !== 'none') ||
      (!!webkitBackdropFilter && webkitBackdropFilter !== 'none') ||
      (!!clipPath && clipPath !== 'none') ||
      (!!maskImage && maskImage !== 'none') ||
      (!!mask && mask !== 'none') ||
      (!!filter && filter !== 'none')
    );
  }

  _isAtomicVisualTag(node) {
    if (!node) return false;
    const tag = String(node.tagName || node.htmlTag || '').trim().toUpperCase();
    return ['IMG', 'SVG', 'CANVAS', 'VIDEO', 'PICTURE'].includes(tag);
  }

  _resolveViewportArea() {
    const config = this.context && this.context.config ? this.context.config : {};
    const width = this._toPositiveNumber(
      config.contentPhysicalWidth,
      this._toPositiveNumber(config.targetWidth, 1),
    );
    const height = this._toPositiveNumber(
      config.contentPhysicalHeight,
      this._toPositiveNumber(config.targetHeight, 1),
    );
    return Math.max(1, width * height);
  }

  _decideOpacityDecouple(node, effectInfo, opacityValue, enabled) {
    if (!enabled) return { enabled: false, renderOpacity: 1 };
    if (!node || !effectInfo) return { enabled: false, renderOpacity: 1 };
    const opacity = this._parseOpacity(opacityValue, 1);
    if (opacity <= 0 || opacity >= 0.999) return { enabled: false, renderOpacity: 1 };
    if (!this._isAtomicVisualTag(node)) return { enabled: false, renderOpacity: 1 };
    if (effectInfo.requiresInPlace) return { enabled: false, renderOpacity: 1 };
    if (this._hasComplexCompositingStyle(node.styles)) return { enabled: false, renderOpacity: 1 };
    return { enabled: true, renderOpacity: opacity };
  }

  _shouldUseLowAlphaContextCapture(node, effectInfo, forceHideChildren, enabled) {
    if (!enabled) return false;
    if (!node || !effectInfo) return false;
    if (node.type !== 'Container') return false;
    if (!forceHideChildren) return false;
    if (this._isInteractiveSemantic(node)) return false;
    if (effectInfo.requiresInPlace) return false;
    if (this._hasComplexCompositingStyle(node.styles)) return false;

    const styles = node.styles && typeof node.styles === 'object' ? node.styles : {};
    const nodeOpacity = this._parseOpacity(styles.opacity, 1);
    if (nodeOpacity < 0.999) return false;

    const backgroundImage = String(styles.backgroundImage || '').trim().toLowerCase();
    if (!this._isNoneLike(backgroundImage)) return false;

    const backgroundAlpha = this._parseColorAlpha(styles.backgroundColor);
    if (backgroundAlpha <= 0 || backgroundAlpha > 0.12) return false;

    const rect = this._normalizeRect(node.rect);
    if (!rect) return false;
    if (rect.width < 120 || rect.height < 40) return false;

    const areaRatio = this._rectArea(rect) / this._resolveViewportArea();
    if (areaRatio < 0.002 || areaRatio > 0.35) return false;

    return true;
  }

  _shouldSuppressUnderlayFaintBorder(node) {
    if (!node || !node.styles || typeof node.styles !== 'object') return false;
    const borderInfo = this._extractBorderVisualInfo(node.styles);
    if (borderInfo.maxWidthPx <= 0.01) return false;
    if (borderInfo.maxWidthPx > 1.5) return false;
    if (borderInfo.maxAlpha > 0.08) return false;
    return true;
  }

  _extractBorderVisualInfo(styles) {
    const borderRaw = String(styles && styles.border ? styles.border : '').trim();
    if (!borderRaw) {
      return {
        maxWidthPx: 0,
        maxAlpha: 0,
      };
    }

    const widthMatches = borderRaw.match(/-?\d*\.?\d+px/gi) || [];
    let maxWidthPx = 0;
    for (const token of widthMatches) {
      const parsed = Number.parseFloat(token);
      if (!Number.isFinite(parsed)) continue;
      const width = Math.abs(parsed);
      if (width > maxWidthPx) maxWidthPx = width;
    }

    const maxAlpha = this._parseCssColorAlpha(borderRaw);
    return {
      maxWidthPx,
      maxAlpha,
    };
  }

  _parseCssColorAlpha(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized || normalized === 'transparent') return 0;
    if (normalized.includes('transparent')) return 0;

    const rgbaMatch = normalized.match(/rgba\(([^)]+)\)/i);
    if (rgbaMatch) {
      const alpha = this._parseFunctionColorAlpha(rgbaMatch[1]);
      if (alpha != null) return alpha;
    }

    const hslaMatch = normalized.match(/hsla\(([^)]+)\)/i);
    if (hslaMatch) {
      const alpha = this._parseFunctionColorAlpha(hslaMatch[1]);
      if (alpha != null) return alpha;
    }

    if (normalized.includes('rgb(') || normalized.includes('hsl(')) {
      return 1;
    }

    const hexMatch = normalized.match(/#([0-9a-f]{3,8})\b/i);
    if (hexMatch) {
      const hex = hexMatch[1];
      if (hex.length === 4) {
        const alphaNibble = Number.parseInt(hex[3], 16);
        if (Number.isFinite(alphaNibble)) return alphaNibble / 15;
      }
      if (hex.length === 8) {
        const alphaByte = Number.parseInt(hex.slice(6, 8), 16);
        if (Number.isFinite(alphaByte)) return alphaByte / 255;
      }
      return 1;
    }

    return this._isNoneLike(normalized) ? 0 : 1;
  }

  _parseFunctionColorAlpha(colorArgs) {
    const text = String(colorArgs || '').trim();
    if (!text) return null;

    if (text.includes('/')) {
      const slashParts = text.split('/');
      const alphaRaw = slashParts[slashParts.length - 1].trim();
      const parsed = Number.parseFloat(alphaRaw);
      if (Number.isFinite(parsed)) {
        return Math.max(0, Math.min(1, parsed));
      }
    }

    const commaParts = text.split(',').map((part) => part.trim());
    if (commaParts.length >= 4) {
      const parsed = Number.parseFloat(commaParts[3]);
      if (Number.isFinite(parsed)) {
        return Math.max(0, Math.min(1, parsed));
      }
    }

    return null;
  }

  _prepareBackgroundStackGroups(root) {
    if (!root) return;
    this._registerBackgroundStackForParent(root);
    const children = Array.isArray(root.children) ? root.children : [];
    for (const child of children) {
      this._prepareBackgroundStackGroups(child);
    }
  }

  _registerBackgroundStackForParent(parentNode) {
    if (!parentNode) return;
    const children = Array.isArray(parentNode.children) ? parentNode.children : [];
    if (children.length < 2) return;

    const parentDepth = String(parentNode.domPath || '')
      .split('>')
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .length;
    if (parentDepth > 2) return;

    const candidates = [];
    for (const child of children) {
      if (!child || !child.id) continue;
      if (!this._isAtomicVisualTag(child)) continue;
      const rect = this._normalizeRect(child.rect);
      if (!rect) continue;
      const opacity = this._parseOpacity(child && child.styles ? child.styles.opacity : 1, 1);
      if (opacity <= 0.01 || opacity >= 0.99) continue;
      const areaRatio = this._rectArea(rect) / this._resolveViewportArea();
      if (areaRatio < 0.7) continue;
      if (rect.x > 4 || rect.y > 4) continue;
      if (this._hasComplexCompositingStyle(child.styles)) continue;
      candidates.push({ node: child, rect });
    }
    if (candidates.length === 0) return;

    for (const entry of candidates) {
      const baseNode = entry.node;
      if (!baseNode || !baseNode.id) continue;
      const overlays = [];
      for (const sibling of children) {
        if (!sibling || sibling.id === baseNode.id) continue;
        if (!this._isBackgroundOverlaySibling(sibling, entry.rect)) continue;
        overlays.push(sibling);
      }
      if (overlays.length === 0) continue;

      this._bgStackBaseNodeIds.add(baseNode.id);
      const includeIds = [baseNode.id];
      for (const overlay of overlays) {
        includeIds.push(overlay.id);
        this._markBackgroundStackSuppressedSubtree(overlay, baseNode.id);
      }
      this._bgStackIncludeByBaseId.set(baseNode.id, Array.from(new Set(includeIds)));
      return;
    }
  }

  _markBackgroundStackSuppressedSubtree(node, baseId) {
    if (!node || !node.id) return;
    this._bgStackSuppressedByNodeId.set(node.id, baseId);
    const children = Array.isArray(node.children) ? node.children : [];
    for (const child of children) {
      this._markBackgroundStackSuppressedSubtree(child, baseId);
    }
  }

  _isBackgroundOverlaySibling(node, baseRect) {
    if (!node || !baseRect) return false;
    if (this._isInteractiveSemantic(node)) return false;
    if (this._hasTextContent(node)) return false;

    const rect = this._normalizeRect(node.rect);
    if (!rect) return false;
    const overlap = this._computeOverlapRatio(rect, baseRect);
    if (overlap < 0.92) return false;

    if (!this._hasVisualTree(node)) return false;
    if (this._hasComplexCompositingStyle(node.styles)) return false;
    return true;
  }

  _computeOverlapRatio(a, b) {
    const intersection = this._intersectRect(a, b);
    if (!intersection) return 0;
    const interArea = this._rectArea(intersection);
    const denom = Math.max(1, Math.min(this._rectArea(a), this._rectArea(b)));
    return interArea / denom;
  }

  _hasVisualTree(node) {
    if (!node) return false;
    if (node.type === 'Image') return true;
    if (node.visual && node.visual.hasVisual) return true;
    const children = Array.isArray(node.children) ? node.children : [];
    for (const child of children) {
      if (this._hasVisualTree(child)) return true;
    }
    return false;
  }

  _analyzeCaptureEffects(styles) {
    if (!styles || typeof styles !== 'object') {
      return {
        clipsDescendants: false,
        requiresInPlace: false,
        inPlaceReasons: [],
        hasOutpaintVisual: false,
      };
    }

    const hasNonVisibleOverflow = (value) => {
      if (!value) return false;
      return String(value).trim().toLowerCase() !== 'visible';
    };

    const overflowClip =
      hasNonVisibleOverflow(styles.overflow) ||
      hasNonVisibleOverflow(styles.overflowX) ||
      hasNonVisibleOverflow(styles.overflowY);

    const clipPath = styles.clipPath && String(styles.clipPath).trim().toLowerCase();
    const maskImage = styles.maskImage && String(styles.maskImage).trim().toLowerCase();
    const mask = styles.mask && String(styles.mask).trim().toLowerCase();

    const backdropFilter = styles.backdropFilter && String(styles.backdropFilter).trim().toLowerCase();
    const webkitBackdropFilter =
      styles.webkitBackdropFilter && String(styles.webkitBackdropFilter).trim().toLowerCase();
    const mixBlendMode = styles.mixBlendMode && String(styles.mixBlendMode).trim().toLowerCase();

    const hasClipPath = !!clipPath && clipPath !== 'none';
    const hasMask = (!!maskImage && maskImage !== 'none') || (!!mask && mask !== 'none');
    const hasBackdrop =
      (!!backdropFilter && backdropFilter !== 'none') ||
      (!!webkitBackdropFilter && webkitBackdropFilter !== 'none');
    const hasBlend = !!mixBlendMode && mixBlendMode !== 'normal';

    const outpaintPad = Math.max(
      this._parseBoxShadowPad(styles.boxShadow),
      this._parseDropShadowPad(styles.filter),
      this._parseBlurPad(styles.filter),
    );
    const hasOutpaintVisual = outpaintPad > 0.5;

    const inPlaceReasons = [];
    if (hasBackdrop) inPlaceReasons.push('self-backdrop-filter');
    if (hasBlend) inPlaceReasons.push('self-mix-blend-mode');

    return {
      clipsDescendants: overflowClip || hasClipPath || hasMask,
      requiresInPlace: inPlaceReasons.length > 0,
      inPlaceReasons,
      hasOutpaintVisual,
    };
  }

  _buildClipRect(node, effectInfo) {
    if (!node || !effectInfo || !effectInfo.clipsDescendants) return null;
    const rect = this._normalizeRect(node.rect);
    if (!rect) return null;

    const radii = this._parseBorderRadius(node && node.styles ? node.styles.borderRadius : '', rect);
    return {
      ancestorId: node.id || '',
      rect,
      hasRoundedCorners: radii.x > 0.01 || radii.y > 0.01,
      radiusX: radii.x,
      radiusY: radii.y,
    };
  }

  _findNearestClipContext(rectLike, clippingAncestors) {
    const rect = this._normalizeRect(rectLike);
    if (!rect) return null;
    const clipList = Array.isArray(clippingAncestors) ? clippingAncestors : [];
    if (clipList.length === 0) return null;

    for (let i = clipList.length - 1; i >= 0; i -= 1) {
      const clipInfo = clipList[i];
      if (!clipInfo || !clipInfo.rect) continue;
      const clipRect = this._normalizeRect(clipInfo.rect);
      if (!clipRect) continue;

      const intersection = this._intersectRect(rect, clipRect);
      const visibleRatio = intersection ? this._rectArea(intersection) / this._rectArea(rect) : 0;
      const isOutside = visibleRatio < 0.999;
      const touchesBoundary = this._touchesClipBoundary(rect, clipRect);

      return {
        ancestorId: clipInfo.ancestorId || '',
        rect: clipRect,
        hasRoundedCorners: !!clipInfo.hasRoundedCorners,
        radiusX: this._toPositiveNumber(clipInfo.radiusX, 0),
        radiusY: this._toPositiveNumber(clipInfo.radiusY, 0),
        visibleRatio,
        isOutside,
        touchesBoundary,
      };
    }

    return null;
  }

  _needsRoundedClipContext(nearestClip, effectInfo) {
    if (!nearestClip || !nearestClip.hasRoundedCorners) return false;
    if (nearestClip.isOutside) return true;
    if (nearestClip.touchesBoundary) return true;
    return !!(effectInfo && effectInfo.hasOutpaintVisual);
  }

  _touchesClipBoundary(rect, clipRect) {
    if (!rect || !clipRect) return false;
    const epsilon = 2.5;
    const rectRight = rect.x + rect.width;
    const rectBottom = rect.y + rect.height;
    const clipRight = clipRect.x + clipRect.width;
    const clipBottom = clipRect.y + clipRect.height;

    const touchLeft = rect.x <= clipRect.x + epsilon;
    const touchTop = rect.y <= clipRect.y + epsilon;
    const touchRight = rectRight >= clipRight - epsilon;
    const touchBottom = rectBottom >= clipBottom - epsilon;
    return touchLeft || touchTop || touchRight || touchBottom;
  }

  _intersectRect(a, b) {
    if (!a || !b) return null;
    const left = Math.max(a.x, b.x);
    const top = Math.max(a.y, b.y);
    const right = Math.min(a.x + a.width, b.x + b.width);
    const bottom = Math.min(a.y + a.height, b.y + b.height);
    if (right <= left || bottom <= top) return null;
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  _rectArea(rect) {
    if (!rect) return 0;
    const width = this._toPositiveNumber(rect.width, 0);
    const height = this._toPositiveNumber(rect.height, 0);
    return width * height;
  }

  _parseBorderRadius(raw, rect) {
    const normalized = String(raw || '').trim().toLowerCase();
    if (!normalized || normalized === '0' || normalized === '0px') {
      return { x: 0, y: 0 };
    }

    const width = this._toPositiveNumber(rect && rect.width, 0);
    const height = this._toPositiveNumber(rect && rect.height, 0);
    if (width <= 0 || height <= 0) return { x: 0, y: 0 };

    const values = [];
    const regex = /(-?\d*\.?\d+)\s*(px|%)/g;
    let match = regex.exec(normalized);
    while (match) {
      const value = Number.parseFloat(match[1]);
      const unit = match[2];
      if (Number.isFinite(value)) {
        if (unit === '%') {
          values.push((Math.min(width, height) * Math.abs(value)) / 100);
        } else {
          values.push(Math.abs(value));
        }
      }
      match = regex.exec(normalized);
    }

    if (values.length === 0) {
      return { x: 0, y: 0 };
    }

    const radius = Math.max(...values);
    return {
      x: Math.min(radius, width / 2),
      y: Math.min(radius, height / 2),
    };
  }

  _parseBoxShadowPad(boxShadowValue) {
    if (!boxShadowValue || boxShadowValue === 'none') return 0;
    const parts = [];
    let depth = 0;
    let current = '';
    for (const ch of String(boxShadowValue)) {
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
      const nums = values.map((v) => Number.parseFloat(v));
      const offsetX = nums[0] || 0;
      const offsetY = nums[1] || 0;
      const blur = nums[2] || 0;
      const spread = nums[3] || 0;
      const pad = Math.max(Math.abs(offsetX), Math.abs(offsetY)) + blur + spread;
      if (pad > maxPad) maxPad = pad;
    }
    return maxPad;
  }

  _parseDropShadowPad(filterValue) {
    if (!filterValue || filterValue === 'none') return 0;
    const matches = String(filterValue).match(/drop-shadow\(([^)]+)\)/g) || [];
    let maxPad = 0;
    for (const match of matches) {
      const inner = match.slice('drop-shadow('.length, -1);
      const values = inner.match(/-?\d*\.?\d+px/g) || [];
      const nums = values.map((v) => Number.parseFloat(v));
      const offsetX = nums[0] || 0;
      const offsetY = nums[1] || 0;
      const blur = nums[2] || 0;
      const pad = Math.max(Math.abs(offsetX), Math.abs(offsetY)) + blur;
      if (pad > maxPad) maxPad = pad;
    }
    return maxPad;
  }

  _parseBlurPad(filterValue) {
    if (!filterValue || filterValue === 'none') return 0;
    const matches = String(filterValue).match(/blur\(([^)]+)\)/g) || [];
    let maxPad = 0;
    for (const match of matches) {
      const inner = match.slice('blur('.length, -1).trim();
      const valueMatch = inner.match(/-?\d*\.?\d+px/);
      if (!valueMatch) continue;
      const blurRadius = Math.abs(Number.parseFloat(valueMatch[0]));
      if (!Number.isFinite(blurRadius)) continue;
      const pad = blurRadius * 2;
      if (pad > maxPad) maxPad = pad;
    }
    return maxPad;
  }

  _normalizeRect(rect) {
    if (!rect || typeof rect !== 'object') return null;
    const x = Number(rect.x);
    const y = Number(rect.y);
    const width = Number(rect.width);
    const height = Number(rect.height);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
      return null;
    }
    if (width <= 0 || height <= 0) return null;
    return { x, y, width, height };
  }

  _hasRotation(rotation) {
    const value = Number(rotation);
    return Number.isFinite(value) && Math.abs(value) > 0.001;
  }

  _toNumber(value, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return parsed;
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

  _round(value, digits = 4) {
    const factor = 10 ** digits;
    return Math.round(Number(value) * factor) / factor;
  }
}

module.exports = Planner;
