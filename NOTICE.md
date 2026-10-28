# Third-party notices

Win2Mac Studio 本身采用 MIT 许可证。以下组件/服务由第三方提供，遵循各自许可证：

## Wine / Gcenx macOS builds

- Wine: <https://www.winehq.org/> — GNU Lesser General Public License 2.1 or later.
- Gcenx macOS Wine builds: <https://github.com/Gcenx/macOS_Wine_builds> — Wine staging/devel 构建，Wine LGPL-2.1+。
- 本项目不把 Wine 源码纳入仓库；构建时从项目 GitHub release 下载 `.tar.xz`，校验 SHA-256 后原样写入用户生成的 `.app`。分发这些构建时请遵守 LGPL 的源码提供要求。
- Gcenx Wine 11.18 内置 Wine Mono 11.3.0（<https://dl.winehq.org/wine/wine-mono/>，MIT/LGPL 视组件而定）。

## Apple Game Porting Toolkit / D3DMetal

- <https://developer.apple.com/games/game-porting-toolkit/> — Apple 专有软件，仅可通过 Apple Developer 获取。
- 本项目只检测用户本机是否安装了 GPTK，并调用其 Wine/D3DMetal；**不会复制、重新打包或再分发**。
- D3DMetal、MetalFX 等归 Apple Inc. 所有。

## CrossOver

- <https://www.codeweavers.com/crossover> — CodeWeavers 商业软件，需用户自行购买/安装。
- 本项目只调用已安装的 CrossOver Wine 二进制，使用独立前缀；不复制其文件、不修改其 bottle、不再分发。

## Whisky

- 原项目 <https://github.com/Whisky-App/Whisky>（GPL-3.0，已归档），活跃 fork <https://github.com/frankea/Whisky>（GPL-3.0）。
- 本项目只检测其 Wine 库路径；不包含其源码。若复用其 GPTK 引擎，遵守 Apple 的专有许可。

## Wineskin / Sikarugir

- <https://github.com/Sikarugir-App/Sikarugir> — Wineskin 后继；Wineskin 代码 LGPL-2.1；其 launcher/模板可能为专有。本项目的 `.app` 结构为独立实现，未复制其模板。

## Microsoft redistributables

- Visual C++ Redistributable 来自 `aka.ms/vs/17/release/`；下载后通过 Authenticode 校验签名主体为 Microsoft Corporation。分发遵循 Microsoft 的可再分发条款。
- Windows 应用、图标、商标归各自发布者所有。本工具不授予任何 Windows 应用的再分发权。

## npm dependencies

- Electron — MIT
- electron-builder — MIT
- yazl — MIT
- yauzl — MIT
- pend — MIT
- buffer-crc32 — MIT
- puppeteer-core（仅开发截图辅助）— Apache-2.0

## 参考项目与文档

调研引用的项目、版本、路径与许可证汇总见 [docs/RESEARCH.md](docs/RESEARCH.md)。
