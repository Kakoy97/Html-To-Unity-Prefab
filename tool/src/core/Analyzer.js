const { randomUUID } = require('crypto');

let uuidV4 = null;
try {
  const uuidPkg = require('uuid');
  if (uuidPkg && typeof uuidPkg.v4 === 'function') {
    uuidV4 = uuidPkg.v4;
  }
} catch (_) {
  // uuid can be ESM-only in newer versions; fallback to randomUUID.
}

function createId() {
  if (uuidV4) {
    return uuidV4();
  }
  if (typeof randomUUID === 'function') {
    return randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

class Analyzer {
  constructor(context) {
    this.context = context;
    this.maskInfo = null;
  }

  async run(page) {
    if (!page) {
      throw new Error('Analyzer.run requires a valid Puppeteer page instance.');
    }

    await this._waitForRenderStability(page);
    this.maskInfo = await this._detectMask(page);
    const rootHandle = await this._detectRoot(page);

    try {
      const tree = await this._traverse(page, rootHandle, 'root', 0);
      if (!tree) {
        return null;
      }

      const contentSize = await page.evaluate(() => {
        const body = document.body;
        const html = document.documentElement;
        return {
          width: Math.max(
            body ? body.scrollWidth : 0,
            body ? body.offsetWidth : 0,
            html ? html.clientWidth : 0,
            html ? html.scrollWidth : 0,
            html ? html.offsetWidth : 0,
            window.innerWidth || 0,
          ),
          height: Math.max(
            body ? body.scrollHeight : 0,
            body ? body.offsetHeight : 0,
            html ? html.clientHeight : 0,
            html ? html.scrollHeight : 0,
            html ? html.offsetHeight : 0,
            window.innerHeight || 0,
          ),
        };
      });

      const dpr = this._getDpr();
      tree.rect = {
        x: 0,
        y: 0,
        width: Math.max(1, Math.round(contentSize.width * dpr)),
        height: Math.max(1, Math.round(contentSize.height * dpr)),
      };
      tree.visual = tree.visual || {};
      tree.visual.isRoot = true;
      tree.mask = this.maskInfo || { hasMask: false };

      return tree;
    } finally {
      if (rootHandle) {
        await rootHandle.dispose();
      }
    }
  }

  async _waitForRenderStability(page) {
    await page.evaluate(async () => {
      if (document.fonts && document.fonts.ready) {
        try {
          await document.fonts.ready;
        } catch (_) {
          // Continue even if the font ready promise rejects.
        }
      }

      await new Promise((resolve) => requestAnimationFrame(resolve));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  }

  async _detectRoot(page) {
    const config = this.context && this.context.config ? this.context.config : {};
    const selectorRaw = config.rootSelector || 'auto';
    const selector = String(selectorRaw).trim() || 'auto';

    if (selector.toLowerCase() !== 'auto') {
      const element = await page.$(selector);
      if (element) {
        return element;
      }
      throw new Error(`Root selector not found: ${selector}`);
    }

    const body = await page.$('body');
    if (!body) {
      throw new Error('No <body> element found');
    }
    return body;
  }

  async _detectMask(page) {
    return page.evaluate(() => {
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight;

      const isTransparentColor = (color) => {
        if (!color) return true;
        if (color === 'transparent') return true;
        const match = color.match(/rgba?\(([^)]+)\)/i);
        if (!match) return false;
        const parts = match[1].split(',').map((p) => p.trim());
        if (parts.length < 4) return false;
        const alpha = parseFloat(parts[3]);
        return Number.isFinite(alpha) && alpha === 0;
      };

      const getEffectiveZ = (node) => {
        let current = node;
        while (current && current !== document.documentElement) {
          const style = window.getComputedStyle(current);
          const z = style.zIndex;
          if (z && z !== 'auto') {
            const zi = parseInt(z, 10);
            if (Number.isFinite(zi)) return zi;
          }
          current = current.parentElement;
        }
        return 0;
      };

      const hasOverlayClass = (el) => {
        const cls = typeof el.className === 'string' ? el.className : '';
        return /(?:^|\s)(?:overlay|mask|modal|backdrop|inset-0|bg-opacity-\d+|backdrop-blur-\w+)(?:\s|$)/i.test(cls);
      };

      const isInsetZero = (style) =>
        (style.top === '0px' || style.top === '0') &&
        (style.right === '0px' || style.right === '0') &&
        (style.bottom === '0px' || style.bottom === '0') &&
        (style.left === '0px' || style.left === '0');

      const candidates = [];
      const elements = Array.from(document.body.querySelectorAll('*'));
      for (const el of elements) {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) {
          continue;
        }
        if (style.position !== 'fixed' && style.position !== 'absolute') continue;

        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;

        const offsetParent = el.offsetParent || el.parentElement;
        const parentRect = offsetParent
          ? offsetParent.getBoundingClientRect()
          : {
              width: viewportWidth,
              height: viewportHeight,
              left: 0,
              top: 0,
              right: viewportWidth,
              bottom: viewportHeight,
            };

        const coversViewport = rect.width >= viewportWidth * 0.9 && rect.height >= viewportHeight * 0.9;
        const coversParent = rect.width >= parentRect.width * 0.9 && rect.height >= parentRect.height * 0.9;

        const hasBackground =
          !isTransparentColor(style.backgroundColor) ||
          (style.backgroundImage && style.backgroundImage !== 'none');
        const hasOpacity = parseFloat(style.opacity) > 0;
        const isTranslucent = (() => {
          const match = style.backgroundColor.match(/rgba?\(([^)]+)\)/i);
          if (!match) return false;
          const parts = match[1].split(',').map((p) => p.trim());
          if (parts.length < 4) return false;
          const alpha = parseFloat(parts[3]);
          return Number.isFinite(alpha) && alpha > 0 && alpha < 1;
        })();
        const hasBackdrop =
          (style.backdropFilter && style.backdropFilter !== 'none') ||
          (style.webkitBackdropFilter && style.webkitBackdropFilter !== 'none');
        if (!hasBackground && !hasOpacity && !hasBackdrop) continue;

        const overlayLike = coversViewport || coversParent || isInsetZero(style) || hasOverlayClass(el) || isTranslucent;
        if (!overlayLike) continue;

        const zIndex = getEffectiveZ(el);
        candidates.push({
          el,
          zIndex,
          rect: {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
          },
        });
      }

      if (candidates.length === 0) {
        return { hasMask: false };
      }

      candidates.sort((a, b) => {
        if (a.zIndex !== b.zIndex) return a.zIndex - b.zIndex;
        const areaA = (a.rect.right - a.rect.left) * (a.rect.bottom - a.rect.top);
        const areaB = (b.rect.right - b.rect.left) * (b.rect.bottom - b.rect.top);
        return areaA - areaB;
      });

      const mask = candidates[candidates.length - 1];
      mask.el.setAttribute('data-bake-mask', '1');
      if (window.getComputedStyle(mask.el).pointerEvents === 'none') {
        mask.el.style.pointerEvents = 'auto';
      }

      return {
        hasMask: true,
        zIndex: mask.zIndex,
        rect: mask.rect,
      };
    });
  }

  async _traverse(page, handle, parentId, childIndex = 0) {
    const info = await this._extractNodeInfo(handle);
    if (!info || !info.isVisible) {
      return null;
    }

    const isRootBody = info.tagName === 'BODY';
    const isMaskLayer = info.isMaskLayer === true;
    const isAtomicImageTag = ['IMG', 'SVG', 'CANVAS', 'VIDEO', 'PICTURE'].includes(info.tagName);
    const isVisual = info.hasVisual || isAtomicImageTag || info.isIconGlyph;

    let type = 'Container';
    if (isRootBody || isMaskLayer) {
      type = 'Container';
    } else if (isAtomicImageTag || info.isIconGlyph) {
      type = 'Image';
    } else if (info.childCount > 0) {
      type = 'Container';
    } else if (isVisual) {
      type = 'Image';
    } else if (info.hasDirectText) {
      type = 'Text';
    } else {
      return null;
    }

    const id = createId();
    await this._safeEvaluateOnHandle(
      handle,
      'Analyzer._traverse.setBakeId',
      (el, bakeId) => {
        el.setAttribute('data-bake-id', bakeId);
      },
      id,
    );

    const node = {
      id,
      parentId,
      childIndex,
      type,
      tagName: info.tagName,
      htmlTag: info.htmlTag,
      role: info.role || '',
      inputType: info.inputType || '',
      classes: info.classes,
      attrs: info.attrs,
      domPath: info.domPath,
      rect: info.rect,
      styles: info.styles,
      visual: {
        hasVisual: !!info.hasVisual,
        isMask: !!info.isMaskLayer,
        isIconGlyph: !!info.isIconGlyph,
      },
      rotation: info.rotation,
      children: [],
    };

    if (type === 'Text') {
      node.text = info.directTextRaw || info.directText || info.textRaw || info.text || '';
      node.style = info.font || null;
      return node;
    }

    if (type !== 'Text' && info.hasDirectText && info.directTextRect && !info.isIconGlyph) {
      node.children.push({
        id: createId(),
        parentId: id,
        childIndex: -1,
        type: 'Text',
        tagName: '#TEXT',
        htmlTag: '#text',
        classes: [],
        attrs: [],
        domPath: `${info.domPath || ''}::text`,
        rect: info.directTextRect,
        styles: {
          font: info.font,
        },
        style: info.font || null,
        visual: {
          hasVisual: false,
          isMask: false,
          isIconGlyph: false,
        },
        rotation: info.rotation,
        text: info.directTextRaw || info.directText,
        children: [],
      });
    }

    const childHandles = await handle.$$(':scope > *');
    childHandles.reverse();
    for (let idx = 0; idx < childHandles.length; idx += 1) {
      const childHandle = childHandles[idx];
      if (isAtomicImageTag) {
        await childHandle.dispose();
        continue;
      }

      const childNode = await this._traverse(page, childHandle, id, idx);
      if (childNode) {
        node.children.push(childNode);
      }
      await childHandle.dispose();
    }

    if (info.text) {
      node.text = info.text;
    }

    return node;
  }

  async _extractNodeInfo(handle) {
    const dpr = this._getDpr();
    return this._safeEvaluateOnHandle(
      handle,
      'Analyzer._extractNodeInfo',
      (el, devicePixelRatio) => {
        const tagName = el.tagName ? el.tagName.toUpperCase() : '';
        const htmlTag = tagName ? tagName.toLowerCase() : '';
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const rawText = el.textContent || '';
        const text = rawText.trim();
        const className =
          typeof el.className === 'string'
            ? el.className
            : typeof el.getAttribute === 'function'
              ? el.getAttribute('class') || ''
              : '';
        const hasMaterialIconClass = /(?:^|\s)(?:material-symbols(?:-(?:outlined|rounded|sharp))?|material-icons(?:-(?:outlined|round|sharp|two-tone))?)(?:\s|$)/i.test(className);
        const fontFamilyLower = (style.fontFamily || '').toLowerCase();
        const hasMaterialIconFont =
          fontFamilyLower.includes('material symbols') || fontFamilyLower.includes('material icons');
        const isIconGlyph = hasMaterialIconClass || hasMaterialIconFont;
        const isMaskLayer = el.getAttribute && el.getAttribute('data-bake-mask') === '1';
        const classes = (className || '')
          .split(/\s+/)
          .map((item) => item.trim())
          .filter((item) => item.length > 0);

        const getAttr = (name) => {
          if (typeof el.getAttribute !== 'function') return '';
          const value = el.getAttribute(name);
          return value == null ? '' : String(value);
        };

        const pushAttr = (list, key, value) => {
          const normalizedKey = (key || '').trim();
          if (!normalizedKey || value == null) return;
          const normalizedValue = String(value).trim();
          if (!normalizedValue) return;
          const exists = list.some((item) => item && item.key === normalizedKey);
          if (!exists) {
            list.push({ key: normalizedKey, value: normalizedValue });
          }
        };

        const attrs = [];
        const attrWhitelist = [
          'id',
          'name',
          'type',
          'role',
          'placeholder',
          'value',
          'href',
          'src',
          'alt',
          'title',
          'for',
          'aria-label',
          'aria-labelledby',
          'aria-describedby',
          'data-action',
          'data-cs-click',
          'data-cs-change',
          'data-cs-input',
        ];

        for (const attrName of attrWhitelist) {
          pushAttr(attrs, attrName, getAttr(attrName));
        }

        const boolAttrs = ['checked', 'disabled', 'readonly', 'required', 'selected'];
        if (typeof el.hasAttribute === 'function') {
          for (const attrName of boolAttrs) {
            if (el.hasAttribute(attrName)) {
              pushAttr(attrs, attrName, 'true');
            }
          }
        }

        if (el.attributes) {
          for (const rawAttr of Array.from(el.attributes)) {
            if (!rawAttr || !rawAttr.name) continue;
            if (/^data-ui-/i.test(rawAttr.name)) {
              pushAttr(attrs, rawAttr.name, rawAttr.value);
            }
          }
        }

        const role = getAttr('role');
        const inputType = htmlTag === 'input'
          ? ((getAttr('type') || 'text').trim().toLowerCase() || 'text')
          : '';

        const parseRotation = (transform) => {
          if (!transform || transform === 'none') return 0;

          const matrix3d = transform.match(/matrix3d\(([^)]+)\)/);
          if (matrix3d) {
            const values = matrix3d[1].split(',').map((v) => parseFloat(v.trim()));
            const a = values[0];
            const b = values[1];
            const angle = Math.atan2(b, a) * (180 / Math.PI);
            return Number.isFinite(angle) ? angle : 0;
          }

          const matrix2d = transform.match(/matrix\(([^)]+)\)/);
          if (matrix2d) {
            const values = matrix2d[1].split(',').map((v) => parseFloat(v.trim()));
            const a = values[0];
            const b = values[1];
            const angle = Math.atan2(b, a) * (180 / Math.PI);
            return Number.isFinite(angle) ? angle : 0;
          }

          const rotate = transform.match(/rotate\(([^)]+)\)/);
          if (rotate) {
            const raw = rotate[1].trim();
            if (raw.endsWith('deg')) return parseFloat(raw);
            if (raw.endsWith('rad')) return parseFloat(raw) * (180 / Math.PI);
          }

          return 0;
        };

        const rotation = parseRotation(style.transform);

        const isTransparentColor = (color) => {
          if (!color) return true;
          if (color === 'transparent') return true;
          const match = color.match(/rgba?\(([^)]+)\)/i);
          if (!match) return false;
          const parts = match[1].split(',').map((p) => p.trim());
          if (parts.length < 4) return false;
          const alpha = parseFloat(parts[3]);
          return Number.isFinite(alpha) && alpha === 0;
        };

        const hasBackgroundColor = !isTransparentColor(style.backgroundColor);
        const hasBackgroundImage = style.backgroundImage && style.backgroundImage !== 'none';
        const hasBorder = ['Top', 'Right', 'Bottom', 'Left'].some((side) => {
          const width = parseFloat(style[`border${side}Width`]);
          const borderStyle = style[`border${side}Style`];
          return width > 0 && borderStyle !== 'none' && borderStyle !== 'hidden';
        });
        const hasBoxShadow = style.boxShadow && style.boxShadow !== 'none';
        const hasVisual = hasBackgroundColor || hasBackgroundImage || hasBorder || hasBoxShadow;

        const transitionProperty = (style.transitionProperty || '').toLowerCase();
        const hasVisibilityTransition =
          transitionProperty.includes('all') || transitionProperty.includes('visibility');
        const hasExplicitHiddenClass = /(?:^|\s)(?:hidden|invisible|sr-only|collapse)(?:\s|$)/i.test(className);
        const hasExplicitHiddenAttr =
          (typeof el.hasAttribute === 'function' && el.hasAttribute('hidden')) ||
          (typeof el.getAttribute === 'function' && el.getAttribute('aria-hidden') === 'true');
        const transientHidden =
          style.visibility === 'hidden' &&
          hasVisibilityTransition &&
          !hasExplicitHiddenClass &&
          !hasExplicitHiddenAttr;

        const isVisible =
          style.display !== 'none' &&
          (style.visibility !== 'hidden' || transientHidden) &&
          parseFloat(style.opacity || '1') !== 0 &&
          rect.width > 0 &&
          rect.height > 0;

        const textNodes = Array.from(el.childNodes).filter(
          (node) => node.nodeType === Node.TEXT_NODE && (node.textContent || '').trim().length > 0,
        );

        let directText = '';
        let directTextRaw = '';
        let directTextRect = null;
        if (textNodes.length > 0) {
          directTextRaw = textNodes.map((node) => node.textContent).join('');
          directText = directTextRaw.trim();

          let minX = Infinity;
          let minY = Infinity;
          let maxX = -Infinity;
          let maxY = -Infinity;

          for (const node of textNodes) {
            const range = document.createRange();
            range.selectNodeContents(node);
            const rects = range.getClientRects();
            for (const r of rects) {
              minX = Math.min(minX, r.left);
              minY = Math.min(minY, r.top);
              maxX = Math.max(maxX, r.right);
              maxY = Math.max(maxY, r.bottom);
            }
          }

          if (Number.isFinite(minX)) {
            directTextRect = {
              x: (minX + window.scrollX) * devicePixelRatio,
              y: (minY + window.scrollY) * devicePixelRatio,
              width: (maxX - minX) * devicePixelRatio,
              height: (maxY - minY) * devicePixelRatio,
            };
          }
        }

        const parseCssPxToPhysical = (cssValue) => {
          if (!cssValue || cssValue === 'normal') return null;
          const match = cssValue.match(/(-?\d*\.?\d+)px/);
          if (match) {
            return parseFloat(match[1]) * devicePixelRatio;
          }
          return null;
        };

        const getDomPath = (node) => {
          if (!node || node.nodeType !== 1) return '';
          const parts = [];
          let current = node;
          while (current && current.nodeType === 1 && current !== document.documentElement) {
            const tag = current.tagName.toLowerCase();
            let index = 1;
            let sibling = current;
            while (sibling.previousElementSibling) {
              sibling = sibling.previousElementSibling;
              if (sibling.tagName === current.tagName) index += 1;
            }
            const sameTagCount = current.parentElement
              ? Array.from(current.parentElement.children).filter((c) => c.tagName === current.tagName).length
              : 0;
            const part = sameTagCount > 1 ? `${tag}:nth-of-type(${index})` : tag;
            parts.unshift(part);
            current = current.parentElement;
          }
          return parts.join(' > ');
        };

        const physicalRect = {
          x: (rect.left + window.scrollX) * devicePixelRatio,
          y: (rect.top + window.scrollY) * devicePixelRatio,
          width: rect.width * devicePixelRatio,
          height: rect.height * devicePixelRatio,
        };

        const physicalFontSize = parseCssPxToPhysical(style.fontSize);
        const physicalLineHeight = parseCssPxToPhysical(style.lineHeight);
        const physicalLetterSpacing = parseCssPxToPhysical(style.letterSpacing);

        const computedStyles = {
          background: style.background,
          backgroundColor: style.backgroundColor,
          backgroundImage: style.backgroundImage,
          border: style.border,
          borderRadius: style.borderRadius,
          boxShadow: style.boxShadow,
          opacity: style.opacity,
          display: style.display,
          visibility: style.visibility,
          position: style.position,
          zIndex: style.zIndex,
          transform: style.transform,
          transformOrigin: style.transformOrigin,
          overflow: style.overflow,
          overflowX: style.overflowX,
          overflowY: style.overflowY,
          pointerEvents: style.pointerEvents,
          mixBlendMode: style.mixBlendMode,
          clipPath: style.clipPath,
          maskImage: style.maskImage,
          mask: style.mask,
          backdropFilter: style.backdropFilter,
          webkitBackdropFilter: style.webkitBackdropFilter,
        };

        const font = {
          color: style.color,
          fontSize: physicalFontSize !== null ? `${physicalFontSize}px` : style.fontSize,
          fontFamily: style.fontFamily,
          alignment: style.textAlign,
          fontWeight: style.fontWeight,
          fontStyle: style.fontStyle,
          lineHeight: physicalLineHeight !== null ? `${physicalLineHeight}px` : style.lineHeight,
          letterSpacing: physicalLetterSpacing !== null ? `${physicalLetterSpacing}px` : style.letterSpacing,
          textTransform: style.textTransform,
          textDecoration: style.textDecorationLine || style.textDecoration,
          textShadow: style.textShadow,
          whiteSpace: style.whiteSpace,
          wordBreak: style.wordBreak,
          wordSpacing: style.wordSpacing,
          textIndent: style.textIndent,
          textOverflow: style.textOverflow,
          direction: style.direction,
        };

        return {
          tagName,
          htmlTag,
          role,
          inputType,
          classes,
          attrs,
          domPath: getDomPath(el),
          rect: physicalRect,
          text,
          textRaw: rawText,
          hasVisual,
          isIconGlyph,
          isMaskLayer,
          isVisible,
          hasText: text.length > 0,
          hasDirectText: directText.length > 0,
          rotation,
          font,
          styles: computedStyles,
          childCount: el.children.length,
          directText,
          directTextRaw,
          directTextRect,
        };
      },
      dpr,
    );
  }

  _getDpr() {
    const raw = this.context && this.context.config ? this.context.config.dpr : 1;
    const dpr = Number(raw);
    if (!Number.isFinite(dpr) || dpr <= 0) return 1;
    return dpr;
  }

  async _safeEvaluateOnHandle(handle, label, pageFunction, ...args) {
    try {
      return await handle.evaluate(pageFunction, ...args);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      throw new Error(`[${label}] ${message}`);
    }
  }
}

module.exports = Analyzer;
