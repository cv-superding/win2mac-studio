# macOS 诊断包格式

产物在 Mac 上失败时会生成两类诊断包，供用户回传或用其他 agent 修复：

- 启动器自动生成：`~/Desktop/Win2Mac-失败诊断-<app-id>-<时间>.zip`
- 手动验证生成：`~/Desktop/Win2Mac-诊断-<时间>.zip`（由 `Start-Mac-Validation.command` 生成）

两者都不包含 payload 二进制，只包含清单、日志和元数据；日志可能含用户名、路径和应用输出，只应发给可信的打包者。

## 目录结构

```text
Report.md                 人类可读汇总
Report.json               机器可读汇总（schema: win2mac-diagnostics/1）
Report.txt                完整终端日志（手动验证包）
Missing.txt               MISSING / SIZE_MISMATCH 清单
Repair.md                 修复步骤
System/
  Environment.txt         macOS/CPU/磁盘/相关环境变量
  Engine.txt              引擎候选、路径、文件类型、缓存
  Processes.txt           残留 wine/win2mac/adb 进程
App/
  Info.plist
  config.env
  bundle.json
  manifest.sha256         期望的 SHA-256 + 相对路径
  payload-index.tsv       期望的 SHA-256、字节数、相对路径
  payload-index.json      同上（JSON，便于工具处理）
  FileTree.txt            实际 bundle/payload 文件树
Prefix/
  Prefix.txt              前缀 marker、drive_c、users、dosdevices
  AppLogs/                应用在 Wine 用户目录写出的 .log/.txt
Logs/
  <app-id>.log            启动器主日志（阶段、返回码、Wine 输出）
  launcher-*.log          配置加载前的早期日志
  state.env               最后一次运行状态（STAGE/STATUS/ERROR/EXIT_CODE）
  integrity.txt           启动前完整 SHA-256 结果（若启用）
  payload-check.txt       启动前文件存在性/大小检查
  direct-launch.txt       手动验证脚本直接启动时的终端输出
```

## `Report.json` 关键字段

```json
{
  "schema": "win2mac-diagnostics/1",
  "generatedAt": "2026-10-29T00:00:00+0800",
  "verdict": "发现问题（请把诊断包发回）",
  "app": { "name": "", "id": "", "bundleId": "", "version": "", "bundlePath": "" },
  "system": { "os": "Darwin", "arch": "arm64", "macos": "14.6.1", "user": "", "home": "" },
  "engine": { "found": 1, "policy": "auto", "order": "gptk,crossover,...", "version": "" },
  "payload": {
    "manifestCount": 109,
    "missingCount": 0,
    "sizeMismatchCount": 0,
    "issues": []
  },
  "checks": { "pass": 10, "warn": 2, "fail": 0 },
  "paths": { "bundle": "", "prefix": "", "launcherLog": "" },
  "logs": { "launcher": "", "state": "Logs/state.env", "appLogs": "Prefix/AppLogs" },
  "repair": { "expectedManifest": "App/manifest.sha256", "payloadIndex": "App/payload-index.tsv" }
}
```

启动器自动生成的 `Report.json` 还包含 `run.stage`、`run.status`、`run.error`、`run.exitCode`、`electron` 和 `adb` 字段。

## `Missing.txt` 行格式

```text
MISSING<TAB>C/App/App.exe<TAB>expected_bytes=12345
SIZE_MISMATCH<TAB>C/App/data.ini<TAB>expected=100<TAB>actual=98
SUMMARY<TAB>checked=109<TAB>missing=1<TAB>size_mismatch=0
```

`MISSING` 和 `SIZE_MISMATCH` 是修复入口；`SUMMARY` 只用于汇总，`Report.json` 的 `issues` 会忽略它。

## 修复流程

1. **先重新解压**：用 Finder 重新解压同一份 ZIP，避免传输/解压不完整。重新运行 `Start-Mac-Validation.command`。
2. **同一版本副本**：如果 Mac 上还保留同一版本 ZIP，可解压到新目录，按 `Missing.txt` 的相对路径复制缺失文件；复制前后用 `App/manifest.sha256` 校验 SHA-256。
3. **不要跨版本拼文件**：`.exe`、`.dll`、`.node`、`.asar` 和注册表快照必须来自同一次构建。
4. **仍缺失**：把 `Report.json`、`Missing.txt`、`App/payload-index.tsv` 和 `Logs/` 发回打包者，重新传输或重新构建。
5. **引擎问题**：看 `System/Engine.txt`；没有可执行 wine 时安装 CrossOver/GPTK，或改用 bundled 引擎包。
6. **应用自身崩溃**：看 `Prefix/AppLogs/` 和 `Logs/<app-id>.log` 末尾；用 `WIN2MAC_DEBUG=1` 重启获取 `fixme-all` 级别的 Wine 日志。

## 详细日志模式

```bash
WIN2MAC_DEBUG=1 "/path/to/YourApp.app/Contents/MacOS/launcher" --debug
```

`Start-Mac-Validation.command` 会默认用该模式启动应用，并在 `Logs/direct-launch.txt` 保留终端输出。

## 约束

- 诊断包不复制 payload；不要为了“方便”把整份应用塞进 ZIP。
- `Report.json` 的 `schema` 固定为 `win2mac-diagnostics/1`，字段只增不改。
- 修复工具不得从日志重建二进制文件，也不得伪造 manifest；缺失文件只能重新传输或重新构建。
- 分享前提醒用户：日志可能包含本机用户名、安装路径和应用输出，不要公开上传。
