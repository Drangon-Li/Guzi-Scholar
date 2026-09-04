"""Extract and reconcile bibliographic metadata without blocking conversion.

Local PDF/document evidence is collected first. Optional Crossref, arXiv, and
PubMed lookups add candidates with provenance and confidence metadata; the
library store remains responsible for preserving user-locked fields.
"""

from __future__ import annotations

import html
import ipaddress
import json
import re
import socket
import threading
import time
import unicodedata
from datetime import datetime, timezone
from difflib import SequenceMatcher
from http.client import HTTPException, HTTPSConnection
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional
from urllib.parse import quote, urlencode, urljoin, urlsplit
from urllib.error import HTTPError, URLError
from xml.etree import ElementTree
from pymupdf_runtime import load_fitz


BIBLIOGRAPHIC_FIELDS = (
    "title",
    "authors",
    "abstract",
    "year",
    "venue",
    "publication_title",
    "proceedings_title",
    "conference_name",
    "book_title",
    "repository",
    "institution",
    "doi",
    "arxiv_id",
    "pmid",
    "url",
    "publisher",
    "volume",
    "issue",
    "pages",
    "language",
    "keywords",
    "item_type",
)

LIST_FIELDS = {"authors", "keywords"}
INTEGER_FIELDS = {"year"}
DOI_RE = re.compile(r"\b10\.\d{4,9}/[-._;()/:A-Z0-9]+", re.IGNORECASE)
ARXIV_NEW_RE = re.compile(r"(?:arXiv\s*:\s*|arxiv\.org/(?:abs|pdf)/)(\d{4}\.\d{4,5}(?:v\d+)?)", re.IGNORECASE)
ARXIV_OLD_RE = re.compile(r"(?:arXiv\s*:\s*|arxiv\.org/(?:abs|pdf)/)((?:astro-ph|cond-mat|cs|gr-qc|hep-ex|hep-lat|hep-ph|hep-th|math|math-ph|nlin|nucl-ex|nucl-th|physics|q-bio|quant-ph)/\d{7}(?:v\d+)?)", re.IGNORECASE)
PMID_RE = re.compile(r"\bPMID\s*:\s*(\d{5,10})\b", re.IGNORECASE)
TAG_RE = re.compile(r"<[^>]+>")
REQUEST_CACHE_TTL = 600
MAX_METADATA_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_METADATA_CACHE_ENTRIES = 32
MAX_METADATA_REDIRECTS = 5
MAX_METADATA_URL_LENGTH = 8192
REQUEST_CACHE_LOCK = threading.RLock()
REQUEST_CACHE: Dict[tuple[str, str], tuple[float, bytes]] = {}
PROVIDER_SEMAPHORES: Dict[str, threading.BoundedSemaphore] = {}


# Local PDF/document extraction and field normalization.
def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def empty_bibliographic_metadata() -> Dict[str, Any]:
    return {
        "fields": {field: ([] if field in LIST_FIELDS else None if field in INTEGER_FIELDS else "") for field in BIBLIOGRAPHIC_FIELDS},
        "sources": {},
        "locked_fields": [],
        "candidates": [],
        "status": "not-run",
        "retrieved_at": None,
        "error": "",
    }


def _clean_text(value: Any) -> str:
    text = html.unescape(TAG_RE.sub(" ", str(value or "")))
    return re.sub(r"\s+", " ", text).strip()


def _clean_doi(value: str) -> str:
    value = re.sub(r"^https?://(?:dx\.)?doi\.org/", "", value.strip(), flags=re.IGNORECASE)
    value = re.sub(r"^doi\s*:\s*", "", value, flags=re.IGNORECASE).rstrip(".,;:")
    while value.endswith(")") and value.count("(") < value.count(")"):
        value = value[:-1]
    return value.lower()


def _find_arxiv_id(text: str) -> str:
    for pattern in (ARXIV_NEW_RE, ARXIV_OLD_RE):
        match = pattern.search(text or "")
        if match:
            return match.group(1)
    return ""


def _unique_strings(values: Iterable[Any], limit: int = 100) -> List[str]:
    result: List[str] = []
    for value in values:
        entry = _clean_text(value)
        if entry and entry not in result:
            result.append(entry[:500])
        if len(result) >= limit:
            break
    return result


def _year(value: Any) -> Optional[int]:
    match = re.search(r"(?<!\d)(18|19|20|21)\d{2}(?!\d)", str(value or ""))
    if not match:
        return None
    parsed = int(match.group(0))
    return parsed if 1800 <= parsed <= datetime.now().year + 2 else None


def _field(result: Dict[str, Any], name: str, value: Any, provider: str, confidence: float) -> None:
    if name not in BIBLIOGRAPHIC_FIELDS:
        return
    if name in LIST_FIELDS:
        normalized: Any = _unique_strings(value if isinstance(value, list) else [value])
    elif name in INTEGER_FIELDS:
        normalized = _year(value)
    else:
        normalized = _clean_text(value)
    if normalized in (None, "", []):
        return
    current = result["sources"].get(name, {})
    if float(current.get("confidence", 0)) > confidence:
        return
    result["fields"][name] = normalized
    result["sources"][name] = {"provider": provider, "confidence": round(max(0, min(1, confidence)), 3), "retrieved_at": utc_now()}


def _read_document_json(path: Optional[Path]) -> Dict[str, Any]:
    if not path or not path.is_file():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _element_text(element: Dict[str, Any]) -> str:
    return _clean_text(element.get("text") or element.get("rendered_markdown") or element.get("html"))


def is_fragmented_metadata_text(value: Any) -> bool:
    """Identify clearly character-fragmented English metadata without repairing it."""
    text = unicodedata.normalize("NFKC", str(value or ""))
    tokens = re.findall(r"[A-Za-z]+", text)
    if len(tokens) < 24 or len(text) < 80:
        return False
    lengths = [len(token) for token in tokens]
    short_ratio = sum(length <= 2 for length in lengths) / len(lengths)
    single_ratio = sum(length == 1 for length in lengths) / len(lengths)
    longest_run = current_run = 0
    for length in lengths:
        current_run = current_run + 1 if length <= 2 else 0
        longest_run = max(longest_run, current_run)
    return short_ratio >= 0.55 and single_ratio >= 0.25 and longest_run >= 4


def _element_section_role(element: Dict[str, Any]) -> str:
    direct = str(element.get("section_role") or "")
    if direct:
        return direct
    ir = element.get("_ir") if isinstance(element.get("_ir"), dict) else {}
    return str(ir.get("section_role") or "")


def _element_bbox(element: Dict[str, Any]) -> Optional[List[float]]:
    value = element.get("bbox")
    if not isinstance(value, list) or len(value) != 4:
        return None
    try:
        box = [float(coordinate) for coordinate in value]
    except (TypeError, ValueError):
        return None
    return box if box[2] > box[0] and box[3] > box[1] else None


def _same_column_abstract_body(
    elements: List[Any], heading_index: int,
) -> str:
    heading = elements[heading_index] if 0 <= heading_index < len(elements) else None
    if not isinstance(heading, dict):
        return ""
    heading_box = _element_bbox(heading)
    candidates: List[tuple[float, int, str]] = []
    for index, element in enumerate(elements):
        if not isinstance(element, dict) or element.get("type") != "paragraph":
            continue
        text = _element_text(element)
        if not text or is_fragmented_metadata_text(text):
            continue
        if _element_section_role(element) == "abstract-body":
            return re.sub(r"^\s*(?:abstract|摘\s*要)\s*(?:[:：.\u2014-])\s*", "", text, flags=re.IGNORECASE)
        body_box = _element_bbox(element)
        if heading_box is None or body_box is None:
            continue
        overlap = max(0.0, min(heading_box[2], body_box[2]) - max(heading_box[0], body_box[0]))
        overlap /= max(1.0, min(heading_box[2] - heading_box[0], body_box[2] - body_box[0]))
        gap = body_box[1] - heading_box[3]
        if -2.0 <= gap <= 80.0 and overlap >= 0.75:
            candidates.append((max(0.0, gap), index, text))
    if candidates:
        return min(candidates, key=lambda candidate: candidate[:2])[2]
    if heading_box is not None:
        return ""
    for element in elements[heading_index + 1:]:
        if not isinstance(element, dict):
            continue
        if element.get("type") == "title":
            break
        text = _element_text(element)
        if text and element.get("type") == "paragraph" and not is_fragmented_metadata_text(text):
            return text
    return ""


def _document_candidates(document: Dict[str, Any]) -> Dict[str, Any]:
    pages = document.get("pages") if isinstance(document.get("pages"), list) else []
    first_elements = pages[0].get("elements", []) if pages and isinstance(pages[0], dict) else []
    result: Dict[str, Any] = {"title": "", "authors": [], "abstract": "", "scan_text": ""}
    title_index = None
    abstract_index = None
    for index, element in enumerate(first_elements):
        if not isinstance(element, dict):
            continue
        text = _element_text(element)
        if not text:
            continue
        if (
            _element_section_role(element) == "abstract-heading"
            or re.fullmatch(r"(?:abstract|摘\s*要)\s*(?:[:：.\u2014-])?", text, flags=re.IGNORECASE)
        ):
            abstract_index = index
            continue
        if _element_section_role(element) == "abstract-body" and not result["abstract"]:
            candidate = re.sub(r"^\s*(?:abstract|摘\s*要)\s*(?:[:：.\u2014-])\s*", "", text, flags=re.IGNORECASE)
            if candidate and not is_fragmented_metadata_text(candidate):
                result["abstract"] = candidate
        if title_index is None and element.get("type") == "title":
            result["title"] = text
            title_index = index
    if title_index is not None:
        author_lines: List[str] = []
        stop = abstract_index if abstract_index is not None else min(len(first_elements), title_index + 4)
        for element in first_elements[title_index + 1 : stop]:
            if not isinstance(element, dict) or element.get("type") != "paragraph":
                continue
            text = _element_text(element)
            lower = text.lower()
            if not text or any(marker in lower for marker in ("university", "laboratory", "institute", "school of", "department of", "@")):
                continue
            author_lines.append(text)
            if len(author_lines) >= 2:
                break
        if author_lines:
            raw = " ".join(author_lines)
            raw = re.sub(r"\b(?:and|&)\b", ",", raw, flags=re.IGNORECASE)
            result["authors"] = _unique_strings(part for part in raw.split(",") if not re.fullmatch(r"[\d†*\s]+", part))
    if abstract_index is not None and not result["abstract"]:
        result["abstract"] = _same_column_abstract_body(first_elements, abstract_index)
    scan_chunks: List[str] = []
    for page in pages[:2]:
        for element in page.get("elements", []) if isinstance(page, dict) else []:
            if isinstance(element, dict):
                text = _element_text(element)
                if text:
                    scan_chunks.append(text)
    result["scan_text"] = "\n".join(scan_chunks)[:40000]
    return result


def extract_local_metadata(pdf_path: Path, document_json_path: Optional[Path] = None, source_filename: str = "") -> Dict[str, Any]:
    result = empty_bibliographic_metadata()
    document = _document_candidates(_read_document_json(document_json_path))
    pdf_metadata: Dict[str, Any] = {}
    pdf_page_texts: List[str] = []
    pdf_link_uris: List[str] = []
    try:
        fitz = load_fitz()

        with fitz.open(pdf_path) as pdf:
            pdf_metadata = dict(pdf.metadata or {})
            # Bibliographic identifiers belong in the front matter. Scanning
            # deep into the paper makes the first DOI in a reference list look
            # like the identity of the uploaded document.
            for page_index in range(min(2, int(pdf.page_count))):
                page = pdf.load_page(page_index)
                text = str(page.get_text("text", sort=True) or "").strip()
                if text:
                    pdf_page_texts.append(text)
                for link in page.get_links() or []:
                    uri = str(link.get("uri") or "").strip() if isinstance(link, dict) else ""
                    if uri:
                        pdf_link_uris.append(uri)
    except Exception:
        pdf_metadata = {}

    _field(result, "title", document.get("title") or pdf_metadata.get("title"), "local-document", 0.86 if document.get("title") else 0.62)
    if not result["fields"]["title"] and pdf_page_texts:
        first_lines = [_clean_text(line) for line in pdf_page_texts[0].splitlines()[:18]]
        first_lines = [
            line for line in first_lines
            if 18 <= len(line) <= 300
            and not re.match(r"^(?:arxiv|doi|abstract|preprint|proceedings|volume|vol\.|copyright)\b", line, re.IGNORECASE)
            and not any(marker in line.lower() for marker in ("university", "institute", "department", "@"))
        ]
        if first_lines:
            _field(result, "title", first_lines[0], "pdf-first-pages", 0.58)
    if not result["fields"]["title"]:
        _field(result, "title", re.sub(r"\.pdf$", "", source_filename, flags=re.IGNORECASE), "filename", 0.35)
    _field(result, "authors", document.get("authors") or [pdf_metadata.get("author")], "local-document", 0.72 if document.get("authors") else 0.5)
    document_abstract = str(document.get("abstract") or "").strip()
    if is_fragmented_metadata_text(document_abstract):
        document_abstract = ""
    xmp_subject = str(pdf_metadata.get("subject") or "").strip()
    if len(xmp_subject) < 100 or is_fragmented_metadata_text(xmp_subject) or xmp_subject.startswith("-"):
        xmp_subject = ""
    if document_abstract:
        _field(result, "abstract", document_abstract, "local-document", 0.78)
    elif xmp_subject:
        _field(result, "abstract", xmp_subject, "pdf-xmp", 0.45)
    _field(result, "keywords", re.split(r"[,;]", str(pdf_metadata.get("keywords") or "")), "pdf-xmp", 0.55)
    _field(result, "year", pdf_metadata.get("creationDate") or pdf_metadata.get("modDate"), "pdf-xmp", 0.48)
    if not result["fields"]["year"]:
        _field(result, "year", source_filename, "filename", 0.35)
    _field(result, "item_type", "journal-article", "local-default", 0.3)

    identifier_sources = [
        ("pdf-xmp-identifier", str(pdf_metadata), 0.99),
        ("pdf-link-identifier", "\n".join(pdf_link_uris), 0.98),
        ("pdf-first-page-identifier", pdf_page_texts[0] if pdf_page_texts else "", 0.97),
        ("pdf-front-matter-identifier", "\n".join(pdf_page_texts[1:2]), 0.93),
        ("parsed-front-matter-identifier", str(document.get("scan_text") or ""), 0.91),
        ("filename-identifier", source_filename, 0.7),
    ]
    for provider, scan_text, confidence in identifier_sources:
        if not result["fields"]["doi"]:
            doi_match = DOI_RE.search(scan_text)
            if doi_match:
                _field(result, "doi", _clean_doi(doi_match.group(0)), provider, confidence)
        if not result["fields"]["arxiv_id"]:
            arxiv_id = _find_arxiv_id(scan_text)
            if arxiv_id:
                _field(result, "arxiv_id", arxiv_id, provider, confidence)
        if not result["fields"]["pmid"]:
            pmid_match = PMID_RE.search(scan_text)
            if pmid_match:
                _field(result, "pmid", pmid_match.group(1), provider, confidence)
    result["status"] = "local" if any(value not in (None, "", []) for value in result["fields"].values()) else "not-run"
    result["retrieved_at"] = utc_now()
    return result


# Provider transports and provider-specific response normalization.
class _PinnedHTTPSConnection(HTTPSConnection):
    def __init__(self, host: str, port: int, resolved_ip: str, *, timeout: int) -> None:
        super().__init__(host, port=port, timeout=timeout)
        self._resolved_ip = resolved_ip
        self._create_connection = self._open_pinned_socket

    def _open_pinned_socket(
        self,
        _address: tuple[str, int],
        timeout: Any = socket._GLOBAL_DEFAULT_TIMEOUT,
        source_address: Optional[tuple[str, int]] = None,
    ) -> socket.socket:
        return socket.create_connection((self._resolved_ip, self.port), timeout, source_address)


def _validated_https_target(url: str) -> tuple[str, int, str, List[str]]:
    value = str(url or "").strip()
    if not value or len(value) > MAX_METADATA_URL_LENGTH:
        raise ValueError("元数据服务地址无效或过长。")
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as exc:
        raise ValueError("元数据服务地址无效。") from exc
    if parsed.scheme.lower() != "https":
        raise ValueError("元数据服务仅允许 HTTPS 地址。")
    if parsed.username or parsed.password:
        raise ValueError("元数据服务地址不得包含凭据。")
    port = port or 443
    hostname = str(parsed.hostname or "").rstrip(".")
    if not hostname:
        raise ValueError("元数据服务地址缺少主机名。")
    try:
        ascii_hostname = hostname.encode("idna").decode("ascii").lower()
        records = socket.getaddrinfo(ascii_hostname, port, type=socket.SOCK_STREAM, proto=socket.IPPROTO_TCP)
    except UnicodeError as exc:
        raise ValueError("元数据服务主机名无效。") from exc
    addresses: List[str] = []
    for _family, _socktype, _protocol, _canonical, sockaddr in records:
        try:
            address = ipaddress.ip_address(str(sockaddr[0]).split("%", 1)[0])
        except ValueError as exc:
            raise ValueError("元数据服务返回了无效网络地址。") from exc
        if not address.is_global:
            raise ValueError("元数据服务地址必须解析到公共网络。")
        normalized = str(address)
        if normalized not in addresses:
            addresses.append(normalized)
    if not addresses:
        raise ValueError("元数据服务没有可用的公共网络地址。")
    path = parsed.path or "/"
    if parsed.query:
        path += "?" + parsed.query
    return ascii_hostname, port, path, addresses


def _request_https_once(
    url: str,
    *,
    user_agent: str,
    accept: str,
    timeout: int,
) -> tuple[int, Any, bytes]:
    host, port, path, addresses = _validated_https_target(url)
    last_error: Optional[BaseException] = None
    for address in addresses:
        connection = _PinnedHTTPSConnection(host, port, address, timeout=timeout)
        try:
            connection.request("GET", path, headers={"Accept": accept, "User-Agent": user_agent})
            response = connection.getresponse()
            status = int(response.status)
            headers = response.headers
            if status in {301, 302, 303, 307, 308}:
                return status, headers, b""
            if not 200 <= status < 300:
                raise HTTPError(url, status, str(response.reason or "HTTP error"), headers, None)
            content_length = str(headers.get("Content-Length", "") or "").strip()
            if content_length.isdigit() and int(content_length) > MAX_METADATA_RESPONSE_BYTES:
                raise ValueError("元数据服务响应超过 2 MB 限制。")
            data = response.read(MAX_METADATA_RESPONSE_BYTES + 1)
            if len(data) > MAX_METADATA_RESPONSE_BYTES:
                raise ValueError("元数据服务响应超过 2 MB 限制。")
            return status, headers, data
        except HTTPError:
            raise
        except (HTTPException, OSError) as exc:
            last_error = exc
        finally:
            connection.close()
    raise URLError(last_error or "元数据服务连接失败。")


def _fetch_with_redirects(url: str, *, user_agent: str, accept: str, timeout: int) -> bytes:
    current = url
    redirects = 0
    while True:
        status, headers, data = _request_https_once(
            current,
            user_agent=user_agent,
            accept=accept,
            timeout=timeout,
        )
        if status not in {301, 302, 303, 307, 308}:
            return data
        location = str(headers.get("Location", "") or "").strip()
        if not location:
            raise HTTPError(current, status, "重定向缺少目标地址。", headers, None)
        if redirects >= MAX_METADATA_REDIRECTS:
            raise ValueError(f"元数据服务重定向超过 {MAX_METADATA_REDIRECTS} 次限制。")
        current = urljoin(current, location)
        redirects += 1


def _fetch_bytes(
    url: str,
    *,
    user_agent: str,
    accept: str,
    timeout: int = 6,
    retries: int = 1,
) -> bytes:
    cache_key = (url, accept)
    now = time.monotonic()
    with REQUEST_CACHE_LOCK:
        cached = REQUEST_CACHE.get(cache_key)
        if cached and cached[0] > now:
            return cached[1]
        if cached:
            REQUEST_CACHE.pop(cache_key, None)
    host = str(urlsplit(url).hostname or "metadata")
    with REQUEST_CACHE_LOCK:
        provider_semaphore = PROVIDER_SEMAPHORES.setdefault(host, threading.BoundedSemaphore(2))
    for attempt in range(retries + 1):
        try:
            with provider_semaphore:
                data = _fetch_with_redirects(url, user_agent=user_agent, accept=accept, timeout=timeout)
            with REQUEST_CACHE_LOCK:
                REQUEST_CACHE[cache_key] = (time.monotonic() + REQUEST_CACHE_TTL, data)
                while len(REQUEST_CACHE) > MAX_METADATA_CACHE_ENTRIES:
                    REQUEST_CACHE.pop(next(iter(REQUEST_CACHE)))
            return data
        except HTTPError as exc:
            if exc.code not in {429, 500, 502, 503, 504} or attempt >= retries:
                raise
            retry_after = str(exc.headers.get("Retry-After", "") or "").strip()
            try:
                delay = float(retry_after)
            except ValueError:
                delay = 0.4 * (2 ** attempt)
            time.sleep(max(0.05, min(1.5, delay)))
        except URLError:
            if attempt >= retries:
                raise
            time.sleep(0.25 * (2 ** attempt))
    raise RuntimeError("元数据请求失败。")


def _fetch_json(url: str, *, user_agent: str, timeout: int = 6, accept: str = "application/json") -> Dict[str, Any]:
    payload = json.loads(_fetch_bytes(url, user_agent=user_agent, accept=accept, timeout=timeout).decode("utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("元数据服务返回了无效 JSON。")
    return payload


def _fetch_text(url: str, *, user_agent: str, timeout: int = 6) -> str:
    return _fetch_bytes(
        url,
        user_agent=user_agent,
        accept="application/atom+xml, application/xml, text/xml",
        timeout=timeout,
    ).decode("utf-8", errors="replace")


def _date_parts(item: Dict[str, Any]) -> Optional[int]:
    for key in ("published-print", "published-online", "published", "issued", "created"):
        value = item.get(key)
        if not isinstance(value, dict):
            continue
        parts = value.get("date-parts")
        if isinstance(parts, list) and parts and isinstance(parts[0], list) and parts[0]:
            return _year(parts[0][0])
    return None


def _crossref_fields(item: Dict[str, Any]) -> Dict[str, Any]:
    authors = []
    for author in item.get("author", []) if isinstance(item.get("author"), list) else []:
        if not isinstance(author, dict):
            continue
        name = " ".join(str(author.get(key) or "").strip() for key in ("given", "family")).strip()
        if name:
            authors.append(name)
    item_type = str(item.get("type") or "journal-article")
    container = (item.get("container-title") or [""])[0] if isinstance(item.get("container-title"), list) else item.get("container-title", "")
    event = item.get("event") if isinstance(item.get("event"), dict) else {}
    institution = item.get("institution")
    if isinstance(institution, list):
        institution = next((entry.get("name") for entry in institution if isinstance(entry, dict) and entry.get("name")), "")
    fields = {
        "title": (item.get("title") or [""])[0] if isinstance(item.get("title"), list) else item.get("title", ""),
        "authors": authors,
        "abstract": item.get("abstract", ""),
        "year": _date_parts(item),
        "doi": _clean_doi(str(item.get("DOI") or "")),
        "url": item.get("URL", ""),
        "publisher": item.get("publisher", ""),
        "institution": institution or "",
        "volume": item.get("volume", ""),
        "issue": item.get("issue", ""),
        "pages": item.get("page", ""),
        "language": item.get("language", ""),
        "keywords": item.get("subject", []),
        "item_type": item_type,
    }
    if item_type == "proceedings-article":
        fields["proceedings_title"] = container
        fields["conference_name"] = event.get("name", "")
    elif item_type in {"book-chapter", "book-section"}:
        fields["book_title"] = container
    elif item_type in {"posted-content", "preprint"}:
        fields["repository"] = item.get("group-title") or container or item.get("publisher", "")
    else:
        fields["publication_title"] = container
    fields["venue"] = _derive_venue(fields)
    return fields


def _derive_venue(fields: Dict[str, Any]) -> str:
    item_type = str(fields.get("item_type") or "").lower()
    if item_type in {"proceedings-article", "paper-conference", "conference-paper"}:
        return _clean_text(fields.get("conference_name") or fields.get("proceedings_title"))
    if item_type in {"book-chapter", "book-section", "chapter"}:
        return _clean_text(fields.get("book_title"))
    if item_type in {"posted-content", "preprint"}:
        return _clean_text(fields.get("publication_title") or fields.get("repository") or "arXiv")
    if item_type in {"report", "dissertation", "thesis"}:
        return _clean_text(fields.get("institution") or fields.get("publisher"))
    return _clean_text(
        fields.get("publication_title")
        or fields.get("conference_name")
        or fields.get("proceedings_title")
        or fields.get("book_title")
        or fields.get("repository")
        or fields.get("institution")
        or fields.get("publisher")
    )


def _title_similarity(left: str, right: str) -> float:
    def normalize(value: Any) -> str:
        normalized = unicodedata.normalize("NFKC", str(value or "")).casefold()
        return re.sub(r"\s+", " ", "".join(character if character.isalnum() else " " for character in normalized)).strip()
    return SequenceMatcher(None, normalize(left), normalize(right)).ratio()


def _candidate_match(local: Dict[str, Any], remote: Dict[str, Any]) -> Dict[str, Any]:
    title_score = _title_similarity(str(local.get("title") or ""), str(remote.get("title") or ""))
    def author_token(value: Any) -> str:
        # Local layout extraction often leaves affiliation markers after a
        # surname (for example ``Jiaming Han 1``). Keep the last word token.
        normalized = unicodedata.normalize("NFKC", str(value or "")).casefold()
        tokens = re.findall(r"[^\W\d_]+", normalized, flags=re.UNICODE)
        return tokens[-1] if tokens else ""
    local_author_tokens = {
        author_token(name)
        for name in local.get("authors") or [] if str(name).strip()
    }
    remote_author_tokens = {
        author_token(name)
        for name in remote.get("authors") or [] if str(name).strip()
    }
    local_author_tokens.discard("")
    remote_author_tokens.discard("")
    author_score = (
        len(local_author_tokens & remote_author_tokens) / max(1, min(len(local_author_tokens), len(remote_author_tokens)))
        if local_author_tokens and remote_author_tokens else 0.0
    )
    local_year = local.get("year")
    remote_year = remote.get("year")
    year_delta = abs(int(local_year) - int(remote_year)) if local_year and remote_year else None
    year_score = 1.0 if year_delta == 0 else 0.65 if year_delta == 1 else 0.0
    confidence = round(0.72 * title_score + 0.2 * author_score + 0.08 * year_score, 3)
    return {
        "confidence": confidence,
        "title": round(title_score, 3),
        "authors": round(author_score, 3),
        "year_delta": year_delta,
        "has_identifier": bool(remote.get("doi") or remote.get("arxiv_id") or remote.get("pmid")),
    }


def _candidate_confidence(local: Dict[str, Any], remote: Dict[str, Any]) -> float:
    return float(_candidate_match(local, remote)["confidence"])


def _candidate_is_safe(match: Dict[str, Any]) -> bool:
    author_confirmed = (
        float(match.get("title", 0)) >= 0.92
        and float(match.get("authors", 0)) >= 0.5
        and (match.get("year_delta") is None or int(match["year_delta"]) <= 1)
    )
    title_year_identifier = (
        float(match.get("title", 0)) >= 0.985
        and match.get("year_delta") == 0
        and bool(match.get("has_identifier"))
    )
    return author_confirmed or title_year_identifier


def _exact_candidate_is_consistent(local_result: Dict[str, Any], remote: Dict[str, Any]) -> bool:
    """Reject an exact-identifier result that clearly belongs to a citation."""
    local = local_result.get("fields") if isinstance(local_result.get("fields"), dict) else {}
    title_source = local_result.get("sources", {}).get("title", {})
    local_title = str(local.get("title") or "").strip()
    remote_title = str(remote.get("title") or "").strip()
    title_confidence = float(title_source.get("confidence", 0) or 0)
    title_provider = str(title_source.get("provider") or "")
    if not local_title or not remote_title or title_confidence < 0.55 or title_provider == "filename":
        return True
    match = _candidate_match(local, remote)
    if float(match.get("title", 0)) < 0.76:
        return False
    local_authors = local.get("authors") or []
    remote_authors = remote.get("authors") or []
    if local_authors and remote_authors and float(match.get("title", 0)) < 0.9 and float(match.get("authors", 0)) < 0.15:
        return False
    return True


def _crossref_exact(doi: str, user_agent: str) -> Dict[str, Any]:
    payload = _fetch_json(f"https://api.crossref.org/works/{quote(doi, safe='')}", user_agent=user_agent)
    message = payload.get("message")
    if not isinstance(message, dict):
        raise ValueError("Crossref 没有返回匹配记录。")
    return _crossref_fields(message)


def _csl_fields(item: Dict[str, Any]) -> Dict[str, Any]:
    authors = []
    for author in item.get("author", []) if isinstance(item.get("author"), list) else []:
        if not isinstance(author, dict):
            continue
        name = str(author.get("literal") or "").strip()
        if not name:
            name = " ".join(str(author.get(key) or "").strip() for key in ("given", "family")).strip()
        if name:
            authors.append(name)
    item_type = str(item.get("type") or "article-journal")
    type_map = {
        "article-journal": "journal-article",
        "paper-conference": "proceedings-article",
        "chapter": "book-chapter",
        "article": "journal-article",
        "report": "report",
        "thesis": "thesis",
    }
    normalized_type = type_map.get(item_type, item_type)
    issued = item.get("issued") if isinstance(item.get("issued"), dict) else {}
    date_parts = issued.get("date-parts") if isinstance(issued, dict) else []
    year = _year(date_parts[0][0]) if isinstance(date_parts, list) and date_parts and isinstance(date_parts[0], list) and date_parts[0] else None
    container = item.get("container-title")
    if isinstance(container, list):
        container = container[0] if container else ""
    fields: Dict[str, Any] = {
        "title": item.get("title", ""),
        "authors": authors,
        "abstract": item.get("abstract", ""),
        "year": year,
        "doi": _clean_doi(str(item.get("DOI") or item.get("doi") or "")),
        "url": item.get("URL") or item.get("url", ""),
        "publisher": item.get("publisher", ""),
        "volume": item.get("volume", ""),
        "issue": item.get("issue", ""),
        "pages": item.get("page", ""),
        "language": item.get("language", ""),
        "keywords": item.get("keyword", []),
        "item_type": normalized_type,
    }
    if normalized_type == "proceedings-article":
        fields["proceedings_title"] = container or ""
        fields["conference_name"] = item.get("event-title") or item.get("event", "")
    elif normalized_type == "book-chapter":
        fields["book_title"] = container or ""
    elif normalized_type in {"posted-content", "preprint"}:
        fields["repository"] = container or item.get("collection-title", "")
    elif normalized_type in {"report", "thesis", "dissertation"}:
        fields["institution"] = item.get("publisher") or item.get("authority", "")
    else:
        fields["publication_title"] = container or ""
    fields["venue"] = _derive_venue(fields)
    return fields


def _datacite_fields(payload: Dict[str, Any]) -> Dict[str, Any]:
    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    attributes = data.get("attributes") if isinstance(data.get("attributes"), dict) else {}
    titles = attributes.get("titles") if isinstance(attributes.get("titles"), list) else []
    creators = attributes.get("creators") if isinstance(attributes.get("creators"), list) else []
    container = attributes.get("container") if isinstance(attributes.get("container"), dict) else {}
    types = attributes.get("types") if isinstance(attributes.get("types"), dict) else {}
    resource_type = str(types.get("resourceTypeGeneral") or types.get("resourceType") or "posted-content").lower()
    item_type = "journal-article" if "article" in resource_type else "report" if "report" in resource_type else "posted-content"
    fields: Dict[str, Any] = {
        "title": titles[0].get("title", "") if titles and isinstance(titles[0], dict) else "",
        "authors": [entry.get("name", "") for entry in creators if isinstance(entry, dict)],
        "year": _year(attributes.get("publicationYear") or attributes.get("published")),
        "doi": _clean_doi(str(attributes.get("doi") or data.get("id") or "")),
        "url": attributes.get("url", ""),
        "publisher": attributes.get("publisher", ""),
        "publication_title": container.get("title", "") if item_type == "journal-article" else "",
        "repository": attributes.get("publisher", "") if item_type == "posted-content" else "",
        "institution": attributes.get("publisher", "") if item_type == "report" else "",
        "language": attributes.get("language", ""),
        "item_type": item_type,
    }
    descriptions = attributes.get("descriptions") if isinstance(attributes.get("descriptions"), list) else []
    fields["abstract"] = next((entry.get("description", "") for entry in descriptions if isinstance(entry, dict) and str(entry.get("descriptionType") or "").lower() == "abstract"), "")
    fields["venue"] = _derive_venue(fields)
    return fields


def _doi_exact(doi: str, user_agent: str) -> tuple[Dict[str, Any], str]:
    errors = []
    try:
        payload = _fetch_json(
            f"https://doi.org/{quote(doi, safe='/')}",
            user_agent=user_agent,
            accept="application/vnd.citationstyles.csl+json, application/json;q=0.9",
        )
        fields = _csl_fields(payload)
        if fields.get("title"):
            return fields, "doi-content-negotiation"
    except Exception as exc:
        errors.append(str(exc))
    try:
        return _crossref_exact(doi, user_agent), "crossref-doi"
    except Exception as exc:
        errors.append(str(exc))
    try:
        payload = _fetch_json(f"https://api.datacite.org/dois/{quote(doi, safe='')}", user_agent=user_agent)
        fields = _datacite_fields(payload)
        if fields.get("title"):
            return fields, "datacite-doi"
    except Exception as exc:
        errors.append(str(exc))
    raise ValueError("DOI 元数据检索失败：" + "; ".join(error for error in errors if error)[:350])


def _crossref_candidates(fields: Dict[str, Any], user_agent: str) -> List[Dict[str, Any]]:
    title = str(fields.get("title") or "").strip()
    if not title:
        return []
    params = {"query.bibliographic": " ".join((title, " ".join(fields.get("authors") or []), str(fields.get("year") or ""))).strip(), "rows": "3"}
    payload = _fetch_json(f"https://api.crossref.org/works?{urlencode(params)}", user_agent=user_agent)
    message = payload.get("message")
    items = message.get("items", []) if isinstance(message, dict) else []
    candidates = []
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict):
            continue
        remote = _crossref_fields(item)
        match = _candidate_match(fields, remote)
        candidates.append({"provider": "crossref", "confidence": match["confidence"], "match": match, "fields": remote})
    return sorted(candidates, key=lambda item: item["confidence"], reverse=True)


def _arxiv_fields(arxiv_id: str, user_agent: str) -> Dict[str, Any]:
    xml = _fetch_text(f"https://export.arxiv.org/api/query?id_list={quote(arxiv_id, safe='')}", user_agent=user_agent)
    root = ElementTree.fromstring(xml)
    namespace = {"atom": "http://www.w3.org/2005/Atom", "arxiv": "http://arxiv.org/schemas/atom"}
    entry = root.find("atom:entry", namespace)
    if entry is None:
        raise ValueError("arXiv 没有返回匹配记录。")
    authors = [node.text or "" for node in entry.findall("atom:author/atom:name", namespace)]
    published = entry.findtext("atom:published", default="", namespaces=namespace)
    published_doi = _clean_doi(entry.findtext("arxiv:doi", default="", namespaces=namespace))
    journal_ref = _clean_text(entry.findtext("arxiv:journal_ref", default="", namespaces=namespace))
    fields = {
        "title": entry.findtext("atom:title", default="", namespaces=namespace),
        "authors": authors,
        "abstract": entry.findtext("atom:summary", default="", namespaces=namespace),
        "year": _year(published),
        "doi": published_doi,
        "arxiv_id": arxiv_id,
        "url": f"https://arxiv.org/abs/{arxiv_id}",
        "publication_title": journal_ref,
        "repository": "arXiv",
        "item_type": "journal-article" if journal_ref else "posted-content",
    }
    fields["venue"] = _derive_venue(fields)
    return fields


def _pubmed_fields(pmid: str, user_agent: str) -> Dict[str, Any]:
    params = urlencode({"db": "pubmed", "id": pmid, "retmode": "json"})
    payload = _fetch_json(f"https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?{params}", user_agent=user_agent)
    result = payload.get("result")
    item = result.get(pmid) if isinstance(result, dict) else None
    if not isinstance(item, dict):
        raise ValueError("PubMed 没有返回匹配记录。")
    article_ids = item.get("articleids", []) if isinstance(item.get("articleids"), list) else []
    doi = next((entry.get("value") for entry in article_ids if isinstance(entry, dict) and entry.get("idtype") == "doi"), "")
    authors = [entry.get("name", "") for entry in item.get("authors", []) if isinstance(entry, dict)]
    fields = {
        "title": item.get("title", ""),
        "authors": authors,
        "year": _year(item.get("pubdate")),
        "publication_title": item.get("fulljournalname") or item.get("source", ""),
        "doi": doi,
        "pmid": pmid,
        "volume": item.get("volume", ""),
        "issue": item.get("issue", ""),
        "pages": item.get("pages", ""),
        "url": f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/",
        "item_type": "journal-article",
    }
    fields["venue"] = _derive_venue(fields)
    return fields


def _merge_candidate(result: Dict[str, Any], fields: Dict[str, Any], provider: str, confidence: float) -> None:
    for field, value in fields.items():
        _field(result, field, value, provider, confidence)


# Public local-first retrieval and confidence-based merge.
def retrieve_bibliographic_metadata(
    pdf_path: Path,
    document_json_path: Optional[Path],
    source_filename: str,
    *,
    online: bool = True,
    contact_email: str = "",
) -> Dict[str, Any]:
    result = extract_local_metadata(pdf_path, document_json_path, source_filename)
    if not online:
        return result
    user_agent = "MyScholar/0.1.12 (local research reader"
    if contact_email.strip():
        user_agent += f"; mailto:{contact_email.strip()}"
    user_agent += ")"
    fields = result["fields"]
    errors: List[str] = []
    exact_match = False
    resolved_dois: set[str] = set()

    def resolve_doi(value: Any) -> bool:
        nonlocal exact_match
        doi = _clean_doi(str(value or ""))
        if not doi or doi in resolved_dois:
            return False
        resolved_dois.add(doi)
        try:
            remote, provider = _doi_exact(doi, user_agent)
            if not _exact_candidate_is_consistent(result, remote):
                if _clean_doi(str(fields.get("doi") or "")) == doi:
                    fields["doi"] = ""
                    result["sources"].pop("doi", None)
                errors.append("DOI 返回的标题/作者与当前文献不一致，已忽略该标识符。")
                return False
            _merge_candidate(result, remote, provider, 0.99)
            exact_match = True
            return True
        except Exception as exc:
            errors.append(str(exc))
            return False

    if fields.get("doi"):
        resolve_doi(fields.get("doi"))

    if fields.get("arxiv_id") and not exact_match:
        try:
            remote = _arxiv_fields(str(fields["arxiv_id"]), user_agent)
            if not _exact_candidate_is_consistent(result, remote):
                fields["arxiv_id"] = ""
                result["sources"].pop("arxiv_id", None)
                raise ValueError("arXiv 返回的标题/作者与当前文献不一致，已忽略该标识符。")
            _merge_candidate(result, remote, "arxiv", 0.97)
            exact_match = True
            if remote.get("doi"):
                resolve_doi(remote.get("doi"))
        except Exception as exc:
            errors.append(str(exc))

    if fields.get("pmid") and not exact_match:
        try:
            remote = _pubmed_fields(str(fields["pmid"]), user_agent)
            if not _exact_candidate_is_consistent(result, remote):
                fields["pmid"] = ""
                result["sources"].pop("pmid", None)
                raise ValueError("PubMed 返回的标题/作者与当前文献不一致，已忽略该标识符。")
            _merge_candidate(result, remote, "pubmed", 0.98)
            exact_match = True
            if remote.get("doi"):
                resolve_doi(remote.get("doi"))
        except Exception as exc:
            errors.append(str(exc))

    if exact_match:
        result["status"] = "complete"
    else:
        try:
            local_for_score = dict(fields)
            local_for_score["title_source"] = result["sources"].get("title", {}).get("provider")
            candidates = _crossref_candidates(local_for_score, user_agent)
            result["candidates"] = candidates
            if candidates and _candidate_is_safe(candidates[0].get("match", {})):
                _merge_candidate(result, candidates[0]["fields"], "crossref-search", float(candidates[0]["confidence"]))
                result["status"] = "complete"
            elif candidates:
                result["status"] = "needs-review"
            else:
                result["status"] = "local"
        except Exception as exc:
            errors.append(str(exc))
            result["status"] = "local" if any(value not in (None, "", []) for value in fields.values()) else "failed"

    if not fields.get("venue"):
        venue = _derive_venue(fields)
        if venue:
            _field(result, "venue", venue, "derived-venue", 0.9)
    result["error"] = "" if result["status"] == "complete" else "; ".join(dict.fromkeys(error for error in errors if error))[:500]
    result["retrieved_at"] = utc_now()
    return result


def _reference_title_coverage(reference_text: str, title: str) -> float:
    def tokens(value: str) -> set[str]:
        normalized = unicodedata.normalize("NFKC", value).casefold()
        return {token for token in re.findall(r"[^\W_]+", normalized, flags=re.UNICODE) if len(token) > 2}
    title_tokens = tokens(title)
    if not title_tokens:
        return 0.0
    return len(title_tokens & tokens(reference_text)) / len(title_tokens)


def retrieve_reference_evidence(reference_text: str, *, contact_email: str = "") -> Dict[str, Any]:
    """Resolve one bibliography entry through fixed academic metadata providers.

    The caller supplies citation text, never a URL. Provider endpoints are
    constructed here so this feature cannot become an arbitrary network fetch.
    """
    citation = re.sub(r"\s+", " ", str(reference_text or "")).strip()[:6000]
    if not citation:
        raise ValueError("参考文献条目为空。")
    user_agent = "MyScholar/0.1.12 (reference quick read"
    if contact_email.strip():
        user_agent += f"; mailto:{contact_email.strip()}"
    user_agent += ")"
    fields: Dict[str, Any] = {}
    provider = ""
    errors: List[str] = []
    doi_match = DOI_RE.search(citation)
    arxiv_id = _find_arxiv_id(citation)
    pmid_match = PMID_RE.search(citation)
    if doi_match:
        try:
            fields, provider = _doi_exact(_clean_doi(doi_match.group(0)), user_agent)
        except Exception as exc:
            errors.append(str(exc))
    if not fields and arxiv_id:
        try:
            fields = _arxiv_fields(arxiv_id, user_agent)
            provider = "arxiv"
        except Exception as exc:
            errors.append(str(exc))
    if not fields and pmid_match:
        try:
            fields = _pubmed_fields(pmid_match.group(1), user_agent)
            provider = "pubmed"
        except Exception as exc:
            errors.append(str(exc))
    if not fields:
        try:
            params = urlencode({"query.bibliographic": citation, "rows": "3"})
            payload = _fetch_json(f"https://api.crossref.org/works?{params}", user_agent=user_agent)
            message = payload.get("message")
            items = message.get("items", []) if isinstance(message, dict) else []
            candidates = [_crossref_fields(item) for item in items if isinstance(item, dict)]
            fields = next(
                (candidate for candidate in candidates if _reference_title_coverage(citation, str(candidate.get("title") or "")) >= 0.72),
                {},
            )
            if fields:
                provider = "crossref-search"
            else:
                errors.append("在线候选与参考文献标题无法可靠匹配。")
        except Exception as exc:
            errors.append(str(exc))
    abstract = html.unescape(TAG_RE.sub(" ", str(fields.get("abstract") or "")))
    abstract = re.sub(r"\s+", " ", abstract).strip()[:12000]
    safe_fields = {
        "title": _clean_text(fields.get("title"))[:1000],
        "authors": [_clean_text(value)[:240] for value in (fields.get("authors") or [])[:50]],
        "year": fields.get("year"),
        "venue": _clean_text(fields.get("venue"))[:500],
        "doi": _clean_doi(str(fields.get("doi") or ""))[:300],
        "arxiv_id": _clean_text(fields.get("arxiv_id"))[:100],
        "pmid": _clean_text(fields.get("pmid"))[:100],
        "abstract": abstract,
    }
    evidence_level = "abstract" if abstract else "metadata" if fields else "citation-only"
    sources = [{"provider": provider, "label": provider.replace("-", " ").title(), "evidence": evidence_level}] if provider else []
    return {
        "citation": citation,
        "fields": safe_fields,
        "sources": sources,
        "evidence_level": evidence_level,
        "error": "; ".join(dict.fromkeys(error for error in errors if error))[:500],
    }
