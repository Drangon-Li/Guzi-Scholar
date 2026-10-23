"""Rebuildable lexical index over authoritative library and active render files."""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import threading
import time
from pathlib import Path
from content_store import _active_conversion_root
from job_store import _read_json_file

TOKEN_RE = re.compile(r"[\u3400-\u9fff]|[^\W_]+", re.UNICODE)
CJK_RE = re.compile(r"([\u3400-\u9fff])")


def lexical_text(text):
    return " ".join(TOKEN_RE.findall(CJK_RE.sub(r" \1 ", str(text)).lower()))


def content_blocks(job_dir):
    active = _active_conversion_root(job_dir)
    document = _read_json_file(active / "document.json", {})
    rows = []
    for page in document.get("pages", []) if isinstance(document, dict) else []:
        if not isinstance(page, dict):
            continue
        for item in page.get("elements", []) if isinstance(page.get("elements"), list) else []:
            if not isinstance(item, dict):
                continue
            text = str(item.get("text") or item.get("caption") or "").strip()
            if text:
                rows.append({"text": text, "page": page.get("page"), "block_id": item.get("block_id"), "type": item.get("type")})
    return rows, active.name if active != job_dir else "base"


class SearchService:
    def __init__(self, root):
        self.path = Path(root) / "cache" / "search.sqlite3"
        self.lock = threading.RLock()
        self.connection = None
        self.last_status = {"state": "not_indexed", "documents": 0, "updated_documents": 0}

    def close(self):
        with self.lock:
            if self.connection is not None:
                self.connection.close()
                self.connection = None

    def _open(self):
        if self.connection is not None:
            return self.connection
        self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            self.connection = self._connect()
        except sqlite3.DatabaseError:
            if self.connection is not None:
                self.connection.close()
            self.path.unlink(missing_ok=True)
            Path(str(self.path) + '-wal').unlink(missing_ok=True)
            Path(str(self.path) + '-shm').unlink(missing_ok=True)
            self.connection = self._connect()
        return self.connection

    def _connect(self):
        connection = sqlite3.connect(self.path, check_same_thread=False)
        try:
            connection.execute('PRAGMA journal_mode=WAL')
            connection.execute('PRAGMA synchronous=NORMAL')
            version = connection.execute('PRAGMA user_version').fetchone()[0]
            if version != 1:
                connection.execute('DROP TABLE IF EXISTS sources')
                connection.execute('DROP TABLE IF EXISTS fingerprints')
                connection.execute('PRAGMA user_version=1')
            connection.execute("CREATE TABLE IF NOT EXISTS fingerprints (job_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL)")
            connection.execute("CREATE VIRTUAL TABLE IF NOT EXISTS sources USING fts5(job_id UNINDEXED, kind UNINDEXED, source_id UNINDEXED, reference UNINDEXED, text UNINDEXED, tokens, tokenize='unicode61')")
            connection.execute("SELECT count(*) FROM sources").fetchone()
            connection.commit()
            return connection
        except Exception:
            connection.close()
            raise

    @staticmethod
    def _fingerprint(job_dir, item):
        active = _active_conversion_root(job_dir)
        paths = [job_dir / 'notes.md', job_dir / 'annotations.json', job_dir / 'job.json', active / 'document.json']
        values = [json.dumps(item, sort_keys=True, ensure_ascii=False), str(active)]
        for path in paths:
            try:
                stat = path.stat()
                values.append(f'{path.name}:{stat.st_mtime_ns}:{stat.st_size}')
            except FileNotFoundError:
                values.append(f'{path.name}:missing')
        return hashlib.sha256('\n'.join(values).encode()).hexdigest()

    def _refresh(self, snapshot, jobs):
        started = time.perf_counter()
        connection = self._open()
        known = dict(connection.execute('SELECT job_id,fingerprint FROM fingerprints'))
        active_ids, updated = set(), 0
        for record in jobs:
            job_id = record['job_id']
            item = snapshot.get('items', {}).get(job_id, {})
            if item.get('deleted_at') or not Path(record['job_dir']).is_dir():
                continue
            active_ids.add(job_id)
            job_dir = Path(record['job_dir'])
            fingerprint = self._fingerprint(job_dir, item)
            if known.get(job_id) == fingerprint:
                continue
            fields = item.get('metadata', {}).get('fields', {})
            metadata = ' '.join(str(value) if not isinstance(value, list) else ' '.join(map(str, value)) for value in fields.values())
            rows = [('metadata', 'metadata', {}, ' '.join([str(record.get('source_filename', '')), str(item.get('alias', '')), metadata]))]
            notes = job_dir / 'notes.md'
            if notes.is_file():
                rows.append(('notes', 'notes', {}, notes.read_text(encoding='utf-8')))
            for annotation in _read_json_file(job_dir / 'annotations.json', []):
                if isinstance(annotation, dict):
                    rows.append(('annotations', str(annotation.get('id', '')), {key: annotation.get(key) for key in ('page', 'block_id', 'render_generation')}, str(annotation.get('quote') or '') + '\n' + str(annotation.get('note') or '')))
            blocks, generation = content_blocks(job_dir)
            rows.extend(('content', str(block.get('block_id') or index), {"page": block['page'], "block_id": block['block_id'], "render_generation": generation}, block['text']) for index, block in enumerate(blocks))
            with connection:
                connection.execute('DELETE FROM sources WHERE job_id=?', (job_id,))
                connection.executemany('INSERT INTO sources(job_id,kind,source_id,reference,text,tokens) VALUES(?,?,?,?,?,?)', [(job_id, kind, source_id, json.dumps(reference), text, lexical_text(text)) for kind, source_id, reference, text in rows if text.strip()])
                connection.execute('INSERT OR REPLACE INTO fingerprints VALUES(?,?)', (job_id, fingerprint))
            updated += 1
        with connection:
            for job_id in set(known) - active_ids:
                connection.execute('DELETE FROM sources WHERE job_id=?', (job_id,))
                connection.execute('DELETE FROM fingerprints WHERE job_id=?', (job_id,))
        self.last_status = {"state": "ready", "documents": len(active_ids), "updated_documents": updated, "refresh_ms": round((time.perf_counter() - started) * 1000, 2), "tokenizer": "unicode61+cjk-character-phrases"}
        return active_ids

    def search(self, snapshot, jobs, query='', limit=30, offset=0, sources=None, folder_id=None):
        if not isinstance(query, str) or len(query) > 500:
            raise ValueError('检索词必须是长度不超过500的字符串。')
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100 or isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
            raise ValueError('分页参数无效。limit为1–100，offset为非负整数。')
        if sources is not None and (not isinstance(sources, list) or any(source not in {'metadata', 'notes', 'annotations', 'content'} for source in sources)):
            raise ValueError('检索来源无效。')
        with self.lock:
            self._refresh(snapshot, jobs)
            connection = self._open()
            clauses, params = [], []
            # Each user word is an exact lexical token phrase; no FTS syntax is executed.
            terms = [lexical_text(term) for term in query.split()]
            terms = [term for term in terms if term]
            if terms:
                clauses.append('sources MATCH ?')
                params.append(' AND '.join('"' + term.replace('"', '""') + '"' for term in terms))
            if sources is not None:
                clauses.append('kind IN (' + ','.join('?' for _ in sources) + ')')
                params.extend(sources)
            if folder_id:
                ids = [job_id for job_id, item in snapshot['items'].items() if folder_id in item.get('folder_ids', [])]
                clauses.append('job_id IN (' + ','.join('?' for _ in ids) + ')')
                params.extend(ids)
            where = ' WHERE ' + ' AND '.join(clauses) if clauses else ''
            total = connection.execute('SELECT count(*) FROM sources' + where, params).fetchone()[0]
            ordering = 'bm25(sources),job_id,source_id' if terms else 'job_id,kind,source_id'
            records = connection.execute('SELECT job_id,kind,source_id,reference,text FROM sources' + where + ' ORDER BY ' + ordering + ' LIMIT ? OFFSET ?', [*params, limit, offset]).fetchall()
            results = []
            for job_id, kind, source_id, reference, text in records:
                position = text.lower().find(query.lower()) if query else 0
                start = max(0, position - 100)
                ref = {"job_id": job_id, "kind": kind, "source_id": source_id, **json.loads(reference)}
                results.append({"job_id": job_id, "source": kind, "source_id": source_id, "snippet": text[start:start+500], "reference": ref})
            return {"results": results, "total": total, "limit": limit, "offset": offset, "index": dict(self.last_status)}
