"""multipart/form-data parsing for the local HTTP API.

``cgi`` was removed in Python 3.13. This parser works directly on the request
bytes, decodes header text latin-1 -> UTF-8 the way ``cgi`` did, and keeps the
slice of the ``cgi.FieldStorage`` interface the server uses.

Small forms are read into memory (:func:`_parse_multipart_form`). Large
uploads are spooled to disk first and scanned in bounded reads
(:func:`_spool_request_body`, :func:`_spooled_body`, :func:`_multipart_parts`),
so the PDF is never held in process memory; both paths share one scanner, so
they accept and reject exactly the same bodies.
"""

from __future__ import annotations

import base64
import io
import os
import quopri
import re
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, Iterator, List

from pipeline import PipelineError

SPOOL_CHUNK_BYTES = 1024 * 1024


class _MultipartFile:
    """One multipart field, mirroring the slice of the removed
    ``cgi.FieldStorage`` interface this server uses."""

    def __init__(self, filename: str, data: bytes) -> None:
        self.filename = filename
        self.data = data
        self.file = io.BytesIO(data)


def _decode_multipart_text(value: str) -> str:
    """Restore UTF-8 header text from the latin-1 parsing round-trip.

    Browsers send multipart filenames as raw UTF-8 bytes; the removed ``cgi``
    module decoded them as UTF-8 and this keeps that behavior.
    """
    try:
        return value.encode("latin-1").decode("utf-8")
    except UnicodeError:
        return value


def _disposition_param(disposition: str, name: str) -> str:
    """Read one Content-Disposition parameter from an already-decoded header.

    ``Message.get_param`` replaces surrogateescape bytes with U+FFFD before we
    can restore them, so the parameter is taken from the raw header instead.
    """
    quoted = re.search(rf'(?<![\w-]){name}\s*=\s*"((?:[^"\\]|\\.)*)"', disposition, re.IGNORECASE)
    if quoted:
        return re.sub(r"\\(.)", r"\1", quoted.group(1))
    plain = re.search(rf"(?<![\w-]){name}\s*=\s*([^;\r\n]+)", disposition, re.IGNORECASE)
    return plain.group(1).strip() if plain else ""


_MULTIPART_BOUNDARY_RE = re.compile(r'(?<![\w-])boundary\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;\s]+))', re.IGNORECASE)


_MULTIPART_LINE_BREAK_RE = re.compile(r"\r\n|\r|\n")
_MULTIPART_LINE_END_RE = re.compile(rb"\r\n|\r|\n")
# A header or continuation line, as email.feedparser.headerRE defines it.
_MULTIPART_HEADER_LINE_RE = re.compile(rb"From |[\041-\071\073-\176]*:|[\t ]")
_MULTIPART_HEADER_NAME_RE = re.compile(rb"[\041-\071\073-\176]*")
_LINE_WINDOW_BYTES = 64 * 1024


def _multipart_headers(raw: bytes) -> Dict[str, str]:
    """Parse one part's header block. Names are case-insensitive and the first
    occurrence wins, matching ``email.message.Message.get``."""
    headers: Dict[str, str] = {}
    current = ""
    # Split on CR/LF only: str.splitlines() would also break on U+0085, and
    # 0x85 is a common UTF-8 continuation byte in CJK filenames (全 = E5 85 A8).
    for line in _MULTIPART_LINE_BREAK_RE.split(raw.decode("latin-1")):
        if line[:1] in {" ", "\t"}:
            if current:
                headers[current] += line
            continue
        name, separator, value = line.partition(":")
        current = name.strip().lower() if separator else ""
        if not current or current in headers:
            current = ""
            continue
        headers[current] = value.lstrip(" \t")
    return headers


def _multipart_delimiter_end(body: bytes, index: int, delimiter: bytes) -> tuple[int, bool]:
    """Validate a ``--boundary`` match at ``index``.

    Returns ``(content_start, closing)``; ``content_start`` is -1 when the match
    is only a prefix of a longer line rather than a real delimiter line.
    """
    # Slices instead of bytes.startswith keep this usable on an mmap.
    cursor = index + len(delimiter)
    closing = body[cursor : cursor + 2] == b"--"
    if closing:
        cursor += 2
    while body[cursor : cursor + 1] in {b" ", b"\t"}:
        cursor += 1
    if body[cursor : cursor + 2] == b"\r\n":
        return cursor + 2, closing
    if body[cursor : cursor + 1] in {b"\n", b"\r"} or cursor >= len(body):
        return min(cursor + 1, len(body)), closing
    return -1, False


def _decode_multipart_payload(payload: bytes, transfer_encoding: str) -> bytes:
    # RFC 7578 forbids Content-Transfer-Encoding in form data; decode the two
    # legacy encodings the previous email-based parser understood anyway.
    encoding = transfer_encoding.strip().lower()
    try:
        if encoding == "base64":
            return base64.b64decode(b"".join(payload.split()))
        if encoding == "quoted-printable":
            return quopri.decodestring(payload)
    except ValueError:
        pass
    return payload


def _multipart_line_end(body: Any, cursor: int, end: int) -> int:
    """Index just past the line break of the line at ``cursor`` (or ``end``).

    A CRLF pair is one break; a lone CR or LF is one too. Reads in bounded
    windows so it works on a spooled file as well as on bytes.
    """
    position = cursor
    while position < end:
        window = body[position : min(end, position + _LINE_WINDOW_BYTES)]
        found = _MULTIPART_LINE_END_RE.search(window)
        if found:
            stop = position + found.end()
            # A CR at the window edge may be the first half of a CRLF pair.
            if found.group() == b"\r" and found.end() == len(window) and stop < end and body[stop : stop + 1] == b"\n":
                stop += 1
            return stop
        position += len(window)
    return end


def _multipart_header_block(body: Any, start: int, end: int) -> tuple[int, int]:
    """Return ``(header_end, payload_start)`` for the part in ``body[start:end]``.

    Follows email.feedparser: headers run until the first line that is not a
    header or continuation line. An empty line there is the separator and is
    dropped; any other line already belongs to the payload.
    """
    cursor = start
    while cursor < end:
        line_end = _multipart_line_end(body, cursor, end)
        if body[cursor : cursor + 1] in {b"\n", b"\r"}:
            return cursor, line_end
        # The header pattern cannot cross a line break, so a bounded probe of
        # the line decides it; only a longer run of name characters needs more.
        probe = body[cursor : min(line_end, cursor + _LINE_WINDOW_BYTES)]
        if len(probe) == _LINE_WINDOW_BYTES and _MULTIPART_HEADER_NAME_RE.fullmatch(probe):
            probe = body[cursor:line_end]
        if not _MULTIPART_HEADER_LINE_RE.match(probe):
            return cursor, cursor
        cursor = line_end
    return end, end


class _MultipartPart:
    """Location of one named part inside a request body."""

    __slots__ = ("filename", "payload_start", "payload_end", "transfer_encoding")

    def __init__(self, filename: str, payload_start: int, payload_end: int, transfer_encoding: str) -> None:
        self.filename = filename
        self.payload_start = payload_start
        self.payload_end = payload_end
        self.transfer_encoding = transfer_encoding

    def read(self, body: Any) -> bytes:
        """Return the decoded payload as bytes (for small fields)."""
        return _decode_multipart_payload(body[self.payload_start : self.payload_end], self.transfer_encoding)

    def iter_chunks(self, body: Any, chunk_size: int = SPOOL_CHUNK_BYTES) -> Iterator[bytes]:
        """Yield the decoded payload in bounded chunks."""
        if self.transfer_encoding.strip().lower() in {"base64", "quoted-printable"}:
            # Legacy encodings need the whole part to decode; browsers never send them.
            payload = self.read(body)
            if payload:
                yield payload
            return
        for offset in range(self.payload_start, self.payload_end, chunk_size):
            yield body[offset : min(offset + chunk_size, self.payload_end)]


def _multipart_parts(body: Any, content_type: str) -> Dict[str, List[_MultipartPart]]:
    """Locate the named parts of a multipart/form-data body.

    ``body`` is ``bytes`` or a :class:`_SpooledBody`; only ``find``, slicing
    and ``len`` are used, and no payload is copied. Raises :class:`PipelineError`
    when the content type has no boundary or the body has no opening delimiter.
    """
    match = _MULTIPART_BOUNDARY_RE.search(content_type)
    boundary = re.sub(r"\\(.)", r"\1", match.group(1)) if match and match.group(1) is not None else (match.group(2) if match else "")
    try:
        delimiter = b"--" + boundary.encode("latin-1")
    except UnicodeEncodeError:
        boundary = ""
    if not boundary:
        raise PipelineError("请使用 multipart/form-data 上传字段 file。")

    # Delimiters must start a line; collect (match index, content start, closing).
    marks: List[tuple[int, int, bool]] = []
    search_from = 0
    while True:
        index = body.find(delimiter, search_from)
        if index < 0:
            break
        search_from = index + len(delimiter)
        if index and body[index - 1 : index] not in {b"\n", b"\r"}:
            continue
        content_start, closing = _multipart_delimiter_end(body, index, delimiter)
        if content_start < 0:
            continue
        marks.append((index, content_start, closing))
        if closing:
            break
    if not marks or marks[0][2]:
        raise PipelineError("请使用 multipart/form-data 上传字段 file。")

    fields: Dict[str, List[_MultipartPart]] = {}
    for position, (_, start, closing) in enumerate(marks):
        if closing:
            break
        end = marks[position + 1][0] if position + 1 < len(marks) else len(body)
        # The line break before the next delimiter (or the end of a truncated
        # body) belongs to the delimiter, not the payload.
        if body[end - 2 : end] == b"\r\n":
            end -= 2
        elif body[end - 1 : end] in {b"\n", b"\r"}:
            end -= 1
        end = max(end, start)
        header_end, payload_start = _multipart_header_block(body, start, end)
        headers = _multipart_headers(body[start:header_end])
        disposition = _decode_multipart_text(headers.get("content-disposition", ""))
        field_name = _disposition_param(disposition, "name")
        if not field_name:
            continue
        part = _MultipartPart(_disposition_param(disposition, "filename"), payload_start, end, headers.get("content-transfer-encoding", ""))
        fields.setdefault(field_name, []).append(part)
    return fields


def _parse_multipart_form(rfile: Any, content_type: str, content_length: int) -> Dict[str, List[_MultipartFile]]:
    """Read a small multipart/form-data body into memory and parse it.

    Each payload is sliced straight out of the body, so the form costs about
    twice its size; large uploads should use :func:`_spool_request_body`.
    """
    body = rfile.read(content_length)
    return {
        name: [_MultipartFile(part.filename, part.read(body)) for part in parts]
        for name, parts in _multipart_parts(body, content_type).items()
    }


def _spool_request_body(rfile: Any, content_length: int, target: Path, chunk_size: int = SPOOL_CHUNK_BYTES) -> int:
    """Copy up to ``content_length`` request bytes to ``target`` in chunks.

    Stops early, like ``rfile.read(content_length)``, if the client closes the
    connection. Returns the number of bytes written.
    """
    written = 0
    with Path(target).open("wb") as handle:
        while written < content_length:
            chunk = rfile.read(min(chunk_size, content_length - written))
            if not chunk:
                break
            handle.write(chunk)
            written += len(chunk)
    return written


class _SpooledBody:
    """Read-only bytes-like view of a spooled request body.

    Supports ``len``, contiguous slicing and ``find`` with bounded reads, so
    the scanner can walk a large upload without loading it. Plain reads beat
    an mmap here: a freshly written file costs a page fault per page when
    mapped, which made scanning a 100 MB body several times slower.
    """

    def __init__(self, handle: Any) -> None:
        self._handle = handle
        self._size = os.fstat(handle.fileno()).st_size

    def __len__(self) -> int:
        return self._size

    def __getitem__(self, index: slice) -> bytes:
        if not isinstance(index, slice):
            raise TypeError("spooled bodies only support slicing")
        start, stop, step = index.indices(self._size)
        if step != 1:
            raise ValueError("spooled bodies only support contiguous slices")
        if stop <= start:
            return b""
        self._handle.seek(start)
        return self._handle.read(stop - start)

    def find(self, sub: bytes, start: int = 0, end: Any = None) -> int:
        start, end, _ = slice(start, end).indices(self._size)
        if not sub:
            return start if start <= end else -1
        overlap = len(sub) - 1
        position = start
        while position + len(sub) <= end:
            stop = min(end, position + SPOOL_CHUNK_BYTES + overlap)
            found = self[position:stop].find(sub)
            if found >= 0:
                return position + found
            if stop >= end:
                break
            position = stop - overlap
        return -1


@contextmanager
def _spooled_body(path: Path) -> Iterator[_SpooledBody]:
    """Open a spooled request body for :func:`_multipart_parts`."""
    with Path(path).open("rb") as handle:
        yield _SpooledBody(handle)
