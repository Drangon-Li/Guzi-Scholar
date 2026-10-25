import unittest

from services.parser_service.table_evidence import assess_table_evidence, ocr_table_candidate


def table(rows):
    return '<table>' + ''.join('<tr>' + ''.join('<td>' + cell + '</td>' for cell in row) + '</tr>' for row in rows) + '</table>'


class TableEvidenceTests(unittest.TestCase):
    def test_two_scanned_tables_agree_but_remain_ocr_only_review(self):
        content = table([['Voltage', '220.4 V'], ['Samples', '128']])
        audit = assess_table_evidence(content, content, native_available=False)
        self.assertTrue(audit['allow_ocr_candidate'])
        self.assertEqual(audit['ocr_agreement'], 'exact')
        self.assertEqual(audit['status'], 'unresolved')
        self.assertFalse(audit['native_confirmed'])
        self.assertTrue(audit['source_comparison_required'])
        self.assertIn('ocr_only_table_requires_source_review', audit['review_reasons'])

    def test_single_scan_candidate_is_selectable_without_claiming_agreement(self):
        audit = assess_table_evidence(table([['Voltage', '220.4 V']]), native_available=False)
        self.assertTrue(audit['allow_ocr_candidate'])
        self.assertEqual(audit['ocr_agreement'], 'unavailable')

    def test_numeric_disagreement_keeps_primary_and_both_cell_values(self):
        audit = assess_table_evidence(table([['Voltage', '220.4']]), table([['Voltage', '220.9']]), native_available=False)
        self.assertTrue(audit['allow_ocr_candidate'])
        self.assertEqual(audit['ocr_agreement'], 'different')
        self.assertEqual(audit['differences'], [{'row': 0, 'column': 1, 'primary': '220.4', 'secondary': '220.9'}])
        self.assertIn('220.4', audit['candidate_html'])
        self.assertNotIn('220.9', audit['candidate_html'])
        self.assertEqual(audit['sources']['secondary']['cells'][1]['text'], '220.9')

    def test_no_native_override_when_native_geometry_available(self):
        content = table([['Voltage', '220.4']])
        audit = assess_table_evidence(content, content, native_available=True)
        self.assertFalse(audit['allow_ocr_candidate'])
        self.assertTrue(audit['structured_candidate_available'])
        self.assertIsNone(ocr_table_candidate({'table_evidence': audit}))

    def test_structure_issue_keeps_existing_fallback(self):
        audit = assess_table_evidence(table([['x', '1']]), native_available=False, structure_issues=['table_grid_invalid'])
        self.assertFalse(audit['allow_ocr_candidate'])

    def test_malformed_unsafe_or_out_of_bounds_tables_are_rejected(self):
        values = [
            '<table><tr><td>1</tr></table>',
            '<table><tr><td>1',
            '<table><tr><td rowspan="0">1</td></tr></table>',
            '<table><tr><td rowspan="-1">1</td></tr></table>',
            '<table><tr><td rowspan="2">1</td></tr></table>',
            '<table><tr><td colspan="99999999">1</td></tr></table>',
            '<table><tr><td colspan="257">1</td></tr></table>',
            '<table><tr><td colspan="no">1</td></tr></table>',
            '<table><tr><td><table><tr><td>1</td></tr></table></td></tr></table>',
            '<table><tr><td>1<script><script>bad</script></script></td></tr></table>',
            '<table><tr><td>1<iframe>bad</iframe></td></tr></table>',
            '<table><tr><td>1</td><td>2</td></tr><tr><td>3</td></tr></table>',
            '<table><tr><td>A</td><td rowspan="2">B</td></tr><tr><td colspan="2">C</td></tr></table>',
            '<table><tr><td><tbody><tr><td>1</td></tr></tbody></td></tr></table>',
            '<table><span>22</span><tr><td>0.4</td></tr></table>',
        ]
        for content in values:
            with self.subTest(content=content):
                audit = assess_table_evidence(content, content, native_available=False)
                self.assertFalse(audit['allow_ocr_candidate'])
                self.assertFalse(audit['structured_candidate_available'])

    def test_valid_rowspan_and_colspan_grid_is_preserved(self):
        content = '<table><tr><td rowspan="2">Group</td><td colspan="2">Title</td></tr><tr><td>220.4</td><td>128</td></tr></table>'
        audit = assess_table_evidence(content, content, native_available=False)
        self.assertTrue(audit['allow_ocr_candidate'])
        self.assertEqual(audit['sources']['primary']['columns'], 3)
        self.assertIn('rowspan="2"', audit['candidate_html'])

    def test_deeply_nested_cell_markup_is_rejected_without_aborting_evidence(self):
        content = table([['<span>' * 500 + '23.7' + '</span>' * 500]])
        audit = assess_table_evidence(content, native_available=False)
        self.assertFalse(audit['allow_ocr_candidate'])
        self.assertFalse(audit['structured_candidate_available'])
        self.assertIsNone(audit['candidate_html'])
        self.assertEqual(audit['sources']['primary']['reason'], 'table_markup_depth_exceeded')
        self.assertEqual(audit['unit_image_audit'], [])
        block = {'table_evidence': dict(audit, allow_ocr_candidate=True, candidate_html=content)}
        self.assertIsNone(ocr_table_candidate(block))

    def test_bounded_nested_cell_markup_keeps_text_and_script_distinctions(self):
        content = table([['<span>' * 20 + 'x<sup>2</sup><br>23.7' + '</span>' * 20]])
        audit = assess_table_evidence(content, native_available=False)
        self.assertTrue(audit['allow_ocr_candidate'])
        self.assertEqual(audit['sources']['primary']['cells'][0]['text'], 'x<sup>2</sup> 23.7')

    def test_markdown_scan_table_can_supply_independent_evidence(self):
        audit = assess_table_evidence(table([['Item', 'Reading'], ['Voltage', '220.4']]), '| Item | Reading |\n| --- | --- |\n| Voltage | 220.4 |', native_available=False)
        self.assertEqual(audit['ocr_agreement'], 'exact')

    def test_secondary_failure_does_not_destroy_valid_primary(self):
        audit = assess_table_evidence(table([['Voltage', '220.4']]), '<table>broken</table>', native_available=False)
        self.assertTrue(audit['allow_ocr_candidate'])
        self.assertEqual(audit['ocr_agreement'], 'unavailable')
        self.assertFalse(audit['sources']['secondary']['valid'])

    def test_numbers_scripts_and_cell_boundaries_are_not_collapsed_for_agreement(self):
        pairs = [('220.4', '220.40'), ('2 20.4', '220.4'), ('2<br>20.4', '220.4'), ('<p>2</p><p>20.4</p>', '220.4'), ('x<sup>2</sup>', 'x<sub>2</sub>'), ('①', '1'), ('−1', '-1')]
        for primary, secondary in pairs:
            with self.subTest(primary=primary, secondary=secondary):
                audit = assess_table_evidence(table([[primary]]), table([[secondary]]), native_available=False)
                self.assertEqual(audit['ocr_agreement'], 'different')
        audit = assess_table_evidence(table([['22', '0.4']]), table([['220.4']]), native_available=False)
        self.assertEqual(audit['ocr_agreement'], 'different')
        self.assertIn('ocr_table_structure_disagreement', audit['review_reasons'])

    def test_sanitizes_attributes_and_revalidates_persisted_candidates(self):
        content = '<table onclick="bad()"><tr><td style="color:red" onmouseover="bad()">220.4</td></tr></table>'
        audit = assess_table_evidence(content, native_available=False)
        block = {'table_evidence': audit, 'native_evidence': {'native_available': False, 'status': 'unsupported'}}
        self.assertEqual(ocr_table_candidate(block), table([['220.4']]))
        self.assertNotIn('bad', audit['candidate_html'])
        block['native_evidence']['native_available'] = True
        self.assertIsNone(ocr_table_candidate(block))
        block['native_evidence']['native_available'] = False
        audit['candidate_html'] = '<table><tr><td><script>bad</script></td></tr></table>'
        self.assertIsNone(ocr_table_candidate(block))


if __name__ == '__main__':
    unittest.main()
