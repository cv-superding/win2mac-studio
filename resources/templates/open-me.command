#!/bin/bash
set -u
cd "$(dirname "$0")" || exit 1

pause_close() { if [ -t 0 ]; then read -r -p "按回车键关闭…" _ || true; fi; }

APP=""
for candidate in ./*.app; do
  if [ -d "$candidate" ]; then APP="$(cd "$candidate" && pwd)"; break; fi
done
if [ -z "$APP" ]; then
  echo "未找到 .app，请确认压缩包已完整解压。"
  pause_close
  exit 1
fi

echo "正在修复 macOS 权限与隔离标记：$APP"
# 整个产物目录一起清，避免 Open/Verify/Reset/Start-Mac-Validation 逐个被 Gatekeeper 拦截。
xattr -dr com.apple.quarantine "$PWD" 2>/dev/null || true
chmod +x "$PWD"/*.command 2>/dev/null || true
chmod +x "$APP/Contents/MacOS/launcher" 2>/dev/null || true
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true

echo "正在启动 $APP ..."
if ! open "$APP"; then
  echo "启动失败：请在“系统设置 → 隐私与安全性”中允许该应用，或重新运行本脚本。"
  pause_close
  exit 1
fi
sleep 1
