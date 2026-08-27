"""Seed a data root with synthetic completed documents for the UI smoke tests.

The library-facing smoke tests (library, library-v3, library-v4,
reading-progress, graph) only need documents to exist with real metadata; they
never assert on body text. Before this fixture they silently depended on
whatever the developer happened to have imported locally, which is why they
could not run in CI.

Usage:
    python3 tests/fixtures/seed_library.py <data-root>
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from job_store import JobStore  # noqa: E402
from library_store import LibraryStore  # noqa: E402
from pipeline import DOCUMENT_CSS  # noqa: E402

# Each section carries at least two paragraphs on purpose: the reader needs two
# adjacent <p> blocks to expose a measurable page boundary.
PAPERS = [
    {
        "filename": "unified-multimodal-alignment.pdf",
        "title": "Unified Multimodal Alignment for Document Understanding",
        "authors": ["Lin Wei", "Amara Osei", "Tomas Nowak"],
        "year": 2024,
        "venue": "CVPR",
        "keywords": ["multimodal", "alignment", "document understanding"],
        "abstract": "We present a unified framework that aligns visual and textual modalities for document understanding, and show that a single projection module generalises across eight input types.",
        "sections": [
            ("Introduction", [
                "Document understanding systems have historically treated layout and language as separate problems.",
                "We argue that a shared projection space removes the need for per-modality heads.",
            ]),
            ("Method", [
                "Our model consists of lightweight modality tokenizers and a universal encoder.",
                "A shared projection module is trained end to end across every supported input type.",
            ]),
            ("Results", [
                "On four public benchmarks the unified model matches or exceeds specialised baselines.",
                "It does so while using roughly a third of the parameters of the strongest baseline.",
            ]),
        ],
    },
    {
        "filename": "layout-aware-table-recovery.pdf",
        "title": "Layout-Aware Table Recovery in Scientific PDFs",
        "authors": ["Amara Osei", "Rui Chen"],
        "year": 2023,
        "venue": "CVPR",
        "keywords": ["tables", "layout analysis", "document understanding"],
        "abstract": "Scientific tables lose their structure when a PDF is linearised. We recover cell topology from geometric evidence alone, without relying on ruling lines.",
        "sections": [
            ("Introduction", [
                "Tables in scientific PDFs carry a large share of the reported evidence.",
                "Linearisation destroys their row and column structure before any reader sees them.",
            ]),
            ("Approach", [
                "We treat table recovery as a geometric grouping problem over text spans.",
                "Column projection profiles replace the ruled borders that borderless layouts never provide.",
            ]),
            ("Evaluation", [
                "The method recovers 94 percent of cells on a held-out set of conference papers.",
                "Borderless layouts, the hardest category, account for most of the remaining errors.",
            ]),
        ],
    },
    {
        "filename": "reading-order-transformers.pdf",
        "title": "Reading Order Recovery with Sparse Transformers",
        "authors": ["Tomas Nowak", "Sofia Marino"],
        "year": 2024,
        "venue": "ACL",
        "keywords": ["reading order", "layout analysis", "transformers"],
        "abstract": "We recover human reading order from multi-column page layouts using a sparse attention model over detected blocks.",
        "sections": [
            ("Introduction", [
                "Multi-column layouts break naive top-to-bottom extraction.",
                "The result interleaves unrelated columns into a single unreadable stream.",
            ]),
            ("Model", [
                "A sparse transformer attends over detected blocks rather than raw tokens.",
                "It predicts a permutation that matches annotated human reading order.",
            ]),
            ("Discussion", [
                "Errors concentrate on pages that mix figures with side captions.",
                "We leave the caption-heavy case to future work.",
            ]),
        ],
    },
    {
        "filename": "formula-recognition-survey.pdf",
        "title": "A Survey of Formula Recognition in Academic Documents",
        "authors": ["Rui Chen"],
        "year": 2022,
        "venue": "ACM Computing Surveys",
        "keywords": ["formula recognition", "survey", "OCR"],
        "abstract": "This survey reviews a decade of mathematical formula recognition, covering detection, structure parsing and LaTeX generation.",
        "sections": [
            ("Scope", [
                "We cover detection, structural parsing and markup generation.",
                "Handwritten input is explicitly out of scope for this review.",
            ]),
            ("Taxonomy", [
                "Existing systems fall into grammar-driven, encoder-decoder and hybrid families.",
                "Each family carries a distinct and fairly predictable failure mode.",
            ]),
            ("Open Problems", [
                "Long displayed equations remain the least reliable case across every family.",
                "Inline notation is a close second, particularly when it borrows surrounding punctuation.",
            ]),
        ],
    },
    {
        "filename": "citation-graph-construction.pdf",
        "title": "Citation Graph Construction from Reference Strings",
        "authors": ["Sofia Marino", "Lin Wei"],
        "year": 2021,
        "venue": "JCDL",
        "keywords": ["citations", "graph", "metadata"],
        "abstract": "We build citation graphs directly from unnormalised reference strings, resolving entities without an external index.",
        "sections": [
            ("Introduction", [
                "Reference strings vary widely in format across venues and decades.",
                "Naive string matching is therefore unreliable for graph construction.",
            ]),
            ("Resolution", [
                "We combine author-year signals with venue abbreviations.",
                "Clustering then groups the references that denote the same underlying work.",
            ]),
            ("Results", [
                "Entity resolution reaches 0.91 F1 on a manually annotated sample.",
                "The sample covers two thousand references drawn from five venues.",
            ]),
        ],
    },
]


def _minimal_pdf(title: str) -> bytes:
    """Build a small but structurally valid single-page PDF.

    The metadata worker opens every source with PyMuPDF, so the fixture should
    look like a document the app would really be given. A malformed file used
    to take the server down with it -- see pymupdf_runtime.py -- and while that
    is fixed, a fixture that only works because of the fix is a poor fixture.
    """
    safe = "".join(ch for ch in title if 32 <= ord(ch) < 127).replace("(", "").replace(")", "")[:80]
    stream = f"BT /F1 14 Tf 72 720 Td ({safe}) Tj ET".encode("ascii")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R "
        b"/Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length " + str(len(stream)).encode("ascii") + b" >>\nstream\n" + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += str(number).encode("ascii") + b" 0 obj\n" + body + b"\nendobj\n"
    xref_at = len(out)
    out += b"xref\n0 " + str(len(objects) + 1).encode("ascii") + b"\n"
    out += b"0000000000 65535 f \n"
    for offset in offsets:
        out += ("%010d 00000 n \n" % offset).encode("ascii")
    out += b"trailer\n<< /Size " + str(len(objects) + 1).encode("ascii") + b" /Root 1 0 R >>\n"
    out += b"startxref\n" + str(xref_at).encode("ascii") + b"\n%%EOF\n"
    return bytes(out)


INLINE_MATH = (
    '<math class="math-inline" xmlns="http://www.w3.org/1998/Math/MathML">'
    "<mrow><mi>f</mi><mo>&#x2061;</mo><mo>(</mo><mi>x</mi><mo>)</mo>"
    "<mo>=</mo><mi>W</mi><mi>x</mi><mo>+</mo><mi>b</mi></mrow></math>"
)


def _blocks(paper: dict) -> list[dict]:
    """Flatten a paper into ordered blocks; the single source for html and json."""
    out = [{"kind": "title", "id": "block-title", "text": paper["title"]}]
    for section_index, (heading, paragraphs) in enumerate(paper["sections"], start=1):
        out.append({"kind": "heading", "id": f"block-{section_index}-0-heading", "text": heading})
        for para_index, text in enumerate(paragraphs, start=1):
            out.append(
                {
                    "kind": "paragraph",
                    "id": f"block-{section_index}-{para_index}-paragraph",
                    "text": text,
                    # translation_smoke needs a paragraph carrying inline MathML
                    # to check that formulas survive a translation round-trip.
                    "math": section_index == 2 and para_index == 1,
                }
            )
    return out


def _split_point(blocks: list[dict]) -> int:
    """Page break between two adjacent paragraphs.

    translation_smoke measures a cross-page boundary, which requires page 1 to
    end on a paragraph and page 2 to start on one.
    """
    return next(
        (
            i
            for i in range(2, len(blocks))
            if blocks[i - 1]["kind"] == "paragraph" and blocks[i]["kind"] == "paragraph"
        ),
        len(blocks) // 2,
    )


def _block_html(block: dict, page: int) -> str:
    attrs = f'id="{block["id"]}" data-block-id="{block["id"]}" data-page="{page}"'
    if block["kind"] == "title":
        return f'<h1 class="paper-title" {attrs}>{block["text"]}</h1>'
    if block["kind"] == "heading":
        return f"<h2 {attrs}>{block['text']}</h2>"
    body = block["text"]
    if block.get("math"):
        body = f"{body.rstrip('.')}, written as {INLINE_MATH}."
    return f"<p {attrs}>{body}</p>"


def _document_html(paper: dict) -> str:
    # data-block-id is what the reader anchors translations and annotations to;
    # interaction_regression skips any document without it.
    blocks = _blocks(paper)
    split = _split_point(blocks)
    pages = []
    for page_number, chunk in enumerate((blocks[:split], blocks[split:]), start=1):
        body = "\n".join(_block_html(block, page_number) for block in chunk)
        pages.append(
            f'<section class="pdf-page" id="page-{page_number}" data-page="{page_number}">'
            f'<div class="page-label">第 {page_number} 页</div>'
            f"{body}"
            "</section>"
        )
    return (
        "<!doctype html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\">\n"
        f"<title>{paper['title']} · My Scholar</title>\n"
        # Real conversions inline this stylesheet, and translation_smoke measures
        # paragraph rhythm in pixels, so the fixture must carry it too.
        f"<style>{DOCUMENT_CSS}</style>\n</head>\n<body>\n"
        '<header class="reader-topbar"><span class="reader-brand">My Scholar</span>'
        f'<span class="reader-title">{paper["title"]}</span></header>\n'
        '<div class="reader-shell"><div class="reader-layout"><main class="reader-content">'
        + "\n".join(pages)
        + "</main></div></div>\n</body>\n</html>\n"
    )


def _document_json(paper: dict, job_id: str) -> dict:
    blocks = _blocks(paper)
    split = _split_point(blocks)
    pages = []
    for page_number, chunk in enumerate((blocks[:split], blocks[split:]), start=1):
        pages.append(
            {
                "page": page_number,
                "elements": [
                    {"id": b["id"], "kind": b["kind"], "page": page_number, "text": b["text"]} for b in chunk
                ],
            }
        )
    return {
        "job_id": job_id,
        "source": {"filename": paper["filename"]},
        "pages": pages,
        "counts": {"pages": len(pages), "tables": 0, "formulas": 0},
    }


def seed(data_root: Path) -> list[str]:
    data_root.mkdir(parents=True, exist_ok=True)
    # Metadata retrieval reaches out to Crossref and arXiv; a CI run must not
    # depend on the network, and the fixture already carries final metadata.
    (data_root / "settings.json").write_text(
        json.dumps(
            {"metadata": {"auto_retrieve": False, "online_lookup": False, "contact_email": ""}},
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    store = JobStore(data_root / "jobs")
    library = LibraryStore(data_root)
    job_ids: list[str] = []

    for paper in PAPERS:
        record = store.create(paper["filename"], 2048)
        job_id = record["job_id"]
        job_dir = Path(record["job_dir"])
        (job_dir / "source.pdf").write_bytes(_minimal_pdf(paper["title"]))
        (job_dir / "document.html").write_text(_document_html(paper), encoding="utf-8")
        document = _document_json(paper, job_id)
        (job_dir / "document.json").write_text(
            json.dumps(document, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        (job_dir / "manifest.json").write_text(
            json.dumps(
                {
                    "job_id": job_id,
                    "source": {"filename": paper["filename"], "bytes": 2048},
                    "engine": {"name": "UI fixture", "mode": "synthetic"},
                    "pages": len(document["pages"]),
                    "outputs": ["document.html", "document.json"],
                    "notes": [],
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        store.update(job_id, status="completed")
        job_ids.append(job_id)

    library.sync_jobs(store.list())
    for paper, job_id in zip(PAPERS, job_ids):
        library.update_metadata(
            job_id,
            {
                "fields": {
                    "title": paper["title"],
                    "authors": paper["authors"],
                    "year": paper["year"],
                    "venue": paper["venue"],
                    "abstract": paper["abstract"],
                    "keywords": paper["keywords"],
                    "item_type": "conferencePaper",
                }
            },
        )
    return job_ids


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("usage: seed_library.py <data-root>")
    job_ids = seed(Path(sys.argv[1]).expanduser().resolve())
    print(json.dumps({"seeded": len(job_ids), "job_ids": job_ids}, ensure_ascii=False))


if __name__ == "__main__":
    main()
