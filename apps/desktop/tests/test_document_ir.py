from __future__ import annotations

import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import document_ir  # noqa: E402
from document_ir import _flatten_text, mineru_to_ir, odl_to_ir, render_pages  # noqa: E402


PAGE_WIDTH = 612.0
PAGE_HEIGHT = 792.0


def odl_box(left: float, top: float, right: float, bottom: float) -> list[float]:
    return [left, PAGE_HEIGHT - bottom, right, PAGE_HEIGHT - top]


def odl_item(identifier: int, kind: str, text: str, box: list[float], **extra) -> dict:
    return {
        "id": identifier,
        "type": kind,
        "page number": 1,
        "bounding box": box,
        "content": text,
        **extra,
    }


class DocumentIRTest(unittest.TestCase):
    def test_pdf_bold_span_becomes_structured_emphasis(self) -> None:
        pages = [[{
            "type": "paragraph",
            "bbox": [40, 40, 500, 100],
            "content": {"paragraph_content": [{
                "type": "text",
                "content": "All parameters are frozen; only the stitch layer is trainable.",
            }]},
        }]]
        pdf_pages = [{
            "width": PAGE_WIDTH,
            "height": PAGE_HEIGHT,
            "spans": [{
                "text": " frozen",
                "bbox": [150, 50, 195, 65],
                "size": 10.0,
                "font": "NimbusRomNo9L-Medi",
                "flags": 21,
                "bold": True,
            }],
        }]

        with patch("document_ir._extract_pdf_text_pages", return_value=pdf_pages):
            ir = mineru_to_ir(pages, backend="fixture", pdf_path=Path("fixture.pdf"))

        element = ir["pages"][0]["elements"][0]
        self.assertEqual(ir["ir_version"], 5)
        self.assertEqual([(item["style"], item["text"]) for item in element["emphasis"]], [("bold", "frozen")])
        rendered = render_pages(ir)[0][0]
        self.assertEqual(rendered["_ir"]["emphasis"][0]["text"], "frozen")
        self.assertEqual(
            rendered["content"]["paragraph_content"][0]["emphasis"],
            [{"start": 19, "end": 25, "style": "bold", "source": "pdf-font"}],
        )

    def test_pdf_text_color_uses_fixed_tone_and_can_overlap_bold(self) -> None:
        text = "Layer Feature Matching (LFM) is emphasized."
        pages = [[{
            "type": "paragraph",
            "bbox": [40, 40, 500, 100],
            "content": {"paragraph_content": [{"type": "text", "content": text}]},
        }]]
        pdf_pages = [{
            "width": PAGE_WIDTH,
            "height": PAGE_HEIGHT,
            "spans": [{
                "text": "Layer Feature Matching (LFM)",
                "bbox": [45, 50, 220, 65],
                "size": 10.0,
                "font": "NimbusRomNo9L-Medi",
                "flags": 16,
                "color": 0xE59F00,
                "bold": True,
            }],
        }]

        ir = mineru_to_ir(pages, backend="fixture", pdf_pages_override=pdf_pages)

        element = ir["pages"][0]["elements"][0]
        self.assertEqual(
            [(item["style"], item.get("tone"), item["text"]) for item in element["emphasis"]],
            [
                ("bold", None, "Layer Feature Matching (LFM)"),
                ("color", "orange", "Layer Feature Matching (LFM)"),
            ],
        )
        rendered_ranges = element["render"]["content"]["paragraph_content"][0]["emphasis"]
        self.assertEqual(
            rendered_ranges,
            [
                {"start": 0, "end": 28, "style": "bold", "source": "pdf-font"},
                {"start": 0, "end": 28, "style": "color", "source": "pdf-text-color", "tone": "orange"},
            ],
        )

    def test_pdf_text_color_rejects_links_citations_neutral_and_pale_spans(self) -> None:
        text = "Figure 1 [38] https://example.org A ure 6 ordinary"
        spans = [
            ("Figure 1", 0x357CBC),
            ("38", 0x357CBC),
            ("https://example.org", 0x357CBC),
            ("A", 0x357CBC),
            ("ure 6", 0x357CBC),
            ("ordinary", 0x666666),
            ("ordinary", 0xF8E8E8),
        ]
        pdf_pages = [{
            "width": PAGE_WIDTH,
            "height": PAGE_HEIGHT,
            "spans": [
                {
                    "text": value,
                    "bbox": [45 + index * 55, 50, 95 + index * 55, 65],
                    "size": 10.0,
                    "font": "Regular",
                    "flags": 0,
                    "color": color,
                    "bold": False,
                }
                for index, (value, color) in enumerate(spans)
            ],
        }]
        pages = [[{
            "type": "paragraph",
            "bbox": [40, 40, 500, 100],
            "content": {"paragraph_content": [{"type": "text", "content": text}]},
        }]]

        ir = mineru_to_ir(pages, backend="fixture", pdf_pages_override=pdf_pages)

        self.assertNotIn("emphasis", ir["pages"][0]["elements"][0])

    def test_emphasis_budgets_fail_open_without_changing_body_ir(self) -> None:
        pages = [[{
            "type": "paragraph",
            "bbox": [40, 40, 500, 100],
            "content": {"paragraph_content": [{"type": "text", "content": "Normal body remains readable."}]},
        }]]
        pdf_pages = [{
            "width": PAGE_WIDTH,
            "height": PAGE_HEIGHT,
            "spans": [{
                "text": "Normal",
                "bbox": [45, 50, 90, 65],
                "size": 10.0,
                "font": "Bold",
                "flags": 16,
                "bold": True,
            }],
        }]
        cases = [
            ("PDF_EMPHASIS_MAX_PAGES", 0, "page-budget"),
            ("PDF_EMPHASIS_MAX_SPANS", 0, "span-budget"),
            ("PDF_EMPHASIS_MAX_TEXT_CHARS", 11, "text-budget"),
            ("PDF_EMPHASIS_MAX_OPERATIONS", 1, "operation-budget"),
        ]
        for setting, limit, reason in cases:
            with self.subTest(setting=setting):
                with patch.object(document_ir, setting, limit):
                    budget = document_ir._new_emphasis_budget()
                    with (
                        patch("document_ir._extract_pdf_text_pages", return_value=pdf_pages),
                        patch("document_ir._new_emphasis_budget", return_value=budget),
                    ):
                        ir = mineru_to_ir(pages, backend="fixture", pdf_path=Path("fixture.pdf"))
                element = ir["pages"][0]["elements"][0]
                self.assertEqual(element["text"], "Normal body remains readable.")
                self.assertNotIn("emphasis", element)
                self.assertNotIn("emphasis", element["render"]["content"]["paragraph_content"][0])
                self.assertEqual(budget.reason, reason)

        budget = document_ir._EmphasisBudget(deadline=1.0)
        with (
            patch("document_ir._extract_pdf_text_pages", return_value=pdf_pages),
            patch("document_ir._new_emphasis_budget", return_value=budget),
            patch("document_ir.time.monotonic", return_value=2.0),
        ):
            ir = mineru_to_ir(pages, backend="fixture", pdf_path=Path("fixture.pdf"))
        element = ir["pages"][0]["elements"][0]
        self.assertEqual(element["text"], "Normal body remains readable.")
        self.assertNotIn("emphasis", element)
        self.assertNotIn("emphasis", element["render"]["content"]["paragraph_content"][0])
        self.assertEqual(budget.reason, "time-budget")

    def test_pdf_text_extraction_enforces_aggregate_limits_before_returning_partial_data(self) -> None:
        class FakePage:
            rect = types.SimpleNamespace(width=PAGE_WIDTH, height=PAGE_HEIGHT)

            def __init__(self, spans: list[dict]) -> None:
                self.spans = spans

            def get_text(self, _kind: str) -> dict:
                return {"blocks": [{"lines": [{"spans": self.spans}]}]}

        class FakeDocument(list):
            def __enter__(self):
                return self

            def __exit__(self, *_args) -> None:
                return None

        span = {
            "text": "bounded",
            "bbox": [45, 50, 90, 65],
            "size": 10.0,
            "font": "Bold",
            "flags": 16,
        }
        fake_fitz = types.SimpleNamespace(open=lambda _path: FakeDocument([
            FakePage([span, span]),
            FakePage([span]),
        ]))
        cases = [
            ("PDF_EMPHASIS_MAX_PAGES", 1),
            ("PDF_EMPHASIS_MAX_SPANS", 1),
            ("PDF_EMPHASIS_MAX_TEXT_CHARS", len(span["text"]) + len(span["font"])),
        ]
        for setting, limit in cases:
            with self.subTest(setting=setting):
                with (
                    patch.dict(sys.modules, {"fitz": fake_fitz}),
                    patch.object(document_ir, setting, limit),
                ):
                    budget = document_ir._new_emphasis_budget()
                    extracted = document_ir._extract_pdf_text_pages(Path("fixture.pdf"), budget=budget)
                self.assertEqual(extracted, [])
                self.assertTrue(budget.exceeded)

    def test_pdf_text_extraction_enforces_drawing_budget(self) -> None:
        class FakePage:
            rect = types.SimpleNamespace(width=PAGE_WIDTH, height=PAGE_HEIGHT)

            def get_text(self, _kind: str) -> dict:
                return {"blocks": []}

            def get_drawings(self) -> list[dict]:
                return [
                    {
                        "type": "s",
                        "rect": [10, 10 + index, 20, 10 + index],
                        "color": (0.5, 0.5, 0.5),
                        "items": [("l", (10, 10), (20, 10))],
                    }
                    for index in range(2)
                ]

        class FakeDocument(list):
            def __enter__(self):
                return self

            def __exit__(self, *_args) -> None:
                return None

        fake_fitz = types.SimpleNamespace(open=lambda _path: FakeDocument([FakePage()]))
        with (
            patch.dict(sys.modules, {"fitz": fake_fitz}),
            patch.object(document_ir, "PDF_EMPHASIS_MAX_DRAWINGS", 1),
        ):
            budget = document_ir._new_emphasis_budget()
            extracted = document_ir._extract_pdf_text_pages(Path("fixture.pdf"), budget=budget)

        self.assertEqual(extracted, [])
        self.assertEqual(budget.reason, "drawing-budget")

    def test_pdf_rawdict_nested_chars_are_preserved_and_reconstructed(self) -> None:
        class FakePage:
            rect = types.SimpleNamespace(width=PAGE_WIDTH, height=PAGE_HEIGHT)

            def get_text(self, kind: str) -> dict:
                if kind != "rawdict":
                    raise AssertionError(f"unexpected text mode: {kind}")
                return {"blocks": [{"lines": [{"spans": [{
                    "bbox": [40, 40, 80, 52],
                    "size": 12.0,
                    "font": "Helvetica-Bold",
                    "flags": 16,
                    "color": 0xFF0000,
                    "chars": [
                        {"c": "U", "bbox": [40, 40, 53, 52]},
                        {"c": "A", "bbox": [52.5, 40, 66, 52]},
                        {"c": "V", "bbox": [65.5, 40, 80, 52]},
                    ],
                }]}]}]}

        class FakeDocument(list):
            def __enter__(self):
                return self

            def __exit__(self, *_args) -> None:
                return None

        fake_fitz = types.SimpleNamespace(open=lambda _path: FakeDocument([FakePage()]))
        with patch.dict(sys.modules, {"fitz": fake_fitz}):
            extracted = document_ir._extract_pdf_text_pages(Path("fixture.pdf"))

        span = extracted[0]["spans"][0]
        self.assertEqual(span["text"], "UAV")
        self.assertTrue(span["bold"])
        self.assertEqual([item["text"] for item in span["chars"]], ["U", "A", "V"])

        indexes = document_ir._prepare_pdf_span_indexes(
            [{"page": 1, "width": PAGE_WIDTH, "height": PAGE_HEIGHT, "elements": []}],
            extracted,
            document_ir._new_emphasis_budget(),
        )
        self.assertIsNotNone(indexes)
        self.assertEqual(indexes[0]["entries"][0]["span"]["text"], "UAV")

    def test_pdf_short_fragment_does_not_match_inside_unrelated_word(self) -> None:
        text = "The usually available model uses UAV telemetry."
        pages = [[{
            "type": "paragraph",
            "bbox": [40, 40, 500, 80],
            "content": {"paragraph_content": [{"type": "text", "content": text}]},
        }]]
        pdf_pages = [{
            "width": PAGE_WIDTH,
            "height": PAGE_HEIGHT,
            "spans": [{
                "text": "UA",
                "bbox": [80, 50, 95, 62],
                "size": 10.0,
                "font": "Regular",
                "color": 0xFF0000,
                "bold": False,
                "chars": [
                    {"text": "U", "bbox": [80, 50, 87, 62]},
                    {"text": "A", "bbox": [87, 50, 95, 62]},
                ],
            }],
        }]

        ir = mineru_to_ir(pages, backend="fixture", pdf_pages_override=pdf_pages)

        self.assertNotIn("emphasis", ir["pages"][0]["elements"][0])

    def test_pdf_matching_ignores_missing_spaces_but_keeps_word_boundaries(self) -> None:
        text = "A red colored phrase and usually remains ordinary."
        pages = [[{
            "type": "paragraph",
            "bbox": [40, 40, 500, 80],
            "content": {"paragraph_content": [{"type": "text", "content": text}]},
        }]]
        pdf_pages = [{
            "width": PAGE_WIDTH,
            "height": PAGE_HEIGHT,
            "spans": [
                {
                    "text": "redcolored",
                    "bbox": [80, 50, 150, 62],
                    "size": 10.0,
                    "font": "Regular",
                    "color": 0xFF0000,
                    "bold": False,
                },
                {
                    "text": "ua",
                    "bbox": [180, 50, 195, 62],
                    "size": 10.0,
                    "font": "Regular",
                    "color": 0x0000FF,
                    "bold": False,
                },
            ],
        }]

        ir = mineru_to_ir(pages, backend="fixture", pdf_pages_override=pdf_pages)
        emphasis = ir["pages"][0]["elements"][0].get("emphasis", [])

        self.assertEqual([(item["tone"], item["text"]) for item in emphasis], [("red", "red colored")])

    def test_pdf_line_break_hyphenation_rejoins_adjacent_colored_runs(self) -> None:
        text = "The UAV Networks architecture is robust."
        pages = [[{
            "type": "paragraph",
            "bbox": [40, 40, 500, 100],
            "content": {"paragraph_content": [{"type": "text", "content": text}]},
        }]]
        pdf_pages = [{
            "width": PAGE_WIDTH,
            "height": PAGE_HEIGHT,
            "spans": [
                {
                    "text": "UAV Net-",
                    "bbox": [80, 50, 145, 62],
                    "size": 10.0,
                    "font": "Regular",
                    "color": 0x0000FF,
                    "bold": False,
                },
                {
                    "text": "works",
                    "bbox": [80, 64, 112, 76],
                    "size": 10.0,
                    "font": "Regular",
                    "color": 0x0000FF,
                    "bold": False,
                },
            ],
        }]

        ir = mineru_to_ir(pages, backend="fixture", pdf_pages_override=pdf_pages)
        emphasis = ir["pages"][0]["elements"][0].get("emphasis", [])

        self.assertEqual([(item["tone"], item["text"]) for item in emphasis], [("blue", "UAV Networks")])

    def test_pdf_bold_spans_apply_bold_emphasis(self) -> None:
        text = "The Bold Claim holds for every case."
        pages = [[{
            "type": "paragraph",
            "bbox": [40, 40, 500, 80],
            "content": {"paragraph_content": [{"type": "text", "content": text}]},
        }]]
        pdf_pages = [{
            "width": PAGE_WIDTH,
            "height": PAGE_HEIGHT,
            "spans": [{
                "text": "Bold Claim",
                "bbox": [80, 50, 160, 62],
                "size": 10.0,
                "font": "Helvetica-Bold",
                "flags": 16,
                "color": 0,
                "bold": True,
            }],
        }]

        ir = mineru_to_ir(pages, backend="fixture", pdf_pages_override=pdf_pages)
        emphasis = ir["pages"][0]["elements"][0].get("emphasis", [])

        self.assertEqual(
            [(item["style"], item["text"]) for item in emphasis],
            [("bold", "Bold Claim")],
        )
        rendered = render_pages(ir)[0][0]
        self.assertEqual(
            rendered["content"]["paragraph_content"][0]["emphasis"],
            [{"start": 4, "end": 14, "style": "bold", "source": "pdf-font"}],
        )

    def test_emphasis_matching_normalizes_body_once_with_linear_operation_count(self) -> None:
        def run(span_count: int) -> tuple[int, int]:
            body = "target " + " ordinary" * 80
            pages = [[{
                "type": "paragraph",
                "bbox": [0, 0, PAGE_WIDTH, PAGE_HEIGHT],
                "content": {"paragraph_content": [{"type": "text", "content": body}]},
            }]]
            pdf_pages = [{
                "width": PAGE_WIDTH,
                "height": PAGE_HEIGHT,
                "spans": [
                    {
                        "text": "target" if index == 0 else f"missing-{index}",
                        "bbox": [10, 10 + index, 80, 11 + index],
                        "size": 10.0,
                        "font": "Bold",
                        "flags": 16,
                        "bold": True,
                    }
                    for index in range(span_count)
                ],
            }]
            with patch("document_ir._extract_pdf_text_pages", return_value=pdf_pages):
                with patch(
                    "document_ir._normalized_text_with_offsets",
                    wraps=document_ir._normalized_text_with_offsets,
                ) as normalize:
                    budget = document_ir._new_emphasis_budget()
                    with patch("document_ir._new_emphasis_budget", return_value=budget):
                        ir = mineru_to_ir(pages, backend="fixture", pdf_path=Path("fixture.pdf"))
            full_body_normalizations = sum(call.args == (body,) for call in normalize.call_args_list)
            self.assertIn("emphasis", ir["pages"][0]["elements"][0])
            return budget.operations, full_body_normalizations

        small_operations, small_body_normalizations = run(80)
        large_operations, large_body_normalizations = run(160)
        self.assertEqual((small_body_normalizations, large_body_normalizations), (1, 1))
        self.assertGreater(small_operations, 0)
        self.assertLessEqual(large_operations, small_operations * 2 + 8)

    def test_emphasis_budget_exhaustion_discards_all_pending_metadata(self) -> None:
        pages = [[
            {
                "type": "paragraph",
                "bbox": [40, 40, 500, 100],
                "content": {"paragraph_content": [{"type": "text", "content": "first bold body"}]},
            },
            {
                "type": "paragraph",
                "bbox": [40, 120, 500, 180],
                "content": {"paragraph_content": [{"type": "text", "content": "second bold body"}]},
            },
        ]]
        pdf_pages = [{
            "width": PAGE_WIDTH,
            "height": PAGE_HEIGHT,
            "spans": [
                {"text": "first", "bbox": [45, 50, 80, 65], "font": "Bold", "bold": True},
                {"text": "second", "bbox": [45, 130, 90, 145], "font": "Bold", "bold": True},
            ],
        }]

        full_budget = document_ir._new_emphasis_budget()
        with (
            patch("document_ir._extract_pdf_text_pages", return_value=pdf_pages),
            patch("document_ir._new_emphasis_budget", return_value=full_budget),
        ):
            complete = mineru_to_ir(pages, backend="fixture", pdf_path=Path("fixture.pdf"))
        self.assertTrue(all("emphasis" in item for item in complete["pages"][0]["elements"]))

        limited_budget = document_ir._new_emphasis_budget()
        with (
            patch("document_ir._extract_pdf_text_pages", return_value=pdf_pages),
            patch("document_ir._new_emphasis_budget", return_value=limited_budget),
            patch.object(document_ir, "PDF_EMPHASIS_MAX_OPERATIONS", full_budget.operations - 1),
        ):
            degraded = mineru_to_ir(pages, backend="fixture", pdf_path=Path("fixture.pdf"))
        self.assertEqual(limited_budget.reason, "operation-budget")
        self.assertTrue(all("emphasis" not in item for item in degraded["pages"][0]["elements"]))
        self.assertEqual(
            [item["text"] for item in degraded["pages"][0]["elements"]],
            ["first bold body", "second bold body"],
        )

    def test_cross_page_body_is_removed_from_caption_only_with_font_evidence(self) -> None:
        cases = [
            (
                "table",
                "table_caption",
                "the stitched model would be expected to match the target’s self-",
                "Table 2. Comprehensive results across all datasets and tasks.",
                "stitch, leaving little room for cross-model complementarity.",
            ),
            (
                "image",
                "image_caption",
                "Question: Can we retain the benefits without incurring linear",
                "Figure 8. VFM Stitch Tree can be applied in multimodal systems.",
                "compute and memory costs?",
            ),
        ]
        for visual_type, caption_key, previous, caption, continuation in cases:
            with self.subTest(visual_type=visual_type):
                pages = [
                    [{
                        "type": "paragraph",
                        "bbox": [40, 650, 550, 740],
                        "content": {"paragraph_content": [{"type": "text", "content": previous}]},
                    }],
                    [{
                        "type": visual_type,
                        "bbox": [50, 50, 550, 200],
                        "content": {
                            caption_key: [
                                {"type": "text", "content": caption},
                                {"type": "text", "content": continuation},
                            ]
                        },
                    }],
                ]
                pdf_pages = [
                    {"width": PAGE_WIDTH, "height": PAGE_HEIGHT, "spans": []},
                    {
                        "width": PAGE_WIDTH,
                        "height": PAGE_HEIGHT,
                        "spans": [
                            {"text": " ".join(caption.split(" ")[:2]), "bbox": [50, 205, 180, 216], "size": 9.0},
                            {"text": continuation, "bbox": [50, 225, 350, 238], "size": 10.0},
                        ],
                    },
                ]
                with patch("document_ir._extract_pdf_text_pages", return_value=pdf_pages):
                    ir = mineru_to_ir(pages, backend="fixture", pdf_path=Path("fixture.pdf"))

                previous_element = ir["pages"][0]["elements"][0]
                visual = ir["pages"][1]["elements"][0]
                rendered_caption = visual["render"]["content"][caption_key]
                expected = f"{previous}{continuation}" if previous.endswith("-") else f"{previous} {continuation}"
                self.assertEqual(previous_element["text"], expected)
                self.assertEqual(rendered_caption, [{"type": "text", "content": caption}])
                self.assertIn("caption-continuation-recovered", visual["flags"])
                self.assertEqual(ir["recoveries"][0]["text"], continuation)

    def test_cross_page_caption_recovery_preserves_inline_equation_structure(self) -> None:
        equations = [
            r"F _ { L o R A } ( x ) = T _ { \phi } ^ { N } \circ f _ { \theta } ^ { n } ( x )",
            r"f _ { \theta , \mathrm { L o R A } } ^ { n }",
            r"S ( R _ { \theta } ^ { n } ( x ) ) = R _ { \phi } ^ { n } ( x )",
        ]
        pages = [
            [{
                "type": "paragraph",
                "bbox": [40, 650, 550, 740],
                "content": {"paragraph_content": [
                    {"type": "text", "content": "Concretely, this is "},
                    {"type": "equation_inline", "content": equations[0]},
                    {"type": "text", "content": " where only "},
                    {"type": "equation_inline", "content": equations[1]},
                    {"type": "text", "content": " is trainable. If "},
                    {"type": "equation_inline", "content": equations[2]},
                    {"type": "text", "content": ", the model would self-"},
                ]},
            }],
            [{
                "type": "table",
                "bbox": [50, 50, 550, 200],
                "content": {"table_caption": [
                    {"type": "text", "content": "Table 2. Comprehensive results."},
                    {"type": "text", "content": "stitch, leaving little room for complementarity."},
                ]},
            }],
        ]
        pdf_pages = [
            {"width": PAGE_WIDTH, "height": PAGE_HEIGHT, "spans": []},
            {"width": PAGE_WIDTH, "height": PAGE_HEIGHT, "spans": [
                {"text": "Table 2.", "bbox": [50, 205, 110, 216], "size": 9.0},
                {"text": "stitch, leaving little room for complementarity.", "bbox": [50, 225, 350, 238], "size": 10.0},
            ]},
        ]
        with patch("document_ir._extract_pdf_text_pages", return_value=pdf_pages):
            ir = mineru_to_ir(pages, backend="fixture", pdf_path=Path("fixture.pdf"))

        paragraph = ir["pages"][0]["elements"][0]
        pieces = paragraph["render"]["content"]["paragraph_content"]
        self.assertEqual(
            [piece["content"] for piece in pieces if piece.get("type") == "equation_inline"],
            equations,
        )
        self.assertTrue(paragraph["text"].endswith("self-stitch, leaving little room for complementarity."))
        self.assertIn("cross-page-caption-recovery", paragraph["flags"])

    def test_legal_multisentence_caption_is_kept_without_distinct_body_font(self) -> None:
        pages = [
            [{
                "type": "paragraph",
                "bbox": [40, 650, 550, 740],
                "content": {"paragraph_content": "The body continues on the next page"},
            }],
            [{
                "type": "image",
                "bbox": [50, 50, 550, 200],
                "content": {"image_caption": [
                    {"type": "text", "content": "Figure 4. Main result."},
                    {"type": "text", "content": "where higher values are better."},
                ]},
            }],
        ]
        pdf_pages = [
            {"width": PAGE_WIDTH, "height": PAGE_HEIGHT, "spans": []},
            {"width": PAGE_WIDTH, "height": PAGE_HEIGHT, "spans": [
                {"text": "Figure 4.", "bbox": [50, 205, 110, 216], "size": 9.0},
                {"text": "where higher values are better.", "bbox": [50, 220, 230, 231], "size": 9.0},
            ]},
        ]
        with patch("document_ir._extract_pdf_text_pages", return_value=pdf_pages):
            ir = mineru_to_ir(pages, backend="fixture", pdf_path=Path("fixture.pdf"))

        self.assertEqual(ir["recoveries"], [])
        self.assertEqual(len(ir["pages"][1]["elements"][0]["render"]["content"]["image_caption"]), 2)

    def test_wpes_page8_two_column_order_and_figure_region(self) -> None:
        raw = {"number of pages": 1, "kids": [
            odl_item(1, "image", "", odl_box(55, 50, 286, 240), source="chart.png"),
            odl_item(2, "paragraph", "0.20 0.15 0.10 0.05", odl_box(75, 80, 270, 205)),
            odl_item(3, "list", "Figure 4. Aggregate comparison.", odl_box(55, 250, 286, 278)),
            odl_item(4, "heading", "5.4 Left analysis", odl_box(55, 310, 286, 330)),
            odl_item(5, "paragraph", "Left-column evidence explains the result with enough prose to establish a real column and continues", odl_box(55, 340, 286, 430)),
            odl_item(6, "heading", "5.5 Additional finding", odl_box(55, 445, 286, 465)),
            odl_item(7, "paragraph", "The second left paragraph reaches the column boundary without punctuation", odl_box(55, 475, 286, 735)),
            odl_item(8, "paragraph", "and resumes at the top of the right column before the next section begins.", odl_box(326, 50, 557, 115)),
            odl_item(9, "heading", "5.6 Right analysis", odl_box(326, 135, 557, 155)),
            odl_item(10, "paragraph", "Right-column evidence follows only after the complete left column has been consumed by reading order.", odl_box(326, 165, 557, 275)),
            odl_item(11, "heading", "6 Limitations", odl_box(326, 300, 557, 320)),
            odl_item(12, "paragraph", "Limitations remain visible after the previous right-column section and are never interleaved row by row.", odl_box(326, 330, 557, 470)),
        ]}

        ir = odl_to_ir(raw, [(PAGE_WIDTH, PAGE_HEIGHT)])
        elements = ir["pages"][0]["elements"]
        texts = [item["text"] for item in elements]

        self.assertEqual(ir["quality"]["status"], "PASS")
        self.assertEqual(elements[0]["type"], "image")
        self.assertIn("Figure 4", elements[0]["text"])
        self.assertIn("chart-text-suppressed", elements[0]["flags"])
        self.assertNotIn("0.20 0.15 0.10 0.05", texts)
        self.assertLess(texts.index("5.4 Left analysis"), texts.index("5.6 Right analysis"))
        self.assertLess(texts.index("5.5 Additional finding"), texts.index("5.6 Right analysis"))
        merged = next(item for item in elements if item["text"].startswith("The second left paragraph"))
        self.assertIn("and resumes at the top", merged["text"])
        self.assertIn("cross-column", merged["flags"])

    def test_odl_pdf_evidence_preserves_page_size_and_applies_text_tone(self) -> None:
        text = "RED COLORED TEXT"
        raw = {
            "number of pages": 1,
            "kids": [{
                "id": 1,
                "type": "paragraph",
                "page number": 1,
                # ODL stores y coordinates from the bottom edge.
                "bounding box": [30, 120, 220, 140],
                "content": text,
            }],
        }
        evidence = [{
            "width": 400.0,
            "height": 200.0,
            "spans": [{
                "text": text,
                "bbox": [30.0, 60.0, 213.0, 80.0],
                "size": 18.0,
                "font": "Helvetica",
                "color": 0xFF0000,
                "bold": False,
            }],
        }]

        ir = odl_to_ir(raw, [(612.0, 792.0)], pdf_pages_override=evidence)

        self.assertEqual((ir["pages"][0]["width"], ir["pages"][0]["height"]), (400.0, 200.0))
        element = ir["pages"][0]["elements"][0]
        self.assertEqual(
            [(item["style"], item["tone"], item["text"]) for item in element["emphasis"]],
            [("color", "red", text)],
        )
        rendered = render_pages(ir)[0][0]
        self.assertEqual(
            rendered["content"]["paragraph_content"][0]["emphasis"],
            [{"start": 0, "end": len(text), "style": "color", "source": "pdf-text-color", "tone": "red"}],
        )

    def test_odl_pdf_evidence_ignores_malformed_span_geometry(self) -> None:
        raw = {
            "number of pages": 1,
            "kids": [{
                "id": 1,
                "type": "paragraph",
                "page number": 1,
                "bounding box": [30, 500, 300, 600],
                "content": "A paragraph remains readable when evidence is malformed.",
            }],
        }
        evidence = [{
            "width": 400.0,
            "height": 200.0,
            "spans": [{"text": "A paragraph", "bbox": ["invalid", 1, 2, 3], "color": 0xFF0000}],
        }]

        ir = odl_to_ir(raw, [(612.0, 792.0)], pdf_pages_override=evidence)

        self.assertEqual(len(ir["pages"][0]["elements"]), 1)
        self.assertNotIn("emphasis", ir["pages"][0]["elements"][0])

    def test_conference_footer_is_not_translatable_body(self) -> None:
        raw = {"number of pages": 1, "kids": [
            odl_item(1, "paragraph", "A sufficiently long body paragraph remains available for semantic reading and translation.", odl_box(55, 100, 557, 180)),
            odl_item(2, "paragraph", "WPES ’26, The Hague, The Netherlands 2026.", odl_box(55, 692, 220, 710)),
        ]}
        ir = odl_to_ir(raw, [(PAGE_WIDTH, PAGE_HEIGHT)])
        self.assertEqual([item["text"] for item in ir["pages"][0]["elements"]], [
            "A sufficiently long body paragraph remains available for semantic reading and translation."
        ])
        self.assertTrue(any(item["reason"] == "furniture" for item in ir["suppressed"]))

    def test_mineru_adapter_preserves_order_and_stable_ids(self) -> None:
        pages = [[
            {"type": "title", "bbox": [10, 10, 500, 40], "content": {"title_content": "Title"}},
            {"type": "paragraph", "bbox": [10, 50, 500, 110], "content": {"paragraph_content": "Body paragraph."}},
            {"type": "page_number", "bbox": [490, 970, 510, 990], "content": "1"},
        ]]
        first = mineru_to_ir(pages, backend="fixture")
        second = mineru_to_ir(pages, backend="fixture")
        self.assertEqual(
            [item["id"] for item in first["pages"][0]["elements"]],
            [item["id"] for item in second["pages"][0]["elements"]],
        )
        rendered = render_pages(first)[0]
        self.assertEqual(rendered[0]["_ir"]["block_id"], "block-1-0-title")
        self.assertEqual([item["type"] for item in rendered], ["title", "paragraph"])

    def test_ieee_inline_abstract_marks_front_matter_and_suppresses_publication_note(self) -> None:
        pages = [[
            {"type": "title", "bbox": [110, 60, 890, 135], "content": {"title_content": "LD-PA: Paper Title"}},
            {"type": "paragraph", "bbox": [180, 150, 815, 172], "content": {"paragraph_content": "Alice Example, Bob Example, Member, IEEE"}},
            {"type": "paragraph", "bbox": [74, 220, 492, 575], "content": {"paragraph_content": "Abstract—This abstract remains one inline paragraph with enough text for semantic reading."}},
            {"type": "paragraph", "bbox": [74, 580, 492, 610], "content": {"paragraph_content": "Index Terms—side-channel analysis, privacy, deep learning."}},
            {"type": "title", "bbox": [210, 615, 355, 635], "content": {"title_content": "I. INTRODUCTION"}},
            {"type": "paragraph", "bbox": [74, 640, 492, 705], "content": {"paragraph_content": "The introduction stays ordinary body text after the front matter."}},
            {"type": "page_footnote", "bbox": [74, 710, 492, 790], "content": {"page_footnote_content": "Received 23 March 2024; revised 25 August 2024; accepted 28 October 2024. Date of publication 4 November 2024. Corresponding author: Alice Example."}},
            {"type": "paragraph", "bbox": [505, 330, 922, 440], "content": {"paragraph_content": "The right column continues with a second ordinary paragraph for validation."}},
        ]]

        ir = mineru_to_ir(pages, backend="fixture")
        elements = ir["pages"][0]["elements"]
        author = next(item for item in elements if item["text"].startswith("Alice Example"))
        abstract = next(item for item in elements if item["text"].startswith("Abstract"))
        keywords = next(item for item in elements if item["text"].startswith("Index Terms"))

        self.assertEqual(author["role"], "metadata")
        self.assertEqual(abstract["section_role"], "abstract-body")
        self.assertEqual(keywords["section_role"], "keywords")
        self.assertNotIn("Received 23 March 2024", [item["text"] for item in elements])
        self.assertTrue(any(item["reason"] == "furniture" and item["text"].startswith("Received") for item in ir["suppressed"]))
        rendered = render_pages(ir)[0]
        abstract_render = next(item for item in rendered if str(item.get("content", {}).get("paragraph_content", "")).startswith("Abstract"))
        self.assertEqual(abstract_render["_ir"]["section_role"], "abstract-body")

    def test_standalone_paragraph_abstract_is_promoted_and_kept_with_same_column_body(self) -> None:
        abstract_text = (
            "The number of wearable activity trackers has increased rapidly. "
            "These devices continuously collect sensitive behavioral and physiological data."
        )
        pages = [[
            {"type": "title", "bbox": [53, 45, 557, 92], "content": {"title_content": "A Step Closer to your Heart"}},
            {"type": "paragraph", "bbox": [53, 105, 557, 137], "content": {"paragraph_content": "Alice Example, Bob Example"}},
            {"type": "paragraph", "bbox": [53, 148, 95, 163], "content": {"paragraph_content": "Abstract"}},
            {"type": "title", "bbox": [317, 148, 367, 163], "content": {"title_content": "Keywords"}},
            {"type": "paragraph", "bbox": [53, 164, 295, 320], "content": {"paragraph_content": abstract_text}},
            {"type": "paragraph", "bbox": [317, 164, 557, 210], "content": {"paragraph_content": "wearable devices, privacy, re-identification, time series, health data"}},
            {"type": "title", "bbox": [53, 336, 210, 354], "content": {"title_content": "1 Introduction"}},
            {"type": "paragraph", "bbox": [53, 360, 295, 455], "content": {"paragraph_content": "The introduction begins after the abstract in the left column and remains ordinary body text."}},
            {"type": "paragraph", "bbox": [317, 225, 557, 350], "content": {"paragraph_content": "The right column contains enough additional front matter text to establish a genuine two-column layout."}},
        ]]

        ir = mineru_to_ir(pages, backend="fixture")

        elements = ir["pages"][0]["elements"]
        heading_index = next(index for index, item in enumerate(elements) if item["text"] == "Abstract")
        heading = elements[heading_index]
        body = elements[heading_index + 1]
        self.assertEqual(heading["type"], "title")
        self.assertEqual(heading["section_role"], "abstract-heading")
        self.assertIn("standalone-abstract-promoted", heading["flags"])
        self.assertEqual(body["text"], abstract_text)
        self.assertEqual(body["section_role"], "abstract-body")
        self.assertEqual(body["column"], heading["column"])
        self.assertLess(heading_index + 1, next(index for index, item in enumerate(elements) if item["text"] == "Keywords"))
        rendered = render_pages(ir)[0]
        rendered_heading = next(item for item in rendered if item.get("_ir", {}).get("section_role") == "abstract-heading")
        self.assertEqual(rendered_heading["type"], "title")
        self.assertEqual(rendered_heading["content"]["title_content"], "Abstract")
        self.assertEqual(rendered[heading_index + 1]["_ir"]["section_role"], "abstract-body")

    def test_mineru_chart_becomes_captioned_visual_block_and_empty_paragraph_is_removed(self) -> None:
        pages = [[
            {
                "type": "chart",
                "bbox": [20, 20, 480, 280],
                "content": {
                    "image_source": {"path": "images/chart.jpg"},
                    "content": "",
                    "chart_caption": [{"type": "text", "content": "Figure 4. Trade-off chart."}],
                },
            },
            {"type": "paragraph", "bbox": [20, 300, 480, 340], "content": {"paragraph_content": []}},
        ]]
        ir = mineru_to_ir(pages, backend="fixture")
        self.assertEqual(len(ir["pages"][0]["elements"]), 1)
        element = ir["pages"][0]["elements"][0]
        self.assertEqual(element["type"], "image")
        self.assertEqual(element["text"], "Figure 4. Trade-off chart.")
        rendered = render_pages(ir)[0][0]
        self.assertEqual(rendered["type"], "image")
        self.assertEqual(rendered["content"]["image_source"]["path"], "images/chart.jpg")
        self.assertEqual(rendered["content"]["image_caption"][0]["content"], "Figure 4. Trade-off chart.")
        self.assertTrue(any(item["reason"] == "empty-text" for item in ir["suppressed"]))

    def test_mineru_multi_panel_figure_is_kept_as_one_composite_visual(self) -> None:
        pages = [[
            {
                "type": "chart", "bbox": [20, 20, 320, 260],
                "content": {"image_source": {"path": "images/figure-a.png"}, "chart_caption": "Figure 1 (a) Main plot."},
            },
            {
                "type": "chart", "bbox": [330, 20, 520, 260],
                "content": {"image_source": {"path": "images/figure-b.png"}, "chart_caption": "Figure 1 (b) Color scale."},
            },
            {
                "type": "chart", "bbox": [20, 270, 260, 430],
                "content": {"image_source": {"path": "images/figure-c.png"}, "chart_caption": "Figure 1 (c) Ablation."},
            },
        ]]

        ir = mineru_to_ir(pages, backend="fixture")
        elements = ir["pages"][0]["elements"]

        self.assertEqual(len(elements), 1)
        self.assertEqual(elements[0]["source"], "mineru-composite")
        self.assertIn("composite-visual", elements[0]["flags"])
        self.assertEqual(elements[0]["bbox"], [20.0, 20.0, 520.0, 430.0])
        self.assertEqual(len(elements[0]["visual_fragments"]), 3)
        self.assertEqual(
            len([item for item in ir["suppressed"] if item["reason"] == "composite-figure-fragment"]),
            3,
        )

    def test_mineru_multi_panel_figure_expands_transitively_from_caption_anchor(self) -> None:
        pages = [[
            {"type": "chart", "bbox": [176, 140, 328, 260], "content": {"chart_caption": "(a)"}},
            {"type": "chart", "bbox": [336, 138, 491, 260], "content": {"chart_caption": "(b)"}},
            {"type": "chart", "bbox": [500, 138, 651, 260], "content": {"chart_caption": "(c)"}},
            {
                "type": "chart", "bbox": [658, 133, 820, 260],
                "content": {"chart_caption": "(d) Figure 5: Analysis regarding the selection of Top K most relevant descriptions."},
            },
        ]]

        ir = mineru_to_ir(pages, backend="fixture")
        elements = ir["pages"][0]["elements"]

        self.assertEqual(len(elements), 1)
        self.assertEqual(elements[0]["source"], "mineru-composite")
        self.assertEqual(elements[0]["bbox"], [176.0, 133.0, 820.0, 260.0])
        self.assertEqual(len(elements[0]["visual_fragments"]), 4)
        self.assertEqual(
            len([item for item in ir["suppressed"] if item["reason"] == "composite-figure-fragment"]),
            4,
        )

    def test_latex_bold_font_names_are_recognised(self) -> None:
        from document_ir import BOLD_FONT_NAME_RE

        for name in ("CMBX10", "CMBX12", "CMB10", "Arial-BoldMT", "MicrosoftYaHei-Bold", "Helvetica-Black"):
            self.assertTrue(BOLD_FONT_NAME_RE.search(name), name)
        # The other Computer Modern cuts are regular weight and must not match:
        # roman, math italic, symbols, text italic, extensions, sans, typewriter.
        for name in ("CMR10", "CMR12", "CMMI10", "CMSY10", "CMTI10", "CMEX10", "CMSS8", "CMTT10", "ArialMT"):
            self.assertIsNone(BOLD_FONT_NAME_RE.search(name), name)

    def test_mineru_repeated_edge_banner_is_suppressed_as_furniture(self) -> None:
        # A preprint watermark that the extractor labels inconsistently: header
        # on one page, body text on the next. Repetition at the same edge is
        # what identifies it.
        banner = "bioRxiv preprint doi: https://doi.org/10.1101/2024.08.01.606258; this version posted August 31, 2026."
        pages = []
        for index in range(5):
            kind = "page_header" if index == 0 else "text"
            pages.append([
                {"type": kind, "bbox": [80, 5, 900, 28], "content": {"paragraph_content": banner}},
                {"type": "text", "bbox": [90, 100, 900, 800], "content": {"paragraph_content": "Body paragraph " * 30}},
            ])

        ir = mineru_to_ir(pages, backend="fixture")

        kept = [e for p in ir["pages"] for e in p["elements"] if str(e.get("text") or "").startswith("bioRxiv")]
        self.assertEqual(kept, [])
        self.assertEqual(len([s for s in ir["suppressed"] if str(s.get("text") or "").startswith("bioRxiv")]), 5)
        # the real body survives untouched
        bodies = [e for p in ir["pages"] for e in p["elements"] if str(e.get("text") or "").startswith("Body paragraph")]
        self.assertEqual(len(bodies), 5)

    def test_mineru_edge_text_on_few_pages_stays_body(self) -> None:
        # Below the repeat floor an edge-anchored line is ordinary content.
        pages = [
            [{"type": "text", "bbox": [80, 5, 900, 28], "content": {"paragraph_content": "A one-off note at the top."}}],
            [{"type": "text", "bbox": [80, 100, 900, 400], "content": {"paragraph_content": "Body " * 40}}],
        ]

        ir = mineru_to_ir(pages, backend="fixture")

        kept = [e for p in ir["pages"] for e in p["elements"] if "one-off" in str(e.get("text") or "")]
        self.assertEqual(len(kept), 1)

    def test_mineru_line_number_gutter_is_stripped_from_body(self) -> None:
        # LaTeX lineno puts a tall narrow column of numbers beside the text;
        # blocks that start inside it pick the number up as leading text.
        pages = [[
            {"type": "page_aside_text", "bbox": [89, 54, 110, 916], "content": {"paragraph_content": ""}},
            {"type": "title", "bbox": [92, 30, 368, 47], "content": {"title_content": "74 1 The Pinal network", "level": 2}},
            {"type": "text", "bbox": [92, 68, 900, 512], "content": {"paragraph_content": "75 The architecture of Pinal is motivated by the idea."}},
            {"type": "text", "bbox": [115, 519, 900, 845], "content": {"paragraph_content": "The first stage is handled by T2struct."}},
        ]]

        ir = mineru_to_ir(pages, backend="fixture")
        texts = [str(e.get("text") or "") for e in ir["pages"][0]["elements"]]

        self.assertIn("1 The Pinal network", texts)
        self.assertIn("The architecture of Pinal is motivated by the idea.", texts)
        # a block clear of the gutter keeps its text verbatim
        self.assertIn("The first stage is handled by T2struct.", texts)
        # The HTML is assembled from the render payload, not from element text,
        # so the number has to be gone from both.
        rendered = [
            _flatten_text((item.get("render") or {}).get("content"))
            for item in ir["pages"][0]["elements"]
        ]
        self.assertIn("1 The Pinal network", rendered)
        self.assertIn("The architecture of Pinal is motivated by the idea.", rendered)
        self.assertFalse([value for value in rendered if value.startswith(("74 ", "75 "))])

    def test_mineru_without_a_gutter_keeps_leading_numbers(self) -> None:
        pages = [[
            {"type": "text", "bbox": [90, 68, 900, 200], "content": {"paragraph_content": "20 candidates were selected for synthesis."}},
        ]]

        ir = mineru_to_ir(pages, backend="fixture")

        self.assertEqual(ir["pages"][0]["elements"][0]["text"], "20 candidates were selected for synthesis.")

    def test_mineru_plate_merges_when_the_caption_lives_on_another_page(self) -> None:
        # "Fig. 5: (previous page) …" leaves no figure number on any panel, so
        # nothing seeds the numbered grouping and the page used to reach the
        # reader as a scatter of panel crops.
        pages = [[
            {"type": "chart", "bbox": [20, 20, 300, 260], "content": {"chart_caption": "a"}},
            {"type": "chart", "bbox": [310, 20, 600, 260], "content": {"chart_caption": "b c"}},
            {"type": "chart", "bbox": [20, 270, 300, 520], "content": {"chart_caption": ""}},
            {"type": "chart", "bbox": [310, 270, 600, 520], "content": {"chart_caption": "d"}},
        ]]

        ir = mineru_to_ir(pages, backend="fixture")
        elements = ir["pages"][0]["elements"]

        self.assertEqual(len(elements), 1)
        self.assertEqual(elements[0]["source"], "mineru-composite")
        self.assertEqual(elements[0]["bbox"], [20.0, 20.0, 600.0, 520.0])
        self.assertEqual(len(elements[0]["visual_fragments"]), 4)
        # No panel letter is promoted into a caption for the merged plate.
        self.assertEqual(elements[0]["text"], "")
        self.assertEqual(
            len([item for item in ir["suppressed"] if item["reason"] == "composite-figure-fragment"]),
            4,
        )

    def test_mineru_two_uncaptioned_images_stay_separate(self) -> None:
        # Below the fragment floor this is an ordinary pair of figures.
        pages = [[
            {"type": "chart", "bbox": [20, 20, 300, 500], "content": {"chart_caption": ""}},
            {"type": "chart", "bbox": [310, 20, 600, 500], "content": {"chart_caption": ""}},
        ]]

        ir = mineru_to_ir(pages, backend="fixture")
        elements = ir["pages"][0]["elements"]

        self.assertEqual(len(elements), 2)
        self.assertTrue(all(item["source"] == "mineru" for item in elements))

    def test_mineru_small_uncaptioned_thumbnails_stay_separate(self) -> None:
        # Three small crops in a corner are not a full-page plate.
        pages = [[
            {"type": "chart", "bbox": [10, 10, 60, 60], "content": {"chart_caption": ""}},
            {"type": "chart", "bbox": [70, 10, 120, 60], "content": {"chart_caption": ""}},
            {"type": "chart", "bbox": [130, 10, 180, 60], "content": {"chart_caption": ""}},
            {"type": "paragraph", "bbox": [10, 400, 900, 950], "content": {"paragraph_content": "Body text " * 60}},
        ]]

        ir = mineru_to_ir(pages, backend="fixture")
        images = [item for item in ir["pages"][0]["elements"] if item["type"] == "image"]

        self.assertEqual(len(images), 3)
        self.assertTrue(all(item["source"] == "mineru" for item in images))

    def test_mineru_different_figure_numbers_are_not_coalesced(self) -> None:
        pages = [[
            {
                "type": "chart", "bbox": [20, 20, 260, 180],
                "content": {"chart_caption": "Figure 1. First result."},
            },
            {
                "type": "chart", "bbox": [270, 20, 520, 180],
                "content": {"chart_caption": "Figure 2. Second result."},
            },
        ]]

        ir = mineru_to_ir(pages, backend="fixture")
        elements = ir["pages"][0]["elements"]

        self.assertEqual(len(elements), 2)
        self.assertTrue(all(item["source"] == "mineru" for item in elements))
        self.assertFalse(any(item["reason"] == "composite-figure-fragment" for item in ir["suppressed"]))

    def test_mineru_figure_anchor_absorbs_uncaptioned_panel_fragments(self) -> None:
        pages = [[
            {
                "type": "chart", "bbox": [20, 20, 360, 300],
                "content": {"chart_caption": "Figure 3. Composite experiment."},
            },
            {"type": "chart", "bbox": [370, 20, 520, 300], "content": {"chart_caption": ""}},
            {"type": "chart", "bbox": [20, 310, 250, 460], "content": {"chart_caption": "(a)"}},
        ]]

        ir = mineru_to_ir(pages, backend="fixture")
        elements = ir["pages"][0]["elements"]

        self.assertEqual(len(elements), 1)
        self.assertEqual(elements[0]["source"], "mineru-composite")
        self.assertEqual(len(elements[0]["visual_fragments"]), 3)

    def test_chart_caption_drops_only_clear_full_segment_prefix(self) -> None:
        pages = [[{
            "type": "chart",
            "bbox": [519, 90, 897, 251],
            "content": {
                "image_source": {"path": "images/chart.jpg"},
                "chart_caption": [
                    {
                        "type": "text",
                        "content": "Final Feature Matching — Layer Feature Layer Feature Matching — Layer Feature",
                    },
                    {"type": "text", "content": "Figure 2. Feature distance measured with "},
                    {"type": "equation_inline", "content": r"\ell _ { 2 }"},
                    {"type": "text", "content": " distance."},
                ],
            },
        }]]

        ir = mineru_to_ir(pages, backend="fixture")
        element = ir["pages"][0]["elements"][0]
        caption = element["render"]["content"]["image_caption"]
        self.assertEqual(caption[0]["content"], "Figure 2. Feature distance measured with ")
        self.assertEqual(caption[1]["type"], "equation_inline")
        self.assertNotIn("Final Feature Matching —", element["text"])
        self.assertIn("chart-caption-prefix-trimmed", element["flags"])

        legal_prefix = [[{
            "type": "chart",
            "bbox": [20, 20, 480, 280],
            "content": {"chart_caption": [
                {"type": "text", "content": "Panel (a)."},
                {"type": "text", "content": "Figure 2. Per-panel comparison."},
            ]},
        }]]
        legal_ir = mineru_to_ir(legal_prefix, backend="fixture")
        legal = legal_ir["pages"][0]["elements"][0]
        self.assertEqual(legal["render"]["content"]["image_caption"][0]["content"], "Panel (a).")
        self.assertNotIn("chart-caption-prefix-trimmed", legal["flags"])

    def test_figure_two_vector_legend_markers_and_caption_tones_are_recovered_from_pdf(self) -> None:
        pages = [[{
            "type": "chart",
            "bbox": [519, 90, 897, 251],
            "content": {"chart_caption": [
                {"type": "text", "content": "Figure 2. Feature distance of Layer Feature Matching (LFM) and Final Feature Matching (FFM) at different positions. indicates the layer feature distance and indicates the final feature distance."},
            ]},
        }]]
        pdf_pages = [{
            "width": PAGE_WIDTH,
            "height": PAGE_HEIGHT,
            "spans": [
                {"text": "Figure 2. Feature distance of", "bbox": [317.2, 216.6, 421.0, 227.4], "size": 9.0},
                {"text": "Layer Feature Matching (LFM)", "bbox": [421.8, 216.6, 538.1, 227.4], "size": 9.0, "color": 0xE59F00},
                {"text": "and", "bbox": [300.0, 227.6, 315.0, 238.4], "size": 9.0},
                {"text": "Final Feature Matching (FFM)", "bbox": [317.25, 227.6, 426.45, 238.4], "size": 9.0, "color": 0x57B4E9},
                {"text": "indicates", "bbox": [521.6, 249.5, 553.5, 260.3], "size": 9.0},
                {"text": "and", "bbox": [410.0, 260.5, 429.5, 271.3], "size": 9.0},
                {"text": "indicates the", "bbox": [443.9, 260.5, 489.9, 271.3], "size": 9.0},
            ],
            "drawings": [
                {"type": "s", "bbox": [512.36, 255.37, 521.33, 255.37], "color": [0.627, 0.627, 0.627], "fill": None, "commands": ["l"]},
                {"type": "fs", "bbox": [514.42, 252.95, 519.26, 257.79], "color": [0.627, 0.627, 0.627], "fill": [0.627, 0.627, 0.627], "commands": ["c", "c", "c", "c"]},
                {"type": "s", "bbox": [429.97, 266.33, 443.58, 266.33], "color": [0.627, 0.627, 0.627], "fill": None, "commands": ["l"]},
                {"type": "f", "bbox": [432.81, 263.50, 438.48, 269.17], "color": None, "fill": [0.627, 0.627, 0.627], "commands": ["l", "l", "l", "l"]},
            ],
        }]
        with patch("document_ir._extract_pdf_text_pages", return_value=pdf_pages):
            ir = mineru_to_ir(pages, backend="fixture", pdf_path=Path("fixture.pdf"))

        element = ir["pages"][0]["elements"][0]
        caption = element["render"]["content"]["image_caption"]
        markers = [piece for piece in caption if piece.get("type") == "inline_marker"]
        self.assertEqual([marker["shape"] for marker in markers], ["circle", "square"])
        self.assertTrue(all(marker["style"] == "line-marker" for marker in markers))
        self.assertEqual([marker["tone"] for marker in markers], ["gray", "gray"])
        self.assertEqual(markers[0]["source_rgb"], [0.627, 0.627, 0.627])
        self.assertIn("caption-inline-marker-recovered", element["flags"])
        self.assertEqual(
            [(item["style"], item.get("tone"), item["text"]) for item in element["emphasis"]],
            [
                ("color", "orange", "Layer Feature Matching (LFM)"),
                ("color", "blue", "Final Feature Matching (FFM)"),
            ],
        )
        text_pieces = [piece for piece in caption if piece.get("type") == "text"]
        tones = [
            emphasis["tone"]
            for piece in text_pieces
            for emphasis in piece.get("emphasis", [])
            if emphasis.get("style") == "color"
        ]
        self.assertEqual(tones, ["orange", "blue"])

    def test_table_caption_tones_above_visual_are_recovered_conservatively(self) -> None:
        pages = [[{
            "type": "table",
            "bbox": [58, 287, 293, 382],
            "content": {
                "table_caption": [{
                    "type": "text",
                    "content": "Table 6. Orange indicates one baseline, while Blue indicates another.",
                }],
                "html": "<table><tr><td>value</td></tr></table>",
            },
        }]]
        pdf_pages = [{
            "width": PAGE_WIDTH,
            "height": PAGE_HEIGHT,
            "spans": [
                {"text": "Orange", "bbox": [58.5, 243.95, 84.9, 254.8], "size": 9.0, "color": 0xFFA500},
                {"text": "Blue", "bbox": [78.4, 254.9, 98.7, 265.7], "size": 9.0, "color": 0x0000FF},
            ],
        }]

        ir = mineru_to_ir(pages, backend="fixture", pdf_pages_override=pdf_pages)

        element = ir["pages"][0]["elements"][0]
        self.assertEqual(
            [(item["tone"], item["text"]) for item in element["emphasis"]],
            [("orange", "Orange"), ("blue", "Blue")],
        )

    def test_paragraph_vector_legend_markers_recover_allowlisted_tones_and_audit_rgb(self) -> None:
        pages = [[{
            "type": "paragraph",
            "bbox": [100, 300, 500, 380],
            "content": {"paragraph_content": [{
                "type": "text",
                "content": "The legend uses two styles. Blue legend. indicates the baseline and represents the updated model.",
            }]},
        }]]
        pdf_pages = [{
            "width": PAGE_WIDTH,
            "height": PAGE_HEIGHT,
            "spans": [
                {"text": "Blue", "bbox": [180, 320, 208, 332], "size": 10.0, "color": 0x57B4E9},
                {"text": "indicates the baseline", "bbox": [220, 320, 320, 332], "size": 10.0},
                {"text": "represents the updated model", "bbox": [220, 340, 355, 352], "size": 10.0},
            ],
            "drawings": [
                {"type": "s", "bbox": [209, 326, 219, 326], "color": [0.10, 0.35, 0.85], "fill": None, "commands": ["l"]},
                {"type": "fs", "bbox": [211, 323, 217, 329], "color": [0.10, 0.35, 0.85], "fill": [0.10, 0.35, 0.85], "commands": ["c", "c", "c", "c"]},
                {"type": "s", "bbox": [209, 346, 219, 346], "color": [0.90, 0.45, 0.05], "fill": None, "commands": ["l"]},
                {"type": "f", "bbox": [211, 343, 217, 349], "color": None, "fill": [0.90, 0.45, 0.05], "commands": ["l", "l", "l", "l"]},
            ],
        }]

        ir = mineru_to_ir(
            pages,
            backend="fixture",
            pdf_path=Path("fixture.pdf"),
            pdf_pages_override=pdf_pages,
        )

        element = ir["pages"][0]["elements"][0]
        pieces = element["render"]["content"]["paragraph_content"]
        markers = [piece for piece in pieces if piece.get("type") == "inline_marker"]
        self.assertEqual([(item["shape"], item["tone"]) for item in markers], [("circle", "blue"), ("square", "orange")])
        self.assertEqual(markers[0]["source_rgb"], [0.1, 0.35, 0.85])
        self.assertEqual(markers[1]["source_rgb"], [0.9, 0.45, 0.05])
        self.assertTrue(all(item["source"] == "pdf-drawing" for item in markers))
        self.assertIn("paragraph-inline-marker-recovered", element["flags"])
        self.assertEqual([item["tone"] for item in element["inline_marker_recoveries"]], ["blue", "orange"])
        self.assertEqual(
            [(item["style"], item.get("tone"), item["text"]) for item in element["emphasis"]],
            [("color", "blue", "Blue")],
        )

    def test_parenthesized_body_marker_slots_recover_complete_same_baseline_groups(self) -> None:
        pages = [[{
            "type": "paragraph",
            "bbox": [511, 385, 908, 627],
            "content": {"paragraph_content": [{
                "type": "text",
                "content": (
                    "Compared with LFM, FFM reduces the final feature distances ( ) at shallow positions. "
                    "It still retains similarly low layer feature distances ( ) as LFM."
                ),
            }]},
        }]]
        blue = [0.34119, 0.70589, 0.91374]
        pdf_pages = [{
            "width": PAGE_WIDTH,
            "height": PAGE_HEIGHT,
            "spans": [
                {"text": "Compared with LFM, FFM reduces the final feature distances (", "bbox": [317.0, 317.67, 502.6639, 329.676], "size": 9.0},
                {"text": ") at shallow positions.", "bbox": [516.969, 317.67, 570.0, 329.676], "size": 9.0},
                {"text": "It still retains similarly low layer feature distances (", "bbox": [317.0, 365.493, 456.2282, 377.497], "size": 9.0},
                {"text": ") as LFM.", "bbox": [466.79, 365.493, 510.0, 377.497], "size": 9.0},
            ],
            "drawings": [
                {"type": "s", "bbox": [503.01474, 324.18701, 516.62091, 324.18701], "color": blue, "fill": None, "commands": ["l"]},
                {"type": "f", "bbox": [505.84937, 321.35242, 511.51862, 327.02161], "color": None, "fill": blue, "commands": ["l", "l", "l", "l"]},
                {"type": "s", "bbox": [456.52463, 372.008, 466.48740, 372.008], "color": blue, "fill": None, "commands": ["l"]},
                {"type": "fs", "bbox": [458.81604, 369.31802, 464.19598, 374.69797], "color": blue, "fill": blue, "commands": ["c", "c", "c", "c"]},
            ],
        }]

        ir = mineru_to_ir(pages, backend="fixture", pdf_pages_override=pdf_pages)

        element = ir["pages"][0]["elements"][0]
        pieces = element["render"]["content"]["paragraph_content"]
        markers = [piece for piece in pieces if piece.get("type") == "inline_marker"]
        self.assertEqual([(item["shape"], item["tone"]) for item in markers], [("square", "blue"), ("circle", "blue")])
        self.assertEqual(len(element["inline_marker_recoveries"]), 2)
        self.assertTrue(all(item["reason"] == "pdf-body-parenthesized-marker-gap" for item in element["inline_marker_recoveries"]))
        flattened = "".join(
            str(piece.get("content") or "") if piece.get("type") == "text" else "MARKER"
            for piece in pieces
        )
        self.assertIn("(MARKER)", flattened)
        self.assertEqual(flattened.count("(MARKER)"), 2)

    def test_parenthesized_body_marker_slots_fail_closed_when_any_slot_is_unmatched(self) -> None:
        pages = [[{
            "type": "paragraph",
            "bbox": [511, 385, 908, 627],
            "content": {"paragraph_content": "One distance ( ) and another distance ( )."},
        }]]
        blue = [0.34119, 0.70589, 0.91374]
        pdf_pages = [{
            "width": PAGE_WIDTH,
            "height": PAGE_HEIGHT,
            "spans": [
                {"text": "One distance (", "bbox": [317, 318, 390, 330], "size": 9.0},
                {"text": ") and another distance (", "bbox": [404, 318, 510, 330], "size": 9.0},
                {"text": ").", "bbox": [524, 318, 530, 330], "size": 9.0},
            ],
            "drawings": [
                {"type": "s", "bbox": [390.5, 324, 403.5, 324], "color": blue, "fill": None, "commands": ["l"]},
                {"type": "f", "bbox": [394, 321, 400, 327], "color": None, "fill": blue, "commands": ["l", "l", "l", "l"]},
            ],
        }]

        ir = mineru_to_ir(pages, backend="fixture", pdf_pages_override=pdf_pages)

        element = ir["pages"][0]["elements"][0]
        pieces = element["render"]["content"]["paragraph_content"]
        self.assertFalse(any(isinstance(piece, dict) and piece.get("type") == "inline_marker" for piece in pieces))
        self.assertNotIn("inline_marker_recoveries", element)

    def test_parenthesized_marker_geometry_rejects_ambiguous_off_baseline_and_mismatched_groups(self) -> None:
        blue = [0.34119, 0.70589, 0.91374]
        orange = [0.90, 0.45, 0.05]
        slot = {"bbox": [100, 50, 114, 62], "font_size": 9.0}
        owner = [80, 35, 140, 75]
        line = {"bbox": [100.3, 56, 113.7, 56], "color": blue, "commands": ["l"]}
        square = {"bbox": [104, 53, 110, 59], "fill": blue, "commands": ["l", "l", "l", "l"]}
        cases = {
            "off-baseline": [{**line, "bbox": [100.3, 68, 113.7, 68]}, square],
            "tone-mismatch": [line, {**square, "fill": orange}],
            "axis-line": [{**line, "bbox": [82, 56, 132, 56]}, square],
            "two-complete-groups": [
                line,
                square,
                {"bbox": [105, 53, 111, 59], "fill": blue, "commands": ["c", "c", "c", "c"]},
            ],
        }
        for name, drawings in cases.items():
            with self.subTest(name=name):
                budget = document_ir._new_emphasis_budget()
                self.assertIsNone(document_ir._drawing_marker_for_slot(slot, drawings, owner, budget))
                self.assertFalse(budget.exceeded)

        entries = [
            {"span": {"text": "distance (", "bbox": [40, 50, 100, 62], "size": 9.0}},
            {"span": {"text": "x", "bbox": [104, 50, 108, 62], "size": 9.0}},
            {"span": {"text": ") result", "bbox": [114, 50, 150, 62], "size": 9.0}},
        ]
        self.assertEqual(document_ir._parenthesized_pdf_slots(entries, [35, 45, 155, 67], document_ir._new_emphasis_budget()), [])

    def test_marker_candidate_pages_require_orphan_body_cue_but_keep_figures(self) -> None:
        pages = [
            [{
                "type": "paragraph",
                "content": {"paragraph_content": "The curve indicates the ordinary measured value."},
            }],
            [{
                "type": "paragraph",
                "content": {"paragraph_content": "Legend. indicates the measured value."},
            }],
            [{"type": "chart", "content": {"chart_caption": "Figure 1. A chart."}}],
        ]

        pages.append([{
            "type": "paragraph",
            "content": {"paragraph_content": "A feature distance ( ) remains in this body paragraph."},
        }])

        self.assertEqual(document_ir._marker_drawing_pages(pages), [2, 3, 4])

    def test_marker_tone_mapping_is_finite_and_fixed_to_the_allowlist(self) -> None:
        samples = {
            "gray": [0.55, 0.55, 0.55],
            "blue": [0.10, 0.35, 0.85],
            "orange": [0.90, 0.45, 0.05],
            "green": [0.12, 0.65, 0.30],
            "red": [0.82, 0.12, 0.10],
            "purple": [0.55, 0.18, 0.75],
            "pink": [0.92, 0.20, 0.58],
        }
        self.assertEqual({document_ir._marker_tone(rgb) for rgb in samples.values()}, set(samples))
        for invalid in ([0.0, 0.0, 0.0], [1.0, 1.0, 1.0], [1.2, 0.2, 0.2], [float("nan"), 0.2, 0.2]):
            self.assertIsNone(document_ir._marker_tone(invalid))

    def test_paragraph_marker_recovery_rejects_subject_verbs_invalid_colors_and_axis_lines(self) -> None:
        cases = [
            (
                "The curve indicates the baseline.",
                {"type": "s", "bbox": [209, 326, 219, 326], "color": [0.1, 0.35, 0.85], "fill": None, "commands": ["l"]},
            ),
            (
                "Legend. indicates the baseline.",
                {"type": "s", "bbox": [150, 326, 219, 326], "color": [0.1, 0.35, 0.85], "fill": None, "commands": ["l"]},
            ),
            (
                "Legend. indicates the baseline.",
                {"type": "s", "bbox": [209, 326, 219, 326], "color": [1.2, 0.2, 0.2], "fill": None, "commands": ["l"]},
            ),
        ]
        for text, line in cases:
            with self.subTest(text=text, line=line):
                pages = [[{
                    "type": "paragraph",
                    "bbox": [100, 300, 500, 380],
                    "content": {"paragraph_content": [{"type": "text", "content": text}]},
                }]]
                pdf_pages = [{
                    "width": PAGE_WIDTH,
                    "height": PAGE_HEIGHT,
                    "spans": [{"text": "indicates the baseline", "bbox": [220, 320, 320, 332], "size": 10.0}],
                    "drawings": [
                        line,
                        {"type": "fs", "bbox": [211, 323, 217, 329], "color": line.get("color"), "fill": line.get("color"), "commands": ["c", "c", "c", "c"]},
                    ],
                }]
                ir = mineru_to_ir(pages, backend="fixture", pdf_pages_override=pdf_pages)
                pieces = ir["pages"][0]["elements"][0]["render"]["content"]["paragraph_content"]
                self.assertFalse(any(piece.get("type") == "inline_marker" for piece in pieces))

    def test_figure_marker_recovery_rejects_axis_lines_and_unpaired_bullets(self) -> None:
        pages = [[{
            "type": "chart",
            "bbox": [519, 90, 897, 251],
            "content": {"chart_caption": [{
                "type": "text",
                "content": "Figure 2. Feature distance at different positions. indicates the layer distance.",
            }]},
        }]]
        pdf_pages = [{
            "width": PAGE_WIDTH,
            "height": PAGE_HEIGHT,
            "spans": [
                {"text": "Figure 2. Feature distance at different positions.", "bbox": [317.2, 216.6, 553.5, 227.4], "size": 9.0},
                {"text": "indicates", "bbox": [521.6, 249.5, 553.5, 260.3], "size": 9.0},
            ],
            "drawings": [
                {"type": "s", "bbox": [450.0, 255.37, 521.33, 255.37], "color": [0.627, 0.627, 0.627], "fill": None, "commands": ["l"]},
                {"type": "fs", "bbox": [514.42, 252.95, 519.26, 257.79], "color": [0.627, 0.627, 0.627], "fill": [0.627, 0.627, 0.627], "commands": ["c", "c", "c", "c"]},
                {"type": "f", "bbox": [500.0, 252.95, 505.0, 257.95], "color": None, "fill": [0.627, 0.627, 0.627], "commands": ["c", "c", "c", "c"]},
            ],
        }]
        with patch("document_ir._extract_pdf_text_pages", return_value=pdf_pages):
            ir = mineru_to_ir(pages, backend="fixture", pdf_path=Path("fixture.pdf"))

        caption = ir["pages"][0]["elements"][0]["render"]["content"]["image_caption"]
        self.assertFalse(any(piece.get("type") == "inline_marker" for piece in caption))

    def test_pdf_colored_citation_spans_detach_mineru_citation_from_formula(self) -> None:
        tex = r"f _ { \theta , \mathrm { L o R A } } ^ { n } \left[ 1 \mathring { 8 } , 3 5 \right]"
        pages = [[{
            "type": "paragraph",
            "bbox": [511, 598, 908, 901],
            "content": {"paragraph_content": [
                {"type": "text", "content": "where only LoRA parameters within "},
                {"type": "equation_inline", "content": tex},
                {"type": "text", "content": "are trainable."},
            ]},
        }]]
        colored_spans = [
            {"text": "[", "bbox": [468.7, 534.4, 472.0, 546.4], "size": 9.0, "color": 0},
            {"text": "18", "bbox": [472.0, 534.4, 481.9, 546.4], "size": 9.0, "color": 0x357CBC},
            {"text": ",", "bbox": [481.9, 534.4, 484.4, 546.4], "size": 9.0, "color": 0},
            {"text": " 35", "bbox": [484.4, 534.4, 496.5, 546.4], "size": 9.0, "color": 0x357CBC},
            {"text": "] are trainable.", "bbox": [496.5, 534.4, 553.5, 546.4], "size": 9.0, "color": 0},
        ]
        pdf_pages = [{"width": PAGE_WIDTH, "height": PAGE_HEIGHT, "spans": colored_spans}]
        with patch("document_ir._extract_pdf_text_pages", return_value=pdf_pages):
            ir = mineru_to_ir(pages, backend="fixture", pdf_path=Path("fixture.pdf"))

        element = ir["pages"][0]["elements"][0]
        pieces = element["render"]["content"]["paragraph_content"]
        equation = next(piece for piece in pieces if piece.get("type") == "equation_inline")
        self.assertNotIn(r"\left[", equation["content"])
        self.assertTrue(any(piece.get("content") == " [18, 35] " for piece in pieces))
        self.assertIn("inline-citation-recovered", element["flags"])

        black_spans = [{**span, "color": 0} for span in colored_spans]
        with patch("document_ir._extract_pdf_text_pages", return_value=[{"width": PAGE_WIDTH, "height": PAGE_HEIGHT, "spans": black_spans}]):
            untouched = mineru_to_ir(pages, backend="fixture", pdf_path=Path("fixture.pdf"))
        untouched_pieces = untouched["pages"][0]["elements"][0]["render"]["content"]["paragraph_content"]
        self.assertEqual(next(piece["content"] for piece in untouched_pieces if piece.get("type") == "equation_inline"), tex)

    def test_mineru_quality_rejects_pathological_script_markup_and_replacement_characters(self) -> None:
        corrupted = " ".join(f"wor<sub>d{i}</sub>" for i in range(30)) + " \ufffd" * 10
        pages = [[
            {"type": "paragraph", "bbox": [20, 40, 480, 180], "content": {"paragraph_content": corrupted}},
            {"type": "paragraph", "bbox": [20, 200, 480, 260], "content": {"paragraph_content": "A second ordinary paragraph keeps the structural count meaningful."}},
        ]]

        quality = mineru_to_ir(pages, backend="fixture")["quality"]

        self.assertEqual(quality["status"], "FAIL")
        self.assertIn("pathological-script-markup", quality["hard_failures"])
        self.assertIn("replacement-characters", quality["hard_failures"])
        self.assertEqual(quality["text_quality"]["replacement_characters"], 10)
        self.assertEqual(quality["text_quality"]["script_runs"], 30)

    def test_mineru_quality_keeps_normal_scientific_subscripts(self) -> None:
        pages = [[
            {"type": "paragraph", "bbox": [20, 40, 480, 120], "content": {"paragraph_content": "The H<sub>2</sub>O concentration remained stable throughout the experiment."}},
            {"type": "paragraph", "bbox": [20, 140, 480, 220], "content": {"paragraph_content": "A separate control paragraph provides enough semantic body text for validation."}},
        ]]

        quality = mineru_to_ir(pages, backend="fixture")["quality"]

        self.assertEqual(quality["status"], "PASS")
        self.assertEqual(quality["text_quality"]["script_runs"], 1)
        self.assertEqual(quality["hard_failures"], [])

    def test_mineru_quality_rejects_mismatched_script_tags(self) -> None:
        pages = [[
            {"type": "paragraph", "bbox": [20, 40, 480, 120], "content": {"paragraph_content": "A malformed H<sub>2</sup>O expression must not reach the reader."}},
            {"type": "paragraph", "bbox": [20, 140, 480, 220], "content": {"paragraph_content": "A second paragraph keeps the structural validation otherwise healthy."}},
        ]]

        quality = mineru_to_ir(pages, backend="fixture")["quality"]

        self.assertEqual(quality["status"], "FAIL")
        self.assertIn("unbalanced-script-markup", quality["hard_failures"])

    def test_mineru_first_page_groups_authors_and_recovers_body_misclassified_as_footnote(self) -> None:
        pages = [[
            {"type": "title", "bbox": [100, 80, 900, 130], "content": {"title_content": "Paper Title"}},
            {"type": "paragraph", "bbox": [180, 150, 390, 220], "content": {"paragraph_content": "First Author, University"}},
            {"type": "title", "bbox": [80, 230, 170, 250], "content": {"title_content": "Abstract"}},
            {"type": "paragraph", "bbox": [80, 260, 480, 560], "content": {"paragraph_content": "Abstract body with enough content to remain in the left column before keywords and introduction."}},
            {"type": "title", "bbox": [80, 580, 180, 600], "content": {"title_content": "1 Introduction"}},
            {"type": "paragraph", "bbox": [80, 610, 480, 850], "content": {"paragraph_content": "The introduction begins in the left column and"}},
            {"type": "paragraph", "bbox": [570, 150, 830, 220], "content": {"paragraph_content": "Second Author, Institute"}},
            {"type": "paragraph", "bbox": [520, 235, 920, 280], "content": {"paragraph_content": "continues at the top of the right column."}},
            {"type": "page_footnote", "bbox": [520, 830, 920, 900], "content": {"page_footnote_content": "(1) A long contribution statement that the extractor mislabeled as a footnote but belongs to the body. " * 2}},
            {"type": "page_footnote", "bbox": [80, 850, 500, 910], "content": {"page_footnote_content": "Permission to make digital or hard copies of all or part of this work is granted without fee. " * 3}},
            {"type": "page_footnote", "bbox": [80, 900, 300, 920], "content": {"page_footnote_content": "WPES ’26, Venue 2026."}},
        ]]
        ir = mineru_to_ir(pages, backend="fixture")
        elements = ir["pages"][0]["elements"]
        texts = [item["text"] for item in elements]
        first_author = next(item for item in elements if item["text"].startswith("First Author"))
        second_author = next(item for item in elements if item["text"].startswith("Second Author"))
        introduction = next(item for item in elements if item["text"].startswith("The introduction"))
        contribution = next(item for item in elements if item["text"].startswith("(1) A long contribution"))
        self.assertEqual(first_author["role"], "metadata")
        self.assertEqual(second_author["role"], "metadata")
        self.assertLess(second_author["reading_order"], texts.index("Abstract") + 1)
        self.assertIn("continues at the top", introduction["text"])
        self.assertIn("cross-column", introduction["flags"])
        self.assertIn("recovered-body", contribution["flags"])
        self.assertFalse(any(text.startswith("Permission to make") for text in texts))
        self.assertNotIn("WPES ’26, Venue 2026.", texts)

    def test_mineru_wrapped_title_keeps_both_lines_before_the_authors(self) -> None:
        # A title that wraps arrives as two title elements. Counting only the
        # first put the author block between the title's two lines.
        pages = [[
            {"type": "title", "bbox": [163, 112, 860, 137], "content": {"title_content": "Programmable design of functional proteins from", "level": 1}},
            {"type": "title", "bbox": [391, 158, 633, 181], "content": {"title_content": "natural language", "level": 1}},
            {"type": "paragraph", "bbox": [159, 202, 865, 324], "content": {"paragraph_content": "Fengyuan Dai, Shiyang You, Yudian Zhu"}},
            {"type": "paragraph", "bbox": [142, 331, 884, 443], "content": {"paragraph_content": "School of Engineering, Westlake University, Hangzhou, China."}},
            {"type": "title", "bbox": [477, 643, 551, 657], "content": {"title_content": "Abstract", "level": 2}},
            {"type": "paragraph", "bbox": [120, 670, 880, 900], "content": {"paragraph_content": "Programming biological function is a foundational goal of molecular engineering. " * 3}},
        ]]

        ir = mineru_to_ir(pages, backend="fixture")
        order = [item["text"] for item in ir["pages"][0]["elements"]]

        self.assertEqual(order[0], "Programmable design of functional proteins from")
        self.assertEqual(order[1], "natural language")
        self.assertTrue(order[2].startswith("Fengyuan Dai"))


if __name__ == "__main__":
    unittest.main()
