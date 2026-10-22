"""Estimated token accounting shared by synchronous and streamed AI requests."""
from __future__ import annotations

import math
from typing import Any

from ai_capabilities import get_model_capabilities, normalize_ai_options, resolve_api_format

DEFAULT_CONTEXT_WINDOW = 32768
IMAGE_TOKEN_ESTIMATE = 4096


def estimate_tokens(content: Any) -> int:
    if isinstance(content, list):
        return sum(IMAGE_TOKEN_ESTIMATE if part.get('type') == 'image_url' else estimate_tokens(part.get('text', ''))
                   for part in content if isinstance(part, dict))
    text = str(content or '')
    # UTF-8 weighting leaves more room for CJK, symbols, and code than the
    # English-only four-characters heuristic. This is still an estimate.
    ascii_count = len(text.encode('ascii', errors='ignore'))
    return math.ceil(ascii_count / 3 + (len(text.encode('utf-8')) - ascii_count) / 1.5)


def message_tokens(messages: list[dict]) -> int:
    return 8 + sum(8 + estimate_tokens(item.get('content', '')) for item in messages)


def request_budget(profile: dict, answer_limit: int) -> dict:
    options = normalize_ai_options(profile, strict=True)
    caps = get_model_capabilities(profile)
    configured_window = options['context_window']
    model_window = caps.get('context_window')
    window = min(value for value in (configured_window, model_window) if value) if configured_window or model_window else DEFAULT_CONTEXT_WINDOW
    effort = options['reasoning_effort']
    explicit_thinking = options['thinking_budget']
    if explicit_thinking and caps.get('thinking_budget_supported') is False:
        raise ValueError('此模型不支持指定思考 token 预算，请使用推理强度。')
    if effort == 'none' and explicit_thinking:
        raise ValueError('关闭思考时不能同时设置思考预算。')
    allowed = caps.get('reasoning_efforts')
    if effort != 'auto' and isinstance(allowed, list) and effort not in allowed:
        # Toggle-based APIs can expose supported thinking without effort names.
        if not (effort == 'none' and caps.get('thinking_supported') and not caps.get('thinking_required')):
            raise ValueError(f'此模型不支持推理强度 {effort}。')
    if effort == 'none' and caps.get('thinking_required'):
        raise ValueError('此模型必须启用思考，不能关闭。')
    if (explicit_thinking or effort not in {'auto', 'none'}) and caps.get('thinking_supported') is False:
        raise ValueError('此模型不支持思考设置。')
    for field, compare, label in [('thinking_budget_min', lambda a, b: a < b, '小于最低值'), ('thinking_budget_max', lambda a, b: a > b, '超过最大值')]:
        if explicit_thinking and caps.get(field) and compare(explicit_thinking, caps[field]):
            raise ValueError(f'思考预算{label} {caps[field]}。')
    thinking = explicit_thinking
    if not thinking and effort not in {'auto', 'none'}:
        thinking = {'minimal': 1024, 'low': 2048, 'medium': 4096, 'high': 8192, 'xhigh': 16384, 'max': 32768}.get(effort, 8192)
    elif not thinking and effort == 'auto' and caps.get('thinking_supported'):
        thinking = 4096
    if thinking and not explicit_thinking:
        thinking = min(thinking, window // 2)
        if caps.get('max_output_tokens'):
            thinking = min(thinking, caps['max_output_tokens'] * 3 // 4)
    answer = min(answer_limit, max(256, window // 4))
    api_format = resolve_api_format(profile)
    combined_output = api_format != 'qwen'
    max_output = caps.get('max_output_tokens')
    if max_output:
        answer = min(answer, max_output - thinking if combined_output else max_output)
    if answer <= 0 or thinking + answer >= window:
        raise ValueError('思考与回答预算超过模型上下文或输出上限，请降低思考预算。')
    output = answer + thinking if combined_output else answer
    input_limit = min(window - answer - thinking, caps.get('max_input_tokens') or window)
    return {'window': window, 'output_tokens': output, 'answer_tokens': answer,
            'thinking_tokens': thinking, 'input_limit': input_limit,
            'source': caps.get('source') or 'unknown', 'estimated': True,
            'window_source': 'configured' if configured_window and configured_window == window else ('model' if model_window else 'conservative-default'),
            'tokenizer': 'utf8-weighted-estimate', 'capabilities': caps}


def fit_messages(messages: list[dict], budget: dict, *, removable: list[int] | None = None,
                 truncatable: list[int] | None = None) -> tuple[list[dict], dict]:
    clean = [dict(item) for item in messages]
    removable = list(removable or [])
    truncatable = list(truncatable or [])
    truncated = False
    for index in removable:
        if message_tokens(clean) <= budget['input_limit']:
            break
        clean[index]['content'] = ''
        truncated = True
    for index in truncatable:
        if message_tokens(clean) <= budget['input_limit']:
            break
        text = clean[index].get('content')
        if not isinstance(text, str):
            continue
        low, high = 0, len(text)
        while low < high:
            middle = (low + high + 1) // 2
            clean[index]['content'] = text[:middle]
            if message_tokens(clean) <= budget['input_limit']:
                low = middle
            else:
                high = middle - 1
        clean[index]['content'] = text[:low]
        truncated = truncated or low < len(text)
    clean = [item for item in clean if item.get('content')]
    estimated = message_tokens(clean)
    if estimated > budget['input_limit']:
        raise ValueError('当前问题、选中内容或必要任务文本超过模型输入预算，请缩短选中内容或增大上下文预算。')
    info = {key: value for key, value in budget.items() if key not in {'capabilities', 'input_limit'}}
    info.update(estimated_input_tokens=estimated, truncated=truncated)
    return clean, info
