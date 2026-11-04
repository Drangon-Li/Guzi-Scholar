"""Helpers for AI-suggested highlights.

Local candidate selection used before (or instead of) a model call, plus the
signature and source checks that keep AI highlights distinct from the user's
own annotations.
"""

from __future__ import annotations

import hashlib
import re
from typing import Any, Dict, List

from ai import is_metadata_block


def _highlight_signature(block_id: Any, quote: Any, category: Any) -> str:
    material = "\n".join((str(block_id or "").strip(), str(category or "method").strip(), str(quote or "").strip()))
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


_LOCAL_HIGHLIGHT_MARKERS = {
    "research_goal": ("we present", "we propose", "this paper", "our goal", "we aim"),
    "method": ("pre-training", "pretraining", "pretrain", "encoder", "transformer", "fine-tun", "optimiz", "task"),
    "innovation": ("unified", "multiway", "novel", "first", "introduce", "stagewise", "general-purpose"),
    "conclusion": ("experimental results", "results demonstrate", "achieves", "outperforms", "state-of-the-art", "improves", "competitive performance"),
}


def _local_highlight_candidates(blocks: List[dict], limit: int = 8) -> List[Dict[str, Any]]:
    """Create conservative, verbatim highlights when the optional model is empty."""
    candidates: List[tuple[Dict[str, Any], Dict[str, int]]] = []
    for block in blocks:
        raw_text = str(block.get("text", "")).strip()
        text = re.sub(r"<[^>]+>", "", raw_text).strip()
        if len(text) < 120 or is_metadata_block(block, text) or any(marker in text for marker in ("MMLab", "Corresponding author")):
            continue
        quote = re.split(r"(?<=[.!?。！？])\s+", text)[0][:300].strip()
        lower = text.lower()
        scores = {category: sum(lower.count(marker) for marker in markers) for category, markers in _LOCAL_HIGHLIGHT_MARKERS.items()}
        candidates.append(({
            "block_id": block.get("block_id"),
            "quote": quote,
            "category": "method",
            "reason": "本地规则候选（未调用模型）",
        }, scores))
    if not candidates:
        return []

    selected: List[Dict[str, Any]] = []
    used_blocks: set[str] = set()
    category_order = ("research_goal", "method", "innovation", "conclusion")
    for category in category_order:
        ranked = sorted(
            candidates,
            key=lambda pair: (pair[1].get(category, 0), max(pair[1].values()), len(str(pair[0].get("quote", "")))),
            reverse=True,
        )
        chosen = next((pair for pair in ranked if str(pair[0].get("block_id")) not in used_blocks and pair[1].get(category, 0) > 0), None)
        if chosen is None:
            chosen = next((pair for pair in ranked if str(pair[0].get("block_id")) not in used_blocks), None)
        if chosen is None:
            continue
        item = dict(chosen[0])
        item["category"] = category
        selected.append(item)
        used_blocks.add(str(item.get("block_id")))

    remaining = sorted(candidates, key=lambda pair: (max(pair[1].values()), len(str(pair[0].get("quote", "")))), reverse=True)
    for candidate, _scores in remaining:
        if len(selected) >= limit:
            break
        block_id = str(candidate.get("block_id"))
        if block_id in used_blocks:
            continue
        selected.append(dict(candidate))
        used_blocks.add(block_id)
    return selected[:limit]


def _is_ai_annotation(item: Dict[str, Any]) -> bool:
    source = str(item.get("source") or "").strip().lower()
    if source == "ai":
        return True
    if source == "manual":
        return False
    return item.get("kind") == "highlight" and item.get("start") is None and item.get("end") is None
