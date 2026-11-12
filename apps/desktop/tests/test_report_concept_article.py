from __future__ import annotations

from copy import deepcopy
from http import HTTPStatus
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import report_concept_article as articles
import report_service


TERM = "检索增强生成"
CONCEPT = "retrieval-augmented-generation"
QUOTE = "The generator answers the question using the retrieved passages."
ANCHOR = "block-17"


def saved_report():
    return {
        "title": "论文报告",
        "source": {"render_generation": "3", "blocks_total": 61},
        "concepts": [
            {"id": CONCEPT, "term": TERM, "definition": "先检索相关资料，再根据资料组织回答。"},
            {"id": "ranking", "term": "重排序", "definition": "重新排列已找到的材料。"},
        ],
        "sections": [
            {"key": "how", "paragraphs": [
                {"text": f"论文用 [[{TERM}]] 回答问题。", "kind": "paper", "citations": [
                    {"block_id": ANCHOR, "quote": QUOTE, "page": 4, "render_generation": "3"},
                ]},
                {"text": "用 [[重排序]] 筛选已有候选。", "kind": "inference", "citations": []},
            ]},
            {"key": "results", "paragraphs": [{"text": "这里讨论独立的实验结果。", "kind": "paper", "citations": []}]},
        ],
    }


def model_article():
    paragraphs = {
        "basics": "有些问题的答案在资料里。检索是先找可能包含答案的段落。",
        "mechanism": "先把提问交给检索器，从候选资料里选段落，再让模型据此组织回答。",
        "example": "自拟例子：问会议何时开始。先搜议程，定位‘九点开幕’，最后回答九点。",
        "paper": "本文让生成器根据检索到的段落回答问题。",
        "limits": "如果没有找到议程，生成器不能凭空确认时间。先检查拿到的段落是否真的含有答案。",
    }
    sections = [{"key": key, "paragraphs": [{"text": text}]} for key, text in paragraphs.items()]
    sections[3]["paragraphs"][0]["citations"] = [
        {"block_id": ANCHOR, "quote": QUOTE, "page": 200, "render_generation": "99"},
    ]
    return {"term": "不采用模型给出的标题", "sections": sections[::-1]}


class ReportConceptArticleTest(unittest.TestCase):
    def setUp(self):
        self.report = saved_report()
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.job_dir = Path(temporary.name)
        self.evidence = report_service.Evidence("3", {
            ANCHOR: {"block_id": ANCHOR, "page": 4, "text": QUOTE},
            "repeated": {"block_id": "repeated", "page": 7, "text": "Two passages. Two passages."},
        }, 0)

    def generate(self, raw=None, evidence=None):
        with (
            patch.object(articles, "_effective_profile", return_value={"cli_kind": "codex"}),
            patch.object(report_service, "_complete", return_value=json.dumps(raw or model_article())) as complete,
        ):
            article = articles.generate_article(evidence or self.evidence, self.report, CONCEPT)
        return article, complete.call_args

    def test_generation_prioritizes_concept_passages_and_uses_long_cli_timeout(self):
        blocks = {
            f"block-{index}": {"block_id": f"block-{index}", "page": 1, "text": "other research context " * 95}
            for index in range(61)
        }
        blocks[ANCHOR] = self.evidence.blocks[ANCHOR]
        article, call = self.generate(evidence=report_service.Evidence("3", blocks, 0))
        messages = call.args[0]
        task = json.loads(messages[-1]["content"])
        self.assertEqual(task["mode"], "concept_article")
        self.assertEqual(task["concept"]["term"], TERM)
        self.assertIn(f"[[{TERM}]]", task["report_excerpts"][0]["text"])
        self.assertNotIn("重排序", messages[-1]["content"])
        self.assertIn("必要的前置知识", messages[0]["content"])
        self.assertIn("中间变化与结果", messages[0]["content"])
        self.assertIn("有关本文的说法只放在 paper 节", messages[0]["content"])
        selected = {block["block_id"] for block in json.loads(messages[1]["content"].split("\n", 1)[1])}
        self.assertLess(len(selected), len(blocks))
        self.assertTrue({"block-16", ANCHOR, "block-18"} <= selected)
        self.assertEqual(call.kwargs["timeout_seconds"], 300)
        self.assertEqual(article["term"], TERM)
        self.assertEqual([section["key"] for section in article["sections"]], list(articles.ARTICLE_SECTIONS))

    def test_only_exact_unique_quotes_become_clickable_and_failed_claims_are_removed(self):
        raw = model_article()
        sections = {section["key"]: section["paragraphs"] for section in raw["sections"]}
        exact = {"block_id": ANCHOR, "quote": QUOTE, "page": 4, "render_generation": "3"}
        sections["basics"][0]["citations"] = [exact]
        sections["paper"].extend([
            {"text": "捏造的数值。", "citations": [{"block_id": ANCHOR, "quote": "100%"}]},
            {"text": "不可唯一定位的说法。", "citations": [{"block_id": "repeated", "quote": "Two passages."}]},
            {"text": "没有引文的说法。"},
        ])
        article, _ = self.generate(raw)
        self.assertEqual(article["sections"][0]["paragraphs"][0]["citations"], [])
        self.assertEqual(article["sections"][3]["paragraphs"], [
            {"text": "本文让生成器根据检索到的段落回答问题。", "citations": [exact]},
            {"text": articles.PAPER_EVIDENCE_GAP, "citations": []},
        ])

    def test_invalid_sections_return_retryable_model_format_error(self):
        raw = model_article()
        raw["sections"].pop()
        with self.assertRaises(report_service.ReportError) as caught:
            self.generate(raw)
        self.assertEqual(caught.exception.status, HTTPStatus.BAD_GATEWAY)
        self.assertEqual(caught.exception.code, "report_ai_format")
        self.assertIsNone(articles.read_article(self.job_dir, self.report, CONCEPT))

    def test_cache_is_scoped_to_job_concept_context_and_render_generation(self):
        article, _ = self.generate()
        self.assertIsNone(articles.read_article(self.job_dir, self.report, CONCEPT))
        self.assertEqual(articles.save_article(self.job_dir, self.report, CONCEPT, article), article)
        self.assertIsNone(articles.read_article(self.job_dir, self.report, "ranking"))
        other_job = self.job_dir / "other-job"
        other_job.mkdir()
        self.assertIsNone(articles.read_article(other_job, self.report, CONCEPT))

        revised = deepcopy(self.report)
        revised["title"] = "改报告标题"
        revised["sections"][1]["paragraphs"][0]["text"] = "改不相关的结果章节。"
        revised["concepts"][1]["definition"] = "改另一术语的定义。"
        self.assertEqual(articles.read_article(self.job_dir, revised, CONCEPT), article)
        self.assertEqual(articles.save_article(self.job_dir, revised, CONCEPT, {}), article)

        revised["concepts"][0]["definition"] = "改当前术语的定义。"
        self.assertIsNone(articles.read_article(self.job_dir, revised, CONCEPT))
        revised = deepcopy(self.report)
        revised["sections"][0]["paragraphs"][0]["citations"][0]["quote"] = "retrieved passages"
        self.assertIsNone(articles.read_article(self.job_dir, revised, CONCEPT))
        revised = deepcopy(self.report)
        revised["source"]["render_generation"] = "4"
        self.assertIsNone(articles.read_article(self.job_dir, revised, CONCEPT))
        self.assertEqual(articles.read_article(self.job_dir, self.report, CONCEPT), article)
