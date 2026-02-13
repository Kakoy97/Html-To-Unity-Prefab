const fs = require('fs-extra');
const path = require('path');
const puppeteer = require('puppeteer');
const { v4: uuidv4 } = require('uuid');
const { pathToFileURL } = require('url');

const crypto = require('crypto');

const DEFAULT_VIEWPORT = {
  width: 750,
  height: 1624,
  deviceScaleFactor: 1,
};

function toPositiveNumber(value, fallback) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseArgValue(arg, name) {
  const prefix = `${name}=`;
  if (!arg.startsWith(prefix)) return null;
  return arg.slice(prefix.length);
}

function isEnabledArg(arg, name) {
  return arg === name || arg === `${name}=1` || arg === `${name}=true`;
}

function createNodeIdFactory(mode) {
  if (mode !== 'stable') {
    return () => uuidv4();
  }

  const duplicateCounters = new Map();
  return (seed) => {
    const key = JSON.stringify(seed);
    const duplicateIndex = duplicateCounters.get(key) || 0;
    duplicateCounters.set(key, duplicateIndex + 1);
    return crypto
      .createHash('sha1')
      .update(`${key}|${duplicateIndex}`)
      .digest('hex')
      .slice(0, 32);
  };
}

function sanitizeNamePart(value, fallback, maxLength = 48) {
  if (!value || typeof value !== 'string') return fallback;
  const normalized = value
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');
  if (!normalized) return fallback;
  return normalized.slice(0, maxLength);
}

function createImageFileName(serial, htmlNamePart) {
  const serialPart = String(serial).padStart(4, '0');
  const namePart = sanitizeNamePart(htmlNamePart, 'html', 64);
  return `${serialPart}_${namePart}`;
}

function normalizeNodeCoordinates(node, offsetX, offsetY) {
  if (!node || !node.rect) return;
  node.rect.x -= offsetX;
  node.rect.y -= offsetY;
  const children = node.children || [];
  for (const child of children) {
    normalizeNodeCoordinates(child, offsetX, offsetY);
  }
}

function toScreenshotClip(rect) {
  if (!rect) return null;
  const x0 = Number.isFinite(rect.x) ? rect.x : 0;
  const y0 = Number.isFinite(rect.y) ? rect.y : 0;
  const w0 = Number.isFinite(rect.width) ? rect.width : 0;
  const h0 = Number.isFinite(rect.height) ? rect.height : 0;
  if (w0 <= 0 || h0 <= 0) return null;

  const x = Math.max(0, x0);
  const y = Math.max(0, y0);
  const width = Math.max(1, w0 - (x - x0));
  const height = Math.max(1, h0 - (y - y0));
  return { x, y, width, height };
}

async function getElementPageRect(page, elementHandle) {
  return page.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return {
      x: rect.left + window.scrollX,
      y: rect.top + window.scrollY,
      width: rect.width,
      height: rect.height,
    };
  }, elementHandle);
}

async function detectAutoRootHandle(page) {
  const handle = await page.evaluateHandle(() => {
    const body = document.body;
    if (!body) return null;

    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 1;
    const tokenRegex = /(^|[\s_-])(app|root|page|screen|container|wrapper|main|content)([\s_-]|$)/i;
    const overlayRegex = /(^|[\s_-])(modal|dialog|popup|toast|tooltip|overlay|mask|backdrop|drawer)([\s_-]|$)/i;
    const hintSelectors = [
      '#app',
      '#root',
      '#__next',
      '#__nuxt',
      'main#app',
      'main[role="main"]',
      '[data-ui-root]',
      '[data-root]',
      '[data-app]',
    ];

    const getRect = (el) => el.getBoundingClientRect();
    const getTokenSource = (el) => `${el.id || ''} ${typeof el.className === 'string' ? el.className : ''}`.trim();

    const isVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      if (!style) return false;
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      if (parseFloat(style.opacity || '1') === 0) return false;
      const rect = getRect(el);
      if (!rect) return false;
      return rect.width > 1 && rect.height > 1;
    };

    const isLikelyOverlay = (el) => {
      if (!isVisible(el)) return false;
      const style = window.getComputedStyle(el);
      const rect = getRect(el);
      const tokenSource = getTokenSource(el);
      const coversViewport = rect.width >= viewportWidth * 0.92 && rect.height >= viewportHeight * 0.92;
      if (overlayRegex.test(tokenSource) && (style.position === 'fixed' || style.position === 'absolute')) return true;
      if (style.position === 'fixed' && coversViewport) return true;
      if ((style.position === 'absolute' || style.position === 'fixed') &&
          (style.top === '0px' || style.top === '0') &&
          (style.left === '0px' || style.left === '0') &&
          coversViewport) {
        return true;
      }
      return false;
    };

    const isCandidate = (el) => {
      if (!el || el === body) return false;
      if (!isVisible(el)) return false;
      if (isLikelyOverlay(el)) return false;
      const rect = getRect(el);
      if (rect.width < 24 || rect.height < 24) return false;
      return true;
    };

    // Stage 1: prefer well-known app root selectors.
    for (const selector of hintSelectors) {
      const el = document.querySelector(selector);
      if (el && body.contains(el) && isCandidate(el)) {
        return el;
      }
    }

    // Stage 2: if body has a single visible non-overlay child, treat it as body > div root.
    const directChildren = Array.from(body.children).filter((child) => isCandidate(child));
    if (directChildren.length === 1) {
      return directChildren[0];
    }

    // Stage 3: build document content bounds from visible non-overlay elements.
    const visibleNodes = Array.from(body.querySelectorAll('*')).filter((el) => isCandidate(el));
    const contentBounds = (() => {
      let minX = Number.POSITIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      for (const el of visibleNodes) {
        const rect = getRect(el);
        minX = Math.min(minX, rect.left);
        minY = Math.min(minY, rect.top);
        maxX = Math.max(maxX, rect.right);
        maxY = Math.max(maxY, rect.bottom);
      }
      if (!Number.isFinite(minX)) return null;
      return {
        x: minX,
        y: minY,
        width: Math.max(1, maxX - minX),
        height: Math.max(1, maxY - minY),
      };
    })();

    const fallbackDirectChildren = Array.from(body.children).filter((child) => isVisible(child));
    if (directChildren.length === 0 && fallbackDirectChildren.length === 1) {
      return fallbackDirectChildren[0];
    }

    // Stage 4: score direct children first, then one level deeper candidates.
    const pool = [];
    for (const child of directChildren) {
      pool.push({ el: child, depth: 0, directChild: true });
      const grandChildren = Array.from(child.children).filter((grandChild) => isCandidate(grandChild));
      for (const grandChild of grandChildren) {
        pool.push({ el: grandChild, depth: 1, directChild: false });
      }
    }

    if (pool.length === 0) return null;

    const candidates = [];
    const scoreElement = (el, depth, directChild) => {
      const rect = getRect(el);
      const style = window.getComputedStyle(el);
      const tokenSource = getTokenSource(el);
      const widthCoverage = rect.width / Math.max(1, viewportWidth);
      const heightCoverage = rect.height / Math.max(1, viewportHeight);
      let score = 0;

      if (directChild) score += 20;
      score -= depth * 6;
      score += Math.min(widthCoverage, 2) * 12;
      score += Math.min(heightCoverage, 2) * 12;

      const topLeftDistance = Math.abs(rect.left) + Math.abs(rect.top);
      score -= Math.min(topLeftDistance, 800) * 0.02;

      if (tokenRegex.test(tokenSource)) score += 12;
      if (overlayRegex.test(tokenSource)) score -= 24;
      if (el.tagName === 'MAIN') score += 8;
      if (el.tagName === 'DIV') score += 4;

      if (style.position === 'fixed') score -= 8;
      if (style.position === 'absolute') score -= 3;

      if (contentBounds) {
        const contentRight = contentBounds.x + contentBounds.width;
        const contentBottom = contentBounds.y + contentBounds.height;
        const dx = Math.abs(rect.left - contentBounds.x) + Math.abs(rect.right - contentRight);
        const dy = Math.abs(rect.top - contentBounds.y) + Math.abs(rect.bottom - contentBottom);
        score -= Math.min(dx + dy, 2400) * 0.015;
        const area = Math.max(1, rect.width * rect.height);
        const contentArea = Math.max(1, contentBounds.width * contentBounds.height);
        const areaRatio = Math.min(area, contentArea) / Math.max(area, contentArea);
        score += areaRatio * 18;
      }

      candidates.push({ el, score });
    };

    for (const item of pool) {
      scoreElement(item.el, item.depth, item.directChild);
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    if (best.score < 8) return null;
    return best.el;
  });

  const element = handle.asElement();
  if (!element) {
    await handle.dispose();
    return null;
  }
  return element;
}

async function waitForRenderStability(page) {
  await page.evaluate(async () => {
    if (document.fonts && document.fonts.ready) {
      try {
        await document.fonts.ready;
      } catch (err) {
        // Ignore font readiness failures and continue with frame settling.
      }
    }

    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

async function detectFullScreenMask(page) {
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
        : { width: viewportWidth, height: viewportHeight, left: 0, top: 0, right: viewportWidth, bottom: viewportHeight };

      const coversViewport = rect.width >= viewportWidth * 0.9 && rect.height >= viewportHeight * 0.9;
      const coversParent = rect.width >= parentRect.width * 0.9 && rect.height >= parentRect.height * 0.9;

      const hasBackground = !isTransparentColor(style.backgroundColor) ||
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
      const hasBackdrop = (style.backdropFilter && style.backdropFilter !== 'none') ||
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

async function captureElementImage(page, elementHandle, outputPath, options = {}) {
  const {
    hideChildren = false,
    inPlace = false,
    bakeRotation = false,
    neutralizeTransforms = false,
    iconTransparentMode = false,
    forceVisible = false,
  } = options;

  if (inPlace) {
    const markerId = uuidv4();
    await page.evaluate((el, id, hideChildrenFlag, bakeRotationFlag, neutralizeTransformsFlag, iconTransparentModeFlag) => {
      const prev = el.getAttribute('data-bake-id');
      el.__bakePrevId = prev;
      el.setAttribute('data-bake-id', id);

      const touchedById = window.__bakeTouchedNodes || (window.__bakeTouchedNodes = {});
      if (!touchedById[id]) touchedById[id] = [];

      const touchNode = (node) => {
        if (!node) return;
        if (!node.__bakeTouchedFlags) node.__bakeTouchedFlags = {};
        if (!node.__bakeTouchedFlags[id]) {
          node.__bakeTouchedFlags[id] = true;
          touchedById[id].push(node);
        }
      };

      const setProp = (node, prop, value) => {
        touchNode(node);
        if (!node.__bakePrevPropsById) node.__bakePrevPropsById = {};
        if (!node.__bakePrevPropsById[id]) node.__bakePrevPropsById[id] = {};
        const prevById = node.__bakePrevPropsById[id];
        if (!Object.prototype.hasOwnProperty.call(prevById, prop)) {
          prevById[prop] = {
            value: node.style.getPropertyValue(prop),
            priority: node.style.getPropertyPriority(prop),
          };
        }
        if (value === null) {
          node.style.removeProperty(prop);
        } else {
          node.style.setProperty(prop, value, 'important');
        }
      };

      // For icon-glyph capture, force transparent isolation to avoid ancestor backgrounds.
      const isolateTargetOnly = !!iconTransparentModeFlag;

      // Default isolation: hide all other elements but keep layout intact.
      const isolateStyle = document.createElement('style');
      isolateStyle.setAttribute('data-bake-isolate', id);
      const freezeMotionCss = `
        *, *::before, *::after {
          transition-property: none !important;
          transition-duration: 0s !important;
          transition-delay: 0s !important;
          animation: none !important;
        }
      `;
      isolateStyle.textContent = isolateTargetOnly
        ? `
          ${freezeMotionCss}
          html, body { background: transparent !important; }
          body * { visibility: hidden !important; }
        `
        : `
          ${freezeMotionCss}
          body * { visibility: hidden !important; }
        `;
      (document.head || document.documentElement).appendChild(isolateStyle);

      if (isolateTargetOnly) {
        el.__bakeIsolationToken = id;
        setProp(el, 'visibility', 'visible');
      } else {
        let isolateNode = el;
        while (isolateNode && isolateNode.nodeType === 1) {
          isolateNode.__bakeIsolationToken = id;
          setProp(isolateNode, 'visibility', 'visible');
          isolateNode = isolateNode.parentElement;
        }
      }

      if (hideChildrenFlag) {
        const descendants = el.querySelectorAll('*');
        for (const child of descendants) {
          setProp(child, 'visibility', 'hidden');
        }
        setProp(el, 'color', 'transparent');
        setProp(el, '-webkit-text-fill-color', 'transparent');
        setProp(el, 'text-shadow', 'none');
      }

      if (!bakeRotationFlag && neutralizeTransformsFlag) {
        const stripRotation = (transform) => {
          if (!transform || transform === 'none') return null;
          const matrixMatch = transform.match(/matrix\(([^)]+)\)/);
          if (matrixMatch) {
            const values = matrixMatch[1].split(',').map((v) => parseFloat(v.trim()));
            if (values.length >= 6) {
              const [a, b, c, d, e, f] = values;
              const angle = Math.atan2(b, a);
              const cos = Math.cos(angle);
              const sin = Math.sin(angle);
              const a2 = cos * a + sin * b;
              const b2 = -sin * a + cos * b;
              const c2 = cos * c + sin * d;
              const d2 = -sin * c + cos * d;
              return `matrix(${a2}, ${b2}, ${c2}, ${d2}, ${e}, ${f})`;
            }
          }
          return null;
        };

        const chain = [];
        let current = el;
        while (current && current.nodeType === 1) {
          chain.push(current);
          current = current.parentElement;
        }

        for (const node of chain) {
          const style = window.getComputedStyle(node);
          const override = stripRotation(style.transform);
          if (override) {
            node.__bakeTransformToken = id;
            setProp(node, 'transform', override);
            setProp(node, 'transform-origin', style.transformOrigin || '0 0');
            setProp(node, 'rotate', '0deg');
            setProp(node, '--tw-rotate', '0deg');
            setProp(node, '--tw-rotate-x', '0deg');
            setProp(node, '--tw-rotate-y', '0deg');
          }
        }
      }

      const mask = document.querySelectorAll('[data-bake-mask="1"]');
      if (mask.length && !el.closest('[data-bake-mask="1"]')) {
        for (const node of mask) {
          node.__bakeMaskToken = id;
          node.__bakePrevMaskVisibility = node.style.visibility;
          node.__bakePrevMaskPointer = node.style.pointerEvents;
          node.style.visibility = 'hidden';
          node.style.pointerEvents = 'none';
        }
      }
    }, elementHandle, markerId, hideChildren, bakeRotation, neutralizeTransforms, iconTransparentMode);

    const clip = await page.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);

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

      const shadowPad = Math.max(parseBoxShadowPad(style.boxShadow), parseDropShadowPad(style.filter));
      return {
        x: Math.max(0, rect.left - shadowPad),
        y: Math.max(0, rect.top - shadowPad),
        width: rect.width + shadowPad * 2,
        height: rect.height + shadowPad * 2,
      };
    }, elementHandle);

    if (clip && clip.width > 0 && clip.height > 0) {
      const currentViewport = page.viewport();
      let resized = false;
      const nextWidth = Math.ceil(clip.width);
      const nextHeight = Math.ceil(clip.height);
      if (currentViewport && (nextWidth > currentViewport.width || nextHeight > currentViewport.height)) {
        await page.setViewport({
          width: Math.max(nextWidth, currentViewport.width),
          height: Math.max(nextHeight, currentViewport.height),
          deviceScaleFactor: currentViewport.deviceScaleFactor || 2,
        });
        resized = true;
      }

      await page.screenshot({
        path: outputPath,
        clip,
        captureBeyondViewport: true,
        omitBackground: true,
      });

      if (resized && currentViewport) {
        await page.setViewport(currentViewport);
      }
    }

    await page.evaluate((el, id) => {
      const noMotionStyle = document.createElement('style');
      noMotionStyle.setAttribute('data-bake-no-motion', id);
      noMotionStyle.textContent = `
        *, *::before, *::after {
          transition-property: none !important;
          transition-duration: 0s !important;
          transition-delay: 0s !important;
          animation: none !important;
        }
      `;
      (document.head || document.documentElement).appendChild(noMotionStyle);

      const isolateStyle = document.querySelector(`style[data-bake-isolate="${id}"]`);
      if (isolateStyle) isolateStyle.remove();

      if (el.__bakePrevId === null || el.__bakePrevId === undefined) {
        el.removeAttribute('data-bake-id');
      } else {
        el.setAttribute('data-bake-id', el.__bakePrevId);
      }
      delete el.__bakePrevId;

      const touchedById = window.__bakeTouchedNodes || {};
      const touchedNodes = touchedById[id] || [];
      for (const node of touchedNodes) {
        const prevById = node.__bakePrevPropsById ? node.__bakePrevPropsById[id] : null;
        if (prevById) {
          for (const [prop, prev] of Object.entries(prevById)) {
            if (prev.value) {
              node.style.setProperty(prop, prev.value, prev.priority || '');
            } else {
              node.style.removeProperty(prop);
            }
          }
          delete node.__bakePrevPropsById[id];
        }
        if (node.__bakeTouchedFlags) {
          delete node.__bakeTouchedFlags[id];
        }
        delete node.__bakeTransformToken;
        delete node.__bakeIsolationToken;
      }
      delete touchedById[id];

      const mask = document.querySelectorAll('[data-bake-mask="1"]');
      for (const node of mask) {
        if (node.__bakeMaskToken === id) {
          node.style.visibility = node.__bakePrevMaskVisibility || '';
          node.style.pointerEvents = node.__bakePrevMaskPointer || '';
          delete node.__bakeMaskToken;
          delete node.__bakePrevMaskVisibility;
          delete node.__bakePrevMaskPointer;
        }
      }

      if (noMotionStyle.parentNode) {
        noMotionStyle.parentNode.removeChild(noMotionStyle);
      }
    }, elementHandle, markerId);

    return;
  }

  const cloneIsolateId = uuidv4();
  const cloneHandle = await page.evaluateHandle((el, hideChildrenFlag, bakeRotationFlag, neutralizeTransformsFlag, isolateId, forceVisibleFlag) => {
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';

    const style = window.getComputedStyle(el);
    const stripRotation = (transform) => {
      if (!transform || transform === 'none') return null;
      const matrixMatch = transform.match(/matrix\(([^)]+)\)/);
      if (matrixMatch) {
        const values = matrixMatch[1].split(',').map((v) => parseFloat(v.trim()));
        if (values.length >= 6) {
          const [a, b, c, d, e, f] = values;
          const angle = Math.atan2(b, a);
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);
          const a2 = cos * a + sin * b;
          const b2 = -sin * a + cos * b;
          const c2 = cos * c + sin * d;
          const d2 = -sin * c + cos * d;
          return `matrix(${a2}, ${b2}, ${c2}, ${d2}, ${e}, ${f})`;
        }
      }
      return null;
    };

    let rect;
    if (!bakeRotationFlag && neutralizeTransformsFlag) {
      const chain = [];
      let current = el;
      while (current && current.nodeType === 1) {
        chain.push(current);
        current = current.parentElement;
      }
      const changed = [];
      const setProp = (node, prop, value) => {
        if (!node.__bakePrevProps) node.__bakePrevProps = {};
        if (!node.__bakePrevProps[prop]) {
          node.__bakePrevProps[prop] = {
            value: node.style.getPropertyValue(prop),
            priority: node.style.getPropertyPriority(prop),
          };
        }
        if (value === null) {
          node.style.removeProperty(prop);
        } else {
          node.style.setProperty(prop, value, 'important');
        }
      };
      for (const node of chain) {
        const nodeStyle = window.getComputedStyle(node);
        const override = stripRotation(nodeStyle.transform);
        if (override) {
          changed.push(node);
          setProp(node, 'transform', override);
          setProp(node, 'transform-origin', nodeStyle.transformOrigin || '0 0');
          setProp(node, 'rotate', '0deg');
          setProp(node, '--tw-rotate', '0deg');
          setProp(node, '--tw-rotate-x', '0deg');
          setProp(node, '--tw-rotate-y', '0deg');
        }
      }
      rect = el.getBoundingClientRect();
      for (const node of changed) {
        if (node.__bakePrevProps) {
          for (const [prop, prev] of Object.entries(node.__bakePrevProps)) {
            if (prev.value) {
              node.style.setProperty(prop, prev.value, prev.priority || '');
            } else {
              node.style.removeProperty(prop);
            }
          }
          delete node.__bakePrevProps;
        }
      }
    } else {
      rect = el.getBoundingClientRect();
    }
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

    const shadowPad = Math.max(parseBoxShadowPad(style.boxShadow), parseDropShadowPad(style.filter));
    const clone = el.cloneNode(true);

    clone.style.position = 'fixed';
    clone.style.left = `${shadowPad}px`;
    clone.style.top = `${shadowPad}px`;
    clone.style.margin = '0';
    clone.style.transform = 'none';
    clone.style.zIndex = '2147483647';
    clone.style.pointerEvents = 'none';
    clone.style.width = `${rect.width}px`;
    clone.style.height = `${rect.height}px`;
    clone.style.boxSizing = style.boxSizing;
    if (forceVisibleFlag) {
      clone.style.visibility = 'visible';
    }
    clone.style.paddingTop = style.paddingTop;
    clone.style.paddingRight = style.paddingRight;
    clone.style.paddingBottom = style.paddingBottom;
    clone.style.paddingLeft = style.paddingLeft;
    clone.style.borderTop = style.borderTop;
    clone.style.borderRight = style.borderRight;
    clone.style.borderBottom = style.borderBottom;
    clone.style.borderLeft = style.borderLeft;
    clone.style.borderRadius = style.borderRadius;
    clone.style.background = style.background;
    clone.style.boxShadow = style.boxShadow;
    clone.style.filter = style.filter;
    clone.style.backgroundClip = style.backgroundClip;
    clone.style.overflow = style.overflow;
    clone.style.overflowX = style.overflowX;
    clone.style.overflowY = style.overflowY;
    // Preserve inherited text/icon presentation when the clone is detached from ancestors.
    clone.style.color = style.color;
    clone.style.webkitTextFillColor = style.webkitTextFillColor;
    clone.style.fontFamily = style.fontFamily;
    clone.style.fontSize = style.fontSize;
    clone.style.fontWeight = style.fontWeight;
    clone.style.fontStyle = style.fontStyle;
    clone.style.lineHeight = style.lineHeight;
    clone.style.letterSpacing = style.letterSpacing;
    clone.style.textTransform = style.textTransform;
    clone.style.fontVariationSettings = style.fontVariationSettings;
    clone.style.fontFeatureSettings = style.fontFeatureSettings;
    clone.style.fontOpticalSizing = style.fontOpticalSizing;
    if (
      style.overflow !== 'visible' ||
      style.overflowX !== 'visible' ||
      style.overflowY !== 'visible'
    ) {
      clone.style.overflow = 'hidden';
      clone.style.overflowX = 'hidden';
      clone.style.overflowY = 'hidden';
    }

    if (hideChildrenFlag) {
      while (clone.firstChild) {
        clone.removeChild(clone.firstChild);
      }
      clone.style.color = 'transparent';
      clone.style.webkitTextFillColor = 'transparent';
      clone.style.textShadow = 'none';
    }

    clone.setAttribute('data-bake-clone-id', isolateId);
    const isolateStyle = document.createElement('style');
    isolateStyle.setAttribute('data-bake-clone-isolate', isolateId);
    isolateStyle.textContent = `
      *, *::before, *::after {
        transition-property: none !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        animation: none !important;
      }
      body * { visibility: hidden !important; }
      [data-bake-clone-id="${isolateId}"],
      [data-bake-clone-id="${isolateId}"] * { visibility: visible !important; }
    `;
    (document.head || document.documentElement).appendChild(isolateStyle);

    clone.__bakePad = shadowPad;
    clone.__bakeCloneIsolateId = isolateId;
    document.body.appendChild(clone);
    return clone;
  }, elementHandle, hideChildren, bakeRotation, neutralizeTransforms, cloneIsolateId, forceVisible);

  const cloneElement = cloneHandle.asElement();
  if (cloneElement) {
    const clip = await page.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const pad = el.__bakePad || 0;
      return {
        x: Math.max(0, rect.left - pad),
        y: Math.max(0, rect.top - pad),
        width: rect.width + pad * 2,
        height: rect.height + pad * 2,
        pad,
      };
    }, cloneHandle);

    if (clip && clip.width > 0 && clip.height > 0) {
      const padding = 0;
      const clipRect = {
        x: Math.max(0, clip.x - padding),
        y: Math.max(0, clip.y - padding),
        width: Math.ceil(clip.width + padding * 2),
        height: Math.ceil(clip.height + padding * 2),
      };

      const currentViewport = page.viewport();
      let resized = false;
      const nextWidth = Math.ceil(clipRect.width);
      const nextHeight = Math.ceil(clipRect.height);
      if (currentViewport && (nextWidth > currentViewport.width || nextHeight > currentViewport.height)) {
        await page.setViewport({
          width: Math.max(nextWidth, currentViewport.width),
          height: Math.max(nextHeight, currentViewport.height),
          deviceScaleFactor: currentViewport.deviceScaleFactor || 2,
        });
        resized = true;
      }

      await page.screenshot({
        path: outputPath,
        clip: clipRect,
        captureBeyondViewport: true,
        omitBackground: true,
      });

      if (resized && currentViewport) {
        await page.setViewport(currentViewport);
      }
    }
  }

  await page.evaluate((el) => {
    const noMotionStyle = document.createElement('style');
    noMotionStyle.setAttribute('data-bake-no-motion-clone', '1');
    noMotionStyle.textContent = `
      *, *::before, *::after {
        transition-property: none !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        animation: none !important;
      }
    `;
    (document.head || document.documentElement).appendChild(noMotionStyle);

    if (el && el.__bakeCloneIsolateId) {
      const style = document.querySelector(`style[data-bake-clone-isolate="${el.__bakeCloneIsolateId}"]`);
      if (style) style.remove();
    }
    if (el && el.parentNode) {
      el.parentNode.removeChild(el);
    }

    if (noMotionStyle.parentNode) {
      noMotionStyle.parentNode.removeChild(noMotionStyle);
    }
  }, cloneHandle);

  await cloneHandle.dispose();
}

async function captureOriginalElementImage(page, elementHandle, outputPath) {
  const clip = await page.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);

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

    const shadowPad = Math.max(parseBoxShadowPad(style.boxShadow), parseDropShadowPad(style.filter));
    return {
      x: Math.max(0, rect.left - shadowPad),
      y: Math.max(0, rect.top - shadowPad),
      width: rect.width + shadowPad * 2,
      height: rect.height + shadowPad * 2,
    };
  }, elementHandle);

  if (clip && clip.width > 0 && clip.height > 0) {
    await page.screenshot({
      path: outputPath,
      clip,
      captureBeyondViewport: true,
    });
  }
}

async function getElementInfo(page, elementHandle, options = {}) {
  const { debug = false, neutralizeTransforms = false } = options;
  return page.evaluate((el, includeDebug, neutralize) => {
    const tagName = el.tagName ? el.tagName.toUpperCase() : '';
    const htmlTag = tagName ? tagName.toLowerCase() : '';
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const rawText = el.textContent || '';
    const text = rawText.trim();
    const className = typeof el.className === 'string'
      ? el.className
      : (typeof el.getAttribute === 'function' ? el.getAttribute('class') || '' : '');
    const hasMaterialIconClass = /(?:^|\s)(?:material-symbols(?:-(?:outlined|rounded|sharp))?|material-icons(?:-(?:outlined|round|sharp|two-tone))?)(?:\s|$)/i.test(
      className
    );
    const fontFamilyLower = (style.fontFamily || '').toLowerCase();
    const hasMaterialIconFont = fontFamilyLower.includes('material symbols') || fontFamilyLower.includes('material icons');
    const isIconGlyph = hasMaterialIconClass || hasMaterialIconFont;
    const isMaskLayer = el.getAttribute && el.getAttribute('data-bake-mask') === '1';
    const classes = (className || '').split(/\s+/).map((item) => item.trim()).filter((item) => item.length > 0);
    const getAttr = (name) => {
      if (typeof el.getAttribute !== 'function') return '';
      const value = el.getAttribute(name);
      return value == null ? '' : String(value);
    };
    const pushAttr = (list, key, value) => {
      const normalizedKey = (key || '').trim();
      if (!normalizedKey) return;
      if (value == null) return;
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
    const hasTransform = style.transform && style.transform !== 'none';

    const hasTransformChain = (() => {
      let current = el;
      while (current && current.nodeType === 1) {
        const cs = window.getComputedStyle(current);
        if (cs.transform && cs.transform !== 'none') return true;
        current = current.parentElement;
      }
      return false;
    })();

    const shouldNeutralize = neutralize && hasTransformChain;

    const stripRotation = (transform) => {
      if (!transform || transform === 'none') return null;
      const matrixMatch = transform.match(/matrix\(([^)]+)\)/);
      if (matrixMatch) {
        const values = matrixMatch[1].split(',').map((v) => parseFloat(v.trim()));
        if (values.length >= 6) {
          const [a, b, c, d, e, f] = values;
          const angle = Math.atan2(b, a);
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);
          const a2 = cos * a + sin * b;
          const b2 = -sin * a + cos * b;
          const c2 = cos * c + sin * d;
          const d2 = -sin * c + cos * d;
          return `matrix(${a2}, ${b2}, ${c2}, ${d2}, ${e}, ${f})`;
        }
      }
      return null;
    };

    let rectOverride = rect;
    let changed = null;
    if (shouldNeutralize) {
      changed = [];
      let current = el;
      while (current && current.nodeType === 1) {
        const cs = window.getComputedStyle(current);
        const override = stripRotation(cs.transform);
        if (override) {
          changed.push({
            node: current,
            transform: current.style.transform,
            origin: current.style.transformOrigin,
          });
          current.style.transform = override;
          current.style.transformOrigin = cs.transformOrigin;
        }
        current = current.parentElement;
      }
      rectOverride = el.getBoundingClientRect();
    }

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
    const hasExplicitHiddenClass =
      /(?:^|\s)(?:hidden|invisible|sr-only|collapse)(?:\s|$)/i.test(className);
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
      parseFloat(style.opacity) !== 0 &&
      rect.width > 0 &&
      rect.height > 0;

    const textNodes = Array.from(el.childNodes).filter(
      (node) => node.nodeType === Node.TEXT_NODE && (node.textContent || '').trim().length > 0
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
        range.detach();
      }

      if (Number.isFinite(minX)) {
        directTextRect = {
          x: minX + window.scrollX,
          y: minY + window.scrollY,
          width: maxX - minX,
          height: maxY - minY,
        };
      }
    }

    if (changed) {
      for (const entry of changed) {
        entry.node.style.transform = entry.transform || '';
        entry.node.style.transformOrigin = entry.origin || '';
      }
    }

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
    const domPath = getDomPath(el);

    let debugInfo = null;
    if (includeDebug) {
      const pickStyle = (s) => ({
        background: s.background,
        backgroundColor: s.backgroundColor,
        backgroundImage: s.backgroundImage,
        boxShadow: s.boxShadow,
        filter: s.filter,
        borderRadius: s.borderRadius,
        border: s.border,
        opacity: s.opacity,
        display: s.display,
        position: s.position,
        zIndex: s.zIndex,
        visibility: s.visibility,
        transform: s.transform,
        mixBlendMode: s.mixBlendMode,
        clipPath: s.clipPath,
        maskImage: s.maskImage,
        mask: s.mask,
        backdropFilter: s.backdropFilter,
        webkitBackdropFilter: s.webkitBackdropFilter,
        overflow: s.overflow,
        overflowX: s.overflowX,
        overflowY: s.overflowY,
      });

      const before = window.getComputedStyle(el, '::before');
      const after = window.getComputedStyle(el, '::after');
      debugInfo = {
        domPath: getDomPath(el),
        outerHTML: el.outerHTML,
        computedStyle: pickStyle(style),
        pseudo: {
          before: pickStyle(before),
          after: pickStyle(after),
        },
      };
    }

    return {
      tagName,
      htmlTag,
      role,
      inputType,
      classes,
      attrs,
      domPath,
      rect: {
        x: rectOverride.left + window.scrollX,
        y: rectOverride.top + window.scrollY,
        width: rectOverride.width,
        height: rectOverride.height,
      },
      text,
      textRaw: rawText,
      hasVisual,
      isIconGlyph,
      isMaskLayer,
      isVisible,
      forceVisibleForCapture: transientHidden,
      hasText: text.length > 0,
      hasDirectText: directText.length > 0,
      rotation,
      hasTransform,
      transformChain: hasTransformChain,
      transformNeutralized: !!(changed && changed.length > 0),
      neutralizedAncestorCount: changed ? changed.length : 0,
      font: {
        color: style.color,
        fontSize: style.fontSize,
        fontFamily: style.fontFamily,
        alignment: style.textAlign,
        fontWeight: style.fontWeight,
        fontStyle: style.fontStyle,
        lineHeight: style.lineHeight,
        letterSpacing: style.letterSpacing,
        textTransform: style.textTransform,
        textDecoration: style.textDecorationLine || style.textDecoration,
        textShadow: style.textShadow,
        whiteSpace: style.whiteSpace,
        wordBreak: style.wordBreak,
        wordSpacing: style.wordSpacing,
        textIndent: style.textIndent,
        textOverflow: style.textOverflow,
        direction: style.direction,
      },
      childCount: el.children.length,
      directText,
      directTextRaw,
      directTextRect,
      debugInfo,
    };
  }, elementHandle, debug, neutralizeTransforms);
}

async function needsInPlaceCapture(page, elementHandle) {
  return page.evaluate((el) => {
    const getReasons = (style) => {
      const reasons = [];
      if (!style) return reasons;
      if (style.overflow !== 'visible' || style.overflowX !== 'visible' || style.overflowY !== 'visible') {
        reasons.push('overflow');
      }
      if (style.clipPath && style.clipPath !== 'none') reasons.push('clipPath');
      if (style.maskImage && style.maskImage !== 'none') reasons.push('maskImage');
      if (style.mask && style.mask !== 'none') reasons.push('mask');
      if (style.opacity && parseFloat(style.opacity) < 1) reasons.push('opacity');
      if (style.filter && style.filter !== 'none') reasons.push('filter');
      if (style.backdropFilter && style.backdropFilter !== 'none') reasons.push('backdropFilter');
      if (style.webkitBackdropFilter && style.webkitBackdropFilter !== 'none') reasons.push('webkitBackdropFilter');
      if (style.mixBlendMode && style.mixBlendMode !== 'normal') reasons.push('mixBlendMode');
      return reasons;
    };

    let current = el;
    let depth = 0;
    while (current && current !== document.documentElement) {
      const style = window.getComputedStyle(current);
      const reasons = getReasons(style);
      if (reasons.length > 0) {
        return {
          inPlace: true,
          reason: depth === 0 ? reasons[0] : `ancestor-${reasons[0]}`,
        };
      }
      current = current.parentElement;
      depth += 1;
    }
    return { inPlace: false, reason: null };
  }, elementHandle);
}

async function processElement(page, elementHandle, imagesDir, debugState, options = {}) {
  const {
    bakeRotation = false,
    makeNodeId = () => uuidv4(),
    nextImageSerial = null,
    htmlNamePart = 'html',
    parentId = 'root',
    childIndex = -1,
  } = options;
  // Skip elements under a full-screen mask (unless they are within the mask or above it).
  if (page.__bakeMask && page.__bakeMask.hasMask) {
    const shouldSkip = await page.evaluate((el, mask) => {
      if (el === document.body || el === document.documentElement) return false;

      const maskEl = document.querySelector('[data-bake-mask="1"]');
      if (!maskEl) return false;
      if (el === maskEl) return false;
      if (el.contains(maskEl)) return false;
      const inMask = el.closest('[data-bake-mask="1"]');
      if (inMask) return false;

      const rect = el.getBoundingClientRect();
      const intersects = !(
        rect.right <= mask.rect.left ||
        rect.left >= mask.rect.right ||
        rect.bottom <= mask.rect.top ||
        rect.top >= mask.rect.bottom
      );
      if (!intersects) return false;

      const points = [
        [rect.left + rect.width / 2, rect.top + rect.height / 2],
        [rect.left + 1, rect.top + 1],
        [rect.right - 1, rect.bottom - 1],
      ];

      const vw = window.innerWidth || document.documentElement.clientWidth;
      const vh = window.innerHeight || document.documentElement.clientHeight;
      for (const [x, y] of points) {
        if (x < 0 || y < 0 || x > vw || y > vh) continue;
        const top = document.elementFromPoint(x, y);
        if (top && top.closest('[data-bake-mask="1"]')) {
          return true;
        }
      }

      return false;
    }, elementHandle, page.__bakeMask);

    if (shouldSkip) return null;
  }

  const info = await getElementInfo(page, elementHandle, {
    debug: debugState && debugState.enabled,
    neutralizeTransforms: !bakeRotation,
  });
  if (!info.isVisible) return null;

  let type;
  const isRootBody = info.tagName === 'BODY';
  const isMaskLayer = info.isMaskLayer === true;
  const isAtomicImageTag = ['IMG', 'SVG', 'CANVAS', 'VIDEO', 'PICTURE'].includes(info.tagName);
  const isVisual = info.hasVisual || isAtomicImageTag || info.isIconGlyph;

  if (isRootBody || isMaskLayer) {
    // Root background is already captured as bg.png; mask layers are composited from children.
    type = 'Container';
  } else if (isVisual) {
    type = 'Image';
  } else if (info.hasDirectText && info.childCount === 0) {
    type = 'Text';
  } else if (info.childCount > 0) {
    type = 'Container';
  } else {
    return null;
  }

  const id = makeNodeId({
    kind: 'node',
    parentId,
    childIndex,
    type,
    tagName: info.tagName,
    domPath: info.domPath || '',
    rect: info.rect,
  });
  const node = {
    id,
    type,
    htmlTag: info.htmlTag || '',
    role: info.role || '',
    inputType: info.inputType || '',
    classes: Array.isArray(info.classes) ? info.classes : [],
    attrs: Array.isArray(info.attrs) ? info.attrs : [],
    domPath: info.domPath || '',
    rect: info.rect,
    rotation: info.rotation,
    transformNeutralized: info.transformNeutralized || false,
    neutralizedAncestorCount: info.neutralizedAncestorCount || 0,
    children: [],
  };

  let debugRecord = null;
  if (debugState && debugState.enabled) {
    debugRecord = {
      id,
      type,
      htmlTag: info.htmlTag || '',
      role: info.role || '',
      inputType: info.inputType || '',
      tagName: info.tagName,
      rect: info.rect,
      rotation: info.rotation,
      transformNeutralized: info.transformNeutralized || false,
      neutralizedAncestorCount: info.neutralizedAncestorCount || 0,
      transformChain: info.transformChain || false,
      domPath: info.domPath || null,
      outerHTML: info.debugInfo ? info.debugInfo.outerHTML : null,
      computedStyle: info.debugInfo ? info.debugInfo.computedStyle : null,
      pseudo: info.debugInfo ? info.debugInfo.pseudo : null,
      captureMode: null,
      inPlaceReason: null,
      imagePath: null,
      originalPath: null,
    };
    debugState.records.push(debugRecord);
  }

  if (type === 'Text') {
    node.text = info.directTextRaw || info.directText || info.textRaw || info.text;
    node.style = info.font;
    return node;
  }

  if (type !== 'Text' && info.directText && info.directTextRect && !info.isIconGlyph) {
    node.children.push({
      id: makeNodeId({
        kind: 'directText',
        parentId: id,
        type: 'Text',
        tagName: info.tagName,
        domPath: info.domPath || '',
        rect: info.directTextRect,
        text: info.directTextRaw || info.directText,
      }),
      type: 'Text',
      htmlTag: '#text',
      role: '',
      inputType: '',
      classes: [],
      attrs: [],
      domPath: `${info.domPath || ''}::text`,
      rect: info.directTextRect,
      text: info.directTextRaw || info.directText,
      style: info.font,
      rotation: info.rotation,
      children: [],
    });
  }

  const childHandles = await elementHandle.$$(':scope > *');
  childHandles.reverse();
  for (let idx = 0; idx < childHandles.length; idx += 1) {
    const child = childHandles[idx];
    if (isAtomicImageTag) {
      await child.dispose();
      continue;
    }
    const childNode = await processElement(page, child, imagesDir, debugState, {
      ...options,
      parentId: id,
      childIndex: idx,
    });
    if (childNode) {
      node.children.push(childNode);
    }
    await child.dispose();
  }

  if (type === 'Image') {
    const imageSerial = typeof nextImageSerial === 'function' ? nextImageSerial() : 0;
    const imageFileName = createImageFileName(imageSerial, htmlNamePart);
    const imagePath = `images/${imageFileName}.png`;
    node.imagePath = imagePath;
    const outputPath = path.join(imagesDir, `${imageFileName}.png`);
    const hideChildren = info.hasVisual && !isAtomicImageTag;
    let inPlace = false;
    let inPlaceReason = null;
    let captureMode = 'clone';
    if (info.isIconGlyph) {
      // Icon glyphs are captured via clone mode to keep transparent background.
      inPlace = false;
      inPlaceReason = null;
      captureMode = 'clone';
    } else if (!hideChildren) {
      const inPlaceDecision = await needsInPlaceCapture(page, elementHandle);
      inPlace = !!(inPlaceDecision && inPlaceDecision.inPlace);
      inPlaceReason = inPlace ? (inPlaceDecision.reason || 'effect') : null;
      captureMode = inPlace ? 'inPlace' : 'clone';
    }
    const neutralizeTransforms = info.transformNeutralized && !bakeRotation;
    await captureElementImage(page, elementHandle, outputPath, {
      hideChildren,
      inPlace,
      bakeRotation,
      neutralizeTransforms,
      iconTransparentMode: info.isIconGlyph,
      forceVisible: info.forceVisibleForCapture === true,
    });
    if (bakeRotation && info.rotation) {
      node.rotationBaked = true;
      node.rotationOriginal = info.rotation;
      node.rotation = 0;
    }

    if (debugState && debugState.enabled) {
      const originalPath = path.join(debugState.originalDir, `${id}.png`);
      await captureOriginalElementImage(page, elementHandle, originalPath);
      if (debugRecord) {
        debugRecord.captureMode = captureMode;
        debugRecord.inPlaceReason = inPlaceReason;
        debugRecord.imagePath = imagePath;
        debugRecord.originalPath = path.relative(debugState.outputDir, originalPath);
      }
    }
  }

  return node;
}

async function main() {
  const args = process.argv.slice(2);
  let htmlInput = null;
  let debugEnabled = false;
  let bakeRotation = false;
  let outputDirInput = null;
  let viewportWidth = DEFAULT_VIEWPORT.width;
  let viewportHeight = DEFAULT_VIEWPORT.height;
  let deviceScaleFactor = DEFAULT_VIEWPORT.deviceScaleFactor;
  let idMode = 'uuid';
  let rootSelector = null;
  for (const arg of args) {
    const outputArg = parseArgValue(arg, '--output-dir');
    const widthArg = parseArgValue(arg, '--viewport-width');
    const heightArg = parseArgValue(arg, '--viewport-height');
    const dprArg = parseArgValue(arg, '--device-scale-factor');
    const idModeArg = parseArgValue(arg, '--id-mode');
    const rootSelectorArg = parseArgValue(arg, '--root-selector');

    if (isEnabledArg(arg, '--debug')) {
      debugEnabled = true;
    } else if (isEnabledArg(arg, '--bake-rotation')) {
      bakeRotation = true;
    } else if (outputArg !== null) {
      outputDirInput = outputArg;
    } else if (widthArg !== null) {
      viewportWidth = Math.round(toPositiveNumber(widthArg, DEFAULT_VIEWPORT.width));
    } else if (heightArg !== null) {
      viewportHeight = Math.round(toPositiveNumber(heightArg, DEFAULT_VIEWPORT.height));
    } else if (dprArg !== null) {
      deviceScaleFactor = toPositiveNumber(dprArg, DEFAULT_VIEWPORT.deviceScaleFactor);
    } else if (idModeArg !== null) {
      idMode = idModeArg === 'stable' ? 'stable' : 'uuid';
    } else if (rootSelectorArg !== null) {
      const parsedRootSelector = rootSelectorArg ? rootSelectorArg.trim() : '';
      rootSelector = parsedRootSelector || null;
    } else if (!arg.startsWith('--') && !htmlInput) {
      htmlInput = arg;
    }
  }
  if (!htmlInput) htmlInput = 'index.html';
  let htmlPath = path.resolve(htmlInput);

  const exists = await fs.pathExists(htmlPath);
  if (!exists) {
    console.error(`HTML file not found: ${htmlPath}`);
    process.exit(1);
  }

  const stat = await fs.stat(htmlPath);
  if (stat.isDirectory()) {
    const candidate = path.join(htmlPath, 'index.html');
    if (await fs.pathExists(candidate)) {
      htmlPath = candidate;
    } else {
      console.error(
        `Provided path is a directory. Please pass an HTML file (e.g. ${path.join(htmlPath, 'index.html')}).`
      );
      process.exit(1);
    }
  }

  const outputDir = path.resolve(outputDirInput || 'output');
  const imagesDir = path.join(outputDir, 'images');
  const htmlNamePart = sanitizeNamePart(path.basename(htmlPath, path.extname(htmlPath)), 'html', 64);
  const viewport = {
    width: viewportWidth,
    height: viewportHeight,
    deviceScaleFactor,
  };

  await fs.remove(outputDir);
  await fs.ensureDir(imagesDir);

  const debugState = {
    enabled: debugEnabled,
    records: [],
    outputDir,
    originalDir: path.join(outputDir, 'debug', 'original'),
  };
  if (debugState.enabled) {
    await fs.ensureDir(debugState.originalDir);
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--allow-file-access-from-files'],
  });

  const page = await browser.newPage();
  await page.setViewport(viewport);

  const fileUrl = pathToFileURL(htmlPath).href;
  await page.goto(fileUrl, { waitUntil: 'networkidle0' });
  await waitForRenderStability(page);

  page.__bakeMask = await detectFullScreenMask(page);

  const bodyHandle = await page.$('body');
  if (!bodyHandle) {
    throw new Error('No <body> element found in HTML.');
  }

  let rootHandle = bodyHandle;
  let cropOffsetX = 0;
  let cropOffsetY = 0;
  let bgClip = null;
  const normalizedRootSelector = rootSelector ? rootSelector.toLowerCase() : '';
  if (rootSelector && normalizedRootSelector !== 'auto') {
    const selectedRoot = await page.$(rootSelector);
    if (!selectedRoot) {
      throw new Error(`Root selector not found: ${rootSelector}`);
    }
    rootHandle = selectedRoot;
    const rootRect = await getElementPageRect(page, rootHandle);
    const clip = toScreenshotClip(rootRect);
    if (!clip) {
      throw new Error(`Root selector resolved to invalid bounds: ${rootSelector}`);
    }
    bgClip = clip;
    cropOffsetX = clip.x;
    cropOffsetY = clip.y;
  } else if (normalizedRootSelector === 'auto') {
    const autoRoot = await detectAutoRootHandle(page);
    if (autoRoot) {
      const autoRect = await getElementPageRect(page, autoRoot);
      const clip = toScreenshotClip(autoRect);
      if (clip) {
        rootHandle = autoRoot;
        bgClip = clip;
        cropOffsetX = clip.x;
        cropOffsetY = clip.y;
      } else {
        await autoRoot.dispose();
      }
    }
  }

  const bgPath = path.join(imagesDir, 'bg.png');
  if (bgClip) {
    await page.screenshot({
      path: bgPath,
      clip: bgClip,
      captureBeyondViewport: true,
    });
  } else {
    await page.screenshot({
      path: bgPath,
      fullPage: true,
      captureBeyondViewport: true,
    });
  }

  const makeNodeId = createNodeIdFactory(idMode);
  let imageSerialCounter = 0;
  const nextImageSerial = () => {
    imageSerialCounter += 1;
    return imageSerialCounter;
  };
  const layout = await processElement(page, rootHandle, imagesDir, debugState, {
    bakeRotation,
    makeNodeId,
    nextImageSerial,
    htmlNamePart,
    parentId: 'root',
    childIndex: 0,
  });
  if (bgClip) {
    normalizeNodeCoordinates(layout, cropOffsetX, cropOffsetY);
  }
  await fs.writeJson(path.join(outputDir, 'layout.json'), layout, { spaces: 2 });

  if (rootHandle !== bodyHandle) {
    await rootHandle.dispose();
  }
  await bodyHandle.dispose();
  await browser.close();

  if (debugState.enabled) {
    const debugPath = path.join(outputDir, 'debug', 'debug.json');
    await fs.writeJson(debugPath, debugState.records, { spaces: 2 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
