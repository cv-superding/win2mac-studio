# Win2Mac Studio 0.4.1

构建日期：2026-10-28 · Windows x64 · Electron 44.9.0

## 交付物

| 文件 | 说明 |
|---|---|
| `release/Win2Mac-Studio-Setup-0.4.1.exe` | NSIS 安装程序（未签名） |
| `release/win-unpacked-0.4.1/Win2Mac Studio.exe` | 免安装运行版（用于冒烟测试） |
| `release/Win2Mac-MacCheck-0.4.1.zip` | 可独立发送的 Mac 验证工具包 |
| `release/SHA256SUMS.txt` | 以上三者 SHA-256 |

- 安装包大小：120,839,556 bytes（约 115.2 MiB）
- 安装包 SHA-256：`0825402cd39a1e867f4784ada31e3d8cc839687b9fec5535df1e73f743460947`
- 便携版 EXE SHA-256：`e3ad8291b40ba11c62fdef426fc82dc3f92db09c471f3eef16a9f259ca258ce1`
- MacCheck ZIP SHA-256：`1f44724785b42faf0302f04951f7f265fc8689530eca59ab942634c0e6dab4ce`
- 打包后 smoke：`bridge=true, nav=4, version=0.4.1, electron=44.9.0, cacheGroups=3, drop=app, archive=Smoke Fixture.exe`
- 真实 IPC UI 扫描 smoke（打包后的 exe）：`172 apps / 172 icons / 0 pending / 0 scanError`
- `release/win-unpacked/`（0.2.0）与 `win-unpacked-0.3.x/`、`0.4.0/` 为历史便携版；0.4.1 请使用 `win-unpacked-0.4.1/`。

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

独立工具包：`release/Win2Mac-MacCheck-0.4.1.zip`。

## 验证结果

- 单元测试 21/21：新增卸载器主程序排除、扁平 ZIP 根目录、`${VAR}`+中文标点模板断言；ZIP 解压、恶意路径、配方/拖拽/缓存/Darwin 启动器/Mac 验证收集器/LF 行尾测试继续通过。
- E2E 通过：notepad 打包、ZIP UTF-8/0755、注册表、内置引擎、运行时下载/SHA/缓存、VC++、安装器、CLI 配方构建。
- 打包后 smoke（0.4.1 便携版）：`archive.exe=Smoke Fixture.exe`、不含 `Uninstall`，`bridge=true / nav=4 / cacheGroups=3`。
- 真实 IPC 扫描：172 应用、172 图标、0 待分析、0 scanError。
- 用实际 `客源雷达` ZIP（109 文件，根目录含 210 MB 主程序与 517 KB 卸载器）复现：修复后主程序识别为 `客源雷达.exe`。

## 安装与运行

1. 运行 `Win2Mac-Studio-Setup-0.4.1.exe`。安装包未签名，SmartScreen 可能要求“更多信息 → 仍要运行”。
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
