const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const Context = require('./core/Context');
const Analyzer = require('./core/Analyzer');
const Planner = require('./core/Planner');
const Baker = require('./core/Baker');
const Assembler = require('./core/Assembler');
const logger = require('./utils/logger');

function formatNumber(value) {
  if (Number.isInteger(value)) return String(value);
  return Number(value.toFixed(2)).toString();
}

function resolveHtmlPath(args) {
  const target = args.html || args.input || args._[0] || 'index.html';
  if (path.isAbsolute(target)) return target;

  const candidates = [
    path.resolve(process.cwd(), target),
    path.resolve(process.cwd(), 'test', target),
    path.resolve(process.cwd(), 'tool', 'UIBaker', 'test', target),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return candidates[0];
}

function assertFileExists(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Target HTML not found: ${filePath}. ` +
      'Use --html <path> (or --input <path>) to point to a valid file.',
    );
  }
}

async function getPageContentSize(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const body = document.body;
    const width = Math.max(
      doc ? doc.scrollWidth : 0,
      doc ? doc.offsetWidth : 0,
      body ? body.scrollWidth : 0,
      body ? body.offsetWidth : 0,
      window.innerWidth || 0,
    );
    const height = Math.max(
      doc ? doc.scrollHeight : 0,
      doc ? doc.offsetHeight : 0,
      body ? body.scrollHeight : 0,
      body ? body.offsetHeight : 0,
      window.innerHeight || 0,
    );
    return { width, height };
  });
}

function resolveFsExtra() {
  try {
    return require('fs-extra');
  } catch (_) {
    return require(path.resolve(__dirname, '../UIBaker/node_modules/fs-extra'));
  }
}

function countNodes(node) {
  if (!node) return 0;
  const children = Array.isArray(node.children) ? node.children : [];
  let total = 1;
  for (const child of children) {
    total += countNodes(child);
  }
  return total;
}

async function openHtmlWithFallback(
  page,
  fileUrl,
  navigationTimeoutMs,
  loadSettleTimeoutMs,
  disableNavLoadTimeoutFallback,
) {
  if (disableNavLoadTimeoutFallback) {
    await page.goto(fileUrl, {
      waitUntil: 'load',
      timeout: navigationTimeoutMs,
    });
    return;
  }

  await page.goto(fileUrl, {
    waitUntil: 'domcontentloaded',
    timeout: navigationTimeoutMs,
  });

  try {
    await page.waitForFunction(
      () => document.readyState === 'complete',
      { timeout: loadSettleTimeoutMs },
    );
  } catch (_) {
    logger.warn(
      `[nav-load-timeout-fallback] readyState incomplete after ${loadSettleTimeoutMs}ms; ` +
      'continue after domcontentloaded.',
    );
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const parsedArgs = Context.parseArgv(argv);
  const context = new Context(argv);
  const fsExtra = resolveFsExtra();

  try {
    logger.step('Context Launch');
    const { page, config } = await context.launch();
    const analyzer = new Analyzer(context);
    const planner = new Planner(context);
    const baker = new Baker(context);
    const assembler = new Assembler(context);
    console.log(
      `[Context] Target: ${config.targetWidth}x${config.targetHeight} | ` +
      `Logical: ${config.logicalWidth}x${config.logicalHeight} | ` +
      `DPR: ${formatNumber(config.dpr)}`,
    );

    logger.step('Open HTML');
    const htmlPath = resolveHtmlPath(parsedArgs);
    assertFileExists(htmlPath);
    logger.info(`Loading: ${htmlPath}`);
    await openHtmlWithFallback(
      page,
      pathToFileURL(htmlPath).href,
      config.navigationTimeoutMs,
      config.navigationLoadSettleTimeoutMs,
      config.disableNavLoadTimeoutFallback,
    );

    logger.step('Measure Content Size');
    const contentSize = await getPageContentSize(page);
    logger.info(`[Page] Content Size: ${contentSize.width}x${contentSize.height}`);
    config.contentLogicalWidth = Math.max(config.logicalWidth, contentSize.width);
    config.contentLogicalHeight = Math.max(config.logicalHeight, contentSize.height);
    config.contentPhysicalWidth = Math.max(config.targetWidth, Math.round(config.contentLogicalWidth * config.dpr));
    config.contentPhysicalHeight = Math.max(config.targetHeight, Math.round(config.contentLogicalHeight * config.dpr));
    context.contentHeight = config.contentLogicalHeight;

    logger.step('DOM Analysis');
    const analysisRoot = await analyzer.run(page);
    const debugDir = path.join(config.outputDir, 'debug');
    const analysisPath = path.join(debugDir, 'analysis_tree.json');
    await fsExtra.ensureDir(path.dirname(analysisPath));
    await fsExtra.writeJson(analysisPath, analysisRoot, { spaces: 2 });
    const totalNodes = countNodes(analysisRoot);
    logger.info(`[Analyzer] DOM Analysis complete. Found ${totalNodes} nodes.`);
    logger.info(`[Analyzer] Output: ${analysisPath}`);

    logger.step('Task Planning');
    const tasks = planner.plan(analysisRoot);
    const planPath = path.join(debugDir, 'bake_plan.json');
    const rulesTracePath = path.join(debugDir, 'rules_trace.json');
    await fsExtra.ensureDir(path.dirname(planPath));
    await fsExtra.writeJson(planPath, tasks, { spaces: 2 });
    const rulesTrace = typeof planner.getRuleTrace === 'function' ? planner.getRuleTrace() : [];
    await fsExtra.writeJson(rulesTracePath, rulesTrace, { spaces: 2 });
    logger.info(`[Planner] Plan generated. Total tasks: ${tasks.length}`);
    logger.info(`[Planner] Output: ${planPath}`);
    logger.info(`[Planner] Rules Trace: ${rulesTracePath}`);

    logger.step('Asset Baking');
    const bakeResult = await baker.run(page, tasks);
    const captureMetaPath = path.join(debugDir, 'capture_meta.json');
    await fsExtra.ensureDir(path.dirname(captureMetaPath));
    await fsExtra.writeJson(captureMetaPath, bakeResult || {}, { spaces: 2 });
    logger.info('[Baker] Assets baking complete.');

    logger.step('Layout Assembly');
    const layout = await assembler.run(analysisRoot, tasks, bakeResult);
    const layoutPath = path.join(config.outputDir, 'layout.json');
    await fsExtra.ensureDir(path.dirname(layoutPath));
    await fsExtra.writeJson(layoutPath, layout, { spaces: 2 });
    logger.info(`[Assembler] Layout assembly complete: ${layoutPath}`);

    logger.step('Done');
    logger.info('✅ Conversion complete!');
    logger.info(`   Output: ${path.resolve(config.outputDir)}`);
    logger.info('   Layout: layout.json');
    const imageCount = tasks.filter((t) => t && t.type === 'CAPTURE_NODE').length + 1;
    logger.info(`   Images: ${imageCount} generated`);
  } catch (error) {
    logger.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  } finally {
    await context.close();
    logger.info('Context closed.');
  }
}

main();
