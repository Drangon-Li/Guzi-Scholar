#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/env.sh"
pdf="${1:?Usage: run_mineru.sh INPUT.pdf OUTPUT_DIR [standard|advanced] [EXPECTED_PAGES]}"
out="${2:?Usage: run_mineru.sh INPUT.pdf OUTPUT_DIR [standard|advanced] [EXPECTED_PAGES]}"
tier="${3:-standard}"
expected_pages="${4:-}"
case "$tier" in standard|advanced) ;; *) exit 2 ;; esac
if [[ -e "$out" ]]; then
    echo "Output already exists; choose a fresh directory: $out" >&2
    exit 2
fi
mkdir -p "$out"
export MINERU_MODEL_SOURCE=local
"$MINERU4_VENV/bin/mineru-kit" models verify --tier standard --small-backend torch --vlm-engine vllm
"$MINERU4_VENV/bin/python" "$script_dir/record_run.py" "$pdf" "$out" "$tier" before
"$MINERU4_VENV/bin/python" "$script_dir/timed_command.py" "$out/time.json" "$MINERU4_VENV/bin/mineru-kit" parse "$pdf" --pages all --tier "$tier" --ocr-mode auto --format zip --output "$out/result.zip" --verbose
"$MINERU4_VENV/bin/python" "$script_dir/record_run.py" "$pdf" "$out" "$tier" after
if [[ -z "$expected_pages" ]]; then
    expected_pages="$("$MINERU4_VENV/bin/python" -c 'import sys,pypdfium2; doc=pypdfium2.PdfDocument(sys.argv[1]); print(len(doc)); doc.close()' "$pdf")"
fi
"$MINERU4_VENV/bin/python" "$script_dir/export_and_check.py" "$out/result.zip" "$out/extracted" "$expected_pages"
