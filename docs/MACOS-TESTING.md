# macOS 真机验收清单

当前项目在 Windows 上完成构建，并用“假 Darwin + 假 Wine”执行真实启动器；托管 macOS CI 工作流也已提供。以下是仍建议在**任意一台真实 Mac**（Intel 或 Apple Silicon）上做的最终验收，通常 10–15 分钟。

## 最快路径：一键诊断

每个转换产物的根目录都有 `Start-Mac-Validation.command`。让朋友：

1. 用 Finder 解压 Win2Mac 生成的 ZIP（不要用 Windows 资源管理器）。
2. 双击 `Start-Mac-Validation.command`；若被 Gatekeeper 拦截，打开“系统设置 → 隐私与安全性”点“仍要打开”（macOS 15/26 右键打开通常无效），或在终端运行 `xattr -dr com.apple.quarantine .` 和 `chmod +x *.command` 后重试。
3. 等验证结束，Finder 会定位到桌面的诊断包。
4. 把 **`~/Desktop/Win2Mac-诊断-<时间>.zip`** 发回。

日志全文在 **`~/Desktop/Win2Mac-验证日志-<时间>.log`**。如果首次启动正在下载 Wine（约 184 MB），30 秒内可能还没进入应用；等窗口出现后再双击一次验证脚本，以收集最终日志。

也可以只发送独立工具包：`npm run mac-check` 生成 `release/Win2Mac-MacCheck-<version>.zip`，朋友解压后把 `.app` 拖到脚本上即可。

## 1. 拷贝与解压

1. 把 `release/Win2Mac-Studio-Setup-0.4.1.exe` 生成的 ZIP 原样拷到 Mac（不要经过会重写文件的同步盘）。
2. 用 **Finder** 双击解压。
3. 进入解压目录，先运行：

```bash
shasum -a 256 -c *.zip.sha256   # 若保留了 ZIP 校验文件
./Verify-Integrity.command      # 校验 .app 内 payload
```

预期：`校验通过`。

## 2. 首次启动（Gatekeeper）

双击 `Open-Win2Mac-App.command`。首次会被 Gatekeeper 拦截：打开“系统设置 → 隐私与安全性”点“仍要打开”，放行后脚本会自动清除整个文件夹的隔离标记。

也可以直接在终端进入解压目录运行：

```bash
xattr -dr com.apple.quarantine .
chmod +x *.command
open *.app
```

检查日志：

```bash
tail -n 100 ~/Library/Logs/Win2Mac/<app-id>.log
```

如果启动器失败，它会在桌面自动生成 `Win2Mac-失败诊断-*.zip`。诊断目录里重点看：

- `Report.md` / `Report.json`：结论、阶段、错误、缺失文件（机器可读）。
- `Missing.txt`：`MISSING` / `SIZE_MISMATCH` 逐文件清单。
- `System/Engine.txt`、`Prefix/Prefix.txt`、`Processes.txt`：引擎、前缀、残留进程。
- `Logs/`：主日志、`launcher-*.log` 早期日志、`state.env`。

需要手动复现详细日志时：

```bash
WIN2MAC_DEBUG=1 "/path/to/YourApp.app/Contents/MacOS/launcher" --debug
```

预期：`Using engine:`、`Initializing prefix`、`Launching:`，应用窗口出现。

首次启动若包含 VC++ 运行库，会先显示“正在安装 Visual C++ 2015–2022”，通常多等 1–2 分钟。日志出现 `Installing runtime` 属正常。

如果应用是手机/ADB 工具且包内自带 macOS 版 `adb`，日志还会出现：

```text
ADB bridge: starting .../adb
ADB bridge: ADB_SERVER_SOCKET=tcp:127.0.0.1:5037
```

这是实验性的本机 ADB 桥接：连接手机并开启 USB 调试后，Wine 内的 adb/scrcpy 会通过 localhost 访问 macOS 的 ADB 服务。若仍找不到设备，说明桥接不适用于该应用，请改用虚拟机或官方 Mac 版。

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
