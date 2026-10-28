from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import content_store  # noqa: E402


class ContentSnapshotTest(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="guzi-content-snapshot-")
        self.addCleanup(temporary.cleanup)
        self.job_dir = Path(temporary.name)
        self.snapshot = self.job_dir / "content" / "english" / "blocks.json"
        self.manifest = self.job_dir / "content" / "manifest.json"
        readonly = patch.object(content_store.runtime, "READONLY_MODE", False)
        readonly.start()
        self.addCleanup(readonly.stop)

    @staticmethod
    def document(root: Path, text: str, **extra) -> Path:
        root.mkdir(parents=True, exist_ok=True)
        path = root / "document.json"
        path.write_text(json.dumps({
            "pages": [{"page": 1, "elements": [{"block_id": "block-1", "type": "paragraph", "text": text}]}],
            **extra,
        }), encoding="utf-8")
        return path

    def activate(self, generation: str) -> Path:
        root = self.job_dir / "renders" / generation
        root.mkdir(parents=True, exist_ok=True)
        (root / "manifest.json").write_text("{}", encoding="utf-8")
        (self.job_dir / "job.json").write_text(json.dumps({"active_render": generation}), encoding="utf-8")
        return root

    def read(self, path: Path) -> dict:
        return json.loads(path.read_text(encoding="utf-8"))

    def test_snapshot_and_html_follow_active_generation_and_base(self) -> None:
        self.document(self.job_dir, "Base content")
        content_store._ensure_content_layout(self.job_dir)
        self.assertEqual(self.read(self.snapshot)["blocks"][0]["text"], "Base content")
        self.assertEqual(self.read(self.manifest)["html"], "../document.html")

        for generation in ("1", "2"):
            with self.subTest(generation=generation):
                self.document(self.activate(generation), f"Render {generation}")
                content_store._ensure_content_layout(self.job_dir)
                self.assertEqual(self.read(self.snapshot)["blocks"][0]["text"], f"Render {generation}")
                self.assertEqual(self.read(self.manifest)["html"], f"../renders/{generation}/document.html")

        (self.job_dir / "job.json").write_text("{}", encoding="utf-8")
        content_store._ensure_content_layout(self.job_dir)
        self.assertEqual(self.read(self.snapshot)["blocks"][0]["text"], "Base content")
        self.assertEqual(self.read(self.manifest)["html"], "../document.html")

    def test_same_generation_refreshes_when_source_appears_and_changes(self) -> None:
        for generation in ("base", "1"):
            with self.subTest(generation=generation):
                root = self.job_dir if generation == "base" else self.activate(generation)
                content_store._ensure_content_layout(self.job_dir)
                self.assertEqual(self.read(self.snapshot)["blocks"], [])

                source = self.document(root, "First text")
                content_store._ensure_content_layout(self.job_dir)
                self.assertEqual(self.read(self.snapshot)["blocks"][0]["text"], "First text")

                previous_stat = source.stat()
                replacement = root / "replacement.json"
                replacement.write_text(source.read_text(encoding="utf-8").replace("First text", "Later text"), encoding="utf-8")
                os.utime(replacement, ns=(previous_stat.st_atime_ns, previous_stat.st_mtime_ns + 1_000_000_000))
                replacement.replace(source)
                content_store._ensure_content_layout(self.job_dir)
                self.assertEqual(self.read(self.snapshot)["blocks"][0]["text"], "Later text")

    def test_unchanged_reads_and_saves_do_not_rewrite_snapshot(self) -> None:
        source = self.document(self.job_dir, "Stable text")
        content_store._ensure_content_layout(self.job_dir)
        before = self.snapshot.read_bytes()
        with (
            patch.object(content_store, "_atomic_temp_path", wraps=content_store._atomic_temp_path) as temporary,
            patch.object(content_store, "_read_json_file", wraps=content_store._read_json_file) as read,
        ):
            content_store._ensure_content_layout(self.job_dir)
            content_store._ensure_content_layout(self.job_dir)
            content_store._write_translation_records(self.job_dir, [{"cache_key": "cached", "text": "译文"}])

        targets = [call.args[0] for call in temporary.call_args_list]
        self.assertNotIn(self.snapshot, targets)
        self.assertNotIn(self.manifest, targets)
        reads = [call.args[0] for call in read.call_args_list]
        self.assertNotIn(source, reads)
        self.assertNotIn(self.snapshot, reads)
        self.assertIn(self.manifest, reads)
        self.assertEqual(self.snapshot.read_bytes(), before)
        self.assertEqual(self.read(self.manifest)["english_source"], json.loads(before)["source"])

    def test_legacy_snapshot_without_source_metadata_is_rebuilt_once(self) -> None:
        self.document(self.job_dir, "Current text")
        self.snapshot.parent.mkdir(parents=True)
        self.snapshot.write_text(json.dumps({"version": 1, "blocks": [{"text": "Legacy text"}]}), encoding="utf-8")
        content_store._ensure_content_layout(self.job_dir)
        self.assertEqual(self.read(self.snapshot)["blocks"][0]["text"], "Current text")
        with patch.object(content_store, "_atomic_temp_path", side_effect=AssertionError("unexpected rewrite")):
            content_store._ensure_content_layout(self.job_dir)

    def test_changed_semantic_gate_clears_previous_blocks(self) -> None:
        for extra in ({"semantic_validation": {"status": "FAIL"}}, {"translation_enabled": False}):
            with self.subTest(extra=extra):
                self.document(self.job_dir, "Valid text")
                content_store._ensure_content_layout(self.job_dir)
                self.assertTrue(self.read(self.snapshot)["blocks"])
                self.document(self.job_dir, "Unsafe text", **extra)
                content_store._ensure_content_layout(self.job_dir)
                self.assertEqual(self.read(self.snapshot)["blocks"], [])

    def test_readonly_mode_does_not_create_or_refresh_content(self) -> None:
        self.document(self.job_dir, "Base text")
        with patch.object(content_store.runtime, "READONLY_MODE", True):
            content_store._ensure_content_layout(self.job_dir)
            self.assertFalse(self.snapshot.parent.parent.exists())

        content_store._ensure_content_layout(self.job_dir)
        original = {path: path.read_bytes() for path in (self.snapshot, self.manifest)}
        self.document(self.activate("1"), "New generation")
        with (
            patch.object(content_store.runtime, "READONLY_MODE", True),
            patch.object(content_store, "_atomic_temp_path", side_effect=AssertionError("readonly write")),
        ):
            content_store._ensure_content_layout(self.job_dir)
            content_store._write_english_snapshot(self.job_dir)
            content_store._write_content_manifest(self.job_dir)
        for path, data in original.items():
            self.assertEqual(path.read_bytes(), data)

    def test_failed_atomic_snapshot_replace_preserves_previous_snapshot(self) -> None:
        self.document(self.job_dir, "Before text")
        content_store._ensure_content_layout(self.job_dir)
        before = self.snapshot.read_bytes()
        self.document(self.job_dir, "After text")
        with patch.object(content_store.os, "replace", side_effect=OSError("replace failed")):
            with self.assertRaisesRegex(OSError, "replace failed"):
                content_store._write_english_snapshot(self.job_dir)
        self.assertEqual(self.snapshot.read_bytes(), before)
        self.assertEqual(list(self.snapshot.parent.glob(".*.tmp")), [])


if __name__ == "__main__":
    unittest.main()
