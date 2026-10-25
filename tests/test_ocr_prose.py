import unittest

from services.parser_service.ocr_prose import reconcile_ocr_prose


class OCRProseTest(unittest.TestCase):
    def test_real_scanned_report_punctuation_and_paragraphs(self):
        primary = '四项检查全部通过。温度为 23.7 C，湿度为 46.2% ，样本数量为128 All four checks passed.The fixed OCR anchor is "Scanned report ready".'
        secondary = ['四项检查全部通过。温度为 23.7 C，湿度为 46.2%，样本数量为 128。', 'All four checks passed. The fixed OCR anchor is "Scanned report ready".']
        result, audit = reconcile_ocr_prose(primary, secondary)
        self.assertEqual(result, '\n\n'.join(secondary))
        self.assertTrue(audit['accepted'])
        self.assertTrue(audit['changed'])
        self.assertEqual(audit['evidence_basis'], 'ocr-agreement')
        self.assertNotEqual(audit['status'], 'confirmed')
        self.assertFalse(audit['native_confirmed'])
        self.assertEqual(audit['before'], primary)
        self.assertEqual(audit['after'], result)

    def test_changed_numeric_values_symbols_case_and_words_are_rejected(self):
        for primary, secondary in [('Value 23.7.', 'Value 23.8.'), ('x is ready.', 'X is ready.'), ('Gain +2.', 'Gain -2.'), ('A good result.', 'A bad result.'), ('Cost 1,280.', 'Cost 1280.'), ('Value 23.7.', 'Value 237.'), ('Value .5.', 'Value 5.')]:
            with self.subTest(primary=primary, secondary=secondary):
                result, audit = reconcile_ocr_prose(primary, [secondary])
                self.assertEqual(result, primary)
                self.assertFalse(audit['accepted'])
                self.assertEqual(audit['reason'], 'ocr_prose_protected_content_disagreement')

    def test_latin_word_joining_or_splitting_is_rejected(self):
        for primary, secondary in [('Take a part.', 'Take apart.'), ('Take apart.', 'Take a part.'), ('The word passedThe test.', 'The word passed. The test.'), ('A part.', 'A pa.rt.')]:
            with self.subTest(primary=primary, secondary=secondary):
                result, audit = reconcile_ocr_prose(primary, [secondary])
                self.assertEqual(result, primary)
                self.assertFalse(audit['accepted'])

    def test_numeric_internal_spacing_is_not_repaired_by_ocr_vote(self):
        for primary, secondary in [('Value 23. 7 is ready.', 'Value 23.7 is ready.'), ('Value 128 is ready.', 'Value 12。8 is ready.')]:
            result, audit = reconcile_ocr_prose(primary, [secondary])
            self.assertEqual(result, primary)
            self.assertEqual(audit['reason'], 'ocr_prose_numeric_spacing_disagreement')

    def test_math_and_html_are_kept_exactly(self):
        for primary in ['Use $x_i$ now.', 'Use x<sub>i</sub> now.', r'Use \(x_i\) now.', 'Use **bold** now.']:
            result, audit = reconcile_ocr_prose(primary, [primary.replace('now.', 'now. Next.')])
            self.assertEqual(result, primary)
            self.assertEqual(audit['reason'], 'ocr_prose_markup_requires_preservation')

    def test_correct_english_word_spaces_are_not_normalized(self):
        primary = 'A  part is ready.'
        result, audit = reconcile_ocr_prose(primary, ['A part is ready.'])
        self.assertEqual(result, primary)
        self.assertTrue(audit['accepted'])
        self.assertFalse(audit['changed'])

    def test_empty_secondary_preserves_candidate(self):
        result, audit = reconcile_ocr_prose('Ready.', [])
        self.assertEqual(result, 'Ready.')
        self.assertFalse(audit['accepted'])


if __name__ == '__main__':
    unittest.main()
