# tool/src 修改规则（HTML -> Prefab）

## 1. 适用范围

本规则适用于以下修改：

- `tool/src/index.js`
- `tool/src/core/*.js`
- `tool/src/utils/*.js`
- 被 Unity 消费的输出契约（`layout.json`、`images/*`、调试 json）

## 2. 链路基线（必须保持有效）

1. `Context` 解析参数、计算分辨率和 DPR，并启动 Puppeteer。
2. `Analyzer` 解析 DOM，输出分析树（`analysis_tree.json`）。
3. `Planner` 将分析树转换为截图任务（`bake_plan.json`）。
4. `Baker` 执行截图并输出图片和捕获元数据（`capture_meta.json`）。
5. `Assembler` 合并分析结果、任务和截图元数据，产出 `layout.json`。
6. Unity 侧（`BakePipeline` -> `LayoutJsonLoader` -> `PrefabBuilder`）读取 `layout.json` 和图片生成 Prefab。

## 3. 强制规则

1. **通用优先（硬性规则）**
   - 所有调整需要坚守通用原则，而不是针对某一个 html 去进行特殊判断或者调整。
   - 禁止基于特定 html 文件名、固定 DOM 路径、某个单独 class/id 做一次性特判。
   - 如果无法通用调整，请及时说明方案，并立即按第 4 节执行。

2. **数据契约稳定**
   - 不得随意删除或重命名跨阶段依赖的关键字段。
   - 新增字段必须向后兼容（可选字段、默认值安全）。

3. **模块职责边界**
   - `Analyzer` 只负责识别/提取。
   - `Planner` 只负责决策截图任务。
   - `Baker` 只负责截图与捕获元数据。
   - `Assembler` 只负责布局结构拼装。
   - 禁止跨层耦合和职责漂移。

4. **参数化优先，避免硬编码**
   - 优先通过 CLI 参数或配置扩展行为。
   - 禁止硬编码本地路径、页面私有选择器、项目特定数据假设。

5. **可调试与可追踪**
   - 保持调试产物完整可读（`analysis_tree.json`、`bake_plan.json`、`capture_meta.json`）。
   - 日志应足够定位回归出现于哪一个阶段。

6. **回归保护**
   - 修改后应保证常见场景可跑通：文本、图片、旋转、overflow/clip/mask。
   - 输出结构必须完整（`layout.json`、`images/*`）。

## 4. 无法通用时必须提供的说明

在实现任何非通用行为前，必须先提供：

1. 约束说明：当前哪个模块或契约阻止了通用解。
2. 推荐方案：可通用改造路径及影响范围。
3. 临时方案：若必须临时特例，给出移除条件与回滚点。
4. 待确认事项：需要用户确认的准确性/性能/工期取舍。

## 5. Regression Trace Guardrails
- Every planner capture decision must write machine-readable reasons into `bake_plan.json`.
- Every traversed node must write a trace record into `rules_trace.json`.
- Any rule exception must add an explicit reason token (example: `icon-glyph-context-exception`).
- Do not remove trace reasons when refactoring; add new reasons instead.

### Required checks after modifying `tool/src`
1. Re-run conversion on at least two representative html files.
2. Run `node tool/src/validate_rules_trace.js <output_dir>/debug` for each run.
3. If validator warns/fails, update generic rules or add a documented exception token.
4. Keep `rules_trace.json` + `bake_plan.json` as regression evidence for review.
