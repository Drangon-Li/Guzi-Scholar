#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$SCRIPT_DIR/../../apps/desktop/tests/windows_package_test.js" "$SCRIPT_DIR/dist/win-unpacked" "$@"
