# Win2Mac Studio 0.4.0

构建日期：2026-10-28 · Windows x64 · Electron 44.9.0

## 交付物

| 文件 | 说明 |
|---|---|
| `release/Win2Mac-Studio-Setup-0.4.0.exe` | NSIS 安装程序（未签名） |
| `release/win-unpacked-0.4.0/Win2Mac Studio.exe` | 免安装运行版（用于冒烟测试） |
| `release/Win2Mac-MacCheck-0.4.0.zip` | 可独立发送的 Mac 验证工具包 |
| `release/SHA256SUMS.txt` | 以上三者 SHA-256 |

- 安装包大小：120,839,185 bytes（约 115.2 MiB）
- 安装包 SHA-256：`7577d2e469d2866550a11a2f1cad563efedcbd60164f43b3aebc89fa2eb1a210`
- 便携版 EXE SHA-256：`b5b6c444593769f48e2416257107abe5ab18613c7b743b74b4822427d0249a51`
- MacCheck ZIP SHA-256：`5cf783e8e78826a99203ef7a6e138ec55e21ca1c3e4f36c786b1c55b22dc2fe8`
- 打包后 smoke：`bridge=true, nav=4, version=0.4.0, electron=44.9.0, cacheGroups=3, drop=app, archive=app`
- 真实 IPC UI 扫描 smoke（打包后的 exe）：`172 apps / 172 icons / 0 pending / 0 scanError`
- `release/win-unpacked/`（0.2.0）、`win-unpacked-0.3.0/`、`0.3.1/`、`0.3.2/` 为历史便携版；0.4.0 请使用 `win-unpacked-0.4.0/`。

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

独立工具包：`release/Win2Mac-MacCheck-0.4.0.zip`。

## 验证结果

- 单元测试 20/20：新增 ZIP 解压、中文路径、顶层应用目录识别、恶意路径拒绝；原有配方/拖拽/缓存/Darwin 启动器/Mac 验证收集器/LF 行尾测试继续通过。
- E2E 通过：notepad 打包、ZIP UTF-8/0755、注册表、内置引擎、运行时下载/SHA/缓存、VC++、安装器、CLI 配方构建。
- 打包后 smoke 增加真实 ZIP 导入（解压 → 识别 → `source=archive`）；便携版 smoke 也通过。
- 真实 IPC 扫描：172 应用、172 图标、0 待分析。
- 用实际 `客源雷达` 目录生成 109 文件 / 453 MB ZIP，解压后 109 文件完整、主程序与 `resources/app.asar` 存在。

## 安装与运行

1. 运行 `Win2Mac-Studio-Setup-0.4.0.exe`。安装包未签名，SmartScreen 可能要求“更多信息 → 仍要运行”。
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

Electron/electron-builder 下载可能需要代理：`HTTPS_PROXY=http://127.0.0.1:7897`。
