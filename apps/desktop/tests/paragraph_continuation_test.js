const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { canJoin } = require('../web/paragraph_continuation.js');

const previous = { page: 6, bbox: [.098, .9, .902, .915], text: 'Both blind passes combined objective trace metrics with two independent visual reads of every design that showed any', tag: 'p' };
const next = { page: 7, bbox: [.096, .08, .9, .112], text: 'response (agreement between readers, 98% for Twist Bioscience and 96% for Adaptyv Bio on positive versus not); no label was changed on metrics alone.', tag: 'p' };
let checks = 0;
function check(left, right, expected, message, options) {
  assert.equal(canJoin(left, right, options), expected, message);
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
const upper = { ...previous, bbox: [.1, .30, .9, .40] };
const lower = { ...next, page: 6, bbox: [.1, .70, .9, .80] };
const picture = { tag: 'figure', page: 6, bbox: [.1, .44, .9, .66] };
const withPicture = { media: [picture] };
check(upper, lower, true, 'A same-column sentence can continue after an intervening image.', withPicture);
check(upper, lower, false, 'Same-page geometry alone does not prove an interruption.');
check(upper, lower, false, 'An explicit empty media list preserves the old same-page behavior.', { media: [] });
check(previous, next, true, 'An explicit empty media list preserves direct page continuation.', { media: [] });
check(upper, lower, true, 'Multiple ordered images can interrupt the same sentence.', { media: [
  { ...picture, bbox: [.1, .43, .9, .51] }, { ...picture, bbox: [.1, .54, .9, .67] },
] });
check({ ...upper, bbox: [.1, .30, .47, .40] }, { ...lower, bbox: [.1, .70, .47, .80] }, true,
  'A narrow column may continue below an image in that column.', { media: [{ ...picture, bbox: [.1, .44, .47, .66] }] });
check(upper, lower, true, 'A picture box may include its caption below the image.', { media: [{ ...picture, bbox: [.1, .44, .9, .69] }] });
for (const bbox of [[.15, .70, .9, .80], [.53, .70, .9, .80], [.1, .35, .9, .38], [.1, .20, .9, .28]]) {
  check(upper, { ...lower, bbox }, false, 'Indented, incompatible or reversed same-page prose does not join.', withPicture);
}
check({ ...upper, bbox: [.1, .30, .47, .40] }, { ...lower, bbox: [.1, .70, .47, .80] }, false,
  'An image in the other column does not explain the interruption.', { media: [{ ...picture, bbox: [.53, .44, .9, .66] }] });
for (const bbox of [[.1, .10, .9, .20], [.1, .75, .9, .90], [.1, .20, .9, .66], [.1, .55, .9, .66]]) {
  check(upper, lower, false, 'Images outside the gap or separated by unexplained whitespace do not join.', { media: [{ ...picture, bbox }] });
}
check(upper, lower, false, 'Reversed image geometry does not join.', { media: [
  { ...picture, bbox: [.1, .54, .9, .67] }, { ...picture, bbox: [.1, .43, .9, .51] },
] });
for (const bbox of [undefined, [], [.1, .44, .9], [.1, .44, .9, NaN], [.1, .44, 1.2, .66], [.9, .44, .1, .66]]) {
  check(upper, lower, false, 'Every intervening image needs valid normalized geometry.', { media: [{ ...picture, bbox }] });
}
for (const image of [null, { ...picture, page: undefined }, { ...picture, page: 5 }, { ...picture, page: 7 }, { ...picture, page: 6.5 }, { ...picture, tag: 'table' }, { ...picture, excluded: true }]) {
  check(upper, lower, false, 'Only known, nonexcluded pictures on the paragraph pages can bridge prose.', { media: [image] });
}
check(upper, lower, false, 'Media must be an explicit list of images.', { media: picture });
check({ ...upper, scope: 'main' }, lower, false, 'An image from a different scope cannot bridge body text.', { media: [{ ...picture, scope: 'references' }] });
const afterHead = { ...next, bbox: [.1, .54, .9, .65] };
const headImage = { ...picture, page: 7, bbox: [.1, .08, .9, .50] };
const beforeTail = { ...previous, bbox: [.1, .52, .9, .62] };
const tailImage = { ...picture, bbox: [.1, .67, .9, .91] };
check(previous, afterHead, true, 'A large page-head image can push continuation below the old top threshold.', { media: [headImage] });
check(beforeTail, next, true, 'A page-tail image can push the unfinished paragraph above the old bottom threshold.', { media: [tailImage] });
check(beforeTail, afterHead, true, 'Images can occupy both sides of a page break.', { media: [tailImage, headImage] });
check(previous, afterHead, true, 'Multiple images can fill the page head.', { media: [
  { ...headImage, bbox: [.1, .08, .9, .28] }, { ...headImage, bbox: [.1, .32, .9, .50] },
] });
check(beforeTail, next, true, 'Multiple images can fill the page tail.', { media: [
  { ...tailImage, bbox: [.1, .65, .9, .76] }, { ...tailImage, bbox: [.1, .80, .9, .92] },
] });
check(rightColumn, { ...leftColumn, bbox: [.1, .54, .47, .65] }, true,
  'Cross-page column order is preserved with a page-head image.', { media: [headImage] });
check(rightColumn, { ...leftColumn, bbox: [.53, .54, .9, .65] }, false,
  'Images do not relax cross-page column order.', { media: [headImage] });
check(beforeTail, afterHead, false, 'Page-break images must follow reading order.', { media: [headImage, tailImage] });
check(beforeTail, afterHead, false, 'A head image does not explain an early previous paragraph ending.', { media: [headImage] });
check(beforeTail, afterHead, false, 'A tail image does not explain a late next paragraph start.', { media: [tailImage] });
for (const bbox of [[.1, .25, .9, .50], [.1, .08, .9, .30], [.1, .08, .9, .60]]) {
  check(previous, afterHead, false, 'Head images must start near the top and lead directly to continuation.', { media: [{ ...headImage, bbox }] });
}
for (const bbox of [[.1, .67, .9, .76], [.1, .78, .9, .91], [.1, .40, .9, .91]]) {
  check(beforeTail, next, false, 'Tail images must follow the paragraph and reach the bottom.', { media: [{ ...tailImage, bbox }] });
}
check(rightColumn, { ...leftColumn, bbox: [.1, .54, .47, .65] }, false,
  'An image in the other next-page column cannot explain the gap.', { media: [{ ...headImage, bbox: [.53, .08, .9, .50] }] });
for (const [left, right] of [
  [{ ...upper, text: 'A finished sentence.' }, lower],
  [upper, { ...lower, text: 'Response starts a new paragraph' }],
  [{ ...upper, text: 'Figure 1: an unfinished caption' }, lower],
  [upper, { ...lower, text: 'references continued' }],
  [upper, { ...lower, text: '(a) response reported' }],
  [{ ...upper, excluded: true }, lower],
  [upper, { ...lower, excluded: true }],
  [{ ...upper, tag: 'h2' }, lower],
  [upper, { ...lower, tag: 'li' }],
  [{ ...upper, scope: 'main' }, { ...lower, scope: 'references' }],
  [upper, { ...lower, page: 8 }],
  [upper, { ...lower, bbox: undefined }],
]) check(left, right, false, 'An intervening image cannot bypass prose, scope or page guards.', withPicture);
const mediaSnapshot = JSON.stringify([beforeTail, afterHead, tailImage, headImage]);
canJoin(beforeTail, afterHead, { media: [tailImage, headImage] });
assert.equal(JSON.stringify([beforeTail, afterHead, tailImage, headImage]), mediaSnapshot, 'Media checks must not mutate inputs.');
assert.equal(JSON.stringify([previous, next]), snapshot, 'The predicate must not mutate input.');
const context = vm.createContext({ window: {} });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/paragraph_continuation.js'), 'utf8'), context);
assert.equal(context.window.GuziParagraphContinuation.canJoin(previous, next), true, 'Classic browser scripts expose the same API.');
console.log(`paragraph continuation: ${checks} checks passed, plus purity and browser export`);
