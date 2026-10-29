# Windows → macOS 一键打包调研

调研日期：2026-10-27。范围：开源同类项目、macOS Wine 运行时、Apple GPTK、CrossOver、分发与兼容边界。GitHub 数据通过 GitHub API 实时获取，运行时信息核对到具体 release 与路径。

## 1. 结论先行

1. **不存在真正的“Windows 二进制无损转成原生 Mac 程序”**。可行路径是保留原始 PE 文件，用 Wine 提供 Windows API/PE 加载环境，再套上标准 macOS `.app` 外壳。所谓“无损”只能定义为：原文件逐字节保留、卸载注册表键/启动参数/图标/目录结构完整打包、可用 SHA-256 验证；不能定义为“100% 兼容”。
2. 对普通 Win32 工具，Wine（特别是包含 DXVK/D3DMetal 的 CrossOver/GPTK 引擎）已经足够；对 D3D 游戏，Apple GPTK / CrossOver 是更优后端；对内核驱动、反作弊、DRM、Windows 服务和 UWP/MSIX，Wine 存在结构性硬限制，改用虚拟机才可能运行。
3. **构建不需要 Mac**。`.app` 是目录结构，Windows 侧可以生成 `Contents/Info.plist`、`MacOS/launcher`、`Resources/icon.icns`、payload、差量注册表、启动脚本和 ZIP（带 Unix mode）。
4. **运行时不应全部塞进仓库或每个安装包**。Gcenx Wine 是 LGPL 可再分发；Apple GPTK 与 CrossOver 是专有软件，不能重新分发，只能检测本地安装并调用。产品因此提供三种策略：自动复用/下载、内置 Gcenx、仅复用。
5. **VM 模式不值得做**：WinApps 只覆盖 Linux（KVM + FreeRDP），macOS 上 UTM/Parallels 只能跑 ARM Windows（x86 走 TCG 极慢），体积和授权不可控，也无法“一键”产出轻量 .app。MVP 聚焦 Wine 包装，兼容性页明确边界。

## 2. 同类开源项目盘点

GitHub 搜索关键词：`wine macos wrapper`、`wineskin`、`whisky wine macos`、`game porting toolkit`、`winapps windows apps linux`、`playonmac`、`win2mac` 等（stars 为查询时点）。

| 项目 | Stars | 语言/许可 | 与本项目的关系 | 可借鉴点 |
|---|---:|---|---|---|
| [Whisky-App/Whisky](https://github.com/Whisky-App/Whisky) | 原项目已归档（2025-04），活跃 fork [frankea/Whisky](https://github.com/frankea/Whisky) ~983 | Swift / GPL-3.0 | macOS 端 Wine 图形壳，每应用独立 bottle | bottle/prefix 隔离、plist 化配置、引擎版本选择 |
| [Gcenx/macOS_Wine_builds](https://github.com/Gcenx/macOS_Wine_builds) | GitHub release 11.18（2026-09-25） | Wine LGPL-2.1+ | 我们的默认可再分发引擎 | 直接下载 `wine-staging-11.18-osx64.tar.xz`，内含 Wine Staging.app 与 Wine Mono |
| [Sikarugir-App/Sikarugir](https://github.com/Sikarugir-App/Sikarugir) | Wineskin 后继（原 Gcenx/WineskinServer 301 至此） | Objective-C / LGPL-2.1（launcher 专有） | 成熟的 `.app` 包装格式 | wrapper 布局：`Contents/Frameworks/wswine.bundle` + `drive_c` + launcher |
| [vitor251093/wineskin](https://github.com/vitor251093/wineskin) | ~130 | Objective-C | 经典 Wineskin | 自包含 app、引擎与 prefix 放在 app 内 |
| [MythicApp/Mythic](https://github.com/MythicApp/Mythic) | ~1451 | Swift | GPTK 游戏启动器 | 运行时与游戏配置分离、按游戏下载/切换引擎 |
| [raymondchins/Bridgeplay](https://github.com/raymondchins/Bridgeplay) | ~580 | Scala | 把 Windows Steam 游戏塞进 Mac Steam | CrossOver Wine + GPTK 组合、Steam 入口伪装 |
| [kageroumado/sevoflurane](https://github.com/kageroumado/sevoflurane) | ~85 | Swift | Windows Steam 隐藏运行 + 原生 Mac UI | 把窗口生命周期与 Wine 进程分离 |
| [winapps-org/winapps](https://github.com/winapps-org/winapps) | ~16117 | Shell | Linux 上 VM + FreeRDP 无缝窗口 | 证明 VM 方案的复杂度与平台限制，macOS 无对应实现 |
| [PhoenicisOrg/phoenicis](https://github.com/PhoenicisOrg/phoenicis) | ~733 | Java | PlayOnLinux/PlayOnMac 5 | 安装脚本/引擎选择的产品化思路 |
| [apple/game-porting-toolkit](https://github.com/apple/game-porting-toolkit) | ~210 | Apple 专有 | GPTK 官方资源 | D3DMetal 路径与官方安装方式；不可再分发 |
| [Gcenx/game-porting-toolkit](https://github.com/Gcenx/game-porting-toolkit) | ~147 | C / 社区重打包 | GPTK 引擎来源之一 | 通过 Homebrew cask 安装 `gcenx/wine/game-porting-toolkit` |
| [installaware/AGPT](https://github.com/installaware/AGPT) | ~542 | Installer | GPTK 安装器 | 首次运行的依赖指引 |
| [domschl/WinSteamOnMac](https://github.com/domschl/WinSteamOnMac) | ~210 | Shell | Steam + GPTK 教程 | 环境变量与 prefix 操作示例 |

“win2mac”关键词的结果主要是键盘映射/文件迁移脚本，没有发现成熟的“Windows 侧生成 Mac .app”开源产品；本项目在工程形态上是空白位。

## 3. 运行时事实表

### 3.1 Gcenx Wine（默认内置/下载引擎）

- 最新 release：**11.18**（2026-09-25），资产仅 x86_64：
  - `wine-staging-11.18-osx64.tar.xz`，193,105,336 bytes，SHA-256 `b63704b91af269bc026a87f12bd297c4a50caaf570c322e600b6621ef918f127`
  - `wine-devel-11.18-osx64.tar.xz`，190,974,384 bytes
- 解包结构：`Wine Staging.app/Contents/Resources/wine/bin/wine`，内置 `share/wine/mono/wine-mono-11.3.0`（因此内置引擎的 .NET Framework 应用不需要再单独下载 Wine Mono）。
- 要求 macOS 10.15+（本项目保守设为 11.0），Apple Silicon 需 Rosetta 2；媒体应用还需要 GStreamer。
- 许可：Wine LGPL-2.1+，可随应用分发；构建资产来自 GitHub release，本项目在 Windows 侧下载/校验后把 `.tar.xz` 原样放入 `.app`，macOS 首次运行时解压到 `~/Library/Application Support/Win2Mac/engines/`。
- 为什么不直接解压到 Windows 再拷贝？Windows 默认不允许普通用户创建符号链接，tar 内的符号链接会损坏；保留 `.tar.xz` 并在 macOS 端解压最稳。

### 3.2 Apple Game Porting Toolkit（GPTK）

- 官方只通过 Apple Developer 下载 DMG（`developer.apple.com/games/game-porting-toolkit/`），没有官方 Homebrew cask；社区安装方式：`brew install --cask gcenx/wine/game-porting-toolkit`（3.0-3，macOS 14+，需 Rosetta）。
- 路径：`/Applications/Game Porting Toolkit.app/Contents/Resources/wine/bin/wine64`；D3DMetal 位于 `.../wine/lib/external/D3DMetal.framework`；DLL 位于 `.../wine/lib/wine/x86_64-windows`。
- 关键 env（社区实践，本项目启动器已按此设置）：
  - `DYLD_FRAMEWORK_PATH=".../wine/lib/external"`
  - `WINEDLLPATH=".../wine/lib/wine/x86_64-windows"`
  - `WINEDLLOVERRIDES` 追加 `d3d9,d3d10core,d3d11,d3d12,d3d12core=n`
  - `WINEPREFIX` 指向项目自己的前缀
- **不可再分发**，因此本项目只检测本地是否安装，绝不把 GPTK 二进制塞进安装包。游戏类应用优先 `gptk,crossover,whisky,wine` 顺序。

### 3.3 CrossOver

- 商业 Wine 发行版（CodeWeavers，14 天试用），路径 `/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine`。
- 官方推荐 `wine --bottle <name> --cx-app <exe>`；bottle 在 `~/Library/Application Support/CrossOver/Bottles/<name>`；D3DMetal 通过 GUI 高级设置或 bottle 根 `cxbottle.conf` 的 `WINED3DMETAL=1` / `WINEDXVK=0` 开启。
- 本项目把它当作“用户已安装的高兼容引擎”直接复用其 Wine 二进制与自有 prefix；不复制其文件、不修改其 bottle。若用户需要完整 CrossOver 语义，可在 CrossOver 里单独建 bottle。
- 许可：商业；不可再分发。

### 3.4 Whisky（活跃 fork）

- 原 Whisky 已归档；`frankea/Whisky` 活跃（GPL-3.0）。App 3.7.0，默认引擎 v3.1.1（Wine 11.0，约 332 MB）；beta v4.6.4-beta.1（Wine 11.16 + GPTK，含不可再分发的 D3DMetal）。
- 引擎目录：`~/Library/Application Support/com.isaacmarovitz.Whisky/Libraries/Wine/bin/wine64`（本项目已检测此路径）。
- 可用于启动器复用；打包时同理不可复制其 GPTK 组件。

### 3.5 WineHQ / Homebrew

- WineHQ macOS 官方包停在 5.0/5.7（Intel，32+64 位，无 ARM）。`brew install --cask wine-stable` 实际是 Gcenx 11.0_1，x86_64，路径 `/Applications/Wine Stable.app/Contents/Resources/wine/bin/wine64`；32 位通过 i386 PE/WoW64，Apple Silicon 需 Rosetta。
- 因此启动器也检测 `/Applications/Wine Staging.app`、`Wine Stable.app`、Homebrew `wine64`。

### 3.6 运行时选择矩阵

| 运行时 | 常规 Win32 | DX9-11 | DX12 | 反作弊/内核 | 许可 | 本项目处理 |
|---|---|---|---|---|---|---|
| Gcenx Wine 11.18 | 好 | 需 DXVK/有限 | 有限 | 不可 | LGPL，可分发 | 可内置/下载 |
| CrossOver 24+ | 好 | D3DMetal | D3DMetal | 不可 | 商业，不可分发 | 仅检测复用 |
| Apple GPTK 2/3 | 部分 | 最佳 | 最佳 | 不可 | Apple 专有，不可分发 | 仅检测复用 |
| Whisky fork | 好 | 取决于引擎 | 有限 | 不可 | GPL-3.0 | 仅检测复用 |
| UTM/Parallels VM | 完整 | 取决于 guest | 取决于 guest | 可能（有风险） | 各自商业/开源 | 不做代码集成，仅文档建议 |

## 4. 架构决策

### 4.1 为什么在 Windows 侧生成 `.app` 目录

`.app` 本质是目录：`Info.plist` + `MacOS/` + `Resources/`。在 Windows 上可以直接写目录并用 ZIP 的 Unix mode 保存执行位，不需要 macOS 构建机。这样产品可以完全本地化：

```
.app/
  Contents/
    Info.plist
    PkgInfo
    MacOS/launcher                 # bash 启动器 0755
    Resources/icon.icns
    Resources/win2mac/
      config.env                   # shell-safe 配置
      bundle.json                  # 机器可读元数据
      manifest.sha256              # 逐文件校验
      payload/C/Program Files/App/...
      payload/D/...
      registry/*.reg               # reg.exe export（UTF-16）
      runtimes/*                   # VC++ / Wine Mono（可选）
      engine/*.tar.xz              # Gcenx（可选）
```

### 4.2 启动器（macOS 端）

1. 发现引擎：内置/缓存 → 用户环境变量 → 按应用类型排序的 CrossOver/GPTK/Whisky/Wine（Homebrew、Wine Staging）。
2. Apple Silicon 上按引擎架构自动检查 Rosetta 2；GPTK 按 D3DMetal 约定设置 `WINEDLLPATH`、`DYLD_FRAMEWORK_PATH` 和 DLL override。
3. 独立前缀：`~/Library/Application Support/Win2Mac/prefixes/<stable-id>`。
4. 首次运行：`wineboot -u` → 复制 payload（C: 映射 `drive_c/`，D:/F: 映射 `drive_c/win2mac_D` 并建立 `dosdevices/d:` 符号链接）→ `wine reg import` → 安装 VC++/Mono → 复制可选用户数据 → 写版本标记。
5. 启动 EXE：参数从 Windows 命令行解析为 argv，避免二次 shell 解析；工作目录限制在安装目录内（跨目录依赖会给出显式警告）。
6. 所有输出写入 `~/Library/Logs/Win2Mac/<id>.log`；失败弹原生对话框并可打开日志。
7. 延迟可写：之后的启动只做引擎发现 + EXE 启动，不重复初始化。

### 4.3 完整性

- 构建时逐文件流式 SHA-256（同时复制），写入 `manifest.sha256`；`.app` 内置 `Verify-Integrity.command`。
- 注册表由 `reg.exe export` 生成 `.reg`，首次启动通过 `wine reg import` 恢复；保持 D:/F: 等原始盘符，避免重写路径。
- ZIP 使用 yazl 写入 `external_attr` Unix mode（launcher/`.command` 0755，其余 0644），并强制 ZIP64。Windows 资源管理器解压会丢执行位，因此说明和“修复”脚本明确要求在 macOS 用 Finder 解压。

### 4.4 默认策略

- 自动：优先复用 Mac 已有 CrossOver/GPTK/Whisky；缺失时首次运行下载 Gcenx Wine 11.18；安装包最小。
- 内置：构建时下载并 SHA-256 校验 Gcenx 资产，把 `.tar.xz` 放进 `.app`，离线可运行；体积约 +184 MB。
- 仅复用：不下载、不内置，目标 Mac 必须已有引擎。
- 不内置 GPTK/CrossOver；许可证不允许。

### 4.5 安全取舍

- 所有子进程使用 argv 数组，不拼接 shell 命令；PowerShell 脚本通过临时 JSON 文件传参。
- VC++ redist 来自微软 `aka.ms`，下载后调用 `Get-AuthenticodeSignature` 校验签名主体包含 Microsoft；校验失败不打包。
- 不绕过反作弊/DRM，不提供任何规避检测功能。
- 启动器脚本使用单引号配置、数组间接展开，避免参数注入；应用名/路径通过 `osascript` argv 传递。

## 5. 兼容性边界

- Wine 是 API 转译层，不是 CPU 模拟器；x86/x64 Windows PE 在 x86_64 或 Rosetta 下执行。
- **无法**：加载 Windows 内核驱动（.sys）、运行带内核反作弊的在线游戏、绕过 DRM/激活服务、运行 Windows 服务/UWP/MSIX 程序、部分 WebView2/IE 插件、把 USB 设备直通给 Windows 程序（ADB/手机投屏/加密狗/串口）。依赖服务的应用仍可能启动，但相关功能会缺失（分级为 C 并提示；USB 依赖直接判 D）。
- **可能需要调校**：.NET Framework（Wine Mono/winetricks）、DX11/12（D3DMetal）、32 位（WoW64）、多媒体（GStreamer）、字体/DPI、COM 组件。
- **通常可运行**：普通 x64 Win32 GUI 工具、开源桌面应用、无特殊驱动的便携程序。
- 这些边界在 UI 的 A/B/C/D 分级、详情原因列表、兼容性页和产出的 README 中一致呈现。

## 6. macOS 分发事实

- 未签名 `.app` 下载后带 `com.apple.quarantine`，首次启动被 Gatekeeper 拦截。
- macOS 14 及更早：右键 → 打开。**macOS 15+ 右键打开往往不再可用**，需“系统设置 → 隐私与安全性 → 仍要打开”，或 `xattr -dr com.apple.quarantine Foo.app`。
- `codesign --force --deep --sign - Foo.app` 只能做 ad-hoc 签名，不绕过 Gatekeeper/公证；Apple Silicon 上原生 arm64 二进制至少需要 ad-hoc 签名，但我们打包的 launcher 是脚本，Wine 引擎是解压到 App Support 的 x86_64 二进制。
- ZIP 的 Unix mode 只在解压工具尊重 `external_attr` 时恢复；macOS Finder/Archive Utility、ditto 可以，Windows 资源管理器不行。因此产品内提供 `Open-Win2Mac-App.command` + 手动 `chmod/xattr` 说明。

## 7. 对本产品的直接取舍

| 问题 | 选择 | 原因 |
|---|---|---|
| 是否生成原生 Mach-O | 否 | 无源码无法重编译；Wine 是唯一现实路径 |
| 是否做 VM 模式 | 否 | 体积/性能/授权不可控；WinApps 模式不适用 macOS |
| 引擎放哪 | 默认系统级缓存或 app 内 tar.xz | 多应用复用、避免 Windows 解压符号链接失败 |
| 是否内置 GPTK | 否 | Apple 专有，不可再分发 |
| 注册表 | 导出原 key + 原盘符映射 | 保持应用路径语义，不做有损重写 |
| 兼容性宣称 | 分级 + 原因 + 已知限制 | 不把 Wine 兼容性包装成“100% 无损” |
| 构建位置 | Windows 本地 | 用户无需 Mac 构建机；.app 是目录 |
| 默认引擎 | 自动复用优先 | 尊重用户已购买/已安装的 CrossOver/GPTK |

## 8. 验证记录（本机，2026-10-27）

- 扫描真实 Windows 11：170 个可转换条目（过滤驱动包/系统组件后），含注册表、开始菜单、服务信息。
- 真实应用 Bandizip：103 个文件 / 23 MB / 1 个注册表键，成功生成 `.app` + ZIP；模拟启动验证 D: 盘映射后文件 SHA-256 与源一致。
- E2E：模拟 Wine 首次/二次启动；验证 prefix 初始化、payload 只复制一次、注册表导入、argv 参数、ZIP Unix mode 0755、中文文件名 UTF-8 标志。
- E2E：用真实 `.tar.xz` 引擎包路径（假引擎内容）验证内置引擎解压、缓存、Rosetta 前置检查逻辑可执行路径发现。
- 单元测试：PE 解析、plist 转义、ICNS、命令行解析、路径映射、快捷方式污染防护。

## 9. 主要来源

- [Gcenx macOS_Wine_builds releases](https://github.com/Gcenx/macOS_Wine_builds/releases/tag/11.18)
- [Whisky 原仓库（已归档）](https://github.com/Whisky-App/Whisky) / [活跃 fork](https://github.com/frankea/Whisky)
- [Sikarugir](https://github.com/Sikarugir-App/Sikarugir) / [WineskinServer 重定向](https://github.com/Gcenx/WineskinServer)
- [Apple Game Porting Toolkit](https://developer.apple.com/games/game-porting-toolkit/) / [apple/game-porting-toolkit](https://github.com/apple/game-porting-toolkit)
- [CrossOver 高级设置](https://support.codeweavers.com/en_US/advanced-settings-in-crossover-mac-26) / [环境变量文档](https://support.codeweavers.com/advanced-crossover-mac-configuration)
- [winapps](https://github.com/winapps-org/winapps) / [UTM d3dmetal-native（D3DMetal 不可捆绑）](https://github.com/utmapp/d3dmetal-native)
- [Ars Technica：macOS 15 Gatekeeper 变化](https://arstechnica.com/gadgets/2024/08/macos-15-sequoia-makes-you-jump-through-more-hoops-to-disable-gatekeeper-app-checks/)
- [WineHQ Wine Mono 11.3.0](https://dl.winehq.org/wine/wine-mono/11.3.0/)


## 10. 0.2 功能参考（2026-10-28）

0.2.0 的功能取舍参考了以下项目的实际产品形态：

- **Wineskin / Sikarugir**：Wrapper 内置“Install Software”工作流、D3DMetal/DXVK 开关、配置与测试运行。本项目实现了实验性“安装器直转”与高级运行参数；未内置 DXVK/D3DMetal 二进制（许可证与引擎差异）。
- **Whisky（活跃 fork）**：Metal HUD、DXVK/DXMT、启动器兼容、SDL 手柄环境变量、稳定性诊断。对应本项目的高级 Metal/DXVK HUD、自定义环境变量与诊断导出基础。
- **Porting Kit**：安装脚本、应用安装器一键 port。对应本项目的 EXE/MSI 安装器模式和预期主程序发现；尚未实现社区配方/安装脚本库。
- **Mythic**：手动导入、游戏库管理、按游戏配置。对应本项目的批量队列与后续配方管理方向。
- **Wineskin 的 D3DMetal/DXVK 提示**也说明：图形后端强依赖用户本机引擎；本项目保持“只检测复用 GPTK/CrossOver，不再分发”的边界。

本轮未做、留待后续：Winetricks 集成、DXVK/DXMT 引擎打包、配方（recipe）导入导出、拖放边栏与缓存清理面板。

## 11. 0.3 功能参考（2026-10-28）

本轮补齐社区配方、拖拽与缓存管理，参考了以下实现：

- **Lutris 安装脚本**：声明式 YAML，包含 `files`、`installer` 步骤、`exe`/`working_dir`/`args`、环境变量与 winetricks，本地脚本用 `lutris -i file.yaml` 导入。它证明了“可分享的声明式移植配置”价值，也暴露了风险：脚本可下载任意文件、执行任意命令。本项目因此只保存**选项与匹配信息**，不保存脚本/URL，导入不会自动执行任何内容。
- **Wineskin / Porting Kit**：配置与引擎都在 wrapper 内部，Porting Kit 以“port”形式分发安装流程。对应本项目的 `.app` 内 `config.env` + 外层可分享配方；仍不内置 D3DMetal/DXVK（许可证/引擎差异）。
- **Bottles 依赖清单**：版本化 manifest 描述运行库与安装步骤；本项目用 `win2mac-recipe/v1` 的 `format` 字段做版本门禁，未知版本明确拒绝。
- **Whisky / Mythic**：按应用/游戏保存运行配置、批量库管理；对应本项目的批量队列与配方匹配。
- **拖拽导入**：参考现代打包工具的“拖入即分析”交互；文件夹主程序选择采用名称相似度 + 大小 + 深度 + 垃圾名过滤，灵感来自 scanner 的快捷方式评分。
- **缓存面板**：Wineskin Winery / Whisky 的引擎与 bottle 缓存管理；本项目增加路径白名单与转换中保护，避免误删用户应用数据。

仍留待后续：社区配方仓库与签名、Winetricks 集成、DXVK/DXMT 二进制打包、真实 Mac 上的 Gatekeeper/CrossOver/GPTK 冒烟。macOS GitHub Actions 工作流已提供，但需推送到 GitHub 才会实际运行。

参考链接：

- [Lutris installers 文档](https://github.com/lutris/lutris/blob/master/docs/installers.rst)
- [Lutris 示例脚本（The Witcher 2）](https://github.com/gabor-udvari/lutris-installers/blob/main/the-witcher-2.yaml)
- [Porting Kit / Wineskin](https://www.portingkit.com/newwineskin)
- [Whisky](https://github.com/Whisky-App/Whisky)
- [Sikarugir](https://github.com/Sikarugir-App/Sikarugir)
- [Bottles](https://github.com/bottlesdevs/Bottles)

## 12. 真实安装包/应用包解剖（2026-10-28）

本轮直接对照 macOS 应用包、Electron 产物与 Windows 安装器的实际结构，并把差异落到打包器中。

### 12.1 macOS `.app`

- Apple 文档定义的标准结构是 `Foo.app/Contents/{Info.plist,MacOS/,Resources/}`；`Info.plist` 文件名大小写敏感，`Contents/MacOS/` 放主可执行文件，`Contents/Resources/` 放资源。对应本项目 `engine/plist.js` 与 `engine/packager.js` 的目录生成。
- Apple 文档把 `.app` 描述为“编译后可执行代码”的封装；本项目的 `Contents/MacOS/launcher` 是带 shebang 的 bash 脚本。LaunchServices 实际可以执行它，但它不是 Apple 推荐的二进制主程序，`codesign --deep` 对脚本主程序的签名也有限，因此产物始终需要 Gatekeeper 手动放行。
- Wineskin/Sikarugir/Whisky 的 wrapper 都把完整 Wine prefix 放在 `.app/Contents/Resources/` 内（如 `drive_c`、`wineskin`/`Wineskin.app`）；本项目选择把 prefix 放在 `~/Library/Application Support/Win2Mac/prefixes/<bundleId>`，`.app` 只带 payload 与启动器，避免每次重建复制数 GB 的 prefix。

### 12.2 Electron for Windows 的真实目录

- 典型安装目录：`App.exe`、`resources/app.asar`、`resources/app.asar.unpacked/`（原生模块）、`locales/`、`chrome_100_percent.pak`、`icudtl.dat`、`ffmpeg.dll`、`vk_swiftshader.dll`、`d3dcompiler_*.dll`；ASAR 官方文档明确 macOS 位于 `Contents/Resources/app.asar`、Windows 位于 `resources/app.asar`。
- 业务代码在 `app.asar` 里，主进程可能读取 `package.json` 的 `name`/`productName`；原生 `.node` 模块必须与 Electron ABI 匹配，Wine 只能加载 Windows 版 `.node`（不能换成 macOS 版）。
- 已知 Wine 兼容问题：Electron 在 Wine 中常因 Chromium sandbox/GPU 进程白屏或崩溃。CrossOver 社区与多个案例使用 `--no-sandbox --disable-gpu --in-process-gpu`。本项目 `engine/electron.js` 检测 ASAR/Chromium 载荷，启动器自动追加这些参数，并允许 `WIN2MAC_ELECTRON_COMPAT=0` 关闭。
- 真实案例（本次测试的“客源雷达”）：Electron x64 + `better-sqlite3` + `@yume-chan/adb` + 自带 `adb.exe`/scrcpy。UI 层可通过上述参数启动，但 ADB/scrcpy 依赖 USB 设备访问，Wine 在 macOS 上无法直通，属于产品边界而非打包 bug。

### 12.3 Windows 安装器留下的足迹

- MSI：在 `HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall\<ProductCode>` 写入 `DisplayName`、`DisplayVersion`、`Publisher`、`InstallLocation`、`DisplayIcon`、`UninstallString`、`EstimatedSize` 等（Microsoft Learn 的 Uninstall Registry Key 文档逐项列出）。
- NSIS/Inno Setup：同样写 Uninstall 键，还常写 `HKCU\Software\<厂商>\<产品>`、`HKLM\SOFTWARE\WOW6432Node\<厂商>\<产品>`、`App Paths\<exe>`、文件关联/COM CLSID、`Run` 自启动；配置与授权多在 `%APPDATA%`、`%LOCALAPPDATA%`、`%PROGRAMDATA%`。
- 因此本项目从“只导出卸载键”扩展为：卸载键 + App Paths + 厂商 HKCU/HKLM 候选键（`engine/registry.js`，缺失键自动跳过），并把 payload 里的 `C/Users/<原用户>/AppData` 合并进 Wine 实际用户目录（跳过 `Programs`/`Temp`/缓存，避免复制二进制）。

### 12.4 USB、驱动与服务

- Wine 的 USB 支持长期停留在实验阶段：WineUSB 自 Wine 6 起只有早期 stub（依赖 libusb），macOS 构建也没有可用的 USB 设备直通；Windows 程序通过 WinUSB/libusb 访问 ADB 设备、加密狗、串口设备时通常直接失败。本项目在 `engine/analyzer.js` 检测 `adb.exe`、`scrcpy*.exe`、`libusb*.dll` 并判 D、推荐虚拟机。
- 唯一的例外是 ADB：adb 客户端支持 `ADB_SERVER_SOCKET`，scrcpy 也通过 adb server 工作而不是直接访问 USB。若应用自带 macOS 版 `adb`（本次测试的“客源雷达”即如此），启动器可执行该 Mach-O 二进制启动宿主机 ADB 服务，再让 Wine 内的 `adb.exe`/scrcpy 通过 `tcp:127.0.0.1:5037` 连接（`engine/electron.js` 的 `findHostAdb` + 启动器 `start_host_adb_bridge`）。该桥接不保证所有应用都识别环境变量，因此仍标记为实验性。
- Windows 内核驱动（`.sys`）与内核反作弊无法在 Wine 加载；Windows 服务不会由 Wine 运行，依赖服务的应用降为 C。Gcenx Wine 缺少 GStreamer 时通常只影响媒体播放，不影响启动。

### 12.5 分发事实

- 未公证的 `.app` 从网络下载后带 `com.apple.quarantine`；macOS 15+ 的右键→打开被取消，只能在“系统设置 → 隐私与安全性 → 仍要打开”放行，或 `xattr -dr com.apple.quarantine`。Apple 支持文档与 Ars Technica 的实测均确认这一点。
- ad-hoc `codesign -s -` 不能满足 Gatekeeper/公证要求；要真正“双击即开”必须 Apple Developer ID 签名 + 公证，这超出本项目范围。产物因此提供 `Open-Win2Mac-App.command` 与详细中文说明。

参考链接：

- [Apple：Bundle Types（.app 结构）](https://developer.apple.com/library/archive/documentation/CoreFoundation/Conceptual/CFBundles/BundleTypes/BundleTypes.html)
- [Electron：ASAR Archives](https://www.electronjs.org/docs/latest/tutorial/asar-archives)
- [Microsoft Learn：Uninstall Registry Key](https://learn.microsoft.com/en-us/windows/win32/msi/uninstall-registry-key)
- [Apple 支持：打开未验证的 App](https://support.apple.com/en-us/102445)
- [WineUSB 早期实现报道](https://www.cnbeta.com.tw/articles/tech/968837.htm)
- [scrcpy（ADB/USB 依赖）](https://github.com/Genymobile/scrcpy)
