import copy
import hashlib
import io
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import zotero_import as zotero


def record(key, item_type, *, library=None, **fields):
    return {"key": key, "version": 7, "library": library or {"type": "user", "id": 123},
            "data": {"key": key, "version": 7, "itemType": item_type, **fields}}


class ZoteroImportTest(unittest.TestCase):
    def setUp(self):
        self.client = zotero.ZoteroClient()
        self.temp = tempfile.TemporaryDirectory(prefix="guzi-zotero-test-")
        self.root = Path(self.temp.name)
        self.parent = record("ITEM0001", "journalArticle", title="A paper", abstractNote="An abstract", date="2024-05-01",
                             creators=[{"creatorType": "author", "firstName": "Ada", "lastName": "Lovelace"}, {"creatorType": "author", "name": "Research Team"}],
                             publicationTitle="A Journal", DOI="10.1000/example", url="https://example.test/paper", tags=[{"tag": "ML"}, {"tag": "ML"}, {"tag": "论文"}], collections=["CHILD001"])
        self.pdf = record("PDF00001", "attachment", parentItem="ITEM0001", title="Full text", contentType="application/pdf", filename="paper.pdf")
        self.pdf2 = record("PDF00002", "attachment", parentItem="ITEM0001", title="Second PDF", contentType="application/pdf", filename="appendix.pdf")
        self.note = record("NOTE0001", "note", parentItem="ITEM0001", note='<div><p>原始 <strong>HTML</strong></p></div>')
        self.annotation = record("ANNOT001", "annotation", parentItem="PDF00001", annotationType="highlight", annotationText="Selected words",
                                 annotationComment="A comment", annotationColor="#ffd400", annotationPageLabel="iv", annotationPosition='{"pageIndex":3,"rects":[[1,2,3,4]]}')
        self.collections = [{"key": "ROOT0001", "data": {"key": "ROOT0001", "name": "Parent folder", "parentCollection": False}},
                            {"key": "CHILD001", "data": {"key": "CHILD001", "name": "Child folder", "parentCollection": "ROOT0001"}}]
        self.routes = {
            "users/0/items/ITEM0001": self.parent,
            "users/0/items/ITEM0001/children": [self.pdf, self.pdf2, self.note],
            "users/0/items/PDF00001/children": [self.annotation],
            "users/0/items/PDF00002/children": [],
            "users/0/collections": self.collections,
        }

    def tearDown(self):
        self.temp.cleanup()

    def fake_json(self, path, params=None):
        payload = copy.deepcopy(self.routes[path])
        if path.endswith('/children') and isinstance(payload, list):
            requested_type = (params or {}).get('itemType')
            payload = [item for item in payload if item['data']['itemType'] == requested_type] if requested_type else [item for item in payload if item['data']['itemType'] != 'annotation']
        headers = {"Last-Modified-Version": "10"}
        if isinstance(payload, list):
            headers["Total-Results"] = str(len(payload))
            start, limit = (params or {}).get("start", 0), (params or {}).get("limit", 100)
            payload = payload[start:start + limit]
        return payload, headers

    def test_only_numeric_loopback_api_endpoints_are_accepted(self):
        for url in ("https://127.0.0.1:23119/api", "http://api.zotero.org:80/api", "http://127.0.0.1:23119/other",
                    "http://127.0.0.1:23119/api?url=https://evil.test", "http://user@127.0.0.1:23119/api", "file:///tmp/api",
                    "http://127.0.0.1:23119/api#fragment", "http://127.0.0.1:bad/api"):
            with self.subTest(url=url), self.assertRaises(zotero.ZoteroError):
                zotero.ZoteroClient(url)
        self.assertEqual(zotero.ZoteroClient("http://127.0.0.1:34567/api").base_url, "http://127.0.0.1:34567/api")

    def test_status_and_collection_hierarchy(self):
        self.routes["users/0/groups"] = [{"id": 55, "data": {"id": 55, "name": "A group"}}]
        with patch.object(self.client, "_json", side_effect=self.fake_json):
            self.assertEqual(self.client.status(), {"available": True, "libraries": [{"id": "user:0", "name": "我的文库"}, {"id": "group:55", "name": "A group"}]})
            self.assertEqual(self.client.collections("user:0"), [{"key": "ROOT0001", "name": "Parent folder", "parent_key": None}, {"key": "CHILD001", "name": "Child folder", "parent_key": "ROOT0001"}])

    def test_complete_pagination_follows_total_even_with_short_pages(self):
        pages = [([{"key": "COLL0001", "data": {"name": "one"}}], {"Total-Results": "2", "Last-Modified-Version": "10"}),
                 ([{"key": "COLL0002", "data": {"name": "two"}}], {"Total-Results": "2", "Last-Modified-Version": "10"})]
        with patch.object(self.client, "_json", side_effect=pages) as request:
            result = self.client.collections("user:0")
        self.assertEqual([item["key"] for item in result], ["COLL0001", "COLL0002"])
        self.assertEqual(request.call_args_list[1].args[1]["start"], 1)

    def test_incomplete_repeated_or_changing_pagination_fails(self):
        first = ([{"key": "COLL0001", "data": {"name": "one"}}], {"Total-Results": "2", "Last-Modified-Version": "10"})
        cases = [([], {"Total-Results": "2"}), first,
                 ([{"key": "COLL0002", "data": {"name": "two"}}], {"Total-Results": "3"}),
                 ([{"key": "COLL0002", "data": {"name": "two"}}], {"Total-Results": "2", "Last-Modified-Version": "11"})]
        for second in cases:
            with self.subTest(second=second), patch.object(self.client, "_json", side_effect=[first, second]), self.assertRaises(zotero.ZoteroError):
                self.client.collections("user:0")
        with patch.object(self.client, "_json", return_value=([], {"Total-Results": "10001"})), self.assertRaises(zotero.ZoteroError):
            self.client.collections("user:0")

    def test_items_preserve_pdf_choices_and_report_missing_pdf(self):
        empty = record("ITEM0002", "book", title="Without PDF")
        self.routes["users/0/collections/CHILD001/items/top"] = [self.parent, empty]
        self.routes["users/0/items/ITEM0002/children"] = []
        with patch.object(self.client, "_json", side_effect=self.fake_json) as request:
            result = self.client.items("user:0", collection="CHILD001", query="Ada", limit=1)
        self.assertEqual(result["total"], 2)
        self.assertEqual(result["next_start"], 1)
        self.assertEqual(result["items"][0]["authors"], ["Ada Lovelace", "Research Team"])
        self.assertEqual(result["items"][0]["year"], "2024")
        self.assertEqual(len(result["items"][0]["attachments"]), 2)
        self.assertEqual(request.call_args_list[0].args[1]["q"], "Ada")
        with patch.object(self.client, "_json", side_effect=self.fake_json):
            result = self.client.items("user:0", collection="CHILD001", start=1, limit=1)
        self.assertIsNone(result["next_start"])
        self.assertIn("reason", result["items"][0])

    def test_identifier_and_pagination_inputs_cannot_change_request_paths(self):
        for library in ("user:0/../../", "group:0", "https://remote.test", "user:-1"):
            with self.subTest(library=library), self.assertRaises(zotero.ZoteroError):
                self.client.items(library)
        for kwargs in ({"collection": "../../keys"}, {"start": -1}, {"start": True}, {"limit": 101}, {"limit": False}, {"query": "a" * 513}):
            with self.subTest(kwargs=kwargs), self.assertRaises(zotero.ZoteroError):
                self.client.items("user:0", **kwargs)
        with self.assertRaises(zotero.ZoteroError):
            self.client.fetch_document("user:0", "ITEM0001?url=evil", "PDF00001")

    def test_fetch_document_preserves_raw_notes_and_annotation_position(self):
        self.pdf["data"]["note"] = "<div>Attachment note</div>"
        self.annotation['data']['tags'] = [{'tag': '批注标签'}, {'tag': '批注标签'}]
        with patch.object(self.client, "_json", side_effect=self.fake_json):
            result = self.client.fetch_document("user:0", "ITEM0001", "PDF00001")
        self.assertEqual(result["source_id"], "zotero:user:123:ITEM0001:PDF00001")
        self.assertEqual(result["library_id"], "user:123")
        self.assertEqual(result["source_url"], "zotero://select/library/items/ITEM0001")
        self.assertEqual(result["metadata"], {"title": "A paper", "authors": ["Ada Lovelace", "Research Team"], "abstract": "An abstract", "year": "2024", "venue": "A Journal", "doi": "10.1000/example", "url": "https://example.test/paper", "keywords": ["ML", "论文"], "item_type": "journalArticle"})
        self.assertEqual(result["notes"][0], {"key": "NOTE0001", "version": 7, "html": '<div><p>原始 <strong>HTML</strong></p></div>'})
        self.assertEqual(result["notes"][1]["html"], "<div>Attachment note</div>")
        self.assertEqual(result["annotations"][0]["position"], {"pageIndex": 3, "rects": [[1, 2, 3, 4]]})
        self.assertEqual(result["annotations"][0]["page_label"], "iv")
        self.assertEqual(result['annotations'][0]['tags'], ['批注标签'])
        self.assertEqual([item["key"] for item in result["collections"]], ["CHILD001"])
        self.assertEqual([item["key"] for item in result["collection_ancestors"]], ["ROOT0001"])

    def test_attachment_must_belong_to_selected_parent_and_library(self):
        with patch.object(self.client, "_json", side_effect=self.fake_json), self.assertRaises(zotero.ZoteroError):
            self.client.fetch_document("user:0", "ITEM0001", "FOREIGN1")
        self.pdf["data"]["parentItem"] = "OTHER001"
        with patch.object(self.client, "_json", side_effect=self.fake_json), self.assertRaises(zotero.ZoteroError):
            self.client.fetch_document("user:0", "ITEM0001", "PDF00001")
        self.pdf["data"]["parentItem"] = "ITEM0001"
        self.pdf["library"] = {"type": "group", "id": 55}
        with patch.object(self.client, "_json", side_effect=self.fake_json), self.assertRaises(zotero.ZoteroError):
            self.client.fetch_document("user:0", "ITEM0001", "PDF00001")

    def test_source_identity_separates_attachments_and_group_libraries(self):
        with patch.object(self.client, "_json", side_effect=self.fake_json):
            first = self.client.fetch_document("user:0", "ITEM0001", "PDF00001")
            second = self.client.fetch_document("user:0", "ITEM0001", "PDF00002")
        self.assertNotEqual(first["source_id"], second["source_id"])
        self.routes = {key.replace("users/0", "groups/55"): value for key, value in self.routes.items()}
        for payload in self.routes.values():
            for item in payload if isinstance(payload, list) else [payload]:
                item["library"] = {"type": "group", "id": 55}
        with patch.object(self.client, "_json", side_effect=self.fake_json):
            group = self.client.fetch_document("group:55", "ITEM0001", "PDF00001")
        self.assertNotEqual(first["source_id"], group["source_id"])
        self.assertEqual(group["source_url"], "zotero://select/groups/55/items/ITEM0001")

    def test_invalid_annotation_or_collection_hierarchy_is_not_silently_lost(self):
        self.annotation["data"]["annotationPosition"] = "invalid JSON"
        with patch.object(self.client, "_json", side_effect=self.fake_json), self.assertRaises(zotero.ZoteroError):
            self.client.fetch_document("user:0", "ITEM0001", "PDF00001")
        self.annotation["data"]["annotationPosition"] = "{}"
        self.collections[0]["data"]["parentCollection"] = "CHILD001"
        with patch.object(self.client, "_json", side_effect=self.fake_json), self.assertRaises(zotero.ZoteroError):
            self.client.fetch_document("user:0", "ITEM0001", "PDF00001")

    def test_trashed_memberships_do_not_block_live_documents(self):
        self.parent['data']['collections'].append('TRASH001')
        self.routes['users/0/collections/TRASH001'] = {'key': 'TRASH001', 'data': {'key': 'TRASH001', 'deleted': True, 'parentCollection': 'TRASH002'}}
        with patch.object(self.client, '_json', side_effect=self.fake_json):
            result = self.client.fetch_document('user:0', 'ITEM0001', 'PDF00001')
        self.assertEqual([item['key'] for item in result['collections']], ['CHILD001'])
        self.assertEqual(len(result['annotations']), 1)
        self.routes['users/0/collections/TRASH001']['data']['deleted'] = False
        with patch.object(self.client, '_json', side_effect=self.fake_json), self.assertRaisesRegex(zotero.ZoteroError, '所属分类已改变'):
            self.client.fetch_document('user:0', 'ITEM0001', 'PDF00001')

    def test_annotation_filter_is_preserved_across_all_pages(self):
        pages = [([self.annotation], {'Total-Results': '2'}), ([{**self.annotation, 'key': 'ANNOT002'}], {'Total-Results': '2'})]
        with patch.object(self.client, '_json', side_effect=pages) as request:
            records = self.client._children('user:0', 'PDF00001', item_type='annotation')
        self.assertEqual(len(records), 2)
        self.assertEqual([call.args[1]['itemType'] for call in request.call_args_list], ['annotation', 'annotation'])
        self.assertEqual(request.call_args_list[1].args[1]['start'], 1)

    def test_missing_pdf_error_identifies_source_instead_of_staging_directory(self):
        with self.assertRaisesRegex(zotero.ZoteroError, 'PDF 附件不在本机'):
            self.stage_pdf(self.root / 'missing.pdf', self.root / 'staged.pdf')

    def stage_pdf(self, source, destination, *, file_url=None):
        self.client._selected[("user:0", "PDF00001")] = self.pdf
        with patch.object(self.client, "_get", return_value=((file_url or source.as_uri()).encode(), {})):
            return self.client.download_pdf("user:0", "PDF00001", destination)

    def test_pdf_is_copied_and_hashed_without_changing_source(self):
        source, destination = self.root / "source document.pdf", self.root / "staged.pdf.part"
        content = b"%PDF-1.7\n" + b"test content" * 200000 + b"\n%%EOF"
        source.write_bytes(content)
        before = source.stat()
        result = self.stage_pdf(source, destination)
        self.assertEqual(result, {"filename": "paper.pdf", "byte_size": len(content), "sha256": hashlib.sha256(content).hexdigest()})
        self.assertEqual(destination.read_bytes(), content)
        self.assertEqual(source.read_bytes(), content)
        self.assertEqual(source.stat().st_mtime_ns, before.st_mtime_ns)

    def test_stored_and_linked_file_urls_decode_unicode_and_percent_once(self):
        source = self.root / '论文 %20 source.pdf'
        source.write_bytes(b'%PDF-1.7\n%%EOF')
        for mode in ('imported_file', 'linked_file'):
            with self.subTest(mode=mode):
                self.pdf['data']['linkMode'] = mode
                result = self.stage_pdf(source, self.root / f'{mode}.pdf')
                self.assertEqual(result['byte_size'], source.stat().st_size)

    def test_remote_urls_missing_nonregular_invalid_or_oversized_files_are_rejected(self):
        source, destination = self.root / "source.pdf", self.root / "staged.pdf"
        source.write_bytes(b"%PDF-1.7\n%%EOF")
        for url in ("https://evil.test/pdf", "file://remote-server/private.pdf", "file://127.0.0.1/private.pdf", "file:///tmp/a.pdf?x=1", "file:relative.pdf"):
            with self.subTest(url=url), self.assertRaises(zotero.ZoteroError):
                self.stage_pdf(source, destination, file_url=url)
            self.assertFalse(destination.exists())
        for bad_source in (self.root / "missing.pdf", self.root):
            with self.subTest(source=bad_source), self.assertRaises(zotero.ZoteroError):
                self.stage_pdf(bad_source, destination)
        source.write_bytes(b"not a pdf")
        with self.assertRaises(zotero.ZoteroError):
            self.stage_pdf(source, destination)
        source.write_bytes(b"%PDF-1.7\n%%EOF")
        with patch.object(zotero, "MAX_PDF_BYTES", 5), self.assertRaises(zotero.ZoteroError):
            self.stage_pdf(source, destination)
        self.assertFalse(destination.exists())

    def test_destination_is_never_overwritten_including_source(self):
        source = self.root / "original.pdf"
        content = b"%PDF-1.7\n%%EOF"
        source.write_bytes(content)
        with self.assertRaises(zotero.ZoteroError):
            self.stage_pdf(source, source)
        self.assertEqual(source.read_bytes(), content)

    def test_direct_download_verifies_attachment_parent_association(self):
        source, destination = self.root / "original.pdf", self.root / "stage.pdf"
        source.write_bytes(b"%PDF-1.7\n%%EOF")
        self.routes["users/0/items/PDF00001"] = self.pdf
        with patch.object(self.client, "_json", side_effect=self.fake_json), patch.object(self.client, "_get", return_value=(source.as_uri().encode(), {})):
            self.assertTrue(self.client.download_pdf("user:0", "PDF00001", destination)["sha256"])
        self.routes["users/0/items/ITEM0001/children"] = [self.pdf2]
        with patch.object(self.client, "_json", side_effect=self.fake_json), self.assertRaises(zotero.ZoteroError):
            self.client.download_pdf("user:0", "PDF00001", self.root / "second.pdf")

    def test_http_transport_is_get_only_no_redirect_and_tracks_server_identity(self):
        class Response(io.BytesIO):
            headers = {"Zotero-Server-ID": "instance-one"}

        with patch.object(self.client._opener, "open", side_effect=[Response(b"[]"), Response(b"[]")]) as request:
            self.client._get("users/0/groups")
            self.client._get("users/0/collections", {"q": "A & B"})
        self.assertEqual(request.call_args_list[0].args[0].get_method(), "GET")
        self.assertEqual(request.call_args_list[1].args[0].get_header("Zotero-server-id"), "instance-one")
        self.assertIn("q=A+%26+B", request.call_args_list[1].args[0].full_url)
        self.assertIsNone(zotero._NoRedirect().redirect_request(None, None, 302, "Found", {}, "https://evil.test"))

    def test_file_redirect_is_read_as_data_and_network_redirect_is_rejected(self):
        for location in ("file:///tmp/test.pdf", "https://evil.test/pdf"):
            error = urllib.error.HTTPError("http://127.0.0.1:23119/api/users/0/items/PDF00001/file", 302, "Found", {"Location": location}, None)
            with patch.object(self.client._opener, "open", side_effect=error):
                if location.startswith("file:"):
                    body, _ = self.client._get("users/0/items/PDF00001/file", file_url=True)
                    self.assertEqual(body.decode(), location)
                else:
                    with self.assertRaises(zotero.ZoteroError):
                        self.client._get("users/0/items/PDF00001/file", file_url=True)

    def test_old_file_endpoint_fallback(self):
        source, destination = self.root / "original.pdf", self.root / "staged.pdf"
        source.write_bytes(b"%PDF-1.7\n%%EOF")
        self.client._selected[("user:0", "PDF00001")] = self.pdf
        with patch.object(self.client, "_get", side_effect=[zotero.ZoteroError("Not found", status_code=404), (source.as_uri().encode(), {})]) as request:
            self.client.download_pdf("user:0", "PDF00001", destination)
        self.assertEqual(request.call_args.args[0], "users/0/items/PDF00001/file")


if __name__ == "__main__":
    unittest.main()
