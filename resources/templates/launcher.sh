#!/bin/bash
# Win2Mac launcher: prepares a Wine prefix from the packaged payload and starts the app.
set -u

BUNDLE_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
RES_DIR="$(cd "$(dirname "$0")/../Resources/win2mac" && pwd)"
CONFIG_FILE="$RES_DIR/config.env"
OSASCRIPT="$(command -v osascript 2>/dev/null || true)"
HOST_OS="$(uname -s 2>/dev/null || echo unknown)"
STAGE="start"
STATUS="running"
ERROR_MESSAGE=""
EXIT_CODE=""
WINE=""
ENGINE_KIND=""
PREFIX=""
LOG=""
EARLY_LOG=""
DIAG_DONE=0
DIAG_ZIP=""
PAYLOAD_CHECK_MISSING=0
PAYLOAD_CHECK_SIZE=0
WIN2MAC_DEBUG="${WIN2MAC_DEBUG:-0}"
for arg in "$@"; do
  case "$arg" in
    --debug) WIN2MAC_DEBUG=1 ;;
  esac
done

log_line() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
stage() { STAGE="$1"; log_line "STAGE $1${2:+ — $2}"; }

# 日志必须比 config 更早可用：否则缺少 config/路径错误时用户拿不到任何信息。
EARLY_LOG_DIR="${WIN2MAC_LOG_DIR:-$HOME/Library/Logs/Win2Mac}"
mkdir -p "$EARLY_LOG_DIR" 2>/dev/null || {
  EARLY_LOG_DIR="${TMPDIR:-/tmp}/Win2Mac-logs"
  mkdir -p "$EARLY_LOG_DIR" 2>/dev/null || true
}
EARLY_LOG="$EARLY_LOG_DIR/launcher-$(basename "$BUNDLE_DIR" .app).log"
if [ -f "$EARLY_LOG" ] && [ "$(wc -c < "$EARLY_LOG" 2>/dev/null | tr -d ' ')" -gt 5000000 ]; then
  mv "$EARLY_LOG" "$EARLY_LOG.1" 2>/dev/null || true
fi
exec >>"$EARLY_LOG" 2>&1
log_line "launcher start"
log_line "bundle=$BUNDLE_DIR"
log_line "resources=$RES_DIR"
log_line "host=$HOST_OS arch=$(uname -m 2>/dev/null || echo unknown) debug=$WIN2MAC_DEBUG"

if [ ! -f "$CONFIG_FILE" ]; then
  log_line "ERROR: missing config.env: $CONFIG_FILE"
  if [ -n "$OSASCRIPT" ]; then
    "$OSASCRIPT" - "$(basename "$BUNDLE_DIR" .app)" "安装包缺少 config.env，无法启动。

日志：$EARLY_LOG" <<'APPLESCRIPT' 2>/dev/null || true
on run argv
  display alert (item 1 of argv) message (item 2 of argv) as critical
end run
APPLESCRIPT
  fi
  exit 1
fi

# shellcheck disable=SC1090
if ! . "$CONFIG_FILE"; then
  log_line "ERROR: failed to load config.env"
  exit 1
fi

: "${WIN2MAC_APP_NAME:=Windows App}"
: "${WIN2MAC_APP_ID:=unknown}"
: "${WIN2MAC_BUNDLE_ID:=com.win2mac.unknown}"
: "${WIN2MAC_PAYLOAD_VERSION:=1}"
: "${WIN2MAC_ENGINE_POLICY:=auto}"
: "${WIN2MAC_ENGINE_ORDER:=crossover,gptk,whisky,wine}"
: "${WIN2MAC_ENGINE_ARCHIVE:=}"
: "${WIN2MAC_ENGINE_URL:=}"
: "${WIN2MAC_ENGINE_SHA256:=}"
: "${WIN2MAC_ENGINE_VERSION:=Wine}"
: "${WIN2MAC_WINEDEBUG:=-all}"
: "${WIN2MAC_WINEARCH:=win64}"
: "${WIN2MAC_ARG_COUNT:=0}"
: "${WIN2MAC_ELECTRON:=0}"
: "${WIN2MAC_ELECTRON_COMPAT:=1}"
: "${WIN2MAC_ELECTRON_NAME:=}"
: "${WIN2MAC_ELECTRON_ARG_COUNT:=0}"
: "${WIN2MAC_HOST_ADB_ARM:=}"
: "${WIN2MAC_HOST_ADB_X86:=}"
: "${WIN2MAC_RUNTIME_COUNT:=0}"
: "${WIN2MAC_RUNTIME_VERSION:=0}"
: "${WIN2MAC_REGISTRY_COUNT:=0}"
: "${WIN2MAC_USERDATA_COUNT:=0}"
: "${WIN2MAC_EXTRA_DRIVES:=}"
: "${WIN2MAC_DLL_OVERRIDES:=mshtml=}"
: "${WIN2MAC_PAYLOAD_BYTES:=0}"
: "${WIN2MAC_ENV_COUNT:=0}"
: "${WIN2MAC_VERIFY_ON_LAUNCH:=0}"
: "${WIN2MAC_PREVENT_SLEEP:=0}"
: "${WIN2MAC_INSTALLER_MODE:=0}"
: "${WIN2MAC_INSTALLER_PAYLOAD:=}"
: "${WIN2MAC_INSTALLER_WIN:=}"
: "${WIN2MAC_INSTALLER_TYPE:=exe}"
: "${WIN2MAC_INSTALLER_ARG_COUNT:=0}"
: "${WIN2MAC_EXPECTED_EXE:=}"
: "${WIN2MAC_LOG_DIR:=$HOME/Library/Logs/Win2Mac}"
: "${WIN2MAC_CACHE_ROOT:=$HOME/Library/Application Support/Win2Mac}"
: "${WIN2MAC_PREFIX_ROOT:=$HOME/Library/Application Support/Win2Mac/prefixes}"
: "${WIN2MAC_PROXY:=}"

PREFIX="$WIN2MAC_PREFIX_ROOT/$WIN2MAC_APP_ID"
: "${WIN2MAC_LOG_DIR:=$HOME/Library/Logs/Win2Mac}"
if ! mkdir -p "$WIN2MAC_LOG_DIR" 2>/dev/null; then
  WIN2MAC_LOG_DIR="${TMPDIR:-/tmp}/Win2Mac-logs"
  mkdir -p "$WIN2MAC_LOG_DIR" 2>/dev/null || true
fi
LOG="$WIN2MAC_LOG_DIR/$WIN2MAC_APP_ID.log"
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG" 2>/dev/null | tr -d ' ')" -gt 5000000 ]; then
  mv "$LOG" "$LOG.1" 2>/dev/null || true
fi
if [ "$LOG" != "$EARLY_LOG" ]; then
  cat "$EARLY_LOG" >> "$LOG" 2>/dev/null || true
fi
if [ "${WIN2MAC_STREAM_LOG:-0}" = "1" ]; then
  exec > >(tee -a "$LOG") 2>&1
else
  exec >>"$LOG" 2>&1
fi
case "${WIN2MAC_DEBUG:-0}" in
  1|true|yes) WIN2MAC_WINEDEBUG="fixme-all" ;;
esac

stage "config" "config.env loaded"
log_line "system: $(uname -a 2>/dev/null || echo unknown)"
if command -v sw_vers >/dev/null 2>&1; then
  log_line "macOS: $(sw_vers -productVersion 2>/dev/null || echo unknown) ($(sw_vers -buildVersion 2>/dev/null || echo unknown))"
fi
log_line "user=$(id -un 2>/dev/null || echo unknown) home=$HOME shell=${SHELL:-unknown}"
log_line "app=$WIN2MAC_APP_NAME id=$WIN2MAC_APP_ID bundleId=$WIN2MAC_BUNDLE_ID version=${WIN2MAC_APP_VERSION:-unknown}"
log_line "payloadVersion=$WIN2MAC_PAYLOAD_VERSION bytes=$WIN2MAC_PAYLOAD_BYTES exe=$WIN2MAC_EXE_PAYLOAD workdir=$WIN2MAC_WORKDIR_PAYLOAD"
log_line "enginePolicy=$WIN2MAC_ENGINE_POLICY order=$WIN2MAC_ENGINE_ORDER version=$WIN2MAC_ENGINE_VERSION"
log_line "engineUrl=${WIN2MAC_ENGINE_URL:-none} engineSha=${WIN2MAC_ENGINE_SHA256:-none}"
log_line "prefix=$PREFIX log=$LOG earlyLog=$EARLY_LOG"
log_line "registryCount=$WIN2MAC_REGISTRY_COUNT runtimeCount=$WIN2MAC_RUNTIME_COUNT runtimeVersion=$WIN2MAC_RUNTIME_VERSION userDataCount=$WIN2MAC_USERDATA_COUNT"
log_line "electron=$WIN2MAC_ELECTRON compat=$WIN2MAC_ELECTRON_COMPAT name=$WIN2MAC_ELECTRON_NAME"
electron_arg_index=1
while [ "$electron_arg_index" -le "${WIN2MAC_ELECTRON_ARG_COUNT:-0}" ] 2>/dev/null; do
  electron_arg_var="WIN2MAC_ELECTRON_ARG_$electron_arg_index"
  log_line "electronArg$electron_arg_index=${!electron_arg_var}"
  electron_arg_index=$((electron_arg_index + 1))
done
log_line "hostAdbArm=${WIN2MAC_HOST_ADB_ARM:-none} hostAdbX86=${WIN2MAC_HOST_ADB_X86:-none}"
log_line "winDebug=$WIN2MAC_WINEDEBUG debugMode=$WIN2MAC_DEBUG noGui=${WIN2MAC_NO_GUI:-0} streamLog=${WIN2MAC_STREAM_LOG:-0}"
if command -v df >/dev/null 2>&1; then
  log_line "disk: $(df -h "$HOME" 2>/dev/null | tail -n 1 || echo unknown)"
fi

# 一旦 .app 被允许运行，顺手修好同目录的辅助脚本，避免用户再被 Gatekeeper 拦一次。
clear_gatekeeper_flags() {
  command -v xattr >/dev/null 2>&1 || return 0
  log_line "clearing quarantine on bundle"
  xattr -dr com.apple.quarantine "$BUNDLE_DIR" 2>/dev/null || true
  local helper_dir helper
  helper_dir="$(cd "$BUNDLE_DIR/.." 2>/dev/null && pwd)" || return 0
  for helper in "$helper_dir/Open-Win2Mac-App.command" "$helper_dir/Verify-Integrity.command" "$helper_dir/Reset-Runtime.command" "$helper_dir/Start-Mac-Validation.command"; do
    [ -f "$helper" ] || continue
    xattr -d com.apple.quarantine "$helper" 2>/dev/null || true
    chmod +x "$helper" 2>/dev/null || true
  done
}
clear_gatekeeper_flags

notify() {
  [ "${WIN2MAC_NO_GUI:-0}" = "1" ] && return 0
  [ -n "$OSASCRIPT" ] || return 0
  "$OSASCRIPT" - "Win2Mac · $WIN2MAC_APP_NAME" "$1" <<'APPLESCRIPT' >/dev/null 2>&1
on run argv
  display notification (item 2 of argv) with title (item 1 of argv)
end run
APPLESCRIPT
}

show_error() {
  echo "ERROR: $1"
  if [ "${WIN2MAC_NO_GUI:-0}" = "1" ]; then
    echo "$1"
    return 0
  fi
  if [ -n "$OSASCRIPT" ]; then
    "$OSASCRIPT" - "Win2Mac · $WIN2MAC_APP_NAME" "$1" "$LOG" <<'APPLESCRIPT' 2>/dev/null || true
on run argv
  set answer to display alert (item 1 of argv) message (item 2 of argv) buttons {"关闭", "打开日志"} default button "打开日志" as critical
  if button returned of answer is "打开日志" then
    do shell script "open -a Console " & quoted form of (item 3 of argv)
  end if
end run
APPLESCRIPT
  else
    echo "$1"
  fi
}

write_state() {
  local file="$WIN2MAC_LOG_DIR/state-${WIN2MAC_APP_ID:-unknown}.env"
  {
    printf 'UPDATED_AT=%s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')"
    printf 'STAGE=%s\n' "$STAGE"
    printf 'STATUS=%s\n' "$STATUS"
    printf 'ERROR=%s\n' "$ERROR_MESSAGE"
    printf 'EXIT_CODE=%s\n' "$EXIT_CODE"
    printf 'APP_ID=%s\n' "${WIN2MAC_APP_ID:-}"
    printf 'APP_NAME=%s\n' "${WIN2MAC_APP_NAME:-}"
    printf 'BUNDLE=%s\n' "$BUNDLE_DIR"
    printf 'PREFIX=%s\n' "${PREFIX:-}"
    printf 'LOG=%s\n' "${LOG:-}"
    printf 'EARLY_LOG=%s\n' "${EARLY_LOG:-}"
    printf 'ENGINE_KIND=%s\n' "${ENGINE_KIND:-}"
    printf 'WINE=%s\n' "${WINE:-}"
    printf 'EXE=%s\n' "${EXE_UNIX:-}"
    printf 'ADB_SERVER_SOCKET=%s\n' "${ADB_SERVER_SOCKET:-}"
    printf 'ANDROID_ADB_SERVER_ADDRESS=%s\n' "${ANDROID_ADB_SERVER_ADDRESS:-}"
    printf 'ANDROID_ADB_SERVER_PORT=%s\n' "${ANDROID_ADB_SERVER_PORT:-}"
  } > "$file" 2>/dev/null || true
}

fail() {
  STATUS="failed"
  ERROR_MESSAGE="$1"
  EXIT_CODE=1
  log_line "FAIL: $1"
  write_state
  collect_failure_report || true
  if [ -n "$DIAG_ZIP" ]; then
    show_error "$1

诊断包：$DIAG_ZIP"
    if [ "${WIN2MAC_NO_GUI:-0}" != "1" ]; then
      command -v open >/dev/null 2>&1 && open -R "$DIAG_ZIP" >/dev/null 2>&1 || true
    fi
  else
    show_error "$1

日志：$LOG"
  fi
  exit 1
}

file_sha256() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    echo ""
  fi
}

human_size() {
  local bytes="${1:-0}"
  if [ "$bytes" -ge 1073741824 ] 2>/dev/null; then
    awk -v b="$bytes" 'BEGIN{printf "%.1f GB", b/1073741824}'
  elif [ "$bytes" -ge 1048576 ] 2>/dev/null; then
    awk -v b="$bytes" 'BEGIN{printf "%.0f MB", b/1048576}'
  else
    echo "$bytes B"
  fi
}

rosetta_available() {
  local arch_bin
  arch_bin="$(command -v arch 2>/dev/null || true)"
  [ -n "$arch_bin" ] || arch_bin="/usr/bin/arch"
  "$arch_bin" -x86_64 true >/dev/null 2>&1
}

ensure_rosetta_if_needed() {
  [ "${HOST_OS:-}" = "Darwin" ] || return 0
  [ "$(uname -m)" = "arm64" ] || return 0
  if rosetta_available; then
    return 0
  fi
  notify "此应用需要 Rosetta 2 来运行 x86/x64 Windows 程序，请在提示中安装后重试。"
  if [ -n "$OSASCRIPT" ]; then
    "$OSASCRIPT" - "$WIN2MAC_APP_NAME" <<'APPLESCRIPT' || true
on run argv
  set answer to display alert "需要 Rosetta 2" message "这个应用使用 x86_64 Wine 引擎。macOS 需要安装 Apple Rosetta 2 才能运行，是否现在安装？" buttons {"取消", "安装"} default button "安装"
  if button returned of answer is "安装" then
    try
      do shell script "/usr/sbin/softwareupdate --install-rosetta --agree-to-license" with administrator privileges
    on error errMsg
      display alert "Rosetta 2 安装失败" message errMsg as critical
    end try
  end if
end run
APPLESCRIPT
  fi
  rosetta_available || fail "未安装 Rosetta 2，无法运行 x86_64 Wine 引擎。请在终端运行：softwareupdate --install-rosetta --agree-to-license"
}

find_wine_binary() {
  local root="$1"
  [ -n "$root" ] && [ -d "$root" ] || return 1
  local c
  for c in \
    "$root/bin/wine64" \
    "$root/bin/wine" \
    "$root/wine/bin/wine64" \
    "$root/wine/bin/wine" \
    "$root/Contents/Resources/wine/bin/wine64" \
    "$root/Contents/Resources/wine/bin/wine" \
    "$root/Contents/SharedSupport/CrossOver/bin/wine64" \
    "$root/Contents/SharedSupport/CrossOver/bin/wine"; do
    if [ -x "$c" ]; then
      printf '%s\n' "$c"
      return 0
    fi
  done
  local c found
  for c in \
    "$root"/*/Contents/Resources/wine/bin/wine64 \
    "$root"/*/Contents/Resources/wine/bin/wine \
    "$root"/*/*/Contents/Resources/wine/bin/wine64 \
    "$root"/*/*/Contents/Resources/wine/bin/wine \
    "$root"/*/bin/wine64 \
    "$root"/*/bin/wine \
    "$root"/*/wine/bin/wine64 \
    "$root"/*/wine/bin/wine; do
    if [ -e "$c" ] && [ -x "$c" ]; then
      printf '%s\n' "$c"
      return 0
    fi
  done
  found=$(find "$root" \( -name wine64 -o -name wine \) 2>/dev/null | while IFS= read -r candidate; do
    if [ -f "$candidate" ] || [ -L "$candidate" ]; then
      if [ -x "$candidate" ]; then printf '%s\n' "$candidate"; break; fi
    fi
  done)
  if [ -n "$found" ]; then
    printf '%s\n' "$found"
    return 0
  fi
  return 1
}

engine_kind_for() {
  case "$1" in
    *"Game Porting Toolkit"*|*game-porting-toolkit*) echo "gptk" ;;
    *CrossOver*) echo "crossover" ;;
    *Whisky*|*whisky*) echo "whisky" ;;
    *) echo "wine" ;;
  esac
}

try_engine_kind() {
  local kind="$1" candidate=""
  case "$kind" in
    gptk)
      for candidate in \
        "/Applications/Game Porting Toolkit.app/Contents/Resources/wine/bin/wine64" \
        "/Applications/Game Porting Toolkit.app/Contents/Resources/wine/bin/wine" \
        "/usr/local/opt/game-porting-toolkit/bin/wine64" \
        "/usr/local/opt/game-porting-toolkit/bin/wine"; do
        [ -x "$candidate" ] && { printf '%s\n' "$candidate"; return 0; }
      done
      ;;
    crossover)
      for candidate in \
        "/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine64" \
        "/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine"; do
        [ -x "$candidate" ] && { printf '%s\n' "$candidate"; return 0; }
      done
      ;;
    whisky)
      for candidate in \
        "$HOME/Library/Application Support/com.isaacmarovitz.Whisky/Libraries/Wine/bin/wine64" \
        "$HOME/Library/Application Support/com.isaacmarovitz.Whisky/Libraries/Wine/bin/wine" \
        "$HOME/Library/Containers/com.isaacmarovitz.Whisky/Data/Library/Application Support/com.isaacmarovitz.Whisky/Libraries/Wine/bin/wine64" \
        "$HOME/Library/Containers/com.isaacmarovitz.Whisky/Data/Library/Application Support/com.isaacmarovitz.Whisky/Libraries/Wine/bin/wine"; do
        [ -x "$candidate" ] && { printf '%s\n' "$candidate"; return 0; }
      done
      ;;
    wine)
      for candidate in \
        "/Applications/Wine Staging.app/Contents/Resources/wine/bin/wine64" \
        "/Applications/Wine Staging.app/Contents/Resources/wine/bin/wine" \
        "/Applications/Wine Stable.app/Contents/Resources/wine/bin/wine64" \
        "/Applications/Wine Stable.app/Contents/Resources/wine/bin/wine" \
        "/opt/homebrew/bin/wine64" \
        "/opt/homebrew/bin/wine" \
        "/usr/local/bin/wine64" \
        "/usr/local/bin/wine"; do
        [ -x "$candidate" ] && { printf '%s\n' "$candidate"; return 0; }
      done
      if command -v wine64 >/dev/null 2>&1; then command -v wine64; return 0; fi
      if command -v wine >/dev/null 2>&1; then command -v wine; return 0; fi
      ;;
  esac
  return 1
}

find_cached_engine() {
  local root="$WIN2MAC_CACHE_ROOT/engines"
  [ -d "$root" ] || return 1
  if [ -n "$WIN2MAC_ENGINE_SHA256" ]; then
    local keyed="$root/engine-$(printf '%s' "$WIN2MAC_ENGINE_SHA256" | cut -c1-16)"
    local found
    found=$(find_wine_binary "$keyed" 2>/dev/null) && { printf '%s\n' "$found"; return 0; }
  fi
  local dir found
  for dir in "$root"/*; do
    [ -d "$dir" ] || continue
    found=$(find_wine_binary "$dir" 2>/dev/null) && { printf '%s\n' "$found"; return 0; }
  done
  return 1
}

extract_engine_archive() {
  local archive="$1"
  [ -f "$archive" ] || return 1
  if [ -n "$WIN2MAC_ENGINE_SHA256" ]; then
    local actual
    actual=$(file_sha256 "$archive")
    if [ -n "$actual" ] && [ "$actual" != "$WIN2MAC_ENGINE_SHA256" ]; then
      echo "引擎 SHA-256 不匹配，拒绝解压。期望 ${WIN2MAC_ENGINE_SHA256}，实际 $actual" >&2
      return 1
    fi
  fi
  local listing
  listing=$(tar -tf "$archive" 2>/dev/null)
  if [ -z "$listing" ] && command -v xz >/dev/null 2>&1; then
    listing=$(xz -dc "$archive" 2>/dev/null | tar -tf - 2>/dev/null)
  fi
  if [ -z "$listing" ]; then
    echo "无法读取引擎归档" >&2
    return 1
  fi
  if printf '%s\n' "$listing" | grep -qE '(^/|(^|/)\.\.(/|$))'; then
    echo "引擎归档包含不安全的绝对路径或 .. 路径，拒绝解压" >&2
    return 1
  fi
  local key="engine-${WIN2MAC_ENGINE_SHA256:0:16}"
  if [ -z "$WIN2MAC_ENGINE_SHA256" ]; then
    key="engine-$(basename "$archive" .tar.xz | tr -c 'A-Za-z0-9._-' '_')"
  fi
  local cache="$WIN2MAC_CACHE_ROOT/engines/$key"
  local existing
  existing=$(find_wine_binary "$cache" 2>/dev/null) && { log_line "engine extract: cache hit $existing"; printf '%s\n' "$existing"; return 0; }
  mkdir -p "$WIN2MAC_CACHE_ROOT/engines" || return 1
  log_line "engine extract: archive=$archive cache=$cache"
  local tmp="$cache.tmp.$$"
  rm -rf "$tmp"
  mkdir -p "$tmp" || return 1
  notify "首次运行：正在解压 Wine 引擎（$(human_size $(wc -c < "$archive" | tr -d ' '))）…"
  if ! tar -xf "$archive" -C "$tmp"; then
    if command -v xz >/dev/null 2>&1 && xz -dc "$archive" | tar -xf - -C "$tmp"; then
      :
    else
      rm -rf "$tmp"
      log_line "engine extract: tar failed for $archive"
      return 1
    fi
  fi
  existing=$(find_wine_binary "$tmp" 2>/dev/null)
  if [ -z "$existing" ]; then
    rm -rf "$tmp"
    echo "解压完成但未找到 wine 可执行文件" >&2
    log_line "engine extract: no wine binary after extraction"
    return 1
  fi
  rm -rf "$cache"
  mv "$tmp" "$cache" || return 1
  xattr -dr com.apple.quarantine "$cache" >/dev/null 2>&1 || true
  existing=$(find_wine_binary "$cache" 2>/dev/null)
  [ -n "$existing" ] && { log_line "engine extract: ready $existing"; printf '%s\n' "$existing"; return 0; }
  log_line "engine extract: cache missing after move"
  return 1
}

runtime_engine_url() {
  if [ -n "$WIN2MAC_ENGINE_URL" ]; then
    printf '%s\n' "$WIN2MAC_ENGINE_URL"
    return 0
  fi
  local api="https://api.github.com/repos/Gcenx/macOS_Wine_builds/releases/latest"
  local proxy_args=()
  [ -n "$WIN2MAC_PROXY" ] && proxy_args=(-x "$WIN2MAC_PROXY")
  curl -fsSL ${proxy_args[@]+"${proxy_args[@]}"} -H 'User-Agent: Win2Mac-Studio' "$api" 2>/dev/null \
    | tr ',' '\n' \
    | grep 'browser_download_url' \
    | grep '\.tar\.xz' \
    | head -n 1 \
    | sed -E 's/.*"browser_download_url":[[:space:]]*"([^"]+)".*/\1/'
}

download_and_extract_engine() {
  local url
  url=$(runtime_engine_url)
  [ -n "$url" ] || { log_line "engine download: no URL configured"; return 1; }
  local key="engine-${WIN2MAC_ENGINE_SHA256:0:16}"
  if [ -z "$WIN2MAC_ENGINE_SHA256" ]; then
    key="engine-$(basename "$url" | tr -c 'A-Za-z0-9._-' '_')"
  fi
  local cache="$WIN2MAC_CACHE_ROOT/engines/$key"
  local existing
  existing=$(find_wine_binary "$cache" 2>/dev/null) && { log_line "engine download: cache hit $existing"; printf '%s\n' "$existing"; return 0; }
  mkdir -p "$WIN2MAC_CACHE_ROOT/downloads" || return 1
  local archive="$WIN2MAC_CACHE_ROOT/downloads/$key.tar.xz"
  log_line "engine download: url=$url archive=$archive"
  if [ -f "$archive" ] && [ ! -s "$archive" ]; then rm -f "$archive"; fi
  if [ ! -s "$archive" ]; then
    notify "首次运行：需要下载 Wine 运行时，开始下载（进度见日志）…"
    local proxy_args=()
    [ -n "$WIN2MAC_PROXY" ] && proxy_args=(-x "$WIN2MAC_PROXY")
    echo "Downloading $url" >&2
    local attempt=1 curl_code=1
    while [ "$attempt" -le 5 ]; do
      echo "Download attempt $attempt/5" >&2
      if [ -s "$archive.part" ]; then
        curl -fL -C - --connect-timeout 25 --retry 2 --retry-delay 2 ${proxy_args[@]+"${proxy_args[@]}"} --progress-bar -o "$archive.part" "$url"
      else
        curl -fL --connect-timeout 25 --retry 2 --retry-delay 2 ${proxy_args[@]+"${proxy_args[@]}"} --progress-bar -o "$archive.part" "$url"
      fi
      curl_code=$?
      log_line "engine download: attempt=$attempt curl_rc=$curl_code"
      [ "$curl_code" -eq 0 ] && break
      if [ "$curl_code" -eq 33 ] || [ "$curl_code" -eq 36 ]; then
        echo "Server does not support resume, restarting download" >&2
        rm -f "$archive.part"
      fi
      sleep $((attempt * 2))
      attempt=$((attempt + 1))
    done
    if [ "$curl_code" -ne 0 ]; then
      notify "Wine 运行时下载失败，断点已保留；下次启动会继续。"
      log_line "engine download: failed after $attempt attempts"
      return 1
    fi
    mv "$archive.part" "$archive" || return 1
  fi
  if [ -n "$WIN2MAC_ENGINE_SHA256" ]; then
    local actual
    actual=$(file_sha256 "$archive")
    log_line "engine download: sha256 actual=$actual expected=$WIN2MAC_ENGINE_SHA256"
    if [ -n "$actual" ] && [ "$actual" != "$WIN2MAC_ENGINE_SHA256" ]; then
      echo "下载的引擎 SHA-256 不匹配（期望 ${WIN2MAC_ENGINE_SHA256}，实际 ${actual}）" >&2
      rm -f "$archive" "$archive.part"
      return 1
    fi
  fi
  extract_engine_archive "$archive"
}

select_engine() {
  local candidate
  if [ -n "${WIN2MAC_WINE:-}" ] && [ -x "$WIN2MAC_WINE" ]; then
    WINE="$WIN2MAC_WINE"
    ENGINE_KIND=$(engine_kind_for "$WINE")
    log_line "engine: env override $WINE kind=$ENGINE_KIND"
    return 0
  fi

  if [ "$WIN2MAC_ENGINE_POLICY" = "bundled" ]; then
    log_line "engine: policy=bundled archive=${WIN2MAC_ENGINE_ARCHIVE:-none}"
    if [ -n "$WIN2MAC_ENGINE_ARCHIVE" ] && [ -f "$RES_DIR/$WIN2MAC_ENGINE_ARCHIVE" ]; then
      candidate=$(extract_engine_archive "$RES_DIR/$WIN2MAC_ENGINE_ARCHIVE") && {
        WINE="$candidate"
        ENGINE_KIND="wine"
        log_line "engine: bundled archive -> $WINE"
        return 0
      }
    fi
    candidate=$(find_cached_engine) && { WINE="$candidate"; ENGINE_KIND="wine"; log_line "engine: cached -> $WINE"; return 0; }
  fi

  local old_ifs="$IFS"
  IFS=','
  for kind in $WIN2MAC_ENGINE_ORDER; do
    IFS="$old_ifs"
    log_line "engine: trying kind=$kind"
    candidate=$(try_engine_kind "$kind") && {
      WINE="$candidate"
      ENGINE_KIND=$(engine_kind_for "$WINE")
      log_line "engine: found kind=$kind path=$WINE"
      return 0
    }
  done
  IFS="$old_ifs"

  candidate=$(find_cached_engine) && { WINE="$candidate"; ENGINE_KIND="wine"; log_line "engine: cached fallback -> $WINE"; return 0; }

  if [ -n "$WIN2MAC_ENGINE_ARCHIVE" ] && [ -f "$RES_DIR/$WIN2MAC_ENGINE_ARCHIVE" ]; then
    log_line "engine: embedded archive $WIN2MAC_ENGINE_ARCHIVE"
    candidate=$(extract_engine_archive "$RES_DIR/$WIN2MAC_ENGINE_ARCHIVE") && {
      WINE="$candidate"
      ENGINE_KIND="wine"
      log_line "engine: embedded archive -> $WINE"
      return 0
    }
  fi

  if [ "$WIN2MAC_ENGINE_POLICY" = "reuse" ]; then
    log_line "engine: policy=reuse and no local engine"
    return 1
  fi
  log_line "engine: downloading Gcenx Wine"
  candidate=$(download_and_extract_engine) && { WINE="$candidate"; ENGINE_KIND="wine"; log_line "engine: downloaded -> $WINE"; return 0; }
  return 1
}

configure_engine_env() {
  local bin_dir
  bin_dir="$(cd "$(dirname "$WINE")" && pwd)"
  export PATH="$bin_dir:$PATH"
  local overrides="$WIN2MAC_DLL_OVERRIDES"
  if [ "$ENGINE_KIND" = "gptk" ]; then
    local wine_root
    wine_root="$(cd "$bin_dir/.." && pwd)"
    if [ -d "$wine_root/lib/wine/x86_64-windows" ]; then
      export WINEDLLPATH="$wine_root/lib/wine/x86_64-windows${WINEDLLPATH:+:$WINEDLLPATH}"
    fi
    if [ -d "$wine_root/lib/external" ]; then
      export DYLD_FRAMEWORK_PATH="$wine_root/lib/external${DYLD_FRAMEWORK_PATH:+:$DYLD_FRAMEWORK_PATH}"
    fi
    overrides="${overrides:+$overrides;}d3d9,d3d10core,d3d11,d3d12,d3d12core=n"
  fi
  if [ -n "$overrides" ]; then
    if [ -n "${WINEDLLOVERRIDES:-}" ]; then
      export WINEDLLOVERRIDES="$overrides;${WINEDLLOVERRIDES}"
    else
      export WINEDLLOVERRIDES="$overrides"
    fi
  fi
  export WINEDEBUG="$WIN2MAC_WINEDEBUG"
  export WINEPREFIX="$PREFIX"
  export WINEARCH="$WIN2MAC_WINEARCH"
}

payload_path_to_prefix() {
  local rel="$1"
  local drive="${rel%%/*}"
  local rest="${rel#*/}"
  if [ "$drive" = "C" ]; then
    printf '%s\n' "$PREFIX/drive_c/$rest"
  else
    printf '%s\n' "$PREFIX/drive_c/win2mac_$drive/$rest"
  fi
}

# 部分 Windows 应用自带 macOS 版 adb。Wine 不能直通 USB，但 adb 客户端支持
# ADB_SERVER_SOCKET；在宿主机启动 adb server 后，Wine 内的 adb/scrcpy 可走 localhost。
start_host_adb_bridge() {
  local rel=""
  case "$(uname -m)" in
    arm64|aarch64) rel="$WIN2MAC_HOST_ADB_ARM"; [ -n "$rel" ] || rel="$WIN2MAC_HOST_ADB_X86" ;;
    x86_64) rel="$WIN2MAC_HOST_ADB_X86" ;;
  esac
  log_line "adb bridge: hostArch=$(uname -m 2>/dev/null || echo unknown) arm=${WIN2MAC_HOST_ADB_ARM:-none} x86=${WIN2MAC_HOST_ADB_X86:-none}"
  [ -n "$rel" ] || { log_line "adb bridge: no host adb configured; skipped"; return 0; }
  local host_adb
  host_adb="$(payload_path_to_prefix "$rel")"
  if [ ! -f "$host_adb" ]; then
    log_line "adb bridge: host adb missing: $host_adb"
    return 0
  fi
  log_line "adb bridge: host adb=$host_adb"
  log_line "adb bridge: $(file "$host_adb" 2>&1 || true)"
  chmod +x "$host_adb" 2>/dev/null || true
  if command -v nc >/dev/null 2>&1 && nc -z 127.0.0.1 5037 >/dev/null 2>&1; then
    echo "ADB bridge: reusing server on 127.0.0.1:5037"
    log_line "adb bridge: reusing existing server on 5037"
  else
    echo "ADB bridge: starting $host_adb"
    ( unset ADB_SERVER_SOCKET; "$host_adb" start-server >/dev/null 2>&1 )
    log_line "adb bridge: start-server rc=$?"
  fi
  export ADB_SERVER_SOCKET="tcp:127.0.0.1:5037"
  export ANDROID_ADB_SERVER_ADDRESS="127.0.0.1"
  export ANDROID_ADB_SERVER_PORT="5037"
  echo "ADB bridge: ADB_SERVER_SOCKET=$ADB_SERVER_SOCKET"
  log_line "adb bridge: ADB_SERVER_SOCKET=$ADB_SERVER_SOCKET address=$ANDROID_ADB_SERVER_ADDRESS port=$ANDROID_ADB_SERVER_PORT"
  if [ "${WIN2MAC_DEBUG:-0}" = "1" ]; then
    adb_devices="$("$host_adb" devices 2>&1 | head -n 10)"
    log_line "adb bridge devices: ${adb_devices:-none}"
  fi
}

apply_custom_env() {
  local env_index=1
  while [ "$env_index" -le "$WIN2MAC_ENV_COUNT" ]; do
    local env_name_var="WIN2MAC_ENV_${env_index}_NAME"
    local env_value_var="WIN2MAC_ENV_${env_index}_VALUE"
    export "${!env_name_var}=${!env_value_var}"
    env_index=$((env_index + 1))
  done
}

verify_payload_integrity() {
  if [ "${WIN2MAC_VERIFY_ON_LAUNCH:-0}" != "1" ]; then
    log_line "integrity: skipped (WIN2MAC_VERIFY_ON_LAUNCH=0)"
    return 0
  fi
  stage "integrity" "full SHA-256 verification"
  notify "启动前校验应用文件…"
  local out="$WIN2MAC_LOG_DIR/integrity-$WIN2MAC_APP_ID.txt"
  local rc=127
  if command -v shasum >/dev/null 2>&1; then
    ( cd "$RES_DIR/payload" && shasum -a 256 -c "$RES_DIR/manifest.sha256" ) > "$out" 2>&1
    rc=$?
  elif command -v sha256sum >/dev/null 2>&1; then
    ( cd "$RES_DIR/payload" && sha256sum -c "$RES_DIR/manifest.sha256" ) > "$out" 2>&1
    rc=$?
  fi
  if [ "$rc" -eq 0 ]; then
    log_line "integrity: OK report=$out"
    return 0
  fi
  if [ "$rc" -eq 127 ]; then
    log_line "integrity: shasum/sha256sum not available; skipped"
    return 0
  fi
  log_line "integrity: FAILED report=$out"
  grep -E 'FAILED|No such file|No such' "$out" 2>/dev/null | head -n 20 | while IFS= read -r line; do
    log_line "integrity issue: $line"
  done
  fail "应用文件完整性校验失败。请重新解压原始 ZIP；详情：$out"
}

has_arg() {
  local needle="$1" arg
  shift
  for arg in "$@"; do
    [ "$arg" = "$needle" ] && return 0
  done
  return 1
}

looks_like_electron() {
  local dir="$1"
  [ -f "$dir/resources/app.asar" ] && return 0
  [ -f "$dir/resources/default_app.asar" ] && return 0
  [ -f "$dir/resources/electron.asar" ] && return 0
  [ -f "$dir/chrome_100_percent.pak" ] && [ -f "$dir/ffmpeg.dll" ] && return 0
  return 1
}

apply_electron_flags() {
  local exe="$1"
  [ "${WIN2MAC_ELECTRON_COMPAT:-1}" = "1" ] || return 0
  local detected="${WIN2MAC_ELECTRON:-0}"
  if [ "$detected" != "1" ] && looks_like_electron "$(dirname "$exe")"; then
    detected=1
  fi
  [ "$detected" = "1" ] || return 0

  local count="${WIN2MAC_ELECTRON_ARG_COUNT:-0}" i=1 name flag
  local added=""
  if [ "$count" -gt 0 ] 2>/dev/null; then
    while [ "$i" -le "$count" ]; do
      name="WIN2MAC_ELECTRON_ARG_$i"
      flag="${!name}"
      if [ -n "$flag" ] && ! has_arg "$flag" ${ARGS[@]+"${ARGS[@]}"}; then
        ARGS+=("$flag")
        added="$added $flag"
      fi
      i=$((i + 1))
    done
  else
    # 安装器模式在打包时还看不到 Electron 目录，这里补上 Wine 下最常用的兼容开关。
    for flag in --no-sandbox --disable-gpu --in-process-gpu; do
      if ! has_arg "$flag" ${ARGS[@]+"${ARGS[@]}"}; then
        ARGS+=("$flag")
        added="$added $flag"
      fi
    done
  fi
  echo "Electron compatibility flags:${added:- (already present)}"
}

discover_installed_exe() {
  local expected="$WIN2MAC_EXPECTED_EXE"
  local roots=("$PREFIX/drive_c/Program Files" "$PREFIX/drive_c/Program Files (x86)" "$PREFIX/drive_c/users" "$PREFIX/drive_c/ProgramData")
  local root found=""
  if [ -n "$expected" ]; then
    for root in "${roots[@]}"; do
      [ -d "$root" ] || continue
      found=$(find "$root" -type f -iname "$expected" 2>/dev/null | grep -viE '/(unins|uninstall|setup|installer|update|updater|helper|crash|vc_redist|dotnet)[^/]*$' | head -n 1)
      [ -n "$found" ] && break
    done
  fi
  if [ -z "$found" ]; then
    local candidates app_key
    candidates=$(find "${roots[@]}" -type f -iname '*.exe' 2>/dev/null | grep -viE '/windows/|/(unins|uninstall|setup|installer|update|updater|helper|crash|reporter|vc_redist|vcredist|dotnet|dxsetup|directx)[^/]*\.exe$' | head -n 500)
    app_key=$(printf '%s' "$WIN2MAC_APP_NAME" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9')
    if [ -n "$app_key" ]; then
      found=$(printf '%s\n' "$candidates" | grep -iF "$app_key" | head -n 1)
    fi
    if [ -z "$found" ]; then
      found=$(printf '%s\n' "$candidates" | head -n 1)
    fi
  fi
  printf '%s\n' "$found"
}

run_installer() {
  local installer_unix="$1"
  [ -f "$installer_unix" ] || fail "安装包未复制到运行环境：$WIN2MAC_INSTALLER_PAYLOAD"
  [ -n "$WIN2MAC_INSTALLER_WIN" ] || fail "安装包缺少 Windows 路径配置"
  stage "installer" "running installation"
  local installer_args=()
  local arg_index=1
  while [ "$arg_index" -le "$WIN2MAC_INSTALLER_ARG_COUNT" ]; do
    local arg_name="WIN2MAC_INSTALLER_ARG_$arg_index"
    installer_args+=("${!arg_name}")
    arg_index=$((arg_index + 1))
  done
  notify "首次运行：即将启动安装程序，请在 Wine 窗口中完成安装…"
  echo "Running installer: $WIN2MAC_INSTALLER_WIN ${installer_args[*]:-}"
  log_line "installer start: $WIN2MAC_INSTALLER_WIN type=$WIN2MAC_INSTALLER_TYPE args=${installer_args[*]:-}"
  local install_status=0
  if [ "$WIN2MAC_INSTALLER_TYPE" = "msi" ]; then
    "$WINE" msiexec /i "$WIN2MAC_INSTALLER_WIN" ${installer_args[@]+"${installer_args[@]}"}
    install_status=$?
  else
    "$WINE" "$WIN2MAC_INSTALLER_WIN" ${installer_args[@]+"${installer_args[@]}"}
    install_status=$?
  fi
  log_line "installer rc=$install_status"
  [ -n "$WINESERVER" ] && { "$WINESERVER" -w; log_line "wineserver -w rc=$?"; }
  if [ "$install_status" -ne 0 ]; then
    fail "安装程序退出（代码 ${install_status}）。可重新打开应用重试安装；如果安装程序已经完成但仍报错，请重置运行环境。日志：$LOG"
  fi
  mkdir -p "$PREFIX/.win2mac"
  printf '%s' "$WIN2MAC_PAYLOAD_VERSION" > "$PREFIX/.win2mac/installer-ran"
}

detect_wine_user() {
  local users_root candidate name
  for users_root in "$PREFIX/drive_c"/[Uu]sers; do
    [ -d "$users_root" ] || continue
    if [ -n "${USER:-}" ] && [ -d "$users_root/$USER" ]; then
      printf '%s\n' "$users_root/$USER"
      return 0
    fi
    for candidate in "$users_root"/*; do
      [ -d "$candidate" ] || continue
      name="$(basename "$candidate")"
      case "$name" in
        Public|"All Users"|Default|"Default User"|defaultuser0) continue ;;
      esac
      printf '%s\n' "$candidate"
      return 0
    done
  done
}

merge_payload_user_profiles() {
  local current="$1"
  [ -n "$current" ] && [ -d "$current" ] || return 0

  local users_root orig name
  for users_root in "$PREFIX/drive_c"/[Uu]sers; do
    [ -d "$users_root" ] || continue
    for orig in "$users_root"/*; do
      [ -d "$orig" ] || continue
      [ "$orig" = "$current" ] && continue
      name="$(basename "$orig")"
      case "$name" in
        Public|"All Users"|Default|"Default User"|defaultuser0) continue ;;
      esac
      [ -d "$orig/AppData" ] || continue
      echo "Merging payload user profile $name into $(basename "$current")"
      log_line "merge profile $name -> $current"
      mkdir -p "$current/AppData"
      (
        cd "$orig/AppData" 2>/dev/null || exit 0
        find . \( -iname 'Programs' -o -iname 'Temp' -o -iname 'Packages' -o -iname 'Microsoft' \
          -o -iname 'CrashDumps' -o -iname 'Cache' -o -iname 'Code Cache' -o -iname 'GPUCache' \
          -o -iname 'ShaderCache' -o -iname 'logs' \) -prune -o -type f -print0 2>/dev/null \
          | while IFS= read -r -d '' rel; do
              [ -e "$current/AppData/$rel" ] && continue
              mkdir -p "$(dirname "$current/AppData/$rel")" 2>/dev/null || continue
              cp -p "$orig/AppData/$rel" "$current/AppData/$rel" 2>/dev/null || true
            done
      )
    done
  done
}

copy_payload() {
  local payload_dir="$RES_DIR/payload"
  [ -d "$payload_dir" ] || fail "安装包缺少应用文件（payload）。"
  local drive src dest rc
  for src in "$payload_dir"/*; do
    [ -d "$src" ] || continue
    drive="$(basename "$src")"
    if [ "$drive" = "C" ]; then
      dest="$PREFIX/drive_c"
    else
      dest="$PREFIX/drive_c/win2mac_$drive"
      mkdir -p "$dest"
      mkdir -p "$PREFIX/dosdevices"
      ln -sfn "../drive_c/win2mac_$drive" "$PREFIX/dosdevices/$(echo "$drive" | tr 'A-Z' 'a-z'):"
    fi
    echo "Copying payload drive $drive to $dest"
    log_line "copy payload drive $drive -> $dest"
    if command -v ditto >/dev/null 2>&1; then
      ditto "$src/" "$dest/"
      rc=$?
      log_line "copy payload drive $drive rc=$rc"
      [ "$rc" -eq 0 ] || return 1
    else
      cp -R "$src/." "$dest/"
      rc=$?
      log_line "copy payload drive $drive rc=$rc"
      [ "$rc" -eq 0 ] || return 1
    fi
  done
  return 0
}

import_registry_and_runtimes() {
  local setup_dir="$PREFIX/drive_c/win2mac-setup"
  mkdir -p "$setup_dir/registry" "$setup_dir/runtimes"
  local i=1 file base rc
  if [ "${WIN2MAC_REGISTRY_COUNT:-0}" -gt 0 ] 2>/dev/null; then
    stage "registry" "importing registry snapshots"
  fi
  while [ "$i" -le "$WIN2MAC_REGISTRY_COUNT" ]; do
    local var="WIN2MAC_REGISTRY_$i"
    file="${!var}"
    if [ -n "$file" ] && [ -f "$RES_DIR/$file" ]; then
      cp "$RES_DIR/$file" "$setup_dir/registry/$i.reg"
      echo "Importing registry $i"
      log_line "registry import $i: $file"
      "$WINE" reg import "C:\\win2mac-setup\\registry\\$i.reg"
      rc=$?
      log_line "registry import $i rc=$rc"
      [ "$rc" -eq 0 ] || log_line "WARN: registry import $i failed; continuing"
    else
      log_line "registry import $i: missing $file"
    fi
    i=$((i + 1))
  done

  local runtime_marker="$PREFIX/.win2mac/runtimes-version"
  local installed_runtime=""
  [ -f "$runtime_marker" ] && installed_runtime="$(cat "$runtime_marker")"
  if [ "$installed_runtime" != "$WIN2MAC_RUNTIME_VERSION" ]; then
    stage "runtimes" "installing bundled runtimes"
    i=1
    while [ "$i" -le "$WIN2MAC_RUNTIME_COUNT" ]; do
      local file_var="WIN2MAC_RUNTIME_${i}_FILE"
      local args_var="WIN2MAC_RUNTIME_${i}_ARGS"
      local label_var="WIN2MAC_RUNTIME_${i}_LABEL"
      local kind_var="WIN2MAC_RUNTIME_${i}_KIND"
      file="${!file_var}"
      if [ -n "$file" ] && [ -f "$RES_DIR/$file" ]; then
        base="$(basename "$file")"
        cp "$RES_DIR/$file" "$setup_dir/runtimes/$base"
        echo "Installing runtime ${!label_var}: $base ${!args_var}"
        log_line "runtime install $i: ${!label_var} $base"
        notify "首次运行：正在安装 ${!label_var}…"
        if [ "${!kind_var:-exe}" = "msi" ]; then
          "$WINE" msiexec /i "C:\\win2mac-setup\\runtimes\\$base" ${!args_var}
        else
          "$WINE" start /wait "C:\\win2mac-setup\\runtimes\\$base" ${!args_var}
        fi
        rc=$?
        log_line "runtime install $i rc=$rc"
        [ "$rc" -eq 0 ] || log_line "WARN: runtime install $i failed; continuing"
        [ -n "$WINESERVER" ] && { "$WINESERVER" -w; log_line "wineserver -w rc=$?"; }
      else
        log_line "runtime install $i: missing $file"
      fi
      i=$((i + 1))
    done
    mkdir -p "$PREFIX/.win2mac"
    printf '%s' "$WIN2MAC_RUNTIME_VERSION" > "$runtime_marker"
  fi
}

copy_userdata() {
  [ "$WIN2MAC_USERDATA_COUNT" -gt 0 ] 2>/dev/null || return 0
  local winuser="" user_dir user_name
  for user_dir in "$PREFIX/drive_c/users"/*; do
    [ -d "$user_dir" ] || continue
    user_name="$(basename "$user_dir")"
    case "$user_name" in
      Public|"All Users"|Default) continue ;;
    esac
    winuser="$user_dir"
    break
  done
  if [ -z "$winuser" ]; then
    winuser="$PREFIX/drive_c/users/$USER"
  fi
  local i=1
  while [ "$i" -le "$WIN2MAC_USERDATA_COUNT" ]; do
    local source_var="WIN2MAC_USERDATA_${i}_SOURCE"
    local target_var="WIN2MAC_USERDATA_${i}_TARGET"
    local source="${!source_var}"
    local target="${!target_var}"
    if [ -n "$source" ] && [ -d "$RES_DIR/$source" ] && [ -n "$target" ]; then
      local dest="$winuser/AppData/$target"
      if [ ! -e "$dest" ]; then
        log_line "userdata restore: $source -> $dest"
        mkdir -p "$(dirname "$dest")"
        ditto "$RES_DIR/$source" "$dest"
        echo "Restored user data to $dest"
      else
        log_line "userdata restore skipped (exists): $dest"
      fi
    fi
    i=$((i + 1))
  done
}

json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr '\t\r\n' '   '
}

json_array_from_lines() {
  local file="$1" first=1 line
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

actual_bytes() {
  wc -c < "$1" 2>/dev/null | tr -d ' '
}

scan_payload_files() {
  local out="$1"
  : > "$out" 2>/dev/null || return 0
  local payload="$RES_DIR/payload"
  printf '# payload=%s\n' "$payload" >> "$out"
  printf '# format=MISSING|SIZE_MISMATCH<TAB>relative_path...\n' >> "$out"
  local index="$RES_DIR/payload-index.tsv"
  local manifest="$RES_DIR/manifest.sha256"
  local checked=0 missing=0 mismatched=0
  local hash size rel file actual line
  PAYLOAD_CHECK_MISSING=0
  PAYLOAD_CHECK_SIZE=0
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
  printf 'SUMMARY\tchecked=%s\tmissing=%s\tsize_mismatch=%s\n' "$checked" "$missing" "$mismatched" >> "$out"
  PAYLOAD_CHECK_MISSING="$missing"
  PAYLOAD_CHECK_SIZE="$mismatched"
  log_line "payload check: checked=$checked missing=$missing sizeMismatch=$mismatched report=$out"
}

copy_diag_file() {
  local src="$1" dest="$2"
  [ -f "$src" ] || return 0
  mkdir -p "$(dirname "$dest")" 2>/dev/null || true
  cp "$src" "$dest" 2>/dev/null || true
}

collect_failure_report() {
  [ "$DIAG_DONE" = "1" ] && return 0
  case "${WIN2MAC_DIAGNOSTICS:-1}" in
    0|false|no) return 0 ;;
  esac
  DIAG_DONE=1
  local base="${WIN2MAC_DIAGNOSTICS_DIR:-$HOME/Desktop}"
  mkdir -p "$base" 2>/dev/null || base="${TMPDIR:-/tmp}"
  local stamp dir
  stamp="$(date '+%Y%m%d-%H%M%S')"
  dir="$base/Win2Mac-失败诊断-${WIN2MAC_APP_ID:-unknown}-$stamp"
  if ! mkdir -p "$dir/Logs" "$dir/App" "$dir/System" "$dir/Prefix" 2>/dev/null; then
    dir="${TMPDIR:-/tmp}/Win2Mac-失败诊断-${WIN2MAC_APP_ID:-unknown}-$stamp"
    mkdir -p "$dir/Logs" "$dir/App" "$dir/System" "$dir/Prefix" 2>/dev/null || return 0
  fi
  log_line "collecting diagnostics into $dir"

  scan_payload_files "$dir/Missing.txt"

  copy_diag_file "$CONFIG_FILE" "$dir/App/config.env"
  copy_diag_file "$RES_DIR/bundle.json" "$dir/App/bundle.json"
  copy_diag_file "$RES_DIR/manifest.sha256" "$dir/App/manifest.sha256"
  copy_diag_file "$RES_DIR/payload-index.tsv" "$dir/App/payload-index.tsv"
  copy_diag_file "$RES_DIR/payload-index.json" "$dir/App/payload-index.json"
  copy_diag_file "$BUNDLE_DIR/Contents/Info.plist" "$dir/App/Info.plist"

  {
    echo "generatedAt=$(date '+%Y-%m-%d %H:%M:%S %z')"
    uname -a 2>&1 || true
    if command -v sw_vers >/dev/null 2>&1; then sw_vers 2>&1 || true; fi
    echo "arch=$(uname -m 2>&1 || true)"
    echo "user=$(id -un 2>&1 || true)"
    echo "HOME=$HOME"
    if command -v df >/dev/null 2>&1; then df -h "$HOME" 2>&1 || true; fi
    echo "--- relevant env ---"
    env | grep -E '^(WIN2MAC|WINE|ADB|DYLD|PATH|HOME|TMPDIR|SHELL)=' 2>/dev/null || true
  } > "$dir/System/Environment.txt" 2>&1

  {
    echo "ENGINE_KIND=${ENGINE_KIND:-}"
    echo "WINE=${WINE:-}"
    if [ -n "${WINE:-}" ] && [ -x "$WINE" ]; then
      ls -l "$WINE" 2>&1 || true
      file "$WINE" 2>&1 || true
      xattr -l "$WINE" 2>&1 || true
      echo "configured version: ${WIN2MAC_ENGINE_VERSION:-unknown}"
    fi
    echo "--- cache ---"
    find "$WIN2MAC_CACHE_ROOT/engines" -maxdepth 3 -print 2>/dev/null | head -n 200 || true
  } > "$dir/System/Engine.txt" 2>&1

  {
    echo "PREFIX=$PREFIX"
    if [ -d "$PREFIX" ]; then
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
      echo "prefix does not exist yet"
    fi
  } > "$dir/Prefix/Prefix.txt" 2>&1

  if [ -d "$PREFIX/drive_c/users" ]; then
    mkdir -p "$dir/Prefix/AppLogs" 2>/dev/null || true
    app_log_index=0
    while IFS= read -r app_log_file; do
      [ -n "$app_log_file" ] || continue
      app_log_index=$((app_log_index + 1))
      cp "$app_log_file" "$dir/Prefix/AppLogs/$(printf '%02d' "$app_log_index")-$(basename "$app_log_file")" 2>/dev/null || true
    done < <(find "$PREFIX/drive_c/users" -type f \( -iname '*.log' -o -iname '*.txt' \) -mtime -3 -size -5M 2>/dev/null | head -n 50)
    log_line "diagnostics app logs: $app_log_index file(s)"
  fi

  {
    echo "== bundle =="
    find "$BUNDLE_DIR" -maxdepth 4 -print 2>/dev/null | head -n 2000 || true
    echo "== payload =="
    find "$RES_DIR/payload" -maxdepth 8 -print 2>/dev/null | head -n 5000 || true
    echo "== prefix =="
    find "$PREFIX" -maxdepth 3 -print 2>/dev/null | head -n 2000 || true
  } > "$dir/Files.txt" 2>&1

  ps -ax -o pid,command 2>/dev/null | grep -Ei 'wine|win2mac|adb' | grep -v grep | head -n 100 > "$dir/Processes.txt" 2>&1 || true

  copy_diag_file "$LOG" "$dir/Logs/$(basename "$LOG")"
  copy_diag_file "$LOG.1" "$dir/Logs/$(basename "$LOG").1"
  copy_diag_file "$EARLY_LOG" "$dir/Logs/$(basename "$EARLY_LOG")"
  copy_diag_file "$WIN2MAC_LOG_DIR/state-${WIN2MAC_APP_ID:-unknown}.env" "$dir/Logs/state.env"
  copy_diag_file "$WIN2MAC_LOG_DIR/payload-check-${WIN2MAC_APP_ID:-unknown}.txt" "$dir/Logs/payload-check.txt"
  copy_diag_file "$WIN2MAC_LOG_DIR/integrity-${WIN2MAC_APP_ID:-unknown}.txt" "$dir/Logs/integrity.txt"
  copy_diag_file "$LOG" "$dir/Report.txt"

  local manifest_count=0
  [ -f "$RES_DIR/manifest.sha256" ] && manifest_count="$(wc -l < "$RES_DIR/manifest.sha256" 2>/dev/null | tr -d ' ')"
  local index_name="none"
  [ -f "$RES_DIR/payload-index.tsv" ] && index_name="payload-index.tsv"

  cat > "$dir/Report.md" <<EOF
# Win2Mac 失败诊断

- 生成时间：$(date '+%Y-%m-%d %H:%M:%S %z')
- 应用：${WIN2MAC_APP_NAME:-未知}（${WIN2MAC_APP_ID:-未知}）
- 版本：${WIN2MAC_APP_VERSION:-未知}
- 阶段：$STAGE
- 状态：$STATUS
- 错误：${ERROR_MESSAGE:-无}
- 退出码：${EXIT_CODE:-无}
- Bundle：$BUNDLE_DIR
- 前缀：$PREFIX
- 日志：$LOG
- 引擎：${ENGINE_KIND:-未选择} ${WINE:-}

## 文件检查

\`\`\`text
$(cat "$dir/Missing.txt" 2>/dev/null || true)
\`\`\`

## 给修复者

1. 如果 \`Missing.txt\` 有 \`MISSING\`，让用户重新用 Finder 解压原始 ZIP；仍缺失说明传输/解压不完整，需要重新发送。
2. 如果 Mac 上还保留同一版本原始 ZIP，可重新解压到新目录，按缺失路径复制并先用 \`App/manifest.sha256\` 校验 SHA-256；不要跨版本混用。
3. 如果 \`System/Engine.txt\` 中没有可执行的 wine，安装 CrossOver（或 Apple GPTK），或改用 bundled 引擎包。
4. \`App/manifest.sha256\` 与 \`App/payload-index.tsv\` 是期望文件清单；可据此补齐或重新打包。
5. 把整个诊断 zip 发回给打包者。日志可能含用户名和路径，请勿公开上传。

## 关键路径

- 期望主程序：${WIN2MAC_EXE_PAYLOAD:-未知}
- 工作目录：${WIN2MAC_WORKDIR_PAYLOAD:-未知}
- 启动参数：${WIN2MAC_ARG_COUNT:-0} 个
- Electron：${WIN2MAC_ELECTRON:-0}（兼容参数 ${WIN2MAC_ELECTRON_COMPAT:-0}）
- ADB：arm=${WIN2MAC_HOST_ADB_ARM:-none} x86=${WIN2MAC_HOST_ADB_X86:-none}
- 应用自身日志：\`Prefix/AppLogs/\`（若应用在 Wine 用户目录写过 .log/.txt）
EOF

  cat > "$dir/Report.json" <<EOF
{
  "schema": "win2mac-diagnostics/1",
  "generatedAt": "$(date '+%Y-%m-%dT%H:%M:%S%z')",
  "app": {
    "name": "$(json_escape "${WIN2MAC_APP_NAME:-}")",
    "id": "$(json_escape "${WIN2MAC_APP_ID:-}")",
    "bundleId": "$(json_escape "${WIN2MAC_BUNDLE_ID:-}")",
    "version": "$(json_escape "${WIN2MAC_APP_VERSION:-}")",
    "bundlePath": "$(json_escape "$BUNDLE_DIR")",
    "exe": "$(json_escape "${WIN2MAC_EXE_PAYLOAD:-}")",
    "workdir": "$(json_escape "${WIN2MAC_WORKDIR_PAYLOAD:-}")"
  },
  "system": {
    "os": "$(json_escape "$HOST_OS")",
    "arch": "$(json_escape "$(uname -m 2>/dev/null || echo unknown)")",
    "user": "$(json_escape "$(id -un 2>/dev/null || echo unknown)")",
    "home": "$(json_escape "$HOME")"
  },
  "run": {
    "stage": "$(json_escape "$STAGE")",
    "status": "$(json_escape "$STATUS")",
    "error": "$(json_escape "${ERROR_MESSAGE:-}")",
    "exitCode": "${EXIT_CODE:-null}"
  },
  "paths": {
    "prefix": "$(json_escape "$PREFIX")",
    "launcherLog": "$(json_escape "$LOG")",
    "earlyLog": "$(json_escape "$EARLY_LOG")",
    "payload": "$(json_escape "$RES_DIR/payload")",
    "engine": "$(json_escape "${WINE:-}")"
  },
  "engine": {
    "kind": "$(json_escape "${ENGINE_KIND:-}")",
    "path": "$(json_escape "${WINE:-}")"
  },
  "payload": {
    "version": "$(json_escape "${WIN2MAC_PAYLOAD_VERSION:-}")",
    "manifestCount": $manifest_count,
    "indexFile": "$(json_escape "$index_name")",
    "missingCount": $PAYLOAD_CHECK_MISSING,
    "sizeMismatchCount": $PAYLOAD_CHECK_SIZE,
    "issues": $(json_array_from_lines "$dir/Missing.txt")
  },
  "electron": {
    "detected": "${WIN2MAC_ELECTRON:-0}",
    "compat": "${WIN2MAC_ELECTRON_COMPAT:-0}",
    "name": "$(json_escape "${WIN2MAC_ELECTRON_NAME:-}")"
  },
  "adb": {
    "hostArm": "$(json_escape "${WIN2MAC_HOST_ADB_ARM:-}")",
    "hostX86": "$(json_escape "${WIN2MAC_HOST_ADB_X86:-}")",
    "serverSocket": "$(json_escape "${ADB_SERVER_SOCKET:-}")"
  },
  "logs": {
    "launcher": "Logs/$(basename "$LOG")",
    "early": "Logs/$(basename "$EARLY_LOG")",
    "state": "Logs/state.env",
    "missing": "Missing.txt",
    "files": "Files.txt",
    "engine": "System/Engine.txt",
    "prefix": "Prefix/Prefix.txt"
  },
  "repair": {
    "expectedManifest": "App/manifest.sha256",
    "payloadIndex": "App/payload-index.tsv",
    "instructions": "Resend the original ZIP or rebuild; compare App/payload-index.tsv with the actual payload. Do not upload logs publicly."
  }
}
EOF

  cat > "$dir/README.txt" <<EOF
Win2Mac 失败诊断包
生成时间：$(date '+%Y-%m-%d %H:%M:%S %z')
应用：${WIN2MAC_APP_NAME:-未知}（${WIN2MAC_APP_ID:-未知}）
阶段：$STAGE
错误：${ERROR_MESSAGE:-无}

优先查看：
- Report.md：人类可读汇总
- Report.json：机器可读（供诊断工具/其他 agent）
- Missing.txt：缺失文件与大小不一致清单
- System/Environment.txt、System/Engine.txt
- Prefix/Prefix.txt、Logs/*.log

隐私提示：日志可能含本机用户名、路径和应用输出。只发送给可信的打包者，不要公开上传。
EOF

  DIAG_ZIP=""
  if [ "${WIN2MAC_DIAGNOSTICS_NO_ZIP:-0}" != "1" ]; then
    if command -v ditto >/dev/null 2>&1; then
      if ditto -c -k --sequesterRsrc --keepParent "$dir" "$dir.zip" >/dev/null 2>&1; then
        DIAG_ZIP="$dir.zip"
      fi
    fi
    if [ -z "$DIAG_ZIP" ] && command -v zip >/dev/null 2>&1; then
      if ( cd "$(dirname "$dir")" && zip -qr "$(basename "$dir").zip" "$(basename "$dir")" ) >/dev/null 2>&1; then
        DIAG_ZIP="$dir.zip"
      fi
    fi
  fi
  [ -n "$DIAG_ZIP" ] || DIAG_ZIP="$dir"
  log_line "diagnostics ready: $DIAG_ZIP"
}

HOST_OS="$(uname -s)"
if [ "$HOST_OS" = "Darwin" ]; then
  macos_version=$(sw_vers -productVersion 2>/dev/null | cut -d. -f1)
  if [ -n "$macos_version" ] && [ "$macos_version" -lt 11 ] 2>/dev/null; then
    fail "此应用需要 macOS 11 或更高版本。"
  fi
fi

if [ ! -f "$RES_DIR/manifest.sha256" ]; then
  fail "安装包缺少完整性清单 manifest.sha256，应用文件可能不完整。请重新解压原始 ZIP。"
fi
stage "payload-check" "checking packaged files before copy"
scan_payload_files "$WIN2MAC_LOG_DIR/payload-check-$WIN2MAC_APP_ID.txt"
if [ "$PAYLOAD_CHECK_MISSING" -gt 0 ] || [ "$PAYLOAD_CHECK_SIZE" -gt 0 ]; then
  fail "检测到 ${PAYLOAD_CHECK_MISSING} 个应用文件缺失、${PAYLOAD_CHECK_SIZE} 个文件大小不一致。请用 Finder 重新解压原始 ZIP；仍失败请把诊断包发回。"
fi

notify "正在准备运行环境…"
stage "engine" "selecting Wine engine"
if ! select_engine; then
  fail "未找到可用的 Wine 引擎。可在 Mac 上安装 CrossOver 或 Apple Game Porting Toolkit 后重试，或使用带内置引擎的安装包。日志：$LOG"
fi
ensure_rosetta_if_needed
configure_engine_env
echo "Using engine: $ENGINE_KIND $WINE"
log_line "engine ready: kind=$ENGINE_KIND path=$WINE"
log_line "engine file: $(file "$WINE" 2>&1 || true)"
log_line "engine version: ${WIN2MAC_ENGINE_VERSION:-unknown}"
write_state

export WINEPREFIX="$PREFIX"
export WINEARCH="$WIN2MAC_WINEARCH"
export WINEDEBUG="$WIN2MAC_WINEDEBUG"
WINESERVER="$(dirname "$WINE")/wineserver"
[ -x "$WINESERVER" ] || WINESERVER="$(command -v wineserver 2>/dev/null || true)"

mkdir -p "$PREFIX"
if [ ! -f "$PREFIX/.win2mac/initialized" ]; then
  stage "prefix" "initializing Wine prefix"
  notify "首次运行：正在初始化 Windows 环境（约 30 秒）…"
  echo "Initializing prefix $PREFIX"
  log_line "wineboot start prefix=$PREFIX"
  "$WINE" wineboot -u
  wineboot_rc=$?
  log_line "wineboot rc=$wineboot_rc"
  if [ -n "$WINESERVER" ]; then
    "$WINESERVER" -w
    log_line "wineserver -w rc=$?"
  fi
  if [ ! -d "$PREFIX/drive_c" ]; then
    log_line "prefix check: drive_c missing after wineboot"
    fail "Wine 前缀初始化失败。请查看日志：$LOG"
  fi
  mkdir -p "$PREFIX/.win2mac"
  touch "$PREFIX/.win2mac/initialized"
  log_line "prefix ready: $(find "$PREFIX/drive_c" -maxdepth 1 -mindepth 1 -print 2>/dev/null | tr '\n' ' ')"
fi

PAYLOAD_MARKER="$PREFIX/.win2mac/payload-version"
current_payload=""
[ -f "$PAYLOAD_MARKER" ] && current_payload="$(cat "$PAYLOAD_MARKER")"
if [ "$current_payload" != "$WIN2MAC_PAYLOAD_VERSION" ]; then
  stage "payload" "copying application files"
  notify "正在复制应用文件（$(human_size "$WIN2MAC_PAYLOAD_BYTES")）…"
  log_line "payload copy start: source=$RES_DIR/payload target=$PREFIX/drive_c bytes=$WIN2MAC_PAYLOAD_BYTES"
  CURRENT_WINE_USER="$(detect_wine_user)"
  log_line "payload wine user: ${CURRENT_WINE_USER:-none}"
  copy_payload
  copy_rc=$?
  log_line "payload copy rc=$copy_rc"
  [ "$copy_rc" -eq 0 ] || fail "复制应用文件失败，请检查磁盘空间与权限。日志：$LOG"
  merge_payload_user_profiles "$CURRENT_WINE_USER"
  import_registry_and_runtimes
  copy_userdata
  printf '%s' "$WIN2MAC_PAYLOAD_VERSION" > "$PAYLOAD_MARKER"
  log_line "payload ready: drive_c entries=$(find "$PREFIX/drive_c" -maxdepth 1 -mindepth 1 -print 2>/dev/null | wc -l | tr -d ' ')"
else
  log_line "payload copy skipped: version already $current_payload"
  installed_runtime_version=""
  [ -f "$PREFIX/.win2mac/runtimes-version" ] && installed_runtime_version="$(cat "$PREFIX/.win2mac/runtimes-version")"
  if [ "$installed_runtime_version" != "$WIN2MAC_RUNTIME_VERSION" ]; then
    import_registry_and_runtimes
  fi
fi

apply_custom_env
verify_payload_integrity

if [ "$WIN2MAC_INSTALLER_MODE" = "1" ]; then
  INSTALLER_UNIX="$(payload_path_to_prefix "$WIN2MAC_INSTALLER_PAYLOAD")"
  if [ ! -f "$INSTALLER_UNIX" ]; then
    fail "安装包未找到：${WIN2MAC_INSTALLER_PAYLOAD}。日志：$LOG"
  fi
  INSTALLER_MARKER="$PREFIX/.win2mac/installer-ran"
  installed_installer_version=""
  [ -f "$INSTALLER_MARKER" ] && installed_installer_version="$(cat "$INSTALLER_MARKER")"
  if [ "$installed_installer_version" != "$WIN2MAC_PAYLOAD_VERSION" ]; then
    rm -f "$PREFIX/.win2mac/discovered-exe"
    run_installer "$INSTALLER_UNIX"
  fi
  DISCOVERED_MARKER="$PREFIX/.win2mac/discovered-exe"
  EXE_UNIX=""
  [ -f "$DISCOVERED_MARKER" ] && EXE_UNIX="$(cat "$DISCOVERED_MARKER")"
  if [ -z "$EXE_UNIX" ] || [ ! -f "$EXE_UNIX" ]; then
    notify "安装完成，正在查找主程序…"
    EXE_UNIX="$(discover_installed_exe)"
    log_line "installer discovery: found=${EXE_UNIX:-none}"
    if [ -n "$EXE_UNIX" ] && [ -f "$EXE_UNIX" ]; then
      printf '%s' "$EXE_UNIX" > "$DISCOVERED_MARKER"
    fi
  fi
  if [ -z "$EXE_UNIX" ] || [ ! -f "$EXE_UNIX" ]; then
    fail "安装程序已运行，但未找到主程序。请确认安装完成，并在打包时填写准确的“预期主程序名”；然后使用 Reset-Runtime.command 重置后重试。日志：$LOG"
  fi
  WORKDIR_UNIX="$(dirname "$EXE_UNIX")"
  echo "Discovered installed app: $EXE_UNIX"
else
  EXE_UNIX="$(payload_path_to_prefix "$WIN2MAC_EXE_PAYLOAD")"
  log_line "exe expected: $WIN2MAC_EXE_PAYLOAD -> $EXE_UNIX"
  if [ ! -f "$EXE_UNIX" ]; then
    fail "未找到主程序：${WIN2MAC_EXE_PAYLOAD}。应用可能不完整，或安装路径包含不受支持的符号。日志：$LOG"
  fi
  WORKDIR_UNIX="$(payload_path_to_prefix "$WIN2MAC_WORKDIR_PAYLOAD")"
  if [ ! -d "$WORKDIR_UNIX" ]; then
    WORKDIR_UNIX="$(dirname "$EXE_UNIX")"
    log_line "workdir fallback: $WORKDIR_UNIX"
  fi
  log_line "workdir: $WORKDIR_UNIX"
fi

ARGS=()
arg_index=1
while [ "$arg_index" -le "$WIN2MAC_ARG_COUNT" ]; do
  arg_name="WIN2MAC_ARG_$arg_index"
  ARGS+=("${!arg_name}")
  arg_index=$((arg_index + 1))
done
apply_electron_flags "$EXE_UNIX"
start_host_adb_bridge

stage "launch" "starting Windows application"
notify "启动 ${WIN2MAC_APP_NAME}…"
echo "Launching: $EXE_UNIX ${ARGS[*]:-}"
log_line "launch exe=$EXE_UNIX argCount=${#ARGS[@]} args=${ARGS[*]:-}"
log_line "launch workdir=$WORKDIR_UNIX"
log_line "launch env: WINEPREFIX=$WINEPREFIX WINEDEBUG=$WINEDEBUG ADB_SERVER_SOCKET=${ADB_SERVER_SOCKET:-none} ADB_ADDR=${ANDROID_ADB_SERVER_ADDRESS:-none} ADB_PORT=${ANDROID_ADB_SERVER_PORT:-none}"
log_line "launch PATH=$PATH"
cd "$WORKDIR_UNIX" || fail "无法进入工作目录：$WORKDIR_UNIX"
STATUS="launched"
write_state
if [ "${WIN2MAC_PREVENT_SLEEP:-0}" = "1" ] && command -v caffeinate >/dev/null 2>&1; then
  caffeinate -dimsu "$WINE" "$EXE_UNIX" ${ARGS[@]+"${ARGS[@]}"}
else
  "$WINE" "$EXE_UNIX" ${ARGS[@]+"${ARGS[@]}"}
fi
status=$?
log_line "app exited status=$status"
STATUS="exited"
EXIT_CODE="$status"
write_state
if [ "$status" -ne 0 ]; then
  collect_failure_report || true
  if [ -n "$DIAG_ZIP" ]; then
    show_error "应用已退出（代码 ${status}）。如果应用没有启动，请把诊断包发回：$DIAG_ZIP"
    if [ "${WIN2MAC_NO_GUI:-0}" != "1" ]; then
      command -v open >/dev/null 2>&1 && open -R "$DIAG_ZIP" >/dev/null 2>&1 || true
    fi
  else
    show_error "应用已退出（代码 ${status}）。如果应用没有启动，请把日志反馈给打包者：$LOG"
  fi
fi
exit "$status"
