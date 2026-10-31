# Win2Mac Studio 0.9.1

构建日期：2026-10-29 · Windows x64 · Electron 44.9.0

## 交付物

| 文件 | 说明 |
|---|---|
| `release/Win2Mac-Studio-Setup-0.9.1.exe` | NSIS 安装程序（未签名） |
| `release/win-unpacked-0.9.1/Win2Mac Studio.exe` | 免安装运行版（用于冒烟测试） |
| `release/Win2Mac-MacCheck-0.9.1.zip` | 可独立发送的 Mac 验证工具包 |
| `release/SHA256SUMS.txt` | 以上三者 SHA-256 |

- 安装包大小：120,890,374 bytes（约 115.3 MiB）
- 安装包 SHA-256：`e28b2028233f87b4412d71cd59f3f18516d2e955e310c86e67576842a9f44dc6`
- 便携版 EXE SHA-256：`273e59b697a797a5f75f1110471d36795ebe4dbe2d4ab77cdc74d8d812174252`
- MacCheck ZIP SHA-256：`e733ea7ce4f6d1eeed2151604e5fa00e9c5bac3476ee470e1f7fa53c9ca5c32a`
- 打包后 smoke：`version=0.9.1, bridge=true, nav=4, cacheGroups=3, ai.leaked=false`；ZIP 导入选中 `Smoke Fixture.exe`
- 真实 IPC UI 扫描 smoke：`174 apps / 174 icons / 0 pending / 0 scanError`

## 0.9.1 自查修复

- Mica 仅在 Windows 11（build ≥ 22000）启用，Win10 回退不透明背景。
- 删除废弃的 `redesign.css` / `theme-aurora.css`；设置/任务页去掉重复大标题。
- 拖拽遮罩、批量栏改为 Fluent 云母/描边；折叠按钮按下态修正。
- 打包 smoke 新增 UI 断言（主题加载 + 侧栏折叠并恢复）。

## 0.9.0 WinUI 3 / Fluent 重做

- 启用 Windows 11 Mica（`backgroundMaterial: mica`），页面使用半透明云母层 + 亚克力卡片；Win11 中性配色 + 系统蓝强调色。
- 可折叠左侧栏（236 ↔ 60px，底部按钮，状态持久化）；折叠后仅保留图标与角标。
- 顶栏回归 Win11 标题栏布局（标题/搜索/操作/窗口按钮）；页面内容全宽。
- 去掉上一版复杂阴影，卡片统一 1px 描边 + 6–8px 圆角；应用卡、设置单列、抽屉、弹窗、toast 全部 Fluent 化。

## 0.8.0 Aurora：彻底重做视觉与骨架

- 移除左侧边栏与大 Hero，改为**深蓝顶部导航**；主色由酸橙绿换成**靛蓝 + 青色**，画布改冷调浅灰。
- 应用库：紧凑页头 + 单行统计条 + 3 列卡片网格；设置页改为 1120px 单列居中，消除右栏空白。
- 抽屉/弹窗/toast/AI 面板全部换新；窗口按钮并入顶栏。批量模式保留紧凑行。

## 0.7.0 骨架重构（Studio v2.1）

- **侧栏改为 86px 图标轨道**：选中绿条、任务角标、底部状态点，导航文字改为 tooltip。
- **应用库改为 3 列卡片网格**（≤1280px 两列、≤900px 单列）：图标/名称/评级/路径 chip/架构/体积/来源/深色转换按钮；批量模式保留紧凑行。
- **Hero 改为紧凑横幅 + 四步流程面板**（扫描 → 评估 → 打包 → 验证），窄窗自动隐藏。
- 统计卡、筛选、卡片网格对齐；首屏卡片错峰入场。

## 0.6.0 界面重构（Studio v2）

- **全新视觉系统**：冷调画布 + 墨黑侧栏（分组标签、选中指示条、绿光晕）、深色 Hero 命令卡（网格纹理、绿色高亮标题、产品截图）。
- **应用库卡片流**：去掉表头，每行变独立白卡（圆角 16、hover 抬升、深色转换按钮）；窄窗自动折叠两行。
- **组件统一**：统计卡、设置卡、引擎选项、输入框、任务/兼容卡、悬浮抽屉、大圆角弹窗、sticky 模糊工具栏。
- **动效**：沿用 Emil Kowalski 规范（统一缓动/时长、按压反馈、首屏错峰、reduced-motion）。

## 0.5.4 UI 打磨

- 统一动效曲线（`--ease-out` / `--ease-drawer`）与 160–300ms 时长；按钮、行内操作按压 `scale(0.97)`。
- 应用列表首次出现 220ms 错峰淡入（24ms/行），筛选/重扫不重播；抽屉、弹窗、toast、AI 面板统一进入动画。
- 页面切换改为 180ms 纯淡入，避免频繁重渲染时的位移闪烁；toast 退出改 `.leaving` 过渡。
- 开关、引擎选项、输入框焦点、进度条/扫描条统一缓动；骨架屏 shimmer 1.1s。
- 支持 `prefers-reduced-motion`：保留颜色/透明度，关闭位移与缩放。

## 0.5.3 修复（前端 + 后端双 agent 审查）

- **安全**：`shell:open` 只能打开文件夹（防执行任意程序）；诊断包与 AI `read_file` 先 realpath 再判定越界（防目录联接/符号链接逃逸）；Mac→Win 重组校验源 `.app` 与载荷 realpath，并要求 `Contents/Info.plist`；`CFBundleExecutable` 禁止路径分隔符；settings/AI IPC 增加对象校验。
- **ZIP/打包**：`writeZip` 失败时关闭流并删除半成品；FAT64 架构步长修正；`.node` 检测读 4 KB 头；无 Framework 时从 ASAR 的 `package.json` 读取 Electron 版本。
- **前端**：动态内容补齐转义；Mac 应用转换按钮/详情分支与不可用兜底；ZIP/诊断导入防重入；AI 面板关闭后停止写 DOM；窄窗表格横向滚动。

## 0.5.2 修复

- **API Key 泄露**：`app:info` 之前把含明文的 settings 返回渲染层，现统一掩码，smoke 同时断言 `settings:get` 与 `app:info`。
- **Mac→Win ZIP 误打包其他应用**：输出目录里已有的其他应用会被塞进当前 ZIP；`writeZip` 支持只打包指定顶层目录，并新增回归。
- **Mac 应用缺少 id/评级**：导入后无法选中、无法转换；现生成稳定 id、评级、原因，并阻止 mac 应用进入 Wine 打包入口。
- **AI 修复边界**：buildId 清洗（防路径穿越）、拒绝注入式 diagnostics、并发任务保护、maxSteps≤12。
- 新增真实二进制 plist（plistlib 生成）解析测试；`patch_config` 明确提示必须 rebuild。

## 0.5.1 修复

- writeZip 先枚举再创建目标文件，避免 Mac→Windows ZIP 把自己写进包里（macOS 15 CI 抓到的 yazl 尺寸错误）。

## 0.5.0 新增

- **AI 修复 Agent（OpenAI 兼容）**：设置页填写 Base URL/模型/API Key（Key 只存本机，IPC 只回掩码）；构建完成后「AI 修复」导入 Mac 诊断 ZIP，Agent 调用白名单工具读报告/日志、改 `config.env`（Wine 调试、DLL overrides、Electron 兼容、启动参数、环境变量）、按需重建最多 2 次，输出中文结论。
- **Mac → Windows（Electron 重组）**：导入 `.app`/含 `.app` 的 ZIP；解析 XML/二进制 Info.plist、Mach-O 架构、ASAR 清单与 `app.asar.unpacked` 原生模块；按原 Electron 版本下载 `electron-v*-win32-x64.zip`（SHASUMS256 校验/缓存），替换载荷、重命名 EXE 并输出 Windows 免安装 ZIP。含 Mach-O `.node` 或非 Electron 应用明确拒绝。
- 应用库/空状态新增「导入 Mac 应用」；拖拽与 ZIP 导入自动识别 `.app`。

## 0.4.2 修复（macOS 运行时审计）

- **引擎路径被日志污染（真机致命）**：启动器在 `candidate=$(extract_engine_archive …)` 里调用 `log_line`，命令替换把日志行也捕获进 `WINE`，`wineboot` 因此返回 127、前缀初始化失败。日志改为独立 fd 3，命令替换只返回引擎路径。**内置引擎和首次下载引擎都会触发**，即 0.4.1 及更早版本在真机上大概率首次启动就失败。
- **运行库安装可能没执行**：`wine start /wait "<安装器>"` 会把首个引号参数当窗口标题，带空格的路径被吞掉；改为直接 `wine "<安装器>" <参数>`。
- **GPTK/arm64 引擎误判缺 Rosetta**：Rosetta 检查先看引擎二进制架构，arm64 引擎直接跳过。
- **引擎 URL 可能指向 .sha256**：只接受以 `.tar.xz` 结尾的下载地址，并优先 x86_64/osx64。
- **config.env 不完整时裸崩**：补齐主程序/工作目录/版本默认值并给出明确报错；`USER` 未定义不再触发 `unbound variable`。
- **E2E 注册表断言**：不再假设只导出 1 个键（本机可能已有 App Paths 等真实键）。

## 0.4.1 修复

- **ZIP/文件夹主程序识别**：`Uninstall 客源雷达.exe` 这类“卸载器 + 应用名”不再被选为主程序；`unins*`/`uninstall`/`卸载`/`setup`/`installer`/`update` 等名称统一硬排除，按名称相似度、体积、目录深度重新打分。已用真实“根目录即应用文件”的 ZIP 复现并回归。
- **macOS 启动器中文变量崩溃**：`$VAR` 紧跟中文标点会被 macOS bash 3.2 当作变量名（`WIN2MAC_APP_NAME…: unbound variable`），启动即退出。launcher/mac-check 模板全部改为 `${VAR}` 形式并新增模板断言。
- 打包 smoke 现在会构造“主程序 + 卸载器”同目录的扁平 ZIP，验证选择的是 `Smoke Fixture.exe` 而非 `Uninstall Smoke Fixture.exe`。
- smoke 模式使用独立 userData，正在运行的正式版窗口不再阻塞冒烟测试。

## 0.4.0 新增：导入 ZIP

软件里现在可以直接导入应用目录压缩包，不需要先解压：

1. 在应用库工具栏点 **“导入 ZIP”**（空状态也有入口），或把 `.zip` 直接拖入窗口。
2. 软件解压到 `%LOCALAPPDATA%\Win2Mac\imports`，自动寻找顶层应用目录和主程序，加入应用库。
3. 点该应用行右侧的 **「转换」**，或点行打开详情后点 **「一键转换为 .app」**。
4. 在打包窗口选择“内置 Wine/自动/仅复用”，开始打包，得到可拷到 Mac 的 ZIP。

> ZIP 里应该是**已解包的应用目录**（包含主程序 `.exe` 和它的 `resources` 等），不是单个安装器。安装器仍走“从安装包创建”。

安全限制：拒绝 `..`/绝对路径/盘符路径/NTFS 流名/符号链接/加密 ZIP；最多 200,000 文件、8 GB ZIP、8 GB 解压体积；失败会自动清理半成品目录。

## 0.4.0 其他改动

- 应用库每行增加直接 **「转换」** 按钮，不再必须打开右侧详情抽屉；批量模式仍显示选择箭头。
- 压缩包导入显示解压文件数与“正在识别主程序”进度；导入应用标记“压缩包导入”，重新扫描时保留。
- `yauzl`（MIT）作为 ZIP 解压依赖打包进安装包。

## Mac 端一键验证

每个转换产物根目录包含 **`Start-Mac-Validation.command`**。朋友在 Mac 上：

1. 用 Finder 解压 ZIP。
2. 双击 `Start-Mac-Validation.command`（若 Gatekeeper 拦截，右键 → 打开，或 `bash Start-Mac-Validation.command`）。
3. 等待脚本检查并尝试启动应用。
4. 把桌面的 **`Win2Mac-诊断-<时间>.zip`** 发回。

```text
~/Desktop/Win2Mac-验证日志-<时间>.log
~/Desktop/Win2Mac-诊断-<时间>.zip
```

诊断 ZIP 包含完整报告、系统/机型/CPU/显卡信息（过滤序列号等）、Info.plist、config.env、bundle.json、manifest、该应用 Wine 日志与失败时的 Integrity.log；不含应用 payload。

独立工具包：`release/Win2Mac-MacCheck-0.9.1.zip`。

## 验证结果

- 单元测试 52/52：新增“运行库直接调用、不用 start /wait”“arm64 引擎跳过 Rosetta”“服务依赖用合成 PE”等回归；ZIP 解压、恶意路径、配方/拖拽/缓存/Darwin 启动器/Mac 验证收集器/LF 行尾测试继续通过。
- E2E 通过：notepad 打包、ZIP UTF-8/0755、注册表、内置引擎、运行时下载/SHA/缓存、VC++、安装器、CLI 配方构建；新增“引擎路径不能被日志污染”断言。
- 打包后 smoke（0.9.1 便携版）：`archive.exe=Smoke Fixture.exe`、不含 `Uninstall`，`bridge=true / nav=4 / cacheGroups=3`。
- 真实 IPC 扫描：174 应用、174 图标、0 待分析、0 scanError。
- 用实际 `客源雷达` ZIP（109 文件，根目录含 210 MB 主程序与 517 KB 卸载器）复现：主程序识别为 `客源雷达.exe`。

## 安装与运行

1. 运行 `Win2Mac-Studio-Setup-0.9.1.exe`。安装包未签名，SmartScreen 可能要求“更多信息 → 仍要运行”。
2. 转换后把 ZIP 原样拷到 Mac，用 Finder 解压，双击 `Open-Win2Mac-App.command`。
3. 若朋友侧报错，让他双击 `Start-Mac-Validation.command`，把桌面诊断 ZIP 发回。

## 限制与未验证项

- 不生成原生 Mach-O；兼容性取决于 Wine。内核驱动、反作弊、DRM、Windows 服务运行、UWP/MSIX 等仍受限制。
- ZIP 导入只接受 `.zip` 和已解包应用目录；单文件安装器请用“从安装包创建”。
- **macOS 启动器尚未在物理 Mac 上启动过**。已通过假 Darwin + 假 Wine、真实 tar.xz 解压、绝对路径/权限/盘符/注册表流程与 macOS CI 工作流准备验证；Gatekeeper、Rosetta 真机提示、CrossOver/GPTK 复用仍需 Mac 冒烟。验收步骤见 [MACOS-TESTING.md](MACOS-TESTING.md)。
- 验证脚本未签名；首次双击可能需要右键打开。
- 安装包与 `.app` 均未 Developer ID 签名/公证。
- 配方只保存声明式选项；安装器模式为实验性；只导出卸载注册表键。
- 默认自动模式首次启动可能下载 Gcenx Wine（约 184 MB）；离线请选“内置 Wine”。

## 复现构建

```bat
npm install
npm test
npm run test:e2e
npm run dist
npm run mac-check
```

Electron/electron-builder 下载可能需要代理：`HTTPS_PROXY=http://127.0.0.1:7897`。若 `release\win-unpacked` 被 Windows 文件锁卡住（EPERM/EBUSY），可输出到工作区外目录：`npx electron-builder --win --config.directories.output=../win2mac-dist`。
