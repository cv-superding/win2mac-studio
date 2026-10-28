# macOS 真机验收清单

当前项目在 Windows 上完成构建，并用“假 Darwin + 假 Wine”执行真实启动器；托管 macOS CI 工作流也已提供。以下是仍建议在**任意一台真实 Mac**（Intel 或 Apple Silicon）上做的最终验收，通常 10–15 分钟。

## 最快路径：一键诊断

每个转换产物的根目录都有 `Start-Mac-Validation.command`。让朋友：

1. 用 Finder 解压 Win2Mac 生成的 ZIP（不要用 Windows 资源管理器）。
2. 双击 `Start-Mac-Validation.command`；若被 Gatekeeper 拦截，右键 → 打开，或运行 `bash Start-Mac-Validation.command`。
3. 等验证结束，Finder 会定位到桌面的诊断包。
4. 把 **`~/Desktop/Win2Mac-诊断-<时间>.zip`** 发回。

日志全文在 **`~/Desktop/Win2Mac-验证日志-<时间>.log`**。如果首次启动正在下载 Wine（约 184 MB），30 秒内可能还没进入应用；等窗口出现后再双击一次验证脚本，以收集最终日志。

也可以只发送独立工具包：`npm run mac-check` 生成 `release/Win2Mac-MacCheck-<version>.zip`，朋友解压后把 `.app` 拖到脚本上即可。

## 1. 拷贝与解压

1. 把 `release/Win2Mac-Studio-Setup-0.4.0.exe` 生成的 ZIP 原样拷到 Mac（不要经过会重写文件的同步盘）。
2. 用 **Finder** 双击解压。
3. 进入解压目录，先运行：

```bash
shasum -a 256 -c *.zip.sha256   # 若保留了 ZIP 校验文件
./Verify-Integrity.command      # 校验 .app 内 payload
```

预期：`校验通过`。

## 2. 首次启动（Gatekeeper）

双击 `Open-Win2Mac-App.command`，或在终端运行：

```bash
xattr -dr com.apple.quarantine "YourApp.app"
codesign --force --deep --sign - "YourApp.app"
open "YourApp.app"
```

首次可能需要在“系统设置 → 隐私与安全性”中允许。检查日志：

```bash
tail -n 100 ~/Library/Logs/Win2Mac/<app-id>.log
```

预期：`Using engine:`、`Initializing prefix`、`Launching:`，应用窗口出现。

## 3. Apple Silicon / Rosetta

在 Apple Silicon 上，如果日志出现 Rosetta 提示：

```bash
softwareupdate --install-rosetta --agree-to-license
```

然后重新打开应用。验证 x86_64 引擎可执行：

```bash
arch -x86_64 true && echo "Rosetta OK"
```

## 4. 引擎复用路径

分别验证三种策略（可用 `engineMode` 重新打包，或直接修改 `config.env` 后重置）：

- `bundled`：断网 + 删除缓存，确认可从 `.app` 内解压并启动。
- `auto`：登录 CrossOver / GPTK / Whisky 已安装环境，确认优先复用。
- `reuse`：无网络、无内置引擎，确认失败信息明确（而不是静默退出）。

检查实际使用引擎：

```bash
grep "Using engine" ~/Library/Logs/Win2Mac/<app-id>.log
```

## 5. 安装器模式（如使用）

首次启动应出现安装向导；完成后自动查找主程序。若失败：

```bash
./Reset-Runtime.command
```

重置后重新打开；打包时填写准确的“预期主程序名”可显著提高发现率。

## 6. 升级与重置

- 重新打包同一应用并覆盖 `.app`：payload 版本变化会重新复制，prefix 保留。
- 删除 `~/Library/Application Support/Win2Mac/prefixes/<app-id>` 或运行 `Reset-Runtime.command`：下次启动重新初始化。
- 清理缓存：设置页“缓存与空间”或手动检查：
  - `~/Library/Application Support/Win2Mac/engines`
  - `~/Library/Application Support/Win2Mac/downloads`（运行期下载）
  - `~/Library/Logs/Win2Mac`

## 7. 记录结果

建议反馈时附上：

```bash
sw_vers
uname -m
defaults read loginwindow SystemVersionStampAsString 2>/dev/null || true
tail -n 200 ~/Library/Logs/Win2Mac/<app-id>.log
```

以及 macOS 版本、Intel/Apple Silicon、使用的引擎（CrossOver/GPTK/Whisky/Gcenx）、应用名称与版本。

## 自动化替代

在 GitHub 上推送仓库后，`macos-verify.yml` 会在 `macos-14`/`macos-15` 运行：

```bash
npm ci --ignore-scripts
npm test
```

其中包含真实 macOS bash 执行启动器、Rosetta 分支、首启/二启、完整性校验与辅助脚本。它不能替代上面的 Gatekeeper、CrossOver/GPTK 真机与图形性能验收。
