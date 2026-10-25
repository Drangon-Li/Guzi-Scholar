from pathlib import Path
import json
import unittest
from unittest import mock

from PIL import Image, ImageDraw, ImageFont
import reportlab
import pypdfium2 as pdfium

from services.parser_service.table_evidence import assess_table_evidence
from services.parser_service import scan_unit_evidence


SCAN_FIXTURE = Path(__file__).resolve().parents[1] / 'data/deployment/quality-fix-20261025/raw/5d7945684b5e4150bc68e4ff7a39ad68'


def table(reading='23.7℃', limit='18.0-28.0℃'):
    return '<table><tr><td>Item</td><td>Reading</td><td>Limit</td></tr><tr><td>Temperature</td><td>' + reading + '</td><td>' + limit + '</td></tr></table>'


class ScanUnitEvidenceTests(unittest.TestCase):
    def source(self, reading='23.7 C', limit='18.0-28.0 C', font_size=30):
        image = Image.new('RGB', (800, 240), 'white')
        draw = ImageDraw.Draw(image)
        font = ImageFont.truetype(str(Path(reportlab.__file__).parent / 'fonts' / 'Vera.ttf'), font_size)
        for x in (20, 210, 480, 780):
            draw.line((x, 20, x, 220), fill=(170, 170, 170), width=2)
        for y in (20, 100, 220):
            draw.line((20, y, 780, y), fill=(170, 170, 170), width=2)
        draw.text((240, 140), reading, font=font, fill='black', anchor='lt')
        draw.text((510, 140), limit, font=font, fill='black', anchor='lt')
        return image, font

    def assess(self, image, primary=None, secondary=None):
        return assess_table_evidence(primary or table(), secondary or table('23.7 C', '18.0-28.0 C'), native_available=False, page_image=image, table_bbox=[20 / 800, 20 / 240, 780 / 800, 220 / 240])

    def test_clear_c_uses_detected_nonuniform_grid_and_preserves_original_evidence(self):
        image, _ = self.source()
        audit = self.assess(image)
        self.assertEqual([a['after'] for a in audit['unit_image_audit']], ['23.7 C', '18.0-28.0 C'])
        self.assertTrue(all(a['status'] == 'selected' for a in audit['unit_image_audit']))
        self.assertIn('<td>23.7 C</td>', audit['candidate_html'])
        self.assertIn('<td>18.0-28.0 C</td>', audit['candidate_html'])
        self.assertEqual(audit['sources']['primary']['cells'][4]['text'], '23.7℃')
        self.assertEqual(audit['sources']['secondary']['cells'][4]['text'], '23.7 C')
        self.assertEqual(audit['ocr_agreement'], 'different')
        self.assertEqual(audit['status'], 'unresolved')
        self.assertFalse(audit['native_confirmed'])
        cell = audit['unit_image_audit'][0]
        self.assertGreater(cell['cell_bbox_pixels'][0], 210)
        self.assertLess(cell['cell_bbox_pixels'][2], 480)
        self.assertGreaterEqual(cell['quality']['numeric_height_pixels'], 18)
        self.assertEqual(len(cell['quality']['cell_sha256']), 64)

    @unittest.skipUnless((SCAN_FIXTURE / 'source.pdf').is_file(), 'optional local scan fixture is unavailable')
    def test_original_scan_antialiased_c_is_not_mistaken_for_a_degree_or_noise(self):
        glm = json.loads((SCAN_FIXTURE / 'glm/output/source/source.json').read_text())[0]
        mineru = json.loads((SCAN_FIXTURE / 'mineru/extracted/structured_content.json').read_text())['pages'][0]['blocks']
        primary = next(block for block in glm if block.get('label') == 'table')
        secondary = next(block for block in mineru if block.get('type') == 'table')
        with pdfium.PdfDocument(SCAN_FIXTURE / 'source.pdf') as document:
            page = document[0]
            bitmap = page.render(scale=200 / 72)
            image = bitmap.to_pil()
            try:
                audit = assess_table_evidence(primary['content'], secondary['content'], native_available=False, page_image=image, table_bbox=[value / 1000 for value in primary['bbox_2d']])
            finally:
                image.close()
                bitmap.close()
                page.close()
        self.assertEqual([(a['status'], a['before'], a['after']) for a in audit['unit_image_audit']], [('selected', '23.7℃', '23.7 C'), ('selected', '18.0-28.0℃', '18.0-28.0 C')])
        self.assertIn('23.7℃', audit['sources']['primary']['html'])
        self.assertIn('23.7 C', audit['candidate_html'])
        self.assertIn('18.0-28.0 C', audit['candidate_html'])
        self.assertEqual(audit['status'], 'unresolved')

    def test_degree_ring_preserves_real_celsius_and_can_select_degree_candidate(self):
        image, _ = self.source('23.7 °C', '18.0-28.0 °C')
        for primary, secondary in [(table(), table('23.7 C', '18.0-28.0 C')), (table('23.7 C', '18.0-28.0 C'), table('23.7°C', '18.0-28.0°C'))]:
            with self.subTest(primary=primary):
                audit = self.assess(image, primary, secondary)
                self.assertTrue(all(a['status'] == 'selected' for a in audit['unit_image_audit']))
                self.assertTrue(all(a['selected_unit_shape'] == 'degree-C' for a in audit['unit_image_audit']))
                self.assertTrue(all('℃' in a['after'] or '°C' in a['after'] for a in audit['unit_image_audit']))

    def test_faint_degree_even_one_gray_level_from_white_blocks_plain_c(self):
        for color in (180, 240, 254):
            with self.subTest(color=color):
                image, font = self.source()
                draw = ImageDraw.Draw(image)
                c_origin = round(240 + font.getlength('23.7 '))
                draw.ellipse((c_origin - 9, 138, c_origin - 3, 144), outline=(color, color, color), width=1)
                audit = self.assess(image)
                cell = audit['unit_image_audit'][0]
                self.assertEqual(cell['status'], 'unresolved')
                self.assertEqual(cell['before'], cell['after'])
                self.assertIn('23.7℃', audit['candidate_html'])
                self.assertEqual(cell['reason'], 'faint_or_unexplained_ink')

    def test_faint_circle_connected_to_c_does_not_disappear_at_dark_threshold(self):
        image, font = self.source()
        draw = ImageDraw.Draw(image)
        c_origin = round(240 + font.getlength('23.7 '))
        draw.ellipse((c_origin - 5, 138, c_origin + 1, 144), outline=(254, 254, 254), width=1)
        draw.line((c_origin + 1, 144, c_origin + 3, 147), fill=(254, 254, 254), width=1)
        audit = self.assess(image)
        self.assertEqual(audit['unit_image_audit'][0]['status'], 'unresolved')
        self.assertIn('23.7℃', audit['candidate_html'])

    def test_noise_or_missing_numeric_components_never_selects_plain_c(self):
        for reading in ('237 C', '23. C', '23.7 G', '23.7 C.'):
            with self.subTest(reading=reading):
                image, _ = self.source(reading)
                audit = self.assess(image)
                self.assertEqual(audit['unit_image_audit'][0]['status'], 'unresolved')
                self.assertEqual(audit['unit_image_audit'][0]['after'], '23.7℃')
        image, _ = self.source()
        ImageDraw.Draw(image).point((430, 130), fill='black')
        audit = self.assess(image)
        self.assertEqual(audit['unit_image_audit'][0]['status'], 'unresolved')
        image, _ = self.source(limit='18.028.0 C')
        self.assertEqual(self.assess(image)['unit_image_audit'][1]['status'], 'unresolved')

    def test_dense_strong_noise_is_rejected_before_weak_component_extraction(self):
        image = Image.new('L', (360, 360), 'white')
        draw = ImageDraw.Draw(image)
        draw.rectangle((20, 20, 340, 340), outline=0)
        for x in range(30, 330, 3):
            for y in range(30, 330, 3):
                draw.point((x, y), fill=0)
        primary = '<table><tr><td>23.7℃</td></tr></table>'
        with mock.patch.object(scan_unit_evidence, '_components', wraps=scan_unit_evidence._components) as components:
            audit = assess_table_evidence(primary, primary.replace('℃', ' C'), native_available=False, page_image=image, table_bbox=[20 / 360, 20 / 360, 340 / 360, 340 / 360])
        cell = audit['unit_image_audit'][0]
        self.assertEqual(cell['status'], 'unresolved')
        self.assertEqual(cell['reason'], 'numeric_or_unit_component_count_mismatch')
        self.assertEqual(cell['quality']['strong_components'], 10000)
        self.assertEqual([call.args[1] for call in components.call_args_list], [150])
        self.assertEqual(audit['candidate_html'], primary)

    def test_excess_faint_noise_is_rejected_before_matching_pixel_sets(self):
        image, _ = self.source()
        cell_image = image.crop((214, 104, 476, 216)).convert('L')
        draw = ImageDraw.Draw(cell_image)
        for x in range(8, 240, 3):
            for y in range(8, 25, 3):
                draw.point((x, y), fill=254)

        class UnmatchedPixels(set):
            def __iter__(self):
                raise AssertionError('excess components must be rejected before pixel matching')

            def __and__(self, other):
                raise AssertionError('excess components must be rejected before pixel matching')

        extract_components = scan_unit_evidence._components

        def guarded_components(image, threshold):
            components = extract_components(image, threshold)
            for component in components:
                component['pixels'] = UnmatchedPixels(component['pixels'])
            return components

        quality = {}
        with mock.patch.object(scan_unit_evidence, '_components', side_effect=guarded_components):
            with self.assertRaisesRegex(ValueError, '^faint_or_unexplained_ink$'):
                scan_unit_evidence._cell_unit(cell_image, '23.7', quality)
        self.assertEqual(quality['strong_components'], 5)
        self.assertGreater(quality['weak_components'], 400)

    def test_low_resolution_and_unit_on_cell_edge_are_unresolved(self):
        image, _ = self.source(font_size=16)
        audit = self.assess(image)
        self.assertTrue(all(a['status'] == 'unresolved' for a in audit['unit_image_audit']))
        image, font = self.source()
        draw = ImageDraw.Draw(image)
        draw.rectangle((220, 125, 475, 180), fill='white')
        reading = '23.7 C'
        x = 479 - font.getbbox(reading)[2]
        draw.text((x, 140), reading, font=font, fill='black', anchor='lt')
        audit = self.assess(image)
        self.assertEqual(audit['unit_image_audit'][0]['status'], 'unresolved')
        self.assertEqual(audit['unit_image_audit'][0]['reason'], 'glyph_touches_cell_boundary')

    def test_broken_missing_or_ambiguous_grid_rejects_pixel_selection(self):
        for kind in ('broken', 'missing', 'extra'):
            with self.subTest(kind=kind):
                image, _ = self.source()
                draw = ImageDraw.Draw(image)
                if kind == 'broken':
                    draw.rectangle((100, 19, 120, 22), fill='white')
                elif kind == 'missing':
                    draw.rectangle((479, 23, 482, 217), fill='white')
                else:
                    draw.line((700, 20, 700, 220), fill=(170, 170, 170), width=2)
                audit = self.assess(image)
                self.assertTrue(all(a['status'] == 'unresolved' for a in audit['unit_image_audit']))
                self.assertEqual(audit['candidate_html'], table())

    def test_numeric_precision_value_or_unknown_unit_disagreements_do_not_trigger(self):
        image, _ = self.source()
        for primary, secondary in [('23.70℃', '23.7 C'), ('23.7℃', '23.9 C'), ('23.7℃', '23.7 F'), ('23.7x℃', '23.7xC')]:
            with self.subTest(primary=primary, secondary=secondary):
                audit = self.assess(image, table(primary, 'same'), table(secondary, 'same'))
                self.assertFalse(audit['needs_unit_image'])
                self.assertEqual(audit['unit_image_audit'], [])
                self.assertIn(primary, audit['candidate_html'])

    def test_both_ocr_omit_degree_never_claims_pixel_selection_or_native_confirmation(self):
        image, _ = self.source('23.7 °C', '18.0-28.0 °C')
        content = table('23.7 C', '18.0-28.0 C')
        audit = self.assess(image, content, content)
        self.assertEqual(audit['unit_image_audit'], [])
        self.assertFalse(audit['needs_unit_image'])
        self.assertEqual(audit['status'], 'unresolved')
        self.assertFalse(audit['native_confirmed'])

    def test_image_requested_only_for_dispute_and_never_for_merged_or_native_table(self):
        audit = self.assess(None)
        self.assertTrue(audit['needs_unit_image'])
        self.assertTrue(all(a['reason'] == 'unit_image_unavailable' for a in audit['unit_image_audit']))
        primary = '<table><tr><td colspan="2">23.7℃</td></tr></table>'
        secondary = primary.replace('23.7℃', '23.7 C')
        audit = self.assess(None, primary, secondary)
        self.assertFalse(audit['needs_unit_image'])
        self.assertEqual(audit['unit_image_audit'][0]['reason'], 'merged_cells_not_supported')
        image, _ = self.source()
        audit = assess_table_evidence(table(), table('23.7 C', '18.0-28.0 C'), native_available=True, page_image=image, table_bbox=[.1, .1, .9, .9])
        self.assertFalse(audit['allow_ocr_candidate'])
        self.assertNotIn('unit_image_audit', audit)

    def test_invalid_geometry_or_pixel_budget_is_reported_without_changing_candidates(self):
        image, _ = self.source()
        for bbox in (None, [0, 0, 1, 0], [0, 0, float('nan'), 1], [0, 0, 1, 1]):
            with self.subTest(bbox=bbox):
                audit = assess_table_evidence(table(), table('23.7 C', '18.0-28.0 C'), native_available=False, page_image=image, table_bbox=bbox)
                self.assertTrue(all(a['status'] == 'unresolved' for a in audit['unit_image_audit']))
                self.assertEqual(audit['candidate_html'], table())
        image = Image.new('L', (3000, 3000), 'white')
        audit = self.assess(image)
        self.assertEqual(audit['unit_image_audit'][0]['reason'], 'page_pixel_budget_exceeded')


if __name__ == '__main__':
    unittest.main()
