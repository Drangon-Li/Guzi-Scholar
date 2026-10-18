"""Generate a standalone synthetic multi-page contents reader fixture."""
import hashlib
import json
from pathlib import Path
import sys

from reportlab.pdfgen.canvas import Canvas

sys.path.insert(0, str(Path(__file__).resolve().parents[4]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from services.parser_service.exporter import export_document
from job_store import JobStore
from library_store import LibraryStore


def seed(root):
    root = Path(root)
    data = root / "data"
    data.mkdir()
    pdf = root / "synthetic-toc.pdf"
    titles = [(str(chapter) if part == 0 else f"{chapter}.{part}", f"Synthetic topic {chapter} branch {part}") for chapter in range(1, 9) for part in range(5)]
    pages = [
        {"blocks": [{"label": "text", "content": "# Synthetic contents reader", "source_bbox_normalized": [.08, .03, .92, .08]}, {"label": "text", "content": "## Contents", "source_bbox_normalized": [.08, .09, .92, .14]}, {"label": "text", "content": "\n".join(f"{number} {title} .... {3 + index // 8}" for index, (number, title) in enumerate(titles[:20])), "source_bbox_normalized": [.08, .15, .92, .95]}]},
        {"blocks": [{"label": "text", "content": "\n".join(f"{number} {title} .... {3 + (index + 20) // 8}" for index, (number, title) in enumerate(titles[20:])), "source_bbox_normalized": [.08, .05, .92, .9]}]},
    ]
    for offset in range(0, len(titles), 8):
        blocks = []
        for index, (number, title) in enumerate(titles[offset:offset + 8]):
            y = .03 + index * .115
            blocks.extend([
                {"label": "text", "content": f"{'##' if '.' not in number else '###'} {number} {title}", "source_bbox_normalized": [.08, y, .92, y + .04]},
                {"label": "text", "content": f"Ordinary selectable paragraph {offset + index + 1} explains the synthetic reader regression with enough prose for translation.", "source_bbox_normalized": [.08, y + .04, .92, y + .105]},
            ])
        pages.append({"blocks": blocks})
    canvas = Canvas(str(pdf), pagesize=(600, 900))
    for index, page in enumerate(pages):
        canvas.setFont("Helvetica", 9)
        canvas.drawString(40, 870, f"Synthetic contents fixture page {index + 1}")
        for block in page["blocks"]:
            for line_index, line in enumerate(block["content"].splitlines()):
                canvas.drawString(40, 850 - block["source_bbox_normalized"][1] * 780 - line_index * 20, line[:105])
        canvas.showPage()
    canvas.save()
    fusion = root / "fusion"
    fusion.mkdir()
    (fusion / "document.json").write_text(json.dumps({"pages": pages}))
    store = JobStore(data / "jobs")
    record = store.create("synthetic-toc.pdf", pdf.stat().st_size)
    output = root / "export"
    export_document(pdf, fusion, output, "Synthetic contents reader", record["job_id"])
    for entry in output.iterdir():
        entry.rename(Path(record["job_dir"]) / entry.name)
    manifest = json.loads((Path(record["job_dir"]) / "manifest.json").read_text())
    store.update(record["job_id"], status="completed", manifest=manifest, source_sha256=hashlib.sha256(pdf.read_bytes()).hexdigest())
    LibraryStore(data).sync_jobs(store.list())
    (data / "settings.json").write_text(json.dumps({"metadata": {"auto_retrieve": False, "online_lookup": False}}))
    descriptor = {"fixture_source": "synthetic-toc-v1", "job_id": record["job_id"], "data": str(data), "entry_count": len(titles)}
    (root / "fixture.json").write_text(json.dumps(descriptor))
    print(json.dumps(descriptor))


if __name__ == "__main__":
    seed(sys.argv[1])
