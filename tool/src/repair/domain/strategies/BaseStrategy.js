const { RepairVariant } = require('../RepairResult');

const REPAIR_ISOLATION_STYLE_IDS = Object.freeze([
  'repair-isolation-style',
  'repair-inplace-style',
  'repair-color-style',
]);

/**
 * @typedef {Object} StrategyContext
 * @property {import('../../infra/BrowserSession')} browserSession
 * @property {import('../../infra/ImagePatcher')} imagePatcher
 * @property {Object<string, any>} [nodeContext]
 * @property {boolean} [dryRun]
 */

/**
 * @typedef {Object} IStrategy
 * @property {string} id
 * @property {string} displayName
 * @property {(request: import('../RepairRequest'), context: StrategyContext) => Promise<RepairVariant|RepairVariant[]|null>} run
 */

class BaseStrategy {
  constructor(id, displayName) {
    this.id = id;
    this.displayName = displayName;
  }

  /**
   * @param {import('../RepairRequest')} _request
   * @param {StrategyContext} _context
   * @returns {Promise<RepairVariant|RepairVariant[]|null>}
   */
  async run(_request, _context) {
    throw new Error(`${this.constructor.name}.run must be implemented.`);
  }

  /**
   * @param {Parameters<RepairVariant['constructor']>[0]} input
   * @returns {RepairVariant}
   */
  createVariant(input) {
    return new RepairVariant(input);
  }

  normalizeClip(clip) {
    if (!clip || typeof clip !== 'object') return null;
    const width = Number(clip.width);
    const height = Number(clip.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return null;
    }

    const x = Number.isFinite(Number(clip.x)) ? Number(clip.x) : 0;
    const y = Number.isFinite(Number(clip.y)) ? Number(clip.y) : 0;
    const clipX = Math.max(0, x);
    const clipY = Math.max(0, y);
    const clipWidth = Math.max(1, Math.round(width - (clipX - x)));
    const clipHeight = Math.max(1, Math.round(height - (clipY - y)));

    return {
      x: Math.round(clipX),
      y: Math.round(clipY),
      width: clipWidth,
      height: clipHeight,
    };
  }

  getNodeSelector(nodeId) {
    return `[data-bake-id="${String(nodeId || '').replace(/"/g, '\\"')}"]`;
  }

  async cleanup(page) {
    await page.evaluate(
      (styleIds) => {
        const cloneNodes = document.querySelectorAll('[data-repair-clone="1"]');
        for (const clone of cloneNodes) clone.remove();

        for (const id of styleIds) {
          const styleNode = document.getElementById(id);
          if (styleNode) styleNode.remove();
        }
      },
      REPAIR_ISOLATION_STYLE_IDS,
    );
  }
}

module.exports = BaseStrategy;
module.exports.REPAIR_ISOLATION_STYLE_IDS = REPAIR_ISOLATION_STYLE_IDS;
