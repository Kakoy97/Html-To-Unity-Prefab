const BaseStrategy = require('./BaseStrategy');

class ForceInPlaceStrategy extends BaseStrategy {
  constructor() {
    super('variant_inplace', 'Force Context');
  }

  async run(request, context) {
    const nodeId = request.targetNodeId;
    const hints = this._resolveHints(context);
    const primarySelector = this.getNodeSelector(nodeId);
    const fallbackSelector = (
      hints.sourceNodeId && String(hints.sourceNodeId) !== String(nodeId)
    ) ? this.getNodeSelector(hints.sourceNodeId) : '';
    const output = await context.imagePatcher.allocateVariantPath(nodeId, 'context');
    const manualPadding = Number(request.manualParams && request.manualParams.contextPadding);
    const extraPadding = Number.isFinite(manualPadding) ? Math.max(0, manualPadding) : 0;

    await context.browserSession.execute(request.htmlPath, async ({ page }) => {
      await this.cleanup(page);
      try {
        const capture = await page.evaluate((targetPrimarySelector, targetFallbackSelector, options) => {
          const removeStale = () => {
            const staleStyle = document.getElementById('repair-inplace-style');
            if (staleStyle) staleStyle.remove();
            const staleFocused = document.querySelectorAll('[data-repair-focus="1"]');
            for (const item of staleFocused) item.removeAttribute('data-repair-focus');
          };

          removeStale();
          const target = document.querySelector(targetPrimarySelector)
            || (targetFallbackSelector ? document.querySelector(targetFallbackSelector) : null);
          if (!target) return null;
          target.setAttribute('data-repair-focus', '1');
          const focusSelector = '[data-repair-focus="1"]';

          const rect = target.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return null;

          const styleTag = document.createElement('style');
          styleTag.id = 'repair-inplace-style';
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
                `${focusSelector} { visibility: visible !important; }`,
                `${focusSelector} * { visibility: hidden !important; }`,
              );
            } else {
              rules.push(`${focusSelector}, ${focusSelector} * { visibility: visible !important; }`);
            }
          }

          if (!options.isolateNode && options.hideChildren) {
            rules.push(`${focusSelector} * { visibility: hidden !important; }`);
          }

          if (options.stripText) {
            const textScope = options.hideOwnText
              ? `${focusSelector}, ${focusSelector} *`
              : `${focusSelector} *`;
            rules.push(
              `${textScope} {`,
              '  color: transparent !important;',
              '  -webkit-text-fill-color: transparent !important;',
              '  text-shadow: none !important;',
              '  caret-color: transparent !important;',
              '}',
              `${focusSelector} input, ${focusSelector} textarea, ${focusSelector} select {`,
              '  color: transparent !important;',
              '  -webkit-text-fill-color: transparent !important;',
              '}',
            );
          }

          styleTag.innerHTML = rules.join('\n');
          document.head.appendChild(styleTag);

          const parseBoxShadowPad = (boxShadow) => {
            if (!boxShadow || boxShadow === 'none') return 0;
            const values = String(boxShadow).match(/-?\d*\.?\d+px/g) || [];
            const nums = values.map((value) => Number.parseFloat(value)).filter(Number.isFinite);
            const offsetX = nums[0] || 0;
            const offsetY = nums[1] || 0;
            const blur = nums[2] || 0;
            const spread = nums[3] || 0;
            return Math.max(Math.abs(offsetX), Math.abs(offsetY)) + blur + spread;
          };

          const parseBlurPad = (filterValue) => {
            if (!filterValue || filterValue === 'none') return 0;
            const blurMatch = String(filterValue).match(/blur\(([^)]+)\)/i);
            if (!blurMatch) return 0;
            const pxMatch = String(blurMatch[1]).match(/-?\d*\.?\d+/);
            if (!pxMatch) return 0;
            const blur = Number.parseFloat(pxMatch[0]);
            return Number.isFinite(blur) ? Math.abs(blur) * 2 : 0;
          };

          const style = window.getComputedStyle(target);
          const shadowPad = Math.max(
            parseBoxShadowPad(style.boxShadow),
            parseBlurPad(style.filter),
          );
          const padding = Math.max(0, shadowPad + Number(options.extraPadding || 0));
          const finalRect = target.getBoundingClientRect();

          return {
            clip: {
              x: finalRect.left - padding,
              y: finalRect.top - padding,
              width: finalRect.width + padding * 2,
              height: finalRect.height + padding * 2,
            },
            metadata: {
              padding,
              mode: 'inPlace',
            },
          };
        }, primarySelector, fallbackSelector, {
          extraPadding,
          hideChildren: !!hints.hideChildren,
          hideOwnText: !!hints.hideOwnText,
          stripText: !!hints.stripText,
          isolateNode: !!hints.isolateNode,
        });

        if (!capture || !capture.clip) {
          throw new Error(`ForceInPlaceStrategy: target not found for ${nodeId}`);
        }

        const clip = this.normalizeClip(capture.clip);
        if (!clip) {
          throw new Error(`ForceInPlaceStrategy: invalid clip for ${nodeId}`);
        }

        await page.screenshot({
          path: output.absolutePath,
          clip,
          omitBackground: true,
          captureBeyondViewport: true,
        });
      } finally {
        await page.evaluate(() => {
          const focused = document.querySelectorAll('[data-repair-focus="1"]');
          for (const item of focused) item.removeAttribute('data-repair-focus');
        });
        await this.cleanup(page);
      }
    }, {
      viewport: context && context.viewport ? context.viewport : undefined,
    });

    return this.createVariant({
      id: this.id,
      name: this.displayName,
      imagePath: output.relativePath,
      description: 'In-place capture with isolated node context',
      metadata: {
        strategy: 'FORCE_IN_PLACE',
      },
    });
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

module.exports = ForceInPlaceStrategy;
