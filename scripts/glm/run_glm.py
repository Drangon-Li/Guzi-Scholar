#!/usr/bin/env python3
import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import sys
import time


def write_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('pdf', type=Path)
    ap.add_argument('output_dir', type=Path)
    ap.add_argument('--base', type=Path, default=Path(os.environ.get('BASE', Path(__file__).resolve().parents[2])))
    ap.add_argument('--port', type=int, default=int(os.environ.get('GLM_PORT', '8080')))
    ap.add_argument('--layout-device', default='cuda:0')
    ap.add_argument('--max-pages', type=int, default=None, help='First N pages; default: whole PDF')
    args = ap.parse_args()
    if args.max_pages is not None and args.max_pages < 1:
        ap.error('--max-pages must be positive')
    pdf = args.pdf.resolve(strict=True)
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)
    if (output / 'run.json').exists():
        raise FileExistsError(f'Refusing to overwrite existing run: {output}')
    os.environ.setdefault('HF_HOME', str(args.base / 'cache/huggingface'))
    from glmocr import GlmOcr
    from glmocr.config import load_config
    import pymupdf
    import torch

    models = json.loads((args.base / 'models/glm-models.json').read_text())
    overrides = {
        'pipeline.maas.enabled': False,
        'pipeline.ocr_api.api_host': '127.0.0.1',
        'pipeline.ocr_api.api_port': args.port,
        'pipeline.ocr_api.model': 'glm-ocr',
        'pipeline.ocr_api.api_url': f'http://127.0.0.1:{args.port}/v1/chat/completions',
        'pipeline.layout.model_dir': models['layout']['snapshot_path'],
        'pipeline.layout.device': args.layout_device,
        'pipeline.max_workers': 8,
        'pipeline.page_loader.pdf_max_pages': args.max_pages,
    }
    with pymupdf.open(pdf) as doc:
        page_info = [{'page_index': i, 'page_number': i + 1,
                      'width_points': p.rect.width, 'height_points': p.rect.height}
                     for i, p in enumerate(doc) if args.max_pages is None or i < args.max_pages]
    start = time.monotonic()
    metadata = {
        'status': 'running', 'pdf': str(pdf),
        'sha256': hashlib.sha256(pdf.read_bytes()).hexdigest(),
        'models': models, 'audited_upstream_commit': '0288f96bb9e78cb439883eaa725eeae90bd177c5',
        'installed_sdk_source_sha256': {
            name: hashlib.sha256((Path(sys.modules['glmocr'].__file__).parent / name).read_bytes()).hexdigest()
            for name in ['api.py', 'config.py', 'config.yaml']
        },
        'versions': {k: importlib.metadata.version(k) for k in ['glmocr', 'vllm', 'transformers', 'torch', 'torchvision']},
        'torch_cuda': torch.version.cuda,
        'gpu': torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        'command': sys.argv, 'pages': page_info,
        'bbox_coordinate_system': 'SDK bbox_2d normalized 0..1000; page arrays are 0-based',
        'intentional_default_changes': {
            'maas.enabled': 'true -> false (local inference)',
            'max_workers': '32 -> 8 (bounded service concurrency)',
            'label_task_mapping': 'Move footnote, aside_text, reference from abandon to text; preserve academic footnotes and bibliography labels',
            'layout.device': f'auto -> {args.layout_device}',
        },
        'server_settings': {'max_model_len': int(os.environ.get('GLM_MAX_MODEL_LEN', '16384')),
                            'gpu_memory_utilization': float(os.environ.get('GLM_GPU_MEMORY_UTILIZATION', '0.15')),
                            'max_num_seqs': 8, 'enforce_eager': True,
                            'speculative_config': None if os.environ.get('GLM_DISABLE_MTP') == '1' else {'method': 'mtp', 'num_speculative_tokens': 3},
                            'rotary_native': os.environ.get('GLM_ROTARY_NATIVE') == '1',
                            'compilation_config': {'custom_ops': ['all', '-rotary_embedding']} if os.environ.get('GLM_ROTARY_NATIVE') == '1' else None},
    }
    write_json(output / 'run.json', metadata)
    try:
        mapping = load_config(mode='selfhosted').pipeline.layout.label_task_mapping
        for label in ['footnote', 'aside_text', 'reference']:
            mapping['abandon'].remove(label)
            mapping['text'].append(label)
        overrides['pipeline.layout.label_task_mapping'] = mapping
        with GlmOcr(mode='selfhosted', _dotted=overrides, log_level='DEBUG') as parser:
            write_json(output / 'effective-config.json', parser.config_model.model_dump())
            result = parser.parse(str(pdf), save_layout_visualization=True, preserve_order=True)
            result.save(output_dir=str(output), save_layout_visualization=True)
            if not isinstance(result.json_result, list) or len(result.json_result) != len(page_info):
                raise RuntimeError('SDK returned unexpected page count/schema')
            pages = [{**info, 'blocks': blocks} for info, blocks in zip(page_info, result.json_result)]
            write_json(output / 'layout-pages.json', {'bbox_units': 'normalized_0_1000', 'pages': pages})
            if not result.markdown_result or not result.markdown_result.strip():
                raise RuntimeError('Empty Markdown output')
        metadata['status'] = 'completed'
    except BaseException as exc:
        metadata.update(status='failed', error=f'{type(exc).__name__}: {exc}')
        raise
    finally:
        metadata['elapsed_seconds'] = time.monotonic() - start
        write_json(output / 'run.json', metadata)


if __name__ == '__main__':
    main()
