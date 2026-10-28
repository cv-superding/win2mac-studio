#!/bin/bash
set -u
cd "$(dirname "$0")" || exit 1

pause_close() { if [ -t 0 ]; then read -r -p "按回车键关闭…" _ || true; fi; }

APP=""
for candidate in ./*.app; do
  if [ -d "$candidate" ]; then APP="$(cd "$candidate" && pwd)"; break; fi
done
if [ -z "$APP" ]; then
  echo "未找到 .app。"
  pause_close
  exit 1
fi

PAYLOAD="$APP/Contents/Resources/win2mac/payload"
MANIFEST="$APP/Contents/Resources/win2mac/manifest.sha256"
if [ ! -f "$MANIFEST" ]; then
  echo "未找到完整性清单。"
  pause_close
  exit 1
fi

echo "正在校验应用文件（逐文件 SHA-256）…"
cd "$PAYLOAD" || exit 1
if shasum -a 256 -c "$MANIFEST"; then
  echo ""
  echo "校验通过：所有打包文件与 Windows 源文件逐字节一致。"
else
  echo ""
  echo "校验失败：文件可能不完整或被修改，请重新解压原始 ZIP。"
fi
echo ""
pause_close
