'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
function functionSource(name) {
  let start = source.indexOf(`  function ${name}(`);
  if (start < 0) start = source.indexOf(`  async function ${name}(`);
  const end = source.indexOf('\n  }\n', start);
  assert(start >= 0 && end > start, name);
  return source.slice(start, end + 4);
}
const eventTarget = () => ({
  listeners: new Map(),
  addEventListener(type, callback) { this.listeners.set(type, callback); },
  removeEventListener(type, callback) { if (this.listeners.get(type) === callback) this.listeners.delete(type); },
});
const animations = [];
const children = [];
const timers = new Map();
let timerId = 0;
let selectedId = '';
let observedMutation;
let observedResize;
const mark = {
  dataset: { annotationId: 'new' },
  rects: [
    { left: 20, top: 60, bottom: 80, width: 100, height: 20 },
    { left: 140, top: 30, bottom: 50, width: 60, height: 20 },
    { left: 20, top: 30, bottom: 50, width: 120, height: 20 },
  ],
  getClientRects() { return this.rects; },
};
class Observer {
  constructor(callback) { this.callback = callback; }
  observe() { this.observed = true; }
  disconnect() { this.disconnected = true; }
}
const content = {};
const doc = {
  ...eventTarget(),
  defaultView: {
    ...eventTarget(), Element: { prototype: { animate() {} } },
    getComputedStyle: () => ({ backgroundColor: 'rgba(255, 212, 0, 0.32)', boxShadow: 'inset 0 -1px 0 orange', textDecorationColor: 'rgb(255, 212, 0)' }),
    MutationObserver: class extends Observer { constructor(callback) { super(callback); observedMutation = this; } },
    ResizeObserver: class extends Observer { constructor(callback) { super(callback); observedResize = this; } },
  },
  querySelectorAll(selector) { selectedId = selector; return selector.includes('"new"') ? [mark] : []; },
  querySelector: () => content,
  createElement() {
    return {
      children: [], style: {}, attributes: {},
      setAttribute(key, value) { this.attributes[key] = value; },
      append(node) { this.children.push(node); },
      remove() { const at = children.indexOf(this); if (at >= 0) children.splice(at, 1); },
      animate(frames, options) {
        const animation = { frames, options, cancelled: false, cancel() { this.cancelled = true; } };
        animations.push(animation); return animation;
      },
    };
  },
  body: { append: (node) => children.push(node) },
};
const documentState = {};
const win = {
  ...eventTarget(),
  setTimeout(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId; },
  clearTimeout(id) { timers.delete(id); },
};
const context = vm.createContext({
  window: win, frameDocument: () => doc, readerDocumentState: () => documentState,
  reducedMotionQuery: { ...eventTarget(), matches: false }, cssEscape: (value) => value,
  isAIAnnotation: (annotation) => annotation.source === 'ai',
});
vm.runInContext(['annotationDrawRects', 'clearAnnotationDrawAnimation', 'playAnnotationDrawAnimation'].map(functionSource).join('\n')
  + '\nthis.test = { annotationDrawRects, clearAnnotationDrawAnimation, playAnnotationDrawAnimation };', context);
const t = context.test;
const plain = (value) => JSON.parse(JSON.stringify(value));
const annotation = { id: 'new', kind: 'highlight', source: 'manual' };
t.playAnnotationDrawAnimation(annotation);
assert.equal(selectedId, ':is(mark, mrow)[data-annotation-id="new"]', 'Only the newly saved annotation is targeted');
assert.equal(children.length, 1);
assert.equal(children[0].attributes['aria-hidden'], 'true');
assert.equal(mark.dataset.annotationDrawing, 'true');
assert.equal(children[0].children.length, 2, 'Adjacent fragments on one line form one drawing stroke');
assert.equal(children[0].children[0].style.top, '30px');
assert.equal(children[0].children[0].style.left, '20px', 'Each line draws from its left edge');
assert.equal(children[0].children[1].style.top, '60px', 'Wrapped lines draw in reading order');
assert.equal(animations[0].options.delay, 0);
assert.equal(animations[1].options.delay, animations[0].options.duration, 'The next line waits for the previous stroke');
assert.equal(animations[1].options.delay + animations[1].options.duration, 400);
assert.deepEqual(plain(animations[0].frames), [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }]);
assert.equal(observedMutation.observed, true);
observedResize.callback();
assert.equal(children.length, 1, 'The initial resize observation does not interrupt drawing');
const completion = [...timers.values()][0];
assert.equal(completion.delay, 420);
completion.callback();
assert.equal(children.length, 0);
assert.equal(mark.dataset.annotationDrawing, undefined, 'Animation completion restores the static annotation');
assert.equal(documentState.annotationDraw, null);
assert(animations.every((animation) => animation.cancelled));
assert.equal(observedMutation.disconnected, true);
assert.equal(doc.listeners.size, 0);
assert.equal(doc.defaultView.listeners.size, 0);
assert.equal(win.listeners.size, 0);

t.playAnnotationDrawAnimation({ ...annotation, kind: 'underline' });
assert.equal(children[0].children[0].style.height, '2px');
assert.equal(children[0].children[0].style.top, '49px');
assert.equal(children[0].children[0].style.backgroundColor, 'rgb(255, 212, 0)');
doc.listeners.get('scroll')();
assert.equal(children.length, 0, 'Scrolling immediately restores the static underline');
for (const trigger of [() => doc.defaultView.listeners.get('resize')(), () => observedMutation.callback(), () => doc.defaultView.listeners.get('pagehide')()]) {
  t.playAnnotationDrawAnimation(annotation); trigger();
  assert.equal(children.length, 0, 'Resize, content mutation and document exit remove the temporary drawing layer');
}
t.playAnnotationDrawAnimation(annotation);
mark.rects[0].top += 10;
observedResize.callback();
assert.equal(children.length, 0, 'Layout movement restores the static annotation before stale coordinates can persist');
context.reducedMotionQuery.matches = true;
t.playAnnotationDrawAnimation(annotation);
assert.equal(children.length, 0, 'Reduced motion keeps newly saved annotations static');
assert.equal(mark.dataset.annotationDrawing, undefined);
context.reducedMotionQuery.matches = false;
t.playAnnotationDrawAnimation(annotation);
context.reducedMotionQuery.listeners.get('change')();
assert.equal(children.length, 0, 'Changing the system motion preference immediately restores static marks');
t.playAnnotationDrawAnimation({ ...annotation, source: 'ai' });
assert.equal(children.length, 0, 'AI suggestions do not play the manual creation animation');
assert.match(source, /if \(saved && !existingAnnotationIds\.has\(saved\.id\)\) playAnnotationDrawAnimation\(saved, doc\)/u);
const render = functionSource('renderFrameAnnotations');
assert(render.indexOf('clearAnnotationDrawAnimation(doc)') < render.indexOf('removeMark('), 'Rebuilding marks clears their temporary decorations first');
assert.doesNotMatch(functionSource('updateAnnotationColor').replace('async ', ''), /playAnnotationDrawAnimation/u);
assert.doesNotMatch(source.slice(source.indexOf('.annotation-draw-layer {'), source.indexOf(':is(p,ul,ol)[data-block-id]')), /clip-path|mask:/u, 'The animation never clips text content');
console.log('annotation drawing tests passed');
