#!/usr/bin/env bash
# Builds the Windows exe from Linux and drops it in builds/. Run after EVERY change.
# Prerequisites and why each step exists are in the repo root CLAUDE.md ("Build environment").
set -euo pipefail
cd "$(dirname "$0")"

# 1. Rust core tests (run natively; no Windows needed)
cargo test -p efn-core --quiet

# 2. UI tests in headless Chromium against a mock backend (needs tests/node_modules link)
[ -e tests/node_modules ] || ln -s /opt/node-tools/node_modules tests/node_modules
SHOTS="${SHOTS:-/tmp}" node tests/ui.test.mjs > /tmp/efn-ui.log || { grep -v "^PASS" /tmp/efn-ui.log; exit 1; }
grep -c "^PASS" /tmp/efn-ui.log | sed "s/^/UI checks passed: /"

# 3. Windows exe: MSVC target statically links the WebView2 loader => ONE self-contained exe.
#    (The windows-gnu target needs WebView2Loader.dll next to the exe; do not use it for releases.)
command -v cargo-xwin >/dev/null || cargo install cargo-xwin --locked
rustup target add x86_64-pc-windows-msvc >/dev/null
XWIN_ACCEPT_LICENSE=1 cargo xwin build --release -p empty-folder-nuker \
  --target x86_64-pc-windows-msvc --features custom-protocol \
  --xwin-cache-dir "${XWIN_CACHE:-/tmp/xwin-cache}"

# 4. Publish into builds/
mkdir -p builds
cp target/x86_64-pc-windows-msvc/release/empty-folder-nuker.exe builds/EmptyFolderNuker.exe
VER=$(grep -m1 '^version' src-tauri/Cargo.toml | cut -d'"' -f2)
{
  echo "EmptyFolderNuker.exe"
  echo "version : $VER"
  echo "built   : $(date -u +%Y-%m-%dT%H:%MZ)"
  echo "commit  : $(git rev-parse --short HEAD 2>/dev/null || echo unknown) (+ uncommitted changes, if any)"
  echo "size    : $(stat -c %s builds/EmptyFolderNuker.exe) bytes"
  echo "sha256  : $(sha256sum builds/EmptyFolderNuker.exe | cut -d' ' -f1)"
} > builds/BUILDINFO.txt
cat builds/BUILDINFO.txt
