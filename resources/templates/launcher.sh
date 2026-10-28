#!/bin/bash
# Win2Mac launcher: prepares a Wine prefix from the packaged payload and starts the app.
set -u

BUNDLE_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
RES_DIR="$(cd "$(dirname "$0")/../Resources/win2mac" && pwd)"
CONFIG_FILE="$RES_DIR/config.env"
OSASCRIPT="$(command -v osascript 2>/dev/null || true)"

if [ ! -f "$CONFIG_FILE" ]; then
  if [ -n "$OSASCRIPT" ]; then
    "$OSASCRIPT" - "$(basename "$BUNDLE_DIR" .app)" "安装包缺少 config.env，无法启动。" <<'APPLESCRIPT' 2>/dev/null || true
on run argv
  display alert (item 1 of argv) message (item 2 of argv) as critical
end run
APPLESCRIPT
  fi
  exit 1
fi

# shellcheck disable=SC1090
. "$CONFIG_FILE"

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

mkdir -p "$WIN2MAC_LOG_DIR" 2>/dev/null
LOG="$WIN2MAC_LOG_DIR/$WIN2MAC_APP_ID.log"
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG" | tr -d ' ')" -gt 5000000 ]; then
  mv "$LOG" "$LOG.1" 2>/dev/null
fi
exec >>"$LOG" 2>&1
echo "===== $(date '+%Y-%m-%d %H:%M:%S') launch $WIN2MAC_APP_NAME ($WIN2MAC_APP_ID) ====="

notify() {
  [ -n "$OSASCRIPT" ] || return 0
  "$OSASCRIPT" - "Win2Mac · $WIN2MAC_APP_NAME" "$1" <<'APPLESCRIPT' >/dev/null 2>&1
on run argv
  display notification (item 2 of argv) with title (item 1 of argv)
end run
APPLESCRIPT
}

show_error() {
  echo "ERROR: $1"
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

fail() {
  show_error "$1"
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
      echo "引擎 SHA-256 不匹配，拒绝解压。期望 $WIN2MAC_ENGINE_SHA256，实际 $actual" >&2
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
  existing=$(find_wine_binary "$cache" 2>/dev/null) && { printf '%s\n' "$existing"; return 0; }
  mkdir -p "$WIN2MAC_CACHE_ROOT/engines" || return 1
  local tmp="$cache.tmp.$$"
  rm -rf "$tmp"
  mkdir -p "$tmp" || return 1
  notify "首次运行：正在解压 Wine 引擎（$(human_size $(wc -c < "$archive" | tr -d ' '))）…"
  if ! tar -xf "$archive" -C "$tmp"; then
    if command -v xz >/dev/null 2>&1 && xz -dc "$archive" | tar -xf - -C "$tmp"; then
      :
    else
      rm -rf "$tmp"
      return 1
    fi
  fi
  existing=$(find_wine_binary "$tmp" 2>/dev/null)
  if [ -z "$existing" ]; then
    rm -rf "$tmp"
    echo "解压完成但未找到 wine 可执行文件" >&2
    return 1
  fi
  rm -rf "$cache"
  mv "$tmp" "$cache" || return 1
  xattr -dr com.apple.quarantine "$cache" >/dev/null 2>&1 || true
  existing=$(find_wine_binary "$cache" 2>/dev/null)
  [ -n "$existing" ] && { printf '%s\n' "$existing"; return 0; }
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
  [ -n "$url" ] || return 1
  local key="engine-${WIN2MAC_ENGINE_SHA256:0:16}"
  if [ -z "$WIN2MAC_ENGINE_SHA256" ]; then
    key="engine-$(basename "$url" | tr -c 'A-Za-z0-9._-' '_')"
  fi
  local cache="$WIN2MAC_CACHE_ROOT/engines/$key"
  local existing
  existing=$(find_wine_binary "$cache" 2>/dev/null) && { printf '%s\n' "$existing"; return 0; }
  mkdir -p "$WIN2MAC_CACHE_ROOT/downloads" || return 1
  local archive="$WIN2MAC_CACHE_ROOT/downloads/$key.tar.xz"
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
      return 1
    fi
    mv "$archive.part" "$archive" || return 1
  fi
  if [ -n "$WIN2MAC_ENGINE_SHA256" ]; then
    local actual
    actual=$(file_sha256 "$archive")
    if [ -n "$actual" ] && [ "$actual" != "$WIN2MAC_ENGINE_SHA256" ]; then
      echo "下载的引擎 SHA-256 不匹配（期望 $WIN2MAC_ENGINE_SHA256，实际 $actual）" >&2
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
    return 0
  fi

  if [ "$WIN2MAC_ENGINE_POLICY" = "bundled" ]; then
    if [ -n "$WIN2MAC_ENGINE_ARCHIVE" ] && [ -f "$RES_DIR/$WIN2MAC_ENGINE_ARCHIVE" ]; then
      candidate=$(extract_engine_archive "$RES_DIR/$WIN2MAC_ENGINE_ARCHIVE") && {
        WINE="$candidate"
        ENGINE_KIND="wine"
        return 0
      }
    fi
    candidate=$(find_cached_engine) && { WINE="$candidate"; ENGINE_KIND="wine"; return 0; }
  fi

  local old_ifs="$IFS"
  IFS=','
  for kind in $WIN2MAC_ENGINE_ORDER; do
    IFS="$old_ifs"
    candidate=$(try_engine_kind "$kind") && {
      WINE="$candidate"
      ENGINE_KIND=$(engine_kind_for "$WINE")
      return 0
    }
  done
  IFS="$old_ifs"

  candidate=$(find_cached_engine) && { WINE="$candidate"; ENGINE_KIND="wine"; return 0; }

  if [ -n "$WIN2MAC_ENGINE_ARCHIVE" ] && [ -f "$RES_DIR/$WIN2MAC_ENGINE_ARCHIVE" ]; then
    candidate=$(extract_engine_archive "$RES_DIR/$WIN2MAC_ENGINE_ARCHIVE") && {
      WINE="$candidate"
      ENGINE_KIND="wine"
      return 0
    }
  fi

  if [ "$WIN2MAC_ENGINE_POLICY" = "reuse" ]; then
    return 1
  fi
  candidate=$(download_and_extract_engine) && { WINE="$candidate"; ENGINE_KIND="wine"; return 0; }
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
  [ "${WIN2MAC_VERIFY_ON_LAUNCH:-0}" = "1" ] || return 0
  notify "启动前校验应用文件…"
  if command -v shasum >/dev/null 2>&1; then
    ( cd "$RES_DIR/payload" && shasum -a 256 -c "$RES_DIR/manifest.sha256" >/dev/null 2>&1 ) || fail "应用文件完整性校验失败，请重新解压原始 ZIP。日志：$LOG"
  else
    echo "shasum not available, skipping integrity verification"
  fi
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
  local installer_args=()
  local arg_index=1
  while [ "$arg_index" -le "$WIN2MAC_INSTALLER_ARG_COUNT" ]; do
    local arg_name="WIN2MAC_INSTALLER_ARG_$arg_index"
    installer_args+=("${!arg_name}")
    arg_index=$((arg_index + 1))
  done
  notify "首次运行：即将启动安装程序，请在 Wine 窗口中完成安装…"
  echo "Running installer: $WIN2MAC_INSTALLER_WIN ${installer_args[*]:-}"
  local install_status=0
  if [ "$WIN2MAC_INSTALLER_TYPE" = "msi" ]; then
    "$WINE" msiexec /i "$WIN2MAC_INSTALLER_WIN" ${installer_args[@]+"${installer_args[@]}"}
    install_status=$?
  else
    "$WINE" "$WIN2MAC_INSTALLER_WIN" ${installer_args[@]+"${installer_args[@]}"}
    install_status=$?
  fi
  [ -n "$WINESERVER" ] && "$WINESERVER" -w
  if [ "$install_status" -ne 0 ]; then
    fail "安装程序退出（代码 $install_status）。可重新打开应用重试安装；如果安装程序已经完成但仍报错，请重置运行环境。日志：$LOG"
  fi
  mkdir -p "$PREFIX/.win2mac"
  printf '%s' "$WIN2MAC_PAYLOAD_VERSION" > "$PREFIX/.win2mac/installer-ran"
}

copy_payload() {
  local payload_dir="$RES_DIR/payload"
  [ -d "$payload_dir" ] || fail "安装包缺少应用文件（payload）。"
  local drive src dest
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
    if command -v ditto >/dev/null 2>&1; then
      ditto "$src/" "$dest/" || return 1
    else
      cp -R "$src/." "$dest/" || return 1
    fi
  done
  return 0
}

import_registry_and_runtimes() {
  local setup_dir="$PREFIX/drive_c/win2mac-setup"
  mkdir -p "$setup_dir/registry" "$setup_dir/runtimes"
  local i=1 file base
  while [ "$i" -le "$WIN2MAC_REGISTRY_COUNT" ]; do
    local var="WIN2MAC_REGISTRY_$i"
    file="${!var}"
    if [ -n "$file" ] && [ -f "$RES_DIR/$file" ]; then
      cp "$RES_DIR/$file" "$setup_dir/registry/$i.reg"
      echo "Importing registry $i"
      "$WINE" reg import "C:\\win2mac-setup\\registry\\$i.reg"
    fi
    i=$((i + 1))
  done

  local runtime_marker="$PREFIX/.win2mac/runtimes-version"
  local installed_runtime=""
  [ -f "$runtime_marker" ] && installed_runtime="$(cat "$runtime_marker")"
  if [ "$installed_runtime" != "$WIN2MAC_RUNTIME_VERSION" ]; then
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
        notify "首次运行：正在安装 ${!label_var}…"
        if [ "${!kind_var:-exe}" = "msi" ]; then
          "$WINE" msiexec /i "C:\\win2mac-setup\\runtimes\\$base" ${!args_var}
        else
          "$WINE" start /wait "C:\\win2mac-setup\\runtimes\\$base" ${!args_var}
        fi
        [ -n "$WINESERVER" ] && "$WINESERVER" -w
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
        mkdir -p "$(dirname "$dest")"
        ditto "$RES_DIR/$source" "$dest"
        echo "Restored user data to $dest"
      fi
    fi
    i=$((i + 1))
  done
}

HOST_OS="$(uname -s)"
if [ "$HOST_OS" = "Darwin" ]; then
  macos_version=$(sw_vers -productVersion 2>/dev/null | cut -d. -f1)
  if [ -n "$macos_version" ] && [ "$macos_version" -lt 11 ] 2>/dev/null; then
    fail "此应用需要 macOS 11 或更高版本。"
  fi
fi

PREFIX="$WIN2MAC_PREFIX_ROOT/$WIN2MAC_APP_ID"
notify "正在准备运行环境…"
if ! select_engine; then
  fail "未找到可用的 Wine 引擎。可在 Mac 上安装 CrossOver 或 Apple Game Porting Toolkit 后重试，或使用带内置引擎的安装包。日志：$LOG"
fi
ensure_rosetta_if_needed
configure_engine_env
echo "Using engine: $ENGINE_KIND $WINE"

export WINEPREFIX="$PREFIX"
export WINEARCH="$WIN2MAC_WINEARCH"
export WINEDEBUG="$WIN2MAC_WINEDEBUG"
WINESERVER="$(dirname "$WINE")/wineserver"
[ -x "$WINESERVER" ] || WINESERVER="$(command -v wineserver 2>/dev/null || true)"

mkdir -p "$PREFIX"
if [ ! -f "$PREFIX/.win2mac/initialized" ]; then
  notify "首次运行：正在初始化 Windows 环境（约 30 秒）…"
  echo "Initializing prefix $PREFIX"
  "$WINE" wineboot -u
  [ -n "$WINESERVER" ] && "$WINESERVER" -w
  if [ ! -d "$PREFIX/drive_c" ]; then
    fail "Wine 前缀初始化失败。请查看日志：$LOG"
  fi
  mkdir -p "$PREFIX/.win2mac"
  touch "$PREFIX/.win2mac/initialized"
fi

PAYLOAD_MARKER="$PREFIX/.win2mac/payload-version"
current_payload=""
[ -f "$PAYLOAD_MARKER" ] && current_payload="$(cat "$PAYLOAD_MARKER")"
if [ "$current_payload" != "$WIN2MAC_PAYLOAD_VERSION" ]; then
  notify "正在复制应用文件（$(human_size "$WIN2MAC_PAYLOAD_BYTES")）…"
  copy_payload || fail "复制应用文件失败，请检查磁盘空间与权限。日志：$LOG"
  import_registry_and_runtimes
  copy_userdata
  printf '%s' "$WIN2MAC_PAYLOAD_VERSION" > "$PAYLOAD_MARKER"
else
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
    fail "安装包未找到：$WIN2MAC_INSTALLER_PAYLOAD。日志：$LOG"
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
  if [ ! -f "$EXE_UNIX" ]; then
    fail "未找到主程序：$WIN2MAC_EXE_PAYLOAD。应用可能不完整，或安装路径包含不受支持的符号。日志：$LOG"
  fi
  WORKDIR_UNIX="$(payload_path_to_prefix "$WIN2MAC_WORKDIR_PAYLOAD")"
  if [ ! -d "$WORKDIR_UNIX" ]; then
    WORKDIR_UNIX="$(dirname "$EXE_UNIX")"
  fi
fi

ARGS=()
arg_index=1
while [ "$arg_index" -le "$WIN2MAC_ARG_COUNT" ]; do
  arg_name="WIN2MAC_ARG_$arg_index"
  ARGS+=("${!arg_name}")
  arg_index=$((arg_index + 1))
done

notify "启动 $WIN2MAC_APP_NAME…"
echo "Launching: $EXE_UNIX ${ARGS[*]:-}"
cd "$WORKDIR_UNIX" || fail "无法进入工作目录：$WORKDIR_UNIX"
if [ "${WIN2MAC_PREVENT_SLEEP:-0}" = "1" ] && command -v caffeinate >/dev/null 2>&1; then
  caffeinate -dimsu "$WINE" "$EXE_UNIX" ${ARGS[@]+"${ARGS[@]}"}
else
  "$WINE" "$EXE_UNIX" ${ARGS[@]+"${ARGS[@]}"}
fi
status=$?
echo "Exited with status $status"
if [ "$status" -ne 0 ]; then
  show_error "应用已退出（代码 $status）。如果应用没有启动，请把日志反馈给打包者。"
fi
exit "$status"
