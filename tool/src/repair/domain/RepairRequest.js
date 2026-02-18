const path = require('path');

const REPAIR_MODES = Object.freeze({
  SMART_GENERATE: 'SMART_GENERATE',
  MANUAL: 'MANUAL',
});

/**
 * @typedef {"SMART_GENERATE" | "MANUAL"} RepairMode
 */

/**
 * @typedef {Object} RepairManualParams
 * @property {string} [strategy]
 * @property {string} [colorFilter]
 * @property {string} [cssFilter]
 */

/**
 * @typedef {Object} RepairRequestInput
 * @property {string} targetNodeId
 * @property {string} htmlPath
 * @property {RepairMode} mode
 * @property {string} [strategy]
 * @property {RepairManualParams & Object<string, any>} [manualParams]
 * @property {boolean} [dryRun]
 */

class RepairRequest {
  /**
   * @param {RepairRequestInput} input
   */
  constructor(input) {
    const payload = input || {};
    this.targetNodeId = String(payload.targetNodeId || '').trim();
    this.htmlPath = String(payload.htmlPath || '').trim();
    this.mode = String(payload.mode || REPAIR_MODES.SMART_GENERATE).trim().toUpperCase();
    this.manualParams = payload.manualParams && typeof payload.manualParams === 'object'
      ? payload.manualParams
      : {};
    if (payload.strategy && !this.manualParams.strategy) {
      this.manualParams.strategy = String(payload.strategy).trim();
    }
    this.dryRun = typeof payload.dryRun === 'boolean'
      ? payload.dryRun
      : this.mode === REPAIR_MODES.SMART_GENERATE;

    this._validate();
    this.htmlPath = path.resolve(this.htmlPath);
  }

  /**
   * @param {RepairRequestInput} input
   * @returns {RepairRequest}
   */
  static from(input) {
    return new RepairRequest(input);
  }

  toJSON() {
    return {
      targetNodeId: this.targetNodeId,
      htmlPath: this.htmlPath,
      mode: this.mode,
      manualParams: this.manualParams,
      dryRun: this.dryRun,
    };
  }

  _validate() {
    if (!this.targetNodeId) {
      throw new Error('RepairRequest.targetNodeId is required.');
    }
    if (!this.htmlPath) {
      throw new Error('RepairRequest.htmlPath is required.');
    }
    if (!Object.values(REPAIR_MODES).includes(this.mode)) {
      throw new Error(
        `RepairRequest.mode must be one of ${Object.values(REPAIR_MODES).join(', ')}.`,
      );
    }
  }
}

module.exports = RepairRequest;
module.exports.REPAIR_MODES = REPAIR_MODES;
