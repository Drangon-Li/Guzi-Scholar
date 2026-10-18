import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import PropertyMock, patch
from types import ModuleType
import zipfile

from services.parser_service.exporter import composite_figures, contents_layout, cross_references, embedded_figure, export_document, inline, reference_layout, render_math, revalidate_inline_source, source_figure_frames, source_figure_ink_bounds, zip_result


class InlineTests(unittest.TestCase):
    def test_styles_and_safety(self):
        rendered, plain = inline('***both*** <u>under</u> **bold** <sup>2</sup><script>bad</script> &lt;literal&gt;')
        self.assertIn('<strong><em>both</em></strong>', rendered)
        self.assertIn('<u>under</u>', rendered)
        self.assertIn('<sup>2</sup>', rendered)
        self.assertNotIn('bad', rendered)
        self.assertIn('&lt;literal&gt;', rendered)
        self.assertIn('<literal>', plain)


class MathRendererTests(unittest.TestCase):
    def converter(self, callback):
        package = ModuleType("latex2mathml")
        converter = ModuleType("latex2mathml.converter")
        converter.convert = callback
        return patch.dict("sys.modules", {"latex2mathml": package, "latex2mathml.converter": converter})

    def test_argmax_is_normalized_before_mathml_conversion(self):
        calls = []
        def convert(value, **_kwargs):
            calls.append(value)
            return '<math><mo>argmax</mo></math>'
        with self.converter(convert):
            self.assertIn("argmax", render_math(r"\arg \max_{s} f(s)"))
        self.assertEqual(calls, [r"\argmax_{s} f(s)"])

    def test_text_escapes_are_normalized_without_turning_underscore_into_script(self):
        with self.converter(lambda *_args, **_kwargs: r'<math xmlns="http://www.w3.org/1998/Math/MathML"><mtext>submit\_answer\%</mtext></math>'):
            value = render_math(r"\text{submit\_answer\%}")
        self.assertIn("submit_answer%", value)
        self.assertNotIn("\\", value)
        self.assertIn("<math xmlns=", value)
        self.assertNotIn("<msub", value)

    def test_unconverted_tex_macro_is_not_treated_as_mathml_success(self):
        with self.converter(lambda *_args, **_kwargs: r"<math><mi>\unhandled</mi></math>"):
            self.assertEqual(render_math(r"\unhandled{x}"), "")


class CaptionReferenceTests(unittest.TestCase):
    @staticmethod
    def block(label, content="", box=None):
        return {"label": label, "content": content, "source_bbox_normalized": box or [.1, .1, .9, .2]}

    def test_shared_subfigure_caption_does_not_shift_later_figures(self):
        b = self.block
        pages = [
            {"blocks": [b("image"), b("text", "(a)"), b("image"), b("text", "(b)"), b("text", "Figure 8 | Two panels.")]},
            {"blocks": [b("text", "As shown in Figure 9."), b("image"), b("text", "Figure 9 | Correct next figure.")]},
        ]
        entries, assignments, groups = reference_layout(pages)
        self.assertEqual(assignments[1, 0]["anchor"], "fig-8")
        self.assertEqual(assignments[1, 2]["anchor"], "fig-8-part-2")
        self.assertEqual(assignments[1, 0]["group"], assignments[1, 2]["group"])
        self.assertEqual(assignments[2, 1]["anchor"], "fig-9")
        self.assertIn('href="#fig-9"', cross_references("Figure 9.", entries[2, 0], groups))

    def test_appendix_numbers_and_references_have_independent_scope(self):
        b = self.block
        pages = [
            {"blocks": [b("image"), b("text", "Figure 1 | Main figure.")]},
            {"blocks": [b("text", "## A. Appendix"), b("text", "## A.2. Earth Science example")]},
            {"blocks": [b("image"), b("text", "Figure 1. Appendix figure."), b("text", "See Figure 1 and Figure 2.")]},
            {"blocks": [b("text", "## References"), b("text", "[6] Figure 3.30 - external title")]},
        ]
        entries, assignments, groups = reference_layout(pages)
        self.assertEqual(assignments[1, 0]["anchor"], "fig-1")
        self.assertEqual(assignments[3, 0]["anchor"], "fig-1-appendix-A-2")
        linked = cross_references("Figure 1 and Figure 2.", entries[3, 2], groups)
        self.assertIn('href="#fig-1-appendix-A-2"', linked)
        self.assertNotIn('href="#fig-2', linked)
        self.assertEqual(cross_references("Figure 1; Figure 3.30", entries[4, 1], groups), "Figure 1; Figure 3.30")

    def test_continued_tables_share_caption_without_counting_chunks(self):
        b = self.block
        pages = [
            {"blocks": [b("text", "Table 2: A multipage table.")]},
            {"blocks": [b("text", "## Typical Limitations", [.3, .21, .5, .25]), b("table", "<table><tr><td>Part A</td></tr></table>", [.1, .2, .9, .8])]},
            {"blocks": [b("table", "<table><tr><td>Part B</td></tr></table>")]},
            {"blocks": [b("text", "An intervening paragraph ends the table."), b("table", "<table><tr><td>Unnumbered</td></tr></table>")]},
        ]
        entries, assignments, _ = reference_layout(pages)
        self.assertTrue(entries[2, 0]["table_heading"])
        self.assertEqual(assignments[2, 1]["anchor"], "table-2")
        self.assertEqual(assignments[3, 0]["anchor"], "table-2-part-2")
        self.assertNotIn((4, 1), assignments)

    def test_unproven_numbers_and_math_content_remain_plain(self):
        b = self.block
        pages = [{"blocks": [b("image"), b("text", "Narrative mentioning Figure 9 is not a caption."), b("text", "Figure 9.")]}]
        entries, assignments, groups = reference_layout(pages)
        self.assertNotIn((1, 0), assignments)
        self.assertEqual(cross_references("Figure 1", entries[1, 1], groups), "Figure 1")
        pages = [{"blocks": [b("image"), b("text", "Figure 9 | Proven caption."), b("text", "See Figure 9.")]}]
        entries, _, groups = reference_layout(pages)
        value = '<math><mtext>Figure 9</mtext></math> <a href="#x">Figure 9</a> Figure 9'
        linked = cross_references(value, entries[1, 2], groups)
        self.assertEqual(linked.count('class="cross-reference"'), 1)
        self.assertIn('<mtext>Figure 9</mtext>', linked)

    def test_prefixed_grid_panels_and_following_page_legend_share_one_group(self):
        b = self.block
        pages = [
            {"blocks": [b("image", box=[.1, .1, .4, .25]), b("text", "B. Readout", [.5, .1, .8, .13]), b("image", box=[.5, .15, .8, .25]), b("text", "Figure M3. A multi-panel grid.", [.1, .3, .9, .4])]},
            {"blocks": [b("image", box=[.1, .1, .9, .3]), b("text", "B Hit rates", [.1, .31, .4, .34]), b("image", box=[.1, .35, .9, .6]), b("text", "Figure 5 (legend on the following page).", [.4, .7, .6, .75])]},
            {"blocks": [b("text", "Figure 5. Full legend on the following page.")]},
            {"blocks": [b("image"), b("text", "Fig. 2 The source caption omitted its separator.")]},
        ]
        entries, assignments, groups = reference_layout(pages)
        self.assertEqual(assignments[1, 0]["anchor"], "fig-M3")
        self.assertEqual(assignments[1, 2]["anchor"], "fig-M3-part-2")
        self.assertEqual(assignments[2, 0]["group"]["caption_location"], (3, 0))
        self.assertEqual(len(assignments[2, 0]["group"]["members"]), 2)
        self.assertEqual(assignments[4, 0]["anchor"], "fig-2")
        entry = dict(entries[1, 1], caption=None)
        self.assertIn('href="#fig-M3"', cross_references("Figure M3", entry, groups))
        self.assertNotIn("href", cross_references("Figure 3", entry, groups))

    def test_nearest_proven_caption_wins_when_same_scope_reuses_a_number(self):
        b = self.block
        pages = [
            {"blocks": [b("image"), b("text", "Figure 1: First report.")]},
            {"blocks": [b("text", "Some intervening narrative.")]},
            {"blocks": [b("image"), b("text", "Figure 1: Second report."), b("text", "See Figure 1.")]},
        ]
        entries, assignments, groups = reference_layout(pages)
        self.assertEqual(assignments[3, 0]["anchor"], "fig-1-p3-0")
        self.assertIn('href="#fig-1-p3-0"', cross_references("Figure 1", entries[3, 2], groups))


class ContentsTests(unittest.TestCase):
    block = staticmethod(CaptionReferenceTests.block)

    def test_explicit_contents_supports_wrapped_titles_leaders_appendix_and_roman_pages(self):
        b = self.block
        pages = [{"blocks": [b("text", "## Table of Contents"), b("text", "# 1 Introduction .... iii\n1.2 A wrapped section\ntitle .... 12\nA Appendix 35\nA.1 Details 36\nReferences 40")]}]
        headings, contents = contents_layout(pages)
        self.assertEqual(headings, {(1, 0)})
        rows = contents[1, 1]
        self.assertEqual([r["level"] for r in rows], [1, 2, 1, 2, 1])
        self.assertEqual(rows[0]["page_label"], "iii")
        self.assertEqual(rows[1]["title"], "A wrapped section title")
        self.assertIn("\n", rows[1]["source_line"])
        self.assertEqual(rows[2]["number"], "A")

    def test_continuation_stops_at_body_and_numbered_prose_or_references_are_not_contents(self):
        b = self.block
        pages = [
            {"blocks": [b("text", "## Contents"), b("text", "1 First 2\n1.1 Detail 3")]},
            {"blocks": [b("page_header", "Header"), b("text", "2 Second 4\n2.1 More 5"), b("text", "## 1 First"), b("text", "3 A numbered sentence 6\n4 Another numbered sentence 7")]},
            {"blocks": [b("text", "5 Further prose 8\n6 Further prose 9")]},
        ]
        _headings, contents = contents_layout(pages)
        self.assertEqual(set(contents), {(1, 1), (2, 1)})
        for ordinary in ["1 First 2\n2 Second 3", "[1] Author. A paper. 2020\n[2] Author. A paper. 2021", "## 1 Introduction\nSome ordinary text."]:
            self.assertEqual(contents_layout([{"blocks": [b("text", ordinary)]}]), (set(), {}))
        self.assertEqual(contents_layout([{"blocks": [b("text", "## Contents"), b("text", "An ordinary paragraph without directory rows.")]}]), (set(), {}))

    def fixture(self, root, pages):
        try:
            from reportlab.pdfgen.canvas import Canvas
            import pdfplumber
            from PIL import Image
        except ImportError:
            self.skipTest("PDF exporter dependencies required")
        pdf = root / "source.pdf"
        canvas = Canvas(str(pdf), pagesize=(400, 400))
        for index in range(len(pages)):
            canvas.drawString(40, 340, f"Synthetic source page {index+1}")
            canvas.showPage()
        canvas.save()
        fusion = root / "fusion"
        fusion.mkdir()
        (fusion / "document.json").write_text(json.dumps({"schema": "guzi-fusion-auto-v3", "pages": pages}))
        return pdf, fusion

    def test_forty_entries_across_two_pages_keep_block_ids_and_only_link_real_sections(self):
        b = self.block
        titles = [f"{i//4+1}.{i%4+1} Section {i+1}" for i in range(40)]
        lines = [f"# {title} {50+i}" for i, title in enumerate(titles)]
        pages = [{"blocks": [b("text", "## Contents"), b("text", "\n\n".join(lines[:14]))]}, {"blocks": [b("text", "\n\n".join(lines[14:]))]}, {"blocks": [b("text", "## " + title) for title in titles]}]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pdf, fusion = self.fixture(root, pages)
            with patch("services.parser_service.exporter.contents_layout", return_value=(set(), {})):
                export_document(pdf, fusion, root / "before")
            export_document(pdf, fusion, root / "after")
            previous = json.loads((root / "before/document.json").read_text())
            result = json.loads((root / "after/document.json").read_text())
            changed = [result["pages"][0]["elements"][1], result["pages"][1]["elements"][0]]
            rows = [row for block in changed for row in block["toc_entries"]]
            self.assertEqual(len(rows), 40)
            self.assertTrue(all(row["target_verified"] and row["target_page"] == 3 for row in rows))
            self.assertEqual([row["page_label"] for row in rows], [str(50+i) for i in range(40)])
            for pi, bi in [(0, 1), (1, 0)]:
                old, new = previous["pages"][pi]["elements"][bi], result["pages"][pi]["elements"][bi]
                for field in ["block_id", "source_content", "bbox"]:
                    self.assertEqual(old[field], new[field])
                self.assertEqual(new["type"], "table_of_contents")
                self.assertEqual(new["html"].count('data-block-id='), 1)
                self.assertNotRegex(new["html"], r"<h[1-6]")
                self.assertIn('<nav class="paper-toc"', new["html"])
            self.assertEqual(previous["pages"][2]["elements"], result["pages"][2]["elements"])
            self.assertIn('data-reader-toc-excluded="contents"', result["pages"][0]["elements"][0]["html"])
            markup = (root / "after/document.html").read_text()
            for row in rows:
                self.assertIn('id="'+row["target_anchor"]+'"', markup)
            self.assertEqual(markup.count('class="toc-row toc-link"'), 40)
            self.assertNotIn('class="cross-reference"', ''.join(block["html"] for block in changed))

    def test_single_page_directory_does_not_link_ambiguous_or_missing_titles(self):
        b = self.block
        pages = [{"blocks": [b("text", "目录"), b("text", "1 Duplicate 1\n2 Missing 9"), b("text", "## 1 Duplicate"), b("text", "## 1 Duplicate")]}]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pdf, fusion = self.fixture(root, pages)
            export_document(pdf, fusion, root / "output")
            record = json.loads((root / "output/document.json").read_text())["pages"][0]["elements"][1]
            self.assertEqual([row["target_status"] for row in record["toc_entries"]], ["ambiguous", "unmatched"])
            self.assertNotIn('href=', record["html"])


class NativeScriptRecoveryTests(unittest.TestCase):
    def fixture(self, root, explicit=True, duplicate=False):
        try:
            from pypdf import PdfWriter
            from pypdf.generic import DictionaryObject, NameObject, ArrayObject, NumberObject, DecodedStreamObject
        except ImportError:
            self.skipTest("pypdf required for explicit font resource fixture")
        writer = PdfWriter()
        page = writer.add_blank_page(400, 400)
        normal = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica')})
        script = DictionaryObject(normal)
        script.update({NameObject('/FirstChar'): NumberObject(178), NameObject('/LastChar'): NumberObject(178), NameObject('/Widths'): ArrayObject([NumberObject(333)])})
        if explicit:
            script[NameObject('/Encoding')] = DictionaryObject({NameObject('/Differences'): ArrayObject([NumberObject(178), NameObject('/twosuperior')])})
        cmap = DecodedStreamObject()
        cmap.set_data(b'/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapType 2 def 1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfchar <B2> <0032> endbfchar endcmap end end')
        script[NameObject('/ToUnicode')] = writer._add_object(cmap)
        page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/Normal'): writer._add_object(normal), NameObject('/Script'): writer._add_object(script)})})
        content = b'BT /Normal 12 Tf 1 0 0 1 40 120 Tm (Previous ordinary paragraph line) Tj ET\nBT /Normal 12 Tf 1 0 0 1 40 100 Tm (\\(R) Tj /Script 12 Tf <B2> Tj /Normal 12 Tf (\\).) Tj ET\nBT /Normal 12 Tf 1 0 0 1 40 60 Tm (\\(R2\\).) Tj ET'
        if duplicate:
            content += b'\nBT /Normal 12 Tf 1 0 0 1 52.66 100 Tm (2) Tj ET'
        stream = DecodedStreamObject()
        stream.set_data(content)
        page[NameObject('/Contents')] = writer._add_object(stream)
        pdf = root / 'font-resource.pdf'
        writer.write(pdf)
        return pdf

    @staticmethod
    def audit(ids, formula=r'\left( R^{2}\right).'):
        return {'status': 'unresolved', 'reason': 'formula_structure_or_glyphs_unresolved', 'render_mode': 'source-crop', 'source_crop_required': True, 'source_glyph_ids': ids, 'selected_engine': 'glm', 'candidate_content': '$'+formula+'$', 'candidates': [{'engine': 'glm', 'content': formula, 'score': 2, 'script_errors': [{'candidate_script': 'sup', 'source_script': None}], 'lexical_errors': 0, 'style_errors': [], 'structure_errors': [], 'unknown_macros': [], 'alignment_coverage': 1.0, 'native_coverage': 1.0}]}

    def test_resource_and_charcode_prove_superscript_without_confusing_same_font_normal_digit(self):
        import pdfplumber
        from services.parser_service.native_pdf import NativePage
        with tempfile.TemporaryDirectory() as directory:
            pdf = self.fixture(Path(directory))
            with pdfplumber.open(pdf) as document:
                page = NativePage(document.pages[0])
                line = [c for c in page.chars if abs(c['baseline']-300) < .01]
                normal = [c for c in page.chars if abs(c['baseline']-340) < .01 and c['text']=='2'][0]
                digit = next(c for c in line if c['text']=='2')
                self.assertEqual(normal['fontname'], digit['fontname'])
                self.assertAlmostEqual(normal['size'], digit['size'])
                evidence = page.encoded_script_glyphs()
                self.assertEqual(evidence[digit['glyph_id']]['font_resource'], 'Script')
                self.assertEqual(evidence[digit['glyph_id']]['charcode'], 178)
                self.assertEqual(evidence[digit['glyph_id']]['glyph_name'], 'twosuperior')
                self.assertNotIn(normal['glyph_id'], evidence)
                audit = self.audit([c['glyph_id'] for c in line])
                revalidate_inline_source(audit, page, [0, 0, 1, 1])
                self.assertEqual(audit['status'], 'confirmed')
                self.assertEqual(audit['render_mode'], 'native-script')
                self.assertEqual([(s['text'], s.get('script_kind')) for s in audit['selectable_segments']], [('(R', None), ('2', 'sup'), (').', None)])
                self.assertFalse(audit['source_crop_required'])
                self.assertAlmostEqual(audit['native_geometry']['body_baseline_normalized'], line[0]['baseline']/400)
                ids = [c['glyph_id'] for c in line]
            source = 'The coefficient is $'+r'\left( R^{2}\right).$'
            candidate = self.audit(ids)
            candidate.update(start=source.index('$'), end=len(source))
            fusion = Path(directory)/'fusion'
            fusion.mkdir()
            (fusion/'document.json').write_text(json.dumps({'pages':[{'blocks':[{'label':'text','content':source,'source_bbox_normalized':[0,0,1,1],'math_audit':{'inline':[candidate],'status':'unresolved'}}]}]}))
            export_document(pdf, fusion, Path(directory)/'output')
            record = json.loads((Path(directory)/'output/document.json').read_text())['pages'][0]['elements'][0]
            self.assertIn('(R<sup>2</sup>).', record['html'])
            self.assertNotIn('<img',record['html'])
            self.assertEqual(record['text'],'The coefficient is (R2).')

    def test_explicit_unicode_scripts_recover_subscript_and_superscript_without_guessing(self):
        from types import SimpleNamespace
        from pdfminer.pdfinterp import PDFResourceManager
        from services.parser_service.native_pdf import NativePage, canonical
        for text, formula, expected in [('CO₂',r'\mathrm{CO}_{2}','sub'), ('δ¹⁸O',r'\delta^{18}O','sup')]:
            with self.subTest(text=text):
                page = NativePage.__new__(NativePage)
                page.page = SimpleNamespace(page_obj=SimpleNamespace(resources={}), pdf=SimpleNamespace(rsrcmgr=PDFResourceManager()))
                page.chars = [{'glyph_id':i,'resolved_text':char,'text':char,'canonical':canonical(char),'rotated':False,'matrix':(1,0,0,1,i*5,0)} for i,char in enumerate(text)]
                ids = list(range(len(text)))
                page.inline_geometry = lambda *_args: {'status':'confirmed','source_bbox_normalized':[0,0,.5,.1],'source_glyph_ids':ids,'body_baseline_normalized':.1,'body_font_size_points':12,'height_em':1,'baseline_offset_em':0}
                audit = self.audit(ids,formula)
                revalidate_inline_source(audit,page,[0,0,1,1])
                self.assertEqual(audit['status'],'confirmed')
                self.assertTrue(any(segment.get('script_kind')==expected for segment in audit['selectable_segments']))
                self.assertTrue(all(item['source']=='unicode-script' for item in audit['source_revalidation']['script_glyphs']))

    def test_style_consistent_but_unrepresentable_math_atoms_keep_source_fallback(self):
        import copy
        from types import SimpleNamespace
        for style in ['mathbf', 'mathit', 'mathcal', 'mathbb', 'mathrm{\\mathbf']:
            with self.subTest(style=style):
                formula = '\\'+style+'{R}'+('}' if '{' in style else '')+'^{2}'
                source = SimpleNamespace(chars=[{'glyph_id':0,'canonical':'R','rotated':False,'math_style':style}, {'glyph_id':1,'canonical':'2','rotated':False}], inline_geometry=lambda *_args: {'status':'confirmed'}, encoded_script_glyphs=lambda: {1:{'script_kind':'sup','source':'unicode-script'}})
                audit = self.audit([0,1],formula)
                self.assertEqual(audit['candidates'][0]['style_errors'],[])
                before = copy.deepcopy(audit)
                revalidate_inline_source(audit,source,[0,0,1,1])
                self.assertEqual(audit,before)

    def test_absent_or_ambiguous_encoding_and_candidate_mismatch_keep_fallback(self):
        import pdfplumber
        from services.parser_service.native_pdf import NativePage
        for explicit, duplicate in [(False, False), (True, True), (True, False)]:
            with self.subTest(explicit=explicit, duplicate=duplicate), tempfile.TemporaryDirectory() as directory:
                pdf = self.fixture(Path(directory), explicit, duplicate)
                with pdfplumber.open(pdf) as document:
                    page = NativePage(document.pages[0])
                    line = [c for c in page.chars if abs(c['baseline']-300) < .01]
                    audit = self.audit([c['glyph_id'] for c in line], r'(R^{3}).' if explicit and not duplicate else r'(R^{2}).')
                    revalidate_inline_source(audit, page, [0, 0, 1, 1])
                    self.assertEqual(audit['status'], 'unresolved')
                    self.assertTrue(audit['source_crop_required'])

    def test_pure_geometric_scripts_keep_adjacent_stem_baseline_and_direction(self):
        from reportlab.pdfgen.canvas import Canvas
        import pdfplumber
        from services.parser_service.native_pdf import NativePage
        for y, text, kind in [(105,'12','sup'), (97,'min','sub')]:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                pdf = Path(directory)/'citation.pdf'
                canvas = Canvas(str(pdf), pagesize=(400,400))
                canvas.setFont('Helvetica',12)
                canvas.drawString(40,100,'ordinary text')
                canvas.setFont('Helvetica',7)
                canvas.drawString(111,y,text)
                canvas.save()
                with pdfplumber.open(pdf) as document:
                    page = NativePage(document.pages[0])
                    ids = [c['glyph_id'] for c in page.chars if c['size']==7]
                    geometry = page.inline_geometry(ids,[0,0,1,1])
                    self.assertEqual(geometry['script_kind'],kind)
                    self.assertAlmostEqual(geometry['body_baseline_normalized'],.75)
                    self.assertLess(geometry['baseline_offset_em'],0) if kind=='sup' else self.assertGreater(geometry['baseline_offset_em'],0)
                    self.assertNotIn('baseline_source',geometry)


class CompositeFigureTests(unittest.TestCase):
    def setUp(self):
        try:
            import pdfplumber
            import reportlab
            from PIL import Image
        except ImportError:
            self.skipTest("pdfplumber/reportlab/Pillow required for composite fixture")

    @staticmethod
    def blocks():
        parts = [
            ("text", "A.", [.19, .09, .205, .101]), ("image", "", [.215, .095, .789, .172]),
            ("text", "B.", [.19, .19, .206, .202]), ("table", "<table><tr><td>Panel scale</td></tr></table>", [.201, .209, .347, .369]),
            ("image", "", [.369, .19, .589, .35]), ("text", "D.", [.601, .19, .615, .202]),
            ("table", "<table><tr><td>73%</td></tr></table>", [.376, .345, .588, .37]),
            ("image", "", [.605, .191, .802, .37]), ("image", "", [.19, .384, .384, .551]),
            ("text", "F.", [.377, .382, .39, .393]), ("text", "G.", [.601, .382, .616, .394]),
            ("image", "", [.398, .386, .577, .58]), ("image", "", [.591, .39, .807, .524]),
            ("text", "Figure 4: A. Overview. B. Scale. C. Metrics. D. Bars. E. Means. F. Legend. G. Summary.", [.111, .589, .888, .728]),
            ("text", "Selectable body after Figure 4 remains unchanged.", [.112, .767, .885, .824]),
        ]
        return [{"label": label, "content": content, "source_bbox_normalized": box, **({"image_path": "images/old-part.png"} if label == "image" else {})} for label, content, box in parts]

    def fixture(self, root, blocks=None, overlay=False, second_page=False, flipped=False, edge_ink=False, inset_native=False, interior_ink=None):
        try:
            from reportlab.pdfgen.canvas import Canvas
            from PIL import Image, ImageDraw
        except ImportError:
            self.skipTest("reportlab/Pillow required for composite fixture")
        image = Image.new("RGB", (1234, 980), "white")
        draw = ImageDraw.Draw(image)
        draw.rectangle((20, 20, 1210, 955), outline="black", width=3)
        draw.text((25, 25), "A B C D E F G; E:35.16+/-21.72; G:1.45 / 0.579; legend", fill="black")
        image.save(root / "original.png")
        pdf = root / "source.pdf"
        canvas = Canvas(str(pdf), pagesize=(400, 400))
        canvas.saveState()
        if flipped:
            canvas.translate((.19+.807)*400, 0)
            canvas.scale(-1, 1)
        native_left = .195 if inset_native else .19
        canvas.drawImage(str(root / "original.png"), native_left*400, (1-.58)*400, width=(.807-native_left)*400, height=(.58-.09)*400)
        canvas.restoreState()
        if interior_ink:
            size, left, text = interior_ink
            canvas.setFont("Helvetica", size)
            canvas.drawString(left*400, .45*400, text)
        if edge_ink:
            canvas.line(.188*400, .45*400, .20*400, .45*400)
        if overlay:
            Image.new("RGB", (10, 10), "blue").save(root / "overlay.png")
            canvas.drawImage(str(root / "overlay.png"), 140, 230, width=10, height=10)
        canvas.drawString(44, 150, "Figure 4: Selectable caption")
        canvas.drawString(44, 65, "Selectable ordinary body")
        if second_page:
            canvas.showPage()
            canvas.drawString(40, 340, "Second ordinary page")
        canvas.save()
        fusion = root / "fusion"
        (fusion / "images").mkdir(parents=True)
        Image.new("RGB", (2, 2), "red").save(fusion / "images/old-part.png")
        pages = [{"blocks": blocks or self.blocks()}]
        if second_page:
            pages.append({"blocks": [{"label": "text", "content": "Second ordinary page", "bbox_2d": [100, 100, 900, 200]}]})
        (fusion / "document.json").write_text(json.dumps({"schema": "guzi-fusion-auto-v3", "pages": pages}))
        return pdf, fusion

    def test_unbound_panels_and_tables_become_one_original_image_without_changing_body(self):
        from PIL import Image, ImageChops
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pdf, fusion = self.fixture(root)
            with patch("services.parser_service.exporter.composite_figures", return_value=[]):
                export_document(pdf, fusion, root / "baseline")
            export_document(pdf, fusion, root / "output")
            old = json.loads((root / "baseline/document.json").read_text())["pages"][0]["elements"]
            records = json.loads((root / "output/document.json").read_text())["pages"][0]["elements"]
            host = records[7]
            self.assertEqual(host["render_mode"], "composite-figure")
            self.assertEqual(len(host["figure_group"]["component_block_ids"]), 13)
            self.assertIn(host["block_id"], host["figure_group"]["component_block_ids"])
            self.assertEqual(sum(block["html"].count("<img") for block in records[:13]), 1)
            self.assertTrue(all(block["render_mode"] == "figure-component" for i, block in enumerate(records[:13]) if i != 7))
            self.assertEqual([block["source_content"] for block in records], [block["content"] for block in self.blocks()])
            for previous, current in zip(old[13:], records[13:]):
                for field in ["block_id", "text", "html", "markdown", "bbox", "math_audit"]:
                    self.assertEqual(previous[field], current[field])
            self.assertEqual(host["source_block_bbox"], old[7]["bbox"])
            self.assertTrue(all(block["render_bbox"] == host["render_bbox"] for block in records[:13]))
            aliases = set(host["figure_group"]["anchor_aliases"])
            self.assertTrue({old[index]["anchor"] for index in [1, 3, 4, 6, 8, 11, 12]} <= aliases)
            from html.parser import HTMLParser
            class Nodes(HTMLParser):
                def __init__(self):
                    super().__init__()
                    self.nodes = []
                def handle_starttag(self, tag, attrs):
                    self.nodes.append((tag, dict(attrs)))
            parsed = Nodes()
            parsed.feed((root / "output/document.html").read_text())
            for alias in aliases:
                target = next(attrs for _tag, attrs in parsed.nodes if attrs.get("id") == alias)
                group_hosts = [attrs for tag, attrs in parsed.nodes if tag == "figure" and attrs.get("data-media-group") == target.get("data-media-group")]
                self.assertEqual(len(group_hosts), 1)
                self.assertEqual(target.get("data-caption-id"), "caption-fig-4")
                self.assertTrue(any(attrs.get("id") == target["data-caption-id"] for _tag, attrs in parsed.nodes))
            self.assertEqual(host["asset_provenance"]["kind"], "pdf-embedded-image")
            self.assertIsNone(host["asset_provenance"]["antialias"])
            with Image.open(root / "original.png") as original, Image.open(root / "output" / host["visual_asset"]) as result:
                self.assertEqual(result.size, (1234, 980))
                self.assertIsNone(ImageChops.difference(original, result).getbbox())

    def test_panel_labels_use_local_geometry_across_marker_and_heading_forms(self):
        import copy
        b = CaptionReferenceTests.block
        for label, content in [("text", "B. Readout"), ("heading", "## (b)"), ("text", "b"), ("text", "(b) Description.")]:
            blocks = [b("image", box=[.1, .1, .4, .25]), b(label, content, [.5, .1, .8, .13]), b("image", box=[.5, .15, .8, .25]), b("text", "Figure 2: Two panels.", [.1, .3, .9, .4])]
            with self.subTest(label=label, content=content):
                entries, assignments, groups = reference_layout([{"blocks": blocks}])
                previous = copy.deepcopy(assignments)
                composites = composite_figures(entries, assignments, groups, lambda page: [[.09, .09, .81, .26]])
                self.assertEqual(composites[0]["components"], [(1, i) for i in range(3)])
                self.assertEqual(assignments, previous)
                self.assertEqual([assignments[1, i]["anchor"] for i in (0, 2)], ["fig-2", "fig-2-part-2"])

    def test_shared_panel_titles_and_footnotes_stay_with_their_image_grid(self):
        b = CaptionReferenceTests.block
        blocks = [
            b("heading", "## Assay one", [.138, .09, .218, .101]),
            b("image", box=[.131, .117, .343, .225]),
            b("text", "Readout: stacked curves; fit per replicate", [.364, .119, .501, .144]),
            b("image", box=[.364, .149, .5, .218]),
            b("text", "Design as captured fusion", [.305, .238, .498, .247]),
            b("text", "Target concentrations: 1,000 333 111 37 12.3 4.1", [.419, .281, .744, .29]),
            b("image", box=[.311, .32, .495, .426]),
            b("image", box=[.502, .314, .699, .426]),
            b("image", box=[.701, .322, .882, .426]),
            b("text", "Figure M2. Assay panels and their readouts.", [.1, .46, .9, .6]),
        ]
        entries, assignments, groups = reference_layout([{"blocks": blocks}])
        composites = composite_figures(entries, assignments, groups, lambda page: [[.1, .08, .9, .44]])
        self.assertEqual(composites[0]["components"], [(1, i) for i in range(9)])
        self.assertEqual(composites[0]["bbox"], [.131, .09, .882, .426])

    def test_caption_and_panel_source_order_can_interleave_without_losing_aliases(self):
        blocks = self.blocks()
        blocks[0]["content"] = "## A."
        last_image = blocks.pop(12)
        blocks.insert(13, last_image)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pdf, fusion = self.fixture(root, blocks=blocks)
            with patch("services.parser_service.exporter.composite_figures", return_value=[]):
                export_document(pdf, fusion, root / "baseline")
            export_document(pdf, fusion, root / "output")
            old = json.loads((root / "baseline/document.json").read_text())["pages"][0]["elements"]
            records = json.loads((root / "output/document.json").read_text())["pages"][0]["elements"]
            host = next(record for record in records if record.get("render_mode") == "composite-figure")
            self.assertEqual(len(host["figure_group"]["component_block_ids"]), 13)
            self.assertEqual(records[13]["render_mode"], "figure-component")
            self.assertIn(old[13]["anchor"], host["figure_group"]["anchor_aliases"])
            self.assertIn("section-" + old[0]["block_id"], host["figure_group"]["anchor_aliases"])
            for index in (12, 14):
                for field in ("block_id", "text", "html", "markdown", "bbox", "math_audit"):
                    self.assertEqual(old[index][field], records[index][field])
            self.assertEqual(records[12]["anchor"] if "anchor" in records[12] else None, None)
            self.assertIn('id="caption-fig-4"', records[12]["html"])

    def test_text_only_panel_requires_label_sequence_caption_and_a_bounded_region(self):
        import copy
        b = CaptionReferenceTests.block
        blocks = [
            b("heading", "## A.", [.19, .087, .206, .1]),
            b("heading", "## Question:", [.202, .112, .257, .122]),
            b("text", "An example question with a complete sentence.", [.2, .124, .794, .144]),
            b("text", "An example answer remains part of the printed panel.", [.2, .176, .781, .206]),
            b("heading", "## Metadata:", [.2, .212, .3, .223]),
            b("text", "An example citation", [.2, .235, .789, .257]),
            b("text", "B", [.191, .276, .202, .287]),
            b("image", box=[.205, .286, .457, .479]),
            b("image", box=[.512, .285, .766, .479]),
            b("text", "Figure 2: A. Example text panel. B. Results.", [.111, .5, .887, .6]),
        ]
        entries, assignments, groups = reference_layout([{"blocks": blocks}])
        frames = lambda page: [[.194, .091, .806, .479]]
        self.assertEqual(composite_figures(entries, assignments, groups, frames)[0]["components"], [(1, i) for i in range(9)])
        self.assertEqual(composite_figures(entries, assignments, groups), [])
        for invalid_frame in [[.1, .05, .9, .49], [.19, .09, .8, .25], [.19, .09, .81, .52]]:
            self.assertEqual(composite_figures(entries, assignments, groups, lambda page: [invalid_frame]), [])
        for mutation in ("numbered_body", "outside_body", "independent_caption"):
            invalid = copy.deepcopy(blocks)
            if mutation == "numbered_body":
                invalid[1]["content"] = "## 3 Introduction"
            elif mutation == "outside_body":
                invalid[3]["source_bbox_normalized"][0] = .05
            else:
                invalid[3]["content"] = "Table 8: Independent results."
            with self.subTest(mutation=mutation):
                entries, assignments, groups = reference_layout([{"blocks": invalid}])
                self.assertEqual(composite_figures(entries, assignments, groups, frames), [])

    def test_external_sections_and_narrative_do_not_become_figure_labels(self):
        b = CaptionReferenceTests.block
        images = [b("image", box=[.1, .2, .45, .4]), b("image", box=[.5, .2, .85, .4])]
        caption = b("text", "Figure 1: Comparison of two panels.", [.1, .46, .9, .52])
        for label, content in [("heading", "Results"), ("text", "We next evaluate held-out accuracy"), ("heading", "A. Experimental setup"), ("text", "A. We next evaluated accuracy.")]:
            with self.subTest(label=label, content=content):
                entries, assignments, groups = reference_layout([{"blocks": [b(label, content, [.1, .15, .44, .18]), *images, caption]}])
                composites = composite_figures(entries, assignments, groups)
                self.assertEqual(composites[0]["components"], [(1, 1), (1, 2)])
        entries, assignments, groups = reference_layout([{"blocks": [images[0], caption, b("text", "b", [.5, .15, .52, .18]), images[1]]}])
        self.assertEqual(composite_figures(entries, assignments, groups)[0]["components"], [(1, 0), (1, 2), (1, 3)])

    def test_independent_table_body_and_caption_overlap_block_merging(self):
        import copy
        base = self.blocks()
        cases = []
        separate_table = copy.deepcopy(base)
        separate_table.insert(7, {"label": "text", "content": "Table 2: Independent table", "source_bbox_normalized": [.2, .373, .8, .38]})
        cases.append(separate_table)
        body = copy.deepcopy(base)
        body.insert(9, {"label": "text", "content": "A substantive ordinary paragraph interrupts these pictures.", "source_bbox_normalized": [.2, .372, .8, .38]})
        cases.append(body)
        for content, box in [
            ("A short ordinary sentence.", [.4, .372, .57, .38]),
            ("An ordinary wide paragraph fragment without punctuation", [.2, .372, .8, .38]),
            ("Held-out accuracy increases after training", [.4, .372, .57, .38]),
            ("(a) Held-out accuracy increases.", [.4, .372, .57, .38]),
            ("## 2 Results", [.4, .372, .57, .38]),
            ("A nearby heading outside the panels", [.4, .65, .57, .67]),
        ]:
            paragraph = copy.deepcopy(base)
            paragraph.insert(9, {"label": "text", "content": content, "source_bbox_normalized": box})
            cases.append(paragraph)
        outside_table = copy.deepcopy(base)
        outside_table[3]["source_bbox_normalized"][0] = .05
        cases.append(outside_table)
        overlap = copy.deepcopy(base)
        overlap[13]["source_bbox_normalized"][1] = .57
        cases.append(overlap)
        for blocks in cases:
            with self.subTest(blocks=blocks):
                entries, assignments, groups = reference_layout([{"blocks": blocks}])
                self.assertEqual(composite_figures(entries, assignments, groups), [])
        entries, assignments, groups = reference_layout([{"blocks": base[:13]}, {"blocks": base[13:]}])
        self.assertEqual(composite_figures(entries, assignments, groups), [])

    def test_native_image_keeps_intrinsic_pixels_despite_ocr_bbox_rounding(self):
        blocks = self.blocks()
        blocks[1]["source_bbox_normalized"][0] = .188
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pdf, fusion = self.fixture(root, blocks=blocks)
            export_document(pdf, fusion, root / "output")
            records = json.loads((root / "output/document.json").read_text())["pages"][0]["elements"]
            host = next(record for record in records if record.get("render_mode") == "composite-figure")
            self.assertEqual(host["component_envelope_bbox"][0], .188)
            self.assertEqual(host["asset_provenance"]["kind"], "pdf-embedded-image")
            self.assertEqual(host["asset_provenance"]["intrinsic_pixels"], [1234, 980])

    def test_native_snap_cannot_discard_real_ink_inside_an_ocr_envelope(self):
        for ink in [(4, .191, "x_new"), (2, .1902, "x")]:
            with self.subTest(ink=ink), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                pdf, fusion = self.fixture(root, inset_native=True, interior_ink=ink)
                export_document(pdf, fusion, root / "output")
                records = json.loads((root / "output/document.json").read_text())["pages"][0]["elements"]
                host = next(record for record in records if record.get("render_mode") == "composite-figure")
                self.assertEqual(host["render_bbox"][0], .19)
                self.assertLess(host["source_ink_bbox"][0], .195)
                self.assertEqual(host["asset_provenance"]["kind"], "pdf-render")

    def test_native_image_snap_cannot_shrink_expanded_vector_ink(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pdf, fusion = self.fixture(root, edge_ink=True)
            export_document(pdf, fusion, root / "output")
            records = json.loads((root / "output/document.json").read_text())["pages"][0]["elements"]
            host = next(record for record in records if record.get("render_mode") == "composite-figure")
            self.assertEqual(host["component_envelope_bbox"], [.19, .09, .807, .58])
            self.assertLess(host["render_bbox"][0], .188)
            self.assertIn("left", host["ink_expanded_edges"])
            self.assertEqual(host["asset_provenance"]["kind"], "pdf-render")

    def test_source_ink_expansion_keeps_vector_labels_but_excludes_body_and_caption(self):
        from reportlab.pdfgen.canvas import Canvas
        with tempfile.TemporaryDirectory() as directory:
            pdf = Path(directory) / "ink.pdf"
            canvas = Canvas(str(pdf), pagesize=(400, 400))
            canvas.setFont("Helvetica", 8)
            canvas.drawString(.18*400, .5*400, "x_new")
            canvas.line(.175*400, .45*400, .25*400, .45*400)
            canvas.rect(.05*400, .05*400, .9*400, .9*400)
            canvas.drawString(.3*400, .385*400, "Figure 1: Selectable caption")
            canvas.save()
            bounds = [.2, .2, .8, .6]
            caption = {"bbox": [.1, .605, .9, .65]}
            result = source_figure_ink_bounds(pdf, 1, bounds, [caption])
            self.assertLess(result[0], .175)
            self.assertGreaterEqual(result[0], bounds[0]-.03)
            self.assertEqual(result[1:], bounds[1:])
            body = {"bbox": [.17, .2, .199, .6]}
            self.assertEqual(source_figure_ink_bounds(pdf, 1, bounds, [body, caption]), bounds)

    def test_source_frame_evidence_applies_nested_form_transforms(self):
        from reportlab.pdfgen.canvas import Canvas
        from PIL import Image
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            Image.new("RGB", (20, 20), "red").save(root / "panel.png")
            pdf = root / "nested.pdf"
            canvas = Canvas(str(pdf), pagesize=(400, 400))
            canvas.beginForm("panel")
            canvas.drawImage(str(root / "panel.png"), 10, 20, width=100, height=80)
            canvas.endForm()
            canvas.translate(40, 50)
            canvas.scale(2, .5)
            canvas.doForm("panel")
            canvas.save()
            frames = source_figure_frames(pdf, 1)
            self.assertTrue(any(all(abs(a-b) < .00001 for a, b in zip(frame, [.15, .75, .65, .85])) for frame in frames))

    def test_pdfium_prefilter_skips_pdfminer_only_when_no_image_bbox_matches(self):
        import pdfplumber
        from pdfplumber.page import Page
        images_property = Page.images
        with tempfile.TemporaryDirectory() as directory:
            pdf, _fusion = self.fixture(Path(directory))
            with pdfplumber.open(pdf) as document:
                page = document.pages[0]
                with patch.object(Page, "images", new_callable=PropertyMock, side_effect=AssertionError("Unneeded full-page parse")) as images:
                    self.assertIsNone(embedded_figure(pdf, 1, page, [.01, .01, .1, .1]))
                    images.assert_not_called()
                with patch.object(Page, "images", new_callable=PropertyMock, side_effect=lambda: images_property.fget(page)) as images:
                    match = embedded_figure(pdf, 1, page, [.19, .09, .807, .58])
                    images.assert_called_once_with()
                    self.assertIsNotNone(match)
                    self.assertEqual(match[0]["srcsize"], (1234, 980))

    def test_image_overlay_and_decoder_error_fall_back_to_lazy_high_resolution_pdf(self):
        try:
            from pdfplumber.page import Page
        except ImportError:
            self.skipTest("pdfplumber required for fixture")
        for overlay in [False, True]:
            with self.subTest(overlay=overlay), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                pdf, fusion = self.fixture(root, overlay=overlay, second_page=True)
                from contextlib import nullcontext
                decoder = nullcontext() if overlay else patch("services.parser_service.exporter.extract_figure_image", side_effect=OSError("unsupported decoder"))
                with decoder, patch("pdfplumber.page.Page.to_image", autospec=True, side_effect=Page.to_image) as render:
                    export_document(pdf, fusion, root / "output")
                host = json.loads((root / "output/document.json").read_text())["pages"][0]["elements"][7]
                provenance = host["asset_provenance"]
                self.assertEqual(provenance["kind"], "pdf-render")
                self.assertTrue(provenance["antialias"])
                self.assertGreaterEqual(provenance["render_dpi"], 288)
                self.assertLessEqual(provenance["render_dpi"], 384)
                self.assertLessEqual(provenance["intrinsic_pixels"][0] * provenance["intrinsic_pixels"][1], 24_000_000)
                self.assertEqual([call.kwargs["resolution"] for call in render.call_args_list], [144., provenance["render_dpi"], 144.])

    def test_snapped_source_image_cannot_expand_into_unrelated_text(self):
        blocks = self.blocks()
        blocks.append({"label": "text", "content": "A real margin note", "source_bbox_normalized": [.184, .2, .189, .3]})
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pdf, fusion = self.fixture(root, blocks=blocks)
            with patch("services.parser_service.exporter.embedded_figure", return_value=({}, [.183, .09, .807, .58])), patch("services.parser_service.exporter.extract_figure_image") as decode:
                export_document(pdf, fusion, root / "output")
            self.assertFalse(decode.called)
            records = json.loads((root / "output/document.json").read_text())["pages"][0]["elements"]
            self.assertEqual(records[7]["render_bbox"], [.19, .09, .807, .58])
            self.assertEqual(records[-1]["text"], "A real margin note")

    def test_inverted_native_image_uses_pdf_renderer_to_preserve_direction(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pdf, fusion = self.fixture(root, flipped=True)
            export_document(pdf, fusion, root / "output")
            host = json.loads((root / "output/document.json").read_text())["pages"][0]["elements"][7]
            self.assertEqual(host["asset_provenance"]["kind"], "pdf-render")


class ExportTests(unittest.TestCase):
    def test_source_crops_explicitly_enable_antialias_and_keep_gray_edges(self):
        try:
            from reportlab.pdfgen.canvas import Canvas
            from pdfplumber.page import Page
            from PIL import Image
        except ImportError:
            self.skipTest("reportlab/pdfplumber/Pillow required for raster fixture")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pdf = root / "source.pdf"
            canvas = Canvas(str(pdf), pagesize=(400, 400))
            canvas.setFont("Helvetica", 9)
            canvas.drawString(40, 340, "Thin mathematical glyphs x + y")
            canvas.setLineWidth(.4)
            canvas.line(40, 180, 300, 300)
            canvas.save()
            fusion = root / "fusion"
            fusion.mkdir()
            (fusion / "document.json").write_text(json.dumps({"pages": [{"blocks": [{"label": "formula", "content": r"$$\unsupported{x}$$", "source_bbox_normalized": [.05, .05, .95, .7], "math_audit": {"source_crop_required": True}}]}]}))
            with patch("pdfplumber.page.Page.to_image", autospec=True, side_effect=Page.to_image) as render:
                export_document(pdf, fusion, root / "output")
            self.assertEqual(render.call_count, 2)
            self.assertTrue(all(call.kwargs.get("antialias") for call in render.call_args_list))
            self.assertGreaterEqual(render.call_args.kwargs["resolution"], 288)
            crop = next((root / "output/assets/images").glob("*.png"))
            with Image.open(crop) as image:
                self.assertTrue(any(image.convert("L").histogram()[1:255]), "Black-on-white vector glyphs must retain antialiased gray edge pixels.")

    def test_selectable_prose_scripts_currency_and_local_formula_share_dom_offsets(self):
        try:
            from reportlab.pdfgen.canvas import Canvas
        except ImportError:
            self.skipTest("reportlab required for fixture")
        from services.parser_service.exporter import text_content
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pdf = root / "source.pdf"
            canvas = Canvas(str(pdf), pagesize=(400, 400))
            canvas.drawString(40, 340, "Visible prose 12 costs $200 and formula x after.")
            canvas.save()
            content = r"Visible prose $^{12}.$ costs \$200 and formula $x$ after; bare \pm stays review."
            spans = []
            for candidate, mode, extra in [
                ("$^{12}.$", "native-script", {"selectable_segments": [{"text": "12", "script_kind": "sup"}, {"text": "."}], "semantic_kind": "citation-marker"}),
                ("$x$", "source-crop", {"fallback_bbox": [.6, .12, .64, .15], "height_em": 1.1, "baseline_offset_em": .2}),
                (r"\pm", "candidate-unresolved", {"selectable_text": "±", "source_syntax": "bare-tex"}),
            ]:
                start = content.index(candidate)
                spans.append({"start": start, "end": start + len(candidate), "candidate_content": candidate, "render_mode": mode, **extra})
            fusion = root / "fusion"
            fusion.mkdir()
            (fusion / "document.json").write_text(json.dumps({"schema": "guzi-fusion-auto-v3", "pages": [{"blocks": [{"label": "text", "content": content, "bbox_2d": [100, 100, 900, 300], "math_audit": {"status": "unresolved", "inline": spans}}]}]}))
            export_document(pdf, fusion, root / "out")
            record = json.loads((root / "out/document.json").read_text())["pages"][0]["elements"][0]
            expected = "Visible prose 12. costs $200 and formula [公式原图] after; bare ± stays review."
            self.assertEqual(json.loads((root / "out/manifest.json").read_text())["engine"]["name"], "guzi-fusion-auto-v3")
            self.assertEqual(json.loads((root / "out/document-ir.json").read_text())["backend"], "guzi-fusion-auto-v3")
            self.assertEqual(record["text"], expected)
            self.assertEqual(text_content(record["html"]), expected)
            self.assertIn("<sup>12</sup>.", record["html"])
            self.assertEqual(record["html"].count("<img"), 1)
            self.assertIn('height:1.1em;vertical-align:-0.2em', record["html"])
            self.assertIn('aria-hidden="true"', record["html"])
            self.assertIn('alt="公式原图，识别待核"', record["html"])
            self.assertNotIn("source-block-crop", record["html"])
            self.assertNotIn("data-translation-excluded", record["html"])
            self.assertNotIn(r"\pm", record["html"])
            self.assertEqual(record["math_audit"]["status"], "unresolved")
            self.assertEqual(len(list((root / "out/assets/images").iterdir())), 1)


    def test_unsupported_prose_stays_selectable_while_complex_table_uses_source(self):
        try:
            from reportlab.pdfgen.canvas import Canvas
        except ImportError:
            self.skipTest("reportlab required for fixture")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pdf = root / "source.pdf"
            canvas = Canvas(str(pdf), pagesize=(400, 400))
            canvas.drawString(40, 340, "Exact source content")
            canvas.save()
            fusion = root / "fusion"
            fusion.mkdir()
            original = "Before $x$ and $y$ after"
            blocks = [
                {"label": "aside_text", "content": "001 002 003", "bbox_2d": [0, 0, 50, 500]},
                {"label": "text", "content": original, "bbox_2d": [100, 100, 900, 300], "math_audit": {"status": "unresolved", "source_block_required": True, "fallback_bbox": [.1, .1, .9, .3], "inline": [{"start": None, "source_crop_required": True}, {"start": None, "source_crop_required": True}]}},
                {"label": "table", "content": "<table><tr><td>Candidate only</td></tr></table>", "bbox_2d": [100, 350, 900, 550], "native_evidence": {"status": "unsupported", "rotated_glyphs": 20}},
                {"label": "formula", "content": r"$$\unknownmacro{x}$$", "bbox_2d": [100, 600, 900, 700], "math_audit": {"status": "confirmed"}},
            ]
            (fusion / "document.json").write_text(json.dumps({"pages": [{"blocks": blocks}]}))
            with patch("services.parser_service.exporter.render_math", return_value=""):
                export_document(pdf, fusion, root / "output")
            records = json.loads((root / "output/document.json").read_text())["pages"][0]["elements"]
            markup = (root / "output/document.html").read_text()
            self.assertNotIn("001 002 003", markup)
            self.assertEqual(records[0]["source_content"], "001 002 003")
            self.assertEqual(records[0]["render_mode"], "suppressed-margin")
            self.assertEqual(records[1]["source_content"], original)
            self.assertEqual(records[1]["html"].count("<img"), 0)
            self.assertIn("Before ", records[1]["text"])
            self.assertIn(" after", records[1]["text"])
            self.assertFalse(records[1]["math_audit"]["source_block_required"])
            self.assertNotIn("math-source-inline", records[1]["html"])
            self.assertNotIn("<table", records[2]["html"])
            self.assertIsNone(records[2]["table_html"])
            self.assertIn("<table", records[2]["candidate_content"])
            self.assertEqual(records[2]["render_mode"], "source-block-crop")
            self.assertEqual(records[3]["math_audit"]["status"], "unresolved")
            self.assertEqual(records[3]["render_mode"], "source-crop")
            self.assertEqual(len(list((root / "output/assets/images").iterdir())), 2)

    def test_reader_package_and_fallback(self):
        try:
            from reportlab.pdfgen.canvas import Canvas
        except ImportError:
            self.skipTest('reportlab required for fixture')
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pdf = root / 'input.pdf'
            canvas = Canvas(str(pdf), pagesize=(400, 400))
            canvas.drawString(40, 340, 'Native maths x + y = z')
            canvas.save()
            fusion = root / 'fusion'
            fusion.mkdir()
            blocks = [
                {'label': 'text', 'bbox_2d': [100, 100, 900, 200], 'content': '# Heading'},
                {'label': 'text', 'bbox_2d': [100, 220, 900, 300], 'content': '***Both*** <u>under</u>', 'style_spans': [{'styles':['bold','italic']}]},
                {'label': 'table', 'bbox_2d': [100, 310, 900, 500], 'content': '<table><tr><td><strong><em>A</em></strong></td><td><u>B</u></td><td>$x$</td></tr></table>', 'math_audit': {'inline':[{'start':64,'end':67,'candidate_content':'$x$','source_crop_required':True,'fallback_bbox':[.1,.1,.5,.2]}]}},
                {'label': 'formula', 'bbox_2d': [100, 510, 900, 600], 'content': '$$wrong$$', 'math_audit': {'status':'unresolved','source_crop_required':True,'fallback_bbox':[.1,.1,.9,.2]}},
                {'label': 'text', 'bbox_2d': [100, 610, 900, 700], 'content': 'before $x$ after', 'math_audit': {'inline':[{'start':7,'end':10,'source_crop_required':True,'fallback_bbox':[.1,.1,.5,.2]}]}},
                {'label': 'text', 'bbox_2d': [100, 720, 900, 800], 'content': '## Title $x$ tail', 'math_audit': {'inline':[{'start':9,'end':12,'source_crop_required':True,'fallback_bbox':[.1,.1,.5,.2]}]}},
            ]
            table_content = blocks[2]['content']
            table_start = table_content.index('$x$')
            blocks[2]['math_audit']['inline'][0].update(start=table_start, end=table_start+3)
            (fusion/'document.json').write_text(json.dumps({'schema':'guzi-fusion-auto-v2','pages':[{'physical_page':1,'blocks':blocks}]}))
            export_document(pdf, fusion, root/'out', 'Paper.pdf', 'job1')
            export_document(pdf, fusion, root/'out2', 'Paper.pdf', 'job2')
            first = json.loads((root/'out/document.json').read_text())
            second = json.loads((root/'out2/document.json').read_text())
            records = first['pages'][0]['elements']
            self.assertEqual([r['block_id'] for r in records], [r['block_id'] for r in second['pages'][0]['elements']])
            self.assertEqual(first['pages'][0]['blocks'], records)
            markup = (root/'out/document.html').read_text()
            self.assertIn('class="reader-content"', markup)
            self.assertIn('<h1', markup)
            self.assertIn('<strong><em>Both</em></strong>', markup)
            self.assertIn('<u>B</u>', markup)
            self.assertNotIn('wrong', markup)
            self.assertNotIn('GUZIMATHCROP', markup)
            self.assertIn('<h2', records[-1]['html'])
            self.assertIn('class="math-source-inline"', records[-1]['html'])
            self.assertNotIn('GUZIMATHCROP', json.dumps(records))
            self.assertIn('before ', markup)
            self.assertIn(' after', markup)
            self.assertNotIn('$x$', records[-2]['content'])
            self.assertIn('![原 PDF 数学区域]', records[-2]['content'])
            ir = json.loads((root/'out/document-ir.json').read_text())
            self.assertEqual(ir['pages'][0]['elements'][3]['content'], records[3]['content'])
            self.assertNotIn('$$wrong$$', (root/'out/document.md').read_text())
            self.assertIn('<td><img src="assets/images/', records[2]['content'])
            manifest = json.loads((root/'out/manifest.json').read_text())
            self.assertEqual(manifest['source']['sha256'], hashlib.sha256(pdf.read_bytes()).hexdigest())
            self.assertEqual(manifest['validation']['status'],'REVIEW')
            zip_result(root/'out', root/'out.zip')
            with zipfile.ZipFile(root/'out.zip') as archive:
                self.assertTrue({'manifest.json','document.html','document.json','document-ir.json','validation.json','source.pdf'} <= set(archive.namelist()))
                self.assertTrue(all(not name.startswith('/') and '..' not in Path(name).parts for name in archive.namelist()))


if __name__ == '__main__':
    unittest.main()
