import json
from pathlib import Path
import tempfile
import unittest

from services.parser_service.bibliography import aggregate_reference_duplicates, bibliography_anchors, bibliography_layout, citation_links, is_bibliography_entry, is_bibliography_heading, native_reference_duplicates
from services.parser_service.exporter import composite_figures, export_document, reference_layout, reexport_document, refresh_cached_layout


class BibliographyTests(unittest.TestCase):
    @staticmethod
    def block(label, content, box):
        return {"label": label, "content": content, "source_bbox_normalized": box}

    def test_bibliography_headings_require_a_complete_section_title(self):
        for heading in [
            "References", "Reference", "BIBLIOGRAPHY", "参考文献", "參考文獻",
            "参考文献/References", "References / 参考文献", "参考文献（References）",
            "References (参考文献)", "参考文献\nReferences", "参考文献：References",
            "6 References", "6. References", "6) 参考文献", "6、参考文献",
            "6.2 参考文献 / References：", "６．２． 参考文献／References。",
            "## <strong>参考文献 / References</strong>:",
            "References (continued)", "References (Cont.)", "References [cont'd]",
            "References — continued", "Bibliography continued", "参考文献（续）",
            "6. References / 参考文献 (continued)",
        ]:
            with self.subTest(heading=heading):
                self.assertTrue(is_bibliography_heading(heading))
        for heading in [
            "", "References to previous work", "References are listed below.",
            "See References", "结论与参考文献", "参考文献编号保持顺序。",
            "Figure 2. References", "Table 1: 参考文献", "Appendix A. References",
            "References / Appendix", "6References", "6.2References", "[1] References",
            "参考文献 (References", "参考文献 / References / Methods",
            "References (continued discussion)", "References continued below",
            "References to previous work (continued)", "References (cont.) appendix",
        ]:
            with self.subTest(heading=heading):
                self.assertFalse(is_bibliography_heading(heading))

    def test_bilingual_section_starts_at_heading_and_stops_at_appendix(self):
        b = self.block
        blocks = [
            b("text", "References", [.1, .01, .9, .03]),
            b("text", "[9] This numbered paragraph mentions earlier work (2026).", [.1, .04, .9, .06]),
            b("heading", "结论与参考文献", [.1, .07, .9, .09]),
            b("text", "[8] Another body paragraph mentioning references (2026).", [.1, .1, .9, .12]),
            b("text", "## Figure 1. References", [.1, .13, .9, .15]),
            b("text", "[7] A numbered figure description from the body (2026).", [.1, .16, .9, .18]),
            b("text", "## 6. 参考文献 / References：", [.1, .2, .9, .23]),
            b("text", "[1] Author. A sufficiently detailed publication (2026).", [.1, .25, .9, .28]),
            b("text", "## Appendix A", [.1, .3, .9, .33]),
            b("text", "[2] This numbered appendix paragraph is not a reference (2026).", [.1, .35, .9, .38]),
            b("text", "## References to previous work", [.1, .4, .9, .43]),
            b("text", "[3] This numbered discussion paragraph is not a reference (2026).", [.1, .45, .9, .48]),
        ]
        pages = [{"blocks": blocks}]
        entries, _, _ = reference_layout(pages)
        targets, _ = bibliography_layout(entries, pages)
        self.assertEqual(targets, {1: (1, 7)})
        self.assertTrue(entries[1, 6]["references"])
        self.assertTrue(entries[1, 7]["references"])
        for index in [0, 1, 2, 3, 4, 5, 8, 9, 10, 11]:
            with self.subTest(index=index):
                self.assertFalse(entries[1, index]["references"])
        self.assertEqual(entries[1, 9]["scope"], "appendix-A")

    def test_table_cell_heading_does_not_start_a_bibliography_section(self):
        b = self.block
        pages = [{"blocks": [
            b("table", "<table><tr><th>References</th></tr></table>", [.1, .1, .9, .3]),
            b("heading", "References", [.2, .12, .8, .15]),
            b("text", "[1] A numbered body paragraph outside the table (2026).", [.1, .4, .9, .45]),
        ]}]
        entries, _, _ = reference_layout(pages)
        targets, _ = bibliography_layout(entries, pages)
        self.assertTrue(entries[1, 1]["table_heading"])
        self.assertFalse(entries[1, 2]["references"])
        self.assertEqual(targets, {})

    def test_dotted_reference_aggregate_and_small_ocr_edge_drift(self):
        b = self.block
        children = [b("text", f"{i}. Author. <em>Paper {i}</em> (2026).", [.1, y, .9, y+.03]) for i, y in [(26, .079), (27, .113), (28, .147)]]
        aggregate = b("reference", "\n".join(child["content"] for child in children), [.097, .08, .902, .174])
        proposal = aggregate_reference_duplicates([aggregate, *children])
        self.assertEqual(proposal[0]["retained_indices"], [1, 2, 3])
        aggregate["content"] += "\n29. A unique reference missing from the finer blocks."
        self.assertEqual(aggregate_reference_duplicates([aggregate, *children]), [])
        aggregate["content"] = "\n".join(child["content"] for child in children)
        aggregate["source_bbox_normalized"] = [.1, .3, .9, .6]
        self.assertEqual(aggregate_reference_duplicates([aggregate, *children]), [])

    def test_compact_bracketed_legacy_aggregate(self):
        blocks = [{"label": "reference", "content": "[1] A [2] B [3] C", "bbox_2d": [0, 0, 1000, 1000]}]
        blocks += [{"label": "text", "content": f"[{i+1}] {c}", "bbox_2d": [0, i*100, 1000, i*100+80]} for i, c in enumerate("ABC")]
        self.assertEqual(aggregate_reference_duplicates(blocks)[0]["retained_indices"], [1, 2, 3])

    def test_aggregate_proves_reference_region_after_internal_explanation_heading(self):
        b = self.block
        children = [b("text", f"{n}. Author. A sufficiently detailed paper title.", [.1, y, .9, y+.03]) for n, y in [(38, .2), (39, .25), (40, .3)]]
        blocks = [b("text", "## References", [.1, .05, .9, .08]), b("text", "## This paper introduces a method", [.1, .1, .9, .15]), b("reference", "\n".join(child["content"] for child in children), [.1, .2, .9, .33]), *children]
        pages = [{"blocks": blocks}]
        entries, _, _ = reference_layout(pages)
        targets, _ = bibliography_layout(entries, pages)
        self.assertEqual(set(targets), {38, 39, 40})
        self.assertTrue(entries[1, 3]["references"])

    def test_author_year_aggregate_requires_near_complete_text_coverage(self):
        b = self.block
        children = [b("text", f"Author {name}. A detailed publication on protein design and experimental biology. Nature (2026).", [.1, y, .9, y+.03]) for name, y in [("A", .2), ("B", .25), ("C", .3)]]
        aggregate = b("reference", "\n".join(child["content"] for child in children), [.1, .2, .9, .33])
        self.assertTrue(aggregate_reference_duplicates([aggregate, *children]))
        aggregate["content"] += " A distinct publication missing from the individual blocks."
        self.assertFalse(aggregate_reference_duplicates([aggregate, *children]))

    def test_list_range_links_preserve_compact_text_and_protect_existing_markup(self):
        targets = dict.fromkeys(range(1, 30), (1, 1))
        raw = '[23,24] [1-15] [1, 3–5, 7; 20—22] [28-30] [99999999-1]'
        linked = citation_links(raw, targets)
        from html import unescape
        import re
        self.assertEqual(unescape(re.sub(r"<[^>]*>", "", linked)), raw)
        for number in [23, 24, 1, 15, 3, 5, 7, 20, 22]:
            self.assertIn(f'href="#ref-{number}"', linked)
        self.assertIn('[28-30]', linked)
        self.assertLess(len(linked), 1800)
        protected = '<a href="#old">[1,2]</a> <math><mtext>[1-3]</mtext></math> <code>[1]</code>'
        self.assertEqual(citation_links(protected, targets), protected)

    def test_numbered_methods_are_not_bibliography_and_anchors_cover_each_entry(self):
        b = self.block
        pages = [{"blocks": [b("text", "## Methods", [.1, .1, .9, .13]), b("text", "1. Prepare the sample.\n2. Measure it.", [.1, .15, .9, .3])]}, {"blocks": [b("text", "## References", [.1, .1, .9, .13]), b("text", "1. Author. A paper.\n2. Author. Another paper.", [.1, .15, .9, .3])]}]
        entries, _, _ = reference_layout(pages)
        targets, duplicates = bibliography_layout(entries, pages)
        self.assertEqual(targets, {1: (2, 1), 2: (2, 1)})
        self.assertEqual(duplicates, {})
        anchored = bibliography_anchors('1. Author. <em>A paper.</em>\n2. Author. Another paper.', targets)
        self.assertEqual(anchored.count('id="ref-'), 2)
        self.assertIn('<em>A paper.</em>', anchored)

    def test_intervals_and_reference_entries_are_not_partially_linked(self):
        targets = dict.fromkeys(range(1, 90), (1, 1))
        interval = 'Unconstrained parameters are mapped to [0,1] before optimization.'
        self.assertEqual(citation_links(interval, targets), interval)
        self.assertEqual(citation_links('Missing evidence [1,999] remains unresolved.', targets), 'Missing evidence [1,999] remains unresolved.')
        reference = '<p>[67] Raffel, C. et al. Exploring transfer learning. Journal of ML Research (2020).</p>'
        self.assertTrue(is_bibliography_entry(reference))
        self.assertEqual(citation_links(reference, targets, superscript=True), reference)
        self.assertFalse(is_bibliography_entry('1. Prepare the sample and measure it carefully.'))

    def test_superscript_citations_require_prose_and_preserve_footnotes_and_powers(self):
        targets = dict.fromkeys(range(1, 90), (1, 1))
        body = '<p>The recent advent of artificial intelligence promised a powerful new paradigm for protein sequence <sup>17–21</sup>, structure <sup>22,31</sup>, and function.</p>'
        linked = citation_links(body, targets, superscript=True)
        self.assertEqual(linked.count('class="citation"'), 4)
        self.assertIn('<sup><a class="citation" href="#ref-17"', linked)
        self.assertEqual(citation_links(linked, targets, superscript=True), linked)
        footnote = '<p>We incorporated comprehensive textual annotations from the database and official website <sup>1</sup>.</p>'
        self.assertEqual(citation_links(footnote, targets, superscript=True, footnote_numbers={1}), footnote)
        for raw in [
            '<p>Fengyuan Dai <sup>1</sup>, Shiyang You <sup>2</sup>, Yudian Zhu <sup>1</sup>, Yuan Gao <sup>4</sup>, Lihao Fu <sup>4</sup>.</p>',
            '<p><sup>1</sup> School of Engineering, Westlake University. <sup>2</sup> Department of Bioengineering.</p>',
            '<p>These experiments measure the coefficient of determination and report its value as R<sup>2</sup>.</p>',
            '<p>These experiments require a large number of calculations, approximately 10<sup>3</sup> steps.</p>',
            '<math><mtext>Protein design demonstrated substantial progress in many experiments <sup>17</sup>.</mtext></math>',
            '<table><tr><td>Protein design demonstrated substantial progress in many experiments <sup>17</sup>.</td></tr></table>',
        ]:
            self.assertEqual(citation_links(raw, targets, superscript=True), raw)

    def test_fine_references_after_headings_are_identified_by_bibliography_evidence(self):
        b = self.block
        pages = [{"blocks": [b('reference', '[67] Raffel, C. A paper (2020).', [.1,.1,.9,.2]), b('text', '## Additional notes', [.1,.3,.9,.35]), b('text', '[67] Raffel, C. A paper (2020).', [.1,.4,.9,.5]), b('text', '1. Prepare the sample.', [.1,.6,.9,.7])]}]
        entries, _, _ = reference_layout(pages)
        bibliography_layout(entries, pages)
        self.assertTrue(entries[1, 2]['references'])
        self.assertFalse(entries[1, 3]['references'])

    def test_overlapping_footnotes_require_a_complete_native_supported_reference_list(self):
        b = self.block
        first = '1. Franklin, A. Experiment, Right or Wrong (Cambridge Univ. Press, 1990).'
        second = '2. Radder, H. The Philosophy of Scientific Experimentation (Univ. Pittsburgh Press, 2003).'
        third = '3. Shamos, M. H. Great Experiments in Physics (Courier Corporation, 1987).'
        canonical = '\n'.join([first, second, third])
        blocks = [b('footnote', first, [.509,.900,.856,.911]), b('reference', canonical, [.509,.904,.944,.941]), b('footnote', second, [.510,.911,.943,.923]), b('footnote', second.replace('Radder', 'Rudder').replace('Univ. Pittsburgh Press, 2003', 'Oxford: Pittsburgh Press, 2006')+'\n'+third, [.512,.918,.941,.942])]
        proposals = native_reference_duplicates(blocks, lambda bounds: canonical)
        self.assertEqual(proposals[0]['canonical_index'], 1)
        self.assertEqual(proposals[0]['suppressed_indices'], [0, 2, 3])
        self.assertEqual(native_reference_duplicates(blocks, lambda bounds: canonical.replace('2003', '2006')), [])
        self.assertEqual(native_reference_duplicates(blocks, lambda bounds: ''), [])
        blocks.append(b('footnote', second, [.1,.1,.8,.13]))
        blocks.append(b('footnote', '2. A distinct explanatory footnote with unique information (2003).', [.510,.911,.943,.923]))
        self.assertEqual(native_reference_duplicates(blocks, lambda bounds: canonical)[0]['suppressed_indices'], [0, 2, 3])


class MixedFigurePanelTests(unittest.TestCase):
    def test_source_frame_binds_one_image_one_table_and_panel_labels(self):
        b = BibliographyTests.block
        blocks = [b("text", "A", [.108, .08, .122, .092]), b("text", "B", [.574, .08, .588, .091]), b("text", "Targets with at least one binder among the top N designs per target", [.589, .096, .787, .117]), b("image", "", [.115, .085, .554, .325]), b("table", "<table><tr><td>N</td><td>6/13</td></tr></table>", [.59, .125, .883, .298]), b("text", "Figure 2. Design rank is calibrated with binding. A, Hit rate. B, Targets.", [.097, .342, .901, .417]), b("text", "A substantive body paragraph must remain selectable.", [.096, .44, .903, .539])]
        entries, assignments, groups = reference_layout([{"blocks": blocks}])
        frame = [.1019, .0787, .8981, .3379]
        self.assertEqual(composite_figures(entries, assignments, groups), [])
        composites = composite_figures(entries, assignments, groups, lambda page: [frame])
        self.assertEqual(composites[0]["components"], [(1, i) for i in range(5)])
        self.assertEqual(composites[0]["host"], (1, 3))
        self.assertEqual(composites[0]["bbox"], frame)
        blocks[2]["content"] = "An ordinary body paragraph ends here."
        entries, assignments, groups = reference_layout([{"blocks": blocks}])
        self.assertEqual(composite_figures(entries, assignments, groups, lambda page: [frame]), [])


class BibliographyExportTests(unittest.TestCase):
    def test_continued_heading_keeps_both_pages_reference_targets_and_links(self):
        from reportlab.pdfgen.canvas import Canvas
        b = BibliographyTests.block
        references = [
            "[1] Alpha. First sufficiently detailed publication (2026).",
            "[2] Beta. Second sufficiently detailed publication (2026).",
        ]
        pages = [
            {"blocks": [
                b("text", "Prior evidence [1,2].", [.1, .05, .9, .08]),
                b("heading", "References", [.1, .1, .9, .15]),
                b("text", references[0], [.1, .3, .9, .35]),
            ]},
            {"blocks": [
                b("heading", "References (continued)", [.1, .1, .9, .15]),
                b("text", references[1], [.1, .3, .9, .35]),
            ]},
        ]
        entries, _, _ = reference_layout(pages)
        targets, _ = bibliography_layout(entries, pages)
        self.assertEqual(targets, {1: (1, 2), 2: (2, 1)})
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pdf = root / "source.pdf"
            canvas = Canvas(str(pdf), pagesize=(400, 400))
            for page in pages:
                for block in page["blocks"]:
                    canvas.drawString(40, 400 * (1 - block["source_bbox_normalized"][1]), block["content"])
                canvas.showPage()
            canvas.save()
            fusion = root / "fusion"
            fusion.mkdir()
            (fusion / "document.json").write_text(json.dumps({"schema": "guzi-fusion-auto-v2", "pages": pages}))
            output = root / "output"
            validation = export_document(pdf, fusion, output)
            document = json.loads((output / "document.json").read_text())
            self.assertEqual(document["summary"]["references"], 2)
            self.assertEqual(validation["bibliography"]["known_references"], [1, 2])
            self.assertTrue(document["pages"][1]["elements"][0]["reference_section"])
            markup = (output / "document.html").read_text()
            for number in [1, 2]:
                self.assertEqual(markup.count(f'id="ref-{number}"'), 1)
                self.assertIn(f'href="#ref-{number}"', markup)

    def test_bilingual_heading_exports_reference_counts_and_anchors(self):
        from reportlab.pdfgen.canvas import Canvas
        b = BibliographyTests.block
        references = [
            "[1] Lin, A. and Chen, B. Synthetic Document Evaluation. Fixture Notes, 2026.",
            "[2] 王明，李青。双语文档解析测试规范。合成测试资料，2026：9-16。",
            "[3] Guzi Test Group. Reproducible OCR Smoke Checks. Report GS-2026-03.",
        ]
        pages = [{"blocks": [
            b("text", "## 结论与参考文献", [.1, .01, .9, .04]),
            b("text", "The following references support this example [1,2,3].", [.1, .05, .9, .08]),
            b("text", "## 6. 参考文献/References：", [.1, .1, .9, .13]),
            *[b("text", text, [.1, .2 + index * .1, .9, .25 + index * .1]) for index, text in enumerate(references)],
            b("text", "## Appendix A", [.1, .6, .9, .63]),
            b("text", "[4] A numbered appendix procedure from 2026, not a bibliography entry.", [.1, .7, .9, .75]),
        ]}]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pdf = root / "source.pdf"
            canvas = Canvas(str(pdf), pagesize=(400, 400))
            canvas.drawString(40, 350, "Synthetic bilingual bibliography fixture")
            canvas.save()
            fusion = root / "fusion"
            fusion.mkdir()
            (fusion / "document.json").write_text(json.dumps({"schema": "guzi-fusion-auto-v2", "pages": pages}))
            output = root / "output"
            validation = export_document(pdf, fusion, output)
            document = json.loads((output / "document.json").read_text())
            self.assertEqual(document["summary"]["references"], 3)
            self.assertEqual(validation["bibliography"]["known_references"], [1, 2, 3])
            records = document["pages"][0]["elements"]
            self.assertFalse(records[0]["reference_section"])
            self.assertTrue(all(record["reference_section"] for record in records[2:6]))
            self.assertFalse(records[7]["reference_section"])
            markup = (output / "document.html").read_text()
            for number, reference in enumerate(references, 1):
                self.assertEqual(markup.count(f'id="ref-{number}"'), 1)
                self.assertIn(f'href="#ref-{number}"', markup)
                self.assertIn(reference, markup)
            self.assertNotIn('id="ref-4"', markup)

    def test_native_reference_refresh_preserves_sources_and_relocates_reference_anchors(self):
        import copy
        from reportlab.pdfgen.canvas import Canvas
        first = '1. Franklin, A. Experiment, Right or Wrong (Cambridge Univ. Press, 1990).'
        second = '2. Radder, H. The Philosophy of Scientific Experimentation (Univ. Pittsburgh Press, 2003).'
        third = '3. Shamos, M. H. Great Experiments in Physics (Courier Corporation, 1987).'
        canonical = '\n'.join([first, second, third])
        b = BibliographyTests.block
        records = [b('text', 'Prior evidence [1,2,3].', [.1,.1,.8,.15]), b('footnote', first, [.1,.235,.8,.254]), b('reference', canonical, [.1,.235,.95,.31]), b('footnote', second, [.1,.26,.9,.28]), b('footnote', second.replace('Radder','Rudder').replace('2003','2006')+'\n'+third, [.1,.26,.95,.31])]
        for index, record in enumerate(records):
            record.update({'block_id':f'b-{index}', 'source_content':record['content'], 'text':record['content'], 'math_audit':{'status':'confirmed'}, 'native_evidence':{'status':'confirmed'}, 'html':f'<p id="b-{index}" data-block-id="b-{index}">{record["content"]}</p>'})
        records[1]['html'] = records[1]['html'].replace('>', '><span id="fn-1"></span><span id="ref-1"></span>', 1)
        records[2]['html'] = records[2]['html'].replace(second, '<span id="ref-2"></span>'+second).replace(third, '<span id="ref-3"></span>'+third)
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory)/'source', Path(directory)/'output'
            source.mkdir()
            canvas = Canvas(str(source/'source.pdf'), pagesize=(600,800))
            canvas.setFont('Helvetica',8)
            for text, y in [(first,600),(second,580),(third,560)]:
                canvas.drawString(60,y,text)
            canvas.save()
            document = {'schema':'guzi-fusion-auto-v3', 'backend':'fixture', 'pages':[{'page':1,'blocks':records}]}
            original = copy.deepcopy(document)
            (source/'document.json').write_text(json.dumps(document))
            (source/'document.html').write_text('<html><head></head><body>'+''.join(r['html'] for r in records)+'</body></html>')
            reexport_document(source, output)
            after = json.loads((output/'document.json').read_text())
            retained = after['pages'][0]['blocks']
            for before, refreshed in zip(original['pages'][0]['blocks'],retained):
                for key in ('block_id','source_content','content','text','math_audit','native_evidence'):
                    self.assertEqual(before[key],refreshed[key])
            for index in (1,3,4):
                self.assertEqual(retained[index]['cached_display']['mode'],'suppressed-reference-member')
                self.assertNotIn('Franklin',retained[index]['html'])
                self.assertNotIn('Rudder',retained[index]['html'])
                self.assertIn(f'id="b-{index}"',retained[index]['html'])
            self.assertIn('id="fn-1"',retained[1]['html'])
            markup = (output/'document.html').read_text()
            for number in (1,2,3):
                self.assertEqual(markup.count(f'id="ref-{number}"'),1)
                self.assertIn(f'id="ref-{number}"',retained[2]['html'])
                self.assertIn(f'href="#ref-{number}"',retained[0]['html'])
            self.assertNotIn('Rudder',markup)
            self.assertEqual(markup.count('Franklin'),1)

    def test_export_and_local_refresh_preserve_ids_and_remove_duplicate_whitespace(self):
        from reportlab.pdfgen.canvas import Canvas
        b = BibliographyTests.block
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pdf = root / "source.pdf"
            canvas = Canvas(str(pdf), pagesize=(400, 400))
            canvas.drawString(40, 350, "Evidence [1,2] [1-3]")
            canvas.showPage()
            canvas.drawString(40, 350, "References")
            for number, y in [(1, 300), (2, 250), (3, 200)]:
                canvas.drawString(40, y, f"{number}. Author. Paper {number}.")
            canvas.save()
            children = [b("text", f"{n}. Author. <em>Paper {n}.</em>", [.1, y, .9, y+.05]) for n, y in [(1, .2), (2, .35), (3, .5)]]
            pages = [{"blocks": [b("text", "Evidence\n\n[1,2] [1-3] remains selectable.", [.1, .1, .9, .2])]}, {"blocks": [b("text", "## References", [.1, .1, .9, .15]), b("reference", "\n\n".join(child["content"] for child in children), [.1, .2, .9, .55]), *children]}]
            fusion = root / "fusion"
            fusion.mkdir()
            (fusion / "document.json").write_text(json.dumps({"schema": "guzi-fusion-auto-v2", "pages": pages}))
            exported, refreshed = root / "exported", root / "refreshed"
            export_document(pdf, fusion, exported, title="original.pdf", job_id="job-identity")
            reexport_document(exported, refreshed)
            before = json.loads((exported / "document.json").read_text())
            after = json.loads((refreshed / "document.json").read_text())
            ids = lambda document: [block["block_id"] for page in document["pages"] for block in page["blocks"]]
            self.assertEqual(ids(before), ids(after))
            manifest = json.loads((refreshed / "manifest.json").read_text())
            self.assertEqual(manifest["job_id"], "job-identity")
            self.assertEqual(manifest["source"]["filename"], "original.pdf")
            markup = (refreshed / "document.html").read_text()
            for number in range(1, 4):
                self.assertEqual(markup.count(f'id="ref-{number}"'), 1)
                self.assertIn(f'href="#ref-{number}"', markup)
                self.assertEqual(markup.count(f'<em>Paper {number}.</em>'), 1)
            self.assertNotIn("white-space:pre-wrap", markup)
            self.assertIn(".pdf-page{padding:0}", markup)
            self.assertEqual(after["summary"]["references"], 3)
            aggregate = after["pages"][1]["blocks"][1]
            self.assertEqual(aggregate["render_mode"], "suppressed-reference-aggregate")
            self.assertEqual(aggregate["source_content"], pages[1]["blocks"][1]["content"])
            self.assertEqual((refreshed / "document.md").read_text().count("Paper 1.</em>"), 1)

    def test_legacy_cached_paragraphs_gain_links_without_changing_blocks_or_assets(self):
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory) / "source", Path(directory) / "result"
            source.mkdir()
            records = [
                {"type": "paragraph", "block_id": "body", "text": "Methods [41,42]", "html": '<p data-block-id="body">Methods [41,42]</p>'},
                {"type": "paragraph", "block_id": "step", "text": "41. A preparation step.", "html": '<p data-block-id="step">41. A preparation step.</p>'},
                {"type": "title", "block_id": "title", "text": "References", "html": '<h2 data-block-id="title">References</h2>'},
                {"type": "paragraph", "block_id": "ref41", "text": "[41] Author. A paper.", "html": '<p data-block-id="ref41">[41] Author. <em>A paper.</em></p>'},
                {"type": "paragraph", "block_id": "ref42", "text": "[42] Author. Another paper.", "html": '<p data-block-id="ref42">[42] Author. Another paper.</p>'},
            ]
            document = {"pages": [{"page": 1, "elements": records}], "citation_audit": {"known_references": [], "unresolved": ["ref-41", "ref-42"]}}
            (source / "document.json").write_text(json.dumps(document))
            (source / "document.html").write_text('<html><head></head><body>' + ''.join(record["html"] for record in records) + '</body></html>')
            result = refresh_cached_layout(source, output)
            self.assertEqual(result["known_references"], [41, 42])
            refreshed = json.loads((output / "document.json").read_text())
            self.assertEqual([r["block_id"] for r in refreshed["pages"][0]["elements"]], [r["block_id"] for r in records])
            self.assertEqual(refreshed["pages"][0]["elements"][1]["html"], records[1]["html"])
            markup = (output / "document.html").read_text()
            self.assertEqual(markup.count('id="ref-41"'), 1)
            self.assertEqual(markup.count('id="ref-42"'), 1)
            self.assertIn('href="#ref-41"', markup)
            self.assertIn('<em>A paper.</em>', markup)
            self.assertEqual(refreshed["citation_audit"]["unresolved"], [])
            repeated = Path(directory) / "repeated"
            refresh_cached_layout(output, repeated)
            self.assertEqual((repeated / "document.html").read_text(), markup)


if __name__ == "__main__":
    unittest.main()
