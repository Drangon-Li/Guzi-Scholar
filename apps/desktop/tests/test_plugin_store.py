import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import threading
import unittest
import uuid
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from plugin_store import PluginStore, MAX_STORAGE, MAX_ACTIVE_PREVIEWS, ADMISSION_CHECKS, _github_url, _GitHubRedirects


def manifest(version="1.0.0", permissions=None, plugin_id="example.reader"):
    return {"id": plugin_id, "name": "测试插件", "version": version, "sdkVersion": "1",
            "entry": "index.html", "permissions": permissions if permissions is not None else ["storage"],
            "contributes": {"pages": [{"id": "main", "title": "测试"}]}}


def package(value=None, extra=None, prefix=""):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(prefix + "manifest.json", json.dumps(value or manifest()))
        archive.writestr(prefix + "index.html", "<!doctype html><h1>Plugin</h1>")
        for name, content in (extra or {}).items():
            archive.writestr(name, content)
    return output.getvalue()


class PluginStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.store = PluginStore(self.base / "state", self.base / "library", self.base / "bundled")

    def install(self, data=None, **kwargs):
        data = data or package()
        if kwargs.get("enabled"):
            self.admit_package(data, kwargs.get("grants"))
        return self.store.install_plugin(packageBase64=base64.b64encode(data).decode(), **kwargs)

    def admit_preview(self, preview):
        self.store.report_plugin_runtime_event(preview["pluginId"], "ready", "Trusted host fixture", previewSession=preview["previewId"])
        return self.store.complete_plugin_admission(preview["pluginId"], preview["previewId"], {check: True for check in ADMISSION_CHECKS})

    def admit_package(self, data, grants=None):
        draft = "draft-" + uuid.uuid4().hex
        root = self.store.root / "drafts" / draft
        root.mkdir(parents=True)
        self.store._extract(data, root)
        validation = self.store.validate_plugin(draft)
        value = validation["manifest"]
        previous = self.store._load()["plugins"].get(value["id"], {})
        granted = grants if grants is not None else [p for p in previous.get("grants", []) if p in value["permissions"]]
        if set(granted) != set(value["permissions"]):
            return
        if self.store._admission({"grants": granted}, root)["status"] != "passed":
            preview = self.store.preview_plugin(draftId=draft, grants=granted)
            self.admit_preview(preview)
            self.store.stop_plugin_preview(draft, preview["previewId"])

    def admit_installed(self, plugin_id="example.reader", grants=None):
        entry = self.store._entries()[plugin_id]
        preview = self.store.preview_plugin(pluginId=plugin_id, grants=grants if grants is not None else entry["manifest"]["permissions"])
        self.admit_preview(preview)
        self.store.stop_plugin_preview(preview["pluginId"], preview["previewId"])

    def session(self, plugin_id="example.reader"):
        return next(row["epoch"] for row in self.store.list_plugins()["plugins"] if row["id"] == plugin_id)

    def invoke(self, plugin_id, name, args, callback):
        return self.store.invoke(plugin_id, name, args, callback, plugin_session=self.session(plugin_id))

    def test_draft_workflow_and_runtime_events(self):
        sdk = self.store.call("get_plugin_sdk", {})
        self.assertIn("index.html", sdk["template"])
        draft = self.store.call("create_plugin_draft", {"id": "example.author", "name": "作者"})["draftId"]
        self.assertTrue(self.store.validate_plugin(draft)["valid"])
        self.assertIn("GuziPlugin", self.store.read_plugin_file(draft, "main.js")["content"])
        preview = self.store.preview_plugin(draft, grants=["storage"])
        self.assertTrue(self.store.asset(draft, f"__preview/{preview['previewId']}/index.html")[0].startswith(b"<!doctype"))
        self.store.invoke(draft, "storage_set", {"key": "draft", "value": 123}, lambda *_: self.fail(), preview_session=preview["previewId"])
        for index in range(110):
            self.store.report_plugin_runtime_event(draft, "info", str(index), previewSession=preview["previewId"])
        self.store.report_plugin_runtime_event(draft, "test", "保存测试通过", {"passed": True}, previewSession=preview["previewId"])
        self.store.report_plugin_runtime_event(draft, "ready", "ready", previewSession=preview["previewId"])
        status = self.store.get_plugin_runtime_status(draft)
        self.assertEqual(len(status["events"]), 100)
        self.assertTrue(status["lastTest"]["details"]["passed"])
        self.assertEqual(status["status"], "ready")
        self.store.write_plugin_file(draft, "main.js", "console.log('updated');")
        with self.assertRaises(ValueError):
            self.store.asset(draft, "index.html")
        installed = self.store.install_plugin(draftId=draft)
        self.assertFalse(installed["plugin"]["enabled"])
        self.assertEqual(preview["pluginId"], draft)

    def test_disabled_by_default_grants_and_host_only_authorization(self):
        self.install(package(manifest(permissions=["library.read", "reader.open"])))
        with self.assertRaises(ValueError):
            self.store.invoke("example.reader", "search_library", {}, lambda *_: None)
        with self.assertRaises(ValueError):
            self.store.set_plugin_enabled("example.reader", True, ["library.read"])
        self.admit_installed()
        self.store.set_plugin_enabled("example.reader", True, ["library.read", "reader.open"])
        seen = []
        result = self.invoke("example.reader", "search_library", {"query": "paper"}, lambda *args: seen.append(args) or ["ok"])
        self.assertEqual(result, ["ok"])
        self.assertEqual(seen, [("search_library", {"query": "paper"})])
        self.assertEqual(self.invoke("example.reader", "open_source", {}, lambda *_: self.fail()), {"authorized": True})
        for name in ("save_notes", "get_preferences", "install_plugin", "storage_get"):
            with self.assertRaises(PermissionError):
                self.invoke("example.reader", name, {}, lambda *_: self.fail())

    def test_versioned_upgrade_requires_grants_and_rollback_preserves_scope(self):
        first = self.install(enabled=True, grants=["storage"])["plugin"]
        upgraded = package(manifest("2.0.0", ["storage", "notes.write"]))
        with self.assertRaises(ValueError):
            self.install(upgraded, enabled=True)
        self.assertEqual(self.store.list_plugins()["plugins"][0]["version"], "1.0.0")
        second = self.install(upgraded)["plugin"]
        self.assertFalse(second["enabled"])
        self.assertEqual(second["grants"], ["storage"])
        self.admit_installed()
        self.store.set_plugin_enabled("example.reader", True, ["storage", "notes.write"])
        rolled = self.store.rollback_plugin("example.reader")["plugin"]
        self.assertEqual(rolled["sha256"], first["sha256"])
        self.assertEqual(rolled["grants"], ["storage"])
        self.assertTrue(rolled["enabled"])
        restored = PluginStore(self.base / "state", self.base / "library", self.base / "bundled")
        self.assertEqual(restored.list_plugins()["plugins"][0]["version"], "1.0.0")

    def test_same_version_different_content_is_rejected(self):
        self.install()
        with self.assertRaises(ValueError):
            self.install(package(extra={"changed.js": "new"}))
        self.assertEqual(len(self.store.list_plugins()["plugins"]), 1)

    def test_upgrade_removing_permission_discards_old_grant(self):
        self.install(package(manifest(permissions=["storage", "notes.read"])), enabled=True, grants=["storage", "notes.read"])
        result = self.install(package(manifest("2.0.0", ["storage"])), enabled=True)
        self.assertEqual(result["plugin"]["grants"], ["storage"])
        result = self.store.rollback_plugin("example.reader")
        self.assertFalse(result["plugin"]["enabled"])
        self.assertEqual(result["plugin"]["grants"], ["storage"])

    def test_storage_is_bound_to_plugin_library_and_retained(self):
        self.install(enabled=True, grants=["storage"])
        other = package(manifest(plugin_id="example.other"))
        self.install(other, enabled=True, grants=["storage"])
        invoke = lambda pid, name, args: self.invoke(pid, name, args, lambda *_: self.fail())
        invoke("example.reader", "storage_set", {"key": "../../foreign", "value": {"count": 4}, "pluginId": "example.other"})
        self.assertEqual(invoke("example.other", "storage_get", {"key": "../../foreign"}), {"value": None})
        with self.assertRaises(ValueError):
            invoke("example.reader", "storage_set", {"key": "huge", "value": "a" * MAX_STORAGE})
        self.store.uninstall_plugin("example.reader")
        self.install(enabled=True, grants=["storage"])
        self.assertEqual(invoke("example.reader", "storage_get", {"key": "../../foreign"})["value"], {"count": 4})
        self.assertFalse((self.base / "foreign").exists())

    def test_unsafe_zip_paths_symlinks_duplicates_and_bomb_are_rejected(self):
        for name in ("../outside", "/outside", "a/../../outside", "a\\outside", "C:/outside"):
            with self.subTest(path=name), self.assertRaises(ValueError):
                self.install(package(extra={name: "bad"}))
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as archive:
            info = zipfile.ZipInfo("link")
            info.create_system = 3
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(info, "../outside")
        with self.assertRaises(ValueError):
            self.install(output.getvalue())
        with self.assertRaises(ValueError):
            self.install(package(extra={"bomb": "a" * (2 * 1024 * 1024 + 1)}))
        for extra in ({"a": "file", "a/b": "nested"}, {"A.js": "first", "a.js": "second"}):
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                self.install(package(extra=extra))
        self.assertEqual(self.store.list_plugins()["plugins"], [])

    def test_github_urls_digest_and_archive_wrapper(self):
        commit = "a" * 40
        valid = "https://github.com/example/repo/archive/" + commit + ".zip"
        data = package(prefix="repo-" + commit + "/")
        with patch.object(self.store, "_download", return_value=data) as download:
            result = self.store.install_plugin(githubUrl=valid, sha256=hashlib.sha256(data).hexdigest())
            self.assertEqual(result["plugin"]["source"]["url"], valid)
            download.assert_called_once_with(valid)
            with self.assertRaises(ValueError):
                self.store.install_plugin(githubUrl=valid, sha256="0" * 64)
        for url in ("http://github.com/a/b/archive/" + commit + ".zip", "https://localhost/x.zip", "https://github.com/a/b/archive/main.zip", "https://github.com.evil.test/a/b.zip", "https://github.com@localhost/x.zip", "https://github.com/a/b/archive/" + commit + ".zip?x=1"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                _github_url(url)
        with self.assertRaises(ValueError):
            self.store.install_plugin(githubUrl="https://github.com/a/b/releases/download/v1/pkg.zip")

    def test_draft_paths_symlink_and_asset_paths(self):
        draft = self.store.create_plugin_draft()["draftId"]
        for path in ("../outside", "/tmp/outside", "a/../b", "a\\b"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.store.write_plugin_file(draft, path, "bad")
        root = self.store._draft(draft)
        (root / "link").symlink_to(self.base)
        with self.assertRaises(ValueError):
            self.store.write_plugin_file(draft, "link/outside", "bad")
        with self.assertRaises(ValueError):
            self.store.validate_plugin(draft)
        (root / "link").unlink()
        preview = self.store.preview_plugin(draft)
        with self.assertRaises(ValueError):
            self.store.asset(draft, f"__preview/{preview['previewId']}/../../registry.json")
        with self.assertRaises(ValueError):
            self.store.call("write_plugin_file", {"draftId": draft, "path": "index.html", "content": "hi", "root": "/"})

    def test_bundled_plugins_default_enabled_cannot_be_replaced_or_removed(self):
        root = self.base / "bundled" / "vocabulary"
        root.mkdir(parents=True)
        (root / "manifest.json").write_text(json.dumps(manifest(plugin_id="guzi.vocabulary")))
        (root / "index.html").write_text("<h1>Words</h1>")
        row = self.store.list_plugins()["plugins"][0]
        self.assertTrue(row["enabled"])
        self.assertTrue(row["bundled"])
        with self.assertRaises(ValueError):
            self.install(package(manifest(plugin_id="guzi.vocabulary")))
        with self.assertRaises(ValueError):
            self.store.uninstall_plugin("guzi.vocabulary")
        self.store.set_plugin_enabled("guzi.vocabulary", False)
        self.assertFalse(self.store.list_plugins()["plugins"][0]["enabled"])

    def test_corrupt_registry_does_not_reset_existing_state(self):
        self.install()
        self.store.registry_path.write_text("bad json")
        with self.assertRaises(ValueError):
            self.store.list_plugins()
        self.assertEqual(self.store.registry_path.read_text(), "bad json")

    def test_tool_argument_types_are_rejected_before_dispatch(self):
        for args in ({"pluginId": [], "enabled": True}, {"pluginId": "example.reader", "enabled": 1},
                     {"pluginId": "example.reader", "enabled": True, "grants": {}}):
            with self.subTest(args=args), self.assertRaises(ValueError):
                self.store.call("set_plugin_enabled", args)

    def test_explanation_requires_explicit_ai_grant_and_scopes_are_copies(self):
        self.install(package(manifest(permissions=["vocabulary.write"])), enabled=True, grants=["vocabulary.write"])
        with self.assertRaises(PermissionError):
            self.invoke("example.reader", "vocabulary_explain", {}, lambda *_: self.fail())
        self.install(package(manifest("2.0.0", ["vocabulary.read", "vocabulary.write", "ai.translate"])), enabled=True, grants=["vocabulary.read", "vocabulary.write", "ai.translate"])
        scopes = self.store.granted_permissions("example.reader", plugin_session=self.session())
        scopes.append("notes.read")
        self.assertNotIn("notes.read", self.store.granted_permissions("example.reader", plugin_session=self.session()))
        self.assertEqual(self.invoke("example.reader", "vocabulary_explain", {}, lambda *_: "ok"), "ok")

    def test_preview_sessions_default_to_no_grants_and_retire_old_requests(self):
        draft = self.store.create_plugin_draft()["draftId"]
        first = self.store.preview_plugin(draft)
        self.assertEqual(first["grants"], [])
        self.assertEqual(first["status"], "waiting")
        with self.assertRaises(PermissionError):
            self.store.invoke(draft, "storage_get", {"key": "secret"}, lambda *_: self.fail(), preview_session=first["previewId"])
        second = self.store.preview_plugin(draft, grants=["storage"])
        self.assertNotEqual(first["epoch"], second["epoch"])
        for session in (None, first["previewId"]):
            with self.subTest(session=session), self.assertRaises(PermissionError):
                self.store.invoke(draft, "storage_get", {"key": "secret"}, lambda *_: self.fail(), preview_session=session)
            with self.assertRaises(PermissionError):
                self.store.granted_permissions(draft, preview_session=session)
        with self.assertRaises(PermissionError):
            self.store.asset(draft, f"__preview/{first['previewId']}/index.html")
        with self.assertRaises(PermissionError):
            self.store.report_plugin_runtime_event(draft, "error", "stale", previewSession=first["previewId"])
        self.assertFalse(self.store.stop_plugin_preview(draft, first["previewId"])["stopped"])
        listed = self.store.list_plugins()["previews"]
        self.assertEqual(listed[0]["url"], second["url"])
        listed[0]["grants"].clear()
        self.assertEqual(self.store.granted_permissions(draft, second["previewId"]), ["storage"])
        self.assertTrue(self.store.stop_plugin_preview(draft, second["previewId"])["stopped"])
        self.assertEqual(self.store.get_plugin_runtime_status(draft)["status"], "stopped")
        with self.assertRaises(ValueError):
            self.store.invoke(draft, "storage_get", {"key": "secret"}, lambda *_: self.fail(), preview_session=second["previewId"])

    def test_installed_id_cannot_shadow_preview_authorization_namespace(self):
        draft = self.store.create_plugin_draft()["draftId"]
        self.store.preview_plugin(draft)
        with self.assertRaises(ValueError):
            self.install(package(manifest(plugin_id=draft)))
        self.assertEqual(self.store.list_plugins()["plugins"], [])

    def test_install_clears_preview_only_after_registry_commit(self):
        draft = self.store.create_plugin_draft()["draftId"]
        preview = self.store.preview_plugin(draft, grants=["storage"])
        replace = os.replace
        def fail_registry(source, destination):
            if Path(destination) == self.store.registry_path:
                raise OSError("simulated disk failure")
            return replace(source, destination)
        with patch("plugin_store.os.replace", side_effect=fail_registry), self.assertRaises(OSError):
            self.store.install_plugin(draftId=draft)
        self.assertEqual(self.store.list_plugins()["previews"][0]["previewId"], preview["previewId"])
        self.assertEqual(self.store.list_plugins()["plugins"], [])
        self.store.install_plugin(draftId=draft)
        self.assertEqual(self.store.list_plugins()["previews"], [])
        self.assertEqual(self.store.get_plugin_runtime_status(draft)["status"], "installed")
        with self.assertRaises(ValueError):
            self.store.asset(draft, f"__preview/{preview['previewId']}/index.html")

    def test_passed_preview_can_install_enabled_and_retires_preview(self):
        draft = self.store.create_plugin_draft()["draftId"]
        preview = self.store.preview_plugin(draftId=draft, grants=["storage"])
        self.admit_preview(preview)
        self.store.invoke(draft, "storage_set", {"key": "preview", "value": True}, lambda *_: self.fail(), preview_session=preview["previewId"])
        preview_root = self.store.root / "previews" / preview["previewId"]
        self.assertTrue((preview_root / "storage.json").is_file())

        installed = self.store.call("install_plugin", {"draftId": draft, "enabled": True, "grants": ["storage"]})["plugin"]

        self.assertTrue(installed["enabled"])
        self.assertEqual(installed["admission"]["status"], "passed")
        self.assertEqual(installed["contentDigest"], preview["contentDigest"])
        self.assertEqual(self.store.list_plugins()["previews"], [])
        self.assertFalse(preview_root.exists())
        self.assertEqual(self.store.get_plugin_runtime_status(draft)["status"], "installed")
        with self.assertRaises(ValueError):
            self.store.granted_permissions(draft, preview_session=preview["previewId"])
        self.assertEqual(self.store.invoke(installed["id"], "storage_get", {"key": "preview"}, lambda *_: self.fail(), plugin_session=installed["epoch"]), {"value": None})

    def test_changed_draft_after_passed_preview_cannot_install_enabled_or_write_registry_packages(self):
        draft = self.store.create_plugin_draft()["draftId"]
        preview = self.store.preview_plugin(draftId=draft, grants=["storage"])
        self.admit_preview(preview)
        self.store.write_plugin_file(draft, "main.js", "console.log('changed after admission');")

        with self.assertRaises(PermissionError):
            self.store.call("install_plugin", {"draftId": draft, "enabled": True, "grants": ["storage"]})

        self.assertFalse(self.store.registry_path.exists())
        self.assertFalse((self.store.root / "packages").exists())
        self.assertEqual(self.store.list_plugins()["plugins"], [])
        self.assertEqual(list(self.store.root.glob(".install-*")), [])

    def test_failed_upgrade_commit_preserves_old_manifest_package_and_rollback(self):
        first = self.install(enabled=True, grants=["storage"])["plugin"]
        self.install(package(manifest("2.0.0")), enabled=True)
        before = self.store.registry_path.read_bytes()
        old_html = self.store.asset("example.reader", "index.html")[0]
        self.admit_package(package(manifest("3.0.0"), extra={"new.js": "new"}), ["storage"])
        replace = os.replace
        def fail_registry(source, destination):
            if Path(destination) == self.store.registry_path:
                raise OSError("simulated disk failure")
            return replace(source, destination)
        with patch("plugin_store.os.replace", side_effect=fail_registry), self.assertRaises(OSError):
            self.install(package(manifest("3.0.0"), extra={"new.js": "new"}), enabled=True)
        self.assertEqual(self.store.registry_path.read_bytes(), before)
        current = self.store.list_plugins()["plugins"][0]
        self.assertEqual(current["version"], "2.0.0")
        self.assertTrue(current["can_rollback"])
        self.assertEqual(self.store.asset("example.reader", "index.html")[0], old_html)
        self.assertEqual(self.store.rollback_plugin("example.reader")["plugin"]["sha256"], first["sha256"])

    def test_failed_manifest_write_keeps_preview_and_original_file(self):
        draft = self.store.create_plugin_draft()["draftId"]
        preview = self.store.preview_plugin(draft)
        before = self.store.read_plugin_file(draft, "manifest.json")["content"]
        with patch("plugin_store.os.replace", side_effect=OSError("simulated disk failure")), self.assertRaises(OSError):
            self.store.write_plugin_file(draft, "manifest.json", "{}")
        self.assertEqual(self.store.read_plugin_file(draft, "manifest.json")["content"], before)
        self.assertEqual(self.store.list_plugins()["previews"][0]["previewId"], preview["previewId"])

    def test_disabled_and_uninstalled_plugins_reject_late_calls_and_keep_diagnostics(self):
        self.install(enabled=True, grants=["storage"])
        self.store.report_plugin_runtime_event("example.reader", "ready", "started", pluginSession=self.session())
        self.store.set_plugin_enabled("example.reader", False)
        with self.assertRaises(ValueError):
            self.store.invoke("example.reader", "storage_set", {"key": "late", "value": True}, lambda *_: self.fail())
        self.assertEqual(self.store.get_plugin_runtime_status("example.reader")["status"], "disabled")
        self.store.set_plugin_enabled("example.reader", True)
        self.store.uninstall_plugin("example.reader")
        with self.assertRaises(ValueError):
            self.store.invoke("example.reader", "storage_set", {"key": "late", "value": True}, lambda *_: self.fail())
        self.assertEqual(self.store.get_plugin_runtime_status("example.reader")["status"], "uninstalled")
        self.assertFalse((self.base / "library" / "plugin-data" / "example.reader" / "storage.json").exists())

    def test_runtime_error_or_failed_test_is_not_masked_by_late_ready(self):
        draft = self.store.create_plugin_draft()["draftId"]
        preview = self.store.preview_plugin(draft)
        session = preview["previewId"]
        self.store.report_plugin_runtime_event(draft, "error", "ReferenceError: missing", previewSession=session)
        with self.assertRaises(PermissionError):
            self.store.report_plugin_runtime_event(draft, "ready", "SDK connected", previewSession=session)
        status = self.store.get_plugin_runtime_status(draft)
        self.assertEqual(status["status"], "error")
        self.assertEqual(status["errorCount"], 1)
        preview = self.store.preview_plugin(draft)
        self.store.report_plugin_runtime_event(draft, "test", "round trip", {"passed": False}, previewSession=preview["previewId"])
        self.assertEqual(self.store.get_plugin_runtime_status(draft)["status"], "error")

    def test_github_downloader_uses_bounded_allowed_redirects_without_network(self):
        from urllib.request import Request
        data = package()
        class Response:
            def __enter__(self): return self
            def __exit__(self, *_): return False
            def geturl(self): return "https://codeload.github.com/example/repo/zip/" + "a" * 40
            def read(self, limit):
                self.limit = limit
                return data
        response = Response()
        class Opener:
            def open(self, request, timeout):
                self.request, self.timeout = request, timeout
                return response
        opener = Opener()
        url = "https://github.com/example/repo/archive/" + "a" * 40 + ".zip"
        with patch("plugin_store.build_opener", return_value=opener):
            self.assertEqual(self.store._download(url), data)
        self.assertEqual(opener.request.full_url, url)
        self.assertEqual(opener.timeout, 30)
        self.assertEqual(response.limit, 20 * 1024 * 1024 + 1)
        with self.assertRaises(ValueError):
            _GitHubRedirects().redirect_request(Request(url), None, 302, "redirect", {}, "http://127.0.0.1/private")

    def test_installed_sessions_rotate_across_every_lifecycle_transition(self):
        self.install(enabled=True, grants=["storage"])
        epochs = [self.session()]
        def old_requests_are_revoked():
            current = self.session()
            self.assertNotIn(current, epochs)
            for old in [None, *epochs]:
                with self.subTest(epoch=old), self.assertRaises(PermissionError):
                    self.store.invoke("example.reader", "storage_get", {"key": "note"}, lambda *_: self.fail(), plugin_session=old)
                with self.assertRaises(PermissionError):
                    self.store.granted_permissions("example.reader", plugin_session=old)
                with self.assertRaises(PermissionError):
                    self.store.report_plugin_runtime_event("example.reader", "error", "stale frame", pluginSession=old)
            self.assertEqual(self.store.invoke("example.reader", "storage_get", {"key": "note"}, lambda *_: self.fail(), plugin_session=current), {"value": None})
            epochs.append(current)
        self.store.set_plugin_enabled("example.reader", False)
        disabled_epoch = self.session()
        self.assertNotIn(disabled_epoch, epochs)
        self.store.set_plugin_enabled("example.reader", True)
        old_requests_are_revoked()
        self.store.set_plugin_enabled("example.reader", True)
        old_requests_are_revoked()
        self.install(package(manifest("2.0.0")), enabled=True)
        old_requests_are_revoked()
        self.store.rollback_plugin("example.reader")
        old_requests_are_revoked()
        self.store.uninstall_plugin("example.reader")
        self.install(enabled=True, grants=["storage"])
        old_requests_are_revoked()
        self.assertEqual(self.store.get_plugin_runtime_status("example.reader")["status"], "not-started")

    def test_installed_and_bundled_sessions_persist_across_store_restart(self):
        root = self.base / "bundled" / "vocabulary"
        root.mkdir(parents=True)
        (root / "manifest.json").write_text(json.dumps(manifest(plugin_id="guzi.vocabulary")))
        (root / "index.html").write_text("<h1>Words</h1>")
        self.install(enabled=True, grants=["storage"])
        before = {row["id"]: row["epoch"] for row in self.store.list_plugins()["plugins"]}
        restored = PluginStore(self.base / "state", self.base / "library", self.base / "bundled")
        after = {row["id"]: row["epoch"] for row in restored.list_plugins()["plugins"]}
        self.assertEqual(before, after)
        with self.assertRaises(PermissionError):
            restored.invoke("guzi.vocabulary", "storage_get", {"key": "note"}, lambda *_: self.fail())
        self.assertEqual(restored.invoke("guzi.vocabulary", "storage_get", {"key": "note"}, lambda *_: self.fail(), plugin_session=before["guzi.vocabulary"]), {"value": None})
        restored.set_plugin_enabled("guzi.vocabulary", True)
        with self.assertRaises(PermissionError):
            restored.invoke("guzi.vocabulary", "storage_get", {"key": "note"}, lambda *_: self.fail(), plugin_session=before["guzi.vocabulary"])

    def test_market_github_commit_without_checksum_and_release_with_checksum(self):
        commit_url = "https://github.com/example/plugin/archive/" + "a" * 40 + ".zip"
        commit_data = package()
        with patch.object(self.store, "_download", return_value=commit_data) as download:
            result = self.store.call("install_plugin", {"githubUrl": commit_url, "enabled": False, "grants": []})
            download.assert_called_once_with(commit_url)
        self.assertEqual(result["plugin"]["sha256"], hashlib.sha256(commit_data).hexdigest())
        self.assertFalse(result["plugin"]["enabled"])
        release_url = "https://github.com/example/plugin/releases/download/v2.0.0/plugin.zip"
        release_data = package(manifest("2.0.0"))
        with patch.object(self.store, "_download", return_value=release_data) as download:
            with self.assertRaises(ValueError):
                self.store.call("install_plugin", {"githubUrl": release_url})
            download.assert_not_called()
            result = self.store.call("install_plugin", {"githubUrl": release_url, "sha256": hashlib.sha256(release_data).hexdigest().upper()})
            download.assert_called_once_with(release_url)
        self.assertEqual(result["plugin"]["source"], {"kind": "github", "url": release_url})
        self.assertEqual(result["plugin"]["version"], "2.0.0")

    def test_slow_remote_download_does_not_block_plugin_listing(self):
        started = threading.Event()
        release = threading.Event()
        listed = threading.Event()
        url = "https://github.com/example/plugin/archive/" + "a" * 40 + ".zip"
        def download(_url):
            started.set()
            if not release.wait(5):
                raise TimeoutError("test download was not released")
            return package()
        def list_plugins():
            result = self.store.list_plugins()
            listed.set()
            return result
        with patch.object(self.store, "_download", side_effect=download), ThreadPoolExecutor(max_workers=2) as pool:
            installing = pool.submit(self.store.install_plugin, githubUrl=url)
            try:
                self.assertTrue(started.wait(2), "download must start")
                listing = pool.submit(list_plugins)
                self.assertTrue(listed.wait(1), "plugin listing must finish while the download is blocked")
                self.assertEqual(listing.result()["plugins"], [])
            finally:
                release.set()
            self.assertEqual(installing.result(timeout=5)["plugin"]["id"], "example.reader")

    def test_concurrent_remote_installs_preserve_both_registry_entries(self):
        urls = ["https://github.com/example/plugin/archive/" + digit * 40 + ".zip" for digit in ("a", "b")]
        started = {url: threading.Event() for url in urls}
        release = threading.Event()
        packages = {url: package(manifest(plugin_id=plugin_id)) for url, plugin_id in zip(urls, ("example.first", "example.second"), strict=True)}
        def download(url):
            started[url].set()
            if not release.wait(5):
                raise TimeoutError("test download was not released")
            return packages[url]
        with patch.object(self.store, "_download", side_effect=download), ThreadPoolExecutor(max_workers=2) as pool:
            installing = [pool.submit(self.store.install_plugin, githubUrl=url) for url in urls]
            try:
                for url in urls:
                    self.assertTrue(started[url].wait(2), "both downloads must start before either finishes")
            finally:
                release.set()
            self.assertEqual({future.result(timeout=5)["plugin"]["id"] for future in installing}, {"example.first", "example.second"})
        self.assertEqual({row["id"] for row in self.store.list_plugins()["plugins"]}, {"example.first", "example.second"})
        restored = PluginStore(self.base / "state", self.base / "library", self.base / "bundled")
        self.assertEqual({row["id"] for row in restored.list_plugins()["plugins"]}, {"example.first", "example.second"})

    def test_remote_download_failure_preserves_registry(self):
        self.install(grants=["storage"])
        before = self.store.registry_path.read_bytes()
        url = "https://github.com/example/plugin/archive/" + "a" * 40 + ".zip"
        with patch.object(self.store, "_download", side_effect=OSError("download failed")), self.assertRaisesRegex(OSError, "download failed"):
            self.store.install_plugin(githubUrl=url)
        self.assertEqual(self.store.registry_path.read_bytes(), before)

    def test_remote_install_rechecks_grants_after_uninstall_and_reinstall(self):
        previous = self.install(enabled=True, grants=["storage"])["plugin"]
        started = threading.Event()
        release = threading.Event()
        replaced = threading.Event()
        url = "https://github.com/example/plugin/archive/" + "a" * 40 + ".zip"
        def download(_url):
            started.set()
            if not release.wait(5):
                raise TimeoutError("test download was not released")
            return package(manifest("2.0.0"))
        def replace():
            self.store.uninstall_plugin("example.reader")
            result = self.install(grants=[])["plugin"]
            replaced.set()
            return result
        with patch.object(self.store, "_download", side_effect=download), ThreadPoolExecutor(max_workers=2) as pool:
            installing = pool.submit(self.store.install_plugin, githubUrl=url, enabled=True)
            try:
                self.assertTrue(started.wait(2), "download must start")
                replacing = pool.submit(replace)
                self.assertTrue(replaced.wait(1), "uninstall and reinstall must finish while the download is blocked")
                current = replacing.result(timeout=5)
                self.assertNotEqual(current["epoch"], previous["epoch"])
            finally:
                release.set()
            with self.assertRaisesRegex(ValueError, "授权"):
                installing.result(timeout=5)
        installed = self.store.list_plugins()["plugins"][0]
        self.assertEqual(installed["version"], "1.0.0")
        self.assertEqual(installed["epoch"], current["epoch"])
        self.assertEqual(installed["grants"], [])
        self.assertFalse(installed["enabled"])

    def test_lifecycle_and_failed_commits_preserve_plugin_storage_and_library_bytes(self):
        self.install(enabled=True, grants=["storage"])
        self.invoke("example.reader", "storage_set", {"key": "progress", "value": {"page": 32, "terms": ["durable"]}}, lambda *_: self.fail())
        paths = [self.base / "library" / "plugin-data" / "example.reader" / "storage.json"]
        for filename in ("library.json", "vocabulary.json"):
            path = self.base / "library" / filename
            path.write_text(json.dumps({"sentinel": filename}), "utf-8")
            paths.append(path)
        original = {path: path.read_bytes() for path in paths}
        def assert_data_untouched():
            self.assertEqual({path: path.read_bytes() for path in paths}, original)
        self.install(package(manifest("2.0.0")), enabled=True)
        assert_data_untouched()
        replace = os.replace
        def fail_registry(source, destination):
            if Path(destination) == self.store.registry_path:
                raise OSError("simulated registry failure")
            return replace(source, destination)
        operations = (
            lambda: self.install(package(manifest("3.0.0")), enabled=True),
            lambda: self.store.rollback_plugin("example.reader"),
            lambda: self.store.uninstall_plugin("example.reader"),
        )
        self.admit_package(package(manifest("3.0.0")), ["storage"])
        registry_before = self.store.registry_path.read_bytes()
        for operation in operations:
            with self.subTest(operation=operation), patch("plugin_store.os.replace", side_effect=fail_registry), self.assertRaises(OSError):
                operation()
            assert_data_untouched()
            self.assertEqual(self.store.registry_path.read_bytes(), registry_before)
        self.store.rollback_plugin("example.reader")
        assert_data_untouched()
        self.store.uninstall_plugin("example.reader")
        assert_data_untouched()
        self.install(enabled=True, grants=["storage"])
        assert_data_untouched()
        value = self.invoke("example.reader", "storage_get", {"key": "progress"}, lambda *_: self.fail())
        self.assertEqual(value["value"], {"page": 32, "terms": ["durable"]})

    def test_mcp_plugin_manage_cannot_grant_write_scope_through_preview_or_enable(self):
        allowed = ["library.read", "plugins.manage"]
        draft = self.store.create_plugin_draft()["draftId"]
        permissions = ["library.read", "library.write", "storage"]
        self.store.write_plugin_file(draft, "manifest.json", json.dumps(manifest(permissions=permissions)))
        with self.assertRaises(PermissionError):
            self.store.call("preview_plugin", {"draftId": draft, "grants": permissions}, allowed_permissions=allowed)
        self.assertEqual(self.store.list_plugins()["previews"], [])
        with self.assertRaises(PermissionError):
            self.store.call("install_plugin", {"draftId": draft, "grants": permissions, "enabled": True}, allowed_permissions=allowed)
        self.assertEqual(self.store.list_plugins()["plugins"], [])
        self.store.call("install_plugin", {"draftId": draft, "grants": permissions, "enabled": False}, allowed_permissions=allowed)
        before = self.store.registry_path.read_bytes()
        for args in ({"pluginId": "example.reader", "enabled": True},
                     {"pluginId": "example.reader", "enabled": True, "grants": permissions}):
            with self.subTest(args=args), self.assertRaises(PermissionError):
                self.store.call("set_plugin_enabled", args, allowed_permissions=allowed)
        self.assertEqual(self.store.registry_path.read_bytes(), before)
        with self.assertRaises(ValueError):
            self.store.call("set_plugin_enabled", {"pluginId": "example.reader", "enabled": True, "_allowed_permissions": None}, allowed_permissions=allowed)

    def test_mcp_rollback_checks_inherited_grants_and_allows_revocation(self):
        allowed = ["library.read", "plugins.manage"]
        permissions = ["notes.write", "storage"]
        self.install(package(manifest(permissions=permissions)), enabled=True, grants=permissions)
        self.install(package(manifest("2.0.0", permissions)), enabled=True)
        before = self.store.registry_path.read_bytes()
        with self.assertRaises(PermissionError):
            self.store.call("rollback_plugin", {"pluginId": "example.reader"}, allowed_permissions=allowed)
        self.assertEqual(self.store.registry_path.read_bytes(), before)
        self.store.call("set_plugin_enabled", {"pluginId": "example.reader", "enabled": False}, allowed_permissions=allowed)
        rolled = self.store.call("rollback_plugin", {"pluginId": "example.reader"}, allowed_permissions=allowed)
        self.assertFalse(rolled["plugin"]["enabled"])
        with self.assertRaises(PermissionError):
            self.store.call("set_plugin_enabled", {"pluginId": "example.reader", "enabled": True}, allowed_permissions=allowed)
        self.assertTrue(self.store.call("uninstall_plugin", {"pluginId": "example.reader"}, allowed_permissions=allowed)["uninstalled"])

    def test_mcp_read_scopes_allow_local_sdk_permissions_and_ui_is_unrestricted(self):
        allowed = ["library.read", "plugins.manage"]
        permissions = ["library.read", "storage", "reader.open"]
        draft = self.store.create_plugin_draft()["draftId"]
        self.store.write_plugin_file(draft, "manifest.json", json.dumps(manifest(permissions=permissions)))
        preview = self.store.call("preview_plugin", {"draftId": draft, "grants": permissions}, allowed_permissions=allowed)
        self.assertEqual(set(preview["grants"]), set(permissions))
        self.admit_preview(preview)
        installed = self.store.call("install_plugin", {"draftId": draft, "grants": permissions, "enabled": True}, allowed_permissions=allowed)
        self.assertTrue(installed["plugin"]["enabled"])
        self.assertEqual(self.invoke("example.reader", "open_source", {"source": {}}, lambda *_: self.fail()), {"authorized": True})
        self.install(package(manifest("2.0.0", ["library.write"])), grants=["library.write"])
        self.admit_installed()
        enabled = self.store.call("set_plugin_enabled", {"pluginId": "example.reader", "enabled": True})
        self.assertTrue(enabled["plugin"]["enabled"])

    def test_packaged_template_root_is_independent_of_python_module_location(self):
        template_root = self.base / "app-resources" / "plugin_templates" / "starter"
        template_root.mkdir(parents=True)
        templates = {"index.html": "<!doctype html><script src='main.js'></script>",
                     "main.js": "console.log('packaged template');", "styles.css": "body { color: green; }"}
        for name, content in templates.items():
            (template_root / name).write_text(content, "utf-8")
        with patch("plugin_store.__file__", str(self.base / "python-server" / "_internal" / "plugin_store.py")):
            packaged = PluginStore(self.base / "packaged-state", self.base / "library", self.base / "bundled", template_root=template_root)
            self.assertEqual(packaged.get_plugin_sdk()["template"], templates)
            draft = packaged.create_plugin_draft()["draftId"]
            self.assertEqual(packaged.read_plugin_file(draft, "main.js")["content"], templates["main.js"])
            self.assertTrue(packaged.validate_plugin(draft)["valid"])

    def test_missing_packaged_templates_fail_without_creating_empty_draft(self):
        packaged = PluginStore(self.base / "packaged-state", self.base / "library", self.base / "bundled", template_root=self.base / "missing-templates")
        with self.assertRaisesRegex(ValueError, "插件模板资源缺失"):
            packaged.get_plugin_sdk()
        with self.assertRaisesRegex(ValueError, "插件模板资源缺失"):
            packaged.create_plugin_draft()
        self.assertFalse((packaged.root / "drafts").exists())

    def test_every_activation_path_requires_host_admission(self):
        raw = base64.b64encode(package()).decode()
        with self.assertRaises(PermissionError):
            self.store.install_plugin(packageBase64=raw, grants=["storage"], enabled=True)
        self.assertEqual(self.store.list_plugins()["plugins"], [])
        installed = self.store.install_plugin(packageBase64=raw, grants=["storage"])["plugin"]
        self.assertEqual(installed["admission"]["status"], "required")
        with self.assertRaises(PermissionError):
            self.store.set_plugin_enabled("example.reader", True)
        self.admit_installed()
        self.store.set_plugin_enabled("example.reader", True)
        before = self.store.registry_path.read_bytes()
        with self.assertRaises(PermissionError):
            self.store.install_plugin(packageBase64=base64.b64encode(package(manifest("2.0.0"))).decode(), enabled=True)
        self.assertEqual(self.store.registry_path.read_bytes(), before)
        self.install(package(manifest("2.0.0")), enabled=True)
        records = self.store._admission_records()
        old_key = self.store._admission_key(installed["contentDigest"], ["storage"])
        records.pop(old_key)
        self.store.admission_path.write_text(json.dumps(records))
        before = self.store.registry_path.read_bytes()
        with self.assertRaises(PermissionError):
            self.store.rollback_plugin("example.reader")
        self.assertEqual(self.store.registry_path.read_bytes(), before)
        self.store.set_plugin_enabled("example.reader", False)
        rolled = self.store.rollback_plugin("example.reader")["plugin"]
        self.assertFalse(rolled["enabled"])
        self.assertEqual(rolled["admission"]["status"], "required")

    def test_plugin_or_mcp_self_reports_cannot_issue_admission(self):
        draft = self.store.create_plugin_draft()["draftId"]
        preview = self.store.preview_plugin(draftId=draft, grants=["storage"])
        arguments = {"pluginId": draft, "level": "ready", "message": "forged", "previewSession": preview["previewId"]}
        self.assertNotIn("report_plugin_runtime_event", {tool["name"] for tool in self.store.tools()})
        with self.assertRaises(ValueError):
            self.store.call("report_plugin_runtime_event", arguments)
        with self.assertRaises(ValueError):
            self.store.call("complete_plugin_admission", {"pluginId": draft, "previewSession": preview["previewId"], "checks": {check: True for check in ADMISSION_CHECKS}})
        self.store.report_plugin_runtime_event(**arguments)
        self.store.report_plugin_runtime_event(draft, "test", "self-asserted", {"passed": True}, previewSession=preview["previewId"])
        status = self.store.get_plugin_runtime_status(draft)
        self.assertEqual(status["status"], "ready")
        self.assertEqual(status["admission"]["status"], "required")
        with self.assertRaises(PermissionError):
            self.store.install_plugin(draftId=draft, enabled=True, grants=["storage"])
        checks = {check: True for check in ADMISSION_CHECKS}
        checks["processIsolation"] = 1
        with self.assertRaises(PermissionError):
            self.store.complete_plugin_admission(draft, preview["previewId"], checks)
        self.assertEqual(self.store.get_plugin_runtime_status(draft)["admission"]["status"], "failed")
        self.assertFalse(self.store.admission_path.exists())

    def test_admission_rejects_failed_runtime_stale_session_and_partial_grants(self):
        draft = self.store.create_plugin_draft()["draftId"]
        first = self.store.preview_plugin(draftId=draft)
        second = self.store.preview_plugin(draftId=draft, grants=["storage"])
        checks = {check: True for check in ADMISSION_CHECKS}
        with self.assertRaises(PermissionError):
            self.store.complete_plugin_admission(draft, first["previewId"], checks)
        self.store.report_plugin_runtime_event(draft, "ready", "connected", previewSession=second["previewId"])
        self.store.report_plugin_runtime_event(draft, "test", "failed", {"passed": False}, previewSession=second["previewId"])
        with self.assertRaises(PermissionError):
            self.store.complete_plugin_admission(draft, second["previewId"], checks)
        partial = self.store.preview_plugin(draftId=draft)
        self.store.report_plugin_runtime_event(draft, "ready", "connected", previewSession=partial["previewId"])
        with self.assertRaises(PermissionError):
            self.store.complete_plugin_admission(draft, partial["previewId"], checks)

    def test_admission_binds_content_grants_policy_and_survives_restart(self):
        installed = self.install(enabled=True, grants=["storage"])["plugin"]
        root = self.store._entries()["example.reader"]["_root"]
        self.assertEqual(self.store._admission({"grants": []}, root)["status"], "required")
        with patch("plugin_store.ADMISSION_POLICY_VERSION", 2):
            self.assertFalse(self.store.list_plugins()["plugins"][0]["enabled"])
            with self.assertRaises(PermissionError):
                self.invoke("example.reader", "storage_get", {"key": "x"}, lambda *_: self.fail())
        restored = PluginStore(self.base / "state", self.base / "library", self.base / "bundled")
        self.assertEqual(restored.list_plugins()["plugins"][0]["admission"]["status"], "passed")
        (root / "index.html").write_text("changed")
        row = self.store.list_plugins()["plugins"][0]
        self.assertFalse(row["enabled"])
        self.assertEqual(row["admission"]["status"], "required")
        with self.assertRaises(PermissionError):
            self.store.asset("example.reader", "index.html")
        with self.assertRaises(PermissionError):
            self.store.invoke("example.reader", "storage_get", {"key": "x"}, lambda *_: self.fail(), plugin_session=installed["epoch"])

    def test_legacy_enabled_registry_does_not_execute_without_admission(self):
        self.install(grants=["storage"])
        registry = self.store._load()
        registry["plugins"]["example.reader"]["enabled"] = True
        registry["plugins"]["example.reader"].pop("contentDigest", None)
        self.store.registry_path.write_text(json.dumps(registry))
        restored = PluginStore(self.base / "state", self.base / "library", self.base / "bundled")
        row = restored.list_plugins()["plugins"][0]
        self.assertFalse(row["enabled"])
        self.assertEqual(row["admission"]["status"], "required")
        with self.assertRaises(PermissionError):
            restored.asset("example.reader", "index.html")

    def test_preview_snapshot_and_admission_are_invalidated_by_draft_changes(self):
        draft = self.store.create_plugin_draft()["draftId"]
        preview = self.store.preview_plugin(draftId=draft, grants=["storage"])
        before = self.store.asset(draft, f"__preview/{preview['previewId']}/main.js")[0]
        snapshot = self.store.root / "previews" / preview["previewId"] / "package"
        self.assertEqual((snapshot / "main.js").read_bytes(), before)
        self.store.report_plugin_runtime_event(draft, "ready", "connected", previewSession=preview["previewId"])
        (self.store._draft(draft) / "main.js").write_text("changed outside authoring API")
        self.assertEqual((snapshot / "main.js").read_bytes(), before)
        with self.assertRaises(PermissionError):
            self.store.asset(draft, f"__preview/{preview['previewId']}/main.js")
        with self.assertRaises(PermissionError):
            self.store.complete_plugin_admission(draft, preview["previewId"], {check: True for check in ADMISSION_CHECKS})
        self.assertEqual(self.store.get_plugin_runtime_status(draft)["admission"]["status"], "required")

    def test_preview_storage_and_write_capabilities_cannot_touch_user_data(self):
        permissions = ["storage", "library.read", "library.write", "notes.read", "notes.write", "vocabulary.read", "vocabulary.write", "ai.translate", "reader.open"]
        self.install(package(manifest(permissions=permissions)), enabled=True, grants=permissions)
        self.invoke("example.reader", "storage_set", {"key": "value", "value": "user"}, lambda *_: self.fail())
        paths = [self.base / "library" / "plugin-data" / "example.reader" / "storage.json"]
        for filename in ("library.json", "notes.md", "vocabulary.json"):
            path = self.base / "library" / filename
            path.write_text("user sentinel")
            paths.append(path)
        before = {path: path.read_bytes() for path in paths}
        preview = self.store.preview_plugin(pluginId="example.reader", grants=permissions)
        self.assertEqual(preview["sourcePluginId"], "example.reader")
        self.assertEqual(preview["draftId"], preview["pluginId"])
        def invoke(name, args=None):
            return self.store.invoke(preview["pluginId"], name, args or {}, lambda *_: self.fail("Preview escaped into real mutation"), preview_session=preview["previewId"])
        self.assertEqual(invoke("storage_get", {"key": "value"}), {"value": None})
        invoke("storage_set", {"key": "value", "value": "sandbox"})
        self.assertEqual(invoke("storage_get", {"key": "value"}), {"value": "sandbox"})
        for name in ("create_folder", "save_notes", "vocabulary_save", "vocabulary_explain", "translate_text", "open_source"):
            with self.subTest(name=name), self.assertRaises(PermissionError):
                invoke(name)
        self.assertEqual({path: path.read_bytes() for path in paths}, before)
        seen = []
        self.store.invoke(preview["pluginId"], "search_library", {}, lambda *args: seen.append(args), preview_session=preview["previewId"])
        self.assertEqual(seen, [("search_library", {})])
        next_preview = self.store.preview_plugin(draftId=preview["draftId"], grants=permissions)
        self.assertEqual(self.store.invoke(next_preview["pluginId"], "storage_get", {"key": "value"}, lambda *_: self.fail(), preview_session=next_preview["previewId"]), {"value": None})

    def test_content_digest_ignores_zip_metadata_and_binds_paths(self):
        first = self.install(package())["plugin"]
        draft = "draft-" + uuid.uuid4().hex
        root = self.store.root / "drafts" / draft
        root.mkdir(parents=True)
        self.store._extract(package(prefix="wrapper/"), root)
        self.assertEqual(self.store.validate_plugin(draft)["contentDigest"], first["contentDigest"])
        (root / "extra.js").write_text("same bytes")
        before = self.store.validate_plugin(draft)["contentDigest"]
        (root / "extra.js").rename(root / "renamed.js")
        self.assertNotEqual(self.store.validate_plugin(draft)["contentDigest"], before)

    def test_installed_runtime_failure_revokes_certificate_disables_and_rotates_session(self):
        for level, details in (("error", None), ("test", {"passed": False})):
            with self.subTest(level=level):
                installed = self.install(enabled=True, grants=["storage"])["plugin"]
                self.invoke("example.reader", "storage_set", {"key": "durable", "value": "user data"}, lambda *_: self.fail())
                path = self.base / "library" / "plugin-data" / "example.reader" / "storage.json"
                before = path.read_bytes()
                self.store.report_plugin_runtime_event("example.reader", level, "Watchdog failure", details, pluginSession=installed["epoch"])
                row = self.store.list_plugins()["plugins"][0]
                self.assertFalse(row["enabled"])
                self.assertNotEqual(row["epoch"], installed["epoch"])
                self.assertNotEqual(row["admission"]["status"], "passed")
                self.assertEqual(row["admission"]["status"], "failed")
                runtime = self.store.get_plugin_runtime_status("example.reader")
                self.assertEqual(runtime["status"], "error")
                self.assertEqual(runtime["admission"]["status"], "failed")
                with self.assertRaises(PermissionError):
                    self.store.set_plugin_enabled("example.reader", True)
                with self.assertRaises(ValueError):
                    self.store.invoke("example.reader", "storage_get", {"key": "durable"}, lambda *_: self.fail(), plugin_session=installed["epoch"])
                restored = PluginStore(self.base / "state", self.base / "library", self.base / "bundled")
                with self.assertRaises(PermissionError):
                    restored.set_plugin_enabled("example.reader", True)
                self.assertEqual(path.read_bytes(), before)

    def test_preview_failure_revokes_issued_certificate_and_cannot_recover_old_session(self):
        draft = self.store.create_plugin_draft()["draftId"]
        first = self.store.preview_plugin(draftId=draft, grants=["storage"])
        self.admit_preview(first)
        self.assertEqual(self.store.get_plugin_runtime_status(draft)["admission"]["status"], "passed")
        self.store.report_plugin_runtime_event(draft, "error", "Renderer terminated", previewSession=first["previewId"])
        for call in (
                lambda: self.store.report_plugin_runtime_event(draft, "ready", "late ready", previewSession=first["previewId"]),
                lambda: self.store.granted_permissions(draft, preview_session=first["previewId"]),
                lambda: self.store.invoke(draft, "storage_get", {"key": "x"}, lambda *_: self.fail(), preview_session=first["previewId"]),
                lambda: self.store.complete_plugin_admission(draft, first["previewId"], {check: True for check in ADMISSION_CHECKS}),
                lambda: self.store.install_plugin(draftId=draft, grants=["storage"], enabled=True)):
            with self.assertRaises(PermissionError):
                call()
        self.assertEqual(self.store.get_plugin_runtime_status(draft)["admission"]["status"], "failed")
        second = self.store.preview_plugin(draftId=draft, grants=["storage"])
        self.assertEqual(self.store.get_plugin_runtime_status(draft)["admission"]["status"], "required")
        self.admit_preview(second)
        self.store.install_plugin(draftId=draft, grants=["storage"], enabled=True)

    def test_failed_host_checks_on_new_preview_revoke_previous_certificate(self):
        draft = self.store.create_plugin_draft()["draftId"]
        first = self.store.preview_plugin(draftId=draft, grants=["storage"])
        self.admit_preview(first)
        installed = self.store.install_plugin(draftId=draft, grants=["storage"])["plugin"]
        before = self.store.registry_path.read_bytes()
        second = self.store.preview_plugin(draftId=draft, grants=["storage"])
        self.assertEqual(second["contentDigest"], first["contentDigest"])
        self.store.report_plugin_runtime_event(draft, "ready", "connected", previewSession=second["previewId"])
        checks = {check: True for check in ADMISSION_CHECKS}
        checks["hostResponsive"] = False

        with self.assertRaises(PermissionError):
            self.store.complete_plugin_admission(draft, second["previewId"], checks)
        self.assertEqual(self.store.get_plugin_runtime_status(draft)["admission"]["status"], "failed")
        for operation in (
                lambda: self.store.call("install_plugin", {"draftId": draft, "enabled": True, "grants": ["storage"]}),
                lambda: self.store.call("set_plugin_enabled", {"pluginId": installed["id"], "enabled": True})):
            with self.assertRaises(PermissionError):
                operation()
        self.assertEqual(self.store.registry_path.read_bytes(), before)
        self.assertEqual(self.store.list_plugins()["plugins"][0]["epoch"], installed["epoch"])
        self.store.stop_plugin_preview(draft, second["previewId"])
        restored = PluginStore(self.base / "state", self.base / "library", self.base / "bundled")
        with self.assertRaises(PermissionError):
            restored.set_plugin_enabled(installed["id"], True)

    def test_stale_error_cannot_revoke_a_new_preview_or_installed_epoch(self):
        installed = self.install(enabled=True, grants=["storage"])["plugin"]
        current = self.store.set_plugin_enabled("example.reader", True)["plugin"]
        with self.assertRaises(PermissionError):
            self.store.report_plugin_runtime_event("example.reader", "error", "stale watchdog", pluginSession=installed["epoch"])
        row = self.store.list_plugins()["plugins"][0]
        self.assertTrue(row["enabled"])
        self.assertEqual(row["epoch"], current["epoch"])
        self.assertEqual(row["admission"]["status"], "passed")
        first = self.store.preview_plugin(pluginId="example.reader", grants=["storage"])
        second = self.store.preview_plugin(draftId=first["draftId"], grants=["storage"])
        self.admit_preview(second)
        with self.assertRaises(PermissionError):
            self.store.report_plugin_runtime_event(first["pluginId"], "error", "old preview watchdog", previewSession=first["previewId"])
        self.assertEqual(self.store.get_plugin_runtime_status(second["pluginId"])["admission"]["status"], "passed")

    def test_preview_session_files_are_removed_on_retirement_or_expiry(self):
        draft = self.store.create_plugin_draft()["draftId"]
        first = self.store.preview_plugin(draftId=draft, grants=["storage"])
        root = self.store.root / "previews"
        first_root = root / first["previewId"]
        self.assertTrue(first_root.is_dir())
        second = self.store.preview_plugin(draftId=draft, grants=["storage"])
        self.assertFalse(first_root.exists())
        self.store.stop_plugin_preview(draft, second["previewId"])
        self.assertFalse((root / second["previewId"]).exists())
        third = self.store.preview_plugin(draftId=draft, grants=["storage"])
        self.store.write_plugin_file(draft, "main.js", "updated")
        self.assertFalse((root / third["previewId"]).exists())
        fourth = self.store.preview_plugin(draftId=draft, grants=["storage"])
        with patch("plugin_store.time.time", return_value=fourth["createdAtUnix"] + 1801):
            self.assertEqual(self.store.get_plugin_runtime_status(draft)["status"], "expired")
        self.assertFalse((root / fourth["previewId"]).exists())
        orphan = root / uuid.uuid4().hex
        orphan.mkdir()
        os.utime(orphan, (1, 1))
        self.store.list_plugins()
        self.assertFalse(orphan.exists())
        self.assertTrue(self.store._draft(draft).is_dir())

    def test_preview_limit_rejects_before_copying_and_releases_on_stop(self):
        self.install(grants=["storage"])
        drafts = [self.store.create_plugin_draft()["draftId"] for _ in range(MAX_ACTIVE_PREVIEWS + 1)]
        active = [self.store.preview_plugin(draftId=draft) for draft in drafts[:-1]]
        before = {path.relative_to(self.store.root).as_posix() for path in self.store.root.rglob("*")}
        for args in ({"draftId": drafts[-1]}, {"pluginId": "example.reader"}):
            with self.subTest(args=args), self.assertRaisesRegex(ValueError, "stop_plugin_preview"):
                self.store.preview_plugin(**args)
        self.assertEqual({path.relative_to(self.store.root).as_posix() for path in self.store.root.rglob("*")}, before)
        replacement = self.store.preview_plugin(draftId=drafts[0])
        self.assertNotEqual(replacement["previewId"], active[0]["previewId"])
        self.assertEqual(len(self.store.list_plugins()["previews"]), MAX_ACTIVE_PREVIEWS)
        self.store.stop_plugin_preview(drafts[0], replacement["previewId"])
        self.store.preview_plugin(draftId=drafts[-1])
        self.assertEqual(len(self.store.list_plugins()["previews"]), MAX_ACTIVE_PREVIEWS)
        self.assertEqual(self.store.get_plugin_sdk()["limits"]["activePreviews"], MAX_ACTIVE_PREVIEWS)

    def test_runtime_failure_badge_does_not_survive_a_new_installed_epoch(self):
        installed = self.install(enabled=True, grants=["storage"])["plugin"]
        self.store.report_plugin_runtime_event("example.reader", "error", "watchdog", pluginSession=installed["epoch"])
        self.assertEqual(self.store.list_plugins()["plugins"][0]["admission"]["status"], "failed")
        self.admit_installed()
        enabled = self.store.set_plugin_enabled("example.reader", True)["plugin"]
        self.assertEqual(enabled["admission"]["status"], "passed")
        with self.assertRaises(PermissionError):
            self.store.report_plugin_runtime_event("example.reader", "error", "stale watchdog", pluginSession=installed["epoch"])
        self.assertEqual(self.store.list_plugins()["plugins"][0]["admission"]["status"], "passed")
        self.assertEqual(self.store.get_plugin_runtime_status("example.reader")["admission"]["status"], "passed")


if __name__ == "__main__":
    unittest.main()
