const path = require('path');

function coerceValue(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

function parseArgv(argv) {
  const args = { _: [] };
  const input = Array.isArray(argv) ? argv : [];

  for (let i = 0; i < input.length; i += 1) {
    const token = input[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }

    const body = token.slice(2);
    const eqIndex = body.indexOf('=');
    if (eqIndex >= 0) {
      const key = body.slice(0, eqIndex);
      const value = body.slice(eqIndex + 1);
      args[key] = coerceValue(value);
      continue;
    }

    const next = input[i + 1];
    if (typeof next === 'string' && !next.startsWith('--')) {
      args[body] = coerceValue(next);
      i += 1;
      continue;
    }

    args[body] = true;
  }

  return args;
}

function toPositiveNumber(value, fallback) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function roundForDisplay(value) {
  return Number(value.toFixed(2));
}

function buildResolutionConfig(args) {
  const targetWidth = Math.round(toPositiveNumber(args.width, 750));
  const targetHeight = Math.round(toPositiveNumber(args.height, 1624));
  const baseWidth = toPositiveNumber(args['base-width'], 375);
  const userDpr = toPositiveNumber(args.dpr, NaN);
  const rootSelectorRaw = args['root-selector'] || args.root || 'auto';
  const rootSelector = String(rootSelectorRaw || 'auto').trim() || 'auto';
  const outputDirArg = args['output-dir'] || args.output || 'output';
  const outputDir = path.isAbsolute(outputDirArg)
    ? outputDirArg
    : path.resolve(process.cwd(), outputDirArg);

  let mode = 'logical';
  let dpr = 2.0;
  let logicalWidth = targetWidth;
  let logicalHeight = targetHeight;

  if (targetWidth > 500) {
    mode = 'physical';
    dpr = roundForDisplay(targetWidth / baseWidth);
    logicalWidth = baseWidth;
    logicalHeight = targetHeight / dpr;
  } else {
    dpr = Number.isFinite(userDpr) ? userDpr : 2.0;
    logicalWidth = targetWidth;
    logicalHeight = targetHeight;
  }

  const viewportWidth = Math.max(1, Math.round(logicalWidth));
  const viewportHeight = Math.max(1, Math.round(logicalHeight));

  const dprRounded = roundForDisplay(dpr);

  return {
    mode,
    targetWidth,
    targetHeight,
    baseWidth: roundForDisplay(baseWidth),
    dpr: dprRounded,
    rootSelector,
    outputDir,
    logicalWidth: viewportWidth,
    logicalHeight: viewportHeight,
    logicalWidthExact: roundForDisplay(logicalWidth),
    logicalHeightExact: roundForDisplay(logicalHeight),
    viewport: {
      width: viewportWidth,
      height: viewportHeight,
      deviceScaleFactor: dprRounded,
    },
  };
}

function resolvePuppeteer() {
  try {
    return require('puppeteer');
  } catch (error) {
    const fallback = path.resolve(__dirname, '../../UIBaker/node_modules/puppeteer');
    try {
      return require(fallback);
    } catch (fallbackError) {
      const message = [
        'Failed to load `puppeteer`.',
        'Tried default module resolution and fallback path:',
        fallback,
      ].join(' ');
      fallbackError.message = `${message}\n${fallbackError.message}`;
      throw fallbackError;
    }
  }
}

class Context {
  constructor(argv = []) {
    this.argv = Array.isArray(argv) ? argv : [];
    this.args = parseArgv(this.argv);
    this.config = buildResolutionConfig(this.args);
    this.browser = null;
    this.page = null;
    this._puppeteer = null;
  }

  async launch() {
    if (this.browser && this.page) {
      return { browser: this.browser, page: this.page, config: this.config };
    }

    this._puppeteer = this._puppeteer || resolvePuppeteer();
    this.browser = await this._puppeteer.launch({
      headless: this.args.headless !== false,
    });

    this.page = await this.browser.newPage();
    await this.page.setViewport({
      width: this.config.logicalWidth,
      height: this.config.logicalHeight,
      deviceScaleFactor: this.config.dpr,
    });

    return { browser: this.browser, page: this.page, config: this.config };
  }

  async close() {
    if (this.page) {
      try {
        await this.page.close();
      } catch (_) {
        // Browser close will clean the page as fallback.
      }
      this.page = null;
    }

    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}

module.exports = Context;
module.exports.parseArgv = parseArgv;
module.exports.buildResolutionConfig = buildResolutionConfig;
