# HtmlToPrefab

将 HTML UI 自动烘焙为 Unity 可用的 `layout.json + 图片资源 + Prefab`。

## 1. 环境要求

- Unity：建议 `2021.3 LTS` 或更高（项目已使用 UGUI + TextMeshPro）。
- Node.js：建议 `18+`（Puppeteer 24 需要较新 Node 版本）。
- 操作系统：Windows / macOS / Linux 均可（需能运行 Node + Chromium）。

## 2. 安装与搭建

### 2.1 克隆项目

```bash
 git@github.com:Kakoy97/Html-To-Unity-Prefab.git  
cd HtmlToPrefab
```

### 2.2 安装 Node 依赖

在 `tool/UIBaker` 目录执行：

```bash
cd tool/UIBaker
npm install
```

当前核心依赖（来自 `tool/UIBaker/package.json`）：

- `puppeteer`
- `fs-extra`
- `uuid`

### 2.3 打开 Unity 工程

使用 Unity Hub 打开项目根目录（包含 `Assets/`、`ProjectSettings/` 的目录）。

## 3. 使用方式

1. 打开 Unity 菜单：`Tools/Html To Prefab/Bake UI Resources`
2. 选择 HTML 文件（支持拖拽或 Browse）
3. 根据需要设置参数（默认推荐 `UI Root = Auto`、`Node Runtime = Auto`）
4. 点击 `Bake To Assets/Resources/UI`

## 4. 输出结果

烘焙后会生成：

- `Assets/Resources/UI/<htmlName>/layout.json`
- `Assets/Resources/UI/<htmlName>/ui_index.json`
- `Assets/Resources/UI/<htmlName>/images/*.png`
- `Assets/Resources/Prefab/<htmlName>/<htmlName>.prefab`

中间临时文件在：

- `Temp/HtmlToPrefab/...`

## 5. 整体原理

### 5.1 转换流程

1. Unity 编辑器发起 Bake 请求（`HtmlBakeWindow`）
2. Unity 调用 Node 脚本 `tool/UIBaker/bake_ui.js`
3. Puppeteer 加载 HTML，分析 DOM 与样式，递归处理节点
4. 生成节点布局树（`layout.json`）和截图资源（`images/*.png`）
5. Unity 导入资源，构建 `ui_index.json`
6. Unity 根据布局与图片生成最终 Prefab

### 5.2 数据分层

- `layout.json`：层级、位置、尺寸、文本样式、语义字段（如 `htmlTag`、`attrs`）
- `ui_index.json`：扁平索引，便于运行时检索
- `Prefab`：Unity 可直接使用的 UI 对象树

### 5.3 交互与表现（当前实现）

- 根据 HTML 语义自动挂部分组件（如 `Button`、`TMP_InputField`、`Toggle`）
- 按钮默认挂 `UiStateDriver`，提供基础 `normal/hover/pressed/disabled` 视觉状态
- 该层为通用运行时层，不强依赖业务脚本结构

## 6. 效果对比

```md
![Web Preview](docs/images/compare_web.png)
![Unity Prefab Preview](docs/images/compare_unity.png)
```

示例占位：

![Web Preview](docs/images/compare_web.png)
![Unity Prefab Preview](docs/images/compare_unity.png)

## 7. 常见问题

- Node 找不到：在 Bake 面板里把 `Node Runtime` 切到 `Custom Path` 指向 `node.exe`
- 根节点尺寸不对：将 `UI Root` 切到 `Custom Selector`，手动填写 `body > div`（或对应主容器）
- 生成慢：优先关闭 Debug 输出；复杂页面节点多时截图次数会显著增加

## 8. 许可与说明

本工具用于提升 HTML UI 到 Unity UI 的迁移效率。若你在项目中二次封装，建议保留本文档并补充你自己的业务接入规范。
