const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

class AsyncMutex {
  constructor() {
    this._locked = false;
    this._waiters = [];
  }

  async acquire() {
    if (!this._locked) {
      this._locked = true;
      return () => this._release();
    }

    return new Promise((resolve) => {
      this._waiters.push(resolve);
    });
  }

  async runExclusive(callback) {
    const release = await this.acquire();
    try {
      return await callback();
    } finally {
      release();
    }
  }

  _release() {
    const next = this._waiters.shift();
    if (next) {
      next(() => this._release());
      return;
    }
    this._locked = false;
  }
}

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function resolvePuppeteer() {
  try {
    return require('puppeteer');
  } catch (_) {
    return require(path.resolve(__dirname, '../../../UIBaker/node_modules/puppeteer'));
  }
}

class BrowserSession {
  static getInstance(options = {}) {
    if (!BrowserSession._singleton) {
      BrowserSession._singleton = new BrowserSession(options);
    }
    return BrowserSession._singleton;
  }

  constructor(options = {}) {
    this.options = {
      headless: options.headless !== false,
      navigationTimeoutMs: toPositiveInt(options.navigationTimeoutMs, 30000),
      viewport: options.viewport || {
        width: 750,
        height: 1624,
        deviceScaleFactor: 2,
      },
    };

    this._puppeteer = null;
    this._browser = null;
    this._page = null;
    this._currentUrl = '';
    this._currentViewport = null;

    this._sessionMutex = new AsyncMutex();
    this._pageMutex = new AsyncMutex();
  }

  /**
   * Executes Puppeteer operations in a page-level mutex to keep concurrent
   * screenshot calls safe while still allowing call sites to request parallel work.
   *
   * @param {string} htmlPath
   * @param {(context: { page: import('puppeteer').Page, reused: boolean, currentUrl: string, htmlPath: string }) => Promise<any>} callback
   * @param {{ viewport?: { width: number, height: number, deviceScaleFactor?: number }, navigationTimeoutMs?: number }} [options]
   * @returns {Promise<any>}
   */
  async execute(htmlPath, callback, options = {}) {
    if (!htmlPath) throw new Error('BrowserSession.execute requires htmlPath.');
    if (typeof callback !== 'function') throw new Error('BrowserSession.execute requires callback.');

    return this._pageMutex.runExclusive(async () => {
      const prepared = await this._ensureReady(htmlPath, options);
      return callback({
        page: this._page,
        reused: prepared.reused,
        currentUrl: prepared.currentUrl,
        htmlPath: prepared.htmlPath,
      });
    });
  }

  async close() {
    await this._sessionMutex.runExclusive(async () => {
      if (this._page) {
        try {
          await this._page.close();
        } catch (_) {
          // browser close is fallback.
        }
        this._page = null;
      }
      if (this._browser) {
        await this._browser.close();
        this._browser = null;
      }
      this._currentUrl = '';
      this._currentViewport = null;
    });
  }

  async _ensureReady(htmlPath, options) {
    return this._sessionMutex.runExclusive(async () => {
      const resolvedHtmlPath = path.resolve(String(htmlPath || '').trim());
      if (!fs.existsSync(resolvedHtmlPath)) {
        throw new Error(`HTML not found: ${resolvedHtmlPath}`);
      }

      await this._ensureBrowser();
      await this._ensureViewport(options && options.viewport);

      const targetUrl = pathToFileURL(resolvedHtmlPath).href;
      const navigationTimeoutMs = toPositiveInt(
        options && options.navigationTimeoutMs,
        this.options.navigationTimeoutMs,
      );

      if (this._currentUrl === targetUrl) {
        return {
          reused: true,
          currentUrl: this._currentUrl,
          htmlPath: resolvedHtmlPath,
        };
      }

      await this._page.goto(targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: navigationTimeoutMs,
      });
      this._currentUrl = targetUrl;

      return {
        reused: false,
        currentUrl: this._currentUrl,
        htmlPath: resolvedHtmlPath,
      };
    });
  }

  async _ensureBrowser() {
    if (this._browser && this._page) return;

    this._puppeteer = this._puppeteer || resolvePuppeteer();
    this._browser = await this._puppeteer.launch({
      headless: this.options.headless,
    });
    this._page = await this._browser.newPage();
  }

  async _ensureViewport(viewportOption) {
    const viewport = this._normalizeViewport(viewportOption || this.options.viewport);
    const current = this._currentViewport || {};
    const changed = (
      current.width !== viewport.width ||
      current.height !== viewport.height ||
      current.deviceScaleFactor !== viewport.deviceScaleFactor
    );
    if (!changed) return;

    await this._page.setViewport(viewport);
    this._currentViewport = viewport;
  }

  _normalizeViewport(viewport) {
    const source = viewport || {};
    return {
      width: toPositiveInt(source.width, 750),
      height: toPositiveInt(source.height, 1624),
      deviceScaleFactor: Number.isFinite(Number(source.deviceScaleFactor))
        ? Math.max(0.5, Number(source.deviceScaleFactor))
        : 2,
    };
  }
}

module.exports = BrowserSession;
