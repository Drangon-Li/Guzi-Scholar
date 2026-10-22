"""Read Zotero's loopback API and stage selected PDF attachments locally."""

from __future__ import annotations

import hashlib
import ipaddress
import json
import os
import re
import stat
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping
from pathlib import Path
from typing import Any


DEFAULT_BASE_URL = "http://127.0.0.1:23119/api"
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
MAX_PDF_BYTES = int(os.environ.get("MY_SCHOLAR_MAX_UPLOAD_BYTES", str(100 * 1024 * 1024)))
PAGE_SIZE = 100
MAX_OBJECTS = 10000
_KEY = re.compile(r"[A-Za-z0-9]{1,64}\Z")
_LIBRARY = re.compile(r"(user|group):(0|[1-9][0-9]{0,15})\Z")


class ZoteroError(RuntimeError):
    def __init__(self, message: str, *, status_code: int | None = None):
        super().__init__(message)
        self.status_code = status_code


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


def _data(record: Any) -> Mapping[str, Any]:
    if not isinstance(record, Mapping):
        raise ZoteroError("Zotero 返回了无效的对象。")
    value = record.get("data", record)
    if not isinstance(value, Mapping):
        raise ZoteroError("Zotero 返回了无效的对象数据。")
    return value


def _text(value: Any) -> str:
    return value if isinstance(value, str) else ""


def _key(value: Any) -> str:
    if not isinstance(value, str) or not _KEY.fullmatch(value):
        raise ZoteroError("无效的 Zotero 条目或分类标识。")
    return value


def _record_key(record: Mapping[str, Any]) -> str:
    return _key(record.get("key", _data(record).get("key")))


def _library_prefix(library: Any) -> str:
    match = _LIBRARY.fullmatch(library) if isinstance(library, str) else None
    if not match or (match[1] == "group" and match[2] == "0"):
        raise ZoteroError("无效的 Zotero 文库标识。")
    return f"{'users' if match[1] == 'user' else 'groups'}/{match[2]}"


def _tags(data: Mapping[str, Any]) -> list[str]:
    tags = data.get("tags", [])
    if not isinstance(tags, list):
        return []
    return list(dict.fromkeys(tag for item in tags if (tag := _text(item.get("tag") if isinstance(item, Mapping) else item).strip())))


def _authors(data: Mapping[str, Any]) -> list[str]:
    creators = data.get("creators", [])
    if not isinstance(creators, list):
        return []
    creators = [creator for creator in creators if isinstance(creator, Mapping)]
    primary = [creator for creator in creators if creator.get("creatorType") in {"author", "bookAuthor"}]
    return [name for creator in (primary or creators) if (name := (_text(creator.get("name")) or " ".join(part for part in (_text(creator.get("firstName")), _text(creator.get("lastName"))) if part)).strip())]


def _year(data: Mapping[str, Any]) -> str:
    match = re.search(r"(?<!\d)([12]\d{3})(?!\d)", _text(data.get("date")))
    return match[1] if match else ""


def _is_pdf(record: Mapping[str, Any]) -> bool:
    data = _data(record)
    if data.get("itemType") != "attachment" or data.get("deleted") or data.get("linkMode") == "linked_url":
        return False
    content_type = _text(data.get("contentType")).lower().split(";", 1)[0]
    return content_type == "application/pdf" or (not content_type and _text(data.get("filename")).lower().endswith(".pdf"))


def _collection(record: Mapping[str, Any]) -> dict[str, Any]:
    data = _data(record)
    parent = data.get("parentCollection")
    return {"key": _record_key(record), "name": _text(data.get("name")), "parent_key": _key(parent) if parent else None}


class ZoteroClient:
    def __init__(self, base_url: str = DEFAULT_BASE_URL, *, timeout_seconds: float = 5):
        parsed = urllib.parse.urlsplit(base_url)
        try:
            loopback = ipaddress.ip_address(parsed.hostname or "").is_loopback
            valid_port = parsed.port is not None and 0 < parsed.port <= 65535
        except ValueError:
            loopback = valid_port = False
        if (parsed.scheme != "http" or not loopback or not valid_port or parsed.path.rstrip("/") != "/api"
                or parsed.username or parsed.password or parsed.query or parsed.fragment):
            raise ZoteroError("Zotero 仅允许使用本机回环地址的 /api 服务。")
        self.base_url = base_url.rstrip("/")
        self.timeout_seconds = timeout_seconds
        # Never send a local-library request through an environment HTTP proxy.
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
        self._server_id = ""
        self._selected: dict[tuple[str, str], Mapping[str, Any]] = {}

    def _get(self, path: str, params: Mapping[str, Any] | None = None, *, file_url: bool = False) -> tuple[bytes, Mapping[str, str]]:
        url = self.base_url + "/" + path
        if params:
            url += "?" + urllib.parse.urlencode(params)
        headers = {"Accept": "text/plain" if file_url else "application/json", "Zotero-API-Version": "3"}
        if self._server_id:
            headers["Zotero-Server-ID"] = self._server_id
        request = urllib.request.Request(url, headers=headers, method="GET")
        try:
            with self._opener.open(request, timeout=self.timeout_seconds) as response:
                body = response.read(MAX_RESPONSE_BYTES + 1)
                response_headers = response.headers
        except urllib.error.HTTPError as exc:
            try:
                if file_url and exc.code in {301, 302, 303, 307, 308}:
                    location = exc.headers.get("Location", "")
                    if urllib.parse.urlsplit(location).scheme == "file":
                        return location.encode("utf-8"), exc.headers
                    raise ZoteroError("Zotero 附件请求拒绝跳转到网络地址。") from exc
                message = "请在 Zotero 设置中启用本地 API。" if exc.code == 403 else f"Zotero 请求失败（HTTP {exc.code}）。"
                raise ZoteroError(message, status_code=exc.code) from exc
            finally:
                exc.close()
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise ZoteroError("无法连接本机 Zotero，请确认 Zotero 正在运行且已启用本地 API。") from exc
        if len(body) > MAX_RESPONSE_BYTES:
            raise ZoteroError("Zotero 响应超过安全上限，请缩小导入范围。")
        server_id = response_headers.get("Zotero-Server-ID", "")
        if self._server_id and server_id and self._server_id != server_id:
            raise ZoteroError("Zotero 文库实例已改变，请重新选择文献。")
        if server_id:
            self._server_id = server_id
        return body, response_headers

    def _json(self, path: str, params: Mapping[str, Any] | None = None) -> tuple[Any, Mapping[str, str]]:
        body, headers = self._get(path, params)
        try:
            return json.loads(body.decode("utf-8")), headers
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ZoteroError("Zotero 响应不是有效 JSON。") from exc

    def _page(self, path: str, params: Mapping[str, Any]) -> tuple[list[Mapping[str, Any]], int | None, str]:
        payload, headers = self._json(path, params)
        if not isinstance(payload, list) or any(not isinstance(record, Mapping) for record in payload):
            raise ZoteroError("Zotero 列表响应格式不受支持。")
        raw_total = headers.get("Total-Results")
        try:
            total = int(raw_total) if raw_total is not None else None
            if total is not None and total < 0:
                raise ValueError()
        except (ValueError, TypeError) as exc:
            raise ZoteroError("Zotero 返回了无效的分页总数。") from exc
        return payload, total, headers.get("Last-Modified-Version", "")

    def _all(self, path: str, params: Mapping[str, Any] | None = None) -> list[Mapping[str, Any]]:
        records, seen = [], set()
        expected_total, expected_version = None, ""
        for _ in range(MAX_OBJECTS // PAGE_SIZE + 1):
            page, total, version = self._page(path, {**(params or {}), "start": len(records), "limit": PAGE_SIZE})
            if expected_total is not None and total is not None and total != expected_total:
                raise ZoteroError("Zotero 列表在读取时发生变化，请重试。")
            if expected_version and version and version != expected_version:
                raise ZoteroError("Zotero 文库在读取时发生变化，请重试。")
            expected_total = total if expected_total is None else expected_total
            expected_version = expected_version or version
            if expected_total is not None and expected_total > MAX_OBJECTS:
                raise ZoteroError("Zotero 列表超过导入上限，请缩小范围。")
            for record in page:
                data = _data(record)
                identity = record.get("key", record.get("id", data.get("key", data.get("id"))))
                if identity is None or str(identity) in seen:
                    raise ZoteroError("Zotero 分页包含重复或缺少标识的对象，请重试。")
                seen.add(str(identity))
                records.append(record)
            if len(records) > MAX_OBJECTS:
                raise ZoteroError("Zotero 列表超过导入上限，请缩小范围。")
            if expected_total is not None and len(records) >= expected_total:
                if len(records) != expected_total:
                    raise ZoteroError("Zotero 分页总数不一致，请重试。")
                return records
            if not page:
                if expected_total is not None:
                    raise ZoteroError("Zotero 分页未返回完整数据，请重试。")
                return records
            if total is None and len(page) < PAGE_SIZE:
                return records
        raise ZoteroError("Zotero 分页请求超过上限，请缩小范围。")

    def _item(self, library: str, item_key: str) -> Mapping[str, Any]:
        record, _ = self._json(f"{_library_prefix(library)}/items/{_key(item_key)}")
        data = _data(record)
        if _record_key(record) != item_key or data.get("deleted"):
            raise ZoteroError("Zotero 条目不存在或已被删除。")
        self._identity(library, record)
        return record

    def _children(self, library: str, item_key: str, *, item_type: str | None = None) -> list[Mapping[str, Any]]:
        return self._all(f"{_library_prefix(library)}/items/{_key(item_key)}/children", {"itemType": item_type} if item_type else None)

    def status(self) -> dict[str, Any]:
        groups = self._all("users/0/groups")
        libraries = [{"id": "user:0", "name": "我的文库"}]
        for group in groups:
            data = _data(group)
            group_id = group.get("id", data.get("id"))
            if isinstance(group_id, bool) or not str(group_id).isdigit() or int(group_id) <= 0:
                raise ZoteroError("Zotero 返回了无效的群组文库标识。")
            libraries.append({"id": f"group:{int(group_id)}", "name": _text(data.get("name")) or f"群组 {group_id}"})
        return {"available": True, "libraries": libraries}

    def collections(self, library: str) -> list[dict[str, Any]]:
        return [_collection(record) for record in self._all(f"{_library_prefix(library)}/collections")]

    def items(self, library: str, collection: str = "", query: str = "", start: int = 0, limit: int = 25) -> dict[str, Any]:
        prefix = _library_prefix(library)
        if not isinstance(start, int) or isinstance(start, bool) or not 0 <= start <= 1000000:
            raise ZoteroError("Zotero 分页起点无效。")
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= PAGE_SIZE:
            raise ZoteroError("Zotero 每页数量必须在 1 到 100 之间。")
        if not isinstance(query, str) or len(query) > 512:
            raise ZoteroError("Zotero 搜索词过长或格式无效。")
        path = prefix + (f"/collections/{_key(collection)}" if collection else "") + "/items/top"
        params = {"start": start, "limit": limit}
        if query.strip():
            params["q"] = query.strip()
            params["qmode"] = "titleCreatorYear"
        records, total, _ = self._page(path, params)
        if len(records) > limit:
            raise ZoteroError("Zotero 返回的分页超过请求范围。")
        result = []
        for record in records:
            data, item_key = _data(record), _record_key(record)
            attachments = []
            for child in self._children(library, item_key):
                child_data = _data(child)
                if child_data.get("parentItem") == item_key and _is_pdf(child):
                    attachments.append({"key": _record_key(child), "title": _text(child_data.get("title")), "filename": _text(child_data.get("filename"))})
            item = {"key": item_key, "title": _text(data.get("title")) or "未命名文献", "authors": _authors(data),
                    "year": _year(data), "tags": _tags(data), "attachments": attachments}
            if not attachments:
                item["reason"] = "此条目没有可导入的 PDF 附件。"
            result.append(item)
        next_start = start + len(records)
        if total is None:
            total = next_start
            next_start = next_start if len(records) == limit else None
        else:
            if not records and start < total:
                raise ZoteroError("Zotero 分页未返回完整数据，请重试。")
            next_start = next_start if next_start < total else None
        return {"items": result, "total": total, "start": start, "next_start": next_start}

    def _identity(self, library: str, record: Mapping[str, Any]) -> str:
        actual = record.get("library")
        if isinstance(actual, Mapping) and actual.get("type") in {"user", "group"}:
            actual_id = actual.get("id")
            if isinstance(actual_id, int) and not isinstance(actual_id, bool) and actual_id >= 0:
                identity = f"{actual['type']}:{actual_id}"
                kind, requested_id = library.split(":")
                if actual["type"] != kind or (requested_id != "0" and identity != library):
                    raise ZoteroError("Zotero 返回的条目不属于选中的文库。")
                return identity
        return library

    def fetch_document(self, library: str, item_key: str, attachment_key: str) -> dict[str, Any]:
        _library_prefix(library)
        item_key, attachment_key = _key(item_key), _key(attachment_key)
        parent = self._item(library, item_key)
        data = _data(parent)
        identity = self._identity(library, parent)
        children = self._children(library, item_key)
        attachment = next((child for child in children if _record_key(child) == attachment_key and _data(child).get("parentItem") == item_key and _is_pdf(child)), None)
        if attachment is None:
            raise ZoteroError("选中的 PDF 附件不属于该 Zotero 条目。")
        if isinstance(attachment.get("library"), Mapping):
            attachment_identity = self._identity(library, attachment)
            if isinstance(parent.get("library"), Mapping) and attachment_identity != identity:
                raise ZoteroError("Zotero 附件与文献的文库不一致。")
            identity = attachment_identity
        # Zotero's default children search omits PDF annotations unless explicitly requested.
        attachment_children = self._children(library, attachment_key) + self._children(library, attachment_key, item_type="annotation")
        notes, annotations = [], []
        for record in children + attachment_children:
            child_data, child_key = _data(record), _record_key(record)
            if child_data.get("deleted") or child_data.get("parentItem") not in {item_key, attachment_key}:
                continue
            version = record.get("version", child_data.get("version", 0))
            if not isinstance(version, int) or isinstance(version, bool):
                raise ZoteroError("Zotero 条目版本无效。")
            if child_data.get("itemType") == "note":
                if not any(note["key"] == child_key for note in notes):
                    notes.append({"key": child_key, "version": version, "html": _text(child_data.get("note"))})
            elif child_data.get("itemType") == "annotation" and child_data.get("parentItem") == attachment_key:
                position = child_data.get("annotationPosition", {})
                if isinstance(position, str):
                    try:
                        position = json.loads(position) if position else {}
                    except json.JSONDecodeError as exc:
                        raise ZoteroError("Zotero PDF 批注位置不是有效 JSON。") from exc
                if not isinstance(position, dict):
                    raise ZoteroError("Zotero PDF 批注位置格式无效。")
                if not any(annotation["key"] == child_key for annotation in annotations):
                    annotations.append({"key": child_key, "version": version, "type": _text(child_data.get("annotationType")),
                                        "text": _text(child_data.get("annotationText")), "comment": _text(child_data.get("annotationComment")),
                                        "color": _text(child_data.get("annotationColor")), "page_label": _text(child_data.get("annotationPageLabel")), "position": position,
                                        "tags": _tags(child_data)})
        attachment_data = _data(attachment)
        if _text(attachment_data.get("note")).strip():
            notes.append({"key": attachment_key, "version": attachment.get("version", attachment_data.get("version", 0)), "html": attachment_data["note"]})
        all_collections = {record["key"]: record for record in self.collections(library)}
        member_keys = data.get("collections", [])
        if not isinstance(member_keys, list):
            raise ZoteroError("Zotero 分类列表格式无效。")
        selected_collections = []
        ancestor_keys = set()
        for member_key in dict.fromkeys(member_keys):
            member_key = _key(member_key)
            if member_key not in all_collections:
                record, _ = self._json(f"{_library_prefix(library)}/collections/{member_key}")
                if _record_key(record) != member_key:
                    raise ZoteroError("Zotero 返回了无效的所属分类。")
                self._identity(library, record)
                # Trashed collections remain in an item's memberships but not the collection list.
                if _data(record).get("deleted"):
                    continue
                raise ZoteroError("Zotero 所属分类已改变，请重新导入。")
            selected_collections.append(all_collections[member_key])
            visited = {member_key}
            current = all_collections[member_key]["parent_key"]
            while current:
                if current in visited or current not in all_collections:
                    raise ZoteroError("Zotero 分类层级无效，请重新读取文库。")
                visited.add(current)
                ancestor_keys.add(current)
                current = all_collections[current]["parent_key"]
        title, tags = _text(data.get("title")) or "未命名文献", _tags(data)
        source_url = f"zotero://select/{'library' if identity.startswith('user:') else 'groups/' + identity.split(':')[1]}/items/{item_key}"
        self._selected[(library, attachment_key)] = attachment
        return {"source_id": f"zotero:{identity}:{item_key}:{attachment_key}", "library_id": identity,
                "item_key": item_key, "attachment_key": attachment_key, "title": title,
                "metadata": {"title": title, "authors": _authors(data), "abstract": _text(data.get("abstractNote")), "year": _year(data),
                             "venue": next((_text(data.get(field)) for field in ("publicationTitle", "proceedingsTitle", "university", "publisher") if _text(data.get(field))), ""),
                             "doi": _text(data.get("DOI")), "url": _text(data.get("url")), "keywords": tags, "item_type": _text(data.get("itemType"))},
                "tags": tags, "collections": selected_collections,
                "collection_ancestors": [record for key, record in all_collections.items() if key in ancestor_keys and key not in member_keys],
                "notes": notes, "annotations": annotations, "source_url": source_url}

    def download_pdf(self, library: str, attachment_key: str, destination: Path) -> dict[str, Any]:
        prefix, attachment_key = _library_prefix(library), _key(attachment_key)
        attachment = self._selected.get((library, attachment_key))
        if attachment is None:
            attachment = self._item(library, attachment_key)
            parent_key = _data(attachment).get("parentItem")
            if not _is_pdf(attachment) or not parent_key:
                raise ZoteroError("选中的 Zotero 对象不是文献的 PDF 附件。")
            if not any(_record_key(child) == attachment_key and _data(child).get("parentItem") == parent_key and _is_pdf(child)
                       for child in self._children(library, _key(parent_key))):
                raise ZoteroError("选中的 PDF 附件不属于该 Zotero 条目。")
        try:
            body, _ = self._get(f"{prefix}/items/{attachment_key}/file/view/url", file_url=True)
        except ZoteroError as exc:
            if exc.status_code not in {404, 405}:
                raise
            # Earlier Local API releases expose only /file's file:// redirect.
            body, _ = self._get(f"{prefix}/items/{attachment_key}/file", file_url=True)
        try:
            parsed = urllib.parse.urlsplit(body.decode("utf-8").strip())
            if parsed.scheme != "file" or parsed.netloc.lower() not in {"", "localhost"} or parsed.query or parsed.fragment:
                raise ValueError()
            source = Path(urllib.parse.unquote(parsed.path, errors="strict"))
            if not source.is_absolute() or "\0" in str(source) or str(source).startswith("//"):
                raise ValueError()
        except (UnicodeError, ValueError) as exc:
            raise ZoteroError("Zotero 没有返回有效的本地附件文件地址。") from exc
        destination = Path(destination)
        created = False
        try:
            try:
                descriptor = os.open(source, os.O_RDONLY | getattr(os, "O_NONBLOCK", 0))
            except FileNotFoundError as exc:
                raise ZoteroError("Zotero PDF 附件不在本机；请先在 Zotero 中下载或重新定位附件，再导入。") from exc
            except PermissionError as exc:
                raise ZoteroError("无法读取 Zotero PDF 附件，请检查文件读取权限。") from exc
            with os.fdopen(descriptor, "rb") as incoming:
                before = os.fstat(incoming.fileno())
                if not stat.S_ISREG(before.st_mode):
                    raise ZoteroError("Zotero 附件不是普通文件。")
                if before.st_size <= 0 or before.st_size > MAX_PDF_BYTES:
                    raise ZoteroError(f"Zotero PDF 大小必须在 1 字节到 {MAX_PDF_BYTES // (1024 * 1024)} MB 之间。")
                header = incoming.read(1024)
                if not header.startswith(b"%PDF-"):
                    raise ZoteroError("Zotero 附件不是有效的 PDF 文件。")
                digest, size = hashlib.sha256(), 0
                with destination.open("xb") as outgoing:
                    created = True
                    chunk = header
                    while chunk:
                        size += len(chunk)
                        if size > MAX_PDF_BYTES:
                            raise ZoteroError("Zotero PDF 超过大小上限。")
                        digest.update(chunk)
                        outgoing.write(chunk)
                        chunk = incoming.read(1024 * 1024)
                    after = os.fstat(incoming.fileno())
                    if size != before.st_size or after.st_size != before.st_size or after.st_mtime_ns != before.st_mtime_ns:
                        raise ZoteroError("Zotero PDF 在复制时发生变化，请重试。")
                    outgoing.flush()
                    os.fsync(outgoing.fileno())
            filename = Path(_text(_data(attachment).get("filename")).replace("\\", "/")).name or source.name
            return {"filename": filename, "byte_size": size, "sha256": digest.hexdigest()}
        except (OSError, ZoteroError) as exc:
            if created:
                destination.unlink(missing_ok=True)
            if isinstance(exc, ZoteroError):
                raise
            raise ZoteroError("无法读取 Zotero PDF 或写入导入暂存目录。") from exc
