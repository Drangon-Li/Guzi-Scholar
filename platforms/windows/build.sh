#!/bin/zsh
# Cross-build the Windows installer from macOS.
# Usage: ./platforms/windows/build.sh          -> NSIS installer + portable zip
#        ./platforms/windows/build.sh --dir    -> unpacked directory only
set -eu

SCRIPT_DIR=${0:a:h}
REPO_ROOT=${SCRIPT_DIR:h:h}
APP_SRC="$REPO_ROOT/apps/desktop"

if [[ ! -d "$APP_SRC/node_modules/electron" ]]; then
  echo "==> Installing app dependencies"
  (cd "$APP_SRC" && npm install)
fi

echo "==> Verifying shared application code"
(cd "$APP_SRC" && npm run mcp:build)
(cd "$APP_SRC" && npm run check)

echo "==> Building Windows package"
cd "$SCRIPT_DIR"
if [[ "${1:-}" == "--dir" ]]; then
  npx --yes electron-builder@26 --win --x64 --dir --config electron-builder.win.json
else
  npx --yes electron-builder@26 --win --x64 --config electron-builder.win.json
fi

echo
echo "Artifacts in $SCRIPT_DIR/dist:"
ls -la "$SCRIPT_DIR/dist" 2>/dev/null | tail -n +2
