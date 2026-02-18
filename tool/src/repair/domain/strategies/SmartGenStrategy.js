const BaseStrategy = require('./BaseStrategy');
const ForceCloneStrategy = require('./ForceCloneStrategy');
const ForceInPlaceStrategy = require('./ForceInPlaceStrategy');
const ExpandPaddingStrategy = require('./ExpandPaddingStrategy');
const ColorCorrectionStrategy = require('../../strategies/ColorCorrectionStrategy');

class SmartGenStrategy extends BaseStrategy {
  constructor(options = {}) {
    super('smart_generate', 'Smart Generation');
    this.forceCloneStrategy = options.forceCloneStrategy || new ForceCloneStrategy();
    this.expandPaddingStrategy = options.expandPaddingStrategy || new ExpandPaddingStrategy();
    this.forceInPlaceStrategy = options.forceInPlaceStrategy || new ForceInPlaceStrategy();
    this.colorCorrectionStrategy = options.colorCorrectionStrategy || new ColorCorrectionStrategy();
  }

  async run(request, context) {
    const colorTask = this.colorCorrectionStrategy.run(request, context).then((result) => (
      Array.isArray(result) ? result : (result ? [result] : [])
    ));

    const tasks = [
      this.forceCloneStrategy.run(request, context),
      this.expandPaddingStrategy.run(request, context),
      this.forceInPlaceStrategy.run(request, context),
      colorTask,
    ];

    const settled = await Promise.allSettled(tasks);
    const variants = [];
    const errors = [];

    for (const item of settled) {
      if (item.status === 'fulfilled' && item.value) {
        if (Array.isArray(item.value)) {
          variants.push(...item.value.filter(Boolean));
        } else {
          variants.push(item.value);
        }
      } else if (item.status === 'rejected') {
        const message = item.reason && item.reason.message
          ? item.reason.message
          : String(item.reason);
        errors.push(message);
      }
    }

    if (variants.length === 0) {
      throw new Error(
        `SmartGenStrategy failed for node ${request.targetNodeId}. ${errors.join(' | ')}`.trim(),
      );
    }

    return variants;
  }
}

module.exports = SmartGenStrategy;
