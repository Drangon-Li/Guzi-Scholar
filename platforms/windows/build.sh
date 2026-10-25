#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ "${1:-}" = "--dir" ]; then
  exec node "$SCRIPT_DIR/build-windows.cjs" dir
fi
exec node "$SCRIPT_DIR/build-windows.cjs" "${1:-dist}"
