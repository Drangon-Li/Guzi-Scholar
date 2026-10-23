"""Versioned plugin packages, explicit grants, and bounded authoring workspaces."""

from __future__ import annotations

import base64
import binascii
import copy
import hashlib
import io
import json
import mimetypes
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import tempfile
import threading
import time
import unicodedata
from datetime import datetime, timezone
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener
import uuid
import zipfile


PERMISSIONS = {
    "library.read", "library.write", "notes.read", "notes.write",
    "vocabulary.read", "vocabulary.write", "ai.translate", "reader.open", "storage",
}
CAPABILITY_PERMISSIONS = {
    **{name: "library.read" for name in ("search_library", "get_document", "get_document_content", "list_folders", "list_properties")},
    **{name: "library.write" for name in ("create_folder", "set_document_folders", "set_document_properties", "update_document_metadata")},
    "get_notes": "notes.read", "save_notes": "notes.write",
    "vocabulary_list": "vocabulary.read",
    "vocabulary_save": "vocabulary.write",
    "vocabulary_update": "vocabulary.write",
    "vocabulary_delete": "vocabulary.write",
    "vocabulary_review": "vocabulary.write",
    "vocabulary_explain": "vocabulary.write",
    "translate_text": "ai.translate", "open_source": "reader.open",
    "storage_get": "storage", "storage_set": "storage", "storage_remove": "storage",
    "storage.get": "storage", "storage.set": "storage", "storage.remove": "storage",
}
MAX_FILE = 2 * 1024 * 1024
MAX_PACKAGE = 20 * 1024 * 1024
MAX_FILES = 512
MAX_STORAGE = 1024 * 1024
PLUGIN_ID = re.compile(r"[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+\Z")
VERSION = re.compile(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\Z")
ADMISSION_POLICY_VERSION = 1
ADMISSION_CHECKS = {"processIsolation", "sdkHandshake", "runtimeStable", "hostResponsive", "capabilityBoundary", "previewWriteIsolation"}
PREVIEW_READ_PERMISSIONS = {"library.read", "notes.read", "vocabulary.read"}
PREVIEW_TTL_SECONDS = 30 * 60
MAX_ACTIVE_PREVIEWS = 4


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _json_bytes(value):
    return json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False).encode("utf-8")


def _atomic_json(path, value):
    data = _json_bytes(value)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".plugin-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _relative(value):
    if not isinstance(value, str) or not value or "\\" in value or "\0" in value:
        raise ValueError("插件路径必须是相对路径。")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in value.split("/")) or ":" in value:
        raise ValueError("插件路径不能越过插件目录。")
    return path


def _safe_file(root, relative):
    parts = _relative(relative).parts
    current = Path(root)
    if current.is_symlink():
        raise ValueError("插件目录不允许符号链接。")
    for part in parts:
        current = current / part
        if current.is_symlink():
            raise ValueError("插件文件不允许符号链接。")
    if not current.resolve().is_relative_to(Path(root).resolve()):
        raise ValueError("插件路径不能越过插件目录。")
    return current


def _manifest(value):
    if not isinstance(value, dict):
        raise ValueError("manifest 必须是 JSON 对象。")
    if not isinstance(value.get("id"), str) or len(value["id"]) > 100 or not PLUGIN_ID.fullmatch(value["id"]):
        raise ValueError("插件 id 必须为小写的域名式标识，例如 guzi.my-plugin。")
    if re.fullmatch(r"draft-[0-9a-f]{32}", value["id"]):
        raise ValueError("插件 id 不能占用作者草稿的保留标识。")
    for key, limit in (("name", 120), ("version", 120), ("entry", 200)):
        if not isinstance(value.get(key), str) or not value[key].strip() or len(value[key]) > limit:
            raise ValueError(f"manifest.{key} 无效。")
    if not VERSION.fullmatch(value["version"]):
        raise ValueError("插件 version 必须是 semver。")
    if "-" in value["version"].split("+", 1)[0]:
        prerelease = value["version"].split("+", 1)[0].split("-", 1)[1]
        if any(not part or (part.isdigit() and len(part) > 1 and part.startswith("0")) for part in prerelease.split(".")):
            raise ValueError("插件 semver 预发布版本标识无效。")
    if value.get("sdkVersion") != "1":
        raise ValueError("仅支持 sdkVersion '1'。")
    if _relative(value["entry"]).suffix.lower() != ".html":
        raise ValueError("插件 entry 必须是 HTML 文件。")
    permissions = value.get("permissions")
    if not isinstance(permissions, list) or any(not isinstance(p, str) or p not in PERMISSIONS for p in permissions):
        raise ValueError("插件包含不支持的权限。")
    if len(set(permissions)) != len(permissions):
        raise ValueError("插件权限不能重复。")
    contributes = value.get("contributes", {})
    if not isinstance(contributes, dict) or set(contributes) - {"pages", "selectionActions"}:
        raise ValueError("插件 contributes 仅支持 pages 与 selectionActions。")
    for kind in ("pages", "selectionActions"):
        rows = contributes.get(kind, [])
        if not isinstance(rows, list) or len(rows) > 20:
            raise ValueError(f"{kind} 必须为最多 20 项的列表。")
        ids = set()
        for row in rows:
            if not isinstance(row, dict) or not isinstance(row.get("id"), str) or not re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", row["id"]):
                raise ValueError(f"{kind} 的 id 无效。")
            if row["id"] in ids or not isinstance(row.get("title"), str) or not 0 < len(row["title"]) <= 120:
                raise ValueError(f"{kind} 的标题或重复 id 无效。")
            if "icon" in row and (not isinstance(row["icon"], str) or len(row["icon"]) > 80):
                raise ValueError(f"{kind} 的 icon 无效。")
            ids.add(row["id"])
    return copy.deepcopy(value)


def _grants(value, manifest):
    if not isinstance(value, list) or any(not isinstance(p, str) or p not in manifest["permissions"] for p in value):
        raise ValueError("grants 必须仅包含此插件声明的权限。")
    return sorted(set(value))


def _limit_grants(grants, allowed_permissions):
    if allowed_permissions is None:
        return
    allowed = set(allowed_permissions) | {"storage", "reader.open"}
    denied = set(grants) - allowed
    if denied:
        raise PermissionError("MCP 未获准授予插件这些权限：" + ", ".join(sorted(denied)))


def _github_url(url, redirect=False):
    if not isinstance(url, str) or len(url) > 2048:
        raise ValueError("GitHub 下载地址无效。")
    parsed = urlparse(url)
    hosts = {"github.com", "codeload.github.com"}
    if redirect:
        hosts |= {"release-assets.githubusercontent.com", "objects.githubusercontent.com"}
    if parsed.scheme != "https" or parsed.hostname not in hosts or parsed.username or parsed.password or parsed.port not in {None, 443} or parsed.fragment:
        raise ValueError("插件下载仅支持受限的 GitHub HTTPS 地址。")
    if not redirect:
        commit = r"[0-9a-fA-F]{40}"
        valid = (
            parsed.hostname == "github.com" and re.fullmatch(rf"/[^/]+/[^/]+/archive/{commit}\.zip", parsed.path)
            or parsed.hostname == "codeload.github.com" and re.fullmatch(rf"/[^/]+/[^/]+/zip/{commit}", parsed.path)
            or parsed.hostname == "github.com" and re.fullmatch(r"/[^/]+/[^/]+/releases/download/[^/]+/[^/]+\.zip", parsed.path)
        )
        if not valid or parsed.query:
            raise ValueError("请使用固定 commit 的 zip 地址或附带 sha256 的 GitHub release zip。")
    return url


class _GitHubRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _github_url(newurl, redirect=True)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class PluginStore:
    def __init__(self, state_root, library_root, bundled_root, template_root=None):
        self.root = Path(state_root) / "plugins"
        self.library_root = Path(library_root)
        self.bundled_root = Path(bundled_root)
        self.template_root = Path(template_root) if template_root is not None else Path(__file__).parent / "plugin_templates" / "starter"
        self.registry_path = self.root / "registry.json"
        self.admission_path = self.root / "admissions.json"
        self.lock = threading.RLock()
        self.runtime = {}
        self.previews = {}
        self._digest_cache = {}

    def _content_digest(self, root, files=None):
        root = Path(root)
        paths = [(_safe_file(root, name), name) for name in files] if files is not None else [
            (_safe_file(root, path.relative_to(root).as_posix()), path.relative_to(root).as_posix())
            for path in sorted(root.rglob("*")) if not path.is_dir() or path.is_symlink()]
        signature = []
        for path, name in paths:
            if not path.is_file() or path.is_symlink():
                raise ValueError("插件包只能包含普通文件。")
            stat_value = path.stat()
            signature.append((name, stat_value.st_size, stat_value.st_mtime_ns, stat_value.st_ctime_ns, stat_value.st_ino))
        cached = self._digest_cache.get(str(root))
        if cached and cached[0] == signature:
            return cached[1]
        digest = hashlib.sha256()
        for path, name in paths:
            encoded = name.encode("utf-8")
            data = path.read_bytes()
            digest.update(len(encoded).to_bytes(8, "big"))
            digest.update(encoded)
            digest.update(len(data).to_bytes(8, "big"))
            digest.update(data)
        result = digest.hexdigest()
        self._digest_cache[str(root)] = (signature, result)
        return result

    def _admission_key(self, digest, grants):
        return hashlib.sha256(_json_bytes([ADMISSION_POLICY_VERSION, digest, sorted(grants)])).hexdigest()

    def _admission_records(self):
        if not self.admission_path.exists():
            return {}
        value = json.loads(self.admission_path.read_text("utf-8"))
        if not isinstance(value, dict):
            raise ValueError("插件验收记录损坏。")
        return value

    def _admission(self, entry, root, grants=None, digest=None):
        if entry.get("bundled"):
            return {"status": "passed", "source": "bundled", "policyVersion": ADMISSION_POLICY_VERSION}
        granted = entry["grants"] if grants is None else grants
        try:
            digest = digest or self._content_digest(root)
            record = self._admission_records().get(self._admission_key(digest, granted))
        except (OSError, ValueError):
            record = None
        if (isinstance(record, dict) and record.get("policyVersion") == ADMISSION_POLICY_VERSION
                and record.get("contentDigest") == digest and record.get("grants") == sorted(granted)
                and isinstance(record.get("checks"), dict)
                and set(record.get("checks", {})) == ADMISSION_CHECKS
                and all(value is True for value in record["checks"].values())):
            return {"status": "passed", **copy.deepcopy(record)}
        return {"status": "required", "policyVersion": ADMISSION_POLICY_VERSION, "contentDigest": digest, "grants": sorted(granted)}

    def _require_admission(self, entry, root, grants=None, validation=None):
        validation = validation or self._validate_root(root)
        admission = self._admission(entry, root, grants, validation["contentDigest"])
        if admission["status"] != "passed":
            raise PermissionError("插件尚未通过宿主独立验收；请预览并等待验收通过后再启用。")
        return admission

    def _remove_preview_files(self, session):
        root = self.root / "previews" / session
        if not re.fullmatch(r"[0-9a-f]{32}", session) or root.is_symlink():
            raise ValueError("预览临时目录无效。")
        if root.exists():
            shutil.rmtree(root)
        for key in list(self._digest_cache):
            if Path(key).is_relative_to(root):
                self._digest_cache.pop(key)

    def _discard_preview(self, plugin_id):
        preview = self.previews.pop(plugin_id, None)
        if preview:
            self._remove_preview_files(preview["previewId"])

    def _expire_previews(self):
        cutoff = time.time() - PREVIEW_TTL_SECONDS
        for plugin_id, preview in list(self.previews.items()):
            if preview["createdAtUnix"] < cutoff:
                self._discard_preview(plugin_id)
                self._runtime_stopped(plugin_id, "expired")
        active = {preview["previewId"] for preview in self.previews.values()}
        for root in (self.root / "previews").glob("*"):
            if (root.name not in active and re.fullmatch(r"[0-9a-f]{32}", root.name)
                    and root.is_dir() and not root.is_symlink() and root.stat().st_mtime < cutoff):
                self._remove_preview_files(root.name)

    def _revoke_admission(self, plugin_id, entry, root, status):
        status["admission"] = {"status": "failed", "policyVersion": ADMISSION_POLICY_VERSION}
        if entry.get("bundled"):
            return
        digest = self._content_digest(root)
        records = self._admission_records()
        key = self._admission_key(digest, entry["grants"])
        if key in records:
            records.pop(key)
            _atomic_json(self.admission_path, records)
        if plugin_id not in self.previews:
            registry = self._load()
            revoked_epoch = uuid.uuid4().hex
            registry["plugins"][plugin_id].update(enabled=False, epoch=revoked_epoch)
            _atomic_json(self.registry_path, registry)
            status["revokedEpoch"] = revoked_epoch

    def _runtime_failure_matches(self, entry, runtime):
        return (runtime.get("admission", {}).get("status") == "failed"
                and entry.get("epoch") in {runtime.get("epoch"), runtime.get("revokedEpoch")})

    def _load(self):
        if not self.registry_path.exists():
            return {"schemaVersion": 1, "plugins": {}}
        try:
            value = json.loads(self.registry_path.read_text("utf-8"))
            if value.get("schemaVersion") != 1 or not isinstance(value.get("plugins"), dict):
                raise ValueError("schema")
            return value
        except (OSError, ValueError, AttributeError) as error:
            raise ValueError("插件注册表损坏；为保护已安装插件，已停止写入。") from error

    def _bundled(self):
        result = {}
        if self.bundled_root.is_dir():
            for root in sorted(self.bundled_root.iterdir()):
                if not root.is_dir() or root.is_symlink() or not (root / "manifest.json").is_file():
                    continue
                manifest = self._validate_root(root)["manifest"]
                result[manifest["id"]] = {
                    "id": manifest["id"], "manifest": manifest, "version": manifest["version"],
                    "enabled": True, "grants": manifest["permissions"], "bundled": True,
                    "source": {"kind": "bundled"}, "_root": root,
                }
        return result

    def _entries(self, registry=None):
        registry = registry if registry is not None else self._load()
        result = self._bundled()
        changed = False
        for key in result:
            if key not in registry["plugins"]:
                registry["plugins"][key] = {"bundled": True, "enabled": True, "epoch": uuid.uuid4().hex}
                changed = True
        for entry in registry["plugins"].values():
            if not entry.get("removed") and not entry.get("epoch"):
                entry["epoch"] = uuid.uuid4().hex
                changed = True
        if changed:
            _atomic_json(self.registry_path, registry)
        for key, entry in registry["plugins"].items():
            if entry.get("removed"):
                result.pop(key, None)
            elif entry.get("bundled"):
                if key in result:
                    result[key].update({k: entry[k] for k in ("enabled", "grants", "epoch") if k in entry})
            else:
                result[key] = copy.deepcopy(entry)
                result[key]["_root"] = self.root / "packages" / key / entry["sha256"]
        return result

    def _public(self, entry):
        result = copy.deepcopy({key: value for key, value in entry.items() if not key.startswith("_") and key != "previous"})
        result["can_rollback"] = bool(entry.get("previous"))
        root = entry.get("_root", self.root / "packages" / entry["id"] / entry.get("sha256", ""))
        result["admission"] = self._admission(entry, root)
        if self._runtime_failure_matches(entry, self.runtime.get(entry["id"], {})):
            result["admission"]["status"] = "failed"
        if result["admission"]["status"] != "passed":
            result["enabled"] = False
        return result

    def _draft(self, draft_id):
        if not isinstance(draft_id, str) or not re.fullmatch(r"draft-[0-9a-f]{32}", draft_id):
            raise ValueError("草稿 id 无效。")
        root = self.root / "drafts" / draft_id
        if not root.is_dir() or root.is_symlink():
            raise ValueError("插件草稿不存在。")
        return root

    def _validate_root(self, root):
        size, files = 0, []
        if root.is_symlink():
            raise ValueError("插件包不允许符号链接。")
        for path in sorted(root.rglob("*")):
            relative = path.relative_to(root).as_posix()
            _safe_file(root, relative)
            if path.is_dir():
                continue
            if not path.is_file():
                raise ValueError("插件包只能包含普通文件。")
            length = path.stat().st_size
            if length > MAX_FILE:
                raise ValueError("插件单个文件不能超过 2 MiB。")
            size += length
            files.append(relative)
            if len(files) > MAX_FILES or size > MAX_PACKAGE:
                raise ValueError("插件包超过 512 文件或 20 MiB 限制。")
        try:
            manifest = _manifest(json.loads(_safe_file(root, "manifest.json").read_text("utf-8")))
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise ValueError("无法读取 manifest.json。") from error
        manifest.setdefault("permissions", [])
        if not _safe_file(root, manifest["entry"]).is_file():
            raise ValueError("manifest 指定的 entry 不存在。")
        return {"valid": True, "manifest": manifest, "files": files, "bytes": size,
                "contentDigest": self._content_digest(root, files),
                "permissions": manifest["permissions"],
                "checks": ["manifest", "entry", "paths", "package-size"],
                "warnings": ["静态校验不执行 JavaScript；请预览并检查运行日志与测试状态。"]}

    def list_plugins(self):
        with self.lock:
            self._expire_previews()
            plugins = [self._public(value) for value in self._entries().values()]
            drafts = []
            for root in sorted((self.root / "drafts").glob("draft-*")):
                if root.is_dir() and not root.is_symlink():
                    try:
                        manifest = _manifest(json.loads(_safe_file(root, "manifest.json").read_text("utf-8")))
                    except (ValueError, OSError):
                        manifest = None
                    drafts.append({"draftId": root.name, "manifest": manifest})
            return {"plugins": plugins, "drafts": drafts, "previews": copy.deepcopy(list(self.previews.values()))}

    def get_plugin_sdk(self):
        if not all((self.template_root / name).is_file() for name in ("index.html", "main.js", "styles.css")):
            raise ValueError("插件模板资源缺失，请检查应用安装中的 plugin_templates/starter。")
        files = {p.name: p.read_text("utf-8") for p in sorted(self.template_root.glob("*")) if p.is_file()}
        context_shape = {"pluginId": "string", "sdkVersion": "1", "preview": "boolean",
                         "previewId": "string | undefined（仅预览会话）", "manifest": "manifest v1 对象", "pageId?": "string"}
        return {
            "sdkVersion": "1", "manifestSchema": MANIFEST_SCHEMA,
            "permissions": sorted(PERMISSIONS), "capabilities": CAPABILITY_PERMISSIONS,
            "capabilityRequiredPermissions": {
                name: (["vocabulary.read", permission, "ai.translate"] if name == "vocabulary_explain" else [permission])
                for name, permission in CAPABILITY_PERMISSIONS.items()},
            "sdk": {
                "script": "/plugin-sdk.js", "global": "GuziPlugin",
                "methods": ["ready() -> context", "call(name, arguments) -> result", "storage.get(key) -> value（键不存在时为 null，直接返回值而非 {value} 包装）",
                            "storage.set(key, value)", "storage.remove(key)", "onAction(handler)",
                            "onContext(handler)", "reportTest(name, passed, details)", "ui.openSource(source)", "ui.toast(message)", "ui.confirm(message, title) -> boolean"],
                "events": {
                    "ready": {"returns": context_shape},
                    "onContext": {"handlerArgument": context_shape},
                    "onAction": {
                        "handlerArgument": {"actionId": "string", "context": {
                            "snapshot": {"term": "string（选区文本去除首尾空白）", "source": {
                                "job_id": "string", "quote": "string（所在句子，缺少时为选区文本）",
                                "selected_text": "string（原始选区文本）", "block_id": "string | undefined",
                                "source_block_id": "string | undefined", "surface": "source | translation",
                                "page": "number | null", "start": "number | undefined", "end": "number | undefined",
                                "quote_prefix": "string | undefined", "quote_suffix": "string | undefined",
                                "render_generation": "string（默认 base）"}},
                            "selection": "原始选区对象；保留宿主提供的定位字段",
                            "meaning": "string（当前已完成的选区翻译，未完成时为空字符串）",
                            "translationRequestId?": "string | null（可用 call('translate_text', {requestId}) 等待已有翻译）"}},
                        "completion": "handler 应返回 Promise 并等待所有工作完成；resolve 后宿主认为动作完成，reject 会报告动作失败。",
                    },
                },
                "isolation": "页面在 sandbox iframe 中运行，无法访问父 DOM、令牌或任意宿主 API；只可调用已声明且已授权的能力。",
            },
            "template": files,
            "installationSources": {
                "commit": {"url": "https://github.com/OWNER/REPO/archive/<40-hex-commit>.zip", "sha256": "可选；安装后总会记录实际包 SHA256。"},
                "release": {"url": "https://github.com/OWNER/REPO/releases/download/TAG/PLUGIN.zip", "sha256": "必填；64 位十六进制校验和。"},
                "unsupported": "普通仓库主页、分支 ZIP、commit 页面与 release 页面不是固定插件包地址。",
            },
            "workflow": ["create_plugin_draft", "write_plugin_file", "validate_plugin", "preview_plugin",
                         "get_plugin_runtime_status（admission.status=passed）", "install_plugin", "set_plugin_enabled"],
            "runtimeTesting": "必须经过静态检查和宿主独立验收，确认隔离运行且不影响核心功能后才可启用，不得跳过测试。preview_plugin 返回 waiting、SDK ready 或插件 reportTest 自报通过均不是通行凭证；只有宿主能签发 admission。内容、权限或验收策略变更须重新测试。预览使用不可变快照和独立 storage，不写用户文献、笔记、生词本，不调用 AI 或打开来源。外部插件先 install_plugin(enabled=false) 保存候选，再 preview_plugin(pluginId=已安装插件id, grants=全部权限)，轮询 get_plugin_runtime_status，等待 admission.status=passed 后 set_plugin_enabled。最多同时运行 4 个预览，创建新预览前请用 stop_plugin_preview 停止旧预览并释放名额；同一草稿可替换自身预览。",
            "limits": {"fileBytes": MAX_FILE, "packageBytes": MAX_PACKAGE, "files": MAX_FILES, "storageBytes": MAX_STORAGE,
                       "activePreviews": MAX_ACTIVE_PREVIEWS, "messageBytes": 65536, "concurrentCalls": 16,
                       "messagesPer10Seconds": 120, "rendererMemoryMiB": 512, "unresponsiveSeconds": 5},
            "testExpectations": [
                "宿主自动检查独立进程、SDK 握手、稳定响应、阅读器响应、越权拒绝与预览写隔离；失败不签发验收。",
                "插件功能自测应覆盖成功路径、错误路径、重复操作与已有数据保留；reportTest 只能提供补充证据。",
                "预览中的写库、写笔记、AI、来源跳转、全局 toast/confirm 必须被拒绝；UI 反馈请显示在插件自身页面内。",
                "用临时 storage 键测试读写并清理；文献和笔记前后只读比对，预览不得尝试通过 MCP 代写来绕过隔离。",
                "静态校验和短时验收不能证明任意 JavaScript 永远安全；启用后仍受进程监测、资源限额与异常撤销约束。",
            ],
        }

    def create_plugin_draft(self, id="local.my-plugin", name="我的插件", version="0.1.0"):
        manifest = _manifest({"id": id, "name": name, "version": version, "sdkVersion": "1",
                              "entry": "index.html", "permissions": ["storage"],
                              "contributes": {"pages": [{"id": "main", "title": name}]}})
        with self.lock:
            template = self.get_plugin_sdk()["template"]
            draft_id = "draft-" + uuid.uuid4().hex
            root = self.root / "drafts" / draft_id
            root.mkdir(parents=True)
            for path, content in template.items():
                (root / path).write_text(content, "utf-8")
            _atomic_json(root / "manifest.json", manifest)
            return {"draftId": draft_id, "manifest": manifest, "files": sorted(p.name for p in root.iterdir())}

    def read_plugin_file(self, draftId, path):
        with self.lock:
            target = _safe_file(self._draft(draftId), path)
            if not target.is_file() or target.stat().st_size > MAX_FILE:
                raise ValueError("插件文件不存在或超出大小限制。")
            try:
                content = target.read_text("utf-8")
            except UnicodeError as error:
                raise ValueError("此工具只读取 UTF-8 文本。") from error
            return {"draftId": draftId, "path": path, "content": content}

    def write_plugin_file(self, draftId, path, content):
        if not isinstance(content, str) or len(content.encode("utf-8")) > MAX_FILE:
            raise ValueError("插件文本文件不能超过 2 MiB。")
        with self.lock:
            root = self._draft(draftId)
            target = _safe_file(root, path)
            files = [p for p in root.rglob("*") if p.is_file()]
            if len(files) + (not target.exists()) > MAX_FILES:
                raise ValueError("插件不能超过 512 个文件。")
            total = sum(p.stat().st_size for p in files if p != target) + len(content.encode("utf-8"))
            if total > MAX_PACKAGE:
                raise ValueError("插件不能超过 20 MiB。")
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_name(".write-" + uuid.uuid4().hex)
            try:
                temporary.write_text(content, "utf-8")
                os.replace(temporary, target)
            finally:
                if temporary.exists():
                    temporary.unlink()
            self._discard_preview(draftId)
            self._runtime_stopped(draftId, "invalidated")
            return {"draftId": draftId, "path": path, "bytes": len(content.encode("utf-8"))}

    def validate_plugin(self, draftId):
        with self.lock:
            return {"draftId": draftId, **self._validate_root(self._draft(draftId))}

    def preview_plugin(self, draftId=None, grants=None, pluginId=None, *, _allowed_permissions=None):
        with self.lock:
            self._expire_previews()
            if (draftId is None) == (pluginId is None):
                raise ValueError("请选择 draftId 或已安装 pluginId 进行预览。")
            if len(self.previews) >= MAX_ACTIVE_PREVIEWS and draftId not in self.previews:
                raise ValueError("最多同时运行 4 个插件预览；请先 stop_plugin_preview 停止旧预览。")
            source_plugin_id = pluginId
            if pluginId is not None:
                entry = self._entries().get(pluginId)
                if not entry:
                    raise ValueError("插件不存在。")
                self._validate_root(entry["_root"])
                draftId = "draft-" + uuid.uuid4().hex
                draft_root = self.root / "drafts" / draftId
                shutil.copytree(entry["_root"], draft_root)
            result = self.validate_plugin(draftId)
            manifest = result["manifest"]
            granted = _grants([] if grants is None else grants, manifest)
            _limit_grants(granted, _allowed_permissions)
            epoch = uuid.uuid4().hex
            snapshot = self.root / "previews" / epoch / "package"
            try:
                shutil.copytree(self._draft(draftId), snapshot)
                if self._validate_root(snapshot)["contentDigest"] != result["contentDigest"]:
                    raise ValueError("插件内容在预览准备期间变化，请重新预览。")
            except Exception:
                self._remove_preview_files(epoch)
                raise
            preview = {"id": draftId, "pluginId": draftId, "draftId": draftId, "previewId": epoch, "epoch": epoch,
                       "manifest": manifest, "grants": granted, "enabled": True,
                       "contentDigest": result["contentDigest"], "sourcePluginId": source_plugin_id,
                       "createdAtUnix": time.time(),
                       "url": f"/plugins/{draftId}/__preview/{epoch}/{manifest['entry']}"}
            self._discard_preview(draftId)
            self.previews[draftId] = preview
            self.runtime[draftId] = {"pluginId": draftId, "previewId": epoch, "startedAt": _now(), "events": [], "status": "waiting"}
            return {**copy.deepcopy(preview), "status": "waiting", "runtimeStatus": "waiting"}

    def complete_plugin_admission(self, pluginId, previewSession, checks):
        with self.lock:
            self._expire_previews()
            preview = self.previews.get(pluginId)
            if not preview:
                raise ValueError("插件预览不存在或已失效。")
            self._check_session(pluginId, preview, preview_session=previewSession)
            runtime = self.runtime.get(pluginId, {})
            last_details = runtime.get("lastTest", {}).get("details")
            snapshot = self.root / "previews" / previewSession / "package"
            if (not isinstance(checks, dict) or set(checks) != ADMISSION_CHECKS
                    or any(value is not True for value in checks.values())
                    or runtime.get("status") != "ready" or runtime.get("errorCount", 0)
                    or (isinstance(last_details, dict) and last_details.get("passed") is False)):
                self._revoke_admission(pluginId, preview, snapshot, runtime)
                raise PermissionError("插件未通过宿主全部独立验收检查。")
            validation = self._validate_root(snapshot)
            current = self._validate_root(self._draft(pluginId))
            if current["contentDigest"] != preview["contentDigest"] or validation["contentDigest"] != preview["contentDigest"]:
                raise PermissionError("插件内容已变化，必须重新预览验收。")
            if set(preview["grants"]) != set(validation["manifest"]["permissions"]):
                raise PermissionError("验收必须覆盖插件全部声明权限。")
            record = {"source": "host", "policyVersion": ADMISSION_POLICY_VERSION,
                      "contentDigest": preview["contentDigest"], "grants": sorted(preview["grants"]),
                      "checks": copy.deepcopy(checks), "acceptedAt": _now()}
            records = self._admission_records()
            records[self._admission_key(record["contentDigest"], record["grants"])] = record
            _atomic_json(self.admission_path, records)
            runtime["admission"] = {"status": "passed", **copy.deepcopy(record)}
            return {"admission": copy.deepcopy(runtime["admission"])}

    def stop_plugin_preview(self, pluginId, previewId=None):
        with self.lock:
            self._draft(pluginId)
            preview = self.previews.get(pluginId)
            if not preview or (previewId is not None and preview["previewId"] != previewId):
                return {"pluginId": pluginId, "stopped": False}
            self._discard_preview(pluginId)
            self._runtime_stopped(pluginId)
            return {"pluginId": pluginId, "previewId": preview["previewId"], "stopped": True}

    def _runtime_stopped(self, plugin_id, status="stopped"):
        runtime = self.runtime.setdefault(plugin_id, {"pluginId": plugin_id, "events": []})
        runtime.update(status=status, stoppedAt=_now())

    def _download(self, url):
        _github_url(url)
        opener = build_opener(_GitHubRedirects())
        with opener.open(Request(url, headers={"User-Agent": "Guzi-Scholar-Plugins/1"}), timeout=30) as response:
            _github_url(response.geturl(), redirect=True)
            data = response.read(MAX_PACKAGE + 1)
        if len(data) > MAX_PACKAGE:
            raise ValueError("压缩插件包不能超过 20 MiB。")
        return data

    def _extract(self, data, root):
        if len(data) > MAX_PACKAGE:
            raise ValueError("压缩插件包不能超过 20 MiB。")
        try:
            archive = zipfile.ZipFile(io.BytesIO(data))
        except zipfile.BadZipFile as error:
            raise ValueError("插件包不是有效 zip。") from error
        with archive:
            entries = archive.infolist()
            if len(entries) > MAX_FILES * 2:
                raise ValueError("插件 zip 条目过多。")
            files = [item for item in entries if not item.is_dir()]
            total = 0
            seen = set()
            file_paths = {unicodedata.normalize("NFC", item.filename).casefold() for item in files}
            for item in entries:
                relative = item.filename.rstrip("/") if item.is_dir() else item.filename
                _relative(relative)
                mode = item.external_attr >> 16
                if stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in {0, stat.S_IFREG, stat.S_IFDIR}):
                    raise ValueError("插件 zip 不允许符号链接或特殊文件。")
                canonical = unicodedata.normalize("NFC", relative).casefold()
                if canonical in seen:
                    raise ValueError("插件 zip 包含重复路径。")
                seen.add(canonical)
                if any(parent.as_posix() in file_paths for parent in PurePosixPath(canonical).parents if parent.as_posix() != "."):
                    raise ValueError("插件 zip 文件与目录路径冲突。")
                total += item.file_size
                if item.file_size > MAX_FILE or total > MAX_PACKAGE or len(files) > MAX_FILES:
                    raise ValueError("插件解压大小超限。")
                if item.flag_bits & 1:
                    raise ValueError("插件 zip 不能加密。")
            prefix = ""
            names = [item.filename for item in files]
            if "manifest.json" not in names:
                candidates = [n for n in names if n.count("/") == 1 and n.endswith("/manifest.json")]
                if len(candidates) == 1:
                    prefix = candidates[0].rsplit("/", 1)[0] + "/"
                    if any(not name.startswith(prefix) for name in names):
                        raise ValueError("插件 manifest 必须位于包根目录。")
            for item in files:
                relative = item.filename[len(prefix):] if prefix else item.filename
                target = _safe_file(root, relative)
                target.parent.mkdir(parents=True, exist_ok=True)
                try:
                    with archive.open(item) as source, target.open("xb") as destination:
                        data = source.read(MAX_FILE + 1)
                        if len(data) != item.file_size or len(data) > MAX_FILE:
                            raise ValueError("插件解压大小与声明不符。")
                        destination.write(data)
                except (zipfile.BadZipFile, RuntimeError) as error:
                    raise ValueError("插件 zip 内容损坏。") from error

    def _pack_draft(self, root):
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
            for path in sorted(root.rglob("*")):
                if path.is_file():
                    info = zipfile.ZipInfo(path.relative_to(root).as_posix(), (1980, 1, 1, 0, 0, 0))
                    archive.writestr(info, path.read_bytes())
        return output.getvalue()

    def install_plugin(self, draftId=None, packageBase64=None, githubUrl=None, sha256=None, grants=None, enabled=False, *, _allowed_permissions=None):
        if sum(value is not None for value in (draftId, packageBase64, githubUrl)) != 1:
            raise ValueError("请选择一种插件来源：draftId、packageBase64 或 githubUrl。")
        if not isinstance(enabled, bool):
            raise ValueError("enabled 必须为布尔值。")
        if sha256 is not None and (not isinstance(sha256, str) or not re.fullmatch(r"[a-fA-F0-9]{64}", sha256)):
            raise ValueError("sha256 必须为 64 位十六进制。")
        with self.lock:
            if draftId is not None:
                draft_root = self._draft(draftId)
                self._validate_root(draft_root)
                data = self._pack_draft(draft_root)
                source = {"kind": "draft", "draftId": draftId}
            elif packageBase64 is not None:
                if not isinstance(packageBase64, str) or len(packageBase64) > (MAX_PACKAGE * 4 // 3 + 8):
                    raise ValueError("本地插件包大小超限。")
                try:
                    data = base64.b64decode(packageBase64, validate=True)
                except (binascii.Error, ValueError) as error:
                    raise ValueError("packageBase64 无效。") from error
                source = {"kind": "local"}
            else:
                _github_url(githubUrl)
                if "/releases/download/" in githubUrl and sha256 is None:
                    raise ValueError("安装 GitHub release 插件必须提供 sha256。")
                data = self._download(githubUrl)
                source = {"kind": "github", "url": githubUrl}
            digest = hashlib.sha256(data).hexdigest()
            if sha256 is not None and digest != sha256.lower():
                raise ValueError("插件包 sha256 与预期不符。")
            self.root.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(prefix=".install-", dir=self.root) as temporary:
                stage = Path(temporary) / "package"
                stage.mkdir()
                self._extract(data, stage)
                validation = self._validate_root(stage)
                manifest = validation["manifest"]
                plugin_id = manifest["id"]
                if plugin_id in self._bundled():
                    raise ValueError("内置插件不能由用户包覆盖。")
                registry = self._load()
                previous = registry["plugins"].get(plugin_id)
                previous = previous if previous and not previous.get("removed") else None
                prior_grants = [p for p in (previous or {}).get("grants", []) if p in manifest["permissions"]]
                granted = _grants(grants if grants is not None else prior_grants, manifest)
                if enabled and not set(manifest["permissions"]).issubset(granted):
                    raise ValueError("启用插件前须授权其全部声明权限。")
                if enabled:
                    _limit_grants(granted, _allowed_permissions)
                    self._require_admission({"grants": granted}, stage, validation=validation)
                if previous and previous["sha256"] != digest and previous["version"] == manifest["version"]:
                    raise ValueError("内容已变更，请提升插件版本后升级。")
                destination = self.root / "packages" / plugin_id / digest
                destination.parent.mkdir(parents=True, exist_ok=True)
                if not destination.exists():
                    os.replace(stage, destination)
                elif self._validate_root(destination)["contentDigest"] != validation["contentDigest"]:
                    raise ValueError("已保存的插件包内容已变化，拒绝安装。")
                entry = {"id": plugin_id, "manifest": manifest, "version": manifest["version"],
                         "sha256": digest, "source": source, "enabled": enabled, "grants": granted,
                         "contentDigest": validation["contentDigest"],
                         "bundled": False, "installedAt": _now(), "epoch": uuid.uuid4().hex}
                if previous and previous["sha256"] != digest:
                    entry["previous"] = {k: v for k, v in previous.items() if k != "previous"}
                elif previous and previous.get("previous"):
                    entry["previous"] = previous["previous"]
                registry["plugins"][plugin_id] = entry
                _atomic_json(self.registry_path, registry)
                self.runtime.pop(plugin_id, None)
                if draftId is not None:
                    self._discard_preview(draftId)
                    self._runtime_stopped(draftId, "installed")
                return {"plugin": self._public(entry), "validation": validation}

    def set_plugin_enabled(self, pluginId, enabled, grants=None, *, _allowed_permissions=None):
        if not isinstance(enabled, bool):
            raise ValueError("enabled 必须为布尔值。")
        with self.lock:
            registry = self._load()
            entry = self._entries(registry).get(pluginId)
            if not entry:
                raise ValueError("插件不存在。")
            granted = _grants(grants if grants is not None else entry["grants"], entry["manifest"])
            if enabled and not set(entry["manifest"]["permissions"]).issubset(granted):
                raise ValueError("启用插件前须授权其全部声明权限。")
            if enabled:
                _limit_grants(granted, _allowed_permissions)
                self._require_admission(entry, entry["_root"], granted)
            if entry["bundled"]:
                registry["plugins"][pluginId] = {"bundled": True, "enabled": enabled, "grants": granted, "epoch": uuid.uuid4().hex}
            else:
                registry["plugins"][pluginId].update(enabled=enabled, grants=granted, epoch=uuid.uuid4().hex)
            _atomic_json(self.registry_path, registry)
            if not enabled:
                self._runtime_stopped(pluginId, "disabled")
            else:
                self.runtime.pop(pluginId, None)
            entry.update(enabled=enabled, grants=granted, epoch=registry["plugins"][pluginId]["epoch"])
            return {"plugin": self._public(entry)}

    def uninstall_plugin(self, pluginId):
        with self.lock:
            registry = self._load()
            entry = self._entries(registry).get(pluginId)
            if not entry:
                raise ValueError("插件不存在。")
            if entry["bundled"]:
                raise ValueError("内置插件可以禁用，不能卸载。")
            registry["plugins"][pluginId] = {"removed": True, "epoch": uuid.uuid4().hex}
            _atomic_json(self.registry_path, registry)
            self._runtime_stopped(pluginId, "uninstalled")
            return {"pluginId": pluginId, "uninstalled": True, "dataRetained": True}

    def rollback_plugin(self, pluginId, *, _allowed_permissions=None):
        with self.lock:
            registry = self._load()
            current = registry["plugins"].get(pluginId)
            if not current or not current.get("previous"):
                raise ValueError("此插件没有可回滚的上一版本。")
            previous = copy.deepcopy(current["previous"])
            root = self.root / "packages" / pluginId / previous["sha256"]
            self._validate_root(root)
            previous["enabled"] = bool(current["enabled"]) and set(previous["manifest"]["permissions"]).issubset(current["grants"])
            previous["grants"] = sorted(set(previous["manifest"]["permissions"]) & set(current["grants"]))
            if previous["enabled"]:
                _limit_grants(previous["grants"], _allowed_permissions)
                self._require_admission(previous, root)
            previous["epoch"] = uuid.uuid4().hex
            previous["previous"] = {k: v for k, v in current.items() if k != "previous"}
            registry["plugins"][pluginId] = previous
            _atomic_json(self.registry_path, registry)
            self.runtime.pop(pluginId, None)
            return {"plugin": self._public(previous)}

    def _active(self, plugin_id):
        self._expire_previews()
        if plugin_id in self.previews:
            preview = self.previews[plugin_id]
            if self.runtime.get(plugin_id, {}).get("status") == "error":
                raise PermissionError("预览运行已失败，请停止或重新预览。")
            snapshot = self.root / "previews" / preview["previewId"] / "package"
            if (self._content_digest(snapshot) != preview["contentDigest"]
                    or self._content_digest(self._draft(plugin_id)) != preview["contentDigest"]):
                raise PermissionError("预览内容已变化，请重新预览。")
            return preview, snapshot
        entry = self._entries().get(plugin_id)
        if not entry or not entry["enabled"]:
            raise ValueError("插件不存在或未启用。")
        if (not entry.get("bundled") and self.runtime.get(plugin_id, {}).get("epoch") == entry["epoch"]
                and self.runtime[plugin_id].get("status") == "error"):
            raise PermissionError("插件运行已失败，必须重新验收。")
        self._require_admission(entry, entry["_root"])
        return entry, entry["_root"]

    def asset(self, plugin_id, path):
        with self.lock:
            entry, root = self._active(plugin_id)
            if plugin_id in self.previews:
                prefix = f"__preview/{entry['previewId']}/"
                if not isinstance(path, str) or not path.startswith(prefix):
                    raise PermissionError("预览会话已失效，请重新预览。")
                path = path[len(prefix):]
            target = _safe_file(root, path)
            if not target.is_file() or target.stat().st_size > MAX_FILE:
                raise ValueError("插件资源不存在。")
            return target.read_bytes(), mimetypes.guess_type(path)[0] or "application/octet-stream"

    def _check_session(self, plugin_id, entry, preview_session=None, plugin_session=None):
        expected = entry["previewId"] if plugin_id in self.previews else entry["epoch"]
        actual = preview_session if plugin_id in self.previews else plugin_session
        if not actual or actual != expected:
            raise PermissionError("插件运行会话已失效，请重新载入插件。")

    def granted_permissions(self, plugin_id, preview_session=None, plugin_session=None):
        with self.lock:
            entry, _ = self._active(plugin_id)
            self._check_session(plugin_id, entry, preview_session, plugin_session)
            return list(entry["grants"])

    def invoke(self, plugin_id, name, args, callback, preview_session=None, plugin_session=None):
        if not isinstance(args, dict):
            raise ValueError("插件能力参数必须是对象。")
        with self.lock:
            entry, _ = self._active(plugin_id)
            self._check_session(plugin_id, entry, preview_session, plugin_session)
            permission = CAPABILITY_PERMISSIONS.get(name)
            required = {"vocabulary.read", permission, "ai.translate"} if name == "vocabulary_explain" else {permission}
            if not permission or not required.issubset(entry["manifest"]["permissions"]) or not required.issubset(entry["grants"]):
                raise PermissionError("插件未获准调用此能力。")
            if plugin_id in self.previews and permission not in PREVIEW_READ_PERMISSIONS | {"storage"}:
                raise PermissionError("预览不能修改用户数据、调用 AI 或打开来源。")
            if name.replace(".", "_").startswith("storage_"):
                return self._storage(plugin_id, name.replace(".", "_").split("_", 1)[1], args)
            if name in {"translate_text", "open_source"}:
                return {"authorized": True}
        return callback(name, args)

    def _storage(self, plugin_id, operation, args):
        key = args.get("key")
        if not isinstance(key, str) or not 0 < len(key) <= 200:
            raise ValueError("storage key 必须为不超过 200 字符的文本。")
        if plugin_id in self.previews:
            path = _safe_file(self.root, f"previews/{self.previews[plugin_id]['previewId']}/storage.json")
        else:
            path = _safe_file(self.library_root, f"plugin-data/{plugin_id}/storage.json")
        try:
            data = json.loads(path.read_text("utf-8")) if path.exists() else {}
        except (OSError, ValueError) as error:
            raise ValueError("插件 storage 数据损坏。") from error
        if operation == "get":
            return {"value": data.get(key)}
        if operation == "set":
            if "value" not in args:
                raise ValueError("storage_set 缺少 value。")
            data[key] = args["value"]
        else:
            data.pop(key, None)
        try:
            if len(_json_bytes(data)) > MAX_STORAGE:
                raise ValueError("插件 storage 超过 1 MiB。")
        except (TypeError, RecursionError) as error:
            raise ValueError("插件 storage 仅支持 JSON 值。") from error
        _atomic_json(path, data)
        return {"ok": True}

    def get_plugin_runtime_status(self, pluginId):
        with self.lock:
            self._expire_previews()
            preview = self.previews.get(pluginId)
            if preview:
                result = copy.deepcopy(self.runtime[pluginId])
                root = self.root / "previews" / preview["previewId"] / "package"
                result["admission"] = self._admission(preview, root)
                if result["status"] == "error" or self.runtime[pluginId].get("admission", {}).get("status") == "failed":
                    result["admission"]["status"] = "failed"
                elif self._content_digest(self._draft(pluginId)) != preview["contentDigest"]:
                    result["admission"]["status"] = "required"
                return result
            entry = self._entries().get(pluginId)
            if pluginId in self.runtime:
                result = copy.deepcopy(self.runtime[pluginId])
                result["admission"] = self._admission(entry, entry["_root"]) if entry else {"status": "required", "policyVersion": ADMISSION_POLICY_VERSION}
                if entry and self._runtime_failure_matches(entry, self.runtime[pluginId]):
                    result["admission"]["status"] = "failed"
                return result
            if not entry:
                self._active(pluginId)
            return {"pluginId": pluginId, "epoch": entry.get("epoch"),
                    "status": "not-started" if entry["enabled"] else "disabled", "events": [],
                    "admission": self._admission(entry, entry["_root"])}

    def report_plugin_runtime_event(self, pluginId, level, message, details=None, previewSession=None, pluginSession=None):
        if level not in {"info", "error", "test", "ready"} or not isinstance(message, str) or len(message) > 4000:
            raise ValueError("插件运行事件无效。")
        if len(_json_bytes(details)) > 16000:
            raise ValueError("插件运行事件 details 过大。")
        with self.lock:
            entry, root = self._active(pluginId)
            self._check_session(pluginId, entry, previewSession, pluginSession)
            if pluginId not in self.previews and self.runtime.get(pluginId, {}).get("epoch") != entry["epoch"]:
                self.runtime.pop(pluginId, None)
            status = self.runtime.setdefault(pluginId, {"pluginId": pluginId, "epoch": entry.get("epoch"), "startedAt": _now(), "events": [], "status": "waiting"})
            status["events"].append({"time": _now(), "level": level, "message": message, "details": details})
            status["events"] = status["events"][-100:]
            if level == "ready":
                if status["status"] != "error":
                    status["status"] = "ready"
            elif level == "error":
                status["status"] = "error"
                status["errorCount"] = status.get("errorCount", 0) + 1
            elif level == "test":
                status["lastTest"] = {"message": message, "details": details, "time": _now()}
                if isinstance(details, dict) and details.get("passed") is False:
                    status["status"] = "error"
            if status["status"] == "error":
                self._revoke_admission(pluginId, entry, root, status)
            return {"ok": True, "status": status["status"]}

    def tools(self):
        return copy.deepcopy(TOOLS)

    def call(self, name, args, allowed_permissions=None):
        if not isinstance(args, dict) or not isinstance(name, str) or name not in {tool["name"] for tool in TOOLS}:
            raise ValueError("未知插件工具或参数无效。")
        schema = next(tool["inputSchema"] for tool in TOOLS if tool["name"] == name)
        if set(args) - schema["properties"].keys() or set(schema.get("required", [])) - args.keys():
            raise ValueError("插件工具参数不完整或包含未知字段。")
        for key, value in args.items():
            rule = schema["properties"][key]
            expected = rule.get("type")
            if ((expected == "string" and not isinstance(value, str))
                    or (expected == "boolean" and not isinstance(value, bool))
                    or (expected == "array" and not isinstance(value, list))
                    or ("enum" in rule and value not in rule["enum"])):
                raise ValueError(f"插件工具参数 {key} 类型或取值无效。")
        if name in {"preview_plugin", "install_plugin", "set_plugin_enabled", "rollback_plugin"}:
            return getattr(self, name)(**args, _allowed_permissions=allowed_permissions)
        return getattr(self, name)(**args)


MANIFEST_SCHEMA = {
    "type": "object", "required": ["id", "name", "version", "sdkVersion", "entry", "permissions", "contributes"],
    "properties": {
        "id": {"type": "string", "pattern": "^" + PLUGIN_ID.pattern.replace(r"\Z", "$")}, "name": {"type": "string", "maxLength": 120},
        "version": {"type": "string", "pattern": "^" + VERSION.pattern.replace(r"\Z", "$")}, "sdkVersion": {"const": "1"},
        "entry": {"type": "string"}, "permissions": {"type": "array", "items": {"enum": sorted(PERMISSIONS)}},
        "contributes": {"type": "object", "additionalProperties": False, "properties": {
            kind: {"type": "array", "maxItems": 20, "items": {"type": "object", "required": ["id", "title"], "properties": {
                "id": {"type": "string", "pattern": "^[a-z][a-z0-9_-]{0,63}$"}, "title": {"type": "string", "minLength": 1, "maxLength": 120},
                "icon": {"type": "string"}}}} for kind in ("pages", "selectionActions")}},
    },
}


def _tool(name, description, properties=None, required=()):
    return {"name": name, "description": description, "scope": "plugins.manage", "inputSchema": {
        "type": "object", "properties": properties or {}, "required": list(required), "additionalProperties": False}}


_STRING = {"type": "string"}
_GRANTS = {"type": "array", "items": {"enum": sorted(PERMISSIONS)}}
TOOLS = [
    _tool("get_plugin_sdk", "获取谷子插件 manifest v1 schema、SDK、模板与允许能力。"),
    _tool("list_plugins", "列出内置插件、已安装插件与作者草稿。"),
    _tool("create_plugin_draft", "创建隔离的插件作者草稿，不访问任意本地路径。", {"id": _STRING, "name": _STRING, "version": _STRING}),
    _tool("read_plugin_file", "读取草稿内的 UTF-8 文件。", {"draftId": _STRING, "path": _STRING}, ("draftId", "path")),
    _tool("write_plugin_file", "写入草稿内文件；修改后须重新预览。", {"draftId": _STRING, "path": _STRING, "content": _STRING}, ("draftId", "path", "content")),
    _tool("validate_plugin", "静态校验 manifest、入口、路径和包限制；不执行代码。", {"draftId": _STRING}, ("draftId",)),
    _tool("preview_plugin", "预览草稿或已安装禁用插件的隔离快照；draftId 与 pluginId 二选一，grants 仅用于此预览。", {"draftId": _STRING, "pluginId": _STRING, "grants": _GRANTS}),
    _tool("stop_plugin_preview", "停止指定预览并立即撤销其能力；旧 previewId 不影响较新的预览。", {"pluginId": _STRING, "previewId": _STRING}, ("pluginId",)),
    _tool("install_plugin", "从作者草稿、本地 zip base64 或固定 GitHub 包安装；默认禁用且保留上一版。", {"draftId": _STRING, "packageBase64": _STRING, "githubUrl": {"type": "string", "description": "固定 40 位 commit 的 GitHub archive ZIP URL，或 releases/download 下的 release ZIP；release 必须同时提供 sha256。"}, "sha256": {"type": "string", "description": "包的 64 位十六进制 SHA256；release 必填，固定 commit ZIP 可选。"}, "grants": _GRANTS, "enabled": {"type": "boolean"}}),
    _tool("set_plugin_enabled", "授权并启用或禁用插件；启用要求完整授权。", {"pluginId": _STRING, "enabled": {"type": "boolean"}, "grants": _GRANTS}, ("pluginId", "enabled")),
    _tool("uninstall_plugin", "卸载用户插件，保留库内的插件数据。", {"pluginId": _STRING}, ("pluginId",)),
    _tool("rollback_plugin", "恢复插件上一版；权限仍限制在当前授权范围。", {"pluginId": _STRING}, ("pluginId",)),
    _tool("get_plugin_runtime_status", "获取预览或插件的 ready/error 状态、最近测试和最多 100 条日志。", {"pluginId": _STRING}, ("pluginId",)),
]
