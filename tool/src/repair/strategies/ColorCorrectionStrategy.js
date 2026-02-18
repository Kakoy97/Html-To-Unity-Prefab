const BaseStrategy = require('../domain/strategies/BaseStrategy');

const FIXED_FILTER_GAMMA = 'contrast(1.2) brightness(0.85) saturate(1.1)';
const FIXED_FILTER_VIVID = 'contrast(1.1) saturate(1.4) brightness(0.9)';

class ColorCorrectionStrategy extends BaseStrategy {
  constructor() {
    super('color_correction', 'Color Correction');
  }

  async run(request, context) {
    const nodeId = request.targetNodeId;
    const hints = this._resolveHints(context);
    const primarySelector = this.getNodeSelector(nodeId);
    const fallbackSelector = (
      hints.sourceNodeId && String(hints.sourceNodeId) !== String(nodeId)
    ) ? this.getNodeSelector(hints.sourceNodeId) : '';
    const focusSelector = '[data-repair-focus="1"]';

    const outputAuto = await context.imagePatcher.allocateVariantPath(nodeId, 'colorauto');
    const outputGamma = await context.imagePatcher.allocateVariantPath(nodeId, 'colorgamma');
    const outputVivid = await context.imagePatcher.allocateVariantPath(nodeId, 'colorvivid');

    const variants = await context.browserSession.execute(request.htmlPath, async ({ page }) => {
      await this.cleanup(page);
      try {
        const capture = await page.evaluate((targetPrimarySelector, targetFallbackSelector, options) => {
          const staleStyle = document.getElementById('repair-color-style');
          if (staleStyle) staleStyle.remove();
          const staleFocused = document.querySelectorAll('[data-repair-focus="1"]');
          for (const item of staleFocused) item.removeAttribute('data-repair-focus');

          const target = document.querySelector(targetPrimarySelector)
            || (targetFallbackSelector ? document.querySelector(targetFallbackSelector) : null);
          if (!target) return null;
          target.setAttribute('data-repair-focus', '1');

          const selector = '[data-repair-focus="1"]';
          const rect = target.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return null;

          const styleTag = document.createElement('style');
          styleTag.id = 'repair-color-style';
          const rules = [
            '*, *::before, *::after {',
            '  transition-property: none !important;',
            '  transition-duration: 0s !important;',
            '  transition-delay: 0s !important;',
            '  animation: none !important;',
            '}',
          ];

          if (options.isolateNode) {
            rules.push(
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
            );
            if (options.hideChildren) {
              rules.push(
                `${selector} { visibility: visible !important; }`,
                `${selector} * { visibility: hidden !important; }`,
              );
            } else {
              rules.push(`${selector}, ${selector} * { visibility: visible !important; }`);
            }
          }

          if (!options.isolateNode && options.hideChildren) {
            rules.push(`${selector} * { visibility: hidden !important; }`);
          }

          if (options.stripText) {
            const textScope = options.hideOwnText
              ? `${selector}, ${selector} *`
              : `${selector} *`;
            rules.push(
              `${textScope} {`,
              '  color: transparent !important;',
              '  -webkit-text-fill-color: transparent !important;',
              '  text-shadow: none !important;',
              '  caret-color: transparent !important;',
              '}',
              `${selector} input, ${selector} textarea, ${selector} select {`,
              '  color: transparent !important;',
              '  -webkit-text-fill-color: transparent !important;',
              '}',
            );
          }

          styleTag.innerHTML = rules.join('\n');
          document.head.appendChild(styleTag);

          const finalRect = target.getBoundingClientRect();
          return {
            clip: {
              x: finalRect.left,
              y: finalRect.top,
              width: finalRect.width,
              height: finalRect.height,
            },
          };
        }, primarySelector, fallbackSelector, {
          hideChildren: !!hints.hideChildren,
          hideOwnText: !!hints.hideOwnText,
          stripText: !!hints.stripText,
          isolateNode: !!hints.isolateNode,
        });

        if (!capture || !capture.clip) {
          throw new Error(`ColorCorrectionStrategy: target not found for ${nodeId}`);
        }

        const clip = this.normalizeClip(capture.clip);
        if (!clip) {
          throw new Error(`ColorCorrectionStrategy: invalid clip for ${nodeId}`);
        }

        const base64 = await page.screenshot({
          clip,
          omitBackground: true,
          captureBeyondViewport: true,
          encoding: 'base64',
        });

        const analysis = await this._analyzePixels(page, base64);
        const manualOverride = this._resolveManualFilter(request);
        const autoFilter = manualOverride || analysis.filter;
        const autoDescription = this._buildAutoDescription(analysis, manualOverride);

        await this._captureWithFilter(page, focusSelector, clip, autoFilter, outputAuto.absolutePath);
        await this._captureWithFilter(page, focusSelector, clip, FIXED_FILTER_GAMMA, outputGamma.absolutePath);
        await this._captureWithFilter(page, focusSelector, clip, FIXED_FILTER_VIVID, outputVivid.absolutePath);

        return [
          this.createVariant({
            id: 'variant_color_auto',
            name: 'Auto-Levels',
            imagePath: outputAuto.relativePath,
            description: autoDescription,
            metadata: {
              strategy: 'COLOR_CORRECTION_AUTO',
              colorFilter: autoFilter,
              minLuma: analysis.minLuma,
              avgLuma: analysis.avgLuma,
              maxLuma: analysis.maxLuma,
              sampleCount: analysis.sampleCount,
              contrast: analysis.contrast,
              brightness: analysis.brightness,
              saturate: analysis.saturate,
              manualOverride: !!manualOverride,
            },
          }),
          this.createVariant({
            id: 'variant_color_gamma',
            name: 'Gamma Correct',
            imagePath: outputGamma.relativePath,
            description: 'Gamma correction (fix Unity washed-out look)',
            metadata: {
              strategy: 'COLOR_CORRECTION_GAMMA',
              colorFilter: FIXED_FILTER_GAMMA,
            },
          }),
          this.createVariant({
            id: 'variant_color_vivid',
            name: 'Deep Vivid',
            imagePath: outputVivid.relativePath,
            description: 'Deep vivid mode (enhance glow and saturation)',
            metadata: {
              strategy: 'COLOR_CORRECTION_VIVID',
              colorFilter: FIXED_FILTER_VIVID,
            },
          }),
        ];
      } finally {
        await page.evaluate((targetSelector) => {
          const target = document.querySelector(targetSelector);
          if (target) {
            const originalFilter = target.getAttribute('data-repair-original-filter');
            if (originalFilter != null) {
              if (originalFilter === '__EMPTY__') {
                target.style.removeProperty('filter');
              } else {
                target.style.filter = originalFilter;
              }
              target.removeAttribute('data-repair-original-filter');
            }
            target.style.removeProperty('will-change');
          }

          const focused = document.querySelectorAll('[data-repair-focus="1"]');
          for (const item of focused) item.removeAttribute('data-repair-focus');

          const styleTag = document.getElementById('repair-color-style');
          if (styleTag) styleTag.remove();
        }, focusSelector);
        await this.cleanup(page);
      }
    }, {
      viewport: context && context.viewport ? context.viewport : undefined,
    });

    return Array.isArray(variants) ? variants : [];
  }

  async _analyzePixels(page, pngBase64) {
    return page.evaluate(async (imageBase64) => {
      const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
      const fallback = {
        filter: 'contrast(1.12) saturate(1.1) brightness(0.94)',
        minLuma: 0,
        avgLuma: 128,
        maxLuma: 255,
        sampleCount: 0,
        contrast: 1.12,
        brightness: 0.94,
        saturate: 1.1,
      };

      if (!imageBase64) return fallback;

      const dataUrl = `data:image/png;base64,${imageBase64}`;
      const image = new Image();
      const loaded = await new Promise((resolve) => {
        image.onload = () => resolve(true);
        image.onerror = () => resolve(false);
        image.src = dataUrl;
      });

      if (!loaded) return fallback;

      const width = Math.max(1, image.naturalWidth || image.width || 1);
      const height = Math.max(1, image.naturalHeight || image.height || 1);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;

      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return fallback;

      ctx.drawImage(image, 0, 0, width, height);
      const imageData = ctx.getImageData(0, 0, width, height);
      const pixels = imageData.data;
      if (!pixels || pixels.length < 4) return fallback;

      const histogram = new Array(256).fill(0);
      const stride = 10;
      let sumLuma = 0;
      let sampleCount = 0;

      for (let y = 0; y < height; y += stride) {
        for (let x = 0; x < width; x += stride) {
          const index = (y * width + x) * 4;
          const alpha = pixels[index + 3];
          if (alpha <= 0) continue;

          const luma = (
            0.299 * pixels[index] +
            0.587 * pixels[index + 1] +
            0.114 * pixels[index + 2]
          );
          const bucket = clamp(Math.round(luma), 0, 255);
          histogram[bucket] += 1;
          sumLuma += luma;
          sampleCount += 1;
        }
      }

      if (sampleCount <= 0) return fallback;

      let minLuma = 0;
      while (minLuma < 255 && histogram[minLuma] === 0) minLuma += 1;

      let maxLuma = 255;
      while (maxLuma > 0 && histogram[maxLuma] === 0) maxLuma -= 1;

      const avgLuma = sumLuma / sampleCount;

      let contrast = 1.08;
      let brightness = avgLuma > 168 ? 0.94 : 0.98;

      if (minLuma > 10) {
        const normalizedMin = minLuma / 255;
        contrast = 1 + normalizedMin;
        brightness = 1 - (normalizedMin / 2);
      }

      if (avgLuma > 170) {
        brightness -= ((avgLuma - 170) / 255) * 0.18;
      } else if (avgLuma < 80) {
        brightness += ((80 - avgLuma) / 255) * 0.08;
      }

      contrast = clamp(contrast, 1.05, 1.38);
      brightness = clamp(brightness, 0.72, 1.03);
      const saturate = clamp(1.1 + ((128 - avgLuma) / 255) * 0.05, 1.02, 1.22);

      const filter = [
        `contrast(${contrast.toFixed(3)})`,
        `saturate(${saturate.toFixed(3)})`,
        `brightness(${brightness.toFixed(3)})`,
      ].join(' ');

      return {
        filter,
        minLuma: Number(minLuma.toFixed(2)),
        avgLuma: Number(avgLuma.toFixed(2)),
        maxLuma: Number(maxLuma.toFixed(2)),
        sampleCount,
        contrast: Number(contrast.toFixed(3)),
        brightness: Number(brightness.toFixed(3)),
        saturate: Number(saturate.toFixed(3)),
      };
    }, pngBase64);
  }

  async _captureWithFilter(page, selector, clip, filterValue, outputAbsolutePath) {
    const applied = await page.evaluate((targetSelector, filter) => {
      const target = document.querySelector(targetSelector);
      if (!target) return false;

      const originalInlineFilter = target.style.filter || '';
      target.setAttribute('data-repair-original-filter', originalInlineFilter || '__EMPTY__');
      target.style.filter = originalInlineFilter
        ? `${originalInlineFilter} ${filter}`.trim()
        : filter;
      target.style.willChange = 'filter';
      return true;
    }, selector, String(filterValue || '').trim());

    if (!applied) {
      throw new Error(`ColorCorrectionStrategy: failed to apply filter to ${selector}`);
    }

    try {
      await page.screenshot({
        path: outputAbsolutePath,
        clip,
        omitBackground: true,
        captureBeyondViewport: true,
      });
    } finally {
      await page.evaluate((targetSelector) => {
        const target = document.querySelector(targetSelector);
        if (!target) return;

        const originalFilter = target.getAttribute('data-repair-original-filter');
        if (originalFilter != null) {
          if (originalFilter === '__EMPTY__') {
            target.style.removeProperty('filter');
          } else {
            target.style.filter = originalFilter;
          }
          target.removeAttribute('data-repair-original-filter');
        }
        target.style.removeProperty('will-change');
      }, selector);
    }
  }

  _buildAutoDescription(analysis, manualOverride) {
    if (manualOverride) {
      return 'Auto-levels (manual colorFilter override)';
    }

    const contrastPct = Math.round((Number(analysis && analysis.contrast) - 1) * 100);
    const brightnessPct = Math.round((Number(analysis && analysis.brightness) - 1) * 100);
    const contrastLabel = `${contrastPct >= 0 ? '+' : ''}${contrastPct}%`;
    const brightnessLabel = `${brightnessPct >= 0 ? '+' : ''}${brightnessPct}%`;
    return `Auto-levels (Contrast: ${contrastLabel}, Bright: ${brightnessLabel})`;
  }

  _resolveManualFilter(request) {
    const manual = request && request.manualParams && typeof request.manualParams === 'object'
      ? request.manualParams
      : {};
    const primary = typeof manual.colorFilter === 'string'
      ? manual.colorFilter.trim()
      : '';
    const fallback = typeof manual.cssFilter === 'string'
      ? manual.cssFilter.trim()
      : '';
    const candidate = primary || fallback;
    return candidate || '';
  }

  _resolveHints(context) {
    const hints = context && context.captureHints && typeof context.captureHints === 'object'
      ? context.captureHints
      : {};
    return {
      sourceNodeId: hints.sourceNodeId || '',
      hideChildren: hints.hideChildren !== false,
      hideOwnText: hints.hideOwnText !== false,
      stripText: hints.stripText !== false,
      isolateNode: hints.isolateNode !== false,
    };
  }
}

module.exports = ColorCorrectionStrategy;
