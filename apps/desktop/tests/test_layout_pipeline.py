from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from layout_pipeline import (  # noqa: E402
    BuildState,
    LayoutRenderBudget,
    _build_document_html,
    _copy_sidecar_images,
    _extract_ref_numbers,
    _extract_pdf_evidence_isolated,
    _linkify_text,
    _normalize_table_html,
    _load_formula_candidates,
    _load_layout_sidecar,
    _mineru_health_failure,
    _paragraph_html,
    _pdf_tools_root,
    _render_pdf_visual_crops,
    _render_pages,
    _run_mineru,
    _safe_inline,
    _special_tokens,
    _title_html,
    _text_from_content,
    _visual_crop_base_dpi,
    MathRenderer,
    LayoutPipelineCancelled,
    LayoutPipelineError,
    normalize_mineru_backend,
    normalize_mineru_server_url,
    is_remote_mineru_backend,
    process_layout_pdf,
)


class LayoutPipelineTest(unittest.TestCase):
    def test_packaged_math_renderer_does_not_use_an_unmanaged_system_pandoc(self) -> None:
        with patch.object(sys, "frozen", True, create=True), patch.dict(
            os.environ, {"MY_SCHOLAR_PANDOC": ""}
        ), patch("layout_pipeline.shutil.which", return_value="/opt/homebrew/bin/pandoc"):
            self.assertIsNone(MathRenderer().pandoc)

    def test_math_fallback_does_not_duplicate_display_tag(self) -> None:
        with patch.object(sys, "frozen", True, create=True), patch.dict(
            os.environ, {"MY_SCHOLAR_PANDOC": ""}
        ):
            renderer = MathRenderer()
            rendered = renderer.render(r"x = y\tag{7}", display=True)
        self.assertIn("math-fallback", rendered)
        self.assertIn("x = y", rendered)
        self.assertNotIn(r"\tag{7}", rendered)
        self.assertIn("<span class=\"equation-number\">(7)</span>", rendered)

    def test_mineru_cancel_terminates_its_process_group(self) -> None:
        cancel = threading.Event()
        read_fd, write_fd = os.pipe()
        os.write(write_fd, b"cancelled")
        os.close(write_fd)

        class HangingProcess:
            pid = 43210
            returncode = None
            stdout = os.fdopen(read_fd, "rb")

            def poll(self):
                cancel.set()
                return self.returncode

            def wait(self, timeout=None):
                self.returncode = -15
                return self.returncode

        process = HangingProcess()
        with tempfile.TemporaryDirectory(prefix="guzi-mineru-cancel-") as temp, patch(
            "layout_pipeline.subprocess.Popen", return_value=process,
        ) as popen, patch("layout_pipeline.os.killpg") as killpg:
            root = Path(temp)
            with self.assertRaises(LayoutPipelineCancelled):
                _run_mineru(root / "mineru", root / "source.pdf", root / "output", cancel_event=cancel)
            self.assertTrue(popen.call_args.kwargs["start_new_session"])
            killpg.assert_called_once_with(process.pid, __import__("signal").SIGTERM)
            self.assertEqual((root / "output/mineru.log").read_text(encoding="utf-8"), "cancelled")

    def test_mineru_backend_prefers_the_caller_then_the_environment(self) -> None:
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("MY_SCHOLAR_MINERU_BACKEND", None)
            self.assertEqual(normalize_mineru_backend(None), "pipeline")
            self.assertEqual(normalize_mineru_backend("hybrid-engine"), "hybrid-engine")
            self.assertEqual(normalize_mineru_backend(" Hybrid-Engine "), "hybrid-engine")
            self.assertEqual(normalize_mineru_backend("vlm-engine"), "pipeline")
        with patch.dict(os.environ, {"MY_SCHOLAR_MINERU_BACKEND": "hybrid-engine"}):
            self.assertEqual(normalize_mineru_backend(None), "hybrid-engine")
            self.assertEqual(normalize_mineru_backend("pipeline"), "pipeline")

    def test_mineru_command_carries_the_selected_backend(self) -> None:
        class CompleteProcess:
            pid = 43212
            returncode = 0
            stdout = None

            def poll(self):
                return self.returncode

            def wait(self, timeout=None):
                return self.returncode

        with tempfile.TemporaryDirectory(prefix="guzi-mineru-backend-") as temp, patch(
            "layout_pipeline.subprocess.Popen", return_value=CompleteProcess(),
        ) as popen:
            root = Path(temp)
            with self.assertRaisesRegex(LayoutPipelineError, "content_list_v2"):
                _run_mineru(
                    root / "mineru",
                    root / "source.pdf",
                    root / "output",
                    backend="hybrid-engine",
                )
            command = popen.call_args.args[0]
            self.assertEqual(command[command.index("-b") + 1], "hybrid-engine")
            self.assertNotIn("-u", command)

    @staticmethod
    def _complete_process():
        class CompleteProcess:
            pid = 43213
            returncode = 0
            stdout = None

            def poll(self):
                return self.returncode

            def wait(self, timeout=None):
                return self.returncode

        return CompleteProcess()

    def test_remote_backend_sends_the_pdf_to_the_configured_server(self) -> None:
        with tempfile.TemporaryDirectory(prefix="guzi-mineru-remote-") as temp, patch(
            "layout_pipeline.subprocess.Popen", return_value=self._complete_process(),
        ) as popen:
            root = Path(temp)
            with self.assertRaisesRegex(LayoutPipelineError, "content_list_v2"):
                _run_mineru(
                    root / "mineru",
                    root / "source.pdf",
                    root / "output",
                    backend="vlm-http-client",
                    server_url="http://gpu-box.internal:30000/",
                )
            command = popen.call_args.args[0]
            self.assertEqual(command[command.index("-b") + 1], "vlm-http-client")
            # the trailing slash is normalised away
            self.assertEqual(command[command.index("-u") + 1], "http://gpu-box.internal:30000")

    def test_remote_backend_without_a_server_url_is_refused(self) -> None:
        with tempfile.TemporaryDirectory(prefix="guzi-mineru-remote-missing-") as temp, patch(
            "layout_pipeline.subprocess.Popen"
        ) as popen, patch.dict(os.environ, {}, clear=False):
            os.environ.pop("MY_SCHOLAR_MINERU_SERVER_URL", None)
            root = Path(temp)
            with self.assertRaisesRegex(LayoutPipelineError, "服务器地址"):
                _run_mineru(
                    root / "mineru",
                    root / "source.pdf",
                    root / "output",
                    backend="vlm-http-client",
                )
            popen.assert_not_called()

    def test_server_url_accepts_http_and_rejects_everything_else(self) -> None:
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("MY_SCHOLAR_MINERU_SERVER_URL", None)
            self.assertEqual(normalize_mineru_server_url("https://gpu.example.com:30000"), "https://gpu.example.com:30000")
            self.assertEqual(normalize_mineru_server_url("  http://127.0.0.1:30000/  "), "http://127.0.0.1:30000")
            self.assertEqual(normalize_mineru_server_url(None), "")
            self.assertEqual(normalize_mineru_server_url(""), "")
            for rejected in (
                "file:///etc/passwd",
                "ftp://gpu.example.com",
                "http://",
                "gpu.example.com:30000",
                "http://gpu.example.com?x=1",
            ):
                with self.assertRaises(LayoutPipelineError, msg=rejected):
                    normalize_mineru_server_url(rejected)

    def test_server_url_falls_back_to_the_environment(self) -> None:
        with patch.dict(os.environ, {"MY_SCHOLAR_MINERU_SERVER_URL": "http://env-host:30000"}):
            self.assertEqual(normalize_mineru_server_url(None), "http://env-host:30000")
            self.assertEqual(normalize_mineru_server_url("http://caller:1234"), "http://caller:1234")

    def test_remote_backends_are_reported_as_remote(self) -> None:
        self.assertTrue(is_remote_mineru_backend("vlm-http-client"))
        self.assertTrue(is_remote_mineru_backend("hybrid-http-client"))
        self.assertFalse(is_remote_mineru_backend("pipeline"))
        self.assertFalse(is_remote_mineru_backend("hybrid-engine"))

    def test_remote_runs_do_not_queue_behind_the_local_single_slot(self) -> None:
        import layout_pipeline

        # The local engine is deliberately limited to one concurrent run; a
        # remote run only uploads and waits, so it must use its own budget.
        self.assertGreater(layout_pipeline.MINERU_REMOTE_WORKERS, layout_pipeline.MINERU_WORKERS)
        layout_pipeline.MINERU_SEMAPHORE.acquire()
        try:
            with tempfile.TemporaryDirectory(prefix="guzi-mineru-remote-slot-") as temp, patch(
                "layout_pipeline.subprocess.Popen", return_value=self._complete_process(),
            ):
                root = Path(temp)
                # Would block forever if the remote path shared the local slot.
                with self.assertRaisesRegex(LayoutPipelineError, "content_list_v2"):
                    _run_mineru(
                        root / "mineru",
                        root / "source.pdf",
                        root / "output",
                        backend="vlm-http-client",
                        server_url="http://gpu-box.internal:30000",
                    )
        finally:
            layout_pipeline.MINERU_SEMAPHORE.release()

    def test_mineru_progress_lines_parse_stage_and_counts(self) -> None:
        from layout_pipeline import _mineru_progress_update

        self.assertEqual(
            _mineru_progress_update("Layout Predict:  52%|█████▏    | 12/23 [00:09<00:02,  4.93it/s]"),
            ("Layout Predict", 12, 23),
        )
        self.assertEqual(
            _mineru_progress_update("OCR-det:  32%|███▏      | 98/307 [00:07<00:10, 20.66it/s]"),
            ("OCR-det", 98, 307),
        )
        self.assertEqual(
            _mineru_progress_update("Predict: 100%|██████████| 33/33 [11:24<00:00, 20.75s/it]"),
            ("Predict", 33, 33),
        )
        self.assertIsNone(_mineru_progress_update("INFO:     Started server process [22327]"))
        self.assertIsNone(_mineru_progress_update("2026-08-25 16:52:14.794 | INFO | mineru.cli.client - started"))
        self.assertIsNone(_mineru_progress_update("Layout Predict:   0%|          | 0/0 [00:00<?, ?it/s]"))

    def test_mineru_progress_monitor_maps_stages_monotonically(self) -> None:
        from layout_pipeline import _MineruOutputMonitor

        updates: list = []
        monitor = _MineruOutputMonitor(None, lambda stage, fraction: updates.append((stage, fraction)))
        monitor._latest = ("Layout Predict", 12, 23)
        monitor.emit()
        monitor.emit()
        monitor._latest = ("Predict", 5, 33)
        monitor.emit()
        monitor._latest = ("Predict", 6, 33)
        monitor.emit()
        monitor._latest = ("Table orientation det", 17, 17)
        monitor.emit()
        self.assertEqual(
            [stage for stage, _ in updates],
            ["版面检测 12/23", "AI 深度解析 5/33", "表格方向分析 17/17"],
        )
        fractions = [fraction for _, fraction in updates]
        self.assertEqual(fractions, sorted(fractions))
        self.assertAlmostEqual(fractions[1], 0.16 + 0.72 * 5 / 33, places=6)
        self.assertEqual(fractions[2], fractions[1])

    def test_run_mineru_streams_progress_from_stdout(self) -> None:
        read_fd, write_fd = os.pipe()
        transcript = (
            b"2026-08-25 16:52:16 | INFO | starting\n"
            b"Layout Predict:  52%|#####     | 12/23 [00:09<00:02,  4.93it/s]\r"
            b"Predict:  15%|#         | 5/33 [00:41<05:19, 11.41s/it]\r"
            b"done\n"
        )

        class StreamingProcess:
            pid = 43213
            stdout = os.fdopen(read_fd, "rb")

            def __init__(self) -> None:
                self.polls = 0
                self.returncode = None

            def poll(self):
                self.polls += 1
                if self.polls == 1:
                    os.write(write_fd, transcript)
                    os.close(write_fd)
                    return None
                if self.polls < 5:
                    return None
                self.returncode = 0
                return self.returncode

            def wait(self, timeout=None):
                return self.returncode

        updates: list = []
        with tempfile.TemporaryDirectory(prefix="guzi-mineru-progress-") as temp, patch(
            "layout_pipeline.subprocess.Popen", return_value=StreamingProcess(),
        ):
            root = Path(temp)
            with self.assertRaisesRegex(LayoutPipelineError, "content_list_v2"):
                _run_mineru(
                    root / "mineru",
                    root / "source.pdf",
                    root / "output",
                    progress=lambda stage, fraction: updates.append((stage, fraction)),
                )
            log = (root / "output/mineru.log").read_text(encoding="utf-8")
            self.assertIn("Layout Predict", log)
            self.assertIn("done", log)
            self.assertEqual(updates[0], ("启动本地版面引擎", 0.0))
            self.assertEqual(updates[-1][0], "AI 深度解析 5/33")
            fractions = [fraction for _, fraction in updates]
            self.assertEqual(fractions, sorted(fractions))

    def test_managed_mineru_uses_component_cwd_minimal_path_and_offline_caches(self) -> None:
        class CompleteProcess:
            pid = 43211
            returncode = 0
            stdout = None

            def poll(self):
                return self.returncode

            def wait(self, timeout=None):
                return self.returncode

        with tempfile.TemporaryDirectory(prefix="guzi-mineru-environment-") as temp, patch(
            "layout_pipeline.subprocess.Popen", return_value=CompleteProcess(),
        ) as popen:
            root = Path(temp)
            component = root / "components/mineru/test-1/darwin-arm64"
            executable = component / "bin/mineru"
            executable.parent.mkdir(parents=True)
            executable.write_bytes(b"binary")
            with self.assertRaisesRegex(LayoutPipelineError, "content_list_v2"):
                _run_mineru(
                    executable,
                    root / "source.pdf",
                    root / "output",
                    runtime_root=component,
                )
            options = popen.call_args.kwargs
            managed = component.resolve()
            self.assertEqual(options["cwd"], str(managed))
            self.assertEqual(options["env"]["PATH"], f"{managed}/bin:/usr/bin:/bin:/usr/sbin:/sbin")
            self.assertEqual(options["env"]["HF_HUB_OFFLINE"], "1")
            self.assertEqual(options["env"]["MY_SCHOLAR_MINERU_COMPONENT_ROOT"], str(managed))
            self.assertNotIn("PYTHONPATH", options["env"])

    def test_layout_sidecar_is_bounded_before_ir_construction(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-sidecar-boundary-") as temp:
            root = Path(temp)
            source = root / "paper.pdf"
            source.write_bytes(b"%PDF-1.4\n")
            sidecar = root / "paper_content_list_v2.json"
            sidecar.write_text(json.dumps([[{"type": "paragraph", "content": {"paragraph_content": "safe"}}]]), encoding="utf-8")
            self.assertEqual(_load_layout_sidecar(sidecar)[0][0]["type"], "paragraph")

            with patch("layout_pipeline.LAYOUT_SIDECAR_MAX_JSON_BYTES", 8), patch(
                "layout_pipeline._find_layout_sidecar", return_value=(sidecar, "configured-sidecar")
            ), patch("layout_pipeline.mineru_to_ir") as mineru:
                with self.assertRaisesRegex(Exception, "文件超过安全上限"):
                    process_layout_pdf(source, root / "job", job_id="bounded123456789", source_name=source.name)
                mineru.assert_not_called()

    def test_layout_sidecar_rejects_structural_amplification(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-sidecar-shape-") as temp:
            sidecar = Path(temp) / "paper_content_list_v2.json"
            cases = [
                ("LAYOUT_SIDECAR_MAX_PAGES", 1, [[], []], "页数"),
                ("LAYOUT_SIDECAR_MAX_ELEMENTS", 1, [[{}, {}]], "元素数量"),
                ("LAYOUT_SIDECAR_MAX_NODES", 3, [[{"content": "safe"}]], "节点数量"),
                ("LAYOUT_SIDECAR_MAX_STRING_CHARS", 4, [[{"content": "too-long"}]], "文本总量"),
            ]
            for constant, limit, value, message in cases:
                with self.subTest(constant=constant):
                    sidecar.write_text(json.dumps(value), encoding="utf-8")
                    with patch(f"layout_pipeline.{constant}", limit), self.assertRaisesRegex(Exception, message):
                        _load_layout_sidecar(sidecar)

            nested: object = "leaf"
            for _ in range(8):
                nested = {"child": nested}
            sidecar.write_text(json.dumps([[{"content": nested}]]), encoding="utf-8")
            with patch("layout_pipeline.LAYOUT_SIDECAR_MAX_DEPTH", 4), self.assertRaisesRegex(Exception, "嵌套层级"):
                _load_layout_sidecar(sidecar)

    def test_pdf_evidence_worker_isolated_success_timeout_and_output_limit(self) -> None:
        try:
            import fitz  # type: ignore
        except ImportError:
            self.skipTest("PyMuPDF is not installed")
        with tempfile.TemporaryDirectory(prefix="my-scholar-pdf-evidence-") as temp:
            root = Path(temp)
            source = root / "paper.pdf"
            document = fitz.open()
            page = document.new_page(width=300, height=300)
            page.insert_text((20, 40), "Bounded evidence")
            document.save(source)
            document.close()
            evidence = _extract_pdf_evidence_isolated(source, [[{"type": "paragraph"}]], root)
            self.assertEqual(len(evidence), 1)
            self.assertIn("Bounded evidence", " ".join(span["text"] for span in evidence[0]["spans"]))

            with patch("layout_pipeline.subprocess.run", side_effect=subprocess.TimeoutExpired(["worker"], 1)):
                self.assertEqual(_extract_pdf_evidence_isolated(source, [[]], root), [])

            def oversized(command, **_kwargs):
                output = Path(command[command.index("--pdf-evidence-output") + 1])
                output.write_bytes(b"x" * 17)
                return types.SimpleNamespace(returncode=0)

            with patch("layout_pipeline.PDF_EVIDENCE_MAX_OUTPUT_BYTES", 16), patch(
                "layout_pipeline.subprocess.run", side_effect=oversized
            ):
                self.assertEqual(_extract_pdf_evidence_isolated(source, [[]], root), [])

    def test_stale_mineru_shebang_is_rejected_before_ingestion(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            executable = Path(temp) / "mineru"
            executable.write_text("#!/definitely/missing/mineru-python\n", encoding="utf-8")
            self.assertIn("启动解释器不存在", _mineru_health_failure(executable) or "")

    def test_pdf_tools_root_supports_migrated_sibling_layout(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            workspace = Path(temp)
            project_root = workspace / "my-scholar" / "macos"
            tools_root = workspace / "pdf-tools"
            project_root.mkdir(parents=True)
            tools_root.mkdir()
            with patch("layout_pipeline.PROJECT_ROOT", project_root), patch.dict(
                os.environ,
                {"MY_SCHOLAR_TOOLCHAIN_ROOT": ""},
            ):
                self.assertEqual(_pdf_tools_root(), tools_root.resolve())

    def test_pdf_tools_root_supports_shared_apps_desktop_layout(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            workspace = Path(temp)
            project_root = workspace / "guzi-scholar" / "apps" / "desktop"
            tools_root = workspace / "pdf-tools"
            project_root.mkdir(parents=True)
            tools_root.mkdir()
            with patch("layout_pipeline.PROJECT_ROOT", project_root), patch.dict(
                os.environ,
                {"MY_SCHOLAR_TOOLCHAIN_ROOT": ""},
            ):
                self.assertEqual(_pdf_tools_root(), tools_root.resolve())

    def test_partial_fitz_page_render_is_discarded_when_fallback_is_unavailable(self) -> None:
        class FakePixmap:
            def save(self, path: str) -> None:
                Path(path).write_bytes(b"png")

        class FakePage:
            def __init__(self, index: int) -> None:
                self.index = index

            def get_pixmap(self, **_kwargs):
                if self.index == 1:
                    raise RuntimeError("render failed")
                return FakePixmap()

        class FakeDocument:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def __len__(self) -> int:
                return 3

            def __getitem__(self, index: int):
                return FakePage(index)

        fake_fitz = types.SimpleNamespace(open=lambda _path: FakeDocument(), Matrix=lambda *_args: object())
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / "pages"
            with patch.dict(sys.modules, {"fitz": fake_fitz}), patch("layout_pipeline._which", return_value=None):
                rendered = _render_pages(Path(temp) / "paper.pdf", target, 3)
            self.assertEqual(rendered, [])
            self.assertEqual(list(target.glob("page-*.png")), [])

    def test_special_tokens_are_rendered_and_audited_without_translation(self) -> None:
        rendered = _safe_inline(r"Input [I_CLS] and [T\_SEP] tokens")
        self.assertIn('class="math-token"', rendered)
        self.assertIn('[I<sub>CLS</sub>]', rendered)
        self.assertIn('[T<sub>SEP</sub>]', rendered)
        self.assertEqual(_special_tokens(r"Input [I_CLS] and [T\_SEP]"), ["[I_CLS]", "[T_SEP]"])

    def test_structured_pdf_emphasis_renders_safe_strong_and_reaches_metadata(self) -> None:
        text = "All parameters are frozen; only the stitch layer is trainable."
        pages = [[{
            "type": "paragraph",
            "bbox": [10, 20, 510, 80],
            "content": {"paragraph_content": [{
                "type": "text",
                "content": text,
                "emphasis": [{"start": 19, "end": 25, "style": "bold", "source": "pdf-font"}],
            }]},
            "_ir": {
                "block_id": "bold-paragraph",
                "emphasis": [{
                    "start": 19,
                    "end": 25,
                    "style": "bold",
                    "text": "frozen",
                    "source": "pdf-font",
                    "font": "NimbusRomNo9L-Medi",
                }],
            },
        }]]

        document, metadata = _build_document_html("fixture.pdf", pages, {}, ["page-1.png"], {})

        self.assertIn('<strong data-emphasis-source="pdf-font">frozen</strong>', document)
        self.assertEqual(metadata["pages"][0]["elements"][0]["emphasis"][0]["text"], "frozen")

    def test_fixed_pdf_text_tone_renders_safely_and_overlaps_bold(self) -> None:
        text = "Layer Feature Matching (LFM) and ordinary text."
        pages = [[{
            "type": "paragraph",
            "bbox": [10, 20, 510, 80],
            "content": {"paragraph_content": [{
                "type": "text",
                "content": text,
                "emphasis": [
                    {"start": 0, "end": 28, "style": "bold", "source": "pdf-font"},
                    {"start": 0, "end": 28, "style": "color", "source": "pdf-text-color", "tone": "orange"},
                    {"start": 33, "end": 41, "style": "color", "tone": 'blue\" onclick=\"alert(1)'},
                    {"start": 42, "end": 46, "style": "position:absolute", "tone": "red"},
                ],
            }]},
            "_ir": {
                "block_id": "colored-paragraph",
                "emphasis": [
                    {"start": 0, "end": 28, "style": "bold", "text": text[:28], "source": "pdf-font"},
                    {"start": 0, "end": 28, "style": "color", "text": text[:28], "source": "pdf-text-color", "tone": "orange"},
                ],
            },
        }]]

        document, metadata = _build_document_html("fixture.pdf", pages, {}, ["page-1.png"], {})

        self.assertIn(
            '<strong data-emphasis-source="pdf-font"><span class="pdf-text-tone pdf-text-tone-orange" data-text-tone="orange">Layer Feature Matching (LFM)</span></strong>',
            document,
        )
        self.assertIn(".pdf-text-tone-orange", document)
        self.assertNotIn("onclick", document)
        self.assertNotIn('data-text-tone="red"', document)
        self.assertEqual(metadata["pages"][0]["elements"][0]["emphasis"][1]["tone"], "orange")

    def test_nougat_inline_candidate_repairs_argmax_and_cross_reference(self) -> None:
        # The repo moved into a platform monorepo (macos/); the fixture repo
        # stays a sibling of the monorepo root, so probe both parent levels.
        tools_root = next((parent / "pdf-tools" for parent in ROOT.parents if (parent / "pdf-tools").is_dir()), ROOT.parent / "pdf-tools")
        sidecar = tools_root / "results/mineru-pipeline/OneLLM_CVPR_2024/auto/OneLLM_CVPR_2024_content_list_v2.json"
        formula_dir = tools_root / "results/nougat-pages"
        if not (sidecar.is_file() and formula_dir.is_dir()):
            self.skipTest("OneLLM layout/formula fixtures 不存在")
        pages = json.loads(sidecar.read_text(encoding="utf-8"))
        item = pages[7][3]
        candidates = _load_formula_candidates(formula_dir)[8]["inline"]
        block, formulas, repairs, unresolved, markdown = _paragraph_html(item, MathRenderer(), BuildState(), candidates)
        self.assertTrue(repairs)
        self.assertTrue(any("arg\\,max" in item["tex"] for item in repairs))
        self.assertIn("<math", block)
        self.assertNotIn("k<sup>∗</sup> = arg max w<sub>k</sub>", block)
        self.assertNotIn("Tab. 7 k (d)", block)
        self.assertIn("Tab. 7 (d)", block)
        self.assertIn("$k^{*}=\\operatorname*{arg\\,max}_{k}w_{k}$", markdown)
        self.assertEqual(unresolved, [])

    def test_ordinary_argmax_sentence_is_not_converted(self) -> None:
        candidate = r"k^{*}=\operatorname*{arg\,max}_{k}w_{k}"
        item = {"content": {"paragraph_content": [{"type": "text", "content": "The arg max operation is useful in this sentence."}]}}
        block, _, repairs, _, _ = _paragraph_html(item, MathRenderer(), BuildState(), [candidate])
        self.assertNotIn("<math", block)
        self.assertEqual(repairs, [])

    def test_missing_nougat_candidate_keeps_safe_fallback(self) -> None:
        item = {"content": {"paragraph_content": [{"type": "text", "content": "where k<sup>∗</sup> = arg max w<sub>k</sub>."}]}}
        block, _, repairs, unresolved, markdown = _paragraph_html(item, MathRenderer(), BuildState(), [])
        self.assertEqual(repairs, [])
        self.assertIn("k<sup>∗</sup> = arg max w<sub>k</sub>", block)
        self.assertEqual(markdown, "where k<sup>∗</sup> = arg max w<sub>k</sub>.")
        self.assertEqual(unresolved, [])

    def test_nested_reference_content_is_flattened(self) -> None:
        value = {
            "list_type": "reference_list",
            "list_items": [
                {"item_type": "text", "item_content": [{"type": "text", "content": "[1] Example"}]},
                {"item_type": "text", "item_content": [{"type": "text", "content": "[2] Another"}]},
            ],
        }
        self.assertEqual(_text_from_content(value), "[1] Example[2] Another")
        self.assertEqual(_extract_ref_numbers([[{"type": "list", "content": value}]]), {1, 2})


    def test_table_normalization_keeps_spans_and_adds_header_semantics(self) -> None:
        table = '<table><tr><td rowspan="2">Model</td><td colspan="2">VQA</td></tr><tr><td>A</td><td>B</td></tr></table>'
        normalized = _normalize_table_html(table)
        self.assertIn('<th rowspan="2">Model</th>', normalized)
        self.assertIn('colspan="2"', normalized)
        self.assertEqual(normalized.count("<table"), 1)


    def test_citations_and_cross_references_resolve(self) -> None:
        unresolved: list[str] = []
        value = _linkify_text("See Fig. 1 and [3, 4].", {3, 4}, {"fig-1"}, unresolved)
        self.assertIn('href="#fig-1"', value)
        self.assertIn('href="#ref-3"', value)
        self.assertIn('href="#ref-4"', value)
        self.assertEqual(unresolved, [])

    def test_appendix_and_reference_titles_are_classified(self) -> None:
        state = BuildState()
        appendix_html, appendix_kind = _title_html({"content": {"title_content": "Appendix A. Additional Results"}}, state)
        reference_html, reference_kind = _title_html({"content": {"title_content": "References"}}, state)
        self.assertEqual(appendix_kind, "appendix")
        self.assertEqual(reference_kind, "references")
        self.assertIn("Appendix A", appendix_html)
        self.assertIn("References", reference_html)

    def test_document_section_audit_keeps_appendix_and_references(self) -> None:
        pages = [
            [{"type": "title", "content": {"title_content": "Appendix A. Additional Results"}}],
            [{"type": "title", "content": {"title_content": "References"}}],
        ]
        _, metadata = _build_document_html("fixture.pdf", pages, {}, ["page-1.png", "page-2.png"], {})
        self.assertEqual(metadata["section_audit"]["appendix_pages"], [1])
        self.assertEqual(metadata["section_audit"]["reference_pages"], [2])

    def test_reader_uses_paper_serif_type_and_continuous_white_pages(self) -> None:
        pages = [[
            {"type": "title", "content": {"title_content": "A Paper Title", "level": 1}},
            {"type": "paragraph", "bbox": [0, 120, 500, 160], "content": {"paragraph_content": "Alice Example, Example University"}},
            {"type": "paragraph", "bbox": [0, 420, 500, 520], "content": {"paragraph_content": "English text 与中文正文。"}},
        ], [
            {"type": "title", "content": {"title_content": "2 Method", "level": 2}},
        ]]
        document, _ = _build_document_html("fixture.pdf", pages, {}, ["page-1.png", "page-2.png"], {})
        self.assertIn('--ui-font:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Segoe UI",sans-serif', document)
        self.assertIn('--paper-font:"Times New Roman",Times,"Songti SC",STSong,"Noto Serif CJK SC",serif', document)
        self.assertIn('body { margin:0; background:var(--paper); color:var(--ink); font-family:var(--ui-font); }', document)
        self.assertIn('.reader-content{max-width:1080px;margin:0 auto;background:var(--paper);font-family:var(--paper-font);font-size:calc(17px * var(--reader-font-scale));line-height:var(--reader-line-height)', document)
        self.assertIn('h1,h2,h3,h4,h5,h6{font-family:var(--paper-font)', document)
        self.assertIn('math,.math-inline,.pdf-equation{font-family:"Times New Roman",Times,serif}', document)
        self.assertIn('.my-scholar-translation{display:block;', document)
        self.assertIn(':has(+ .my-scholar-translation){margin-bottom:0}', document)
        self.assertIn('.pdf-page > .my-scholar-translation:last-child{margin-bottom:.86em}', document)
        self.assertNotIn('.my-scholar-translation>span', document)
        self.assertIn('font-family:var(--paper-font);font-size:.94em;line-height:1.68', document)
        self.assertIn('background:rgba(246,166,35,.38)', document)
        self.assertIn('@media(prefers-color-scheme:dark)', document)
        self.assertIn('class="paper-title" data-translate-block-id="block-1-0-title"', document)
        self.assertIn('class="paper-metadata" data-translation-excluded="metadata"', document)
        self.assertIn('.pdf-page{padding-top:0;padding-bottom:0;border-top:0;border-bottom:0}', document)
        self.assertIn('.pdf-page + .pdf-page{padding-top:0;border-top:0}', document)
        self.assertIn('.highlight-group-research_goal', document)
        self.assertIn('.my-scholar-highlight-innovation', document)
        self.assertNotIn('padding-top:36px', document)
        self.assertNotIn('padding:44px clamp(30px,5vw,74px) 28px', document)
        self.assertNotIn('body { margin:0; background:#eef2f5', document)
        self.assertNotIn('.pdf-page + .pdf-page{padding-top:38px;border-top:1px', document)

    def test_visual_elements_use_pdf_crops_and_caption_translation_anchors(self) -> None:
        pages = [[
            {"type": "image", "bbox": [10, 10, 110, 70], "content": {"image_caption": "Figure 1. A caption.", "image_source": {"path": "images/low.jpg"}}},
            {"type": "table", "bbox": [10, 80, 110, 140], "content": {"table_caption": "Table 1. A caption.", "image_source": {"path": "images/low-table.jpg"}, "html": "<table><tr><td>A</td></tr></table>"}},
        ]]
        document, metadata = _build_document_html(
            "fixture.pdf", pages, {"low.jpg": "assets/images/low.jpg", "low-table.jpg": "assets/images/low-table.jpg"}, ["page-1.png"], {},
            visual_assets={
                "block-1-0-image": "assets/images/pdf-figure.png",
                "block-1-1-table": "assets/images/pdf-table.png",
            },
            visual_asset_metadata={
                "block-1-0-image": {"actual_dpi": 600, "pixel_width": 1920, "pixel_height": 900},
                "block-1-1-table": {"actual_dpi": 300, "pixel_width": 2100, "pixel_height": 800},
            },
        )
        self.assertIn('src="assets/images/pdf-figure.png"', document)
        self.assertIn('src="assets/images/pdf-table.png"', document)
        self.assertIn('figcaption data-translate-block-id="block-1-0-image"', document)
        self.assertIn('figcaption data-translate-block-id="block-1-1-table"', document)
        self.assertIn(".references{list-style:none;padding-left:0}", document)
        image = metadata["pages"][0]["elements"][0]
        table = metadata["pages"][0]["elements"][1]
        self.assertEqual(image["visual_source"], "pdf-crop")
        self.assertFalse(image["visual_fallback"])
        self.assertEqual(image["actual_dpi"], 600)
        self.assertEqual(image["pixel_width"], 1920)
        self.assertEqual(table["visual_asset"], "assets/images/pdf-table.png")
        self.assertEqual(table["actual_dpi"], 300)

        _, fallback_metadata = _build_document_html(
            "fixture.pdf",
            pages,
            {"low.jpg": "assets/images/low.jpg", "low-table.jpg": "assets/images/low-table.jpg"},
            ["page-1.png"],
            {},
            visual_assets={},
        )
        fallback = fallback_metadata["pages"][0]["elements"][0]
        self.assertEqual(fallback["visual_asset"], "assets/images/low.jpg")
        self.assertEqual(fallback["visual_source"], "mineru-crop")
        self.assertTrue(fallback["visual_fallback"])
        self.assertIsNone(fallback["actual_dpi"])
        self.assertIsNone(fallback["pixel_width"])

    def test_composite_visual_never_uses_the_whole_page_as_a_fallback(self) -> None:
        pages = [[{
            "type": "image",
            "bbox": [10, 10, 500, 500],
            "content": {
                "image_caption": "Figure 1. Composite source.",
                "image_source": {"path": "images/panel-a.jpg"},
            },
            "_ir": {"block_id": "block-1-composite-image", "source": "mineru-composite"},
        }]]

        document, metadata = _build_document_html(
            "fixture.pdf",
            pages,
            {"panel-a.jpg": "assets/images/panel-a.jpg"},
            ["page-1.png"],
            {},
            visual_assets={},
        )

        self.assertNotIn('src="pages/page-1.png"', document)
        visual = metadata["pages"][0]["elements"][0]
        self.assertEqual(visual["visual_source"], "source-unavailable")
        self.assertIsNone(visual["visual_asset"])
        self.assertTrue(visual["visual_fallback"])

    def test_ir_block_ids_and_provenance_reach_reader_metadata(self) -> None:
        pages = [[{
            "type": "paragraph",
            "bbox": [10, 20, 110, 60],
            "content": {"paragraph_content": "Ordered body."},
            "_ir": {
                "block_id": "block-1-source-42-paragraph",
                "reading_order": 3,
                "confidence": 0.84,
                "source": "opendataloader",
                "source_id": "source-42",
                "column": 2,
                "flags": ["cross-column"],
                "fragments": [{"page": 1, "bbox": [10, 20, 110, 60], "text": "Ordered body."}],
            },
        }]]
        document, metadata = _build_document_html("fixture.pdf", pages, {}, ["page-1.png"], {})
        self.assertIn('data-block-id="block-1-source-42-paragraph"', document)
        record = metadata["pages"][0]["elements"][0]
        self.assertEqual(record["reading_order"], 3)
        self.assertEqual(record["source"], "opendataloader")
        self.assertEqual(record["flags"], ["cross-column"])

    def test_uncaptioned_figure_does_not_steal_a_later_paper_anchor(self) -> None:
        pages = [[
            {"type": "image", "bbox": [10, 10, 110, 60], "content": {"image_caption": ""}},
            {"type": "image", "bbox": [10, 70, 110, 120], "content": {"image_caption": "Figure 1. Main architecture."}},
        ]]
        document, _ = _build_document_html("fixture.pdf", pages, {}, ["page-1.png"], {})
        anchors = re.findall(r'<figure class="pdf-figure" id="([^"]+)"', document)
        self.assertEqual(len(anchors), len(set(anchors)))
        self.assertIn("fig-1", anchors)
        self.assertNotEqual(anchors[0], "fig-1")

    def test_abstract_semantics_and_visual_modules_use_paper_background(self) -> None:
        pages = [[
            {"type": "title", "bbox": [10, 10, 110, 30], "content": {"title_content": "A Paper Title", "level": 1}},
            {"type": "paragraph", "bbox": [10, 40, 110, 55], "content": {"paragraph_content": [{"type": "text", "content": "Author Name"}]}},
            {"type": "title", "bbox": [10, 310, 110, 330], "content": {"title_content": "Abstract", "level": 2}},
            {"type": "paragraph", "bbox": [10, 340, 110, 390], "content": {"paragraph_content": [{"type": "text", "content": "This is the abstract body."}]}},
            {"type": "title", "bbox": [10, 410, 110, 430], "content": {"title_content": "1. Introduction", "level": 2}},
            {"type": "paragraph", "bbox": [10, 440, 110, 490], "content": {"paragraph_content": [{"type": "text", "content": "This is the main body."}]}},
        ]]
        document, _ = _build_document_html("fixture.pdf", pages, {}, ["page-1.png"], {})
        self.assertRegex(document, r'<h2[^>]*class="paper-abstract-heading"[^>]*>Abstract</h2>')
        self.assertRegex(document, r'<p[^>]*class="paper-abstract-body"[^>]*>This is the abstract body\.</p>')
        self.assertNotRegex(document, r'<p[^>]*class="paper-abstract-body"[^>]*>This is the main body\.</p>')
        self.assertIn('.paper-abstract-body,.paper-abstract-translation{font-style:italic}', document)
        self.assertIn('.pdf-figure,.pdf-table{margin:28px 0;padding:14px;border:1px solid var(--line);border-radius:9px;background:transparent}', document)

    def test_ieee_inline_abstract_and_keywords_share_front_matter_typography(self) -> None:
        pages = [[
            {
                "type": "title", "bbox": [10, 10, 510, 70],
                "content": {"title_content": "LD-PA: Paper Title", "level": 1},
                "_ir": {"block_id": "title", "role": "body"},
            },
            {
                "type": "paragraph", "bbox": [90, 90, 430, 115],
                "content": {"paragraph_content": "Alice Example and Bob Example"},
                "_ir": {"block_id": "authors", "role": "metadata"},
            },
            {
                "type": "paragraph", "bbox": [10, 140, 250, 360],
                "content": {"paragraph_content": "Abstract—The inline abstract uses the shared semantic role."},
                "_ir": {"block_id": "abstract", "role": "body", "section_role": "abstract-body"},
            },
            {
                "type": "paragraph", "bbox": [10, 370, 250, 410],
                "content": {"paragraph_content": "Index Terms—privacy, security, deep learning."},
                "_ir": {"block_id": "keywords", "role": "body", "section_role": "keywords"},
            },
            {"type": "title", "bbox": [10, 420, 250, 445], "content": {"title_content": "I. INTRODUCTION", "level": 2}},
            {"type": "paragraph", "bbox": [10, 450, 250, 520], "content": {"paragraph_content": "Ordinary body text remains upright."}},
        ]]

        document, metadata = _build_document_html("fixture.pdf", pages, {}, ["page-1.png"], {})

        self.assertIn('class="paper-metadata" data-translation-excluded="metadata">Alice Example', document)
        self.assertIn('class="paper-abstract-body"><strong class="paper-section-label paper-abstract-label">Abstract—</strong>', document)
        self.assertIn('class="paper-keywords"><strong class="paper-section-label paper-keywords-label">Index Terms—</strong>', document)
        self.assertIn('color:color-mix(in srgb,var(--ink) 42%,var(--paper))', document)
        self.assertEqual(metadata["pages"][0]["elements"][2]["section_role"], "abstract-body")
        self.assertEqual(metadata["pages"][0]["elements"][3]["section_role"], "keywords")

    def test_promoted_standalone_abstract_renders_before_right_column_keywords(self) -> None:
        pages = [[
            {
                "type": "title", "bbox": [53, 148, 95, 163],
                "content": {"title_content": "Abstract", "level": 2},
                "_ir": {"block_id": "abstract-heading", "reading_order": 2, "section_role": "abstract-heading"},
            },
            {
                "type": "paragraph", "bbox": [53, 164, 295, 320],
                "content": {"paragraph_content": [{"type": "text", "content": "A clean same-column abstract body."}]},
                "_ir": {"block_id": "abstract-body", "reading_order": 3, "section_role": "abstract-body"},
            },
            {
                "type": "title", "bbox": [317, 148, 367, 163],
                "content": {"title_content": "Keywords", "level": 2},
                "_ir": {"block_id": "keywords-heading", "reading_order": 4},
            },
        ]]

        document, metadata = _build_document_html("fixture.pdf", pages, {}, ["page-1.png"], {})

        self.assertLess(document.index("paper-abstract-heading"), document.index("paper-abstract-body"))
        self.assertLess(document.index("A clean same-column abstract body."), document.index("Keywords"))
        self.assertEqual(metadata["pages"][0]["elements"][0]["section_role"], "abstract-heading")
        self.assertEqual(metadata["pages"][0]["elements"][1]["section_role"], "abstract-body")

    def test_tables_keep_unique_anchors_and_never_render_semantic_fallback(self) -> None:
        pages = [[
            {"type": "table", "bbox": [10, 10, 110, 60], "content": {"table_caption": "", "html": "<table><tr><td>A</td></tr></table>"}},
            {"type": "table", "bbox": [10, 70, 110, 120], "content": {"table_caption": "Table 1: second view.", "html": "<table><tr><td>B</td></tr></table>"}},
        ]]
        document, metadata = _build_document_html("fixture.pdf", pages, {}, ["page-1.png"], {}, {})
        self.assertEqual(re.findall(r'<figure class="pdf-table [^"]*" id="([^"]+)"', document), ["table-1", "table-2"])
        self.assertNotIn("<table", document)
        self.assertEqual(metadata["summary"]["semantic_tables"], 0)

    def test_pdf_visual_crops_adapt_density_for_narrow_regions(self) -> None:
        try:
            import fitz  # type: ignore
        except ImportError:
            self.skipTest("PyMuPDF is not installed")
        with tempfile.TemporaryDirectory(prefix="my-scholar-crop-test-") as temp:
            root = Path(temp)
            source = root / "source.pdf"
            document = fitz.open()
            page = document.new_page(width=600, height=600)
            page.draw_rect(fitz.Rect(20, 20, 260, 120), color=(0, 0, 0), fill=(0.8, 0.8, 0.8))
            page.draw_rect(fitz.Rect(20, 160, 540, 320), color=(0, 0, 0), fill=(0.6, 0.6, 0.6))
            document.save(source)
            document.close()
            crop_metadata = {}
            crops = _render_pdf_visual_crops(
                source,
                [[
                    {"type": "image", "bbox": [20, 20, 260, 120]},
                    {"type": "table", "bbox": [20, 160, 540, 320]},
                ]],
                root / "assets" / "images",
                metadata=crop_metadata,
            )
            narrow_asset = crops["block-1-0-image"]
            wide_asset = crops["block-1-1-table"]
            narrow = fitz.Pixmap(root / narrow_asset)
            wide = fitz.Pixmap(root / wide_asset)
            self.assertTrue(narrow_asset.endswith("@576.png"))
            self.assertGreaterEqual(narrow.width, 1_900)
            self.assertEqual(crop_metadata["block-1-0-image"]["actual_dpi"], 576)
            self.assertTrue(crop_metadata["block-1-0-image"]["target_width_met"])
            self.assertTrue(wide_asset.endswith("@300.png"))
            self.assertGreaterEqual(wide.width, 2_100)
            self.assertEqual(crop_metadata["block-1-1-table"]["actual_dpi"], 300)

    def test_pdf_visual_crops_use_mineru_normalized_canvas_when_source_is_marked(self) -> None:
        try:
            import fitz  # type: ignore
        except ImportError:
            self.skipTest("PyMuPDF is not installed")
        with tempfile.TemporaryDirectory(prefix="my-scholar-normalized-crop-test-") as temp:
            root = Path(temp)
            source = root / "source.pdf"
            document = fitz.open()
            page = document.new_page(width=612, height=792)
            page.draw_rect(fitz.Rect(110, 212, 502, 431), color=(0, 0, 0), fill=(0.8, 0.8, 0.8))
            document.save(source)
            document.close()
            crop_metadata = {}
            crops = _render_pdf_visual_crops(
                source,
                [[{
                    "type": "image",
                    "bbox": [179, 267, 820, 544],
                    "_ir": {"block_id": "normalized-figure", "source": "mineru-composite"},
                }]],
                root / "assets" / "images",
                dpi=72,
                target_width_px=100,
                max_dpi=72,
                max_pixels=1_000_000,
                metadata=crop_metadata,
            )
            asset = crops["normalized-figure"]
            pixmap = fitz.Pixmap(root / asset)
            self.assertAlmostEqual(pixmap.width, 612 * 641 / 1000, delta=1)
            self.assertAlmostEqual(pixmap.height, 792 * 277 / 1000, delta=1)
            self.assertEqual(crop_metadata["normalized-figure"]["visual_source"], "pdf-crop")

    def test_pdf_visual_crops_enforce_max_dpi_and_pixel_area(self) -> None:
        try:
            import fitz  # type: ignore
        except ImportError:
            self.skipTest("PyMuPDF is not installed")
        with tempfile.TemporaryDirectory(prefix="my-scholar-crop-cap-test-") as temp:
            root = Path(temp)
            source = root / "source.pdf"
            document = fitz.open()
            document.new_page(width=600, height=600)
            document.save(source)
            document.close()

            max_dpi_metadata = {}
            max_dpi_crops = _render_pdf_visual_crops(
                source,
                [[{"type": "image", "bbox": [20, 20, 70, 120]}]],
                root / "max-dpi",
                max_dpi=900,
                metadata=max_dpi_metadata,
            )
            self.assertTrue(max_dpi_crops["block-1-0-image"].endswith("@600.png"))
            self.assertEqual(max_dpi_metadata["block-1-0-image"]["actual_dpi"], 600)
            self.assertFalse(max_dpi_metadata["block-1-0-image"]["target_width_met"])

            pixel_metadata = {}
            pixel_crops = _render_pdf_visual_crops(
                source,
                [[{"type": "image", "bbox": [20, 20, 580, 580]}]],
                root / "pixel-cap",
                dpi=600,
                max_pixels=500_000,
                metadata=pixel_metadata,
            )
            asset = pixel_crops["block-1-0-image"]
            pixmap = fitz.Pixmap(root / "pixel-cap" / Path(asset).name)
            self.assertLessEqual(pixmap.width * pixmap.height, 500_000)
            self.assertLess(pixel_metadata["block-1-0-image"]["actual_dpi"], 300)
            self.assertTrue(pixel_metadata["block-1-0-image"]["pixel_cap_applied"])

    def test_visual_crop_environment_dpi_is_explicitly_bounded(self) -> None:
        self.assertEqual(_visual_crop_base_dpi("invalid"), 300)
        self.assertEqual(_visual_crop_base_dpi(72), 300)
        self.assertEqual(_visual_crop_base_dpi(450), 450)
        self.assertEqual(_visual_crop_base_dpi(1200), 600)
        with patch.dict(os.environ, {"MY_SCHOLAR_VISUAL_DPI": "not-an-integer"}):
            self.assertEqual(_visual_crop_base_dpi(), 300)

    def test_visual_budget_enforces_count_cumulative_pixels_and_actual_png_bytes(self) -> None:
        try:
            import fitz  # type: ignore
        except ImportError:
            self.skipTest("PyMuPDF is not installed")
        with tempfile.TemporaryDirectory(prefix="my-scholar-aggregate-crop-budget-") as temp:
            root = Path(temp)
            source = root / "source.pdf"
            document = fitz.open()
            document.new_page(width=400, height=400)
            document.save(source)
            document.close()
            pages = [[
                {"type": "image", "bbox": [10, 10, 110, 110]},
                {"type": "image", "bbox": [130, 10, 230, 110]},
            ]]

            count_budget = LayoutRenderBudget(max_visuals=1)
            count_metadata = {}
            count_crops = _render_pdf_visual_crops(
                source,
                pages,
                root / "count",
                dpi=72,
                target_width_px=1,
                max_dpi=72,
                metadata=count_metadata,
                budget=count_budget,
            )
            self.assertEqual(len(count_crops), 1)
            count_report = count_budget.report()
            count_output_bytes = sum(path.stat().st_size for path in (root / "count").glob("*.png"))
            self.assertEqual(count_report["usage"]["output_bytes"], count_output_bytes)
            self.assertEqual(count_report["fallbacks"]["by_reason"]["visual-count"], 1)
            self.assertTrue(count_metadata["block-1-1-image"]["fallback"])

            pixel_budget = LayoutRenderBudget(max_total_pixels=15_000)
            pixel_crops = _render_pdf_visual_crops(
                source,
                pages,
                root / "pixels",
                dpi=72,
                target_width_px=1,
                max_dpi=72,
                budget=pixel_budget,
            )
            self.assertEqual(len(pixel_crops), 1)
            pixel_report = pixel_budget.report()
            self.assertLessEqual(pixel_report["usage"]["pixels"], 15_000)
            self.assertEqual(pixel_report["fallbacks"]["by_reason"]["pixel-budget"], 1)

            byte_budget = LayoutRenderBudget(max_output_bytes=1)
            byte_crops = _render_pdf_visual_crops(
                source,
                [[pages[0][0]]],
                root / "bytes",
                dpi=72,
                target_width_px=1,
                max_dpi=72,
                budget=byte_budget,
            )
            byte_report = byte_budget.report()
            self.assertEqual(byte_crops, {})
            self.assertEqual(list((root / "bytes").glob("*.png")), [])
            self.assertGreater(byte_report["usage"]["encoded_png_bytes"], 1)
            self.assertEqual(byte_report["usage"]["output_bytes"], 0)
            self.assertEqual(byte_report["fallbacks"]["by_reason"]["output-bytes"], 1)

    def test_sidecar_count_and_bytes_share_the_job_budget_with_visual_crops(self) -> None:
        try:
            import fitz  # type: ignore
        except ImportError:
            self.skipTest("PyMuPDF is not installed")
        with tempfile.TemporaryDirectory(prefix="my-scholar-sidecar-budget-") as temp:
            root = Path(temp)
            sidecar = root / "paper_content_list_v2.json"
            sidecar.write_text("[]", encoding="utf-8")
            images = root / "images"
            images.mkdir()
            (images / "a.png").write_bytes(b"a" * 4)
            (images / "b.png").write_bytes(b"b" * 5)

            count_budget = LayoutRenderBudget(max_sidecar_files=1)
            count_mapping = _copy_sidecar_images(sidecar, root / "count", budget=count_budget)
            self.assertEqual(len(count_mapping), 1)
            self.assertEqual(count_budget.report()["fallbacks"]["by_reason"]["sidecar-count"], 1)

            byte_budget = LayoutRenderBudget(max_sidecar_bytes=6)
            byte_mapping = _copy_sidecar_images(sidecar, root / "sidecar-bytes", budget=byte_budget)
            self.assertEqual(len(byte_mapping), 1)
            copied_sidecar_bytes = (images / next(iter(byte_mapping))).stat().st_size
            self.assertEqual(byte_budget.report()["usage"]["sidecar_bytes"], copied_sidecar_bytes)
            self.assertLessEqual(copied_sidecar_bytes, 6)
            self.assertEqual(byte_budget.report()["fallbacks"]["by_reason"]["sidecar-bytes"], 1)

            source = root / "source.pdf"
            document = fitz.open()
            document.new_page(width=400, height=400)
            document.save(source)
            document.close()
            shared_budget = LayoutRenderBudget(max_operations=1)
            shared_mapping = _copy_sidecar_images(sidecar, root / "shared", budget=shared_budget)
            shared_crops = _render_pdf_visual_crops(
                source,
                [[{"type": "image", "bbox": [10, 10, 110, 110]}]],
                root / "shared",
                dpi=72,
                target_width_px=1,
                max_dpi=72,
                budget=shared_budget,
            )
            shared_report = shared_budget.report()
            self.assertEqual(len(shared_mapping), 1)
            self.assertEqual(shared_crops, {})
            self.assertEqual(shared_report["usage"]["operations"], 1)
            copied_output_bytes = (images / next(iter(shared_mapping))).stat().st_size
            self.assertEqual(shared_report["usage"]["output_bytes"], copied_output_bytes)
            self.assertGreaterEqual(shared_report["fallbacks"]["by_reason"]["operation-count"], 1)
            self.assertTrue(any(
                event["kind"] == "visual" and event["reason"] == "operation-count"
                for event in shared_report["fallbacks"]["events"]
            ))

            output_budget = LayoutRenderBudget(max_output_bytes=6)
            output_mapping = _copy_sidecar_images(sidecar, root / "shared-output", budget=output_budget)
            output_crops = _render_pdf_visual_crops(
                source,
                [[{"type": "image", "bbox": [10, 10, 110, 110]}]],
                root / "shared-output",
                dpi=72,
                target_width_px=1,
                max_dpi=72,
                budget=output_budget,
            )
            output_report = output_budget.report()
            copied_output_bytes = sum(
                (root / "shared-output" / Path(asset).name).stat().st_size
                for asset in output_mapping.values()
            )
            self.assertEqual(output_crops, {})
            self.assertEqual(output_report["usage"]["output_bytes"], copied_output_bytes)
            self.assertTrue(any(
                event["kind"] == "visual" and event["reason"] == "output-bytes"
                for event in output_report["fallbacks"]["events"]
            ))

    def test_visual_budget_uses_injected_clock_for_wall_time(self) -> None:
        class Clock:
            now = 0.0

            def __call__(self) -> float:
                return self.now

        clock = Clock()

        class FakeRect:
            def __init__(self, left: float, top: float, right: float, bottom: float) -> None:
                self.width = right - left
                self.height = bottom - top

            def __and__(self, _other):
                return self

        class FakePixmap:
            width = 100
            height = 100

            def tobytes(self, _kind: str) -> bytes:
                clock.now = 2.0
                return b"png-bytes"

        class FakePage:
            rect = FakeRect(0, 0, 400, 400)

            def get_pixmap(self, **_kwargs):
                return FakePixmap()

        class FakeDocument:
            def __len__(self) -> int:
                return 1

            def __getitem__(self, _index: int):
                return FakePage()

            def close(self) -> None:
                pass

        fake_fitz = types.SimpleNamespace(
            open=lambda _path: FakeDocument(),
            Matrix=lambda *_args: object(),
            Rect=FakeRect,
        )
        budget = LayoutRenderBudget(max_wall_seconds=1.0, clock=clock)
        with tempfile.TemporaryDirectory(prefix="my-scholar-wall-budget-") as temp:
            target = Path(temp) / "assets"
            with patch.dict(sys.modules, {"fitz": fake_fitz}):
                crops = _render_pdf_visual_crops(
                    Path(temp) / "source.pdf",
                    [[{"type": "image", "bbox": [10, 10, 110, 110]}]],
                    target,
                    dpi=72,
                    target_width_px=1,
                    max_dpi=72,
                    budget=budget,
                )
        self.assertEqual(crops, {})
        self.assertEqual(budget.report()["fallbacks"]["by_reason"]["wall-clock"], 1)

    def test_exhausted_job_budget_keeps_readable_output_and_quality_metadata(self) -> None:
        try:
            import fitz  # type: ignore
        except ImportError:
            self.skipTest("PyMuPDF is not installed")
        with tempfile.TemporaryDirectory(prefix="my-scholar-budget-document-") as temp:
            root = Path(temp)
            source = root / "paper.pdf"
            document = fitz.open()
            page = document.new_page(width=400, height=400)
            page.insert_text((20, 30), "Readable body remains available")
            document.save(source)
            document.close()
            sidecar = root / "paper_content_list_v2.json"
            sidecar.write_text(json.dumps([[
                {
                    "type": "paragraph",
                    "bbox": [10, 10, 380, 80],
                    "content": {"paragraph_content": "Readable body remains available after visual fallback."},
                },
                {
                    "type": "image",
                    "bbox": [20, 100, 220, 220],
                    "content": {
                        "image_caption": "Figure 1. Source fallback.",
                        "image_source": {"path": "images/figure.png"},
                    },
                },
            ]]), encoding="utf-8")
            images = root / "images"
            images.mkdir()
            (images / "figure.png").write_bytes(b"sidecar-image")
            output = root / "job"
            budget = LayoutRenderBudget(max_operations=1)
            with patch("layout_pipeline._find_layout_sidecar", return_value=(sidecar, "configured-sidecar")):
                manifest = process_layout_pdf(
                    source,
                    output,
                    job_id="budget1234567890",
                    source_name=source.name,
                    render_budget=budget,
                )
            self.assertIsNotNone(manifest)
            assert manifest is not None
            rendered = (output / "document.html").read_text(encoding="utf-8")
            metadata = json.loads((output / "document.json").read_text(encoding="utf-8"))
            validation = json.loads((output / "validation.json").read_text(encoding="utf-8"))
            self.assertIn("Readable body remains available", rendered)
            self.assertIn("assets/images/figure.png", rendered)
            self.assertEqual(metadata["render_budget"]["quality"], "fallback")
            self.assertEqual(metadata["render_budget"]["fallbacks"]["by_reason"]["operation-count"], 1)
            visual = next(iter(manifest["assets"]["visuals"].values()))
            self.assertTrue(visual["fallback"])
            self.assertEqual(visual["fallback_reason"], "operation-count")
            self.assertEqual(manifest["quality"]["render_budget"], "fallback")
            self.assertEqual(validation["status"], "REVIEW")

    def test_pdf_visual_crop_render_failure_leaves_source_fallback_available(self) -> None:
        class FakeRect:
            def __init__(self, left: float, top: float, right: float, bottom: float) -> None:
                self.width = right - left
                self.height = bottom - top

            def __and__(self, _other):
                return self

        class FakePage:
            rect = FakeRect(0, 0, 600, 600)

            def get_pixmap(self, **_kwargs):
                raise RuntimeError("render failed")

        class FakeDocument:
            def __len__(self) -> int:
                return 1

            def __getitem__(self, _index: int):
                return FakePage()

            def close(self) -> None:
                pass

        fake_fitz = types.SimpleNamespace(
            open=lambda _path: FakeDocument(),
            Matrix=lambda *_args: object(),
            Rect=FakeRect,
        )
        with tempfile.TemporaryDirectory(prefix="my-scholar-crop-failure-") as temp:
            crop_metadata = {}
            with patch.dict(sys.modules, {"fitz": fake_fitz}):
                crops = _render_pdf_visual_crops(
                    Path(temp) / "source.pdf",
                    [[{"type": "image", "bbox": [20, 20, 260, 120]}]],
                    Path(temp) / "assets" / "images",
                    metadata=crop_metadata,
                )
            self.assertEqual(crops, {})
            self.assertTrue(crop_metadata["block-1-0-image"]["fallback"])
            self.assertEqual(crop_metadata["block-1-0-image"]["fallback_reason"], "render-error")

    def test_legacy_inline_tex_is_normalized_before_mathml(self) -> None:
        renderer = MathRenderer()
        if not renderer.pandoc:
            self.skipTest("Pandoc is not installed in this environment")
        tex = r"\begin{array} { r } { \sum _ { k = 1 } ^ { K } \frac { 1 } { K } \cdot P _ { k } ( { \bf x } ) } \end{array}"
        html = renderer.render(tex, display=False)
        self.assertIn("<math", html)
        self.assertNotIn("math-fallback", html)
        self.assertEqual(renderer.mode(tex, display=False), "mathml")

    def test_caption_segments_render_inline_math(self) -> None:
        from layout_pipeline import _caption_html

        renderer = MathRenderer()
        if not renderer.pandoc:
            self.skipTest("Pandoc is not installed in this environment")
        content = {
            "table_caption": [
                {"type": "text", "content": "Table 9: queries "},
                {"type": "equation_inline", "content": r"q _ { 1 } , \ldots q _ { m }"},
                {"type": "text", "content": " and averaging."},
            ]
        }
        rendered = _caption_html(content, "table_caption", renderer)
        self.assertIn("Table 9: queries ", rendered)
        self.assertIn("<math", rendered)
        self.assertIn('data-tex="', rendered)
        self.assertIn(" and averaging.", rendered)
        visible = re.sub(r'\sdata-tex="[^"]*"', "", rendered)
        visible = re.sub(r"<annotation.*?</annotation>", "", visible, flags=re.S)
        self.assertNotIn(r"\ldots", visible)

    def test_caption_inline_marker_uses_fixed_accessible_allowlisted_markup(self) -> None:
        from layout_pipeline import _caption_html

        renderer = MathRenderer()
        content = {
            "image_caption": [
                {"type": "text", "content": "Figure 2. "},
                {
                    "type": "inline_marker",
                    "shape": "circle",
                    "style": "line-marker",
                    "tone": "gray",
                    "label": 'ignored\" onmouseover=\"alert(1)',
                },
                {"type": "text", "content": " indicates layer distance."},
                {
                    "type": "inline_marker",
                    "shape": "triangle",
                    "style": "position:absolute",
                    "tone": "red",
                },
            ]
        }

        rendered = _caption_html(content, "image_caption", renderer)
        self.assertIn('class="inline-legend-marker inline-legend-marker-circle inline-legend-marker-gray"', rendered)
        self.assertIn('role="img"', rendered)
        self.assertIn('aria-label="line with circle marker"', rendered)
        self.assertNotIn("onmouseover", rendered)
        self.assertNotIn("triangle", rendered)
        self.assertNotIn("position:absolute", rendered)

    def test_paragraph_inline_markers_render_all_fixed_tones_without_raw_style_data(self) -> None:
        tones = ("gray", "blue", "orange", "green", "red", "purple", "pink")
        pieces = [{"type": "text", "content": "Legend: "}]
        for tone in tones:
            pieces.extend([
                {
                    "type": "inline_marker",
                    "shape": "circle",
                    "style": "line-marker",
                    "tone": tone,
                    "source_rgb": [0.1, 0.2, 0.3],
                    "class": 'unsafe\" onmouseover=\"alert(1)',
                },
                {"type": "text", "content": f" {tone} "},
            ])
        pieces.append({
            "type": "inline_marker",
            "shape": "square",
            "style": "line-marker",
            "tone": "chartreuse",
        })
        item = {"content": {"paragraph_content": pieces}}

        rendered, _, _, _, markdown = _paragraph_html(item, MathRenderer(), BuildState())

        for tone in tones:
            self.assertIn(f"inline-legend-marker-{tone}", rendered)
        self.assertEqual(rendered.count('role="img"'), len(tones))
        self.assertNotIn("source_rgb", rendered)
        self.assertNotIn("onmouseover", rendered)
        self.assertNotIn("chartreuse", rendered)
        self.assertEqual(markdown.count("—●"), len(tones))

    def test_parenthesized_paragraph_marker_stays_inside_slot(self) -> None:
        item = {"content": {"paragraph_content": [
            {"type": "text", "content": "final feature distances ("},
            {
                "type": "inline_marker",
                "shape": "square",
                "style": "line-marker",
                "tone": "blue",
                "source_rgb": [0.3412, 0.7059, 0.9137],
            },
            {"type": "text", "content": ") at shallow positions"},
        ]}}

        rendered, _, _, _, markdown = _paragraph_html(item, MathRenderer(), BuildState())

        self.assertIn('distances (<span class="inline-legend-marker inline-legend-marker-square inline-legend-marker-blue"', rendered)
        self.assertIn('</span>) at shallow positions', rendered)
        self.assertIn("(—■)", markdown)
        self.assertNotIn("source_rgb", rendered)

    def test_multicolumn_array_and_hphantom_render_as_mathml(self) -> None:
        renderer = MathRenderer()
        if not renderer.pandoc:
            self.skipTest("Pandoc is not installed in this environment")
        # MinerU spaces the array column spec and uses \hphantom; Pandoc 2.x
        # rejects both forms unless they are normalized first.
        tex = (
            r"\begin{array} { r l } & { v _ { \mathrm { c r o s s } } ( \mathbf { z } ) } \\ "
            r"& { \sum _ { j , \hphantom { ( } 1 ) } ^ { J } x } \end{array}"
        )
        html = renderer.render(tex, display=True)
        self.assertIn("<math", html)
        self.assertNotIn("math-fallback", html)
        self.assertEqual(renderer.mode(tex, display=True), "mathml")


    def test_one_llm_layout_fixture_regression(self) -> None:
        pdf = Path(os.environ.get("MY_SCHOLAR_ONELLM_PDF", ""))
        sidecar = Path(os.environ.get("MY_SCHOLAR_ONELLM_SIDECAR", ""))
        if not (pdf.is_file() and sidecar.is_file()):
            self.skipTest("set MY_SCHOLAR_ONELLM_PDF and MY_SCHOLAR_ONELLM_SIDECAR to run the golden fixture")
        with tempfile.TemporaryDirectory(prefix="my-scholar-layout-test-") as temp:
            out = Path(temp) / "job"
            manifest = process_layout_pdf(pdf, out, job_id="fixture12345678", source_name=pdf.name)
            self.assertIsNotNone(manifest)
            assert manifest is not None
            self.assertEqual(manifest["counts"]["pages"], 12)
            self.assertEqual(manifest["counts"]["images"], 3)
            self.assertEqual(manifest["counts"]["tables"], 7)
            self.assertEqual(manifest["counts"]["display_formulas"], 2)
            validation = json.loads((out / "validation.json").read_text())
            self.assertIn(validation["status"], {"PASS", "REVIEW"})
            self.assertEqual(validation["missing_assets"], [])
            self.assertGreaterEqual(validation["checks"]["tables_needing_review"], 1)
            self.assertEqual(validation["checks"]["table_display_mode"], "source-crop-only")
            self.assertEqual(validation["checks"]["table_images"], 7)
            self.assertEqual(validation["checks"]["semantic_tables"], 0)
            self.assertTrue(validation["checks"]["cross_reference_links_resolved"])
            self.assertFalse(validation["checks"]["visible_page_fallback"])
            self.assertFalse(validation["checks"]["visible_formula_crops"])
            self.assertIn("appendix_pages", validation["checks"])
            self.assertIn("reference_pages", validation["checks"])
            self.assertTrue(validation["checks"]["reference_pages"])
            document_html = (out / "document.html").read_text()
            self.assertGreaterEqual(document_html.count("<math "), 20)
            self.assertNotIn('class="math-inline math-fallback"', document_html)
            self.assertRegex(document_html, r'<figure class="pdf-table table-image-only"')
            self.assertNotIn('table-review-badge', document_html)
            self.assertNotIn('class="pdf-table table-image-only needs-review"', document_html)
            self.assertEqual(document_html.count('class="table-source-primary table-image-only"'), 7)
            self.assertNotIn("<table", document_html)
            self.assertIn('id="table-1"', document_html)
            self.assertIn('href="#table-1"', document_html)
            self.assertIn('data-section-kind="references"', document_html)
            self.assertIn('data-translate-block-id="block-3-0-image"', document_html)
            self.assertIn('data-translate-block-id="block-6-0-table"', document_html)
            self.assertIn('.references{list-style:none;padding-left:0}', document_html)
            figure_crop = out / "assets" / "images" / "pdf-block-3-0-image@300.png"
            table_crop = out / "assets" / "images" / "pdf-block-6-0-table@300.png"
            self.assertTrue(figure_crop.is_file())
            self.assertTrue(table_crop.is_file())
            try:
                import fitz  # type: ignore
                # The crop is rendered from the source PDF at 300 DPI.  The
                # corrected normalized-bbox mapping yields ~1.96k px for
                # Figure 2 (the exact width depends on the PDF clip), which
                # is still substantially above the old 1.3k MinerU raster.
                self.assertGreaterEqual(fitz.Pixmap(figure_crop).width, 1_800)
                self.assertGreaterEqual(fitz.Pixmap(table_crop).width, 2_000)
            except ImportError:
                self.skipTest("PyMuPDF is not installed")
            self.assertNotIn('class="reader-nav"', document_html)
            self.assertNotIn('class="page-source"', document_html)
            self.assertNotIn('class="source-crop"', document_html)
            self.assertNotIn("查看原始页面", document_html)
            self.assertNotIn("查看原始公式裁剪", document_html)
            self.assertFalse((out / "document.md").exists())
