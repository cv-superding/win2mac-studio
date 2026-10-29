# Changelog

## 0.5.2 — 2026-10-29

### Fixed

- **API Key 泄露**：`app:info` 之前返回含明文的 settings，渲染层可直接拿到 Key；现在统一走掩码输出，smoke 同时断言 `settings:get` 与 `app:info`。
- **AI 修复边界**：buildId 清洗后用于上下文文件名（防路径穿越）；拒绝渲染层注入任意 diagnostics 对象；同时只允许一个 AI 修复任务；maxSteps 上限 12。
- **Mac 应用缺少 id/评级**：导入 `.app` 后没有 `id` 与 `analysis`，应用库无法选中；现在生成稳定 id、评级与原因，并禁止把 mac 应用送进 Wine 打包入口。
- **重建提示**：`patch_config` 现在明确告知模型必须 rebuild 才会更新 ZIP。
- 新增真实二进制 plist（plistlib 生成）解析与 .app 识别测试；ZIP 自包含回归继续保留。

## 0.5.1 — 2026-10-29

### Fixed

- **ZIP 可能包含自身**：`writeZip` 先创建目标文件再枚举目录，若 ZIP 位于输出目录内（Mac→Windows 产物），macOS 15 上会把正在写入的 ZIP 当成输入，yazl 报 “unexpected number of bytes”。现在先枚举并排除目标文件，测试断言 ZIP 内不含 `.zip`。
- 0.5.1 重新打包安装包、便携版与 MacCheck；0.5.0 已标为 pre-release。

## 0.5.0 — 2026-10-29

### Added

- **AI 修复 Agent（OpenAI 兼容）**：设置页填写 Base URL / 模型 / API Key（Key 只存本机，接口只返回掩码）。构建完成后「AI 修复」可导入 Mac 诊断 ZIP，Agent 通过白名单工具读取 `Report.json`/`Missing.txt`/启动日志、修改 `config.env` 白名单键（Wine 调试级别、DLL overrides、Electron 兼容、启动参数、环境变量等），并按需重建最多 2 次，最后输出中文结论。传输层支持 HTTP 代理（curl），请求体/响应限制大小。
- **Mac → Windows（Electron 重组）**：新增 .app 分析（XML/二进制 Info.plist、Mach-O x86_64/arm64/universal、ASAR 清单、`app.asar.unpacked` 原生模块检测）与 Windows 组装器：按原应用 Electron 版本下载 `electron-v*-win32-x64.zip`（SHASUMS256 校验、缓存），替换 `app.asar`、重命名 EXE、写入运行说明并打包 ZIP。含 macOS 原生模块或非 Electron 应用会给出明确不可行提示。
- 应用库与空状态新增「导入 Mac 应用」，拖拽/导入 ZIP 时自动识别 `.app`。

### Tests

- 单元测试 52/52：新增 OpenAI 客户端（本地 mock 服务、tool_calls、401）、Agent 工具循环/步数上限、配置白名单补丁、plist/Mach-O/ASAR 分析、原生模块降级、非 Electron 拒绝、Windows 免安装包组装。
- 打包后 smoke 增加断言：`settings.ai` 不得泄露 API Key。

## 0.4.2 — 2026-10-28

### Fixed

- **引擎路径被日志污染（真机致命）**：`candidate=$(extract_engine_archive …)` 里的 `log_line` 输出会被命令替换捕获，`WINE` 变成“日志行 + 路径”，随后 `wineboot` 返回 127、前缀初始化失败。日志改走独立 fd 3，命令替换只返回路径。内置引擎与首次下载引擎（绝大多数朋友的使用路径）此前都会中招。
- **运行时安装可能根本没有执行**：启动器用 `wine start /wait "<安装器路径>"` 安装 VC++ 等运行库，Wine/Windows 的 `start` 会把首个引号参数当作窗口标题，带空格的路径被吞掉。改为直接 `wine "<安装器>" <参数>`，随后 `wineserver -w` 等待完成。
- **Apple Silicon + GPTK 被误判缺 Rosetta**：Rosetta 检查现在先看引擎二进制架构，arm64 引擎（如 GPTK）直接跳过，不再要求安装 Rosetta。
- **首次下载引擎可能拿到 .sha256 校验文件**：自动解析 Gcenx 最新发布时，URL 必须真正以 `.tar.xz` 结尾，并优先 x86_64/osx64 资产。
- **config.env 不完整时启动器裸崩**：补充主程序/工作目录/版本号默认值与明确报错，`USER` 未定义也不再触发 `unbound variable`。

### Tests

- 单元测试 40/40：新增“运行库直接调用、不用 start /wait”“arm64 引擎跳过 Rosetta”两条回归；macOS 14/15 CI 继续跑真实 bash。

## 0.4.1 — 2026-10-28

### Added

- **Electron 白屏修复**：识别 `resources/app.asar` 或 Chromium 载荷，自动为 Electron 主程序追加 `--no-sandbox --disable-gpu --in-process-gpu`，并支持去重、高级设置自定义、CLI `--electron-flags` / `--no-electron-compat`。检测到原生 `.node` 模块时自动加入 VC++ 运行库，避免 `better-sqlite3` 等模块加载失败。
- **注册表与用户配置补全**：除卸载项外，额外导出 App Paths、`HKCU\Software\<厂商>\<产品>`、HKLM/WOW6432Node 等候选键（自动跳过不存在的键）；可选用户数据会按 Electron 包名/产品名补充 AppData。
- **Wine 用户目录合并**：启动时把 payload 中 `C/Users/<原用户>/AppData` 的设置合并进 Wine 实际用户目录，跳过 `Programs`、`Temp`、缓存等二进制/临时目录，避免覆盖或重复。
- **ADB 桥接（实验性）**：如果应用自带 macOS 版 `adb`，启动器会在宿主机启动 ADB 服务并设置 `ADB_SERVER_SOCKET=tcp:127.0.0.1:5037`，让 Wine 内的 `adb.exe`/scrcpy 通过 localhost 连接，绕开 Wine 无法直通 USB 的限制；没有 macOS adb 时仍按 D 级提示使用虚拟机。
- **失败自动诊断**：启动器从配置加载前就开始写日志，按阶段记录时间戳/返回码；失败时自动在桌面生成 `Win2Mac-失败诊断-*.zip`，内含 `Report.md` / `Report.json` / `Missing.txt` / `Repair.md`、系统/引擎/前缀/进程信息和完整日志。支持 `WIN2MAC_DEBUG=1` / `--debug` 打开详细 Wine 日志。
- **文件清单与缺失检测**：构建时生成 `payload-index.tsv/json`（SHA-256、字节数、路径）；启动前快速检查缺失/大小不一致，不通过就不下载引擎、直接给出可修复清单。
- **Mac 验证脚本升级**：`Start-Mac-Validation.command` 增加文件清单、缺失报告、引擎/环境/前缀/进程快照、`Report.json`、`Repair.md`，并以 `--debug` 启动应用。
- **USB/ADB 兼容性检测**：发现 `adb.exe`、`scrcpy`、`libusb` 时直接判 D 并推荐虚拟机——Wine 在 macOS 上无法直通 USB 设备（若存在上述 macOS adb 则尝试桥接）。
- 注册表候选生成与 Electron 检测均有独立单元测试；启动器新增兼容参数、运行时识别与用户目录合并回归测试。

### Fixed

- **ZIP/文件夹主程序误识别**：`Uninstall 客源雷达.exe` 这类“卸载器 + 应用名”文件不再参与主程序排序；`uninstall`/`unins*`/`卸载`/安装器/更新器等名称统一硬排除。真实“ZIP 内容直接在根目录”的包也已加入回归测试。
- **macOS 启动器变量解析**：`${WIN2MAC_APP_NAME}` 等变量在中文标点前统一加花括号，修复 macOS bash 报 `WIN2MAC_APP_NAME…: unbound variable` 导致首次启动直接退出的问题。新增模板变量回归断言。
- **首次打开引导**：产物 README 置顶 macOS 15/26 的“系统设置 → 隐私与安全性 → 仍要打开”步骤与终端命令；`Open-Win2Mac-App.command` 放行后会清除整个产物目录的隔离标记并修复所有 `.command` 权限，启动器与一键诊断也会顺手修复辅助脚本，避免逐个被 Gatekeeper 拦截。
- 0.4.1 重新打包安装包、便携版与 MacCheck 工具包；源码与 GitHub Actions 同步更新。

### Tests

- 单元测试 39/39：新增 Electron/ASAR/原生模块/通用 Mach-O adb 检测、ADB 桥接、缺失文件自动诊断、注册表候选、USB 阻断、启动器 Electron 参数、用户目录合并回归；E2E 与打包后 ZIP 导入 smoke 继续通过。

## 0.4.0 — 2026-10-28

### Added

- **导入 ZIP**：应用库工具栏/空状态新增“导入 ZIP”，也可直接拖入 `.zip`。软件会安全解压到 `%LOCALAPPDATA%\Win2Mac\imports`，自动定位顶层应用目录和主程序，加入应用库并进入现有分析/转换流程。
- ZIP 解压保护：拒绝路径穿越、绝对路径、盘符前缀、`..`、NTFS 流名、符号链接、加密条目；限制 200,000 个文件 / 8 GB 压缩包 / 8 GB 解压体积；失败自动清理未完成目录。
- 压缩包导入过程显示解压文件数与“正在识别主程序”进度；导入应用标记为“压缩包导入”，重新扫描时保留。
- 每行应用新增直接的「转换」按钮，不必先打开详情抽屉；批量模式下仍显示选择箭头。
- `yauzl` ZIP 解压依赖加入安装包。

### Tests

- 单元测试 20/20：新增 ZIP 解压、顶层应用目录识别与恶意路径拒绝；原 19 项继续通过。
- 打包后 smoke 增加真实 ZIP 导入（解压 → 识别 → 归档），验证新增的 yauzl/解压流程。

## 0.3.2 — 2026-10-28

### Fixed

- 验证脚本在**缺少 .app / config.env**时，`set -u` 会因未初始化的引擎变量直接退出，导致朋友看不到完整报告。现在所有配置变量预初始化，并新增“缺应用”和“payload 被改动”两条失败路径测试。
- 诊断包对 `system_profiler` 的硬件/显示器输出过滤 `Serial Number`、`Hardware UUID`、`Provisioning UDID`、`Activation Lock`，减少不必要隐私泄露。
- 启动日志检测补充 `Exited with status 1-9` 失败判定；`ditto` 打包失败时会回退到 `zip -qr`。
- 重新生成 0.3.2 安装包、便携版和 MacCheck 工具包，修复 0.3.1 产物中仍是旧验证脚本的问题。

### Tests

- 单元测试 19/19：新增无 `.app`、完整性失败两条验证脚本回归；E2E、LF 行尾、启动器模拟继续通过。

## 0.3.1 — 2026-10-28

### Added

- `Start-Mac-Validation.command` 随每个转换产物分发：双击后自动定位 `.app`，检查 macOS/Rosetta、Gatekeeper/签名、Bundle 结构、config、逐文件 SHA-256、CrossOver/GPTK/Whisky/Homebrew/Gcenx 引擎、Wine prefix 与启动日志，并尝试启动应用。
- 验证结束后在 **Mac 桌面**生成 `Win2Mac-验证日志-<时间>.log` 和 `Win2Mac-诊断-<时间>.zip`；诊断包含完整报告、系统/机型/显卡信息、应用配置与该应用日志，不包含应用 payload。Finder 会自动定位诊断 ZIP。
- 独立工具包：`npm run mac-check` 生成 `release/Win2Mac-MacCheck-0.3.1.zip`，含说明、许可提示与同一验证脚本，可单独发给朋友。
- 产物 README、完成页与真机验收文档增加日志位置和“发回诊断包”的说明。

### Fixed

- **macOS 脚本 CRLF 行尾**：launcher 与 4 个 `.command` 模板改为 LF，避免真实 Mac 上出现 `bad interpreter: /bin/bash^M`、变量尾部带 `\r` 等启动失败。新增模板与打包产物的 LF 回归断言。

### Tests

- 单元测试 18/18：新增 Mac 验证收集器（日志/诊断目录/不复制 payload）与脚本行尾回归。
- E2E 增加 `Start-Mac-Validation.command` 存在性、0755、README 指引与 launcher LF 校验。
- 之前的 16 项配方/拖拽/缓存/Darwin 启动器测试继续通过。

## 0.3.0 — 2026-10-28

### Added

- 移植配方（`win2mac-recipe/v1`）：打包窗口导出 `.win2mac.json`；应用库导入后按名称/EXE/发布者自动匹配并应用引擎、运行库、安装参数与高级选项；安装器配方会提示重新选择对应安装包。
- CLI `build --recipe`：复用同一套配方选项，显式命令行参数优先；`--no-mono` 可关闭 Wine Mono。
- 拖拽导入：支持 `.exe`、`.msi` 与应用文件夹；文件夹按名称相似度/大小/层级挑选主程序，过滤卸载器、安装器与运行库；疑似安装器的 EXE 会询问打包方式。
- 缓存与空间：设置页统计 Wine 引擎、运行库与 `win2mac-build-*` 临时目录，可分组/全部清理并打开目录；转换中拒绝清理。
- macOS 启动器验证：假 Darwin + 假 Wine 执行真实 `launcher.sh`，覆盖 Rosetta 缺失、macOS 11 门槛、首启/二启、环境变量、参数、完整性校验与三个辅助脚本；同一测试可在真实 macOS bash 运行。
- GitHub Actions `macos-verify.yml`：在 `macos-14`/`macos-15` 上做 `bash -n`、单元测试与启动器模拟。
- 设置页缓存卡片、配方提示条、拖拽遮罩；配方/缓存/拖拽截图。

### Changed

- 启动器通过 `command -v osascript` 与 `command -v arch` 发现系统工具，便于测试与异常环境重定向；行为在 macOS 上不变。
- 扫描/安装器选择复用统一的应用构造逻辑，手工 EXE 与文件夹导入的行为更一致。
- README、架构文档、调研文档同步 0.3.0 功能与 macOS 验证边界。

### Tests

- 单元测试 16/16：配方校验与路径脱敏、拖拽排序、缓存范围、macOS Darwin 启动器。
- E2E 保持通过：notepad 打包、ZIP 权限、注册表、内置/下载引擎、安装器工作流。
- 打包后 smoke 与真实 IPC 扫描由 0.2.0 的 170 应用基线继续覆盖。

## 0.2.0 — 2026-10-28

### Added

- 安装器直转（实验性）：从 `.exe`/`.msi` 生成首次运行安装的 `.app`；支持静默参数、预期主程序名、自动发现、失败重试与二次启动不重装。
- 高级运行配置：Metal HUD、DXVK HUD、自定义环境变量、启动参数覆盖、启动前完整性校验、阻止睡眠、Wine 日志级别。
- 批量转换：多选、全选当前、顺序队列、逐应用状态/日志、失败继续、停止剩余、结果汇总。
- 安装器设置和高级配置写入产物 README/`bundle.json`/`config.env`，macOS 启动器执行。
- 单元测试扩展到 11 个；E2E 增加运行时下载缓存、安装器首启工作流、高级环境/参数注入。

### Changed

- 安装器模式将安装程序放在 `payload/C/win2mac-installer`，启动器负责安装、发现和后续启动。
- 应用库新增安装包与批量入口；批量构建使用设置页默认引擎/运行时。

### Documented

- 新增 GitHub 参考（Wineskin/Sikarugir、Whisky、Porting Kit、Mythic）和安装器实验性限制。
- 明确本轮未做：Winetricks、DXVK/DXMT 打包、配方导入导出、缓存清理面板、拖放。

## 0.1.1 — 2026-10-28

### Fixed

- Windows 服务依赖从阻断 D 降为可尝试的 C，并给出功能风险提示。
- 修复 Steam `steam_api64.dll` 被误判为 DRM。
- 修复系统快捷方式（Steps Recorder / Task Manager 等）污染 Docker、Steam 游戏主程序选择。
- 支持在详情中重新指定安装目录内主程序。
- 拒绝 UNC 与 Z: 盘安装路径；超过 200,000 个应用文件时明确失败。
- .NET 应用的 Wine Mono 不再受“内置引擎”模式错误跳过。
- macOS 引擎下载支持断点续传与重试；缓存忽略未完成临时目录；tar 增加路径穿越检查。
- 构建中关闭窗口增加确认提示。
- 关闭 Electron 对外部应用目录的 asar 解析，消除扫描噪声。
- ZIP 压缩进度按文件推进。
- 输出目录选择、代理保存、扫描错误状态和手动应用添加的状态同步修复。
- 辅助脚本在非交互环境不再等待回车。

### UI

- 真实应用图标、列标题、粘性筛选栏。
- 短屏幕紧凑布局，首屏列表更多行。
- 扫描/分析错误态与重试。
- 抽屉/弹窗滚动锁定、焦点隔离与恢复。
- 主程序“更改”、高风险提示、引擎/Mono 说明。
- 1040px 最小宽度适配、任务空徽标隐藏、Hero 转化标识。

### Verified

- 9 个单元测试、E2E、VC++ 运行时、真实 170 应用/170 图标/0 挂起分析、打包后 smoke。

## 0.1.0 — 2026-10-27

- 首个可构建版本：扫描、PE/兼容性分析、原样打包、`.app`/ZIP、Wine 引擎策略、Electron UI、E2E。
