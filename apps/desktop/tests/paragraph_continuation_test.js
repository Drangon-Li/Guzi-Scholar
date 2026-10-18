const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { canJoin } = require('../web/paragraph_continuation.js');

const previous = { page: 6, bbox: [.098, .9, .902, .915], text: 'Both blind passes combined objective trace metrics with two independent visual reads of every design that showed any', tag: 'p' };
const next = { page: 7, bbox: [.096, .08, .9, .112], text: 'response (agreement between readers, 98% for Twist Bioscience and 96% for Adaptyv Bio on positive versus not); no label was changed on metrics alone.', tag: 'p' };
let checks = 0;
function check(left, right, expected, message) {
  assert.equal(canJoin(left, right), expected, message);
  checks += 1;
}
const snapshot = JSON.stringify([previous, next]);
check(previous, next, true, 'The reported cross-page sentence continues.');
for (const prefix of ['(', '“', '"(', '[']) check(previous, { ...next, text: `${prefix}response remains measurable` }, true, 'Opening punctuation may precede lowercase prose.');
check({ ...previous, text: 'An incompletely named protein-' }, { ...next, text: 'binding response remains measurable' }, true, 'A line-end hyphen permits continuation without changing source text.');
for (const punctuation of ['.', '?', '!', ';', ':', '.”', '.")']) check({ ...previous, text: `A complete result${punctuation}` }, next, false, 'Terminal punctuation ends the paragraph.');
for (const text of ['Response starts a new paragraph.', '42 responses remained.', '中文段落', 'Figure 2 | Evidence', 'table 2 evidence', 'references continued', '[12] response reported', '1. response reported', '(a) response reported', 'a) response reported', '• response reported', '† response reported']) {
  check(previous, { ...next, text }, false, 'Ambiguous or auxiliary starts do not continue prose.');
}
for (const text of ['Figure 1 | A caption with an unfinished', '[12] A bibliographic record with an unfinished', 'Note: an unfinished footnote']) check({ ...previous, text }, next, false, 'Auxiliary left blocks do not continue body text.');
for (const tag of ['h2', 'figure', 'li', 'blockquote']) {
  check({ ...previous, tag }, next, false, 'Only paragraphs can join.');
  check(previous, { ...next, tag }, false, 'Only paragraphs can join.');
}
check({ ...previous, excluded: true }, next, false, 'Excluded sources do not join.');
check(previous, { ...next, excluded: true }, false, 'Excluded destinations do not join.');
check(previous, { ...next, page: 8 }, false, 'Skipped pages do not join.');
check(previous, { ...next, page: 6 }, false, 'Same-page fragments do not join.');
check({ ...previous, scope: 'main' }, { ...next, scope: 'references' }, false, 'Scope transitions do not join.');
check({ ...previous, scope: 'main' }, { ...next, scope: 'main' }, true, 'Matching scopes may join.');
check({ ...previous, bbox: [.1, .5, .9, .7] }, next, false, 'Body must reach the page bottom.');
check(previous, { ...next, bbox: [.1, .3, .9, .4] }, false, 'Body must resume near the page top.');
check(previous, { ...next, bbox: [.15, .08, .9, .112] }, false, 'An indented new paragraph does not join.');
const rightColumn = { ...previous, bbox: [.53, .85, .9, .92] };
const leftColumn = { ...next, bbox: [.1, .08, .47, .2] };
check(rightColumn, leftColumn, true, 'A right column can continue into the next page left column.');
check(rightColumn, { ...next, bbox: [.53, .08, .9, .2] }, false, 'Same narrow-column positions lack full reading-order evidence.');
check({ ...previous, bbox: [.1, .85, .47, .92] }, leftColumn, false, 'A left column alone does not prove page continuation.');
check(rightColumn, { ...next, bbox: [.18, .08, .47, .2] }, false, 'An indented left column does not join.');
for (const bbox of [undefined, [], [.1, .8, .9], [.1, .8, .9, NaN], [.1, .8, 1.2, .9], [.9, .8, .1, .9]]) check({ ...previous, bbox }, next, false, 'Missing or invalid geometry is rejected.');
check(null, next, false, 'Missing blocks are rejected.');
check(previous, { ...next, text: '' }, false, 'Empty text is rejected.');
assert.equal(JSON.stringify([previous, next]), snapshot, 'The predicate must not mutate input.');
const context = vm.createContext({ window: {} });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/paragraph_continuation.js'), 'utf8'), context);
assert.equal(context.window.GuziParagraphContinuation.canJoin(previous, next), true, 'Classic browser scripts expose the same API.');
console.log(`paragraph continuation: ${checks} checks passed, plus purity and browser export`);
