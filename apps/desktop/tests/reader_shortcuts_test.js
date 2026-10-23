'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
function section(from, to) {
  const start = source.indexOf(`  ${from}`);
  const end = source.indexOf(`  ${to}`, start);
  assert(start >= 0 && end > start, `${from} section exists`);
  return source.slice(start, end);
}
const mapSource = section('const shortcutInputMap =', 'shortcutInputs().forEach(');
const dispatchSource = section('function shortcutMatches(', "document.addEventListener('keydown', handleApplicationShortcut)");
function input(value) {
  return { value, classList: { toggle() {} }, setAttribute(name, value) { this[name] = value; } };
}
function harness(platform = 'MacIntel') {
  const inputs = new Map(); const buttons = new Map();
  let dialog = null; let active = true;
  const calls = [];
  const context = vm.createContext({
    navigator: { platform },
    state: { activeJob: { job_id: 'job', status: 'completed' }, health: {}, translationRuns: new Map() },
    readerMount: { jobId: 'job', ready: true }, reflowPreflightInFlight: false,
    document: { getElementById: (id) => inputs.get(id) },
    $: (selector) => selector === 'dialog[open]' ? dialog : selector === '#reader-view'
      ? { classList: { contains: () => active } } : buttons.get(selector),
    frameDocument: () => ({}), isEditableAppSurface: (target) => Boolean(target?.editable),
    handleSelectionNumberShortcut: () => false,
    runFullTranslation: (...args) => calls.push(['translate', ...args]),
    startReflow: () => calls.push(['reflow']), activeReflowRun: () => context.reflow,
    reflowRunIsActive: (run) => Boolean(run?.active),
    switchView: (view) => calls.push(['view', view]), showToast() {}, saveAnnotation() {},
    syncTranslationScopeControls() {},
  });
  vm.runInContext([
    section('const shortcutPrimaryModifier =', 'const state ='),
    `state.shortcuts = ${source.match(/ {4}shortcuts: (\{[^\n]+\}),/u)[1]};`,
    mapSource, dispatchSource,
    'this.validate = validateShortcutInputs; this.handle = handleApplicationShortcut; this.matches = shortcutMatches; this.capture = capturedShortcut; this.hint = setReaderShortcutHint; this.keys = shortcutInputMap;',
  ].join('\n'), context);
  Object.entries(context.keys).forEach(([id, setting]) => inputs.set(id, input(context.state.shortcuts[setting])));
  return { context, inputs, calls, setDialog: (value) => { dialog = value; }, setActive: (value) => { active = value; } };
}
function event(overrides = {}) {
  return { key: 'Enter', metaKey: true, ctrlKey: false, shiftKey: true, altKey: false,
    target: {}, preventDefault() { this.defaultPrevented = true; }, ...overrides };
}
for (const [platform, modifier] of [['MacIntel', 'Cmd'], ['Win32', 'Ctrl'], ['Linux x86_64', 'Ctrl']]) {
  const h = harness(platform);
  assert.equal(h.context.state.shortcuts.full_translation, `${modifier}+Shift+Enter`);
  assert.equal(h.context.state.shortcuts.reflow, `${modifier}+Option+Enter`);
  assert.equal(h.context.validate().valid, true);
}
{
  const h = harness();
  h.inputs.get('shortcut-full-translation').value = 'Command+Shift+H';
  assert.equal(h.context.validate().valid, false, 'Aliases cannot hide duplicate bindings');
  for (const shortcut of ['Cmd+F', 'Ctrl+F', 'Cmd+A', 'Ctrl+A', 'Cmd+I', 'Cmd+Shift+F', 'Cmd+Backspace', 'Cmd+Delete', 'Cmd+W']) {
    h.inputs.get('shortcut-full-translation').value = shortcut;
    assert.equal(h.context.validate().valid, false, `${shortcut} is reserved`);
  }
  h.inputs.get('shortcut-full-translation').value = 'Ctrl+Shift+T';
  assert.equal(h.context.validate().valid, true);
  assert.equal(h.context.matches(event({ key: 't', metaKey: false, ctrlKey: true }), 'Ctrl+Shift+T'), true);
  assert.equal(h.context.capture(event({ isComposing: true })), '');
  assert.equal(h.context.capture(event({ repeat: true })), '');
}
{
  const h = harness();
  const e = event();
  assert.equal(h.context.handle(e), true);
  assert.equal(e.defaultPrevented, true);
  assert.deepEqual(h.calls, [['translate']], 'The default scope and cache arguments stay untouched');
  h.context.state.translationRuns.set('job', { running: true });
  assert.equal(h.context.handle(event()), true);
  assert.equal(h.calls.length, 1, 'A running translation is neither restarted nor cancelled');
  h.context.state.shortcuts.full_translation = 'Ctrl+Shift+T';
  assert.equal(h.context.handle(event()), false, 'The old binding stops matching');
}
{
  const h = harness(); const e = () => event({ shiftKey: false, altKey: true });
  assert.equal(h.context.handle(e()), true);
  assert.deepEqual(h.calls, [['reflow']]);
  h.context.reflowPreflightInFlight = true;
  assert.equal(h.context.handle(e()), true);
  h.context.reflowPreflightInFlight = false; h.context.reflow = { active: true };
  assert.equal(h.context.handle(e()), true);
  assert.equal(h.calls.length, 1, 'A running or preflight reflow is not restarted');
}
for (const overrides of [{ defaultPrevented: true }, { repeat: true }, { isComposing: true }, { keyCode: 229 },
  { target: { editable: true } }, { target: { isContentEditable: true } },
  { target: { closest: () => ({}) } }, { target: { ownerDocument: { querySelector: () => ({}) } } }]) {
  const h = harness(); let numberCalls = 0;
  h.context.handleSelectionNumberShortcut = () => { numberCalls += 1; return false; };
  assert.equal(h.context.handle(event(overrides)), false);
  assert.equal(numberCalls, 0, 'Common guards also protect selection number commands');
  assert.equal(h.calls.length, 0);
}
for (const unavailable of ['dialog', 'view', 'status', 'ready', 'mount', 'readonly']) {
  const h = harness();
  if (unavailable === 'dialog') h.setDialog({});
  if (unavailable === 'view') h.setActive(false);
  if (unavailable === 'status') h.context.state.activeJob.status = 'running';
  if (unavailable === 'ready') h.context.readerMount.ready = false;
  if (unavailable === 'mount') h.context.readerMount.jobId = 'other';
  if (unavailable === 'readonly') h.context.state.health.readonly = true;
  assert.equal(h.context.handle(event()), false, unavailable);
  assert.equal(h.context.handle(event({ shiftKey: false, altKey: true })), false, unavailable);
  assert.equal(h.calls.length, 0);
}
{
  const h = harness();
  h.context.handleSelectionNumberShortcut = () => true;
  assert.equal(h.context.handle(event()), true);
  assert.equal(h.calls.length, 0, 'Selection commands dispatch before application bindings');
  h.context.state.shortcuts.reflow = 'Ctrl+Option+R';
  const button = input('');
  h.context.hint(button, 'reflow', 'AI 重排');
  assert.equal(button.title, 'AI 重排（Ctrl+Option+R）');
  assert.equal(button['aria-label'], button.title);
  assert.equal(button['aria-keyshortcuts'], 'Ctrl+Alt+R');
}
const tabKeydownSource = section(
  "  container.querySelectorAll('.document-tab').forEach((tab) => tab.addEventListener('keydown',",
  "  container.querySelectorAll('[data-close-job-id]')",
);
function wireTabKeydown(context) {
  let handler; let clicks = 0;
  const tab = {
    dataset: { jobId: 'job' },
    addEventListener(type, callback) { assert.equal(type, 'keydown'); handler = callback; },
    click() { clicks += 1; },
  };
  context.container = { querySelectorAll: () => [tab] };
  vm.runInContext(tabKeydownSource, context);
  return { tab, handle: (e) => handler(e), clicks: () => clicks };
}
for (const key of ['Enter', ' ']) {
  const h = harness(); const tab = wireTabKeydown(h.context);
  const e = event({ key, metaKey: false, shiftKey: false, target: tab.tab });
  tab.handle(e);
  assert.equal(e.defaultPrevented, true, `Ordinary ${key} activates the document tab`);
  assert.equal(tab.clicks(), 1);
}
for (const [platform, modifiers, action] of [
  ['MacIntel', { metaKey: true, shiftKey: true, altKey: false }, 'translate'],
  ['MacIntel', { metaKey: true, shiftKey: false, altKey: true }, 'reflow'],
  ['Win32', { metaKey: false, ctrlKey: true, shiftKey: true, altKey: false }, 'translate'],
  ['Win32', { metaKey: false, ctrlKey: true, shiftKey: false, altKey: true }, 'reflow'],
]) {
  const h = harness(platform); const tab = wireTabKeydown(h.context);
  const e = event({ ...modifiers, target: tab.tab,
    stopPropagation() { this.propagationStopped = true; },
    stopImmediatePropagation() { this.propagationStopped = true; },
  });
  tab.handle(e);
  assert.equal(Boolean(e.defaultPrevented), false, `${platform} ${action} is not consumed by tab activation`);
  assert.equal(Boolean(e.propagationStopped), false, 'The application shortcut can continue bubbling');
  assert.equal(tab.clicks(), 0, 'Modified Enter must not activate the focused tab');
  assert.equal(h.context.handle(e), true);
  assert.deepEqual(h.calls, [[action]], 'The bubbled event reaches the application command');
}
console.log('reader shortcut tests passed');
