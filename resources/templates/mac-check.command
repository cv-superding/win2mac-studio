#!/bin/bash
# Win2Mac Mac-side validation collector.
# Double-click this file on macOS. It writes a report and a support bundle to the Desktop.
set -u

SCRIPT_VERSION="1.1.0"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT_ROOT="${WIN2MAC_CHECK_OUTDIR:-$HOME/Desktop}"
NO_PROMPT="${WIN2MAC_CHECK_NO_PROMPT:-0}"
NO_LAUNCH="${WIN2MAC_CHECK_NO_LAUNCH:-0}"
NO_ZIP="${WIN2MAC_CHECK_NO_ZIP:-0}"
WAIT_SECONDS="${WIN2MAC_CHECK_LAUNCH_WAIT:-30}"
case "$WAIT_SECONDS" in ''|*[!0-9]*) WAIT_SECONDS=30;; esac
STAMP="$(date '+%Y%m%d-%H%M%S')"

if ! mkdir -p "$OUT_ROOT" 2>/dev/null; then
  OUT_ROOT="${TMPDIR:-/tmp}"
fi
LOG="$OUT_ROOT/Win2Mac-验证日志-$STAMP.log"
BUNDLE_DIR="$OUT_ROOT/Win2Mac-诊断-$STAMP"
ZIP="$BUNDLE_DIR.zip"
mkdir -p "$BUNDLE_DIR" 2>/dev/null
if ! : > "$LOG" 2>/dev/null; then
  OUT_ROOT="${TMPDIR:-/tmp}"
  LOG="$OUT_ROOT/Win2Mac-验证日志-$STAMP.log"
  BUNDLE_DIR="$OUT_ROOT/Win2Mac-诊断-$STAMP"
  ZIP="$BUNDLE_DIR.zip"
  mkdir -p "$BUNDLE_DIR" 2>/dev/null
  : > "$LOG"
fi

# Keep a complete transcript in the log and on the terminal.
exec > >(tee -a "$LOG") 2>&1

PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0
MISSING_COUNT=0
SIZE_MISMATCH_COUNT=0
MANIFEST_COUNT=0
SUMMARY_LINES=()
ROSETTA_OK=0
ENGINE_FOUND=0
APP=""
APP_ID=""
APP_NAME=""
POLICY=""
ORDER=""
ENGINE_ARCHIVE=""
ENGINE_SHA=""
ENGINE_VERSION=""
PAYLOAD_VERSION=""
PREFIX_ROOT=""
LOG_ROOT=""
APP_LOG=""

record() {
  level="$1"
  name="$2"
  detail="${3:-}"
  case "$level" in
    PASS) PASS_COUNT=$((PASS_COUNT + 1));;
    WARN) WARN_COUNT=$((WARN_COUNT + 1));;
    FAIL) FAIL_COUNT=$((FAIL_COUNT + 1));;
  esac
  line="[$level] $name${detail:+ — $detail}"
  SUMMARY_LINES+=("$line")
  printf '%s\n' "$line"
}

section() {
  printf '\n========== %s ==========\n' "$1"
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

pause_close() {
  if [ -t 0 ]; then
    printf '\n按回车键关闭此窗口…'
    read -r _ || true
  fi
}

say_paths() {
  printf '\n日志文件：%s\n' "$LOG"
  printf '诊断包：%s\n' "$ZIP"
}

find_app_in_dir() {
  dir="$1"
  [ -d "$dir" ] || return 1
  for candidate in "$dir"/*.app; do
    [ -d "$candidate" ] || continue
    if [ -f "$candidate/Contents/Resources/win2mac/config.env" ]; then
      printf '%s\n' "${candidate%/}"
      return 0
    fi
  done
  for candidate in "$dir"/*.app; do
    [ -d "$candidate" ] || continue
    printf '%s\n' "${candidate%/}"
    return 0
  done
  return 1
}

resolve_app() {
  if [ -n "${WIN2MAC_CHECK_APP:-}" ]; then
    APP="${WIN2MAC_CHECK_APP%/}"
  elif [ "$#" -gt 0 ] && [ -n "${1:-}" ]; then
    input="${1%/}"
    case "$input" in
      *.zip|*.tar.*|*.dmg)
        printf '[WARN] 拖入的是压缩包，请先用 Finder 解压，再双击本脚本。\n'
        ;;
      *.app)
        APP="$input"
        ;;
      *)
        if [ -d "$input" ]; then
          APP="$(find_app_in_dir "$input" || true)"
        fi
        ;;
    esac
  fi
  if [ -z "$APP" ]; then
    APP="$(find_app_in_dir "$SCRIPT_DIR" || true)"
  fi
  if [ -z "$APP" ] && [ "$NO_PROMPT" != "1" ] && command_exists osascript; then
    picked="$(osascript \
      -e 'set f to choose file with prompt "请选择要验证的 .app（转换产物）" of type {"com.apple.application-bundle"}' \
      -e 'POSIX path of f' 2>/dev/null || true)"
    if [ -n "$picked" ]; then APP="${picked%/}"; fi
  fi
}

config_get() {
  key="$1"
  ( . "$CONFIG" >/dev/null 2>&1; eval "printf '%s' \"\${$key:-}\"" ) 2>/dev/null || true
}

copy_if_exists() {
  src="$1"
  dest="$2"
  [ -f "$src" ] || return 1
  mkdir -p "$(dirname "$dest")" 2>/dev/null
  cp "$src" "$dest" 2>/dev/null || true
}

actual_bytes() {
  wc -c < "$1" 2>/dev/null | tr -d ' '
}

json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr '\t\r\n' '   '
}

json_array_from_lines() {
  file="$1"
  first=1
  printf '['
  if [ -f "$file" ]; then
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      case "$line" in
        SUMMARY*|'#'*) continue ;;
      esac
      [ "$first" -eq 1 ] || printf ','
      first=0
      printf '"%s"' "$(json_escape "$line")"
    done < "$file"
  fi
  printf ']'
}

check_payload_inventory() {
  payload="$WIN2MAC/payload"
  index="$WIN2MAC/payload-index.tsv"
  manifest="$WIN2MAC/manifest.sha256"
  out="$BUNDLE_DIR/Missing.txt"
  : > "$out" 2>/dev/null || true
  printf '# payload=%s\n' "$payload" >> "$out"
  printf '# format=MISSING|SIZE_MISMATCH<TAB>relative_path...\n' >> "$out"
  checked=0
  missing=0
  mismatched=0
  if [ -f "$index" ]; then
    while IFS="$(printf '\t')" read -r hash size rel; do
      [ "$hash" = "sha256" ] && continue
      [ -n "$rel" ] || continue
      checked=$((checked + 1))
      file="$payload/$rel"
      if [ ! -f "$file" ]; then
        printf 'MISSING\t%s\texpected_bytes=%s\n' "$rel" "${size:-?}" >> "$out"
        missing=$((missing + 1))
      elif [ -n "$size" ]; then
        actual="$(actual_bytes "$file")"
        if [ -n "$actual" ] && [ "$actual" != "$size" ]; then
          printf 'SIZE_MISMATCH\t%s\texpected=%s\tactual=%s\n' "$rel" "$size" "$actual" >> "$out"
          mismatched=$((mismatched + 1))
        fi
      fi
    done < "$index"
  elif [ -f "$manifest" ]; then
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      rel="${line#*  }"
      [ -n "$rel" ] || continue
      checked=$((checked + 1))
      [ -f "$payload/$rel" ] || {
        printf 'MISSING\t%s\n' "$rel" >> "$out"
        missing=$((missing + 1))
      }
    done < "$manifest"
  fi
  if [ -f "$manifest" ]; then
    MANIFEST_COUNT="$(wc -l < "$manifest" | tr -d ' ')"
  fi
  MISSING_COUNT="$missing"
  SIZE_MISMATCH_COUNT="$mismatched"
  printf 'SUMMARY\tchecked=%s\tmissing=%s\tsize_mismatch=%s\n' "$checked" "$missing" "$mismatched" >> "$out"
  if [ "$checked" -eq 0 ]; then
    record FAIL "文件清单" "缺少 payload-index.tsv 或 manifest.sha256，无法核对文件"
  elif [ "$missing" -gt 0 ] || [ "$mismatched" -gt 0 ]; then
    record FAIL "文件清单" "缺失 ${missing} 个、大小不一致 ${mismatched} 个；详见诊断包 Missing.txt"
    head -n 40 "$out" 2>/dev/null || true
  else
    record PASS "文件清单" "${checked} 个文件存在且大小匹配"
  fi
}

launch_running() {
  [ -n "$1" ] || return 1
  if command_exists pgrep; then
    pgrep -f "$1" >/dev/null 2>&1
  else
    ps -ax -o command= 2>/dev/null | grep -F "$1" | grep -v grep >/dev/null 2>&1
  fi
}

printf 'Win2Mac Mac Validation %s\n' "$SCRIPT_VERSION"
printf '时间：%s\n' "$(date '+%Y-%m-%d %H:%M:%S %z')"
printf '脚本：%s\n' "$SCRIPT_DIR"
printf '日志：%s\n' "$LOG"
printf '提示：验证结束后，把桌面上的“Win2Mac-诊断-*.zip”发回即可；日志全文也会在桌面。\n'

resolve_app "${1:-}"
if [ -n "$APP" ]; then
  record PASS "找到 .app" "$APP"
else
  record FAIL "没有找到 .app" "请把本脚本放到 .app 旁边，或把 .app 拖到脚本上。"
fi

# ---------------------------------------------------------------------------
section "1. 系统与 Rosetta"
HOST_OS="$(uname -s 2>/dev/null || echo unknown)"
HOST_ARCH="$(uname -m 2>/dev/null || echo unknown)"
printf 'Host: %s %s\n' "$HOST_OS" "$HOST_ARCH"
if command_exists sw_vers; then
  sw_vers 2>&1 || true
fi
if command_exists sysctl; then
  printf '机型：%s\n' "$(sysctl -n hw.model 2>/dev/null || echo unknown)"
  printf 'CPU：%s\n' "$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo unknown)"
fi
if command_exists df; then
  df -h "$HOME" 2>/dev/null | tail -n 2 || true
fi
if [ "$HOST_ARCH" = "arm64" ]; then
  if command_exists arch && arch -x86_64 true >/dev/null 2>&1; then
    ROSETTA_OK=1
    record PASS "Rosetta 2" "x86_64 可执行"
  else
    record FAIL "Rosetta 2 未就绪" "请运行：softwareupdate --install-rosetta --agree-to-license"
  fi
else
  record PASS "Rosetta 检查" "当前为 ${HOST_ARCH}，无需 Rosetta"
fi

if [ -n "$APP" ] && [ ! -d "$APP" ]; then
  record FAIL ".app 不存在" "$APP"
  APP=""
fi

INFO=""
LAUNCHER=""
WIN2MAC=""
CONFIG=""
PLIST_OK=0
if [ -n "$APP" ]; then
  INFO="$APP/Contents/Info.plist"
  LAUNCHER="$APP/Contents/MacOS/launcher"
  WIN2MAC="$APP/Contents/Resources/win2mac"
  CONFIG="$WIN2MAC/config.env"
fi

# ---------------------------------------------------------------------------
section "2. .app 结构、Gatekeeper 与签名"
if [ -n "$APP" ]; then
  record PASS "Bundle 目录" "$APP"
  for required in "$INFO" "$LAUNCHER" "$CONFIG"; do
    if [ -f "$required" ]; then
      record PASS "存在" "$required"
    else
      record FAIL "缺失" "$required"
    fi
  done
  if [ -f "$LAUNCHER" ]; then
    if [ -x "$LAUNCHER" ]; then
      record PASS "launcher 可执行" "$(ls -l "$LAUNCHER" 2>/dev/null || true)"
    else
      record FAIL "launcher 没有执行权限" "chmod +x \"$LAUNCHER\""
    fi
    file "$LAUNCHER" 2>/dev/null || true
    head -n 1 "$LAUNCHER" 2>/dev/null || true
  fi
  if [ -f "$INFO" ] && command_exists plutil; then
    if plutil -lint "$INFO" >/tmp/win2mac-plutil-lint.$$ 2>&1; then
      PLIST_OK=1
      record PASS "Info.plist" "plutil -lint 通过"
    else
      record FAIL "Info.plist" "plutil -lint 失败（见下）"
      cat /tmp/win2mac-plutil-lint.$$ 2>/dev/null || true
    fi
    rm -f /tmp/win2mac-plutil-lint.$$
    plutil -p "$INFO" 2>/dev/null | head -n 80 || true
  fi
  BUNDLE_ID="$(plutil -extract CFBundleIdentifier raw -o - "$INFO" 2>/dev/null || true)"
  SHORT_VERSION="$(plutil -extract CFBundleShortVersionString raw -o - "$INFO" 2>/dev/null || true)"
  MIN_MAC="$(plutil -extract LSMinimumSystemVersion raw -o - "$INFO" 2>/dev/null || true)"
  printf 'Bundle ID：%s\n版本：%s\n最低系统：%s\n' "${BUNDLE_ID:-未知}" "${SHORT_VERSION:-未知}" "${MIN_MAC:-未知}"

  if command_exists xattr; then
    XATTRS="$(xattr -l "$APP" 2>/dev/null || true)"
    if printf '%s' "$XATTRS" | grep -q 'com.apple.quarantine'; then
      record WARN "隔离标记" "检测到 com.apple.quarantine，正在自动清除"
      xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
    elif [ -n "$XATTRS" ]; then
      record WARN "扩展属性" "$XATTRS"
      printf '%s\n' "$XATTRS"
    else
      record PASS "扩展属性" "无隔离标记"
    fi
  fi
  if command_exists codesign; then
    CODESIGN_OUT="$(codesign -dv --verbose=4 "$APP" 2>&1 || true)"
    printf '%s\n' "$CODESIGN_OUT" | head -n 30
    if codesign --verify --deep --strict "$APP" >/dev/null 2>&1; then
      record PASS "codesign 校验" "签名结构完整"
    else
      record WARN "codesign 校验" "未签名或 ad-hoc 签名；需手动允许 Gatekeeper"
    fi
  fi
  if command_exists spctl; then
    if spctl --assess --type execute --verbose=4 "$APP" >/tmp/win2mac-spctl.$$ 2>&1; then
      record PASS "Gatekeeper" "spctl 接受"
    else
      record WARN "Gatekeeper" "spctl 拒绝（未签名时预期）；首次打开需“隐私与安全性”允许"
    fi
    cat /tmp/win2mac-spctl.$$ 2>/dev/null || true
    rm -f /tmp/win2mac-spctl.$$
  fi
  for helper in Open-Win2Mac-App.command Verify-Integrity.command Reset-Runtime.command Start-Mac-Validation.command; do
    helper_path="$SCRIPT_DIR/$helper"
    if [ -f "$helper_path" ]; then
      if command_exists xattr; then
        xattr -d com.apple.quarantine "$helper_path" 2>/dev/null || true
      fi
      chmod +x "$helper_path" 2>/dev/null || true
      printf '辅助脚本：%s %s\n' "$helper" "$(ls -l "$helper_path" 2>/dev/null || true)"
    fi
  done
else
  record WARN "Bundle 检查" "没有 .app，已跳过"
fi

# ---------------------------------------------------------------------------
section "3. 配置与 Wine 前缀"
if [ -n "$CONFIG" ] && [ -f "$CONFIG" ]; then
  record PASS "config.env" "$CONFIG"
  sed -n '1,160p' "$CONFIG" 2>/dev/null || true
  APP_ID="$(config_get WIN2MAC_APP_ID)"
  APP_NAME="$(config_get WIN2MAC_APP_NAME)"
  POLICY="$(config_get WIN2MAC_ENGINE_POLICY)"
  ORDER="$(config_get WIN2MAC_ENGINE_ORDER)"
  ENGINE_ARCHIVE="$(config_get WIN2MAC_ENGINE_ARCHIVE)"
  ENGINE_SHA="$(config_get WIN2MAC_ENGINE_SHA256)"
  ENGINE_VERSION="$(config_get WIN2MAC_ENGINE_VERSION)"
  PAYLOAD_VERSION="$(config_get WIN2MAC_PAYLOAD_VERSION)"
  PREFIX_ROOT="$(config_get WIN2MAC_PREFIX_ROOT)"
  [ -n "$PREFIX_ROOT" ] || PREFIX_ROOT="$HOME/Library/Application Support/Win2Mac/prefixes"
  LOG_ROOT="$(config_get WIN2MAC_LOG_DIR)"
  [ -n "$LOG_ROOT" ] || LOG_ROOT="$HOME/Library/Logs/Win2Mac"
  printf '应用：%s\nApp ID：%s\n引擎策略：%s\n引擎顺序：%s\n引擎版本：%s\n' \
    "${APP_NAME:-未知}" "${APP_ID:-未知}" "${POLICY:-未知}" "${ORDER:-未知}" "${ENGINE_VERSION:-未知}"
  printf 'Payload 版本：%s\n' "${PAYLOAD_VERSION:-未知}"
  if [ -n "$APP_ID" ]; then
    PREFIX="$PREFIX_ROOT/$APP_ID"
    if [ -d "$PREFIX" ]; then
      record PASS "Wine 前缀已存在" "$PREFIX"
      for marker in initialized payload-version runtimes-version installer-ran discovered-exe; do
        [ -f "$PREFIX/.win2mac/$marker" ] && printf 'marker: %s = %s\n' "$marker" "$(cat "$PREFIX/.win2mac/$marker" 2>/dev/null || true)"
      done
      [ -d "$PREFIX/drive_c" ] && record PASS "drive_c" "存在" || record WARN "drive_c" "不存在，首次启动会重新初始化"
      if command_exists du; then du -sh "$PREFIX" 2>/dev/null || true; fi
    else
      record WARN "Wine 前缀" "尚未初始化（首次启动会创建）：$PREFIX"
    fi
    APP_LOG="$LOG_ROOT/$APP_ID.log"
    if [ -f "$APP_LOG" ]; then
      record PASS "启动日志已存在" "$APP_LOG"
    else
      record WARN "启动日志" "尚未生成：$APP_LOG"
    fi
  fi
else
  record FAIL "config.env" "缺少配置文件"
fi

# ---------------------------------------------------------------------------
section "4. 载荷完整性（文件清单 + SHA-256）"
if [ -n "$WIN2MAC" ] && [ -d "$WIN2MAC/payload" ]; then
  check_payload_inventory
fi
if [ -n "$WIN2MAC" ] && [ -f "$WIN2MAC/manifest.sha256" ] && [ -d "$WIN2MAC/payload" ]; then
  MANIFEST="$WIN2MAC/manifest.sha256"
  FILE_COUNT="$(wc -l < "$MANIFEST" | tr -d ' ')"
  printf '清单文件数：%s\n正在校验，文件较多时可能需要几分钟…\n' "$FILE_COUNT"
  INTEGRITY_LOG="$BUNDLE_DIR/Integrity.log"
  if command_exists shasum; then
    ( cd "$WIN2MAC/payload" && shasum -a 256 -c "$MANIFEST" ) > "$INTEGRITY_LOG" 2>&1
    INTEGRITY_CODE=$?
  elif command_exists sha256sum; then
    ( cd "$WIN2MAC/payload" && sha256sum -c "$MANIFEST" ) > "$INTEGRITY_LOG" 2>&1
    INTEGRITY_CODE=$?
  else
    INTEGRITY_CODE=127
  fi
  if [ "$INTEGRITY_CODE" -eq 0 ]; then
    record PASS "完整性校验" "$FILE_COUNT 个文件全部通过"
    rm -f "$INTEGRITY_LOG"
  elif [ "$INTEGRITY_CODE" -eq 127 ]; then
    record WARN "完整性校验" "缺少 shasum/sha256sum，跳过"
  else
    FAILED_COUNT="$(grep -c 'FAILED' "$INTEGRITY_LOG" 2>/dev/null || true)"
    record FAIL "完整性校验" "${FAILED_COUNT:-若干} 个文件失败；完整结果见诊断包 Integrity.log"
    grep 'FAILED' "$INTEGRITY_LOG" 2>/dev/null | head -n 40 || true
  fi
else
  record FAIL "完整性清单" "缺少 manifest.sha256 或 payload"
fi

# ---------------------------------------------------------------------------
section "5. 引擎候选"
check_engine_candidate() {
  label="$1"
  path="$2"
  [ -n "$path" ] || return 0
  if [ -x "$path" ]; then
    ENGINE_FOUND=1
    record PASS "引擎：$label" "$path"
    file "$path" 2>/dev/null || true
  else
    printf '[info] 未找到 %s → %s\n' "$label" "$path"
  fi
}

check_engine_candidate "环境变量 WIN2MAC_WINE" "${WIN2MAC_WINE:-}"
check_engine_candidate "CrossOver" "/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine64"
check_engine_candidate "CrossOver (wine)" "/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine"
check_engine_candidate "Apple GPTK" "/Applications/Game Porting Toolkit.app/Contents/Resources/wine/bin/wine64"
check_engine_candidate "Apple GPTK (Homebrew)" "/usr/local/opt/game-porting-toolkit/bin/wine64"
check_engine_candidate "Whisky" "$HOME/Library/Application Support/com.isaacmarovitz.Whisky/Libraries/Wine/bin/wine64"
check_engine_candidate "Whisky (container)" "$HOME/Library/Containers/com.isaacmarovitz.Whisky/Data/Library/Application Support/com.isaacmarovitz.Whisky/Libraries/Wine/bin/wine64"
check_engine_candidate "Wine Staging" "/Applications/Wine Staging.app/Contents/Resources/wine/bin/wine64"
check_engine_candidate "Wine Stable" "/Applications/Wine Stable.app/Contents/Resources/wine/bin/wine64"
check_engine_candidate "Homebrew Wine (arm)" "/opt/homebrew/bin/wine64"
check_engine_candidate "Homebrew Wine (intel)" "/usr/local/bin/wine64"

if [ "$ENGINE_FOUND" = "0" ] && command_exists wine64; then
  check_engine_candidate "PATH wine64" "$(command -v wine64)"
fi
if [ "$ENGINE_FOUND" = "0" ] && command_exists wine; then
  check_engine_candidate "PATH wine" "$(command -v wine)"
fi

CACHE_ROOT="$HOME/Library/Application Support/Win2Mac"
if [ -d "$CACHE_ROOT/engines" ]; then
  while IFS= read -r cached_wine; do
    [ -n "$cached_wine" ] || continue
    check_engine_candidate "Gcenx 缓存" "$cached_wine"
    break
  done <<EOF
$(find "$CACHE_ROOT/engines" -type f \( -name wine64 -o -name wine \) 2>/dev/null | head -n 5)
EOF
fi

if [ -n "$WIN2MAC" ] && [ -n "$ENGINE_ARCHIVE" ] && [ -f "$WIN2MAC/$ENGINE_ARCHIVE" ]; then
  ARCHIVE_PATH="$WIN2MAC/$ENGINE_ARCHIVE"
  record PASS "内置引擎归档" "$ARCHIVE_PATH"
  if [ -n "$ENGINE_SHA" ]; then
    if command_exists shasum; then ACTUAL_SHA="$(shasum -a 256 "$ARCHIVE_PATH" | awk '{print $1}')"; else ACTUAL_SHA=""; fi
    if [ -n "$ACTUAL_SHA" ] && [ "$ACTUAL_SHA" = "$ENGINE_SHA" ]; then
      record PASS "内置引擎 SHA-256" "匹配"
    elif [ -n "$ACTUAL_SHA" ]; then
      record FAIL "内置引擎 SHA-256" "不匹配：实际 $ACTUAL_SHA"
    else
      record WARN "内置引擎 SHA-256" "无法计算"
    fi
  fi
else
  if [ -n "$ENGINE_ARCHIVE" ]; then
    record FAIL "内置引擎归档缺失" "$ENGINE_ARCHIVE"
  fi
fi

case "${POLICY:-auto}" in
  reuse)
    if [ "$ENGINE_FOUND" = "1" ]; then
      record PASS "引擎策略 reuse" "已找到本地引擎"
    else
      record FAIL "引擎策略 reuse" "未找到 CrossOver/GPTK/Whisky/Homebrew Wine"
    fi
    ;;
  bundled)
    if [ -n "$ENGINE_ARCHIVE" ] && [ -f "$WIN2MAC/$ENGINE_ARCHIVE" ]; then
      record PASS "引擎策略 bundled" "内置归档存在"
    else
      record FAIL "引擎策略 bundled" "内置归档不存在"
    fi
    ;;
  *)
    if [ "$ENGINE_FOUND" = "1" ]; then
      record PASS "引擎策略 auto" "可直接复用本地引擎"
    else
      record WARN "引擎策略 auto" "未发现本地引擎；首次启动会尝试下载 Gcenx Wine（约 184 MB）"
      URL="$(config_get WIN2MAC_ENGINE_URL)"
      if [ -n "$URL" ] && command_exists curl; then
        if curl -fsSI --max-time 10 -A 'Win2Mac-Studio' "$URL" >/dev/null 2>&1; then
          record PASS "引擎下载地址" "可访问"
        else
          record WARN "引擎下载地址" "当前网络不可访问：$URL"
        fi
      fi
    fi
    ;;
esac

# ---------------------------------------------------------------------------
section "6. 启动测试"
if [ "$NO_LAUNCH" = "1" ]; then
  record WARN "启动测试" "已按 WIN2MAC_CHECK_NO_LAUNCH=1 跳过"
elif [ -z "$APP" ] || [ ! -x "$LAUNCHER" ]; then
  record WARN "启动测试" "缺少可执行的 .app/launcher，跳过"
elif [ "$HOST_OS" != "Darwin" ]; then
  record WARN "启动测试" "当前不是 macOS，跳过实际启动"
elif [ "$HOST_ARCH" = "arm64" ] && [ "$ROSETTA_OK" = "0" ]; then
  record WARN "启动测试" "Rosetta 未就绪，跳过实际启动"
elif launch_running "$LAUNCHER"; then
  record WARN "启动测试" "launcher 已在运行，跳过以免重复实例"
else
  printf '3 秒后启动应用。首次运行可能下载引擎/安装组件，可能需要几分钟…\n'
  sleep 3
  if [ -x "$LAUNCHER" ]; then
    mkdir -p "$BUNDLE_DIR/Logs" 2>/dev/null
    ( WIN2MAC_DEBUG=1 nohup "$LAUNCHER" --debug > "$BUNDLE_DIR/Logs/direct-launch.txt" 2>&1 & echo $! > "$BUNDLE_DIR/Logs/direct-launch.pid" )
    record PASS "启动请求" "直接运行 launcher（WIN2MAC_DEBUG=1，详细日志）"
  elif command_exists open; then
    if open -n "$APP" --args --debug; then
      record PASS "启动请求" "open -n 已执行（--debug 详细 Wine 日志）"
    else
      record FAIL "启动请求" "open 返回失败"
    fi
  else
    record WARN "启动请求" "缺少 open 命令"
  fi
  elapsed=0
  while [ "$elapsed" -lt "$WAIT_SECONDS" ]; do
    sleep 2
    elapsed=$((elapsed + 2))
    if [ -n "$APP_LOG" ] && [ -f "$APP_LOG" ] && grep -q 'Launching:' "$APP_LOG" 2>/dev/null; then
      break
    fi
  done
  if launch_running "$LAUNCHER"; then
    record PASS "进程状态" "launcher 仍在运行（首次启动可能正在下载/初始化）"
  else
    record WARN "进程状态" "等待 ${WAIT_SECONDS} 秒后未检测到 launcher"
  fi
  if [ -n "$APP_LOG" ] && [ -f "$APP_LOG" ]; then
    record PASS "启动日志" "$APP_LOG"
    printf '\n----- 启动日志最后 200 行 -----\n'
    tail -n 200 "$APP_LOG" 2>/dev/null || true
    printf '%s\n' '----- 日志结束 -----'
    LAST_ERROR="$(grep -E 'ERROR:|ERROR |未找到|失败|No such file|not found' "$APP_LOG" 2>/dev/null | tail -n 1 || true)"
    if [ -n "$LAST_ERROR" ]; then
      record FAIL "日志错误" "$LAST_ERROR"
    elif grep -q 'Launching:' "$APP_LOG" 2>/dev/null; then
      record PASS "启动流程" "已进入 Launching"
    elif grep -q 'Download attempt\|正在下载' "$APP_LOG" 2>/dev/null; then
      record WARN "启动流程" "仍在下载/初始化，请稍后重新运行本脚本"
    else
      record WARN "启动流程" "日志尚未出现 Launching，请稍后重试"
    fi
    if grep -q 'Exited with status 0' "$APP_LOG" 2>/dev/null; then
      record PASS "退出状态" "0（应用已正常退出）"
    elif grep -Eq 'Exited with status [1-9]' "$APP_LOG" 2>/dev/null; then
      record FAIL "退出状态" "$(grep -E 'Exited with status [1-9]' "$APP_LOG" | tail -n 1)"
    fi
  else
    record WARN "启动日志" "等待后仍未生成：${APP_LOG:-未知路径}"
  fi
fi

# ---------------------------------------------------------------------------
section "7. 汇总"
for line in ${SUMMARY_LINES[@]+"${SUMMARY_LINES[@]}"}; do printf '%s\n' "$line"; done
printf '\nPASS：%s  WARN：%s  FAIL：%s  缺失文件：%s  大小不一致：%s\n' "$PASS_COUNT" "$WARN_COUNT" "$FAIL_COUNT" "$MISSING_COUNT" "$SIZE_MISMATCH_COUNT"
if [ "$FAIL_COUNT" -gt 0 ]; then
  VERDICT="发现问题（请把诊断包发回）"
elif [ "$WARN_COUNT" -gt 0 ]; then
  VERDICT="基本通过，有需要确认的警告"
else
  VERDICT="全部通过"
fi

# ---------------------------------------------------------------------------
# Build a support bundle without copying the application payload.
mkdir -p "$BUNDLE_DIR/System" "$BUNDLE_DIR/App" "$BUNDLE_DIR/Logs" "$BUNDLE_DIR/Prefix" 2>/dev/null
[ -f "$BUNDLE_DIR/Missing.txt" ] || : > "$BUNDLE_DIR/Missing.txt" 2>/dev/null || true
if command_exists sw_vers; then sw_vers > "$BUNDLE_DIR/System/sw_vers.txt" 2>&1 || true; fi
uname -a > "$BUNDLE_DIR/System/uname.txt" 2>&1 || true
if command_exists sysctl; then
  sysctl -n hw.model > "$BUNDLE_DIR/System/hw_model.txt" 2>&1 || true
  sysctl -n machdep.cpu.brand_string > "$BUNDLE_DIR/System/cpu.txt" 2>&1 || true
fi
if command_exists system_profiler; then
  system_profiler SPHardwareDataType 2>/dev/null | grep -vE 'Serial Number|Hardware UUID|Provisioning UDID|Activation Lock' > "$BUNDLE_DIR/System/hardware.txt" 2>/dev/null || true
  system_profiler SPDisplaysDataType 2>/dev/null | grep -vE 'Serial Number' > "$BUNDLE_DIR/System/displays.txt" 2>/dev/null || true
fi
if [ -n "$APP" ]; then
  copy_if_exists "$APP/Contents/Info.plist" "$BUNDLE_DIR/App/Info.plist" || true
  copy_if_exists "$CONFIG" "$BUNDLE_DIR/App/config.env" || true
  copy_if_exists "$WIN2MAC/bundle.json" "$BUNDLE_DIR/App/bundle.json" || true
  copy_if_exists "$WIN2MAC/manifest.sha256" "$BUNDLE_DIR/App/manifest.sha256" || true
  copy_if_exists "$WIN2MAC/payload-index.tsv" "$BUNDLE_DIR/App/payload-index.tsv" || true
  copy_if_exists "$WIN2MAC/payload-index.json" "$BUNDLE_DIR/App/payload-index.json" || true
fi
if [ -n "$APP_LOG" ]; then
  copy_if_exists "$APP_LOG" "$BUNDLE_DIR/Logs/$(basename "$APP_LOG")" || true
  copy_if_exists "$APP_LOG.1" "$BUNDLE_DIR/Logs/$(basename "$APP_LOG").1" || true
fi
if [ -n "$LOG_ROOT" ] && [ -d "$LOG_ROOT" ]; then
  for extra_log in "$LOG_ROOT/launcher-"*.log "$LOG_ROOT/state-${APP_ID:-unknown}.env" "$LOG_ROOT/payload-check-${APP_ID:-unknown}.txt" "$LOG_ROOT/integrity-${APP_ID:-unknown}.txt"; do
    [ -f "$extra_log" ] || continue
    copy_if_exists "$extra_log" "$BUNDLE_DIR/Logs/$(basename "$extra_log")" || true
  done
fi
if [ -n "$APP" ]; then
  {
    echo "== app =="
    find "$APP" -maxdepth 4 -print 2>/dev/null | head -n 2000 || true
    echo "== payload =="
    find "$WIN2MAC/payload" -maxdepth 8 -print 2>/dev/null | head -n 5000 || true
  } > "$BUNDLE_DIR/App/FileTree.txt" 2>&1
fi
[ -f "$BUNDLE_DIR/Integrity.log" ] || rm -f "$BUNDLE_DIR/Integrity.log" 2>/dev/null

{
  echo "generatedAt=$(date '+%Y-%m-%d %H:%M:%S %z')"
  uname -a 2>&1 || true
  if command_exists sw_vers; then sw_vers 2>&1 || true; fi
  echo "arch=$(uname -m 2>/dev/null || echo unknown)"
  echo "user=$(id -un 2>/dev/null || echo unknown)"
  echo "HOME=$HOME"
  if command_exists df; then df -h "$HOME" 2>&1 || true; fi
  echo "--- relevant env ---"
  env | grep -E '^(WIN2MAC|WINE|ADB|DYLD|PATH|HOME|TMPDIR|SHELL)=' 2>/dev/null || true
} > "$BUNDLE_DIR/System/Environment.txt" 2>&1

{
  echo "ENGINE_FOUND=$ENGINE_FOUND"
  echo "POLICY=${POLICY:-}"
  echo "ORDER=${ORDER:-}"
  echo "ENGINE_VERSION=${ENGINE_VERSION:-}"
  echo "WIN2MAC_WINE=${WIN2MAC_WINE:-}"
  echo "hostAdbArm=$(config_get WIN2MAC_HOST_ADB_ARM)"
  echo "hostAdbX86=$(config_get WIN2MAC_HOST_ADB_X86)"
  for candidate in \
    "${WIN2MAC_WINE:-}" \
    "/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine64" \
    "/Applications/Game Porting Toolkit.app/Contents/Resources/wine/bin/wine64" \
    "$HOME/Library/Application Support/com.isaacmarovitz.Whisky/Libraries/Wine/bin/wine64" \
    "/opt/homebrew/bin/wine64" \
    "/usr/local/bin/wine64"; do
    [ -n "$candidate" ] && [ -x "$candidate" ] || continue
    echo "--- $candidate ---"
    ls -l "$candidate" 2>&1 || true
    file "$candidate" 2>&1 || true
    xattr -l "$candidate" 2>&1 || true
  done
  echo "--- cached engines ---"
  find "$CACHE_ROOT/engines" -maxdepth 3 -print 2>/dev/null | head -n 200 || true
} > "$BUNDLE_DIR/System/Engine.txt" 2>&1

ps -ax -o pid,command 2>/dev/null | grep -Ei 'wine|win2mac|adb' | grep -v grep | head -n 100 > "$BUNDLE_DIR/System/Processes.txt" 2>&1 || true

{
  echo "PREFIX=${PREFIX:-}"
  if [ -n "${PREFIX:-}" ] && [ -d "$PREFIX" ]; then
    du -sh "$PREFIX" 2>/dev/null || true
    ls -la "$PREFIX/.win2mac" 2>/dev/null || true
    for marker in initialized payload-version runtimes-version installer-ran discovered-exe; do
      [ -f "$PREFIX/.win2mac/$marker" ] && echo "marker: $marker = $(cat "$PREFIX/.win2mac/$marker" 2>/dev/null || true)"
    done
    echo "--- drive_c ---"
    find "$PREFIX/drive_c" -maxdepth 2 -print 2>/dev/null | head -n 300 || true
    echo "--- users ---"
    find "$PREFIX/drive_c/users" -maxdepth 3 -print 2>/dev/null | head -n 300 || true
    echo "--- dosdevices ---"
    ls -la "$PREFIX/dosdevices" 2>/dev/null || true
  else
    echo "prefix does not exist"
  fi
} > "$BUNDLE_DIR/Prefix/Prefix.txt" 2>&1

if [ -n "${PREFIX:-}" ] && [ -d "$PREFIX/drive_c/users" ]; then
  mkdir -p "$BUNDLE_DIR/Prefix/AppLogs" 2>/dev/null || true
  app_log_index=0
  while IFS= read -r app_log_file; do
    [ -n "$app_log_file" ] || continue
    app_log_index=$((app_log_index + 1))
    cp "$app_log_file" "$BUNDLE_DIR/Prefix/AppLogs/$(printf '%02d' "$app_log_index")-$(basename "$app_log_file")" 2>/dev/null || true
  done < <(find "$PREFIX/drive_c/users" -type f \( -iname '*.log' -o -iname '*.txt' \) -mtime -3 -size -5M 2>/dev/null | head -n 50)
fi

cp "$LOG" "$BUNDLE_DIR/Report.txt" 2>/dev/null || true
MISSING_HINT=""
if [ "$MISSING_COUNT" -gt 0 ] || [ "$SIZE_MISMATCH_COUNT" -gt 0 ]; then
  MISSING_HINT="检测到 ${MISSING_COUNT} 个缺失文件、${SIZE_MISMATCH_COUNT} 个大小不一致文件。先让用户用 Finder 重新解压原始 ZIP；仍失败请重新发送/重建安装包。"
fi

cat > "$BUNDLE_DIR/Report.json" <<EOF
{
  "schema": "win2mac-diagnostics/1",
  "generatedAt": "$(date '+%Y-%m-%dT%H:%M:%S%z')",
  "scriptVersion": "$SCRIPT_VERSION",
  "verdict": "$(json_escape "$VERDICT")",
  "app": {
    "name": "$(json_escape "${APP_NAME:-}")",
    "id": "$(json_escape "${APP_ID:-}")",
    "bundleId": "$(json_escape "${BUNDLE_ID:-}")",
    "version": "$(json_escape "${SHORT_VERSION:-}")",
    "bundlePath": "$(json_escape "${APP:-}")"
  },
  "system": {
    "os": "$(json_escape "$HOST_OS")",
    "arch": "$(json_escape "$HOST_ARCH")",
    "macos": "$(sw_vers -productVersion 2>/dev/null || echo unknown)",
    "user": "$(id -un 2>/dev/null || echo unknown)",
    "home": "$(json_escape "$HOME")"
  },
  "engine": {
    "found": $ENGINE_FOUND,
    "policy": "$(json_escape "${POLICY:-}")",
    "order": "$(json_escape "${ORDER:-}")",
    "version": "$(json_escape "${ENGINE_VERSION:-}")"
  },
  "payload": {
    "manifestCount": $MANIFEST_COUNT,
    "missingCount": $MISSING_COUNT,
    "sizeMismatchCount": $SIZE_MISMATCH_COUNT,
    "issues": $(json_array_from_lines "$BUNDLE_DIR/Missing.txt")
  },
  "checks": {
    "pass": $PASS_COUNT,
    "warn": $WARN_COUNT,
    "fail": $FAIL_COUNT
  },
  "paths": {
    "bundle": "$(json_escape "${APP:-}")",
    "win2mac": "$(json_escape "${WIN2MAC:-}")",
    "payload": "$(json_escape "${WIN2MAC:-}/payload")",
    "prefix": "$(json_escape "${PREFIX:-}")",
    "launcherLog": "$(json_escape "${APP_LOG:-}")",
    "collectorLog": "$(json_escape "$LOG")"
  },
  "logs": {
    "launcher": "Logs/$(basename "${APP_LOG:-none}")",
    "state": "Logs/state.env",
    "missing": "Missing.txt",
    "files": "App/FileTree.txt",
    "engine": "System/Engine.txt",
    "prefix": "Prefix/Prefix.txt",
    "appLogs": "Prefix/AppLogs"
  },
  "repair": {
    "expectedManifest": "App/manifest.sha256",
    "payloadIndex": "App/payload-index.tsv",
    "missingFile": "Missing.txt",
    "instructions": "Compare expected manifest/index with actual payload; ask for a fresh ZIP or rebuild. Do not attempt to reconstruct missing binaries from logs."
  }
}
EOF

cat > "$BUNDLE_DIR/Repair.md" <<EOF
# Win2Mac 修复建议

结论：$VERDICT
${MISSING_HINT}

## 1. 文件缺失 / 大小不一致

- 期望清单：\`App/manifest.sha256\`、\`App/payload-index.tsv\`
- 本次问题：\`Missing.txt\`（每行以 \`MISSING\` 或 \`SIZE_MISMATCH\` 开头）
- 处理顺序：
  1. 让用户用 Finder 重新解压原始 ZIP（不要用 Windows 资源管理器解压）。
  2. 重新运行 \`Start-Mac-Validation.command\`。
  3. 仍有缺失：把 \`Missing.txt\`、\`App/payload-index.tsv\` 发回打包者，重新传输或重新构建安装包。
- 如果 Mac 上还保留**同一版本**的原始 ZIP：重新解压到新目录，按 \`Missing.txt\` 中的相对路径从新目录复制到当前 payload，复制前用 \`App/manifest.sha256\` 的 SHA-256 校验。不要跨版本混用文件。
- 不要试图从日志或旧版本目录里“拼”回缺失文件；二进制文件和注册表/原生模块必须来自同一次构建。

## 2. 引擎 / Wine

- 查看 \`System/Engine.txt\`：是否有可执行的 \`wine64\`，以及 \`POLICY\`、\`ORDER\`。
- \`ENGINE_FOUND=0\`：让用户安装 CrossOver 或 Apple GPTK，或改用带内置引擎的安装包。
- 下载失败：检查网络/代理；日志中有 \`Download attempt\` 和 curl 返回码。

## 3. 启动日志

- \`Logs/\` 里包含启动器日志、\`launcher-*.log\` 早期日志、\`state.env\` 和完整性结果。
- 重点搜索：\`STAGE\`、\`FAIL:\`、\`engine ready\`、\`payload check\`、\`wineboot rc\`、\`app exited status\`。
- \`Prefix/Prefix.txt\` 可确认 prefix 是否初始化、主程序是否复制到 \`drive_c\`。

## 4. 给其他 agent

优先读取 \`Report.json\`（机器可读），再按需查看 \`Report.md\`、\`Missing.txt\`、\`Logs/\`。期望文件清单只能来自 \`App/manifest.sha256\` 和 \`App/payload-index.tsv\`；修复缺失文件需要重新传输或重新打包，不能在用户机器上伪造。
EOF

cat > "$BUNDLE_DIR/README.txt" <<EOF
Win2Mac macOS 验证诊断包
生成时间：$(date '+%Y-%m-%d %H:%M:%S %z')
结论：$VERDICT
脚本版本：$SCRIPT_VERSION
应用：${APP_NAME:-未知}（${APP_ID:-未知}）

包含内容：
- Report.md / Report.json：人类可读与机器可读汇总
- Report.txt：本次验证的完整终端日志
- Missing.txt：缺失文件、大小不一致清单（若有）
- Repair.md：修复步骤（供用户或其他 agent）
- System/：macOS、机型、CPU、显卡、环境变量、引擎候选、进程
- App/：Info.plist、config.env、bundle.json、manifest.sha256、payload-index.*、FileTree.txt
- Prefix/：Wine 前缀状态、drive_c/users/dosdevices，以及应用自己写出的日志（AppLogs/）
- Logs/：启动器日志、launcher-*.log、state.env、完整性结果

隐私提示：日志可能包含本机用户名、安装路径、应用输出。请只发送给可信的打包者；不要公开上传。
EOF

ZIP_OK=0
if [ "$NO_ZIP" != "1" ]; then
  if command_exists ditto; then
    if ditto -c -k --sequesterRsrc --keepParent "$BUNDLE_DIR" "$ZIP" >/dev/null 2>&1; then ZIP_OK=1; fi
  fi
  if [ "$ZIP_OK" != "1" ] && command_exists zip; then
    parent="$(dirname "$BUNDLE_DIR")"
    base="$(basename "$BUNDLE_DIR")"
    if ( cd "$parent" && zip -qr "$ZIP" "$base" >/dev/null 2>&1 ); then ZIP_OK=1; fi
  fi
fi

printf '\n验证结论：%s\n' "$VERDICT"
printf '日志：%s\n' "$LOG"
if [ "$ZIP_OK" = "1" ]; then
  printf '诊断包：%s\n' "$ZIP"
else
  printf '诊断目录（未能自动压缩）：%s\n' "$BUNDLE_DIR"
fi

if [ "$NO_PROMPT" != "1" ] && command_exists osascript; then
  if [ "$ZIP_OK" = "1" ]; then
    osascript - "$VERDICT" "$LOG" "$ZIP" <<'APPLESCRIPT' >/dev/null 2>&1 || true
on run argv
  set msg to "验证完成：" & (item 1 of argv) & return & return & "日志：" & (item 2 of argv) & return & "诊断包：" & (item 3 of argv) & return & return & "请把桌面上的诊断 ZIP 发回给打包者。"
  display dialog msg buttons {"好"} default button "好" with title "Win2Mac Mac 验证" with icon note
end run
APPLESCRIPT
    if command_exists open; then open -R "$ZIP" >/dev/null 2>&1 || true; fi
  else
    osascript - "$VERDICT" "$LOG" "$BUNDLE_DIR" <<'APPLESCRIPT' >/dev/null 2>&1 || true
on run argv
  set msg to "验证完成：" & (item 1 of argv) & return & return & "日志：" & (item 2 of argv) & return & "诊断目录：" & (item 3 of argv)
  display dialog msg buttons {"好"} default button "好" with title "Win2Mac Mac 验证" with icon note
end run
APPLESCRIPT
    if command_exists open; then open -R "$LOG" >/dev/null 2>&1 || true; fi
  fi
fi

if [ "$FAIL_COUNT" -gt 0 ]; then
  pause_close
  exit 1
fi
pause_close
exit 0
