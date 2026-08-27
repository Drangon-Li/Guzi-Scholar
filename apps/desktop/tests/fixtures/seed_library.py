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
from layout_pipeline import READER_DOCUMENT_CSS  # noqa: E402

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


# The reader only tokenizes a <math> element that carries a TeX annotation, so
# a fixture without one silently translates as plain text. Real conversions
# always emit the annotation; see the extractor in web/app.js.
INLINE_MATH = (
    '<math class="math-inline" xmlns="http://www.w3.org/1998/Math/MathML">'
    "<semantics>"
    "<mrow><mi>f</mi><mo>&#x2061;</mo><mo>(</mo><mi>x</mi><mo>)</mo>"
    "<mo>=</mo><mi>W</mi><mi>x</mi><mo>+</mo><mi>b</mi></mrow>"
    '<annotation encoding="application/x-tex">f(x) = Wx + b</annotation>'
    "</semantics></math>"
)



# --- the reader fixture -----------------------------------------------------
#
# web_smoke asserts an exact census of the open document -- 12 pages, 3 figures,
# 7 tables, 2 equations, 100 references -- and feature_smoke asserts on four
# verbatim sentences at fixed block ids. Both were written against one real
# conversion, so this paper reproduces that shape rather than that PDF: the
# guard is "the reader surfaces everything the document contains", which a
# generated document pins just as well as a checked-in one.
RICH_TITLE = "OneLLM: One Framework to Align All Modalities with Language"

RICH_SECTIONS = [
    ("Introduction", [
        "Multimodal large language models have advanced quickly, yet most systems still bolt a separate encoder onto the language backbone for every new signal they need to understand.",
        "Each additional encoder brings its own pretraining recipe, its own tokenizer and its own alignment stage, so the engineering cost of a new modality grows with every modality already supported.",
        "A framework that treats modalities uniformly would remove that cost, but it must first show that a single projection can carry signals as different as audio, depth and inertial measurement.",
        # feature_smoke quotes this sentence verbatim as a research-goal highlight.
        "We take a different route. In this paper, we present OneLLM, an MLLM that aligns eight modalities to language using a unified framework.",
        "We train the framework progressively, starting from image-text pairs and adding one modality at a time so that the shared projection never has to be relearned from scratch.",
        # web_smoke and feature_smoke both anchor selections at block-1-6-paragraph
        # and require this exact opening.
        "Large Language Models (LLMs) have become the default interface for reasoning over text, and extending that interface to arbitrary sensory input is the natural next step for the field.",
    ]),
    ("Method", [
        "The design follows a single rule: every modality is projected into the same language space before the backbone ever sees it, so the backbone itself needs no modality-specific parameters.",
        "We describe the modality tokenizers first, then the shared encoder, and finally the projection module that performs the alignment work.",
        # feature_smoke quotes this sentence verbatim as a method highlight.
        "At a high level, OneLLM consists of lightweight modality tokenizers, a universal encoder, a universal projection module (UPM), and an LLM.",
        "Each tokenizer is a single convolutional layer that turns a raw signal into a sequence of tokens with the width the encoder expects.",
        "The universal encoder is a frozen vision-language model whose weights are shared across every modality, which keeps the parameter count flat as modalities are added.",
        "The universal projection module is a mixture of projection experts, and a router selects the combination used for each incoming token sequence.",
        "Because the router is learned rather than hand-assigned, a new modality can reuse experts that already handle a similar signal instead of training its own from scratch.",
        # feature_smoke quotes this sentence verbatim as an innovation highlight.
        "To the best of our knowledge, OneLLM is the first MLLM that integrates eight distinct modalities within a single model.",
        # feature_smoke quotes the opening of this sentence as a conclusion highlight.
        "Across the full benchmark suite, OneLLM finetuned on this dataset achieves superior performance on multimodal tasks, and the gains hold across both the captioning and the question-answering benchmarks.",
    ]),
    ("Results", [
        'We report accuracy for every modality pair in <a class="cross-reference" href="#table-1">Table 1</a>, and summarise the ablations that follow in the remaining tables.',
        # Deliberately not fig-1: feature_smoke rewrites the referenced figure's
        # image to a 1x1 stub, and fig-1 is the one its lightbox checks open.
        'The architecture diagram in <a class="cross-reference" href="#fig-3">Figure 3</a> shows where the router sits relative to the frozen encoder.',
    ]),
    ("Conclusion", [
        "A single projection space is enough to align eight modalities, and the cost of adding the ninth is a tokenizer rather than a training pipeline.",
        "We release the progressive training recipe so that the alignment stage can be reproduced without the original compute budget.",
    ]),
]

RICH_ABSTRACT = (
    "We present OneLLM, a multimodal large language model that aligns eight modalities to "
    "language through one unified projection module, removing the per-modality encoders that "
    "previous systems required."
)


def _png(width: int, height: int, rgb: tuple[int, int, int]) -> bytes:
    """A solid-colour PNG, built here so the fixture needs no image library."""
    import struct
    import zlib

    raw = b"".join(b"\x00" + bytes(rgb) * width for _ in range(height))

    def chunk(tag: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + tag
            + payload
            + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
        )

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 6))
        + chunk(b"IEND", b"")
    )


# web_smoke requires the crop to be a real 300-DPI asset: naturalWidth >= 1200
# and an "@300." in the resolved URL, which is the pipeline's own naming.
RICH_ASSET_WIDTH = 1280
RICH_ASSET_HEIGHT = 720


def _rich_media(kind: str, number: int) -> tuple[str, str, bytes]:
    """Return (anchor, asset path, png bytes) for one figure or table."""
    anchor = f"{'fig' if kind == 'figure' else 'table'}-{number}"
    name = f"pdf-block-{anchor}@300.png"
    tint = (232, 226, 214) if kind == "figure" else (214, 226, 232)
    return anchor, f"assets/images/{name}", _png(RICH_ASSET_WIDTH, RICH_ASSET_HEIGHT, tint)


def _rich_figure_html(number: int, page: int, asset: str) -> str:
    anchor = f"fig-{number}"
    block_id = f"block-{page}-{900 + number}-image"
    return (
        f'<figure class="pdf-figure" id="{anchor}" data-block-id="{block_id}" data-page="{page}">'
        f'<img src="{asset}" alt="Figure {number}">'
        f'<figcaption data-translate-block-id="{block_id}">Figure {number}: '
        f"Overview of the unified projection module.</figcaption></figure>"
    )


def _rich_table_html(number: int, page: int, asset: str) -> str:
    # table-image-only, with no <table> inside: web_smoke asserts the reading
    # surface never reconstructs a semantic table (semanticTables === 0).
    anchor = f"table-{number}"
    block_id = f"block-{page}-{800 + number}-table"
    return (
        f'<figure class="pdf-table table-image-only" id="{anchor}" data-block-id="{block_id}" data-page="{page}">'
        f'<figcaption data-translate-block-id="{block_id}">Table {number}: '
        f"Accuracy across the aligned modalities.</figcaption>"
        f'<div class="table-source-primary table-image-only">'
        f'<img src="{asset}" alt="Table {number} source crop"></div></figure>'
    )


def _rich_equation_html(number: int, page: int) -> str:
    block_id = f"block-{page}-{700 + number}-equation"
    return (
        f'<div class="pdf-equation" data-block-id="{block_id}" data-page="{page}">'
        f'<div id="eq-{number}" class="equation-entry">{INLINE_MATH}</div></div>'
    )


def _rich_references_html() -> str:
    items = "".join(
        f'<li id="ref-{i}"><span class="ref-number">[{i}]</span> '
        f"Reference {i} for the unified alignment study.</li>"
        for i in range(1, 101)
    )
    return f'<ol class="references">{items}</ol>'



RICH_PAPER = {
    "filename": "onellm-unified-alignment.pdf",
    "title": RICH_TITLE,
    "authors": ["Jiaming Han", "Kaixiong Gong", "Yiyuan Zhang"],
    "year": 2024,
    "venue": "CVPR",
    "keywords": ["multimodal", "alignment", "projection"],
    "abstract": RICH_ABSTRACT,
    "rich": True,
}

PAPERS.append(RICH_PAPER)


def _rich_para(section_index: int, para_index: int, text: str, page: int) -> str:
    bid = f"block-{section_index}-{para_index}-paragraph"
    return f'<p id="{bid}" data-block-id="{bid}" data-page="{page}">{text}</p>'


def _rich_subheading(slug: str, text: str, page: int) -> str:
    bid = f"block-sub-{slug}-heading"
    return f'<h3 id="{bid}" data-block-id="{bid}" data-page="{page}">{text}</h3>'


def _rich_heading(section_index: int, text: str, page: int) -> str:
    bid = f"block-{section_index}-0-heading"
    return f'<h2 id="{bid}" data-block-id="{bid}" data-page="{page}">{text}</h2>'


# (section index, first paragraph, last paragraph, page) for the body text, then
# the media pages. Laid out explicitly because the census has to be exact.
# The whole introduction sits on page 1: feature_smoke checks that a Chat
# citation naming the wrong page ([p2/block-1-6-paragraph]) fails to resolve.
RICH_TEXT_LAYOUT = [
    (1, 1, 6, 1),
    (2, 1, 3, 2),
    (2, 4, 6, 3),
    (2, 7, 9, 4),
    (3, 1, 2, 11),
    (4, 1, 2, 11),
]


def _rich_pages() -> tuple[list[str], dict[str, bytes]]:
    """Return the twelve page bodies and every asset they reference."""
    assets: dict[str, bytes] = {}

    def media(kind: str, number: int) -> str:
        _, path, data = _rich_media(kind, number)
        assets[path] = data
        return path

    pages: dict[int, list[str]] = {n: [] for n in range(1, 13)}

    title_id = "block-title"
    pages[1].append(
        f'<h1 class="paper-title" id="{title_id}" data-block-id="{title_id}" data-page="1">{RICH_TITLE}</h1>'
        '<p class="paper-metadata">Jiaming Han, Kaixiong Gong, Yiyuan Zhang · CVPR 2024</p>'
        '<h2 class="paper-abstract-heading" id="block-abstract-heading" data-block-id="block-abstract-heading" data-page="1">Abstract</h2>'
        f'<p class="paper-abstract-body" id="block-abstract" data-block-id="block-abstract" data-page="1">{RICH_ABSTRACT}</p>'
    )

    for section_index, first, last, page in RICH_TEXT_LAYOUT:
        heading, paragraphs = RICH_SECTIONS[section_index - 1]
        if first == 1:
            pages[page].append(_rich_heading(section_index, heading, page))
        for para_index in range(first, last + 1):
            pages[page].append(
                _rich_para(section_index, para_index, paragraphs[para_index - 1], page)
            )

    pages[2].insert(1, _rich_subheading("tokenizers", "Modality Tokenizers", 2))
    pages[4].insert(0, _rich_subheading("projection", "Universal Projection Module", 4))
    pages[4].append(_rich_equation_html(1, 4))
    pages[5].append(_rich_equation_html(2, 5))

    pages[5].append(_rich_figure_html(1, 5, media("figure", 1)))
    pages[6].append(_rich_table_html(1, 6, media("table", 1)))
    pages[6].append(_rich_table_html(2, 6, media("table", 2)))
    pages[7].append(_rich_table_html(3, 7, media("table", 3)))
    pages[7].append(_rich_table_html(4, 7, media("table", 4)))
    pages[8].append(_rich_table_html(5, 8, media("table", 5)))
    pages[8].append(_rich_table_html(6, 8, media("table", 6)))
    pages[9].append(_rich_table_html(7, 9, media("table", 7)))
    pages[9].append(_rich_figure_html(2, 9, media("figure", 2)))
    pages[10].append(_rich_figure_html(3, 10, media("figure", 3)))

    pages[12].append('<h2 id="block-references-heading" data-block-id="block-references-heading" data-page="12">References</h2>')
    pages[12].append(_rich_references_html())

    return ["".join(pages[n]) for n in range(1, 13)], assets


def _rich_document_html() -> tuple[str, dict[str, bytes]]:
    bodies, assets = _rich_pages()
    pages = "".join(
        f'<section class="pdf-page" id="page-{n}" data-page="{n}">'
        f'<div class="page-label">第 {n} 页</div>{body}</section>'
        for n, body in enumerate(bodies, start=1)
    )
    document = (
        '<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n'
        f"<title>{RICH_TITLE} · My Scholar</title>\n"
        f"<style>{READER_DOCUMENT_CSS}</style>\n</head>\n<body>\n"
        '<header class="reader-topbar"><span class="reader-brand">My Scholar</span>'
        f'<span class="reader-title">{RICH_TITLE}</span></header>\n'
        '<div class="reader-shell"><div class="reader-layout"><main class="reader-content">'
        + pages
        + "</main></div></div>\n</body>\n</html>\n"
    )
    return document, assets


def _rich_document_json(job_id: str, filename: str) -> dict:
    pages = []
    for section_index, first, last, page in RICH_TEXT_LAYOUT:
        _, paragraphs = RICH_SECTIONS[section_index - 1]
        elements = [
            {
                "id": f"block-{section_index}-{i}-paragraph",
                "kind": "paragraph",
                "page": page,
                "text": paragraphs[i - 1],
            }
            for i in range(first, last + 1)
        ]
        existing = next((p for p in pages if p["page"] == page), None)
        if existing:
            existing["elements"].extend(elements)
        else:
            pages.append({"page": page, "elements": elements})
    for page in range(1, 13):
        if not any(p["page"] == page for p in pages):
            pages.append({"page": page, "elements": []})
    pages.sort(key=lambda item: item["page"])
    return {
        "job_id": job_id,
        "source": {"filename": filename},
        "pages": pages,
        "counts": {"pages": 12, "tables": 7, "formulas": 2},
    }


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
        f"<style>{READER_DOCUMENT_CSS}</style>\n</head>\n<body>\n"
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
        if paper.get("rich"):
            document_html, assets = _rich_document_html()
            for relative_path, payload in assets.items():
                asset = job_dir / relative_path
                asset.parent.mkdir(parents=True, exist_ok=True)
                asset.write_bytes(payload)
            document = _rich_document_json(job_id, paper["filename"])
        else:
            document_html = _document_html(paper)
            document = _document_json(paper, job_id)
        (job_dir / "document.html").write_text(document_html, encoding="utf-8")
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
    for paper, job_id in zip(PAPERS, job_ids, strict=True):
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
