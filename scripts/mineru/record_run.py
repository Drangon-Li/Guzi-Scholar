import hashlib
import importlib.metadata
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from mineru.config import config
from mineru.model.vlm.engine_utils import set_default_gpu_memory_utilization

pdf, out, tier, stage = sys.argv[1:]
gpu_memory_utilization = set_default_gpu_memory_utilization()
assert gpu_memory_utilization <= 0.5, 'MinerU default VLM memory budget exceeds 50%'
data = {
    'started_utc': datetime.now(timezone.utc).isoformat(),
    'input': str(Path(pdf).resolve()),
    'input_sha256': hashlib.file_digest(open(pdf, 'rb'), 'sha256').hexdigest(),
    'version': importlib.metadata.version('mineru'),
    'options': {'tier': tier, 'ocr_mode': 'auto', 'pages': 'all', 'image_analysis': True, 'format': 'zip'},
    'model_config': config.model.model_dump(exclude={'vlm': {'api_key'}}),
    'render_config': config.render.model_dump(),
    'llm_features': config.llm_aided.features.model_dump(),
    'cuda_visible_devices': os.getenv('CUDA_VISIBLE_DEVICES'),
    'vlm_gpu_memory_utilization': gpu_memory_utilization,
}
assert not config.model.vlm.server_url
assert config.model.small_backend == 'torch'
assert config.model.vlm.engine == 'vllm'
assert not config.llm_aided.features.title_leveling
assert not config.llm_aided.features.cross_page_table_cell_merge
Path(out, f'run-{stage}.json').write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
