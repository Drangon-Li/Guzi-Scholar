"""Cover the MinerU wall-clock budget and the transcript a failure leaves behind.

A flat 900s cap killed a 65-page paper at 78% of its Predict bar while a
23-page one finished in 820s on the same machine: the budget has to follow the
document. The transcript matters for the same incident -- it was written inside
the attempt directory that the failure path deletes, so the run that could have
explained itself was the one whose log was thrown away.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import layout_pipeline  # noqa: E402
import pipeline as pipeline_module  # noqa: E402
import server as server_module  # noqa: E402


class MineruTimeoutBudgetTest(unittest.TestCase):
    def test_short_documents_keep_the_previous_budget(self) -> None:
        # The floor is what makes this change incapable of shortening a run.
        for pages in (1, 10, 24):
            self.assertEqual(
                layout_pipeline.mineru_timeout_seconds(pages),
                layout_pipeline.MINERU_TIMEOUT_FLOOR_SECONDS,
            )

    def test_the_budget_grows_once_the_page_count_earns_it(self) -> None:
        self.assertEqual(layout_pipeline.mineru_timeout_seconds(25), 925)
        self.assertEqual(layout_pipeline.mineru_timeout_seconds(65), 1925)

    def test_the_reported_failure_would_now_have_room(self) -> None:
        # The 65-page run reached 78% of Predict at 900s, so it needed roughly
        # 1150s of Predict plus setup and post-processing.
        self.assertGreater(layout_pipeline.mineru_timeout_seconds(65), 1400)

    def test_a_long_document_is_capped(self) -> None:
        self.assertEqual(
            layout_pipeline.mineru_timeout_seconds(5000),
            layout_pipeline.MINERU_TIMEOUT_CEILING_SECONDS,
        )

    def test_an_unreadable_page_count_falls_back_to_the_floor(self) -> None:
        # _page_count() returns 1 for anything it cannot open.
        self.assertEqual(
            layout_pipeline.mineru_timeout_seconds(None),
            layout_pipeline.MINERU_TIMEOUT_FLOOR_SECONDS,
        )

    def test_the_environment_override_still_wins(self) -> None:
        with patch.dict("os.environ", {"MY_SCHOLAR_MINERU_TIMEOUT": "2400"}):
            self.assertEqual(layout_pipeline.mineru_timeout_seconds(65), 2400)
            self.assertEqual(layout_pipeline.mineru_timeout_seconds(1), 2400)

    def test_an_unusable_override_does_not_kill_the_run(self) -> None:
        with patch.dict("os.environ", {"MY_SCHOLAR_MINERU_TIMEOUT": "soon"}):
            self.assertEqual(layout_pipeline.mineru_timeout_seconds(65), 1925)


class MineruReportedPagesTest(unittest.TestCase):
    """PyMuPDF is absent from the packaged runtime, so _page_count() reports 1
    there and the budget would silently sit on its floor. These are the lines
    MinerU actually prints, taken from real run logs."""

    def test_the_client_batch_line(self) -> None:
        line = (
            "2026-08-26 11:59:14.798 | INFO | mineru.cli.client:run_planned_task:832 - "
            "Submitting batch 1/1 | 1 document, 65 pages in this batch | 65 pages total | task#1 [source]"
        )
        self.assertEqual(layout_pipeline._mineru_reported_pages(line), 65)

    def test_the_pipeline_window_line(self) -> None:
        line = "... - Pipeline processing-window multi-file run. doc_count=1, total_pages=65, window_size=64"
        self.assertEqual(layout_pipeline._mineru_reported_pages(line), 65)

    def test_the_hybrid_window_line(self) -> None:
        line = "... - Hybrid processing-window run. page_count=23, window_size=64, total_windows=1"
        self.assertEqual(layout_pipeline._mineru_reported_pages(line), 23)

    def test_a_progress_bar_is_not_a_page_count(self) -> None:
        self.assertIsNone(
            layout_pipeline._mineru_reported_pages("Layout Predict:  50%|#####| 32/64 [00:04<00:04, 7.85it/s]")
        )

    def test_a_page_count_free_line_reports_nothing(self) -> None:
        self.assertIsNone(layout_pipeline._mineru_reported_pages("INFO: Application startup complete."))


class MineruTimeoutMessageTest(unittest.TestCase):
    def test_the_message_names_the_limit_and_where_the_run_stopped(self) -> None:
        monitor = layout_pipeline._MineruOutputMonitor(None, None)
        monitor._latest = ("Predict", 57, 73)
        message = layout_pipeline._mineru_timeout_message(1925, monitor)
        self.assertIn("32 分钟", message)
        self.assertIn("AI 深度解析 57/73", message)
        self.assertIn("78%", message)
        self.assertIn("MY_SCHOLAR_MINERU_TIMEOUT", message)
        self.assertIn("pipeline", message)

    def test_a_silent_run_says_so_rather_than_inventing_progress(self) -> None:
        monitor = layout_pipeline._MineruOutputMonitor(None, None)
        message = layout_pipeline._mineru_timeout_message(900, monitor)
        self.assertIn("没有收到任何进度", message)
        self.assertIn("15 分钟", message)

    def test_the_message_survives_the_stored_error_truncation(self) -> None:
        monitor = layout_pipeline._MineruOutputMonitor(None, None)
        monitor._latest = ("Predict", 57, 73)
        self.assertLess(len(layout_pipeline._mineru_timeout_message(1925, monitor)), 500)

    def test_progress_summary_is_none_before_any_bar_appears(self) -> None:
        monitor = layout_pipeline._MineruOutputMonitor(None, None)
        self.assertIsNone(monitor.progress_summary())

    def test_progress_summary_uses_the_reader_facing_stage_name(self) -> None:
        monitor = layout_pipeline._MineruOutputMonitor(None, None)
        monitor._latest = ("Layout Predict", 32, 64)
        self.assertEqual(monitor.progress_summary(), "版面检测 32/64（50%）")

    def test_an_unmapped_bar_keeps_its_own_name(self) -> None:
        monitor = layout_pipeline._MineruOutputMonitor(None, None)
        monitor._latest = ("Something New", 1, 4)
        self.assertEqual(monitor.progress_summary(), "Something New 1/4（25%）")


class _StalledRun:
    """A MinerU process that has printed a progress bar and will not finish."""

    def __init__(self, transcript: bytes) -> None:
        read_fd, write_fd = os.pipe()
        os.write(write_fd, transcript)
        # Closed so the reader thread sees EOF and the transcript is complete
        # before the deadline expires; the process itself still never exits.
        os.close(write_fd)
        self.stdout = os.fdopen(read_fd, "rb")
        self.pid = -1

    def poll(self) -> None:
        return None

    def wait(self, timeout: float | None = None) -> int:
        return 0


class MineruTimeoutRaiseSiteTest(unittest.TestCase):
    """The raise site, not just the message builder it is supposed to call."""

    def _time_out(self, transcript: bytes) -> str:
        with tempfile.TemporaryDirectory(prefix="my-scholar-mineru-timeout-") as temp:
            output = Path(temp) / "layout"
            pdf = Path(temp) / "source.pdf"
            pdf.write_bytes(b"%PDF-1.4\n")
            with patch.object(layout_pipeline.subprocess, "Popen", return_value=_StalledRun(transcript)), \
                    patch.object(layout_pipeline.os, "killpg"), \
                    patch.object(layout_pipeline, "mineru_timeout_seconds", return_value=1):
                with self.assertRaises(layout_pipeline.LayoutPipelineError) as caught:
                    layout_pipeline._run_mineru(Path("/nonexistent/mineru"), pdf, output)
            # The transcript is kept for the caller to preserve.
            self.assertIn("57/73", (output / "mineru.log").read_text(encoding="utf-8"))
            return str(caught.exception)

    def test_the_timeout_reports_the_limit_and_the_last_bar(self) -> None:
        message = self._time_out(b"Predict:  78%|#######   | 57/73 [12:00<03:00, 22.33s/it]\r")
        self.assertIn("MinerU 运行超时", message)
        self.assertIn("AI 深度解析 57/73", message)
        self.assertIn("MY_SCHOLAR_MINERU_TIMEOUT", message)

    def test_the_budget_is_asked_for_rather_than_hard_coded(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-mineru-budget-") as temp:
            pdf = Path(temp) / "source.pdf"
            pdf.write_bytes(b"%PDF-1.4\n")
            budget = MagicMock(return_value=1)
            with patch.object(layout_pipeline.subprocess, "Popen", return_value=_StalledRun(b"")), \
                    patch.object(layout_pipeline.os, "killpg"), \
                    patch.object(layout_pipeline, "mineru_timeout_seconds", budget):
                with self.assertRaises(layout_pipeline.LayoutPipelineError):
                    layout_pipeline._run_mineru(Path("/nonexistent/mineru"), pdf, Path(temp) / "layout")
            budget.assert_called_once()


class BudgetFollowsMineruReportTest(unittest.TestCase):
    """The regression that shipped: the budget collapsed to its floor because
    the packaged runtime has no PyMuPDF, so a 65-page paper was killed at a
    15-minute limit the message then reported truthfully."""

    def _budgets_requested(self, transcript: bytes) -> list:
        seen = []

        def budget(pages):
            seen.append(pages)
            return 1

        with tempfile.TemporaryDirectory(prefix="my-scholar-budget-") as temp:
            pdf = Path(temp) / "source.pdf"
            pdf.write_bytes(b"%PDF-1.4\n")
            with patch.object(layout_pipeline.subprocess, "Popen", return_value=_StalledRun(transcript)), \
                    patch.object(layout_pipeline.os, "killpg"), \
                    patch.object(layout_pipeline, "mineru_timeout_seconds", budget):
                with self.assertRaises(layout_pipeline.LayoutPipelineError):
                    layout_pipeline._run_mineru(Path("/nonexistent/mineru"), pdf, Path(temp) / "layout")
        return seen

    def test_the_page_count_mineru_reports_reaches_the_budget(self) -> None:
        seen = self._budgets_requested(
            b"Submitting batch 1/1 | 1 document, 65 pages in this batch | 65 pages total | task#1\n"
            b"Predict:  10%|#         | 5/54 [01:00<09:00, 11.0s/it]\r"
        )
        self.assertIn(65, seen, f"the reported page count never reached the budget; saw {seen}")

    def test_a_silent_run_falls_back_to_the_local_count(self) -> None:
        # No page line: only the _page_count() result is ever asked for.
        seen = self._budgets_requested(b"INFO: Application startup complete.\n")
        self.assertEqual(set(seen), {1}, f"unexpected budget inputs {seen}")


class LayoutTranscriptSurvivesCandidateTest(unittest.TestCase):
    """process_pdf() runs layout inside a TemporaryDirectory it promotes only on
    success, so the transcript has to be copied out before the failure unwinds."""

    def _fail_layout(self, job_dir: Path, write_log: bool):
        def fake(pdf_path, candidate_dir, **kwargs):
            if write_log:
                layout = Path(candidate_dir) / "layout"
                layout.mkdir(parents=True, exist_ok=True)
                (layout / "mineru.log").write_text("Predict: 80%|...| 43/54", encoding="utf-8")
            raise layout_pipeline.LayoutPipelineError("MinerU 运行超时：已达到 32 分钟上限")

        with patch.object(pipeline_module, "_process_layout_candidate", side_effect=fake):
            with self.assertRaises(pipeline_module.PipelineError):
                pipeline_module.process_pdf(
                    job_dir.parent / "input.pdf",
                    job_dir,
                    job_id="testjob",
                    source_name="paper.pdf",
                    backend_override="layout",
                )

    def test_the_transcript_lands_where_a_successful_run_would_have_put_it(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-layout-fail-") as temp:
            job_dir = Path(temp) / "attempt"
            job_dir.mkdir()
            (Path(temp) / "input.pdf").write_bytes(b"%PDF-1.4\n")
            self._fail_layout(job_dir, write_log=True)
            kept = job_dir / "layout" / "mineru.log"
            self.assertTrue(kept.is_file(), "the candidate directory took the transcript with it")
            self.assertIn("43/54", kept.read_text(encoding="utf-8"))

    def test_a_run_that_produced_no_transcript_still_fails_cleanly(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-layout-fail-") as temp:
            job_dir = Path(temp) / "attempt"
            job_dir.mkdir()
            (Path(temp) / "input.pdf").write_bytes(b"%PDF-1.4\n")
            self._fail_layout(job_dir, write_log=False)
            self.assertFalse((job_dir / "layout" / "mineru.log").exists())

    def test_a_cancellation_leaves_no_transcript(self) -> None:
        def fake(pdf_path, candidate_dir, **kwargs):
            layout = Path(candidate_dir) / "layout"
            layout.mkdir(parents=True, exist_ok=True)
            (layout / "mineru.log").write_text("partial", encoding="utf-8")
            raise layout_pipeline.LayoutPipelineCancelled("AI 重排已取消。")

        with tempfile.TemporaryDirectory(prefix="my-scholar-layout-cancel-") as temp:
            job_dir = Path(temp) / "attempt"
            job_dir.mkdir()
            (Path(temp) / "input.pdf").write_bytes(b"%PDF-1.4\n")
            with patch.object(pipeline_module, "_process_layout_candidate", side_effect=fake):
                # The outer handler converts it, since the cancellation type
                # subclasses LayoutPipelineError.
                with self.assertRaises(pipeline_module.PipelineError):
                    pipeline_module.process_pdf(
                        Path(temp) / "input.pdf", job_dir,
                        job_id="testjob", source_name="paper.pdf", backend_override="layout",
                    )
            self.assertFalse((job_dir / "layout" / "mineru.log").exists())


class PreserveLayoutErrorLogTest(unittest.TestCase):
    def _attempt(self, renders: Path, transcript: str, generation: int = 5) -> Path:
        attempt = renders / f".{generation}-abc.tmp"
        (attempt / "layout").mkdir(parents=True)
        (attempt / "layout" / "mineru.log").write_text(transcript, encoding="utf-8")
        return attempt

    def test_the_transcript_outlives_the_attempt_directory(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-reflow-log-") as temp:
            renders = Path(temp) / "renders"
            renders.mkdir()
            attempt = self._attempt(renders, "Predict: 78%|...| 57/73")
            kept = server_module._preserve_layout_error_log(attempt, renders, 5)
            self.assertEqual(kept, renders / "layout-error-5.log")
            self.assertIn("57/73", kept.read_text(encoding="utf-8"))

    def test_a_missing_transcript_is_not_an_error(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-reflow-log-") as temp:
            renders = Path(temp) / "renders"
            renders.mkdir()
            attempt = renders / ".5-abc.tmp"
            attempt.mkdir()
            self.assertIsNone(server_module._preserve_layout_error_log(attempt, renders, 5))

    def test_an_empty_transcript_is_not_kept(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-reflow-log-") as temp:
            renders = Path(temp) / "renders"
            renders.mkdir()
            attempt = self._attempt(renders, "")
            self.assertIsNone(server_module._preserve_layout_error_log(attempt, renders, 5))

    def test_each_failed_generation_keeps_its_own_log(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-reflow-log-") as temp:
            renders = Path(temp) / "renders"
            renders.mkdir()
            for generation in (4, 5):
                attempt = self._attempt(renders, f"run {generation}", generation)
                server_module._preserve_layout_error_log(attempt, renders, generation)
            self.assertEqual((renders / "layout-error-4.log").read_text(encoding="utf-8"), "run 4")
            self.assertEqual((renders / "layout-error-5.log").read_text(encoding="utf-8"), "run 5")

    def test_an_unwritable_destination_does_not_mask_the_real_failure(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-reflow-log-") as temp:
            renders = Path(temp) / "renders"
            renders.mkdir()
            attempt = self._attempt(renders, "transcript")
            with patch("server.shutil.copyfile", side_effect=OSError("disk full")):
                self.assertIsNone(server_module._preserve_layout_error_log(attempt, renders, 5))


class ReflowFailureErrorTest(unittest.TestCase):
    def test_the_stored_error_points_at_the_kept_log(self) -> None:
        message = server_module._reflow_failure_error(
            RuntimeError("MinerU 运行超时：已达到 32 分钟上限"),
            Path("/jobs/x/renders/layout-error-5.log"),
        )
        self.assertIn("32 分钟上限", message)
        self.assertIn("layout-error-5.log", message)

    def test_no_log_means_no_dangling_pointer(self) -> None:
        message = server_module._reflow_failure_error(RuntimeError("原始 PDF 校验失败"), None)
        self.assertEqual(message, "原始 PDF 校验失败")

    def test_the_stored_error_stays_within_the_column_budget(self) -> None:
        message = server_module._reflow_failure_error(
            RuntimeError("x" * 900), Path("/jobs/x/renders/layout-error-5.log")
        )
        self.assertEqual(len(message), 500)


class ReflowFailureKeepsTheTranscriptTest(unittest.TestCase):
    """The failure path itself, not just the helper it is supposed to call.

    Testing the helper alone would still pass if the call were dropped from the
    ``except`` branch, which is exactly how the transcript went missing.
    """

    @staticmethod
    def _completed_store(root: Path):
        store = server_module.JobStore(root)
        source = b"%PDF-1.4\noriginal-source"
        record = store.create("paper.pdf", len(source))
        job_dir = Path(record["job_dir"])
        (job_dir / "source.pdf").write_bytes(source)
        manifest = {"job_id": record["job_id"], "source": {"filename": "paper.pdf"}, "counts": {"pages": 1}}
        (job_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        store.update(
            record["job_id"],
            status="completed",
            source_sha256=hashlib.sha256(source).hexdigest(),
            manifest=manifest,
        )
        return store, store.get(record["job_id"])

    def _run_failing_reflow(self, temp: str, error: Exception):
        store, record = self._completed_store(Path(temp))
        job_id = record["job_id"]
        generation = store.begin_reflow(job_id)["reflow"]["generation"]

        def run(request, progress=None, cancel_event=None):
            layout = Path(request.output_dir) / "layout"
            layout.mkdir(parents=True, exist_ok=True)
            (layout / "mineru.log").write_text("Predict: 78%|...| 57/73", encoding="utf-8")
            raise error

        provider = MagicMock()
        provider.run.side_effect = run
        registry = MagicMock()
        registry.get.return_value = provider
        with patch.object(server_module, "STORE", store), patch.object(
            server_module, "_parsing_provider_registry", return_value=registry
        ):
            server_module._run_reflow_job(job_id, "paper.pdf", generation)
        return store, Path(record["job_dir"]), generation, store.get(job_id)

    def test_a_failed_reflow_leaves_its_transcript_behind(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-reflow-fail-") as temp:
            _store, job_dir, generation, current = self._run_failing_reflow(
                temp, server_module.PipelineError("MinerU 运行超时：已达到 32 分钟上限")
            )
            kept = job_dir / "renders" / f"layout-error-{generation}.log"
            self.assertTrue(kept.is_file(), "the failed attempt's MinerU log was discarded")
            self.assertIn("57/73", kept.read_text(encoding="utf-8"))
            # The attempt directory itself is still cleaned up.
            self.assertEqual(list((job_dir / "renders").glob("*.tmp")), [])
            self.assertEqual(current["reflow"]["status"], "failed")
            self.assertIn("32 分钟上限", current["reflow"]["error"])
            self.assertIn(kept.name, current["reflow"]["error"])

    def test_a_cancelled_reflow_leaves_no_misleading_error_log(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-reflow-cancel-") as temp:
            _store, job_dir, generation, current = self._run_failing_reflow(
                temp, server_module.ReflowCancelledError("用户已取消重新排版。")
            )
            self.assertFalse((job_dir / "renders" / f"layout-error-{generation}.log").exists())
            self.assertEqual(current["reflow"]["status"], "cancelled")


if __name__ == "__main__":
    unittest.main()
