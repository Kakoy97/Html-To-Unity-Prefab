const BaseStrategy = require('./BaseStrategy');

class ForceCloneStrategy extends BaseStrategy {
  constructor() {
    super('variant_original', 'Original (Clone)');
  }

  async run(request, context) {
    const nodeId = request.targetNodeId;
    const hints = this._resolveHints(context);
    const selector = this.getNodeSelector(hints.sourceNodeId || nodeId);
    const output = await context.imagePatcher.allocateVariantPath(nodeId, 'orig');

    await context.browserSession.execute(request.htmlPath, async ({ page }) => {
      await this.cleanup(page);
      try {
        const capture = await page.evaluate((targetSelector, options) => {
          const removeStale = () => {
            const staleClones = document.querySelectorAll('[data-repair-clone="1"]');
            for (const stale of staleClones) stale.remove();
            const staleStyle = document.getElementById('repair-isolation-style');
            if (staleStyle) staleStyle.remove();
          };

          const stripTextTree = (root) => {
            if (!root) return;
            const walker = document.createTreeWalker(
              root,
              NodeFilter.SHOW_TEXT,
              null,
            );
            const textNodes = [];
            while (walker.nextNode()) {
              textNodes.push(walker.currentNode);
            }
            for (const textNode of textNodes) {
              if (!textNode || textNode.nodeType !== Node.TEXT_NODE) continue;
              textNode.textContent = '';
            }

            const controls = root.querySelectorAll('input, textarea, select');
            for (const control of controls) {
              if (!control) continue;
              if ('value' in control) {
                try {
                  control.value = '';
                } catch (_) {
                  // ignore readonly/runtime controls
                }
              }
              if (control.hasAttribute('value')) control.setAttribute('value', '');
              if (control.hasAttribute('placeholder')) control.setAttribute('placeholder', '');
              control.style.color = 'transparent';
              control.style.webkitTextFillColor = 'transparent';
              control.style.textShadow = 'none';
              control.style.caretColor = 'transparent';
            }
          };

          const hideDirectText = (root) => {
            if (!root || !root.childNodes) return;
            for (const child of Array.from(root.childNodes)) {
              if (!child || child.nodeType !== Node.TEXT_NODE) continue;
              child.textContent = '';
            }
          };

          removeStale();
          const target = document.querySelector(targetSelector);
          if (!target) return null;
          const rect = target.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return null;

          const clone = target.cloneNode(true);
          clone.setAttribute('data-repair-clone', '1');
          clone.style.position = 'fixed';
          clone.style.left = '0px';
          clone.style.top = '0px';
          clone.style.margin = '0';
          clone.style.transform = 'none';
          clone.style.transformOrigin = '0 0';
          clone.style.width = `${rect.width}px`;
          clone.style.height = `${rect.height}px`;
          clone.style.zIndex = '2147483647';

          if (options.hideChildren) {
            clone.innerHTML = '';
          } else if (options.stripText) {
            if (options.hideOwnText) {
              hideDirectText(clone);
            }
            stripTextTree(clone);
          }

          document.body.appendChild(clone);

          const styleTag = document.createElement('style');
          styleTag.id = 'repair-isolation-style';
          styleTag.innerHTML = options.isolateNode
            ? [
                'html, body {',
                '  background: transparent !important;',
                '  background-color: transparent !important;',
                '  background-image: none !important;',
                '}',
                'html::before, html::after, body::before, body::after {',
                '  content: none !important;',
                '  display: none !important;',
                '}',
                'body > *:not([data-repair-clone="1"]) {',
                '  visibility: hidden !important;',
                '}',
              ].join('\n')
            : [
                '*, *::before, *::after {',
                '  transition-property: none !important;',
                '  transition-duration: 0s !important;',
                '  transition-delay: 0s !important;',
                '  animation: none !important;',
                '}',
              ].join('\n');
          document.head.appendChild(styleTag);

          return {
            clip: {
              x: 0,
              y: 0,
              width: Math.max(1, Math.ceil(rect.width)),
              height: Math.max(1, Math.ceil(rect.height)),
            },
          };
        }, selector, {
          hideChildren: !!hints.hideChildren,
          hideOwnText: !!hints.hideOwnText,
          stripText: !!hints.stripText,
          isolateNode: !!hints.isolateNode,
        });

        if (!capture || !capture.clip) {
          throw new Error(`ForceCloneStrategy: target not found for ${nodeId}`);
        }

        const clip = this.normalizeClip(capture.clip);
        if (!clip) {
          throw new Error(`ForceCloneStrategy: invalid clip for ${nodeId}`);
        }

        await page.screenshot({
          path: output.absolutePath,
          clip,
          omitBackground: true,
          captureBeyondViewport: true,
        });
      } finally {
        await this.cleanup(page);
      }
    }, {
      viewport: context && context.viewport ? context.viewport : undefined,
    });

    return this.createVariant({
      id: this.id,
      name: this.displayName,
      imagePath: output.relativePath,
      description: 'Original strategy (clone + strip text)',
      metadata: {
        strategy: 'FORCE_CLONE',
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

module.exports = ForceCloneStrategy;
