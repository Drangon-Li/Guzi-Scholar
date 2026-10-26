import io
import json
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import ai
import server
from content_store import _translation_key, _translation_records, _write_translation_records


PROFILE = {"profile_id": "profile-a", "provider": "openai-compatible", "mode": "chat", "model": "test", "api_key": "secret", "base_url": "https://private.example/v1"}
SEGMENTS = [{"id": "s1", "text": "First __MY_SCHOLAR_MATH_0__."}, {"id": "s2", "text": "Second __MY_SCHOLAR_SPECIAL_TOKEN_0__."}]
SOURCE = " ".join(item["text"] for item in SEGMENTS)
TRANSLATED = [{"id": "s1", "text": "第一句 __MY_SCHOLAR_MATH_0__。"}, {"id": "s2", "text": "第二句 __MY_SCHOLAR_SPECIAL_TOKEN_0__。"}]


class AlignmentTest(unittest.TestCase):
    def translate(self, **kwargs):
        return ai.translate_text(SOURCE, segments=SEGMENTS, alignment_version="sentence-v1", profile=PROFILE, **kwargs)

    def test_chat_batches_once_and_orders_by_id(self):
        with patch("ai._complete", return_value=json.dumps({"segments": list(reversed(TRANSLATED))})) as complete:
            result = self.translate()
        complete.assert_called_once()
        self.assertEqual(result["segments"], TRANSLATED)
        self.assertEqual(json.loads(complete.call_args.args[0][1]["content"])["segments"], SEGMENTS)

    def test_rejects_missing_duplicate_unknown_ids_and_moved_tokens_without_retry(self):
        bad = [TRANSLATED[:1], [TRANSLATED[0], TRANSLATED[0]], [TRANSLATED[0], dict(TRANSLATED[1], id="other")],
               [{"id": "s1", "text": "第一句。"}, {"id": "s2", "text": "第二句 __MY_SCHOLAR_MATH_0__ __MY_SCHOLAR_SPECIAL_TOKEN_0__。"}],
               [dict(TRANSLATED[0], text=TRANSLATED[0]["text"] * 2), TRANSLATED[1]]]
        for output in bad:
            with self.subTest(output=output), patch("ai._complete", return_value=json.dumps({"segments": output})) as complete:
                with self.assertRaises(ai.TranslationQualityError):
                    self.translate()
                complete.assert_called_once()

    def test_rejects_invalid_input_before_model(self):
        for segments in (None, [], [SEGMENTS[0], SEGMENTS[0]], [dict(SEGMENTS[0], text="Missing token."), SEGMENTS[1]]):
            with self.subTest(segments=segments), patch("ai._complete") as complete:
                with self.assertRaises(ValueError):
                    ai.translate_text(SOURCE, segments=segments, alignment_version="sentence-v1", profile=PROFILE)
                complete.assert_not_called()

    def test_dedicated_protocol_validates_batch_boundaries_once(self):
        profile = dict(PROFILE, mode="qwen-mt")
        with patch("ai._complete", side_effect=lambda messages, **kwargs: messages[0]["content"].replace("First", "第一").replace("Second", "第二")) as complete:
            result = ai.translate_text(SOURCE, segments=SEGMENTS, alignment_version="sentence-v1", profile=profile)
        complete.assert_called_once()
        self.assertEqual([item["id"] for item in result["segments"]], ["s1", "s2"])
        with patch("ai._complete", return_value="丢失边界") as complete:
            with self.assertRaisesRegex(ai.TranslationQualityError, "边界"):
                ai.translate_text(SOURCE, segments=SEGMENTS, alignment_version="sentence-v1", profile=profile)
        complete.assert_called_once()

    def test_machine_provider_combines_sentences_and_restores_local_tokens(self):
        profile = {"provider": "deepl", "api_key": "secret", "profile_id": "deepl"}
        def translated(_url, body, _headers, _timeout):
            values = json.loads(body)["text"]
            self.assertEqual(values, ["First", "Second"])
            return {"translations": [{"text": value.upper()} for value in values]}
        with patch("translation_providers._post", side_effect=translated) as call:
            result = ai.translate_text(SOURCE, segments=SEGMENTS, alignment_version="sentence-v1", profile=profile)
        call.assert_called_once()
        self.assertEqual(result["segments"][0]["text"], "FIRST __MY_SCHOLAR_MATH_0__.")

    def test_alignment_identity_includes_sentence_text_ids_and_version(self):
        old = _translation_key(SOURCE, "b", "zh", "hash", "profile-a")
        aligned = _translation_key(SOURCE, "b", "zh", "hash", "profile-a", "sentence-v1", SEGMENTS)
        self.assertNotEqual(old, aligned)
        changed = [dict(SEGMENTS[0], id="new"), SEGMENTS[1]]
        self.assertNotEqual(aligned, _translation_key(SOURCE, "b", "zh", "hash", "profile-a", "sentence-v1", changed))


class AlignmentEndpointTest(unittest.TestCase):
    @staticmethod
    def handler(job_dir, payload):
        handler = object.__new__(server.ScholarHandler)
        handler._completed_job_dir = lambda _job_id: job_dir
        handler._read_json_body = lambda **kwargs: dict(payload)
        handler.responses = []
        handler._send_json = lambda body, *args, **kwargs: handler.responses.append(body)
        handler._send_error_json = lambda message, *args, **kwargs: handler.responses.append({"error": message})
        handler.send_response = lambda *args, **kwargs: None
        handler.send_header = lambda *args, **kwargs: None
        handler.end_headers = lambda: None
        handler.wfile = io.BytesIO()
        return handler

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.job_dir = Path(self.directory.name)
        for name, value in (("STORE", None), ("resolve_ai_profile", lambda _service: dict(PROFILE))):
            patcher = patch.object(server, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.payload = {"text": SOURCE, "block_id": "block", "source_hash": "hash", "segments": SEGMENTS, "alignment_version": "sentence-v1"}

    def test_persists_alignment_and_safe_source_snapshot_without_hitting_old_cache(self):
        old = {"cache_key": _translation_key(SOURCE, "block", "zh", "hash", "profile-a"), "text": "旧整段", "profile_id": "profile-a"}
        _write_translation_records(self.job_dir, [old])
        handler = self.handler(self.job_dir, self.payload)
        with patch("ai._complete", return_value=json.dumps({"segments": TRANSLATED})) as complete:
            handler._translate("a" * 16)
            handler._translate("a" * 16)
        complete.assert_called_once()
        self.assertEqual([item["result"]["cached"] for item in handler.responses], [False, True])
        record = handler.responses[0]["result"]
        self.assertEqual(record["source_segments"], SEGMENTS)
        self.assertEqual(record["segments"], TRANSLATED)
        self.assertEqual(record["provider_snapshot"], {"provider": "openai-compatible", "model": "test", "mode": "chat"})
        self.assertNotIn("secret", json.dumps(record))
        self.assertNotIn("private.example", json.dumps(record))
        self.assertEqual(len(_translation_records(self.job_dir)), 2)

    def test_history_query_keeps_old_profiles(self):
        records = [{"cache_key": "a", "profile_id": "profile-a"}, {"cache_key": "b", "profile_id": "profile-b"}, {"cache_key": "legacy"}]
        _write_translation_records(self.job_dir, records)
        handler = self.handler(self.job_dir, {})
        handler.path = "/api/jobs/" + "a" * 16 + "/translations?scope=all"
        with patch("server.STORE") as store:
            store.path.return_value = self.job_dir
            handler.do_GET()
        self.assertEqual(handler.responses[0]["translations"], records)
        self.assertEqual(_translation_records(self.job_dir), records)

    def test_normal_and_stream_concurrent_requests_share_one_call(self):
        started, release, waiting = threading.Event(), threading.Event(), threading.Event()
        normal = self.handler(self.job_dir, self.payload)
        stream = self.handler(self.job_dir, dict(self.payload, stream=True))
        original_stream_response = stream._translate_stream_response
        def stream_response(producer):
            waiting.set()
            original_stream_response(producer)
        stream._translate_stream_response = stream_response
        def complete(*args, **kwargs):
            started.set()
            self.assertTrue(release.wait(3))
            return json.dumps({"segments": TRANSLATED})
        with patch("ai._complete", side_effect=complete) as call, ThreadPoolExecutor(2) as pool:
            first = pool.submit(normal._translate, "a" * 16)
            self.assertTrue(started.wait(3))
            second = pool.submit(stream._translate, "a" * 16)
            self.assertTrue(waiting.wait(3))
            release.set()
            first.result(timeout=3)
            second.result(timeout=3)
        call.assert_called_once()
        self.assertEqual(normal.responses[0]["result"]["segments"], TRANSLATED)
        events = [json.loads(line[6:]) for line in stream.wfile.getvalue().decode().splitlines() if line.startswith("data: ")]
        self.assertEqual(events[-1]["result"]["segments"], TRANSLATED)
        self.assertEqual(server.TRANSLATION_FLIGHTS, {})

    def test_concurrent_profiles_have_separate_flights(self):
        both_started = threading.Barrier(2)
        first = self.handler(self.job_dir, self.payload)
        second = self.handler(self.job_dir, self.payload)
        def complete(*args, **kwargs):
            both_started.wait(timeout=3)
            return json.dumps({"segments": TRANSLATED})
        def run(handler, profile):
            # The resolver is request-scoped, as it is when preferences change.
            threading.current_thread().translation_profile = profile
            handler._translate("a" * 16)
        with patch("server.resolve_ai_profile", side_effect=lambda _: threading.current_thread().translation_profile), patch("ai._complete", side_effect=complete) as call, ThreadPoolExecutor(2) as pool:
            a = pool.submit(run, first, PROFILE)
            b = pool.submit(run, second, dict(PROFILE, profile_id="profile-b", model="second"))
            a.result(timeout=4)
            b.result(timeout=4)
        self.assertEqual(call.call_count, 2)
        self.assertEqual({item["profile_id"] for item in _translation_records(self.job_dir)}, {"profile-a", "profile-b"})

    def test_concurrent_refreshes_share_with_refresh_and_bypass_normal_flight(self):
        ordinary_started, refresh_started, follower_waiting, release = (threading.Event() for _ in range(4))
        ordinary = self.handler(self.job_dir, self.payload)
        refresh = self.handler(self.job_dir, dict(self.payload, refresh=True))
        follower = self.handler(self.job_dir, dict(self.payload, refresh=True, stream=True))
        original_stream_response = follower._translate_stream_response
        def response(producer):
            follower_waiting.set()
            original_stream_response(producer)
        follower._translate_stream_response = response
        def complete(*args, **kwargs):
            if not ordinary_started.is_set():
                ordinary_started.set()
            else:
                refresh_started.set()
            self.assertTrue(release.wait(4))
            return json.dumps({"segments": TRANSLATED})
        with patch("ai._complete", side_effect=complete) as call, ThreadPoolExecutor(3) as pool:
            normal_job = pool.submit(ordinary._translate, "a" * 16)
            self.assertTrue(ordinary_started.wait(3))
            refresh_job = pool.submit(refresh._translate, "a" * 16)
            self.assertTrue(refresh_started.wait(3))
            follower_job = pool.submit(follower._translate, "a" * 16)
            self.assertTrue(follower_waiting.wait(3))
            release.set()
            for job in (normal_job, refresh_job, follower_job):
                job.result(timeout=3)
        self.assertEqual(call.call_count, 2)
        self.assertEqual(server.TRANSLATION_FLIGHTS, {})

    def test_slow_ordinary_result_cannot_overwrite_successful_refresh(self):
        started, release = threading.Event(), threading.Event()
        ordinary = self.handler(self.job_dir, self.payload)
        refresh = self.handler(self.job_dir, dict(self.payload, refresh=True))
        fresh_segments = [dict(item, text="新版本 " + item["text"]) for item in TRANSLATED]
        def complete(*args, **kwargs):
            if not started.is_set():
                started.set()
                self.assertTrue(release.wait(3))
                return json.dumps({"segments": TRANSLATED})
            return json.dumps({"segments": fresh_segments})
        with patch("ai._complete", side_effect=complete) as call, ThreadPoolExecutor(1) as pool:
            normal_job = pool.submit(ordinary._translate, "a" * 16)
            self.assertTrue(started.wait(3))
            refresh._translate("a" * 16)
            release.set()
            normal_job.result(timeout=3)
        self.assertEqual(call.call_count, 2)
        self.assertEqual(_translation_records(self.job_dir)[0]["segments"], fresh_segments)
        self.assertEqual(ordinary.responses[0]["result"]["segments"], fresh_segments)

    def test_failure_reaches_all_waiters_and_next_attempt_can_retry(self):
        started, waiting, release = (threading.Event() for _ in range(3))
        first = self.handler(self.job_dir, self.payload)
        second = self.handler(self.job_dir, dict(self.payload, stream=True))
        original_stream_response = second._translate_stream_response
        def response(producer):
            waiting.set()
            original_stream_response(producer)
        second._translate_stream_response = response
        def complete(*args, **kwargs):
            started.set()
            self.assertTrue(release.wait(3))
            raise RuntimeError("upstream failed")
        with patch("ai._complete", side_effect=complete) as call, ThreadPoolExecutor(2) as pool:
            a = pool.submit(first._translate, "a" * 16)
            self.assertTrue(started.wait(3))
            b = pool.submit(second._translate, "a" * 16)
            self.assertTrue(waiting.wait(3))
            release.set()
            a.result(timeout=3)
            b.result(timeout=3)
        call.assert_called_once()
        self.assertIn("upstream failed", first.responses[0]["error"])
        self.assertIn("upstream failed", second.wfile.getvalue().decode())
        self.assertEqual(server.TRANSLATION_FLIGHTS, {})
        self.assertEqual(_translation_records(self.job_dir), [])
        with patch("ai._complete", return_value=json.dumps({"segments": TRANSLATED})) as retry:
            first._translate("a" * 16)
        retry.assert_called_once()
        self.assertIn("result", first.responses[-1])

    def test_failed_refresh_preserves_record_and_releases_flight(self):
        handler = self.handler(self.job_dir, self.payload)
        with patch("ai._complete", return_value=json.dumps({"segments": TRANSLATED})):
            handler._translate("a" * 16)
        before = _translation_records(self.job_dir)
        refresh = self.handler(self.job_dir, dict(self.payload, refresh=True))
        with patch("ai._complete", return_value="bad") as call:
            refresh._translate("a" * 16)
            refresh._translate("a" * 16)
        self.assertEqual(call.call_count, 2)
        self.assertEqual(_translation_records(self.job_dir), before)
        self.assertEqual(server.TRANSLATION_FLIGHTS, {})


if __name__ == "__main__":
    unittest.main()
