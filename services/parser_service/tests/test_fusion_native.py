import unittest

from services.parser_service.fusion import aggregate_reference_duplicates, inline_block_audit, locate_inline_audits, normalize_currency_dollars, restore_inline_math, restore_styles, restore_table_math, table_script_audit
from services.parser_service.math_evidence import TexAtoms, assess_formula, math_candidates, readable_candidate, reconcile_equation_number
from services.parser_service.tests.test_native_pdf import glyph, page, line


class NativeFusionTest(unittest.TestCase):
    def test_real_nu_is_not_changed_to_latin_v(self):
        p = page([glyph('ν', 10), glyph('i', 15, baseline=52, size=7)])
        content, audit = assess_formula(r'\nu_i', None, p, [0, 0, 1, 1])
        self.assertEqual(content, r'\nu_i')
        self.assertEqual(audit['status'], 'confirmed')

    def test_shared_ocr_nu_error_uses_native_latin_glyph(self):
        p = page([glyph('𝑣', 10), glyph('i', 15, baseline=52, size=7)])
        content, audit = assess_formula(r'\nu_i', r'\nu_i', p, [0, 0, 1, 1])
        self.assertEqual(content, 'v_i')
        self.assertEqual(audit['selected_engine'], 'pdf_native_repair')

    def test_plain_s_wins_over_calligraphic_candidate(self):
        p = page([glyph('S', 10)])
        content, audit = assess_formula('S', r'\mathcal{S}', p, [0, 0, 1, 1])
        self.assertEqual(content, 'S')
        self.assertEqual(audit['status'], 'confirmed')

    def test_calligraphic_font_is_preserved(self):
        p = page([glyph('S', 10, font='ABCDEF+CMSY10')])
        content, audit = assess_formula('S', r'\mathcal{S}', p, [0, 0, 1, 1])
        self.assertEqual(content, r'\mathcal{S}')
        self.assertEqual(audit['status'], 'confirmed')

    def test_superscript_and_subscript_cannot_vote_by_character_bag(self):
        p = page([glyph('x', 10), glyph('2', 15, baseline=52, size=7)])
        content, audit = assess_formula('x^2', 'x_2', p, [0, 0, 1, 1])
        self.assertEqual(content, 'x_2')
        self.assertEqual(audit['status'], 'confirmed')

    def test_fraction_requires_a_native_rule_and_two_sides(self):
        p = page([glyph('a', 10, baseline=45, size=8), glyph('b', 10, baseline=55, size=8)], [line(10, 15, 47)])
        content, audit = assess_formula('ab', r'\frac{a}{b}', p, [0, 0, 1, 1])
        self.assertEqual(content, r'\frac{a}{b}')
        self.assertEqual(audit['status'], 'confirmed')
        plain = page([glyph('a', 10), glyph('b', 15)])
        content, audit = assess_formula(r'\frac{a}{b}', 'ab', plain, [0, 0, 1, 1])
        self.assertEqual(content, 'ab')
        self.assertEqual(audit['status'], 'confirmed')

    def test_extra_sim_symbol_is_rejected(self):
        chars = [glyph(c, 5 + i * 5) for i, c in enumerate('sim(x)')]
        p = page(chars)
        content, audit = assess_formula(r'\operatorname{sim}(x)', r'\sim\operatorname{sim}(x)', p, [0, 0, 1, 1])
        self.assertEqual(content, r'\operatorname{sim}(x)')
        self.assertEqual(audit['status'], 'confirmed')

    def test_unknown_cid_and_image_only_region_request_source_crop(self):
        for p in [page([]), page([glyph('(cid:11)', 10)])]:
            content, audit = assess_formula('x', None, p, [0, 0, 1, 1])
            self.assertEqual(content, 'x')
            self.assertTrue(audit['source_crop_required'])
            self.assertEqual(audit['status'], 'unsupported')

    def test_repeated_table_numbers_keep_individual_glyph_styles(self):
        p = page([glyph('1', 10, font='Bold'), glyph('1', 40)], fonts={'Bold': {'bold': True}})
        content, spans, _ = restore_styles('<table><tr><td>1</td><td>1</td></tr></table>', p, [0, 0, 1, 1], table=True)
        self.assertIn('<td><strong>1</strong></td><td>1</td>', content)
        self.assertEqual(spans[0]['source_glyph_ids'], [0])

    def test_bold_italic_combination_preserves_text(self):
        p = page([glyph('A', 10, font='BoldItalic'), glyph('B', 15, font='BoldItalic')], fonts={'BoldItalic': {'bold': True, 'italic': True}})
        content, _, _ = restore_styles('AB', p, [0, 0, 1, 1])
        self.assertEqual(content, '<strong><em>AB</em></strong>')

    def test_inline_offsets_reference_final_html_content(self):
        content = '<strong>Before</strong> $v_i$ then $v_i$'
        audits = [{'candidate_content': 'v_i'}, {'candidate_content': 'v_i'}]
        locate_inline_audits(content, audits)
        self.assertLess(audits[0]['start'], audits[1]['start'])
        for audit in audits:
            self.assertEqual(content[audit['start']:audit['end']], audit['candidate_content'])

    def test_spacing_before_operator_star_is_layout(self):
        atoms = TexAtoms(r'\operatorname * {t o p k}_{T}')
        self.assertEqual(''.join(a['text'] for a in atoms.atoms), 'topkT')

    def test_unknown_glyph_between_known_atoms_is_not_confirmed(self):
        p = page([glyph('x', 10), glyph('(cid:11)', 15), glyph('y', 20)])
        _, audit = assess_formula('xy', None, p, [0, 0, 1, 1])
        self.assertNotEqual(audit['status'], 'confirmed')

    def test_reference_aggregate_suppression_requires_content_and_geometry(self):
        blocks = [{'label': 'reference', 'content': '[1] A [2] B [3] C', 'bbox_2d': [0, 0, 1000, 1000]}]
        blocks += [{'label': 'text', 'content': f'[{i + 1}] {c}', 'bbox_2d': [0, i * 100, 1000, i * 100 + 80]} for i, c in enumerate('ABC')]
        duplicates = aggregate_reference_duplicates(blocks)
        self.assertEqual(duplicates[0]['retained_indices'], [1, 2, 3])
        self.assertFalse(aggregate_reference_duplicates(blocks[:1]))
        blocks[0]['label'] = 'table'
        self.assertFalse(aggregate_reference_duplicates(blocks))

    def test_reference_with_unique_material_is_retained(self):
        blocks = [{'label': 'reference', 'content': '[1] A [2] B [3] C plus unique material', 'bbox_2d': [0, 0, 1000, 1000]}]
        blocks += [{'label': 'text', 'content': f'[{i + 1}] {c}', 'bbox_2d': [0, i * 100, 1000, i * 100 + 80]} for i, c in enumerate('ABC')]
        self.assertFalse(aggregate_reference_duplicates(blocks))

    def test_table_math_keeps_html_and_repairs_math_alphabet(self):
        p = page([glyph('S', 10, font='ABCDEF+CMSY10')])
        content, audits = restore_table_math('<table><tr><td>$S$</td></tr></table>', p, [0, 0, 1, 1])
        self.assertIn(r'$\mathcal{S}$', content)
        self.assertEqual(audits[0]['status'], 'confirmed')

    def test_adjacent_unlocated_math_does_not_copy_neighbor_icon(self):
        p = page([glyph('X', 0), glyph('(cid:90)', 20), glyph('δ', 30), glyph('Y', 60)])
        _, audits = restore_inline_math(r'X $\bullet$ $\delta$ Y', p, [0, 0, 1, 1])
        self.assertFalse(audits[0]['source_crop_required'])
        self.assertEqual(audits[0]['reason'], 'inline_crop_alignment_unavailable')
        self.assertEqual(audits[1]['fallback_bbox'][0], .3)

    def test_standalone_superscript_uses_neighboring_body_baseline(self):
        p = page([glyph('A', 0), glyph('1', 10, baseline=45, size=7), glyph('B', 20)])
        _, audits = restore_inline_math('A $^{1}$ B', p, [0, 0, 1, 1])
        self.assertEqual(audits[0]['status'], 'confirmed')
        self.assertFalse(audits[0]['source_crop_required'])

    def test_escaped_braces_and_percent_are_atoms(self):
        parsed = TexAtoms(r'x\in\{a,b\}\quad 30\%')
        self.assertEqual(''.join(a['text'] for a in parsed.atoms), 'x∈{a,b}30%')
        self.assertEqual(parsed.unknown, [])

    def test_unlocalized_inline_keeps_selectable_paragraph(self):
        p = page([glyph('Q', 10)])
        content, audits = restore_inline_math('Algorithm $x$ then $y$', p, [0, 0, 1, 1])
        self.assertTrue(all(not a['source_crop_required'] for a in audits))
        self.assertFalse(inline_block_audit(content, audits, [0, 0, 1, 1])['source_block_required'])
        self.assertTrue(all(a['render_mode'] == 'candidate-unresolved' for a in audits))

    def test_widely_separated_glyphs_cannot_form_inline_crop(self):
        p = page([glyph('A', 0), glyph('x', 10), glyph('y', 85), glyph('B', 95)])
        _, audits = restore_inline_math('A $xy$ B', p, [0, 0, 1, 1])
        self.assertEqual(audits[0]['reason'], 'inline_native_geometry_ambiguous')
        self.assertFalse(audits[0]['source_crop_required'])

    def test_native_number_repairs_missing_wrong_and_duplicate_tags(self):
        p = page([glyph('x', 10), glyph('(', 70), glyph('1', 75), glyph('2', 80), glyph(')', 85)])
        for content in ['x', r'x\tag{9}', r'x\tag{9}\tag{9}']:
            fixed, audit = reconcile_equation_number(content, p, [0, 0, 1, 1])
            self.assertEqual(fixed, r'x \tag{12}')
            self.assertEqual(audit['source_number'], '12')

    def test_internal_parenthetical_number_is_not_an_equation_tag(self):
        p = page([glyph(c, 10 + i * 5) for i, c in enumerate('f(1)')])
        fixed, audit = reconcile_equation_number('f(1)', p, [0, 0, 1, 1])
        self.assertEqual(fixed, 'f(1)')
        self.assertEqual(audit['status'], 'absent')

    def test_flattened_table_scripts_require_source_table(self):
        p = page([glyph('S', 10), glyph('a', 15, baseline=52, size=7), glyph('n', 20, baseline=52, size=7)])
        audit = table_script_audit('<table><tr><td>San</td></tr></table>', p, [0, 0, 1, 1])
        self.assertEqual(audit['status'], 'unresolved')
        self.assertTrue(audit['lost_native_scripts'])
        correct = table_script_audit('<table><tr><td>S<sub>an</sub></td></tr></table>', p, [0, 0, 1, 1])
        self.assertEqual(correct['status'], 'confirmed')

    def test_money_delimiter_cannot_confirm_a_prose_paragraph(self):
        value = '3-12 per question and human annotators achieved 64%'
        p = page([glyph(c, i * .8) for i, c in enumerate(value)])
        _, audits = restore_inline_math('$' + value + '$', p, [0, 0, 1, 1])
        self.assertEqual(audits[0]['reason'], 'math_delimiter_boundary_ambiguous')
        self.assertFalse(audits[0]['source_crop_required'])

    def test_unconfirmed_bare_script_does_not_replace_paragraph(self):
        p = page([glyph('A', 0), glyph('1', 10), glyph('B', 20)])
        content, audits = restore_inline_math('A $^{1}$ B', p, [0, 0, 1, 1])
        self.assertEqual(audits[0]['reason'], 'bare_script_native_evidence_unresolved')
        self.assertEqual(audits[0]['render_mode'], 'candidate-unresolved')
        self.assertFalse(inline_block_audit(content, audits, [0, 0, 1, 1])['source_block_required'])

    def test_citation_list_is_selectable_native_superscript(self):
        chars = [glyph(c, i * 5) for i, c in enumerate('Study')]
        chars += [glyph(c, 25 + i * 5, baseline=45, size=7) for i, c in enumerate('1,5')]
        chars += [glyph(c, 45 + i * 5) for i, c in enumerate('done')]
        content, audits = restore_inline_math('Study $^{1,5}$ done', page(chars), [0, 0, 1, 1])
        self.assertEqual(audits[0]['render_mode'], 'native-script')
        self.assertEqual(audits[0]['semantic_kind'], 'citation-marker')
        self.assertEqual(audits[0]['selectable_text'], '1,5')
        self.assertEqual(audits[0]['script_kind'], 'sup')
        self.assertFalse(audits[0]['source_crop_required'])
        self.assertFalse(inline_block_audit(content, audits, [0, 0, 1, 1])['source_block_required'])

    def test_power_and_chemical_index_are_not_citations(self):
        for value, chars in [('x^2', [glyph('x', 0), glyph('2', 5, baseline=45, size=7)]), ('H_2O', [glyph('H', 0), glyph('2', 5, baseline=52, size=7), glyph('O', 10)])]:
            _, audits = restore_inline_math('$' + value + '$', page(chars), [0, 0, 1, 1])
            self.assertEqual(audits[0]['status'], 'confirmed')
            self.assertEqual(audits[0]['render_mode'], 'mathml')
            self.assertEqual(audits[0]['semantic_kind'], 'formula')

    def test_separate_math_scripts_keep_native_script_without_citation_label(self):
        for value, chars, kind in [('x $^{2}$', [glyph('x', 0), glyph('2', 5, baseline=45, size=7)], 'sup'), ('H $_{2}$ O', [glyph('H', 0), glyph('2', 5, baseline=52, size=7), glyph('O', 10)], 'sub')]:
            _, audits = restore_inline_math(value, page(chars), [0, 0, 1, 1])
            self.assertEqual(audits[0]['render_mode'], 'native-script')
            self.assertEqual(audits[0]['semantic_kind'], 'math-script')
            self.assertEqual(audits[0]['script_kind'], kind)

    def test_native_currency_dollars_do_not_pair_across_prose(self):
        text = 'Cost $3 / $5'
        p = page([glyph(c, i * 5) for i, c in enumerate(text)])
        fixed, changes = normalize_currency_dollars(text, p, [0, 0, 1, 1])
        self.assertEqual(fixed, r'Cost \$3 / \$5')
        self.assertEqual(len(changes), 2)
        self.assertEqual(restore_inline_math(fixed, p, [0, 0, 1, 1])[1], [])
        p = page([glyph('3', 20)])
        self.assertEqual(normalize_currency_dollars('$3$', p, [0, 0, 1, 1]), ('$3$', []))

    def test_unresolved_formula_crop_has_native_baseline_and_tight_bounds(self):
        p = page([glyph('A', 0), glyph('ˆ', 10, baseline=44, size=7), glyph('x', 10), glyph('B', 30)])
        _, audits = restore_inline_math(r'A $\hat{x}$ B', p, [0, 0, 1, 1])
        audit = audits[0]
        self.assertEqual(audit['render_mode'], 'source-crop')
        self.assertEqual(audit['source_bbox_normalized'], [.1, .384, .15, .52])
        self.assertAlmostEqual(audit['height_em'], 1.36)
        self.assertAlmostEqual(audit['baseline_offset_em'], .2)
        self.assertEqual(audit['source_glyph_ids'], [1, 2])

    def test_crop_with_adjacent_body_ink_is_rejected(self):
        p = page([glyph('A', 0), glyph('x', 4), glyph('B', 30)])
        _, audits = restore_inline_math('A $x$ B', p, [0, 0, 1, 1])
        self.assertEqual(audits[0]['render_mode'], 'candidate-unresolved')
        self.assertEqual(audits[0]['reason'], 'inline_foreign_glyph_overlap')
        self.assertFalse(audits[0]['source_crop_required'])

    def test_citation_range_retains_native_en_dash(self):
        chars = [glyph(c, i * 5) for i, c in enumerate('Study')]
        chars += [glyph(c, 25 + i * 5, baseline=45, size=7) for i, c in enumerate('1–5')]
        _, audits = restore_inline_math('Study $^{1-5}$', page(chars), [0, 0, 1, 1])
        self.assertEqual(audits[0]['render_mode'], 'native-script')
        self.assertEqual(audits[0]['selectable_text'], '1–5')

    def test_literal_currency_preserves_following_real_math(self):
        native = 'Pay $3 then x now'
        chars = [glyph(c, i * 5) for i, c in enumerate(native)]
        p = page(chars)
        content, changes = normalize_currency_dollars('Pay $3 then $x$ now', p, [0, 0, 1, 1])
        self.assertEqual(content, r'Pay \$3 then $x$ now')
        self.assertEqual(len(changes), 1)
        _, audits = restore_inline_math(content, p, [0, 0, 1, 1])
        self.assertEqual(len(audits), 1)
        self.assertEqual(audits[0]['candidate_content'], 'x')

    def test_unlocalized_candidate_preview_is_readable_without_changing_audit(self):
        self.assertEqual(readable_candidate(r'\frac{a}{b} \pm x_2'), '(a)/(b) ± x₂')
        p = page([])
        _, audits = restore_inline_math(r'Prose $\frac{a}{b}$ remains', p, [0, 0, 1, 1])
        self.assertEqual(audits[0]['selectable_text'], '(a)/(b)')
        self.assertEqual(audits[0]['candidate_content'], r'$\frac{a}{b}$')
        self.assertEqual(readable_candidate(r'E=\frac{mv^{2}}{2}'), 'E=(mv²)/(2)')

    def test_reference_script_and_baseline_period_are_separate_selectable_segments(self):
        chars = [glyph(c, i * 5) for i, c in enumerate('Study')]
        chars += [glyph(c, 25 + i * 5, baseline=45, size=7) for i, c in enumerate('1,5')]
        chars += [glyph('.', 40), glyph('B', 50)]
        _, audits = restore_inline_math('Study $^{1,5}。$ B', page(chars), [0, 0, 1, 1])
        audit = audits[0]
        self.assertEqual(audit['render_mode'], 'native-script')
        self.assertEqual(audit['selectable_text'], '1,5.')
        self.assertEqual([(s['text'], s.get('script_kind')) for s in audit['selectable_segments']], [('1,5', 'sup'), ('.', None)])
        self.assertFalse(audit['source_crop_required'])

    def test_copyright_is_native_selectable_text_not_formula_crop(self):
        p = page([glyph('A', 0), glyph('©', 10), glyph('B', 25)])
        _, audits = restore_inline_math(r'A $\textcircled{c}$ B', p, [0, 0, 1, 1])
        self.assertEqual(audits[0]['render_mode'], 'literal-text')
        self.assertEqual(audits[0]['semantic_kind'], 'text-symbol')
        self.assertEqual(audits[0]['selectable_text'], '©')
        self.assertFalse(audits[0]['source_crop_required'])

    def test_native_blank_on_next_line_is_not_formula_geometry(self):
        p = page([glyph('A', 0), glyph('β', 10), glyph(' ', 80, baseline=65), glyph('B', 25)])
        _, audits = restore_inline_math(r'A $\beta$ B', p, [0, 0, 1, 1])
        self.assertEqual(audits[0]['status'], 'confirmed')
        self.assertEqual(audits[0]['source_glyph_ids'], [1])

    def test_currency_wrapper_and_orphan_pm_remain_readable(self):
        native = 'Cost $4.48 ± $1.02.'
        p = page([glyph(c, i * 5) for i, c in enumerate(native)])
        content, changes = normalize_currency_dollars(r'Cost $4.48$ \pm $1.02.', p, [0, 0, 1, 1])
        self.assertEqual(content, r'Cost \$4.48 ± \$1.02.')
        self.assertEqual([c['reason'] for c in changes].count('math_wrapper_after_native_currency'), 1)
        _, audits = restore_inline_math(content, p, [0, 0, 1, 1])
        self.assertEqual(audits, [])
        self.assertEqual(content.replace(r'\$', '$'), native)

    def test_unclosed_math_cannot_flip_following_algorithm_lines(self):
        value = 'Ensure: papers $D_{\\mathrm{out}}\n\n6: procedure F($D, D_{\\mathrm{prev}}, \\theta_o, \\ell$)\n7: $B = \\left[o \\in D\\right]$'
        ranges = math_candidates(value)
        self.assertEqual(len(ranges), 3)
        self.assertEqual([s[3] for s in ranges], ['unbalanced-inline', 'delimited', 'delimited'])
        self.assertTrue(all('\n' not in value[a:b] for a, b, _, _ in ranges))
        content, audits = restore_inline_math(value, page([]), [0, 0, 1, 1])
        locate_inline_audits(content, audits)
        for a in reversed(audits):
            self.assertEqual(content[a['start']:a['end']], a['candidate_content'])
            content = content[:a['start']] + a['selectable_text'] + content[a['end']:]
        self.assertNotIn('\\', content)
        self.assertNotIn('$', content)
        self.assertIn('Dₚᵣₑᵥ', content)
        self.assertIn('θₒ', content)

    def test_bare_nested_tex_is_readable_but_unresolved(self):
        value = r'6: F(D_{\mathrm{prev}}, \theta_o, \ell) ▷ comment'
        content, audits = restore_inline_math(value, page([]), [0, 0, 1, 1])
        self.assertEqual(len(audits), 1)
        self.assertEqual(audits[0]['status'], 'unresolved')
        self.assertEqual(audits[0]['source_syntax'], 'bare-tex')
        self.assertEqual(audits[0]['selectable_text'], 'Dₚᵣₑᵥ, θₒ, ℓ)')
        locate_inline_audits(content, audits)
        self.assertEqual(content[audits[0]['start']:audits[0]['end']], audits[0]['candidate_content'])

    def test_partial_formula_atom_coverage_cannot_produce_crop(self):
        chars = [glyph('β', 10), glyph('A', 0), glyph('1', 15, baseline=52, size=7), glyph('=', 20), glyph('0', 25), glyph('.', 30), glyph('9', 35), glyph('B', 60)]
        _, audits = restore_inline_math(r'A $\beta_1=0.9$ B', page(chars), [0, 0, 1, 1])
        audit = audits[0]
        self.assertEqual(audit['render_mode'], 'candidate-unresolved')
        self.assertFalse(audit['source_crop_required'])
        self.assertEqual(audit['selectable_text'], 'β₁=0.9')
        self.assertFalse(audit['crop_completeness']['complete'])

    def test_unknown_adjacent_formula_boundary_cannot_crop_only_known_atom(self):
        p = page([glyph('A', 0), glyph('ˆ', 10, baseline=44, size=7), glyph('x', 10), glyph('y', 20), glyph('B', 35)])
        _, audits = restore_inline_math(r'A $\hat{x}$ $y$ B', p, [0, 0, 1, 1])
        self.assertEqual(audits[0]['render_mode'], 'candidate-unresolved')
        self.assertFalse(audits[0]['source_crop_required'])

    def test_native_words_selected_with_formula_cannot_enter_math_crop(self):
        native = 'AsetofpreviouspapersDprevB'
        p = page([glyph(c, i * 5) for i, c in enumerate(native)])
        p.width = 200
        _, audits = restore_inline_math(r'A $D_{\mathrm{prev}}$ B', p, [0, 0, 1, 1])
        audit = audits[0]
        self.assertEqual(audit['render_mode'], 'candidate-unresolved')
        self.assertEqual(audit['reason'], 'formula_crop_contains_unmatched_native_text')
        self.assertFalse(audit['source_crop_required'])
        self.assertEqual(audit['selectable_text'], 'Dₚᵣₑᵥ')
        self.assertLess(audit['crop_completeness']['selected_native_atoms_covered'], .3)

    def test_readable_script_fallback_is_stable_and_math_labels_do_not_merge(self):
        self.assertEqual(readable_candidate(r'\theta_{\mathrm{score}}'), 'θ_(score)')
        self.assertEqual(readable_candidate(r'\text{SORT}_{\downarrow\text{CITERS}}(D)'), 'SORT_(↓CITERS)(D)')

    def test_candidate_preview_preserves_word_boundaries_and_logic_symbols(self):
        self.assertEqual(readable_candidate(r' o \in D '), ' o ∈ D ')
        self.assertEqual(readable_candidate(r'x \vee y \wedge z'), 'x ∨ y ∧ z')


if __name__ == '__main__':
    unittest.main()
