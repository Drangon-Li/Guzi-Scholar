import json
import builtins
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from pipeline import _make_document_html, process_pdf, resolve_jar, validate_document  # noqa: E402
import layout_pipeline  # noqa: E402


class PipelineHelpersTest(unittest.TestCase):
    def test_resolve_jar_keeps_legacy_in_repo_toolchain(self):
        with tempfile.TemporaryDirectory() as temp:
            repository = Path(temp) / "my-scholar"
            project_root = repository / "macos"
            jar = repository / "opendataloader-pdf/java/opendataloader-pdf-cli/target/opendataloader-pdf-cli-0.0.0.jar"
            project_root.mkdir(parents=True)
            jar.parent.mkdir(parents=True)
            jar.touch()
            with patch("pipeline.PROJECT_ROOT", project_root), patch.dict(
                os.environ,
                {"MY_SCHOLAR_ODL_JAR": "", "MY_SCHOLAR_TOOLCHAIN_ROOT": ""},
            ):
                self.assertEqual(resolve_jar(), jar.resolve())

    def test_resolve_jar_supports_migrated_sibling_toolchain(self):
        with tempfile.TemporaryDirectory() as temp:
            workspace = Path(temp)
            project_root = workspace / "my-scholar" / "macos"
            jar = workspace / "opendataloader-pdf/java/opendataloader-pdf-cli/target/opendataloader-pdf-cli-0.0.0.jar"
            project_root.mkdir(parents=True)
            jar.parent.mkdir(parents=True)
            jar.touch()
            with patch("pipeline.PROJECT_ROOT", project_root), patch.dict(
                os.environ,
                {"MY_SCHOLAR_ODL_JAR": "", "MY_SCHOLAR_TOOLCHAIN_ROOT": ""},
            ):
                self.assertEqual(resolve_jar(), jar.resolve())

    def test_resolve_jar_keeps_direct_environment_override(self):
        with tempfile.TemporaryDirectory() as temp:
            jar = Path(temp) / "custom.jar"
            jar.touch()
            with patch.dict(os.environ, {"MY_SCHOLAR_ODL_JAR": str(jar)}):
                self.assertEqual(resolve_jar(), jar.resolve())

    def test_page_sections_and_asset_rewrite(self):
        raw = """<html><body>&lt;!-- page: 1 --&gt;<h1>Title</h1><img src=\"paper_images/imageFile1.png\"><!-- page: 2 --><table><tr><td>A</td></tr></table></body></html>"""
        result, pages = _make_document_html("paper.pdf", raw)
        self.assertEqual(pages, [1, 2])
        self.assertIn('id="page-1"', result)
        self.assertIn('assets/images/imageFile1.png', result)
        self.assertIn('class="extracted-table"', result)
        # The ODL fallback must match the immersive reader: page anchors stay
        # available, but the old visible "Pages" navigation is not rendered.
        self.assertNotIn('class="reader-nav"', result)

    def test_validation_flags_missing_asset_and_empty_table(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            html_path = root / "document.html"
            html_path.write_text('<section class="pdf-page"><img src="assets/images/missing.png"><table><tr><td></td></tr><tr><td></td></tr></table></section>', encoding="utf-8")
            result = validate_document(html_path, root / "assets" / "images", 1, 1)
            self.assertEqual(result["status"], "REVIEW")
            self.assertTrue(result["missing_assets"])
            self.assertTrue(result["table_reviews"])

    def test_auto_backend_rejects_corrupt_layout_candidate_and_promotes_odl(self):
        def fake_layout(_pdf_path, candidate_dir, **_kwargs):
            candidate_dir = Path(candidate_dir)
            candidate_dir.mkdir(parents=True, exist_ok=True)
            (candidate_dir / "layout-marker.txt").write_text("layout", encoding="utf-8")
            (candidate_dir / "document.json").write_text(json.dumps({
                "semantic_validation": {
                    "status": "FAIL",
                    "issues": ["pathological-script-markup"],
                    "hard_failures": ["pathological-script-markup"],
                    "text_quality": {"script_runs": 120, "script_run_ratio": 0.12},
                },
            }), encoding="utf-8")
            return {"engine": {"name": "MinerU local pipeline"}, "outputs": []}

        def fake_odl(_pdf_path, candidate_dir, **_kwargs):
            candidate_dir = Path(candidate_dir)
            candidate_dir.mkdir(parents=True, exist_ok=True)
            (candidate_dir / "odl-marker.txt").write_text("odl", encoding="utf-8")
            (candidate_dir / "document.json").write_text(json.dumps({
                "semantic_validation": {"status": "PASS", "issues": [], "hard_failures": []},
            }), encoding="utf-8")
            (candidate_dir / "validation.json").write_text(json.dumps({"status": "PASS", "warnings": []}), encoding="utf-8")
            (candidate_dir / "manifest.json").write_text("{}", encoding="utf-8")
            return {"engine": {"name": "OpenDataLoader PDF CLI"}, "outputs": ["document.json", "validation.json"]}

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "paper.pdf"
            source.write_bytes(b"%PDF-fixture")
            job_dir = root / "job"
            with patch.dict(os.environ, {"MY_SCHOLAR_BACKEND": "auto"}), patch(
                "layout_pipeline.process_layout_pdf", side_effect=fake_layout,
            ), patch("pipeline._process_pdf_odl", side_effect=fake_odl):
                manifest = process_pdf(source, job_dir, job_id="fixture", source_name="paper.pdf")

            self.assertTrue((job_dir / "odl-marker.txt").is_file())
            self.assertFalse((job_dir / "layout-marker.txt").exists())
            self.assertEqual(manifest["backend_selection"]["reason"], "semantic-quality-gate")
            selection = json.loads((job_dir / "backend-selection.json").read_text(encoding="utf-8"))
            self.assertEqual(selection["hard_failures"], ["pathological-script-markup"])

    def test_layout_cancellation_propagates_without_fallback_or_error_log(self):
        for backend in ("auto", "layout"):
            with self.subTest(backend=backend), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                source = root / "paper.pdf"
                source.write_bytes(b"%PDF-fixture")
                job_dir = root / "job"
                cancelled = layout_pipeline.LayoutPipelineCancelled("cancelled")
                with (
                    patch("layout_pipeline.process_layout_pdf", side_effect=cancelled),
                    patch("pipeline._preserve_layout_transcript") as preserve,
                    patch("pipeline._process_pdf_odl") as odl,
                ):
                    with self.assertRaises(layout_pipeline.LayoutPipelineCancelled) as raised:
                        process_pdf(source, job_dir, job_id="fixture", source_name="paper.pdf", backend_override=backend)

                self.assertIs(raised.exception, cancelled)
                preserve.assert_not_called()
                odl.assert_not_called()
                self.assertFalse((job_dir / "layout-error.log").exists())
                self.assertFalse((job_dir / "backend-selection.json").exists())

    def test_auto_backend_falls_back_when_layout_import_fails(self):
        original_import = builtins.__import__

        def import_without_layout(name, *args, **kwargs):
            if name == "layout_pipeline":
                raise ImportError("missing optional layout dependency")
            return original_import(name, *args, **kwargs)

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "paper.pdf"
            source.write_bytes(b"%PDF-fixture")
            job_dir = root / "job"
            with (
                patch("builtins.__import__", side_effect=import_without_layout),
                patch("pipeline._process_pdf_odl", return_value={"outputs": []}) as odl,
            ):
                manifest = process_pdf(source, job_dir, job_id="fixture", source_name="paper.pdf", backend_override="auto")

            odl.assert_called_once()
            self.assertEqual(manifest["backend_selection"]["reason"], "layout-error")
            self.assertIn("ImportError", manifest["backend_selection"]["error"])

    def test_auto_backend_promotes_healthy_layout_without_running_odl(self):
        def fake_layout(_pdf_path, candidate_dir, **_kwargs):
            candidate_dir = Path(candidate_dir)
            candidate_dir.mkdir(parents=True, exist_ok=True)
            (candidate_dir / "layout-marker.txt").write_text("layout", encoding="utf-8")
            (candidate_dir / "document.json").write_text(json.dumps({
                "semantic_validation": {"status": "PASS", "issues": [], "hard_failures": []},
                "layout_source": str(candidate_dir / "layout" / "source.json"),
            }), encoding="utf-8")
            return {
                "engine": {"name": "MinerU local pipeline", "layout": str(candidate_dir / "layout" / "source.json")},
                "outputs": ["document.json"],
            }

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "paper.pdf"
            source.write_bytes(b"%PDF-fixture")
            job_dir = root / "job"
            with patch.dict(os.environ, {"MY_SCHOLAR_BACKEND": "auto"}), patch(
                "layout_pipeline.process_layout_pdf", side_effect=fake_layout,
            ), patch("pipeline._process_pdf_odl") as odl:
                manifest = process_pdf(source, job_dir, job_id="fixture", source_name="paper.pdf")

            odl.assert_not_called()
            self.assertTrue((job_dir / "layout-marker.txt").is_file())
            self.assertEqual(manifest["engine"]["name"], "MinerU local pipeline")
            self.assertTrue(manifest["engine"]["layout"].startswith(str(job_dir.resolve())))
            document = json.loads((job_dir / "document.json").read_text(encoding="utf-8"))
            self.assertTrue(document["layout_source"].startswith(str(job_dir.resolve())))
            self.assertFalse((job_dir / "backend-selection.json").exists())

    def test_strict_fresh_layout_is_parameter_scoped_and_does_not_mutate_environment(self):
        original_finder = layout_pipeline._find_layout_sidecar
        fresh_executable = Path("/private/tmp/fresh-mineru")

        def fake_layout(_pdf_path, candidate_dir, **kwargs):
            self.assertEqual(kwargs["layout_source"], (fresh_executable, "mineru-executable"))
            candidate_dir = Path(candidate_dir)
            candidate_dir.mkdir(parents=True, exist_ok=True)
            (candidate_dir / "document.json").write_text(json.dumps({
                "semantic_validation": {"status": "PASS", "issues": [], "hard_failures": []},
            }), encoding="utf-8")
            return {"engine": {"name": "MinerU local pipeline"}, "outputs": ["document.json"]}

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "paper.pdf"
            source.write_bytes(b"%PDF-fixture")
            with (
                patch.dict(os.environ, {"MY_SCHOLAR_BACKEND": "odl"}),
                patch("pipeline._fresh_layout_backend", return_value=(fresh_executable, "mineru-executable")) as fresh,
                patch("layout_pipeline.process_layout_pdf", side_effect=fake_layout),
                patch("pipeline._process_pdf_odl") as odl,
            ):
                process_pdf(
                    source,
                    root / "job",
                    job_id="fixture",
                    source_name="paper.pdf",
                    backend_override="layout",
                    refresh_layout_sidecar=True,
                )
                self.assertEqual(os.environ["MY_SCHOLAR_BACKEND"], "odl")

        fresh.assert_called_once()
        odl.assert_not_called()
        self.assertIs(layout_pipeline._find_layout_sidecar, original_finder)

if __name__ == "__main__":
    unittest.main()
