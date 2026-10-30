# AGENTS.md

面向在此仓库中工作的 AI 助手。人类文档见 [README.md](README.md) 与 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 项目是什么

Win2Mac Studio：在 **Windows 10/11** 上把已安装的 Windows 应用打包成可拷到 macOS 的 `.app`（Wine 驱动）。构建全部在 Windows 完成；生成的 `launcher` 只在 macOS 执行。产物不是原生移植，兼容性受 Wine 边界限制。

主要入口：Electron 桌面 UI（`electron/` + `app/`）、无界面 CLI（`cli.js`）、核心引擎（`engine/`）。

## 环境

- Windows 10/11 x64、Node.js 22+、PowerShell 5.1、curl。
- 依赖已随仓库外的 `node_modules/` 安装；`npm install` 仅在依赖变更时需要。
- `npm test` 可在 Windows 与 macOS 上运行，不要新增依赖 Windows 注册表/系统目录的测试。
- 若 `npm start` 只打印 Node 版本，清除 `ELECTRON_RUN_AS_NODE` 后重试。

## 常用命令

| 命令 | 用途 |
|---|---|
| `npm start` | 启动 Electron 桌面应用 |
| `npm run dev:ui` | 无 Electron 的浏览器 UI 预览（`tools/dev-server.js`） |
| `npm test` | 单元测试 + macOS 启动器模拟（`node --test test/*.test.js`） |
| `npm run test:macos` | 仅 macOS 启动器测试 |
| `npm run test:e2e` | Windows 端到端打包/首启/引擎下载（较慢，需真实文件） |
| `npm run dist` | electron-builder 生成 NSIS 安装包到 `release/` |
| `npm run dist:dir` | 免安装目录构建，适合快速验证打包链路 |
| `npm run mac-check` | 生成可独立发送的 Mac 诊断工具 ZIP |
| `npm run brand` | 重新生成 `build/icon.*` |
| `node cli.js scan\|analyze\|build\|engines ...` | 无界面流程，参数见 `cli.js` 顶部 usage |

验证阈值：提交前 `npm test` 必须全绿（当前 80 项）；改动打包路径时额外跑 `npm run test:e2e`。

## 代码地图

| 路径 | 职责 |
|---|---|
| `engine/scanner.js` | 调用 PowerShell 扫描注册表/开始菜单/服务，合并并挑选主程序 |
| `engine/pe.js` | 轻量 PE 解析（头、节、导入、延迟导入、CLR） |
| `engine/analyzer.js` | 依赖分类、风险检测（含 USB/ADB）、A–D 分级、推荐引擎 |
| `engine/electron.js` | ASAR 头解析、Electron 载荷/原生模块识别、Mach-O adb 检测、默认 Wine 兼容参数 |
| `engine/registry.js` | 从应用名/厂商/Electron 元数据生成注册表候选键 |
| `engine/packager.js` | 构建 `.app` 结构、payload 复制与 SHA-256、注册表、运行时、引擎、ZIP |
| `engine/resolver.js` / `download.js` | Gcenx Wine 资产解析、下载、校验、缓存 |
| `engine/icns.js` / `icons.js` / `plist.js` | 图标与 Info.plist 生成 |
| `engine/recipe.js` | `.win2mac.json` 移植配方（白名单校验） |
| `engine/ai/` | OpenAI 兼容客户端、修复 Agent 循环、`config.env` 白名单补丁 |
| `engine/macapp.js` / `mactowin.js` | macOS `.app` 分析（plist/Mach-O/ASAR）；Electron 重组为 Windows 免安装包 |
| `engine/archive.js` / `drop.js` | ZIP 安全解压；拖拽路径分类与主程序排序 |
| `engine/cache.js` / `util.js` | 缓存清理；通用路径/哈希/文件工具 |
| `resources/scripts/` | PowerShell：扫描、图标提取、签名校验 |
| `resources/templates/` | macOS 启动器、诊断/修复脚本、中文 README 模板 |
| `electron/main.js` / `preload.js` | 主进程编排与 IPC；最小 contextBridge 暴露 |
| `app/` | 无框架 HTML/CSS/JS 渲染层 |
| `test/` | `node:test` 测试、E2E、UI 截图辅助 |
| `docs/` | 架构、配方格式、macOS 真机验收、诊断包格式、调研 |

## 打包流水线（修改时先读）

`analyze → payload → registry → userdata → runtime → engine → icon → zip → done`。

- 进度通过 `onProgress({ stage, percent, message })` 上报；UI 在 `app/app.js` 的 `STAGE_RANGE` 映射总进度，且用 `Math.max` 防止回退。新增阶段必须同步 UI 映射。
- `bundleId`/`buildId` 用于稳定 prefix 与日志路径；不要改成随机构值。
- 所有复制都流式 SHA-256 并保留 mtime；修改复制逻辑不得破坏 manifest 校验。
- 盘符路径通过 `engine/util.js` 的 `splitWindowsPath` / `payloadRelativeForWindowsPath` 映射，不要手写字符串替换。
- Windows 命令行参数解析为 argv 编号写入 `config.env`，不得引入 `eval` 或拼接 shell。

## 代码约定

- CommonJS、`'use strict'`、2 空格缩进、单引号、分号；内置模块用 `node:` 前缀。
- `engine/` 保持无 Electron 依赖，可被 `cli.js` 与测试直接调用。
- 渐进式后台分析、IPC、构建都通过回调/事件推进进度，不要轮询。
- 面向用户的文案、错误信息、日志使用中文；标识符与协议字段用英文。
- 不引入前端框架或打包器；`app/` 保持原生 DOM。
- 新增工具函数优先放 `engine/util.js`；路径判断使用 `isPathInside` / `relativeInside`，不要用字符串 `startsWith`。

## 必须保持的约束

- **行尾**：`.sh`、`.command` 必须 LF（`.gitattributes` 已声明）。模板 CRLF 会导致 macOS `bad interpreter`，测试会断言。
- **安全边界**：渲染层 `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`；IPC 只走 `preload.js` 白名单；拖拽路径用 `webUtils.getPathForFile`，不信任 `file.path`。
- **子进程**：`spawn` 只传 argv 数组；PowerShell 任务用 JSON 文件传路径，禁止引号拼接。
- **ZIP 解压**：必须继续拒绝路径穿越、绝对路径、盘符前缀、NTFS 流名、符号链接与加密条目。
- **配方**：只接受声明式白名单字段，不保存本机绝对路径、下载 URL 或可执行脚本。
- **缓存清理**：仅限 `%LOCALAPPDATA%\Win2Mac\engines`、`runtimes` 与 `%TEMP%\win2mac-build-*`；构建中拒绝清理。
- **用户配置合并**：启动器只补入缺失的 AppData 文件，跳过 `Programs`/`Temp`/缓存等目录，不能覆盖 prefix 已有文件或复制应用二进制。
- **Electron 兼容**：自动参数必须可去重、可关闭（`WIN2MAC_ELECTRON_COMPAT=0` / `--no-electron-compat`），且只对识别为 Electron 的主程序生效。
- **ADB 桥接**：只运行 payload 内检测到的 Mach-O `adb`，端口固定 `127.0.0.1:5037`，已有服务时复用；失败不能阻止应用启动，且不得把 ADB 暴露到局域网。
- **诊断报告**：`Report.json` 的 `schema` 固定为 `win2mac-diagnostics/1`；`Missing.txt` 的 `MISSING`/`SIZE_MISMATCH` 行格式是修复入口。诊断包不得复制 payload，只能带清单、日志和元数据。
- **文件清单**：`payload-index.tsv/json` 必须与 `manifest.sha256` 同源同批生成；启动器用 TSV 做存在性/大小快检，完整 SHA-256 仍以 manifest 为准。
- **许可证**：不复制/分发 Apple GPTK、CrossOver、Whisky 二进制；只允许内置可再分发的 Gcenx Wine（LGPL）。不得实现反作弊/DRM 绕过、隐蔽运行或进程注入。
- **AI 修复**：Agent 只能调用白名单工具（读诊断/日志、改 `config.env` 白名单键、重建）；禁止任意命令执行、任意路径读取与签名/隔离绕过。API Key 只存本机 `settings.json`，IPC 不得回传明文。
- **Mac → Windows**：只重组 Electron 载荷；下载 Electron 运行时必须校验 `SHASUMS256.txt`；含 Mach-O `.node` 或非 Electron 应用必须明确拒绝，不得静默产出不可用包。

## 测试约定

- 用 Node 内置 `node:test` + `node:assert/strict`，文件命名 `test/*.test.js`。
- 测试必须跨平台：用合成 PE、假 `uname`/`sw_vers`/`arch`/`wine` 模拟 macOS，不依赖 Windows `SystemRoot` 或真实注册表。
- macOS 启动器测试会执行真实 `resources/templates/launcher.sh`；改模板后先跑 `bash -n` 再跑 `npm test`。
- UI 验证使用 Electron offscreen 截图（见 `tools/capture-ui.js`），不要弹出真实窗口。

## 生成物与忽略目录

`release/`、`node_modules/`、`test/out/`、`test/.e2e/`、`test/scan-*.json`、`research/raw/`、`ceshi/` 均为本机产物，不要提交。版本号在 `package.json`，发版需同步 `README.md` 与 `CHANGELOG.md`。
