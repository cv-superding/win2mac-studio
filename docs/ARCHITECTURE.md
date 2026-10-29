# 架构说明

## 1. 总览

```
Windows 侧（Electron / CLI）
┌────────────────────────────────────────────────────────────┐
│ 渲染层 app/                                                │
│   应用库 · 兼容性详情 · 转换向导 · 历史 · 设置              │
│            │ IPC（contextIsolation，无 nodeIntegration）    │
│ 主进程 electron/main.js                                    │
│   扫描 / 分析 / 打包 / 文件选择 / 历史 / 诊断              │
│            │                                               │
│ 核心 engine/                                               │
│   scanner → analyzer → packager → zip                      │
│      │          │          │                               │
│   PowerShell   PE 解析    图标/ICNS/plist/注册表/引擎       │
└────────────────────────────────────────────────────────────┘
                              │ 生成
                              ▼
macOS .app（Contents/MacOS/launcher + payload + config）
                              │ 首次运行
                              ▼
引擎发现（GPTK/CrossOver/Whisky/Gcenx/brew）→ prefix → Wine → EXE
```

构建完全发生在 Windows；`launcher` 在 macOS 端才执行。这样避免了跨平台编译，也让 Windows 用户可以独立产出可分发的 `.app`。

## 2. 模块

| 模块 | 职责 |
|---|---|
| `engine/scanner.js` | 调用 `scan-apps.ps1`，合并注册表应用、快捷方式、服务；选择主程序；过滤驱动/系统组件；只做轻量 PE 头解析 |
| `engine/pe.js` | DOS/COFF/Optional Header、节表、导入表、延迟导入、CLR/资源目录；轻量模式读 64 KB |
| `engine/analyzer.js` | 分类依赖（VC++/.NET/WebView2/DX/Vulkan/输入/音频）、目录风险（反作弊/.sys/DRM/服务）、评分 A-D、推荐引擎 |
| `engine/icons.js` + `resources/scripts/extract-icons.ps1` | Shell COM 提取 512px 图标（保留 alpha），System.Drawing 缩放；批量缓存；失败时生成品牌占位图标 |
| `engine/icns.js` | 将 PNG 组成 `icns`（icp4/icp5/icp6/ic07-ic14） |
| `engine/plist.js` | 生成 Info.plist，转义 + 版本归一化 |
| `engine/packager.js` | 创建 `.app` 结构、复制/哈希 payload、导出注册表、可选用户数据、运行时、内置引擎、图标、config.env、ZIP、README；生成稳定 bundle id / prefix id |
| `engine/resolver.js` | 从固定清单或 GitHub API 选择 Gcenx Wine 资产；下载、SHA-256 校验、缓存 |
| `engine/download.js` | curl 断点续传 + 多次重试 + 进度回调 + hash 校验 |
| `engine/recipe.js` | 版本化移植配方：导出/校验/选项还原/匹配评分；拒绝脚本、URL 与本机绝对路径 |
| `engine/drop.js` | 拖拽路径分类、应用文件夹 EXE 枚举与主程序排序（名称相似度/大小/层级/垃圾名过滤） |
| `engine/archive.js` | ZIP 安全解压（路径穿越/符号链接/加密/大小限制）、顶层应用目录识别 |
| `engine/cache.js` | 引擎/运行库/临时构建统计与白名单清理，路径包含校验 |
| `electron/main.js` | IPC、窗口、扫描/构建编排、历史、设置、诊断、配方读写、拖拽识别、缓存管理 |
| `electron/preload.js` | 最小 contextBridge API；文件路径通过 `webUtils.getPathForFile` 获取 |
| `app/app.js` | 无框架 UI、状态机、渐进式后台分析、构建进度映射、配方导入导出、拖拽遮罩、缓存卡片、演示适配器 |
| `resources/templates/launcher.sh` | macOS 运行时：引擎发现、Rosetta、prefix、payload/盘符、注册表、运行时、启动、日志/对话框 |
| `resources/templates/mac-check.command` | Mac 一键验证：系统/签名/引擎/完整性/启动检查，桌面日志与诊断 ZIP |
| `cli.js` | 无界面扫描/分析/构建，便于 CI 与批处理 |

## 3. 构建流水线

1. **校验**：安装目录存在、EXE 在目录内、拒绝磁盘根/Program Files 根级目录、输出目录不在载荷内。
2. **稳定标识**：`bundleId = com.win2mac.<publisher>-<name>.<hash>`；`buildId = sha1(bundleId)` 作为 prefix/log 稳定键。
3. **payload 复制**：遍历安装目录，跳过符号链接/目录联接；流式复制并同时 SHA-256；保留 mtime；记录 payload 相对路径（含盘符）。
4. **注册表**：`reg.exe export` 每个 uninstall key；UTF-16 `.reg`，首次启动 `wine reg import`。
5. **用户数据**（可选）：按应用名/发布者匹配 Roaming/Local 同名目录；首次启动才复制。
6. **运行时**：VC++（按 PE 架构）从 aka.ms 下载并用 Authenticode 校验 Microsoft 签名；.NET Framework 在勾选“附带 Wine Mono”时始终加入 Wine Mono，不再假设内置引擎自带。
7. **引擎**：
   - auto：固定清单 URL/sha 写入配置，构建时不下载；
   - bundled：下载/复用缓存 tar.xz，SHA-256 校验后放入 `.app`；
   - reuse：不写 URL，强制本地引擎。
8. **图标**：Shell 提取 512 → PNG 多尺寸 → ICNS；失败时使用内置 fallback。
9. **配置**：生成 shell-safe `config.env` 和 `bundle.json`；Windows 命令行解析为 argv 编号变量，避免 eval。
10. **ZIP**：yazl 写入 Unix mode 与 UTF-8 文件名，强制 ZIP64，计算 ZIP SHA-256；保留 `.app` 目录副本。

### 进度模型

`packager` 以 stage + 阶段内 percent 发事件；UI 按阶段区间映射总进度：

| stage | 总进度区间 |
|---|---|
| analyze | 0–3% |
| payload | 5–55% |
| registry | 55–61% |
| userdata | 61–64% |
| runtime | 64–78% |
| engine | 78–89% |
| icon | 89–92% |
| zip | 92–99% |
| done | 100% |

阶段内 percent 重置不会让总进度后退（`Math.max`）。

## 4. macOS 启动器

1. 读取 `Contents/Resources/win2mac/config.env`（单引号 shell 值）。
2. 引擎策略：
   - `bundled`：先解压内置/缓存 tar.xz（SHA-256 校验；`tar -xf` 失败时回退 `xz -dc | tar`）。
   - 自动/复用：按应用类型尝试 `WIN2MAC_ENGINE_ORDER`（游戏 `gptk,crossover,whisky,wine`，普通应用 `crossover,gptk,whisky,wine`），再找缓存/Homebrew；auto 最后下载固定 URL。
   - 所有外部引擎都使用本项目自己的 `WINEPREFIX`，不修改 CrossOver/Whisky 数据。
3. Apple Silicon：`arch -x86_64 true` 检测 Rosetta；GPTK/Whisky/Gcenx 为 x86_64，提示安装。
4. GPTK：设置 `WINEDLLPATH=.../lib/wine/x86_64-windows`、`DYLD_FRAMEWORK_PATH=.../lib/external`，并追加 D3D DLL override。
5. 前缀：`wineboot -u` → `wineserver -w`；标记 `.win2mac/initialized`。
6. 载荷：C: 合并到 `drive_c`；D:/F: 复制到 `drive_c/win2mac_<letter>` 并创建 `dosdevices/<letter>:`；版本变化才重新复制。
7. 环境组件：registry/runtimes 安装一次，版本 hash 变化才重装；运行时直接用 `wine <安装器>` 或 `msiexec /i` 调用（不要用 `wine start /wait "<路径>"`，start 会把首个引号参数当窗口标题）。
8. 启动：`wine <prefix-path> args...`，工作目录在安装目录内才使用，否则回退主程序目录；stdout/stderr 写日志；非零退出弹原生对话框。
9. 可诊断性：`Open-Win2Mac-App.command` 修权限/隔离；`Verify-Integrity.command` 校验 payload；`Reset-Runtime.command` 重置 prefix；`Start-Mac-Validation.command` 生成桌面日志与诊断 ZIP（系统、配置、引擎、完整性、启动日志；不含 payload）。

## 5. 0.3 新增模块

### 移植配方

- 格式：`win2mac-recipe/v1` JSON，大小上限 256 KiB。
- 内容：应用身份（名称/发布者/版本/EXE 名）、匹配信息、兼容性快照、引擎策略、运行库/用户数据开关、安装参数、预期主程序、高级运行选项、备注。
- 边界：不保存安装目录、输出目录、注册表、用户数据、下载 URL 或可执行脚本；导入后仍需本机已有应用/安装包。这样配方可安全分享，也不会变成远程执行载体。
- 流程：`buildRecipe` → `normalizeRecipe`（白名单、长度、env 名、引擎枚举）→ 主进程保存；导入时再次 normalize，渲染层只在匹配到应用后填入打包状态。
- CLI：`build --recipe` 通过 `recipeBuildOptions` 还原；显式 `--engine/--args/...` 覆盖配方。字段说明见 [RECIPE.md](RECIPE.md)。

### 压缩包导入

- 工具栏“导入 ZIP”/拖拽 `.zip`：`yauzl` 懒加载中央目录，逐条校验路径（拒绝 `..`、绝对路径、盘符前缀、NTFS 流名、符号链接、加密条目），限制 200,000 文件 / 8 GB 压缩包 / 8 GB 解压体积。
- 解压到 `%LOCALAPPDATA%\Win2Mac\imports\zip-*`，保留顶层应用目录；`findAppRoot` 复用 `drop.js` 的 EXE 评分，避免把 `resources/` 或 `bin/` 当应用根。
- 成功后应用标记 `source: archive`，重新扫描时保留；解压失败自动删除半成品。

### 拖拽导入

- 渲染层只从 `DataTransfer.files` 取第一个文件，并用 preload 的 `webUtils.getPathForFile` 获得绝对路径；不信任 `file.path`。
- 主进程按扩展/目录分类：`.msi` → 安装器；`.exe` → 应用，疑似安装器时弹三选一；目录 → `drop.js` 枚举最多 6000 项/3 层，过滤符号链接与卸载/安装/崩溃/运行库名，按 EXE 与文件夹名称相似度、体积、深度排序。
- 文件夹的 `installPath` 保持为拖入目录（而不是 EXE 所在子目录），避免漏打同目录资源；工作目录取 EXE 目录。

### 缓存管理

- 统计范围：`%LOCALAPPDATA%\Win2Mac\engines`、`runtimes`、`%TEMP%\win2mac-build-*`。
- 清理前再次解析路径并检查 `isPathInside` / 目录名前缀，不递归跟随符号链接；转换进行中直接拒绝；使用原生确认对话框。
- 不触碰任务历史、设置、已生成的 `.app`/ZIP 或 macOS 端 prefix。

## 6. 安全与隐私

- 渲染进程 `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`；CSP 限制脚本/连接为 self。
- 主进程只暴露白名单 IPC；外部链接通过系统浏览器打开。
- 所有命令 spawn 使用 argv，不执行拼接 shell；PowerShell 任务用 JSON 文件传递路径，避免引号注入。
- 扫描只读注册表/开始菜单/服务，不需要管理员权限；不发网络请求（除引擎/运行时下载）。
- VC++ 安装包下载后强制校验 Authenticode（Microsoft 签名）；Wine 资产校验 GitHub release 的 SHA-256。
- 配方导入只接受声明式选项，不执行脚本、不下载文件；拖拽路径只接受本机存在的文件/目录，疑似安装器需用户确认。
- 不做反作弊/DRM 绕过；不提供隐蔽运行、注入、修改目标进程的能力。

## 7. 测试

- `npm test`：
  - PE 头/导入表/CLR、plist、ICNS、Windows 命令行解析、路径映射、快捷方式污染防护；
  - 配方往返/拒绝非法格式与越权字段、拖拽主程序排序、缓存白名单清理；
  - **macOS 启动器模拟**：PATH 注入假 `uname`/`sw_vers`/`arch`/`osascript`/`caffeinate`/`open` 与假 Wine，执行真实模板，覆盖 Rosetta 缺失、macOS 11 门槛、首启/二启、环境变量、参数、完整性校验、Reset 非交互保护。Windows 与 macOS 共用同一测试。
  - **ZIP 导入**：真实 ZIP 解压、中文路径、顶层应用目录识别、恶意路径拒绝；打包后 smoke 验证 IPC 导入。
  - **Mac 验证收集器**：模拟执行 `Start-Mac-Validation.command`，确认桌面报告/诊断目录、Report/config/manifest/系统信息与 payload 排除。
  - **行尾回归**：模板与打包 launcher 必须为 LF；防止 CRLF 导致 macOS `bad interpreter`。
- `npm run test:e2e`：
  - 真实复制 notepad.exe 到隔离目录 + 创建临时 HKCU 测试键；
  - 构建 `.app` + ZIP，验证 manifest 哈希、plist、中文文件名、ZIP 0755；
  - 用模拟 Wine 运行启动器两次，验证 prefix 初始化一次、payload 复制一次、注册表导入、argv 传递、逐字节复制；
  - 用真实 xz 假引擎包验证内置引擎解压、缓存、Wine 路径发现、启动器使用缓存引擎；
  - 真实应用回归：Bandizip（D: 盘）构建 + 模拟启动；D: 映射后 EXE hash 与源一致。
- `.github/workflows/macos-verify.yml`：macOS 14/15 上执行 `bash -n` 与上述测试；当前工作区无 GitHub remote，托管 CI 尚未触发。
- UI：Electron offscreen 逐页截图，不弹出桌面窗口；覆盖配方导入、缓存卡片、拖拽遮罩。

## 8. 边界与后续

- 可以扩展的引擎：Sikarugir/Wineskin 的 `wswine.bundle`、Whisky 的 bottle 直接复用、CrossOver `--bottle` 模式。
- 可以扩展的载荷：MSI 管理安装提取、MSIX/Appx（Wine 仍不支持运行时，只能作为安装器提示）。
- 可以扩展的签名：在 macOS 侧调用 `codesign`/`notarytool` 的脚本生成器（Windows 无法本地签名）。
- 不应该扩展的方向：反作弊绕过、DRM 规避、内核驱动模拟、伪装官方客户端。
