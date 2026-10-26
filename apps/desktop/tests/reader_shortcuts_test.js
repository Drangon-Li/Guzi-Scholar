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
function harness(platform = 'MacIntel', desktopPlatform, userAgentDataPlatform) {
  const inputs = new Map(); const buttons = new Map();
  let dialog = null; let active = true;
  const calls = [];
  const context = vm.createContext({
    navigator: { platform, userAgentData: userAgentDataPlatform ? { platform: userAgentDataPlatform } : undefined },
    window: { myScholarDesktop: desktopPlatform ? { platform: desktopPlatform } : undefined },
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
    section('const desktopPlatform =', 'const state ='),
    'state.shortcuts = { ...shortcutDefaults };',
    mapSource, dispatchSource,
    'this.validate = validateShortcutInputs; this.handle = handleApplicationShortcut; this.matches = shortcutMatches; this.capture = capturedShortcut; this.hint = setReaderShortcutHint; this.keys = shortcutInputMap; this.normalizeSettings = normalizedShortcutSettings; this.normalize = normalizeShortcut;',
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
  assert.equal(h.context.state.shortcuts.open_library, `${modifier}+1`);
  assert.equal(h.context.state.shortcuts.open_settings, `${modifier}+,`);
  assert.equal(h.context.state.shortcuts.highlight, `${modifier}+Shift+H`);
  assert.equal(h.context.state.shortcuts.underline, `${modifier}+Shift+U`);
  assert.equal(h.context.state.shortcuts.highlight_note, `${modifier}+Shift+J`);
  assert.equal(h.context.state.shortcuts.underline_note, `${modifier}+Shift+K`);
  assert.equal(h.context.state.shortcuts.full_translation, `${modifier}+Shift+Enter`);
  assert.equal(h.context.state.shortcuts.reflow, `${modifier}+${platform === 'MacIntel' ? 'Option' : 'Alt'}+Enter`);
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


for (const [browser, desktop, expected] of [['MacIntel', 'win32', 'Ctrl'], ['Win32', 'darwin', 'Cmd'], ['MacIntel', 'linux', 'Ctrl']]) {
  assert.equal(harness(browser, desktop).context.state.shortcuts.open_library, `${expected}+1`, 'Native desktop platform takes priority over navigator');
}
assert.equal(harness('MacIntel', undefined, 'Windows').context.state.shortcuts.open_library, 'Ctrl+1', 'Browser userAgentData takes priority over legacy platform');
{
  const h = harness('Win32');
  const ctrlAlt = event({ key: 'r', metaKey: false, ctrlKey: true, shiftKey: false, altKey: true });
  assert.equal(h.context.capture(ctrlAlt), 'Ctrl+Alt+R');
  assert.equal(h.context.normalize('Cmd+Option+P'), 'Windows+Alt+P');
  assert.equal(h.context.capture(event({ key: 'p', altKey: true })), 'Windows+Alt+Shift+P');
  assert.equal(h.context.matches(ctrlAlt, 'Ctrl+Option+R'), true, 'Saved Option aliases still use Alt');
  const custom = h.context.normalizeSettings({ open_library: 'Cmd+Option+P', open_settings: 'Ctrl+Option+S' });
  assert.equal(custom.open_library, 'Windows+Alt+P');
  assert.equal(custom.open_settings, 'Ctrl+Alt+S');
  assert.equal(h.context.matches(event({ key: 'p', shiftKey: false, altKey: true }), custom.open_library), true, 'Custom Command remains Meta rather than becoming Control');
  assert.equal(h.context.matches(event({ key: 'p', metaKey: false, ctrlKey: true, shiftKey: false, altKey: true }), custom.open_library), false);
  const migrated = h.context.normalizeSettings({ open_library: 'Cmd+1', highlight: 'Cmd+Shift+H', reflow: 'Cmd+Option+Enter' });
  assert.equal(migrated.open_library, 'Ctrl+1');
  assert.equal(migrated.highlight, 'Ctrl+Shift+H');
  assert.equal(migrated.reflow, 'Ctrl+Alt+Enter');
  h.context.state.shortcuts = custom;
  assert.equal(h.context.handle(event({ key: 'p', shiftKey: false, altKey: true })), true);
  assert.deepEqual(h.calls, [['view', 'library-view']]);
  for (const shortcut of ['Ctrl+I', 'Ctrl+Shift+F', 'Ctrl+Backspace', 'Ctrl+Delete', 'Ctrl+W']) {
    h.inputs.get('shortcut-full-translation').value = shortcut;
    assert.equal(h.context.validate().valid, false, `${shortcut} cannot shadow Windows built-ins`);
  }
  h.inputs.get('shortcut-full-translation').value = 'Ctrl+Alt+R';
  h.inputs.get('shortcut-reflow').value = 'Ctrl+Option+R';
  assert.equal(h.context.validate().valid, false, 'Alt and Option aliases cannot hide duplicate bindings');
}
const rowShortcutSource = section("document.addEventListener('keydown', (event) => {\n    if (event.defaultPrevented || event.repeat || !state.selectedLibraryJobId)", 'async function refreshLibraryFrom(');
for (const platform of ['MacIntel', 'Win32']) {
  const h = harness(platform); let handleRow; let trashed = false;
  h.context.state.selectedLibraryJobId = 'job';
  h.context.document.addEventListener = (_type, callback) => { handleRow = callback; };
  h.context.document.activeElement = { closest: () => ({ dataset: { jobId: 'job' }, closest: () => ({}) }) };
  h.context.$ = (selector) => selector === 'dialog[open]' ? null : { classList: { contains: () => true } };
  h.context.closeAllRowMenus = () => {};
  h.context.libraryEntryById = () => ({ item: { deleted_at: trashed } });
  h.context.performLibraryRowAction = (id, action) => h.calls.push([id, action]);
  vm.runInContext(rowShortcutSource, h.context);
  const primary = platform === 'MacIntel' ? { metaKey: true, ctrlKey: false } : { metaKey: false, ctrlKey: true };
  const rowEvent = (key, overrides = {}) => event({ key, shiftKey: false, ...primary, target: { closest: () => null }, ...overrides });
  handleRow(rowEvent('i'));
  handleRow(rowEvent('f', { shiftKey: true }));
  handleRow(rowEvent('Backspace'));
  trashed = true;
  handleRow(rowEvent('Delete'));
  assert.deepEqual(h.calls, [['job', 'metadata'], ['job', 'folders'], ['job', 'trash'], ['job', 'restore']]);
  handleRow(rowEvent('i', { metaKey: platform !== 'MacIntel', ctrlKey: platform === 'MacIntel' }));
  assert.equal(h.calls.length, 4, 'The other platform modifier does not invoke row commands');
}
const chatKeydownSource = section("$('#chat-input')?.addEventListener('keydown',", "$('#chat-form').addEventListener('submit',");
const classicSource = fs.readFileSync(path.join(__dirname, '../web/classic/app.js'), 'utf8');
const classicChatSource = classicSource.slice(classicSource.indexOf("  $('#chat-input')?.addEventListener('keydown',"), classicSource.indexOf("  $('#chat-form').addEventListener('submit',"));
for (const platform of ['MacIntel', 'Win32']) {
  for (const chatSource of [chatKeydownSource, classicChatSource]) {
    const h = harness(platform); let handleChat; let submitted = 0; let inserted = '';
    const textarea = { addEventListener: (_type, callback) => { handleChat = callback; }, value: 'question', setRangeText: (text) => { inserted += text; }, dispatchEvent() {} };
    h.context.$ = (selector) => selector === '#chat-input' ? textarea : { requestSubmit: () => { submitted += 1; } };
    h.context.Event = class {};
    vm.runInContext(chatSource, h.context);
    const primary = platform === 'MacIntel' ? { metaKey: true, ctrlKey: false } : { metaKey: false, ctrlKey: true };
    handleChat(event({ key: 'Enter', shiftKey: false, ...primary, currentTarget: textarea, stopPropagation() {} }));
    assert.equal(inserted, '\n', `${platform} primary+Enter inserts a line break`);
    assert.equal(submitted, 0);
    handleChat(event({ key: 'Enter', metaKey: false, ctrlKey: false, shiftKey: false, currentTarget: textarea }));
    assert.equal(submitted, 1, 'Plain Enter sends');
    handleChat(event({ key: 'Enter', ...primary, isComposing: true, currentTarget: textarea }));
    assert.equal(inserted, '\n', 'IME composition does not insert an extra newline');
  }
}
for (const [platform, native, expected] of [['MacIntel', 'darwin', 'macOS · Apple Silicon'], ['MacIntel', 'win32', 'Windows · arm64'], ['Win32', 'win32', 'Windows · x64']]) {
  const h = harness(platform, native); const elements = new Map(); const formatButtons = [{}, {}];
  h.context.$ = (selector) => { if (!elements.has(selector)) elements.set(selector, input('')); return elements.get(selector); };
  h.context.$$ = () => formatButtons;
  vm.runInContext(section('function applyPlatformCopy()', 'const openTabsStorageKey ='), h.context);
  const placeholder = elements.get('#chat-input').placeholder;
  assert(placeholder.includes(native === 'darwin' ? '⌘ Enter' : 'Ctrl+Enter'));
  if (native === 'win32') {
    assert(!elements.get('#shortcut-description').textContent.includes('Command'));
    assert(elements.get('#shortcut-description').textContent.includes('Windows'));
    assert(!elements.get('#app-update-install-hint')?.textContent.includes('暂不支持应用内检查更新'));
    assert(!formatButtons.some((button) => button.title.includes('⌘')));
  }
  vm.runInContext(section('let localTestBuild =', 'async function loadAppInfo()'), h.context);
  h.context.info = { app: { platform: native, arch: expected.endsWith('x64') ? 'x64' : 'arm64' } };
  vm.runInContext('renderAppInfo(info)', h.context);
  assert.equal(elements.get('#app-platform-arch').textContent, expected);
}
for (const [platform, label] of [['MacIntel', 'Cmd+Option+P'], ['Win32', 'Windows+Alt+P']]) {
  const elements = new Map();
  const context = vm.createContext({ navigator: { platform }, window: {}, $: (selector) => { if (!elements.has(selector)) elements.set(selector, {}); return elements.get(selector); } });
  vm.runInContext(classicSource.slice(classicSource.indexOf('  const desktopPlatform ='), classicSource.indexOf('  const state =')) + '\nthis.label = shortcutLabel;', context);
  assert.equal(context.label('Cmd+Option+P'), label, 'Classic settings show platform names without changing custom modifiers');
}
console.log('reader shortcut tests passed (macOS, Windows and browser fallback)');
