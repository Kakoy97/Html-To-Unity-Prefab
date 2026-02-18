/**
 * @typedef {Object} RepairVariantInput
 * @property {string} id
 * @property {string} name
 * @property {string} imagePath
 * @property {string} description
 * @property {Object<string, any>} [metadata]
 */

class RepairVariant {
  /**
   * @param {RepairVariantInput} input
   */
  constructor(input) {
    const payload = input || {};
    this.id = String(payload.id || '').trim();
    this.name = String(payload.name || '').trim();
    this.imagePath = String(payload.imagePath || '').replace(/\\/g, '/');
    this.description = String(payload.description || '').trim();
    this.metadata = payload.metadata && typeof payload.metadata === 'object'
      ? payload.metadata
      : undefined;

    if (!this.id) throw new Error('RepairVariant.id is required.');
    if (!this.name) throw new Error('RepairVariant.name is required.');
    if (!this.imagePath) throw new Error('RepairVariant.imagePath is required.');
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      imagePath: this.imagePath,
      description: this.description,
      ...(this.metadata ? { metadata: this.metadata } : {}),
    };
  }
}

class RepairResult {
  /**
   * @param {{ nodeId: string, variants?: Array<RepairVariantInput|RepairVariant> }} input
   */
  constructor(input) {
    const payload = input || {};
    this.nodeId = String(payload.nodeId || '').trim();
    this.variants = [];

    if (!this.nodeId) {
      throw new Error('RepairResult.nodeId is required.');
    }

    const variants = Array.isArray(payload.variants) ? payload.variants : [];
    for (const variant of variants) {
      this.addVariant(variant);
    }
  }

  /**
   * @param {RepairVariantInput|RepairVariant} variant
   */
  addVariant(variant) {
    if (!variant) return;
    if (variant instanceof RepairVariant) {
      this.variants.push(variant);
      return;
    }
    this.variants.push(new RepairVariant(variant));
  }

  toJSON() {
    return {
      nodeId: this.nodeId,
      variants: this.variants.map((item) => item.toJSON()),
    };
  }
}

module.exports = RepairResult;
module.exports.RepairVariant = RepairVariant;
