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
  exit 1
fi
CONFIG="$APP/Contents/Resources/win2mac/config.env"
if [ ! -f "$CONFIG" ]; then
  echo "未找到 config.env。"
  exit 1
fi
# shellcheck disable=SC1090
. "$CONFIG"
PREFIX="${WIN2MAC_PREFIX_ROOT:-$HOME/Library/Application Support/Win2Mac/prefixes}/$WIN2MAC_APP_ID"

echo "将删除此应用的 Wine 运行环境（不会删除 .app 本身）："
echo "$PREFIX"
echo "应用在其中的数据与设置也会被删除。"
if [ ! -t 0 ]; then echo "非交互环境，已取消重置。"; exit 1; fi
read -r -p "确认重置？输入 yes 继续：" answer
if [ "$answer" != "yes" ]; then
  echo "已取消。"
  exit 0
fi
rm -rf "$PREFIX"
echo "已重置。下次启动将重新初始化。"
pause_close
