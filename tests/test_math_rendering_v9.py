import unittest
from xml.etree import ElementTree

from services.parser_service.exporter import render_math


def elements(rendered, tag):
    return [node for node in ElementTree.fromstring(rendered).iter() if node.tag.rsplit('}', 1)[-1] == tag]


class UprightMathRenderingV9Tests(unittest.TestCase):
    def test_single_ascii_roman_letters_keep_explicit_normal_variant(self):
        for letter in 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz':
            with self.subTest(letter=letter):
                node, = elements(render_math(r'\mathrm{' + letter + '}'), 'mi')
                self.assertEqual(node.text, letter)
                self.assertEqual(node.get('mathvariant'), 'normal')

    def test_repeated_plain_variables_do_not_inherit_neighboring_roman_scope(self):
        nodes = elements(render_math(r'E+\mathrm{E}+E+\mathrm{m}+m'), 'mi')
        self.assertEqual([(node.text, node.get('mathvariant')) for node in nodes],
                         [('E', None), ('E', 'normal'), ('E', None), ('m', 'normal'), ('m', None)])

    def test_simple_scripts_follow_their_original_font_scope(self):
        nodes = elements(render_math(r'\mathrm{m}_i+\mathrm{E}^{2}'), 'mi')
        self.assertEqual([(node.text, node.get('mathvariant')) for node in nodes],
                         [('m', 'normal'), ('i', None), ('E', 'normal')])
        self.assertEqual(elements(render_math(r'\mathrm{E}^{2}'), 'mn')[0].text, '2')

    def test_nested_roman_groups_and_scripts_keep_inner_and_outer_scopes(self):
        nodes = elements(render_math(r'E_{\mathrm{m}}+\mathrm{E_i}+\mathrm{{m}}+E'), 'mi')
        self.assertEqual([(node.text, node.get('mathvariant')) for node in nodes],
                         [('E', None), ('m', 'normal'), ('E', 'normal'), ('i', 'normal'), ('m', 'normal'), ('E', None)])

    def test_operatorname_and_text_remain_upright_without_restylizing_variables(self):
        rendered = render_math(r'\operatorname{x}_i+\text{E}+E')
        self.assertEqual(elements(rendered, 'mtext')[0].text, 'E')
        self.assertTrue(any(node.text == 'x' for node in elements(rendered, 'mo')))
        self.assertEqual([(node.text, node.get('mathvariant')) for node in elements(rendered, 'mi')], [('i', None), ('E', None)])

    def test_bold_script_double_struck_and_greek_variants_are_unchanged(self):
        from latex2mathml.converter import convert
        for tex in [r'\mathbf{E}', r'\mathcal{E}', r'\mathbb{E}', r'\mathrm{\alpha}', r'\alpha']:
            with self.subTest(tex=tex):
                self.assertEqual(render_math(tex), convert(tex))
        nodes = elements(render_math(r'\mathrm{E}+\mathbf{E}+\mathcal{E}+\mathbb{E}+E'), 'mi')
        self.assertEqual(nodes[0].get('mathvariant'), 'normal')
        self.assertEqual([node.text for node in nodes[1:]], ['𝐄', 'ℰ', '𝔼', 'E'])
        self.assertIsNone(nodes[-1].get('mathvariant'))

    def test_greek_bold_styles_use_browser_supported_encoded_glyphs(self):
        nodes = elements(render_math(r'\alpha+\mathbf{\alpha}+\mathbf{\beta}+\boldsymbol{\alpha}+\mathrm{\alpha}'), 'mi')
        self.assertEqual([n.text for n in nodes], ['α', '𝛂', '𝛃', '𝜶', 'α'])
        self.assertEqual([n.get('mathvariant') for n in nodes], [None, 'bold', 'bold', 'bold-italic', 'normal'])

    def test_greek_variant_symbols_and_scripts_keep_distinct_source_glyphs(self):
        nodes = elements(render_math(r'\mathbf{\theta}+\mathbf{\vartheta}+\mathbf{\Gamma}_{\alpha}'), 'mi')
        self.assertEqual([n.text for n in nodes], ['𝛉', '𝛝', '𝚪', 'α'])

    def test_source_statistical_expression_keeps_upright_e_and_parentheses(self):
        rendered = render_math(r'$(\mathrm{E}\leq 0.1)$')
        node, = elements(rendered, 'mi')
        self.assertEqual((node.text, node.get('mathvariant')), ('E', 'normal'))
        self.assertEqual([node.text for node in elements(rendered, 'mo')], ['(', '≤', ')'])


if __name__ == '__main__':
    unittest.main()
