# 移植配方格式（`win2mac-recipe/v1`）

配方是可分享的 JSON，只描述“如何打包”，不包含应用文件本身。导出入口：打包窗口 → 导出配方；导入入口：应用库工具栏 → 导入配方。

## 示例

```json
{
  "format": "win2mac-recipe/v1",
  "createdAt": "2026-10-28T08:00:00.000Z",
  "generator": { "name": "Win2Mac Studio", "version": "0.9.3" },
  "app": {
    "name": "7-Zip",
    "publisher": "Igor Pavlov",
    "version": "24.09",
    "exeName": "7zFM.exe",
    "source": "registry"
  },
  "match": {
    "name": "7-Zip",
    "publisher": "Igor Pavlov",
    "exeName": "7zFM.exe",
    "bits": 64,
    "size": 6100000
  },
  "compatibility": {
    "grade": "A",
    "label": "可直接运行",
    "summary": "社区验证：常规 Win32 工具",
    "recommendedEngine": "wine"
  },
  "installer": null,
  "options": {
    "engineMode": "bundled",
    "includeRuntimes": true,
    "includeWineMono": true,
    "includeUserData": false,
    "advanced": {
      "metalHud": false,
      "dxvkHud": false,
      "verifyIntegrity": true,
      "preventSleep": false,
      "wineDebug": "off",
      "launchArgs": "",
      "envText": "DXVK_ASYNC=1"
    }
  },
  "notes": "内置 Wine，离线可用。"
}
```

安装器配方把 `installer` 设为：

```json
{
  "type": "exe",
  "args": "/S",
  "expectedExe": "App.exe"
}
```

## 字段与限制

| 字段 | 说明 |
|---|---|
| `format` | 必须为 `win2mac-recipe/v1`；未知版本拒绝导入 |
| `app` / `match` | 用于界面展示与匹配；不含安装路径 |
| `compatibility` | 导出时的分析快照，仅提示，不参与构建决策 |
| `installer` | `exe`/`msi` + 参数 + 预期主程序；导入时仍需用户重新选择安装包 |
| `options.engineMode` | `auto` / `bundled` / `reuse` |
| `options.advanced` | HUD、完整性校验、阻止睡眠、Wine 日志、启动参数、自定义环境变量 |
| `notes` | 最多 2000 字符 |

限制：文件最大 256 KiB；环境变量名必须匹配 `^[A-Za-z_][A-Za-z0-9_]*$`；安装参数最多 1024 字符；启动参数最多 2048 字符；环境变量文本最多 8192 字符。CLI 与桌面端使用同一套校验。

## 匹配与优先级

导入时按以下顺序寻找已扫描应用：名称完全一致 → EXE 文件名一致 → 发布者一致；找不到时显示“待应用配方”提示条。打开打包窗口时自动带入配方；显式 CLI 参数（`--engine`、`--args`、`--no-runtimes`、`--no-mono`、`--user-data`）优先于配方。

## 安全边界

- 配方不含本机绝对路径、安装包、注册表、用户数据、下载 URL、命令或脚本。
- 导入只填选项，不自动下载/执行任何内容；安装器配方必须重新选择本地安装包。
- 配方可以描述第三方应用，但不授予分发权；请确认你拥有打包与分享该应用的权利。

## CLI

```bat
node cli.js build --exe "C:\Program Files\7-Zip\7zFM.exe" ^
  --install "C:\Program Files\7-Zip" ^
  --recipe "7-Zip.win2mac.json" --out "%USERPROFILE%\Documents\Win2Mac"
```
