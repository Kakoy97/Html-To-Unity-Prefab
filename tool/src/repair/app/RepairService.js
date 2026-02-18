const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');

const RepairRequest = require('../domain/RepairRequest');
const { REPAIR_MODES } = require('../domain/RepairRequest');
const { buildResolutionConfig } = require('../../core/Context');
const RepairResult = require('../domain/RepairResult');
const SmartGenStrategy = require('../domain/strategies/SmartGenStrategy');
const ForceCloneStrategy = require('../domain/strategies/ForceCloneStrategy');
const ForceInPlaceStrategy = require('../domain/strategies/ForceInPlaceStrategy');
const ExpandPaddingStrategy = require('../domain/strategies/ExpandPaddingStrategy');
const ColorCorrectionStrategy = require('../strategies/ColorCorrectionStrategy');
const BrowserSession = require('../infra/BrowserSession');
const ImagePatcher = require('../infra/ImagePatcher');

function sanitizeName(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return 'HtmlBaked';
  return normalized.replace(/[<>:"/\\|?*\x00-\x1F]+/g, '_');
}

class RepairService {
  constructor(options = {}) {
    this.browserSession = options.browserSession || BrowserSession.getInstance(options.browserOptions);
    this.imagePatcher = options.imagePatcher || new ImagePatcher(options.imagePatcherOptions);

    this.forceCloneStrategy = options.forceCloneStrategy || new ForceCloneStrategy();
    this.forceInPlaceStrategy = options.forceInPlaceStrategy || new ForceInPlaceStrategy();
    this.expandPaddingStrategy = options.expandPaddingStrategy || new ExpandPaddingStrategy();
    this.colorCorrectionStrategy = options.colorCorrectionStrategy || new ColorCorrectionStrategy();
    this.smartGenStrategy = options.smartGenStrategy || new SmartGenStrategy({
      forceCloneStrategy: this.forceCloneStrategy,
      forceInPlaceStrategy: this.forceInPlaceStrategy,
      expandPaddingStrategy: this.expandPaddingStrategy,
      colorCorrectionStrategy: this.colorCorrectionStrategy,
    });
  }

  /**
   * @param {import('../domain/RepairRequest').RepairRequestInput} input
   * @returns {Promise<{ nodeId: string, variants: Array<{ id: string, name: string, imagePath: string, description: string, metadata?: Object<string, any> }> }>}
   */
  async run(input) {
    const request = RepairRequest.from(input);
    const nodeContext = await this._resolveNodeContext(request);
    this._tryAlignRequestHtmlPath(request, nodeContext);
    const resolutionConfig = this._resolveResolutionConfig(request, nodeContext);
    const captureHints = this._resolveCaptureHints(request, nodeContext);

    await this._ensureNodeMarker(request, nodeContext, resolutionConfig);

    const strategyContext = {
      browserSession: this.browserSession,
      imagePatcher: this.imagePatcher,
      nodeContext,
      captureHints,
      viewport: resolutionConfig.viewport,
      resolutionConfig,
      dryRun: request.dryRun,
    };

    let strategyResult = null;
    if (request.mode === REPAIR_MODES.SMART_GENERATE) {
      strategyResult = await this.smartGenStrategy.run(request, strategyContext);
    } else {
      strategyResult = await this._runManual(request, strategyContext);
    }

    const variants = Array.isArray(strategyResult) ? strategyResult : [strategyResult];
    const result = new RepairResult({
      nodeId: request.targetNodeId,
      variants: variants.filter(Boolean),
    });
    return result.toJSON();
  }

  async close() {
    await this.browserSession.close();
  }

  async _runManual(request, context) {
    const strategyKey = String(
      request.manualParams && request.manualParams.strategy
        ? request.manualParams.strategy
        : 'FORCE_CLONE',
    ).trim().toUpperCase();

    if (strategyKey === 'FORCE_IN_PLACE') {
      return this.forceInPlaceStrategy.run(request, context);
    }
    if (strategyKey === 'EXPAND_PADDING') {
      return this.expandPaddingStrategy.run(request, context);
    }
    if (strategyKey === 'COLOR_CORRECTION') {
      return this.colorCorrectionStrategy.run(request, context);
    }
    if (strategyKey === 'SMART_GENERATE') {
      return this.smartGenStrategy.run(request, context);
    }
    return this.forceCloneStrategy.run(request, context);
  }

  async _resolveNodeContext(request) {
    const analysisTreePath = this._resolveAnalysisTreePath(request);
    const context = {
      analysisTreePath: analysisTreePath || '',
      matchedAnalysisTreePath: '',
      matchedHtmlName: '',
      node: null,
      domPath: '',
      ancestorChain: [],
      captureTaskParams: null,
    };

    if (analysisTreePath && fs.existsSync(analysisTreePath)) {
      const raw = await fsPromises.readFile(analysisTreePath, 'utf8');
      const root = JSON.parse(raw);
      const resolved = this._findNodeById(root, request.targetNodeId, []);
      if (resolved) {
        context.node = resolved.node;
        context.domPath = resolved.node && resolved.node.domPath ? resolved.node.domPath : '';
        context.ancestorChain = Array.isArray(resolved.ancestorChain) ? resolved.ancestorChain : [];
        context.matchedAnalysisTreePath = analysisTreePath;
        context.matchedHtmlName = this._extractHtmlNameFromAnalysisPath(analysisTreePath);
      }
    }

    if (!context.node) {
      const fallback = await this._findNodeInAnyAnalysisTree(request.targetNodeId, analysisTreePath);
      if (fallback) {
        context.analysisTreePath = fallback.analysisTreePath;
        context.matchedAnalysisTreePath = fallback.analysisTreePath;
        context.matchedHtmlName = fallback.htmlName;
        context.node = fallback.node;
        context.domPath = fallback.node && fallback.node.domPath ? fallback.node.domPath : '';
        context.ancestorChain = Array.isArray(fallback.ancestorChain) ? fallback.ancestorChain : [];
      }
    }

    const bakePlanPath = this._resolveBakePlanPath(request, context.analysisTreePath);
    if (bakePlanPath && fs.existsSync(bakePlanPath)) {
      try {
        const rawPlan = await fsPromises.readFile(bakePlanPath, 'utf8');
        const plan = JSON.parse(rawPlan);
        const captureTask = this._findCaptureTaskByNodeId(plan, request.targetNodeId);
        if (captureTask && captureTask.params && typeof captureTask.params === 'object') {
          context.captureTaskParams = captureTask.params;
        }
      } catch (_) {
        // Ignore malformed/debug-incomplete plan files and fallback to heuristics.
      }
    }

    return context;
  }

  async _ensureNodeMarker(request, nodeContext, resolutionConfig) {
    const manualDomPath = request && request.manualParams ? String(request.manualParams.domPath || '') : '';
    const domPath = nodeContext && nodeContext.domPath
      ? String(nodeContext.domPath)
      : manualDomPath;
    const sourceNodeId = this._resolveSourceNodeId(request, nodeContext);
    await this.browserSession.execute(request.htmlPath, async ({ page }) => {
      const found = await page.evaluate((nodeId, nodeDomPath) => {
        const selector = `[data-bake-id="${String(nodeId || '').replace(/"/g, '\\"')}"]`;
        let target = document.querySelector(selector);
        if (target) return true;

        if (nodeDomPath) {
          try {
            target = document.querySelector(nodeDomPath);
          } catch (_) {
            target = null;
          }
        }

        if (!target) return false;
        target.setAttribute('data-bake-id', String(nodeId));
        return true;
      }, sourceNodeId, domPath);

      if (!found) {
        const hint = this._buildLocateHint(request, nodeContext, domPath, manualDomPath);
        throw new Error(
          `RepairService: unable to locate node '${request.targetNodeId}' in current HTML.${hint ? ` ${hint}` : ''}`,
        );
      }
    }, {
      viewport: resolutionConfig && resolutionConfig.viewport ? resolutionConfig.viewport : undefined,
    });
  }

  _resolveResolutionConfig(request, nodeContext) {
    const manual = request && request.manualParams && typeof request.manualParams === 'object'
      ? request.manualParams
      : {};
    const width = this._toPositiveInt(manual.width || manual.targetWidth, 750);
    const height = this._toPositiveInt(manual.height || manual.targetHeight, 1624);
    const baseWidth = this._toPositiveNumber(manual.baseWidth, 375);
    const dpr = this._toPositiveNumber(manual.dpr, NaN);

    const config = buildResolutionConfig({
      width,
      height,
      'base-width': baseWidth,
      ...(Number.isFinite(dpr) ? { dpr } : {}),
    });

    if (nodeContext && nodeContext.captureTaskParams && Number.isFinite(Number(nodeContext.captureTaskParams.renderOpacity))) {
      config.renderOpacity = Number(nodeContext.captureTaskParams.renderOpacity);
    }
    return config;
  }

  _resolveCaptureHints(request, nodeContext) {
    const manual = request && request.manualParams && typeof request.manualParams === 'object'
      ? request.manualParams
      : {};
    const taskParams = nodeContext && nodeContext.captureTaskParams && typeof nodeContext.captureTaskParams === 'object'
      ? nodeContext.captureTaskParams
      : {};
    const node = nodeContext && nodeContext.node && typeof nodeContext.node === 'object'
      ? nodeContext.node
      : null;
    const nodeType = String(
      manual.nodeType ||
      (node && node.type) ||
      '',
    ).trim();

    const manualHideChildren = this._parseOptionalBoolean(manual.hideChildren);
    const manualHideOwnText = this._parseOptionalBoolean(manual.hideOwnText);
    const hideChildren = manualHideChildren != null
      ? manualHideChildren
      : (typeof taskParams.hideChildren === 'boolean'
        ? taskParams.hideChildren
        : (nodeType.toLowerCase() !== 'text'));
    const hideOwnText = manualHideOwnText != null
      ? manualHideOwnText
      : (typeof taskParams.hideOwnText === 'boolean' ? taskParams.hideOwnText : true);
    const stripText = this._toBoolean(manual.stripText, true);
    const isolateNode = this._toBoolean(manual.isolateNode, true);

    return {
      hideChildren,
      hideOwnText,
      stripText,
      isolateNode,
      nodeType,
      mode: String(taskParams.mode || '').trim(),
      rangePart: String(taskParams.rangePart || '').trim(),
      sourceNodeId: this._resolveSourceNodeId(request, nodeContext),
      renderOpacity: this._toPositiveNumber(taskParams.renderOpacity, 1),
    };
  }

  _resolveSourceNodeId(request, nodeContext) {
    const taskParams = nodeContext && nodeContext.captureTaskParams ? nodeContext.captureTaskParams : null;
    if (taskParams && taskParams.captureSourceNodeId) {
      return String(taskParams.captureSourceNodeId);
    }
    return String(request.targetNodeId || '');
  }

  _resolveBakePlanPath(request, analysisTreePath) {
    const manualPath = request.manualParams && request.manualParams.bakePlanPath
      ? path.resolve(String(request.manualParams.bakePlanPath))
      : '';
    if (manualPath && fs.existsSync(manualPath)) {
      return manualPath;
    }

    const htmlName = sanitizeName(path.basename(request.htmlPath, path.extname(request.htmlPath)));
    const root = this.imagePatcher.workspaceRoot;
    const fromAnalysis = analysisTreePath
      ? path.join(path.dirname(analysisTreePath), 'bake_plan.json')
      : '';
    const candidates = [
      fromAnalysis,
      path.join(root, 'Temp', 'HtmlToPrefab', htmlName, 'output', 'debug', 'bake_plan.json'),
      path.join(root, 'tool', 'UIBaker', 'output', 'debug', 'bake_plan.json'),
      path.join(root, 'output', 'debug', 'bake_plan.json'),
      path.join(process.cwd(), 'output', 'debug', 'bake_plan.json'),
    ].filter(Boolean);

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return '';
  }

  _findCaptureTaskByNodeId(plan, nodeId) {
    const tasks = Array.isArray(plan) ? plan : [];
    for (const task of tasks) {
      if (!task || task.type !== 'CAPTURE_NODE') continue;
      const taskNodeId = (task.params && task.params.nodeId) || task.nodeId;
      if (String(taskNodeId || '') === String(nodeId || '')) return task;
    }
    return null;
  }

  async _findNodeInAnyAnalysisTree(nodeId, excludeAnalysisPath = '') {
    const root = this.imagePatcher.workspaceRoot;
    const tempRoot = path.join(root, 'Temp', 'HtmlToPrefab');
    if (!fs.existsSync(tempRoot)) {
      return null;
    }

    const excluded = excludeAnalysisPath ? path.resolve(excludeAnalysisPath) : '';
    let entries = [];
    try {
      entries = await fsPromises.readdir(tempRoot, { withFileTypes: true });
    } catch (_) {
      return null;
    }

    for (const entry of entries) {
      if (!entry || !entry.isDirectory()) continue;
      if (String(entry.name || '').toLowerCase() === 'repair') continue;

      const analysisPath = path.join(tempRoot, entry.name, 'output', 'debug', 'analysis_tree.json');
      if (!fs.existsSync(analysisPath)) continue;
      if (excluded && path.resolve(analysisPath) === excluded) continue;

      try {
        const raw = await fsPromises.readFile(analysisPath, 'utf8');
        if (!raw || !raw.includes(String(nodeId || ''))) continue;

        const tree = JSON.parse(raw);
        const matched = this._findNodeById(tree, nodeId, []);
        if (!matched) continue;

        return {
          analysisTreePath: analysisPath,
          htmlName: entry.name,
          node: matched.node,
          ancestorChain: matched.ancestorChain,
        };
      } catch (_) {
        // Ignore malformed tree and continue scanning other candidates.
      }
    }

    return null;
  }

  _extractHtmlNameFromAnalysisPath(analysisTreePath) {
    if (!analysisTreePath) return '';
    const normalized = String(analysisTreePath).replace(/\\/g, '/');
    const marker = '/Temp/HtmlToPrefab/';
    const index = normalized.indexOf(marker);
    if (index < 0) return '';
    const rest = normalized.slice(index + marker.length);
    const parts = rest.split('/');
    return parts.length > 0 ? String(parts[0] || '') : '';
  }

  _tryAlignRequestHtmlPath(request, nodeContext) {
    if (!request || !request.htmlPath || !nodeContext) return;

    const matchedHtmlName = String(nodeContext.matchedHtmlName || '').trim();
    if (!matchedHtmlName) return;

    const requestHtmlName = path.basename(
      String(request.htmlPath || ''),
      path.extname(String(request.htmlPath || '')),
    );
    if (!requestHtmlName || requestHtmlName === matchedHtmlName) return;

    const candidates = this._resolveHtmlPathCandidatesByName(matchedHtmlName);
    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) continue;
      request.htmlPath = path.resolve(candidate);
      nodeContext.alignedHtmlPath = request.htmlPath;
      return;
    }
  }

  _resolveHtmlPathCandidatesByName(htmlName) {
    const safeName = String(htmlName || '').trim();
    if (!safeName) return [];
    const root = this.imagePatcher.workspaceRoot;
    return [
      path.join(root, `${safeName}.html`),
      path.join(root, `${safeName}.htm`),
      path.join(root, 'test', `${safeName}.html`),
      path.join(root, 'test', `${safeName}.htm`),
      path.join(root, 'tool', 'UIBaker', 'test', `${safeName}.html`),
      path.join(root, 'tool', 'UIBaker', 'test', `${safeName}.htm`),
    ];
  }

  _buildLocateHint(request, nodeContext, resolvedDomPath, manualDomPath) {
    const hints = [];
    const requestHtmlName = path.basename(String(request && request.htmlPath ? request.htmlPath : ''), path.extname(String(request && request.htmlPath ? request.htmlPath : '')));
    const matchedHtmlName = String(nodeContext && nodeContext.matchedHtmlName ? nodeContext.matchedHtmlName : '');

    if (matchedHtmlName && requestHtmlName && matchedHtmlName !== requestHtmlName) {
      hints.push(
        `Hint: node appears in analysis tree for '${matchedHtmlName}', but current html is '${requestHtmlName}'.`,
      );
    }

    const effectiveDomPath = String(resolvedDomPath || '').trim();
    const fallbackDomPath = String(manualDomPath || '').trim();
    if (effectiveDomPath) {
      hints.push(`domPath='${effectiveDomPath}'.`);
    } else if (fallbackDomPath) {
      hints.push(`manual domPath='${fallbackDomPath}'.`);
    }

    if (nodeContext && nodeContext.matchedAnalysisTreePath) {
      hints.push(`analysis='${nodeContext.matchedAnalysisTreePath}'.`);
    }

    if (hints.length === 0) {
      return '';
    }
    return hints.join(' ');
  }

  _toPositiveInt(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return parsed;
  }

  _toPositiveNumber(value, fallback) {
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return parsed;
  }

  _toBoolean(value, fallback) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true') return true;
      if (normalized === 'false') return false;
    }
    return fallback;
  }

  _parseOptionalBoolean(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true') return true;
      if (normalized === 'false') return false;
    }
    return null;
  }

  _resolveAnalysisTreePath(request) {
    const manualPath = request.manualParams && request.manualParams.analysisTreePath
      ? path.resolve(String(request.manualParams.analysisTreePath))
      : '';
    if (manualPath && fs.existsSync(manualPath)) {
      return manualPath;
    }

    const htmlName = sanitizeName(path.basename(request.htmlPath, path.extname(request.htmlPath)));
    const root = this.imagePatcher.workspaceRoot;
    const candidates = [
      path.join(root, 'Temp', 'HtmlToPrefab', htmlName, 'output', 'debug', 'analysis_tree.json'),
      path.join(root, 'tool', 'UIBaker', 'output', 'debug', 'analysis_tree.json'),
      path.join(root, 'output', 'debug', 'analysis_tree.json'),
      path.join(process.cwd(), 'output', 'debug', 'analysis_tree.json'),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return '';
  }

  _findNodeById(node, nodeId, ancestorChain) {
    if (!node || typeof node !== 'object') return null;
    if (String(node.id || '') === String(nodeId)) {
      return {
        node,
        ancestorChain,
      };
    }

    const children = Array.isArray(node.children) ? node.children : [];
    for (const child of children) {
      const nextChain = ancestorChain.concat(node.id ? [String(node.id)] : []);
      const matched = this._findNodeById(child, nodeId, nextChain);
      if (matched) return matched;
    }
    return null;
  }
}

module.exports = RepairService;
