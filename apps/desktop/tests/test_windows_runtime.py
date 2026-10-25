from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import annotation_style_sync
import layout_pipeline
import mineru_discovery
import pipeline
import subprocess_runtime
import zotero_merge
from remote_parser_connection import RemoteParserConnection


class WindowsRuntimeTest(unittest.TestCase):
    def windows(self):
        stack = ExitStack()
        stack.enter_context(patch("subprocess_runtime.sys.platform", "win32"))
        stack.enter_context(patch.object(subprocess, "CREATE_NO_WINDOW", 0x08000000, create=True))
        stack.enter_context(patch.object(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200, create=True))
        return stack

    def test_zotero_atomic_write_windows_commits_without_opening_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "文献 library" / "notes.json"
            payload = {"note": "可靠写入"}
            original_fsync = os.fsync
            with patch("annotation_style_sync.os.name", "nt"), patch(
                "annotation_style_sync.os.open", side_effect=PermissionError("directories cannot be opened")
            ) as directory_open, patch("zotero_merge.os.fsync", wraps=original_fsync) as sync:
                zotero_merge._atomic_write(target, payload)
            directory_open.assert_not_called()
            sync.assert_called_once()
            self.assertEqual(json.loads(target.read_text(encoding="utf-8")), payload)
            zotero_merge._atomic_write(target, {"note": "updated"})
            self.assertEqual(json.loads(target.read_text(encoding="utf-8")), {"note": "updated"})
            self.assertEqual(list(target.parent.glob(".*.tmp")), [])

    def test_directory_sync_keeps_posix_durability(self):
        directory = Path("library")
        with patch("annotation_style_sync.os.name", "posix"), patch(
            "annotation_style_sync.os.open", return_value=17
        ) as opened, patch("annotation_style_sync.os.fsync") as sync, patch("annotation_style_sync.os.close") as closed:
            annotation_style_sync._sync_directory(directory)
        opened.assert_called_once_with(directory, os.O_RDONLY)
        sync.assert_called_once_with(17)
        closed.assert_called_once_with(17)

    def test_background_options_leave_mac_unchanged(self):
        with patch("subprocess_runtime.sys.platform", "darwin"):
            self.assertEqual(subprocess_runtime.hidden_subprocess_options(), {})

    def test_java_arguments_keep_space_and_unicode_paths_without_shell(self):
        command = [r"C:\Program Files\Java\bin\java.exe", "-cp", r"C:\文献 工具\renderer;C:\tools\odl.jar"]
        with self.windows(), patch("pipeline.subprocess.run", return_value=subprocess.CompletedProcess(command, 0, "ok")) as run:
            self.assertEqual(pipeline._run(command).stdout, "ok")
        self.assertEqual(run.call_args.args[0], command)
        self.assertEqual(run.call_args.kwargs["creationflags"], 0x08000000)
        self.assertFalse(run.call_args.kwargs.get("shell", False))

    def test_pdf_workers_and_java_fallback_are_hidden(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "论文.pdf"
            with self.windows(), patch("layout_pipeline._pdf_evidence_worker_command", return_value=["worker.exe", str(source)]), patch(
                "layout_pipeline._pdf_evidence_java_command", return_value=["java.exe", "-cp", "renderer;odl.jar"]
            ), patch("layout_pipeline.subprocess.run", return_value=subprocess.CompletedProcess([], 1)) as run:
                self.assertEqual(layout_pipeline._extract_pdf_evidence_isolated(source, [[]], root), [])
            self.assertEqual(run.call_count, 2)
            for call in run.call_args_list:
                self.assertEqual(call.kwargs["creationflags"], 0x08000000)
                self.assertFalse(call.kwargs.get("shell", False))

    def test_pandoc_is_hidden_and_receives_formula_on_stdin(self):
        renderer = layout_pipeline.MathRenderer()
        renderer.pandoc = r"C:\Program Files\Pandoc\pandoc.exe"
        with self.windows(), patch("layout_pipeline.subprocess.run", return_value=subprocess.CompletedProcess([], 0, "<math>x</math>")) as run:
            self.assertIn("math-rendered", renderer.render("x", False))
        self.assertEqual(run.call_args.args[0][0], renderer.pandoc)
        self.assertEqual(run.call_args.kwargs["input"], "$x$")
        self.assertEqual(run.call_args.kwargs["creationflags"], 0x08000000)

    def test_external_mineru_probes_are_hidden(self):
        with tempfile.TemporaryDirectory() as temporary:
            executable = Path(temporary) / "mineru.exe"
            executable.write_bytes(b"fake executable")
            executable.chmod(0o700)
            with self.windows(), patch("mineru_discovery.subprocess.run", return_value=subprocess.CompletedProcess([], 0, "mineru 1.0")) as run:
                self.assertIsNone(mineru_discovery._health_failure(executable))
                self.assertEqual(mineru_discovery._version(executable), "mineru 1.0")
            for call in run.call_args_list:
                self.assertEqual(call.kwargs["creationflags"], 0x08000000)

    def test_mineru_windows_launch_uses_hidden_process_group(self):
        process = MagicMock(returncode=0, stdout=None)
        process.poll.return_value = 0
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.windows(), patch("layout_pipeline.subprocess.Popen", return_value=process) as popen, patch(
                "layout_pipeline._page_count", return_value=1
            ), self.assertRaisesRegex(layout_pipeline.LayoutPipelineError, "content_list_v2"):
                layout_pipeline._run_mineru(root / "mineru.exe", root / "论文.pdf", root / "output")
        self.assertEqual(popen.call_args.kwargs["creationflags"], 0x08000200)
        self.assertNotIn("start_new_session", popen.call_args.kwargs)

    def test_windows_cancel_targets_only_owned_pid_tree(self):
        process = MagicMock(pid=43210)
        process.poll.return_value = None
        with self.windows(), patch("subprocess_runtime.subprocess.run", return_value=subprocess.CompletedProcess([], 0)) as run:
            layout_pipeline._stop_mineru_process(process)
        self.assertEqual(run.call_args.args[0][1:], ["/PID", "43210", "/T", "/F"])
        self.assertEqual(run.call_args.kwargs["creationflags"], 0x08000000)
        self.assertFalse(run.call_args.kwargs.get("shell", False))
        process.terminate.assert_not_called()
        process.kill.assert_not_called()
        process.wait.assert_called_once_with(timeout=5)

    def test_windows_tree_stop_falls_back_when_taskkill_is_unavailable(self):
        process = MagicMock(pid=43211)
        process.poll.return_value = None
        with self.windows(), patch("subprocess_runtime.subprocess.run", side_effect=FileNotFoundError):
            subprocess_runtime.stop_windows_process_tree(process)
        process.kill.assert_called_once()

    def test_mineru_mac_cancel_keeps_process_group_signal(self):
        process = MagicMock(pid=43212)
        process.poll.return_value = None
        with patch("layout_pipeline.sys.platform", "darwin"), patch("layout_pipeline.os.name", "posix"), patch(
            "layout_pipeline.os.killpg", create=True
        ) as killpg:
            layout_pipeline._stop_mineru_process(process)
        killpg.assert_called_once_with(43212, signal.SIGTERM)

    def test_windows_tunnel_stop_cleans_owned_tree(self):
        with tempfile.TemporaryDirectory() as temporary:
            connection = RemoteParserConnection(Path(temporary) / "remote.json")
            process = MagicMock(pid=43213)
            process.poll.return_value = None
            connection._process = process
            with self.windows(), patch("remote_parser_connection.stop_windows_process_tree") as stop:
                connection.close()
            stop.assert_called_once_with(process)
            self.assertIsNone(connection._process)

    def test_windows_tunnel_launch_is_hidden_without_shell(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            identity = root / "private key"
            known_hosts = root / "known hosts"
            identity.touch()
            known_hosts.touch()
            connection = RemoteParserConnection(root / "remote.json")
            process = MagicMock(pid=43214)
            process.poll.return_value = None
            probe = MagicMock()
            probe.__enter__.return_value.connect_ex.side_effect = [1, 0]
            with self.windows(), patch("remote_parser_connection.socket.socket", return_value=probe), patch(
                "remote_parser_connection.subprocess.Popen", return_value=process
            ) as popen:
                connection._ensure_tunnel({"host": "example.test", "identity_file": str(identity), "known_hosts_file": str(known_hosts)}, "http://127.0.0.1:18770")
            self.assertEqual(popen.call_args.kwargs["creationflags"], 0x08000000)
            self.assertFalse(popen.call_args.kwargs.get("shell", False))
            self.assertIn(str(identity.resolve()), popen.call_args.args[0])
            process.poll.return_value = 0
            connection.close()


if __name__ == "__main__":
    unittest.main()
