#!/usr/bin/env bash
set -euo pipefail
BASE=${BASE:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)}
VENV=${GLM_VENV:-$BASE/envs/glm}
export HF_HOME=${HF_HOME:-$BASE/cache/huggingface}
export VLLM_CACHE_ROOT=${VLLM_CACHE_ROOT:-$BASE/cache/vllm}
export TRITON_CACHE_DIR=${TRITON_CACHE_DIR:-$BASE/cache/triton}
export TORCHINDUCTOR_CACHE_DIR=${TORCHINDUCTOR_CACHE_DIR:-$BASE/cache/torchinductor}
export CUDA_VISIBLE_DEVICES=${CUDA_VISIBLE_DEVICES:-0}
MODEL_PATH=$("$VENV/bin/python" -c 'import json,sys; print(json.load(open(sys.argv[1]))["ocr"]["snapshot_path"])' "$BASE/models/glm-models.json")
DIAGNOSTIC_ARGS=()
ROTARY_ARGS=()
if [[ ${GLM_ROTARY_NATIVE:-0} == 1 ]]; then
  ROTARY_ARGS+=(--compilation-config '{"custom_ops":["all","-rotary_embedding"]}')
fi
MTP_ARGS=()
if [[ ${GLM_DISABLE_MTP:-0} != 1 ]]; then
  MTP_ARGS+=(--speculative-config '{"method":"mtp","num_speculative_tokens":3}')
fi
if [[ ${GLM_DIAGNOSTICS:-0} == 1 ]]; then
  export VLLM_LOGGING_LEVEL=DEBUG
  DIAGNOSTIC_ARGS+=(--enable-log-requests)
fi
exec "$VENV/bin/vllm" serve "$MODEL_PATH" \
  --served-model-name glm-ocr --host 127.0.0.1 --port "${GLM_PORT:-8080}" \
  --dtype bfloat16 --max-model-len "${GLM_MAX_MODEL_LEN:-16384}" \
  --gpu-memory-utilization "${GLM_GPU_MEMORY_UTILIZATION:-0.15}" \
  --max-num-seqs 8 --enforce-eager \
  "${MTP_ARGS[@]}" \
  "${ROTARY_ARGS[@]}" \
  "${DIAGNOSTIC_ARGS[@]}"
