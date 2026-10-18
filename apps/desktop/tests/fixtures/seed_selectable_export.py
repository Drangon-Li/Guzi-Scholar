"""Seed an isolated selectable-reader fixture from a generated one-page PDF."""
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
    pdf = root / "synthetic.pdf"
    canvas = Canvas(str(pdf), pagesize=(500, 500))
    canvas.drawString(40, 450, "Synthetic selectable reader")
    canvas.drawString(40, 400, "Visible prose12 costs $200 and formula x after.")
    canvas.setFont("Helvetica", 7)
    canvas.drawString(110, 405, "12")
    canvas.drawString(300, 400, "x")
    canvas.save()
    content = r"Visible 🧪 prose$^{12}$ costs \$200 and formula $x$ after."
    spans = []
    for candidate, mode, values in [
        ("$^{12}$", "native-script", {"semantic_kind": "citation-marker", "script_kind": "sup", "selectable_text": "12"}),
        ("$x$", "source-crop", {"semantic_kind": "formula", "source_crop_required": True, "fallback_bbox": [.595, .185, .62, .21], "height_em": 1.25, "baseline_offset_em": .25}),
    ]:
        start = content.index(candidate)
        spans.append({"start": start, "end": start + len(candidate), "candidate_content": candidate, "render_mode": mode, **values})
    fusion = root / "fusion"
    fusion.mkdir()
    blocks = [
        {"label": "text", "content": "# Synthetic selectable reader", "source_bbox_normalized": [.08, .06, .92, .12]},
        {"label": "text", "content": "## Selectable evidence", "source_bbox_normalized": [.08, .13, .92, .17]},
        {"label": "text", "content": content, "source_bbox_normalized": [.08, .18, .92, .25], "math_audit": {"status": "unresolved", "inline": spans}},
        {"label": "text", "content": "An unresolved candidate $\\unsupported{x}$ stays visible and selectable.", "source_bbox_normalized": [.08, .3, .92, .4], "math_audit": {"status": "unresolved"}},
        {"label": "text", "content": "A second visible reference<sup>34</sup> stays selectable.", "source_bbox_normalized": [.08, .45, .92, .5]},
    ]
    (fusion / "document.json").write_text(json.dumps({"pages": [{"blocks": blocks}]}))
    store = JobStore(data / "jobs")
    record = store.create("synthetic-selectable.pdf", pdf.stat().st_size)
    output = root / "export"
    export_document(pdf, fusion, output, "Synthetic selectable reader", record["job_id"])
    for entry in output.iterdir():
        entry.rename(Path(record["job_dir"]) / entry.name)
    output = Path(record["job_dir"])
    manifest = json.loads((output / "manifest.json").read_text())
    store.update(record["job_id"], status="completed", manifest=manifest, source_sha256=hashlib.sha256(pdf.read_bytes()).hexdigest())
    LibraryStore(data).sync_jobs(store.list())
    (data / "settings.json").write_text(json.dumps({"metadata": {"auto_retrieve": False, "online_lookup": False}}))
    descriptor = {"fixture_source": "synthetic-selectable-v3", "job_id": record["job_id"], "data": str(data)}
    (root / "fixture.json").write_text(json.dumps(descriptor))
    print(json.dumps(descriptor))


if __name__ == "__main__":
    seed(sys.argv[1])
