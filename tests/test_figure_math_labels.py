import copy
import json
from pathlib import Path
import tempfile
import unittest

from services.parser_service.exporter import composite_figures, export_document, reference_layout


class SourceFramedFigureMathLabelTests(unittest.TestCase):
    frame = [.1, .1, .9, .8]

    @staticmethod
    def block(label, content, box):
        return {"label": label, "content": content, "source_bbox_normalized": box}

    def pages(self):
        blocks = []
        for index in range(8):
            top = round(.1 + index * .085, 3)
            blocks.append(self.block("image", "", [.1, top, .9, round(top + .07, 3)]))
            if index < 7:
                blocks.append(self.block("text", "Target K_{0} human 31 nM" if index == 0 else "Target K_{D} human 28 nM", [.2, round(top + .074, 3), .65, round(top + .084, 3)]))
        blocks.append(self.block("text", "Concentrations 1 nM 10 nM 100 nM", [.3, .785, .7, .795]))
        blocks.append(self.block("text", "Figure 8 (legend on the following page).", [.25, .82, .75, .85]))
        return [{"blocks": blocks}, {"blocks": [self.block("text", "Figure 8. Affinity measurements across species.", [.1, .1, .9, .15]), self.block("text", "Results remain ordinary body text.", [.1, .2, .9, .25])]}]

    def layout(self, pages=None, frames=None):
        entries, assignments, groups = reference_layout(pages or self.pages())
        composites = composite_figures(entries, assignments, groups, frames)
        return entries, assignments, groups, composites

    def test_source_frame_recovers_interrupted_labels_and_keeps_next_page_caption(self):
        pages = self.pages()
        original = copy.deepcopy(pages)
        entries, assignments, groups, composites = self.layout(pages, lambda page: [self.frame] if page == 1 else [])
        self.assertEqual(pages, original)
        self.assertEqual(len(composites), 1)
        result = composites[0]
        self.assertEqual(result["components"], [(1, index) for index in range(16)])
        self.assertEqual(result["bbox"], self.frame)
        self.assertEqual(result["group"]["caption_location"], (2, 0))
        self.assertEqual(result["group"]["anchor"], "fig-8")
        self.assertEqual(len(result["group"]["members"]), 8)
        self.assertEqual(len(assignments), 8)
        self.assertNotIn((1, 16), result["components"])
        self.assertNotIn((2, 0), result["components"])
        self.assertEqual(entries[1, 1]["plain"], "Target K_{0} human 31 nM")

    def test_missing_frame_caption_inside_frame_and_partial_frame_are_rejected(self):
        self.assertEqual(self.layout()[3], [])
        for frame in [[.1, .1, .9, .85], [.1, .1, .9, .4], [0, 0, 1, .81]]:
            with self.subTest(frame=frame):
                self.assertEqual(self.layout(frames=lambda page: [frame] if page == 1 else [])[3], [])

    def test_source_frame_cannot_absorb_body_or_independent_figure_captions(self):
        for content, box in [
            ("We evaluated an ordinary body paragraph with several lines of prose.", [.15, .3, .85, .4]),
            ("A short ordinary sentence.", [.2, .174, .65, .184]),
            ("## 2 Results", [.2, .174, .65, .184]),
            ("Figure 9. Independent figure.", [.2, .174, .65, .184]),
            ("Table 2. Independent table.", [.2, .174, .65, .184]),
        ]:
            pages = self.pages()
            pages[0]["blocks"][1] = self.block("text", content, box)
            with self.subTest(content=content):
                self.assertFalse(any(item["group"]["number"] == "8" for item in self.layout(pages, lambda page: [self.frame] if page == 1 else [])[3]))

    def test_conflicting_scope_cannot_be_hidden_in_source_frame(self):
        entries, assignments, groups = reference_layout(self.pages())
        entries[1, 1]["scope"] = "appendix-A"
        self.assertEqual(composite_figures(entries, assignments, groups, lambda page: [self.frame] if page == 1 else []), [])

    def test_export_uses_source_pixels_and_suppresses_all_seven_math_labels(self):
        from PIL import Image, ImageChops, ImageDraw
        from reportlab.pdfgen import canvas
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original = Image.new("RGB", (1200, 1400), "white")
            draw = ImageDraw.Draw(original)
            draw.text((20, 20), "Source KD label remains D, independently of OCR K0", fill="black")
            original.save(root / "source-figure.png")
            pdf = canvas.Canvas(str(root / "source.pdf"), pagesize=(600, 800))
            pdf.drawImage(str(root / "source-figure.png"), 60, 160, width=480, height=560)
            pdf.drawString(150, 130, "Figure 8 (legend on the following page).")
            pdf.showPage()
            pdf.drawString(60, 700, "Figure 8. Affinity measurements across species.")
            pdf.drawString(60, 620, "Results remain ordinary body text.")
            pdf.save()
            (root / "fusion").mkdir()
            (root / "fusion/document.json").write_text(json.dumps({"schema": "test", "pages": self.pages()}))
            export_document(root / "source.pdf", root / "fusion", root / "output")
            result = json.loads((root / "output/document.json").read_text())
            records = result["pages"][0]["blocks"]
            host = records[0]
            self.assertEqual(host["render_mode"], "composite-figure")
            self.assertEqual(len(host["figure_group"]["component_block_ids"]), 16)
            self.assertEqual(sum(record["html"].count("<img") for record in records), 1)
            self.assertTrue(all(records[index]["render_mode"] == "figure-component" and records[index]["html"] == "" for index in range(1, 14, 2)))
            self.assertIn("K_{0}", records[1]["source_content"])
            for index in range(0, 16, 2):
                self.assertIn('id="fig-' + records[index]["block_id"] + '"', host["html"])
            self.assertIn('id="caption-fig-8"', result["pages"][1]["blocks"][0]["html"])
            self.assertIn("Results remain ordinary body text.", result["pages"][1]["blocks"][1]["html"])
            with Image.open(root / "output" / host["visual_asset"]) as asset:
                self.assertEqual(asset.size, original.size)
                self.assertIsNone(ImageChops.difference(asset.convert("RGB"), original).getbbox())


if __name__ == "__main__":
    unittest.main()
