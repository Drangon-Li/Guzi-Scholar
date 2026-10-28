"""Build an isolated, synthetic Attention sample for browser-demo smoke tests."""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import runtime  # noqa: E402
from content_store import _sync_content_file, _translation_key, _write_media_layout, _write_translation_records  # noqa: E402
from job_store import JobStore  # noqa: E402
from library_store import LibraryStore  # noqa: E402
from seed_library import READER_DOCUMENT_CSS, _block_html, _minimal_pdf, _png  # noqa: E402


JOB_ID = "8065bbad761a6255"
TITLE = "Attention — Synthetic Browser Demo"
FILENAME = "attention-synthetic-browser-demo.pdf"
STAMP = "2026-01-01T00:00:00+00:00"
PARAGRAPHS = [
    (
        "This synthetic example describes a sequence model based solely on attention. "
        "It is a small browser test fixture, not a reproduction of a research paper.",
        "这个合成示例描述了一个完全基于注意力的序列模型。它是一个小型浏览器测试样例，并非研究论文的复现。",
    ),
    (
        "In this synthetic scaled dot-product attention example, queries and keys produce "
        "scores that weight the values.",
        "在这个合成的缩放点积注意力示例中，查询和键产生分数，用于对值进行加权。",
    ),
    (
        "Synthetic multi-head attention combines several small attention heads so that "
        "they can inspect different representation subspaces.",
        "合成的多头注意力组合了几个小型注意力头，使它们能够查看不同的表示子空间。",
    ),
]
NOTES = "# Synthetic Attention notes\n\nThis note belongs only to the browser-demo test fixture.\n"
MEDIA_BLOCK_ID = "block-1-4-image"
MEDIA_ASSET = "assets/images/synthetic-attention@300.png"


def _write_json(path: Path, payload: object) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def seed(data_root: Path) -> list[str]:
    """Populate an empty root without reading existing app data or using the network."""
    data_root = Path(data_root)
    if data_root.is_symlink() or (data_root.exists() and (not data_root.is_dir() or any(data_root.iterdir()))):
        raise ValueError("Browser demo fixture requires an empty data root.")
    if runtime.READONLY_MODE:
        raise ValueError("Seed the browser demo fixture before enabling MY_SCHOLAR_READONLY.")
    data_root.mkdir(parents=True, exist_ok=True)
    _write_json(data_root / "settings.json", {
        "metadata": {"auto_retrieve": False, "online_lookup": False, "contact_email": ""},
    })
    job_dir = data_root / "jobs" / JOB_ID
    job_dir.mkdir(parents=True)
    pdf = _minimal_pdf("Attention - Synthetic Browser Demo")
    (job_dir / "source.pdf").write_bytes(pdf)
    elements = [{"id": "block-title", "block_id": "block-title", "kind": "title", "type": "title", "page": 1, "text": TITLE}]
    for index, (source, _) in enumerate(PARAGRAPHS, start=1):
        block_id = f"block-1-{index}-paragraph"
        elements.append({"id": block_id, "block_id": block_id, "kind": "paragraph", "type": "paragraph", "page": 1, "text": source})
    body = "\n".join(_block_html(block, 1) for block in elements)
    body += (
        f'<figure class="pdf-figure" id="fig-1" data-block-id="{MEDIA_BLOCK_ID}" data-page="1">'
        f'<img src="{MEDIA_ASSET}" alt="Synthetic attention test image">'
        '<figcaption>Synthetic test image; no experimental results.</figcaption></figure>'
    )
    document_html = (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        f'<title>{TITLE}</title><style>{READER_DOCUMENT_CSS}</style></head><body>'
        '<div class="reader-shell"><div class="reader-layout"><main class="reader-content">'
        f'<section class="pdf-page" id="page-1" data-page="1">{body}</section>'
        '</main></div></div></body></html>'
    )
    (job_dir / "document.html").write_text(document_html, encoding="utf-8")
    _write_json(job_dir / "document.json", {
        "job_id": JOB_ID, "synthetic": True, "source": {"filename": FILENAME},
        "pages": [{"page": 1, "elements": elements}],
        "counts": {"pages": 1, "figures": 1, "tables": 0, "formulas": 0},
    })
    image = job_dir / MEDIA_ASSET
    image.parent.mkdir(parents=True)
    image.write_bytes(_png(320, 180, (220, 230, 240)))
    _write_json(job_dir / "manifest.json", {
        "job_id": JOB_ID, "created_at": STAMP,
        "source": {"filename": FILENAME, "bytes": len(pdf)},
        "engine": {"name": "Browser demo fixture", "mode": "synthetic"}, "pages": 1,
        "outputs": ["document.html", "document.json", MEDIA_ASSET],
        "notes": ["Synthetic test content; no downloaded paper or user library data."],
    })
    _write_json(job_dir / "job.json", {
        "job_id": JOB_ID, "source_filename": FILENAME, "source_bytes": len(pdf),
        "status": "completed", "created_at": STAMP, "updated_at": STAMP,
    })
    translations = []
    for block, (_, translated) in zip(elements[1:], PARAGRAPHS, strict=True):
        source = block["text"]
        source_hash = hashlib.sha256(source.encode("utf-8")).hexdigest()
        translations.append({
            "cache_key": _translation_key(source, block["block_id"], "中文", source_hash, "synthetic-browser-fixture"),
            "block_id": block["block_id"], "page": 1, "source_text": source, "source_hash": source_hash,
            "text": translated, "target_language": "中文", "profile_id": "synthetic-browser-fixture",
            "model": "Synthetic fixture translation", "created_at": STAMP, "synthetic": True,
        })
    _write_translation_records(job_dir, translations)
    quote = "synthetic example"
    start = PARAGRAPHS[0][0].index(quote)
    annotations = [{
        "id": "synthetic-original-annotation", "kind": "highlight", "source": "manual",
        "block_id": elements[1]["block_id"], "page": 1, "quote": quote,
        "start": start, "end": start + len(quote), "color": "#2563eb",
        "note": "Original synthetic fixture annotation.", "created_at": STAMP, "updated_at": STAMP,
    }]
    _write_json(job_dir / "annotations.json", annotations)
    _sync_content_file(job_dir, "annotations/annotations.json", annotations)
    (job_dir / "notes.md").write_text(NOTES, encoding="utf-8")
    _sync_content_file(job_dir, "notes/notes.md", NOTES)
    _write_media_layout(job_dir, {MEDIA_BLOCK_ID: {"width_percent": 70}})
    store = JobStore(data_root / "jobs")
    library = LibraryStore(data_root)
    library.sync_jobs(store.list())
    library.update_metadata(JOB_ID, {"fields": {
        "title": TITLE, "authors": ["Synthetic Browser Fixture"], "year": 2026,
        "venue": "Synthetic test fixture", "abstract": PARAGRAPHS[0][0],
        "keywords": ["attention", "synthetic", "browser demo"], "item_type": "document",
    }})
    return [JOB_ID]


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: seed_browser_demo.py <empty-data-root>")
    job_ids = seed(Path(sys.argv[1]).expanduser())
    print(json.dumps({"seeded": len(job_ids), "job_ids": job_ids}, ensure_ascii=False))


if __name__ == "__main__":
    main()
