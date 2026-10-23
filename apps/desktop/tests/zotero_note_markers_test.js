'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const source = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
function section(from, to) {
  const start = source.indexOf(`  ${from}`);
  const end = source.indexOf(`  ${to}`, start);
  assert(start >= 0 && end > start);
  return source.slice(start, end);
}
const Node = { ELEMENT_NODE: 1, TEXT_NODE: 3, COMMENT_NODE: 8 };
const text = (value) => ({ nodeType: 3, nodeValue: value });
const comment = (value) => ({ nodeType: 8, nodeValue: value });
function element(tagName, ...childNodes) {
  return { nodeType: 1, tagName, childNodes, children: childNodes.filter((node) => node.nodeType === 1),
    dataset: {}, classList: { contains: () => false }, getAttribute: () => null };
}
const marker = '<!-- zotero-note:abcdef0123456789abcdef0123456789 -->';
const unanchored = '<!-- zotero-unanchored:0123456789abcdef0123456789abcdef -->';
const editor = element('DIV', comment(marker.slice(4, -3)), element('H2', text('Zotero 笔记')), element('P', text('Original note.')),
  comment(unanchored.slice(4, -3)), element('H2', text('Zotero 未定位批注')), element('P', text('Unanchored content.')));
editor.dataset = { jobId: 'fixture', revision: '7' }; editor.contentEditable = 'true';
const context = vm.createContext({ Node, articleNoteServerRevisions: new Map([['fixture', 'server-revision']]), state: { activeJob: { job_id: 'fixture' } },
  $: () => editor, noteAssetURL: () => '',
  escapeHTML: (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])),
});
vm.runInContext([
  section('function escapeAnnotationMarkdownText(', 'function insertPlainTextAtSelection('),
  section('function renderMarkdown(', 'function restoreArticleNoteDrafts('),
  section('function articleNotesSnapshot(', 'function setArticleNotesStatus('),
  'this.render = renderMarkdown; this.markdown = annotationEditorMarkdown; this.snapshot = articleNotesSnapshot;',
].join('\n'), context);

const initial = `${marker}\n## Zotero 笔记\n\nOriginal note.\n\n${unanchored}\n## Zotero 未定位批注\n\nUnanchored content.`;
const rendered = context.render(initial);
assert.equal(rendered, `${marker}<h2>Zotero 笔记</h2><p>Original note.</p>${unanchored}<h2>Zotero 未定位批注</h2><p>Unanchored content.</p>`);
const saved = context.snapshot();
assert.equal(saved.jobId, 'fixture');
assert.equal(saved.revision, 7);
assert.equal(saved.baseRevision, 'server-revision');
assert.equal(context.render(saved.markdown), rendered, 'Loading and saving preserve the hidden metadata and note bodies');
editor.childNodes[2].childNodes.push(element('STRONG', text(' An edited sentence.')));
const edited = context.snapshot().markdown;
assert(edited.includes('** An edited sentence.**'));
for (const value of [marker, unanchored]) assert.equal(edited.split(value).length - 1, 1, 'Each deduplication marker survives editing exactly once');
const nested = element('DIV', element('P', text('Before.'), comment(marker.slice(4, -3)), text('After.')));
assert.equal(context.markdown(nested), `Before.\n\n${marker}\n\nAfter.`, 'Browser-nested comment nodes remain complete standalone markers');
assert.equal(context.markdown(element('DIV', comment(' ordinary comment '), comment(' zotero-note:bad --> <img onerror=alert(1)> '))), '');

const fenced = context.render(`\`\`\`html\n${marker}\n\`\`\``);
assert(fenced.includes('&lt;!-- zotero-note:'));
assert(!fenced.includes(marker), 'A fenced code example is displayed literally');
const inline = context.render(`Example: \`${marker}\``);
assert(inline.includes('<code>&lt;!-- zotero-note:'));
assert(!inline.includes(marker), 'An inline code example is displayed literally');
for (const literal of [' ' + marker, marker + ' ', marker.replace('abcdef', 'ABCDEF'), '<!-- zotero-other:abcdef0123456789abcdef0123456789 -->', '<!-- normal comment -->']) {
  const html = context.render(literal);
  assert(html.includes('&lt;!--'));
  assert(!html.includes(literal.trim()), 'Only exact known marker lines are hidden');
}
const unsafe = context.render('<script>window.markerExecuted = true</script>\n<img src=x onerror=alert(1)>');
assert(!unsafe.includes('<script>') && !unsafe.includes('<img '), 'Arbitrary raw HTML remains escaped');
assert(unsafe.includes('&lt;script&gt;') && unsafe.includes('&lt;img'));
const reimport = spawnSync(process.env.MY_SCHOLAR_TEST_PYTHON || process.env.MY_SCHOLAR_PYTHON || 'python3', ['-c', `
import json, sys
sys.path.insert(0, sys.argv[1])
from zotero_merge import _append_note
payload = json.load(sys.stdin)
for marker in payload['markers']:
    saved, added, clipped = _append_note(payload['markdown'], marker, 'Duplicate imported content')
    assert saved == payload['markdown'] and not added and not clipped
`, path.join(__dirname, '..')], { input: JSON.stringify({ markdown: edited, markers: [marker, unanchored] }), encoding: 'utf8' });
assert.equal(reimport.status, 0, reimport.stderr || 'Saved markers must still prevent duplicate Zotero imports');
console.log('Zotero note marker rendering and editor round-trip tests passed');
