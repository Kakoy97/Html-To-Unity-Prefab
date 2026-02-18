# HTML 到 Unity Prefab 转换工具 - 完整架构文档

## 目录

1. [工程结构](#工程结构)
2. [HTML 到 Prefab 完整链路](#html-到-prefab-完整链路)
3. [核心原理](#核心原理)
4. [详细模块说明](#详细模块说明)

---

## 工程结构

### 整体目录结构

```
Html-To-Unity-Prefab/
├── tool/                          # Node.js 工具端
│   ├── src/                       # 核心源代码
│   │   ├── index.js              # 主入口文件
│   │   ├── core/
│   │   │   ├── Context.js        # 上下文管理（Puppeteer 启动）
│   │   │   ├── Analyzer.js       # DOM 分析器
│   │   │   ├── Planner.js        # 任务规划器
│   │   │   ├── Baker.js          # 截图器
│   │   │   └── Assembler.js      # 布局组装器
│   │   └── utils/
│   │       └── logger.js         # 日志工具
│   └── UIBaker/                  # UIBaker 依赖
├── Assets/
│   ├── Editor/
│   │   └── HtmlToPrefab/         # Unity Editor 脚本
│   │       ├── HtmlBakeWindow.cs      # 编辑器窗口
│   │       ├── BakePipeline.cs        # 烘焙管道
│   │       ├── NodeBakeRunner.cs      # Node.js 进程执行器
│   │       ├── PrefabBuilder.cs       # Prefab 构建器
│   │       ├── LayoutModels.cs        # 布局数据模型
│   │       ├── LayoutIndexBuilder.cs  # UI 索引构建器
│   │       └── UiAssetImporter.cs     # 纹理导入规则
│   └── HtmlToPrefab/
│       └── Runtime/               # 运行时组件
│           ├── UiNodeRef.cs      # 节点引用组件
│           ├── UiStateDriver.cs  # UI 状态驱动组件
│           └── UiVisualState.cs  # UI 视觉状态
└── test/                          # 测试 HTML 文件
```

### 模块职责划分

#### Node.js 工具端 (tool/src)

- **Context.js**: 管理 Puppeteer 浏览器实例，配置视口和 DPR
- **Analyzer.js**: 遍历 DOM 树，提取节点信息（位置、样式、类型等）
- **Planner.js**: 分析节点，决定捕获策略（clone/inPlace/rangePart/backgroundStack）
- **Baker.js**: 执行截图操作，支持多种捕获模式
- **Assembler.js**: 组装分析结果和截图元数据，生成 layout.json

#### Unity Editor 端 (Assets/Editor/HtmlToPrefab)

- **HtmlBakeWindow.cs**: 提供 Unity Editor 窗口界面
- **BakePipeline.cs**: 协调整个烘焙流程
- **NodeBakeRunner.cs**: 执行 Node.js 脚本
- **PrefabBuilder.cs**: 根据 layout.json 构建 Unity Prefab
- **LayoutIndexBuilder.cs**: 生成 UI 索引文件（ui_index.json）
- **UiAssetImporter.cs**: 配置纹理导入设置

---

## HTML 到 Prefab 完整链路

### 流程图

```
HTML 文件
    ↓
[Unity Editor] HtmlBakeWindow.cs
    ↓
[Unity Editor] BakePipeline.RunBake()
    ↓
[Unity Editor] NodeBakeRunner.Run() → 执行 Node.js 脚本
    ↓
[Node.js] tool/src/index.js
    ├─→ Context.launch() → 启动 Puppeteer
    ├─→ Analyzer.run() → DOM 分析
    │   └─→ 生成 analysis_tree.json
    ├─→ Planner.plan() → 任务规划
    │   └─→ 生成 bake_plan.json
    ├─→ Baker.run() → 截图捕获
    │   └─→ 生成 images/*.png
    └─→ Assembler.run() → 布局组装
        └─→ 生成 layout.json
    ↓
[Unity Editor] BakePipeline 后处理
    ├─→ 同步文件到 Assets/Resources
    ├─→ UiAssetImporter.ApplyTextureRules()
    ├─→ LayoutIndexBuilder.WriteIndex()
    └─→ PrefabBuilder.Build()
        └─→ 生成 Prefab
```

### 详细步骤

#### 阶段 1: Unity Editor 启动 (HtmlBakeWindow.cs)

1. 用户选择 HTML 文件
2. 设置输出目录（必须在 `Assets/Resources` 下）
3. 设置视口尺寸（宽度、高度）
4. 点击 "Bake" 按钮

#### 阶段 2: 调用 Node.js 工具 (BakePipeline.cs)

```csharp
// 构建 Node.js 命令参数
var args = BuildBakeArgs(bakeScriptPath, htmlPath, tempOutput, request);
// 执行 Node.js 脚本
var nodeResult = NodeBakeRunner.Run("node", args, bakerRoot);
```

**命令示例**:
```bash
node "tool/src/index.js" "path/to/file.html" \
  --output-dir="Temp/HtmlToPrefab/output" \
  --width=750 --height=1624 \
  --root-selector=body
```

#### 阶段 3: DOM 分析 (Analyzer.js)

**流程**:
1. **等待渲染稳定**: 等待字体加载和动画完成
2. **检测遮罩层**: 识别全局遮罩层（overlay/modal）
3. **遍历 DOM 树**:
   - 从根节点（body）开始递归遍历
   - 为每个可见节点分配唯一 ID (`data-bake-id`)
   - 提取节点信息：
     - 位置和尺寸（物理像素坐标）
     - 样式信息（背景、边框、阴影等）
     - 文本内容（直接文本节点）
     - 特殊元素（range input 的 track/thumb）
     - 旋转角度（从 transform 解析）

**输出**: `debug/analysis_tree.json`

**节点类型**:
- `Container`: 容器节点
- `Image`: 图像节点（有视觉效果的节点）
- `Text`: 文本节点

#### 阶段 4: 任务规划 (Planner.js)

**决策流程**:

1. **遍历分析树**: 深度优先遍历每个节点
2. **判断是否需要捕获**:
   - `Image` 类型节点 → 需要捕获
   - `Container` 类型且有视觉效果的节点 → 需要捕获
3. **选择捕获模式**:
   - **clone 模式**: 默认模式，克隆节点到新位置截图
   - **inPlace 模式**: 在原位置截图（需要上下文时）
   - **rangePart 模式**: 捕获 range input 的 track/thumb
   - **backgroundStack 模式**: 背景堆叠合成

**选择 inPlace 的条件**:
- 有 backdrop-filter（背景模糊）
- 有 mix-blend-mode（混合模式）
- 有祖先裁剪（overflow: hidden）
- 有圆角裁剪上下文
- 有旋转上下文
- 低透明度背景需要上下文

**输出**: `debug/bake_plan.json`, `debug/rules_trace.json`

#### 阶段 5: 截图捕获 (Baker.js)

**捕获模式详解**:

##### Clone 模式
1. 克隆目标节点
2. 设置固定定位，移到左上角
3. 隐藏页面其他内容
4. 截图克隆节点

##### InPlace 模式
1. 隐藏页面其他内容
2. 显示目标节点及其祖先链
3. 可选：抑制祖先绘制（避免背景污染）
4. 可选：保留场景底层（用于半透明效果）
5. 在原位置截图

##### RangePart 模式
1. 解析 range input 的伪元素样式（`::-webkit-slider-track`, `::-webkit-slider-thumb`）
2. 计算 track 和 thumb 的位置
3. 隐藏另一个部分
4. 截图指定部分

##### BackgroundStack 模式
1. 显示基础节点和堆叠节点
2. 截图整个区域

**输出**: `images/*.png` + `debug/capture_meta.json`

#### 阶段 6: 布局组装 (Assembler.js)

**组装流程**:
1. 合并分析树和截图元数据
2. 计算内容边界（contentBounds）
3. 生成最终的布局树

**输出**: `layout.json`

**layout.json 结构**:
```json
{
  "id": "root-id",
  "type": "Container",
  "rect": { "x": 0, "y": 0, "width": 1500, "height": 3248 },
  "imagePath": "images/bg.png",
  "children": [
    {
      "id": "node-id",
      "type": "Image",
      "rect": { "x": 100, "y": 200, "width": 200, "height": 100 },
      "imagePath": "images/0001_div.png",
      "capture": {
        "mode": "clone",
        "imageWidth": 200,
        "imageHeight": 100,
        "contentOffsetX": 0,
        "contentOffsetY": 0,
        "contentWidth": 200,
        "contentHeight": 100
      },
      "rotationBaked": false,
      "rotation": 0,
      "renderOpacity": 1
    }
  ]
}
```

#### 阶段 7: Unity 后处理 (BakePipeline.cs)

1. **同步文件**: 将临时输出目录的文件复制到 `Assets/Resources/UI/{htmlName}/`
2. **应用纹理规则**: `UiAssetImporter.ApplyTextureRules()`
   - 设置为 Sprite 类型
   - 禁用 Mipmap
   - 设置像素单位 100
   - 启用 Alpha 透明度
   - 设置过滤模式为 Bilinear
3. **生成索引**: `LayoutIndexBuilder.WriteIndex()`
   - 生成 `ui_index.json`，包含所有节点的索引信息
4. **构建 Prefab**: `PrefabBuilder.Build()`

#### 阶段 8: Prefab 构建 (PrefabBuilder.cs)

**构建流程**:

1. **创建根 GameObject**: 设置 RectTransform
2. **创建内容容器**: `__content` GameObject，使用物理坐标
3. **创建背景**: `__bg` GameObject，使用 Stretch 锚点
4. **递归构建子节点**:
   - 为每个节点创建 GameObject
   - 设置 RectTransform（基于物理坐标）
   - 创建 `__visual` 子对象用于显示图像
   - 应用截图帧偏移（contentOffset）
   - 应用旋转（如果未烘焙）
   - 应用透明度（renderOpacity）
   - 添加 Image 组件（如果有 imagePath）
   - 添加 TextMeshProUGUI（如果是 Text 节点）
   - 添加语义组件（Button、InputField、Toggle 等）

**坐标系统**:
- HTML 使用物理像素坐标（已乘以 DPR）
- Unity Prefab 直接使用物理坐标，无需缩放
- 锚点设置为左上角（0, 1），pivot 为 (0, 1)

**输出**: `Assets/Resources/Prefab/{htmlName}/{htmlName}.prefab`

---

## 核心原理

### 1. 坐标系统转换

**HTML 坐标 → Unity 坐标**:

- HTML 使用逻辑像素（CSS px），通过 DPR 转换为物理像素
- Unity 直接使用物理像素坐标
- 坐标原点：HTML 左上角 (0, 0) → Unity 左上角 (0, height)
- Y 轴翻转：HTML Y 向下 → Unity Y 向上

**转换公式**:
```javascript
// Analyzer.js 中
physicalX = (rect.left + window.scrollX) * devicePixelRatio
physicalY = (rect.top + window.scrollY) * devicePixelRatio
physicalWidth = rect.width * devicePixelRatio
physicalHeight = rect.height * devicePixelRatio
```

```csharp
// PrefabBuilder.cs 中
localX = nodeRect.x - parentRect.x
localY = nodeRect.y - parentRect.y
// Unity Y 轴向上，需要翻转
anchoredPosition = new Vector2(localX, -localY)
```

### 2. 截图策略选择

#### Clone 模式 vs InPlace 模式

**Clone 模式**（默认）:
- 优点：干净，不受页面其他内容影响
- 缺点：无法捕获需要上下文的效果（backdrop-filter、clip-path 等）
- 适用：简单节点、图标、纯色背景

**InPlace 模式**:
- 优点：可以捕获上下文效果
- 缺点：可能包含不需要的背景
- 适用：有 backdrop-filter、mix-blend-mode、裁剪上下文、旋转上下文

**决策逻辑**（Planner.js）:
```javascript
if (hasBackdrop || hasBlend || hasClip || hasRotation || needsContext) {
  captureMode = 'inPlace'
} else {
  captureMode = 'clone'
}
```

### 3. 旋转处理

**两种旋转策略**:

1. **烘焙旋转**（rotationBaked = true）:
   - 在截图中应用旋转
   - Unity 中直接显示，无需额外旋转
   - 适用于：节点自身旋转

2. **运行时旋转**（rotationBaked = false）:
   - 截图保持原始方向
   - Unity 中通过 `localRotation` 应用旋转
   - 适用于：祖先旋转上下文

**旋转计算**（Analyzer.js）:
```javascript
// 从 transform matrix 解析角度
const matrix = transform.match(/matrix\(([^)]+)\)/);
const [a, b] = values;
const angle = Math.atan2(b, a) * (180 / Math.PI);
```

### 4. 透明度解耦（Opacity Decoupling）

**问题**: CSS opacity 会被烘焙到纹理的 alpha 通道，Unity Image 组件也会应用 alpha，导致双重衰减。

**解决方案**: 
- 截图时设置 `opacity: 1`（不烘焙透明度）
- 在 `layout.json` 中记录 `renderOpacity`
- Unity 中通过 `Image.color.a` 应用透明度

**适用条件**:
- 节点是原子视觉标签（IMG、SVG 等）
- opacity 在 0 到 0.999 之间
- 没有复杂合成样式

### 5. 低透明度上下文捕获（Low Alpha Context Capture）

**场景**: 半透明背景面板（如毛玻璃效果）

**策略**:
- 使用 inPlace 模式
- 保留场景底层（preserveSceneUnderlay = true）
- 抑制微弱边框（suppressUnderlayFaintBorder = true）

**检测条件**:
- Container 类型
- 背景 alpha 在 0 到 0.12 之间
- 没有背景图片
- 面积比例在 0.002 到 0.35 之间

### 6. 背景堆叠合成（Background Stack Composite）

**场景**: 多个半透明层叠加（如多个 overlay）

**策略**:
- 识别基础节点（大面积、半透明）
- 识别叠加节点（覆盖基础节点 92% 以上）
- 一次性截图整个堆叠

**优势**: 减少截图数量，保持正确的层叠效果

### 7. Range Input 特殊处理

**问题**: `<input type="range">` 的 track 和 thumb 是伪元素，无法直接截图。

**解决方案**:
1. Analyzer 解析伪元素样式（`::-webkit-slider-track`, `::-webkit-slider-thumb`）
2. 计算 track 和 thumb 的位置和尺寸
3. 创建虚拟子节点（rangePart）
4. Baker 使用 rangePart 模式分别截图

**计算逻辑**:
- Track: 基于 input 元素的尺寸和 track 样式
- Thumb: 基于 value 比例计算位置，考虑 margin-top

### 8. 文本处理

**文本节点类型**:
- **直接文本**: 作为节点的直接子文本节点
- **Text 节点**: 独立的 Text 类型节点

**处理方式**:
- 截图时隐藏文本（hideOwnText = true）
- 在 layout.json 中保存文本内容和样式
- Unity 中使用 TextMeshProUGUI 渲染文本

**文本样式映射**:
- CSS `fontSize` → TextMeshPro `fontSize`
- CSS `color` → TextMeshPro `color`
- CSS `fontWeight` → TextMeshPro `fontStyle` (Bold)
- CSS `textAlign` → TextMeshPro `alignment`

### 9. 语义组件映射

**HTML → Unity 组件映射**:

| HTML 元素 | Unity 组件 |
|-----------|-----------|
| `<button>` | `Button` + `UiStateDriver` |
| `<input type="text">` | `TMP_InputField` |
| `<textarea>` | `TMP_InputField` (multiline) |
| `<input type="checkbox">` | `Toggle` |
| `<input type="radio">` | `Toggle` |

**UiStateDriver**: 驱动按钮的视觉状态（hover、pressed、disabled）

---

## 详细模块说明

### Node.js 工具端

#### Context.js

**职责**: 管理 Puppeteer 浏览器实例和配置

**关键方法**:
- `launch()`: 启动浏览器，设置视口和 DPR
- `close()`: 关闭浏览器

**配置参数**:
- `logicalWidth/logicalHeight`: 逻辑视口尺寸
- `dpr`: 设备像素比
- `targetWidth/targetHeight`: 物理视口尺寸

#### Analyzer.js

**职责**: 分析 DOM 结构，提取节点信息

**关键方法**:
- `run()`: 主入口，执行完整分析
- `_traverse()`: 递归遍历 DOM 树
- `_extractNodeInfo()`: 提取单个节点的信息
- `_detectMask()`: 检测全局遮罩层
- `_waitForRenderStability()`: 等待渲染稳定

**提取的信息**:
- 位置和尺寸（物理像素）
- 样式信息（computed styles）
- 文本内容
- 旋转角度
- z-index
- 特殊元素（range input parts）

#### Planner.js

**职责**: 分析节点，决定捕获策略

**关键方法**:
- `plan()`: 主入口，生成任务列表
- `_traverse()`: 递归遍历分析树
- `_analyzeCaptureEffects()`: 分析节点效果
- `_decideOpacityDecouple()`: 决定是否解耦透明度
- `_shouldUseLowAlphaContextCapture()`: 判断是否需要低透明度上下文捕获

**决策规则**:
- 检查节点类型（Image/Container）
- 检查视觉效果（backdrop-filter、mix-blend-mode）
- 检查裁剪上下文（overflow、clip-path）
- 检查旋转上下文
- 检查透明度

#### Baker.js

**职责**: 执行截图操作

**关键方法**:
- `run()`: 主入口，执行所有截图任务
- `_captureNodeClone()`: Clone 模式截图
- `_captureNodeInPlace()`: InPlace 模式截图
- `_captureRangePart()`: RangePart 模式截图
- `_captureBackgroundStack()`: BackgroundStack 模式截图

**浏览器端逻辑**:
- `_browserCaptureLogic()`: Clone 模式的浏览器端逻辑
- `_browserInPlaceSetupLogic()`: InPlace 模式的浏览器端逻辑
- `_browserRangePartSetupLogic()`: RangePart 模式的浏览器端逻辑
- `_browserCleanupLogic()`: 清理临时修改

#### Assembler.js

**职责**: 组装最终布局数据

**关键方法**:
- `run()`: 主入口，生成 layout.json
- `_transformNode()`: 转换节点数据
- `_computeContentBounds()`: 计算内容边界
- `_extractCaptureInfo()`: 提取截图元数据

### Unity Editor 端

#### HtmlBakeWindow.cs

**职责**: 提供 Unity Editor 窗口界面

**功能**:
- HTML 文件选择（拖拽支持）
- 输出目录选择
- 视口尺寸设置
- 日志显示

#### BakePipeline.cs

**职责**: 协调整个烘焙流程

**关键方法**:
- `RunBake()`: 主入口
- `Run()`: 执行完整流程
- `BuildBakeArgs()`: 构建 Node.js 命令参数
- `SyncDirectory()`: 同步文件

**流程**:
1. 调用 Node.js 工具
2. 等待完成
3. 同步文件到 Assets
4. 应用纹理规则
5. 生成索引
6. 构建 Prefab

#### NodeBakeRunner.cs

**职责**: 执行 Node.js 进程

**关键方法**:
- `Run()`: 启动进程，捕获输出

**特性**:
- 超时处理（默认 300 秒）
- 标准输出/错误捕获
- 异常处理

#### PrefabBuilder.cs

**职责**: 根据 layout.json 构建 Unity Prefab

**关键方法**:
- `Build()`: 主入口
- `BuildNode()`: 构建单个节点
- `BuildChildren()`: 构建子节点
- `ConfigureRect()`: 配置 RectTransform
- `ApplyCaptureFrame()`: 应用截图帧偏移
- `ApplySemanticComponents()`: 添加语义组件

**坐标转换**:
- 物理像素坐标直接使用
- Y 轴翻转（HTML 向下 → Unity 向上）
- 锚点设置为左上角

#### LayoutIndexBuilder.cs

**职责**: 生成 UI 索引文件

**输出**: `ui_index.json`

**用途**: 运行时快速查找节点（通过 ID、domPath 等）

#### UiAssetImporter.cs

**职责**: 配置纹理导入设置

**设置项**:
- 类型: Sprite
- 模式: Single
- 像素单位: 100
- Alpha 透明度: 启用
- Mipmap: 禁用
- 过滤模式: Bilinear
- 压缩: Uncompressed

---

## 总结

这个工具实现了从 HTML 到 Unity Prefab 的完整转换流程，核心思想是：

1. **分析**: 使用 Puppeteer 分析 HTML DOM 结构
2. **规划**: 智能选择截图策略
3. **捕获**: 使用多种模式截图节点
4. **组装**: 生成包含布局和元数据的 JSON
5. **构建**: Unity 中根据 JSON 构建 Prefab

关键特性：
- 支持复杂 CSS 效果（backdrop-filter、mix-blend-mode）
- 智能处理旋转和透明度
- 支持特殊元素（range input）
- 保持布局精度（物理像素坐标）
- 自动映射语义组件
