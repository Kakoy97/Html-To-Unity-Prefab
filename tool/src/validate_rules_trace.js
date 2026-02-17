const fs = require('fs');
const path = require('path');

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function resolveDebugDir(argv) {
  const input = Array.isArray(argv) ? argv : [];
  const target = input[0] || path.join(process.cwd(), 'output', 'debug');
  return path.isAbsolute(target) ? target : path.resolve(process.cwd(), target);
}

function main() {
  const debugDir = resolveDebugDir(process.argv.slice(2));
  const planPath = path.join(debugDir, 'bake_plan.json');
  const tracePath = path.join(debugDir, 'rules_trace.json');

  if (!fs.existsSync(planPath)) {
    console.error(`[rules-check] missing: ${planPath}`);
    process.exitCode = 1;
    return;
  }
  if (!fs.existsSync(tracePath)) {
    console.error(`[rules-check] missing: ${tracePath}`);
    process.exitCode = 1;
    return;
  }

  const plan = loadJson(planPath);
  const trace = loadJson(tracePath);
  const issues = [];
  const warnings = [];

  const captureTasks = Array.isArray(plan)
    ? plan.filter((t) => t && t.type === 'CAPTURE_NODE')
    : [];
  const traceByNodeId = new Map();
  for (const item of Array.isArray(trace) ? trace : []) {
    if (!item || !item.nodeId) continue;
    traceByNodeId.set(item.nodeId, item);
  }

  for (const task of captureTasks) {
    const params = task.params || {};
    const reasons = Array.isArray(params.reasons) ? params.reasons : [];
    const nodeId = params.nodeId || task.nodeId || '';
    const mode = params.mode || '';

    if (reasons.length === 0) {
      issues.push(`Task ${task.outputName || task.id}: reasons is empty.`);
    }

    if (params.hideOwnText && !reasons.includes('hide-own-direct-text')) {
      issues.push(`Task ${task.outputName || task.id}: hideOwnText=true but missing reason hide-own-direct-text.`);
    }

    if (params.rotationBaked) {
      if (mode !== 'inPlace') {
        issues.push(`Task ${task.outputName || task.id}: rotationBaked=true requires mode=inPlace.`);
      }
      if (!reasons.includes('rotation-baked')) {
        issues.push(`Task ${task.outputName || task.id}: rotationBaked=true but missing reason rotation-baked.`);
      }
    }

    if (params.suppressAncestorPaint && !reasons.includes('suppress-ancestor-paint')) {
      issues.push(
        `Task ${task.outputName || task.id}: suppressAncestorPaint=true but missing reason suppress-ancestor-paint.`,
      );
    }
    if (!params.suppressAncestorPaint && reasons.includes('suppress-ancestor-paint')) {
      warnings.push(
        `Task ${task.outputName || task.id}: reason suppress-ancestor-paint exists but param suppressAncestorPaint is false.`,
      );
    }

    if (params.preserveOwnTextGeometry && !reasons.includes('preserve-own-text-geometry')) {
      issues.push(
        `Task ${task.outputName || task.id}: preserveOwnTextGeometry=true but missing reason preserve-own-text-geometry.`,
      );
    }
    if (!params.preserveOwnTextGeometry && reasons.includes('preserve-own-text-geometry')) {
      warnings.push(
        `Task ${task.outputName || task.id}: reason preserve-own-text-geometry exists but param preserveOwnTextGeometry is false.`,
      );
    }

    if (params.preserveSceneUnderlay && !reasons.includes('preserve-scene-underlay')) {
      issues.push(
        `Task ${task.outputName || task.id}: preserveSceneUnderlay=true but missing reason preserve-scene-underlay.`,
      );
    }
    if (!params.preserveSceneUnderlay && reasons.includes('preserve-scene-underlay')) {
      warnings.push(
        `Task ${task.outputName || task.id}: reason preserve-scene-underlay exists but param preserveSceneUnderlay is false.`,
      );
    }

    if (params.suppressUnderlayFaintBorder && !reasons.includes('underlay-faint-border-suppressed')) {
      issues.push(
        `Task ${task.outputName || task.id}: suppressUnderlayFaintBorder=true but missing reason underlay-faint-border-suppressed.`,
      );
    }
    if (!params.suppressUnderlayFaintBorder && reasons.includes('underlay-faint-border-suppressed')) {
      warnings.push(
        `Task ${task.outputName || task.id}: reason underlay-faint-border-suppressed exists but param suppressUnderlayFaintBorder is false.`,
      );
    }
    if (params.suppressUnderlayFaintBorder && !params.preserveSceneUnderlay) {
      issues.push(
        `Task ${task.outputName || task.id}: suppressUnderlayFaintBorder=true requires preserveSceneUnderlay=true.`,
      );
    }

    if (params.ancestorRotationContext && !reasons.includes('ancestor-rotation-context')) {
      issues.push(
        `Task ${task.outputName || task.id}: ancestorRotationContext=true but missing reason ancestor-rotation-context.`,
      );
    }

    if (params.rangePart) {
      const partReason = `range-part:${params.rangePart}`;
      if (!reasons.includes(partReason)) {
        issues.push(
          `Task ${task.outputName || task.id}: rangePart=${params.rangePart} but missing reason ${partReason}.`,
        );
      }
      if ((params.mode || '') !== 'rangePart') {
        issues.push(
          `Task ${task.outputName || task.id}: rangePart is set but mode is not rangePart.`,
        );
      }
      if (!params.captureSourceNodeId) {
        issues.push(
          `Task ${task.outputName || task.id}: rangePart task missing captureSourceNodeId.`,
        );
      }
    }

    if (mode === 'backgroundStack') {
      if (!reasons.includes('background-stack-composite')) {
        issues.push(
          `Task ${task.outputName || task.id}: backgroundStack mode missing reason background-stack-composite.`,
        );
      }
    }

    const hasClipReason = reasons.some(
      (reason) =>
        typeof reason === 'string' &&
        (reason.startsWith('ancestor-rounded-clip:') || reason.startsWith('ancestor-clip-outside:')),
    );
    const hasIconGlyphException = reasons.includes('icon-glyph-context-exception');
    if (mode === 'clone' && hasClipReason && !hasIconGlyphException) {
      warnings.push(`Task ${task.outputName || task.id}: clone mode with clip-related reason.`);
    }

    if (!traceByNodeId.has(nodeId)) {
      issues.push(`Task ${task.outputName || task.id}: missing node trace for ${nodeId}.`);
    } else {
      const traceItem = traceByNodeId.get(nodeId) || {};
      if (!!traceItem.preserveSceneUnderlay !== !!params.preserveSceneUnderlay) {
        issues.push(
          `Task ${task.outputName || task.id}: trace preserveSceneUnderlay mismatch (task=${!!params.preserveSceneUnderlay}, trace=${!!traceItem.preserveSceneUnderlay}).`,
        );
      }
      if (!!traceItem.suppressUnderlayFaintBorder !== !!params.suppressUnderlayFaintBorder) {
        issues.push(
          `Task ${task.outputName || task.id}: trace suppressUnderlayFaintBorder mismatch (task=${!!params.suppressUnderlayFaintBorder}, trace=${!!traceItem.suppressUnderlayFaintBorder}).`,
        );
      }
    }
  }

  if (issues.length > 0) {
    console.error(`[rules-check] failed. issues=${issues.length}`);
    for (const issue of issues) {
      console.error(`- ${issue}`);
    }
    process.exitCode = 1;
    return;
  }

  if (warnings.length > 0) {
    console.warn(`[rules-check] warnings=${warnings.length}`);
    for (const warning of warnings) {
      console.warn(`- ${warning}`);
    }
  }

  console.log(`[rules-check] ok. checked=${captureTasks.length} tasks, trace=${traceByNodeId.size} nodes.`);
}

main();
