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
    const config = this.context && this.context.config ? this.context.config : {};
    const fontsReadyTimeoutMs = this._toPositiveInt(config.fontsReadyTimeoutMs, 2500);

    await page.evaluate(async (fontTimeoutMs) => {
      const waitWithTimeout = async (promise, timeoutMs) => new Promise((resolve, reject) => {
        let done = false;
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          reject(new Error('fonts-ready-timeout'));
        }, Math.max(1, timeoutMs));

        Promise.resolve(promise)
          .then((value) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(value);
          })
          .catch((error) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            reject(error);
          });
      });

      if (document.fonts && document.fonts.ready) {
        try {
          await waitWithTimeout(document.fonts.ready, fontTimeoutMs);
        } catch (_) {
          // Continue even if fonts are delayed/rejected.
        }
      }

      await new Promise((resolve) => requestAnimationFrame(resolve));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await new Promise((resolve) => setTimeout(resolve, 50));
    }, fontsReadyTimeoutMs);
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
        return /(?:^|\s)(?:overlay|mask|modal|backdrop|bg-opacity-\d+|backdrop-blur-\w+)(?:\s|$)/i.test(cls);
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

        const coversViewport = rect.width >= viewportWidth * 0.9 && rect.height >= viewportHeight * 0.9;
        const viewportArea = Math.max(1, viewportWidth * viewportHeight);
        const areaRatio = (rect.width * rect.height) / viewportArea;

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

        const zIndex = getEffectiveZ(el);
        const isViewportScale = coversViewport || areaRatio >= 0.7;
        const globalOverlayLike =
          isViewportScale &&
          (
            style.position === 'fixed' ||
            isInsetZero(style) ||
            hasOverlayClass(el) ||
            hasBackdrop ||
            isTranslucent ||
            zIndex >= 100
          );
        if (!globalOverlayLike) continue;

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
    const isRangeInput = info.htmlTag === 'input' && info.inputType === 'range';
    const hasRangeParts = isRangeInput && Array.isArray(info.rangeParts) && info.rangeParts.length > 0;
    const isVisual = info.hasVisual || isAtomicImageTag || info.isIconGlyph;

    let type = 'Container';
    if (isRootBody || isMaskLayer) {
      type = 'Container';
    } else if (hasRangeParts) {
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
      zIndex: info.zIndex,
      visual: {
        hasVisual: hasRangeParts ? false : !!info.hasVisual,
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

    if (hasRangeParts) {
      const rangeParts = info.rangeParts;
      for (let idx = 0; idx < rangeParts.length; idx += 1) {
        const part = rangeParts[idx];
        if (!part || !part.rect) continue;
        node.children.push({
          id: createId(),
          parentId: id,
          childIndex: -(100 + idx),
          type: 'Image',
          tagName: 'DIV',
          htmlTag: 'div',
          role: '',
          inputType: '',
          classes: [`__range-part`, `__range-${part.name || 'part'}`],
          attrs: [
            { key: 'data-range-part', value: part.name || 'part' },
            { key: 'data-range-source', value: id },
          ],
          domPath: `${info.domPath || ''}::range-${part.name || idx}`,
          rect: part.rect,
          styles: {
            position: 'absolute',
            zIndex: String((info.zIndex || 0) + (part.name === 'thumb' ? 0.1 : 0)),
          },
          zIndex: (info.zIndex || 0) + (part.name === 'thumb' ? 0.1 : 0),
          visual: {
            hasVisual: true,
            isMask: false,
            isIconGlyph: false,
          },
          rotation: info.rotation,
          captureFrom: {
            sourceNodeId: id,
            rangePart: part.name || 'part',
          },
          children: [],
        });
      }
    }

    const childHandles = await handle.$$(':scope > *');
    childHandles.reverse();
    for (let idx = 0; idx < childHandles.length; idx += 1) {
      const childHandle = childHandles[idx];
      const domOrder = childHandles.length - 1 - idx;
      if (isAtomicImageTag) {
        await childHandle.dispose();
        continue;
      }

      const childNode = await this._traverse(page, childHandle, id, domOrder);
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
        const isRangeInput = htmlTag === 'input' && inputType === 'range';

        const toNumber = (value, fallback = 0) => {
          const parsed = Number(value);
          return Number.isFinite(parsed) ? parsed : fallback;
        };

        const parsePx = (value, fallback = 0) => {
          if (!value || value === 'normal') return fallback;
          const match = String(value).match(/(-?\d*\.?\d+)px/);
          if (!match) return fallback;
          const parsed = parseFloat(match[1]);
          return Number.isFinite(parsed) ? parsed : fallback;
        };

        const parseZIndex = (value) => {
          if (!value || value === 'auto') return 0;
          const parsed = parseFloat(value);
          return Number.isFinite(parsed) ? parsed : 0;
        };

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
        const hasVisual = hasBackgroundColor || hasBackgroundImage || hasBorder || hasBoxShadow || isRangeInput;

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

        const buildRangeParts = () => {
          if (!isRangeInput || rect.width <= 0 || rect.height <= 0) return [];
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

          const parseBoxShadowPad = (boxShadow) => {
            if (!boxShadow || boxShadow === 'none') return 0;
            const parts = [];
            let depth = 0;
            let current = '';
            for (const ch of String(boxShadow)) {
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

          const min = toNumber(el.min, 0);
          const max = toNumber(el.max, 100);
          const value = toNumber(el.value, min);
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

          const thumbWidth = Math.max(1, parsePx(thumbStyle.width, NaN));
          const thumbHeight = Math.max(1, parsePx(thumbStyle.height, NaN));
          const thumbBorderTop = parseBorderWidth(thumbStyle, 'top');
          const thumbBorderBottom = parseBorderWidth(thumbStyle, 'bottom');
          const thumbBorderLeft = parseBorderWidth(thumbStyle, 'left');
          const thumbBorderRight = parseBorderWidth(thumbStyle, 'right');

          let resolvedThumbWidth = thumbWidth;
          let resolvedThumbHeight = thumbHeight;
          const fallbackThumbWidth = Math.max(8, (trackHeightRaw > 0 ? trackHeightRaw : trackHeight) * 2);
          const fallbackThumbHeight = Math.max(12, (trackHeightRaw > 0 ? trackHeightRaw : trackHeight) * 3);
          if (!Number.isFinite(resolvedThumbWidth) || resolvedThumbWidth <= 0 || resolvedThumbWidth >= trackWidth * 0.8) {
            resolvedThumbWidth = fallbackThumbWidth;
          }
          if (!Number.isFinite(resolvedThumbHeight) || resolvedThumbHeight <= 0 || resolvedThumbHeight >= Math.max(rect.height * 4, trackHeight * 6)) {
            resolvedThumbHeight = fallbackThumbHeight;
          }
          resolvedThumbWidth += thumbBorderLeft + thumbBorderRight;
          resolvedThumbHeight += thumbBorderTop + thumbBorderBottom;

          const thumbMarginTop = parsePx(thumbStyle['margin-top'], 0);
          const safeThumbMarginTop =
            Number.isFinite(thumbMarginTop) && Math.abs(thumbMarginTop) <= Math.max(rect.height * 4, trackHeight * 6)
              ? thumbMarginTop
              : 0;
          const hasExplicitThumbMarginTop = Number.isFinite(thumbMarginTop) && Math.abs(thumbMarginTop) > 0.001;
          // In Chromium, range thumb vertical placement follows margin-top semantics
          // more closely than pure center alignment when author CSS sets margin-top.
          const trackContentTop = rect.top + (rect.height - trackHeightRaw) / 2 + trackBorderTop;
          const thumbTravel = Math.max(0, trackWidth - trackBorderLeft - trackBorderRight - resolvedThumbWidth);
          const thumbX = trackX + trackBorderLeft + ratio * thumbTravel;
          const thumbY = hasExplicitThumbMarginTop
            ? (trackContentTop + safeThumbMarginTop)
            : (trackY + (trackHeight - resolvedThumbHeight) / 2);

          const trackShadowPad = parseBoxShadowPad(trackStyle['box-shadow']);
          const thumbShadowPad = parseBoxShadowPad(thumbStyle['box-shadow']);

          const toPhysicalRect = (x, y, width, height, shadowPad = 0) => ({
            x: (x - shadowPad + window.scrollX) * devicePixelRatio,
            y: (y - shadowPad + window.scrollY) * devicePixelRatio,
            width: Math.max(1, (width + shadowPad * 2) * devicePixelRatio),
            height: Math.max(1, (height + shadowPad * 2) * devicePixelRatio),
          });

          return [
            {
              name: 'track',
              rect: toPhysicalRect(trackX, trackY, trackWidth, trackHeight, trackShadowPad),
            },
            {
              name: 'thumb',
              rect: toPhysicalRect(thumbX, thumbY, resolvedThumbWidth, resolvedThumbHeight, thumbShadowPad),
            },
          ];
        };

        const rangeParts = buildRangeParts();
        const zIndex = parseZIndex(style.zIndex);

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
          filter: style.filter,
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
          zIndex,
          font,
          styles: computedStyles,
          childCount: el.children.length,
          directText,
          directTextRaw,
          directTextRect,
          rangeParts,
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

  _toPositiveInt(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return parsed;
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
