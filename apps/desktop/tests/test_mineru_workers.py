"""Cover the local MinerU worker advice.

The default of one local slot is a hardware statement, not a conservative
guess: on a 1GB card a second concurrent layout run competes for memory rather
than adding throughput. The advice line exists so that the default stops being
invisible once the machine has headroom.
"""

from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import layout_pipeline  # noqa: E402


class MineruWorkerAdviceTest(unittest.TestCase):
    def test_no_advice_without_a_gpu(self) -> None:
        with patch.dict("os.environ", {}, clear=False):
            self.assertIsNone(layout_pipeline.mineru_worker_advice(memory_mb=None))

    def test_no_advice_on_a_card_without_headroom(self) -> None:
        below = layout_pipeline.MINERU_SECOND_WORKER_MIN_MB - 1
        self.assertIsNone(layout_pipeline.mineru_worker_advice(memory_mb=below))

    def test_advice_names_the_variable_and_the_size(self) -> None:
        advice = layout_pipeline.mineru_worker_advice(memory_mb=24_576)
        self.assertIsNotNone(advice)
        self.assertIn("MY_SCHOLAR_MINERU_WORKERS", advice)
        self.assertIn("24GB", advice)

    def test_an_explicit_setting_is_never_second_guessed(self) -> None:
        with patch.dict("os.environ", {"MY_SCHOLAR_MINERU_WORKERS": "2"}):
            self.assertIsNone(layout_pipeline.mineru_worker_advice(memory_mb=24_576))

    def test_detection_returns_none_when_nvidia_smi_is_absent(self) -> None:
        with patch("subprocess.run", side_effect=FileNotFoundError):
            self.assertIsNone(layout_pipeline.detect_gpu_memory_mb())

    def test_detection_returns_none_when_nvidia_smi_times_out(self) -> None:
        with patch("subprocess.run", side_effect=subprocess.TimeoutExpired("nvidia-smi", 5)):
            self.assertIsNone(layout_pipeline.detect_gpu_memory_mb())

    def test_detection_takes_the_largest_card(self) -> None:
        completed = subprocess.CompletedProcess([], 0, stdout="8192\n24576\n", stderr="")
        with patch("subprocess.run", return_value=completed):
            self.assertEqual(layout_pipeline.detect_gpu_memory_mb(), 24576)

    def test_detection_ignores_unparsable_output(self) -> None:
        completed = subprocess.CompletedProcess([], 0, stdout="N/A\n[Insufficient Permissions]\n", stderr="")
        with patch("subprocess.run", return_value=completed):
            self.assertIsNone(layout_pipeline.detect_gpu_memory_mb())

    def test_detection_reports_nothing_on_a_failing_call(self) -> None:
        completed = subprocess.CompletedProcess([], 9, stdout="24576\n", stderr="boom")
        with patch("subprocess.run", return_value=completed):
            self.assertIsNone(layout_pipeline.detect_gpu_memory_mb())


if __name__ == "__main__":
    unittest.main()
