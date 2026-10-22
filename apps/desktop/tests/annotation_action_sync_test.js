'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
function section(from, to) {
  const start = source.indexOf(`  ${from}`);
  const end = source.indexOf(`  ${to}`, start);
  assert(start >= 0 && end > start);
  return source.slice(start, end);
}
const manual = { id: 'manual', action_id: 'principle', source: 'manual', label: '原理', color: '#ff0000', kind: 'highlight' };
const other = { id: 'other', action_id: 'other', source: 'manual', color: '#111111' };
const plain = { id: 'plain', source: 'manual', color: '#222222' };
const ai = { id: 'ai', action_id: 'principle', source: 'ai', color: '#333333' };
const first = { annotations: [manual, other, plain, ai] };
const second = { annotations: [{ ...manual, id: 'second' }] };
const pending = []; let renderCount = 0;
const context = vm.createContext({
  state: { annotations: first.annotations }, readerMount: first,
  readerMounts: new Map([['one', first], ['two', second]]),
  isAIAnnotation: (annotation) => annotation.source === 'ai',
  renderAnnotations: () => { renderCount += 1; }, renderFrameAnnotations: () => { renderCount += 1; },
  fetch: async () => new Promise((resolve) => pending.push((payload) => resolve({ ok: true, json: async () => payload }))),
});
vm.runInContext([
  section('const annotationStyleSyncs =', 'const jsonOptions ='),
  section('function applyAnnotationActionFields(', 'const builtinAnnotationActions ='),
  'this.api = api; this.sync = applyAnnotationActionSync;',
].join('\n'), context);

(async () => {
  const staleResponse = context.api('/annotations');
  context.sync({ revision: 1, updates: { principle: { label: '新原理', color: '#00aa00', kind: 'underline' } } });
  assert.equal(first.annotations[0].color, '#00aa00');
  assert.equal(second.annotations[0].kind, 'underline', 'All kept-alive reader mounts receive the action update');
  assert.equal(first.annotations[1], other);
  assert.equal(first.annotations[2], plain);
  assert.equal(first.annotations[3], ai);
  assert.equal(context.state.annotations, first.annotations);
  assert.equal(renderCount, 2);
  pending.shift()({ annotation_style_revision: 0, annotation: manual, annotations: [manual, other, plain, ai] });
  const response = await staleResponse;
  assert.equal(response.annotation.label, '新原理');
  assert.equal(response.annotations[0].color, '#00aa00', 'A response begun before synchronization cannot restore an old action snapshot');
  assert.equal(response.annotations[3], ai);
  const manualOverride = { ...first.annotations[0], color: '#ffaa00' };
  const newResponse = context.api('/annotation/manual');
  pending.shift()({ annotation_style_revision: 1, annotation: manualOverride, annotations: [manualOverride] });
  assert.equal((await newResponse).annotation.color, '#ffaa00', 'A later single-annotation color edit remains local until the action color next changes');
  context.sync({ revision: 2, updates: { principle: { label: '仅改名' } } });
  assert.equal(first.annotations[0].color, '#00aa00', 'Renaming changes only the requested field');
  assert.equal(first.annotations[0].label, '仅改名');
  const queuedBeforeSync = context.api('/annotation/manual');
  context.sync({ revision: 3, updates: { principle: { color: '#00ff00' } } });
  pending.shift()({ annotation_style_revision: 3, annotation: manualOverride, annotations: [manualOverride] });
  assert.equal((await queuedBeforeSync).annotation.color, '#ffaa00', 'A PATCH executed after synchronization retains the color actually stored by the server even if requested earlier');
  const arrivedBeforeSettingsResponse = context.api('/annotation/manual');
  pending.shift()({ annotation_style_revision: 4, annotations: [manualOverride] });
  first.annotations = (await arrivedBeforeSettingsResponse).annotations;
  context.sync({ revision: 4, updates: { principle: { color: '#008800' } } });
  assert.equal(first.annotations[0].color, '#ffaa00', 'A later-version annotation response also survives a delayed settings response');
  console.log('annotation action synchronization tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
