from __future__ import annotations

import base64
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from report_media import collect_report_media, overview_figure, report_image_data_url


PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZT8AAAAASUVORK5CYII=")


class ReportMediaTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.render = Path(temporary.name) / "render"
        self.images = self.render / "assets" / "images"
        self.images.mkdir(parents=True)
        for name in ("figure", "figure-2", "table", "panel", "equation"):
            (self.images / f"{name}.png").write_bytes(PNG)

    def collect(self, *elements):
        return collect_report_media(self.render, [{"page": 3, "elements": list(elements)}], "12")

    def test_captions_link_to_canonical_figure_and_table_crops(self):
        media = self.collect(
            {"block_id": "fig1", "type": "image", "anchor": "fig-1", "visual_asset": "assets/images/figure.png",
             "figure_group": {"caption_block_id": "cap1", "component_block_ids": ["fig1", "panel"]}},
            {"block_id": "panel", "type": "image", "visual_asset": "assets/images/panel.png"},
            {"block_id": "cap1", "type": "paragraph", "text": "Figure 1. Examples from the dataset."},
            {"block_id": "fig2", "type": "image", "visual_asset": "assets/images/figure-2.png",
             "html": '<figure data-caption-id="caption-fig-2"><figcaption></figcaption></figure>'},
            {"block_id": "cap2", "type": "paragraph", "text": "图 2：总体架构和工作流程", "html": '<p id="caption-fig-2">原文</p>'},
            {"block_id": "table", "type": "table", "anchor_group": "table-1", "visual_asset": "assets/images/table.png",
             "source_asset": "assets/images/panel.png"},
            {"block_id": "table-cap", "type": "paragraph", "native_label": "figure_title", "text": "Table 1. Main results."},
            {"block_id": "logo", "type": "image", "native_label": "logo", "visual_asset": "assets/images/panel.png"},
            {"block_id": "refs", "type": "image", "reference_section": True, "visual_asset": "assets/images/panel.png"},
        )
        self.assertEqual(list(media), ["figure:fig1", "figure:fig2", "table:table"])
        self.assertEqual(media["figure:fig1"], {
            "id": "figure:fig1", "block_id": "fig1", "page": 3, "render_generation": "12",
            "kind": "figure", "caption": "Figure 1. Examples from the dataset.", "asset": "assets/images/figure.png",
        })
        self.assertEqual(media["table:table"]["caption"], "Table 1. Main results.")
        self.assertEqual(media["table:table"]["asset"], "assets/images/table.png")
        self.assertEqual(overview_figure(media), "figure:fig2")
        first = {"figure:fig1": media["figure:fig1"]}
        self.assertEqual(overview_figure(first), "figure:fig1")
        self.assertIsNone(overview_figure(first, numbered_fallback=False))

    def test_formulas_use_source_tex_or_original_crop(self):
        media = self.collect(
            {"block_id": "stack", "type": "equation_interline", "equations": [{"tex": "$$a+b$$"}, {"tex": r"\[c=2\]"}]},
            {"block_id": "verified", "type": "equation_interline", "render_mode": "mathml",
             "math_audit": {"status": "confirmed"}, "content": "$$\nx  =  2\n$$"},
            {"block_id": "unresolved", "type": "equation_interline", "render_mode": "source-crop",
             "math_audit": {"status": "unresolved", "source_asset": "assets/images/equation.png"},
             "equations": [{"tex": "unverified"}]},
            {"block_id": "unverified", "type": "equation_interline", "content": "$$incorrect$$"},
        )
        self.assertEqual(list(media), ["equation:stack:1", "equation:stack:2", "equation:verified:1", "equation:unresolved:1"])
        self.assertEqual([media[key]["tex"] for key in list(media)[:3]], ["a+b", "c=2", "x  =  2"])
        self.assertEqual(media["equation:unresolved:1"]["asset"], "assets/images/equation.png")
        self.assertNotIn("tex", media["equation:unresolved:1"])

    def test_only_existing_raster_files_in_this_render_are_usable(self):
        outside = self.render.parent / "elsewhere.png"
        outside.write_bytes(PNG)
        (self.images / "linked.png").symlink_to(outside)
        (self.images / "fake.png").write_bytes(b"<svg></svg>")
        (self.images / "vector.svg").write_bytes(b"<svg></svg>")
        paths = ["../../elsewhere.png", "assets/images/../../../elsewhere.png", "assets/images/linked.png", "assets/images/missing.png",
                 "assets/images/fake.png", "assets/images/vector.svg", "https://example.org/figure.png", "assets/images/figure.png"]
        media = self.collect(*(
            {"block_id": str(index), "type": "image", "visual_asset": path} for index, path in enumerate(paths)
        ))
        self.assertEqual(list(media), ["figure:7"])

    def test_standard_png_can_be_sent_without_optional_image_renderer(self):
        asset = {"asset": "assets/images/figure.png"}
        with patch("report_media.load_fitz", side_effect=ImportError):
            url = report_image_data_url(self.render, asset)
            self.assertEqual(base64.b64decode(url.partition(",")[2]), PNG)
            (self.images / "figure.png").write_bytes(PNG[:16] + (8192).to_bytes(4, "big") + PNG[20:])
            self.assertIsNone(report_image_data_url(self.render, asset))


if __name__ == "__main__":
    unittest.main()
