'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const annotationOperations = require('../web/annotation-operations.js');
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
const first = { jobId: 'one', annotations: [manual, other, plain, ai] };
const second = { jobId: 'two', annotations: [{ ...manual, id: 'second' }] };
const pending = []; let renderCount = 0;
const context = vm.createContext({
  state: { activeJob: { job_id: 'one' }, annotations: first.annotations }, readerMount: first,
  window: { MyScholarAnnotationOperations: annotationOperations },
  readerMounts: new Map([['one', first], ['two', second]]),
  readerMountIsCurrent: (mount) => context.readerMounts.get(mount.jobId) === mount,
  readerMountMatches: (mount) => context.readerMount === mount && context.state.activeJob?.job_id === mount.jobId,
  isAIAnnotation: (annotation) => annotation.source === 'ai',
  renderAnnotations: () => { renderCount += 1; }, renderFrameAnnotations: () => { renderCount += 1; },
  fetch: async () => new Promise((resolve) => pending.push((payload) => resolve({ ok: true, json: async () => payload }))),
});
vm.runInContext([
  'const browserDemo = null; let demoResetting = false;',
  section('const request =', 'const appearanceDefaults ='),
  section('const requestAPI =', 'const jsonOptions ='),
  section('function applyAnnotationActionSync(', 'const builtinAnnotationActions ='),
  'this.api = api; this.sync = applyAnnotationActionSync;',
].join('\n'), context);

(async () => {
  const staleResponse = context.api('/api/jobs/one/annotations');
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
  const serverArray = [{ ...manual, color: '#112233' }];
  const backgroundRead = context.api('/api/jobs/two/annotations');
  pending.shift()({ annotation_style_revision: 0, annotations: serverArray });
  const backgroundResponse = await backgroundRead;
  assert.notEqual(backgroundResponse.annotations, serverArray, 'Style normalization replaces the response array');
  assert.equal(backgroundResponse.annotations[0].color, '#008800', 'Background GET responses receive every newer action revision');
  assert.equal(serverArray[0].color, '#112233', 'Style normalization does not rewrite the original server objects');
  context.readerMount = null;
  context.state.annotations = [manualOverride];
  context.sync({ revision: 5, updates: { principle: { label: '无当前阅读页' } } });
  assert.equal(context.state.annotations[0].label, '无当前阅读页', 'Action synchronization also updates active state without a reader mount');
  assert.equal(context.state.annotations[0].color, '#ffaa00', 'No-mount synchronization preserves unmentioned fields');
  assert.equal(second.annotations[0].label, '无当前阅读页', 'Kept-alive background mounts continue receiving revisions without a foreground mount');
  console.log('annotation action synchronization tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
