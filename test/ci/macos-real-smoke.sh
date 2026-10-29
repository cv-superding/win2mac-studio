#!/bin/bash
# Real-macOS smoke test for the Win2Mac launcher and diagnostics.
# Requires an extracted Gcenx Wine tree in WIN2MAC_CI_WINE_ROOT.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="${RUNNER_TEMP:-/tmp}/win2mac-smoke"
WINE_ROOT="${WIN2MAC_CI_WINE_ROOT:?set WIN2MAC_CI_WINE_ROOT to the extracted Gcenx Wine tree}"
APP="$WORK/Smoke.app"
WIN2MAC="$APP/Contents/Resources/win2mac"
PAYLOAD="$WIN2MAC/payload/C/App"
LOG="$WORK/logs/ci-smoke.log"

cleanup() {
  rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "===== smoke failed (rc=$rc) ====="
    echo "--- launcher log ---"
    tail -n 240 "$LOG" 2>/dev/null || true
    echo "--- mac-check output ---"
    tail -n 160 "$WORK/mac-check.out" 2>/dev/null || true
  fi
}
trap cleanup EXIT

rm -rf "$WORK"
mkdir -p "$APP/Contents/MacOS" "$PAYLOAD" "$WORK/logs" "$WORK/prefixes" "$WORK/cache" "$WORK/diag"

WINE_BIN="$(find "$WINE_ROOT" \( -type f -o -type l \) -name wine64 | head -n 1)"
CMD_EXE="$(find "$WINE_ROOT" -type f -path '*x86_64-windows/cmd.exe' | head -n 1)"
if [ -z "$WINE_BIN" ] || [ ! -x "$WINE_BIN" ]; then
  echo "wine64 not found under $WINE_ROOT"
  find "$WINE_ROOT" -maxdepth 3 -print 2>/dev/null | head -n 50 || true
  exit 1
fi
if [ -z "$CMD_EXE" ] || [ ! -f "$CMD_EXE" ]; then
  echo "Wine cmd.exe not found under $WINE_ROOT"
  exit 1
fi
echo "wine64: $WINE_BIN"
echo "cmd.exe: $CMD_EXE"

cp "$ROOT/resources/templates/launcher.sh" "$APP/Contents/MacOS/launcher"
chmod +x "$APP/Contents/MacOS/launcher"
cp "$CMD_EXE" "$PAYLOAD/App.exe"
HASH="$(shasum -a 256 "$PAYLOAD/App.exe" | awk '{print $1}')"
SIZE="$(wc -c < "$PAYLOAD/App.exe" | tr -d ' ')"
printf '%s  C/App/App.exe\n' "$HASH" > "$WIN2MAC/manifest.sha256"
printf 'sha256\tbytes\tpath\n%s\t%s\tC/App/App.exe\n' "$HASH" "$SIZE" > "$WIN2MAC/payload-index.tsv"
printf '{"format":1,"files":[{"path":"C/App/App.exe","bytes":%s,"sha256":"%s"}]}\n' "$SIZE" "$HASH" > "$WIN2MAC/payload-index.json"

cat > "$WIN2MAC/config.env" <<EOF
WIN2MAC_FORMAT='1'
WIN2MAC_APP_NAME='CI Smoke App'
WIN2MAC_APP_ID='ci-smoke'
WIN2MAC_BUNDLE_ID='com.win2mac.ci-smoke'
WIN2MAC_APP_VERSION='1.0'
WIN2MAC_PUBLISHER='Win2Mac CI'
WIN2MAC_PAYLOAD_VERSION='ci-smoke-1'
WIN2MAC_EXE_PAYLOAD='C/App/App.exe'
WIN2MAC_WORKDIR_PAYLOAD='C/App'
WIN2MAC_PAYLOAD_BYTES='$SIZE'
WIN2MAC_INSTALLER_MODE='0'
WIN2MAC_INSTALLER_PAYLOAD=''
WIN2MAC_INSTALLER_WIN=''
WIN2MAC_INSTALLER_TYPE='exe'
WIN2MAC_EXPECTED_EXE=''
WIN2MAC_INSTALLER_ARG_COUNT='0'
WIN2MAC_EXTRA_DRIVES=''
WIN2MAC_ARG_COUNT='2'
WIN2MAC_ARG_1='/c'
WIN2MAC_ARG_2='echo WIN2MAC_SMOKE_OK'
WIN2MAC_REGISTRY_COUNT='0'
WIN2MAC_RUNTIME_COUNT='0'
WIN2MAC_RUNTIME_VERSION='none'
WIN2MAC_USERDATA_COUNT='0'
WIN2MAC_DLL_OVERRIDES='mshtml='
WIN2MAC_WINEDEBUG='-all'
WIN2MAC_ENV_COUNT='0'
WIN2MAC_VERIFY_ON_LAUNCH='1'
WIN2MAC_PREVENT_SLEEP='0'
WIN2MAC_WINEARCH='win64'
WIN2MAC_ENGINE_POLICY='reuse'
WIN2MAC_ENGINE_ORDER='wine'
WIN2MAC_ENGINE_ARCHIVE=''
WIN2MAC_ENGINE_URL=''
WIN2MAC_ENGINE_SHA256=''
WIN2MAC_ENGINE_VERSION='Gcenx Wine 11.18 (CI)'
WIN2MAC_PROXY=''
WIN2MAC_ELECTRON='0'
WIN2MAC_ELECTRON_COMPAT='1'
WIN2MAC_ELECTRON_NAME=''
WIN2MAC_ELECTRON_ARG_COUNT='0'
WIN2MAC_HOST_ADB_ARM=''
WIN2MAC_HOST_ADB_X86=''
WIN2MAC_PREFIX_ROOT='$WORK/prefixes'
WIN2MAC_LOG_DIR='$WORK/logs'
WIN2MAC_CACHE_ROOT='$WORK/cache'
EOF

cat > "$APP/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.win2mac.ci-smoke</string>
<key>CFBundleExecutable</key><string>launcher</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>CFBundleVersion</key><string>1.0</string>
<key>LSMinimumSystemVersion</key><string>11.0</string>
</dict></plist>
EOF

export WIN2MAC_WINE="$WINE_BIN"
export WIN2MAC_PREFIX_ROOT="$WORK/prefixes"
export WIN2MAC_LOG_DIR="$WORK/logs"
export WIN2MAC_CACHE_ROOT="$WORK/cache"
export WIN2MAC_DIAGNOSTICS_DIR="$WORK/diag"
export WIN2MAC_NO_GUI=1
export WIN2MAC_PREVENT_SLEEP=0

launcher_run() {
  "$APP/Contents/MacOS/launcher" --debug > "$WORK/run-$1.out" 2>&1
}

echo "===== first launch ====="
if ! launcher_run first; then
  echo "first launch failed"
  exit 1
fi
grep -q 'WIN2MAC_SMOKE_OK' "$LOG"
grep -q 'STAGE launch' "$LOG"
grep -q 'payload check: checked=1 missing=0 sizeMismatch=0' "$LOG"
grep -q 'app exited status=0' "$LOG"
test -f "$WORK/prefixes/ci-smoke/.win2mac/initialized"
test -f "$WORK/prefixes/ci-smoke/drive_c/App/App.exe"

echo "===== second launch (payload must not be copied again) ====="
if ! launcher_run second; then
  echo "second launch failed"
  exit 1
fi
grep -q 'payload copy skipped' "$LOG"

echo "===== missing file must produce diagnostics ====="
mv "$PAYLOAD/App.exe" "$WORK/App.exe.bak"
if launcher_run missing; then
  echo "expected missing payload launch to fail"
  exit 1
fi
DIAG="$(find "$WORK/diag" -maxdepth 1 -type d -name 'Win2Mac-失败诊断-ci-smoke-*' | head -n 1)"
if [ -z "$DIAG" ]; then
  echo "diagnostics folder not found"
  exit 1
fi
grep -q 'MISSING.*C/App/App.exe' "$DIAG/Missing.txt"
grep -q '"missingCount": 1' "$DIAG/Report.json"
test -f "$DIAG/Report.md"
test -f "$DIAG/Repair.md"
mv "$WORK/App.exe.bak" "$PAYLOAD/App.exe"

echo "===== mac-check on the same bundle ====="
CHECK_OUT="$WORK/check"
mkdir -p "$CHECK_OUT"
WIN2MAC_CHECK_APP="$APP" \
WIN2MAC_CHECK_OUTDIR="$CHECK_OUT" \
WIN2MAC_CHECK_NO_PROMPT=1 \
WIN2MAC_CHECK_NO_LAUNCH=1 \
WIN2MAC_CHECK_NO_ZIP=1 \
WIN2MAC_WINE="$WINE_BIN" \
WIN2MAC_PREFIX_ROOT="$WORK/prefixes" \
WIN2MAC_LOG_DIR="$WORK/logs" \
  bash "$ROOT/resources/templates/mac-check.command" > "$WORK/mac-check.out" 2>&1
grep -q '\[PASS\] 文件清单' "$WORK/mac-check.out"
grep -q '\[PASS\] 完整性校验' "$WORK/mac-check.out"
REPORT="$(find "$CHECK_OUT" -name Report.json | head -n 1)"
if [ -z "$REPORT" ]; then
  echo "mac-check Report.json missing"
  exit 1
fi
grep -q '"missingCount": 0' "$REPORT"
test -f "$(dirname "$REPORT")/Repair.md"

echo "SMOKE_OK: real macOS launcher, Wine engine, payload index and diagnostics all passed"
