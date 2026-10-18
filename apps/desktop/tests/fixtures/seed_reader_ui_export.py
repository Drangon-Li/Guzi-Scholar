"""Add a synthetic figure to the isolated selectable exporter fixture."""
import json
import re
import shutil
from pathlib import Path
import sys
from PIL import Image, ImageDraw
from seed_selectable_export import seed
from services.parser_service.exporter import export_document
from job_store import JobStore

root = Path(sys.argv[1])
seed(root)
descriptor = json.loads((root / "fixture.json").read_text())
job = root / "data" / "jobs" / descriptor["job_id"]
fusion_path = root / "fusion" / "document.json"
fusion = json.loads(fusion_path.read_text())
examples = [
    (r"The citation keeps $^{34}$ between words. This synthetic sentence preserves spaces around citation superscripts.", [(r"$^{34}$", [{"text": "34", "script_kind": "sup"}])]),
    (r"The coefficient is $(R^2)$. This synthetic sentence checks inline scientific notation.", [(r"$(R^2)$", [{"text": "(R"}, {"text": "2", "script_kind": "sup"}, {"text": ")"}])]),
    (r"The mixture contains $CO_2$ and $\delta^{18}O$. This synthetic sentence checks scientific scripts.", [(r"$CO_2$", [{"text": "CO"}, {"text": "2", "script_kind": "sub"}]), (r"$\delta^{18}O$", [{"text": "δ"}, {"text": "18", "script_kind": "sup"}, {"text": "O"}])]),
]
for index, (content, formulas) in enumerate(examples):
    spans = []
    for candidate, segments in formulas:
        start = content.index(candidate)
        spans.append({"start": start, "end": start + len(candidate), "candidate_content": candidate, "render_mode": "native-script", "status": "confirmed", "semantic_kind": "simple-script-formula", "selectable_segments": segments, "selectable_text": "".join(segment["text"] for segment in segments)})
    fusion["pages"][0]["blocks"].append({"label": "text", "content": content, "source_bbox_normalized": [.08, .6 + index * .1, .92, .65 + index * .1], "math_audit": {"status": "confirmed", "inline": spans}})
fusion_path.write_text(json.dumps(fusion))
output = root / "native-script-export"
export_document(root / "synthetic.pdf", root / "fusion", output, "Synthetic selectable reader", descriptor["job_id"])
for entry in output.iterdir():
    if entry.is_dir():
        shutil.copytree(entry, job / entry.name, dirs_exist_ok=True)
    else:
        shutil.copy2(entry, job / entry.name)
JobStore(root / "data" / "jobs").update(descriptor["job_id"], manifest=json.loads((job / "manifest.json").read_text()))
image = Image.new("RGB", (900, 380), "#d5e6ef")
draw = ImageDraw.Draw(image)
for x in range(20, 900, 60):
    draw.rectangle((x, 30, x + 35, 350), fill="#307799")
image.save(job / "assets" / "images" / "synthetic-figure.png")
p = job / "document.html"
html = p.read_text()
figure = '<figure class="pdf-figure" id="fig-ui"><img src="assets/images/synthetic-figure.png" alt="Synthetic figure behind reader popover"><figcaption>Figure UI: Synthetic background contrast bars.</figcaption></figure><p><a class="cross-reference" href="#fig-ui">Figure UI</a></p>'
html = re.sub(r'(<p[^>]*>Visible .*?</p>)', lambda match: match[0] + figure, html, count=1, flags=re.S)
p.write_text(html)
descriptor["fixture_source"] = "synthetic-reader-ui-v1"
(root / "fixture.json").write_text(json.dumps(descriptor))

print(json.dumps(descriptor))
