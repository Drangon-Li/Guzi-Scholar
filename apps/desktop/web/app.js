(async () => {
  // Browser application composition (kept in one compatibility entrypoint):
  // shell/tabs -> import/library -> reader/annotations -> translation/AI ->
  // notes/settings -> startup. README.md documents the cross-file data flow.
  // Shared primitives live in core.js; see that file for the split rationale.
  const {
    $,
    $$,
    flushPersistentStateWrites,
    formatBytes,
    isDesktopApp,
    persistentStateGet,
    persistentStateRemove,
    persistentStateSet,
    pausePersistentStateWrites,
    resumePersistentStateWrites,
  } = window.MyScholarCore;
  const browserDemo = window.MyScholarDemo?.enabled ? window.MyScholarDemo : null;
  let demoResetting = false;
  if (browserDemo) window.addEventListener('my-scholar-demo-invalidated', showBrowserDemoInvalidation);
  if (browserDemo) {
    try {
      await window.MyScholarCore.ready;
      await browserDemo.ready;
    } catch (_) {
      if (browserDemo.invalidated) { showBrowserDemoInvalidation(); return; }
      document.title = '谷子学术 · 本地测试版启动失败';
      const notice = document.createElement('div');
      notice.id = 'browser-demo-startup-error';
      notice.className = 'browser-demo-ai-notice';
      notice.setAttribute('role', 'alert');
      const message = document.createElement('p');
      message.textContent = '浏览器本地测试版无法启动。请刷新页面，并确认浏览器允许本网站使用本地存储。若仍失败，请稍后重试。';
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'secondary-button compact-button';
      retry.textContent = '刷新重试';
      retry.addEventListener('click', () => location.reload());
      notice.append(message, retry);
      document.body.prepend(notice);
      return;
    }
  } else {
    await window.MyScholarCore.ready;
  }
  if (browserDemo?.invalidated) { showBrowserDemoInvalidation(); return; }
  const request = async (url, options = {}) => {
    if (demoResetting) return Promise.reject(new Error('正在重置测试数据。'));
    if (browserDemo?.invalidated) return Promise.reject(new Error('测试数据已重置，请刷新后继续。'));
    const { closeSave = false, closeBarrier = true, ...fetchOptions } = options;
    if (request.closeGate) await waitForCloseResume(closeSave);
    const operation = browserDemo ? browserDemo.fetch(url, fetchOptions) : fetch(url, fetchOptions);
    const pendingWrite = closeBarrier && !closeSave && !['GET', 'HEAD'].includes(String(options.method || 'GET').toUpperCase());
    if (pendingWrite) request.inFlightWrites.add(operation);
    let response;
    try { response = await operation; }
    finally { if (pendingWrite) request.inFlightWrites.delete(operation); }
    await waitForCloseResume(closeSave);
    return response;
  };
  request.inFlightWrites = new Set();
  async function waitForCloseResume(closeSave = false) {
    while (request.closeGate && !(closeSave && request.closeGate.allowSave)) await request.closeGate.changed;
  }

  const appearanceDefaults = Object.freeze({ app_font: 'system', reader_font: 'academic', accent: 'amber' });
  const appearanceOptions = Object.freeze({
    app_font: new Set(['system', 'pingfang', 'songti']),
    reader_font: new Set(['academic', 'songti', 'georgia', 'sans']),
    accent: new Set(['amber', 'blue', 'emerald', 'violet', 'rose', 'graphite']),
  });
  const appFontStacks = Object.freeze({
    system: '"SF Pro Text", "SF Pro Display", -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", "Segoe UI", sans-serif',
    pingfang: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
    songti: '"Songti SC", STSong, "Noto Serif CJK SC", serif',
  });
  const readerFontStacks = Object.freeze({
    academic: '"Times New Roman", Times, "Songti SC", STSong, "Noto Serif CJK SC", serif',
    songti: '"Songti SC", STSong, "Noto Serif CJK SC", serif',
    georgia: 'Georgia, "Times New Roman", Times, serif',
    sans: '"SF Pro Text", -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", "Segoe UI", sans-serif',
  });
  function normalizeGraphViewportScale(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0.85;
    return Math.min(1.3, Math.max(0.6, numeric));
  }
  const accentTokens = Object.freeze({
    light: {
      amber: { accent: '#b45309', dark: '#92400e', soft: '#fff3d6', fill: '#b45309', hover: '#92400e', on: '#ffffff' },
      blue: { accent: '#2563eb', dark: '#1d4ed8', soft: '#eff6ff', fill: '#2563eb', hover: '#1d4ed8', on: '#ffffff' },
      emerald: { accent: '#047857', dark: '#065f46', soft: '#ecfdf5', fill: '#047857', hover: '#065f46', on: '#ffffff' },
      violet: { accent: '#7c3aed', dark: '#6d28d9', soft: '#f5f3ff', fill: '#7c3aed', hover: '#6d28d9', on: '#ffffff' },
      rose: { accent: '#be123c', dark: '#9f1239', soft: '#fff1f2', fill: '#be123c', hover: '#9f1239', on: '#ffffff' },
      graphite: { accent: '#4b5563', dark: '#374151', soft: '#f1f5f9', fill: '#475569', hover: '#374151', on: '#ffffff' },
    },
    dark: {
      amber: { accent: '#f3b34c', dark: '#ffd07a', soft: '#3a2b16', fill: '#b45309', hover: '#92400e', on: '#ffffff' },
      blue: { accent: '#60a5fa', dark: '#93c5fd', soft: '#172554', fill: '#2563eb', hover: '#1d4ed8', on: '#ffffff' },
      emerald: { accent: '#34d399', dark: '#6ee7b7', soft: '#022c22', fill: '#047857', hover: '#065f46', on: '#ffffff' },
      violet: { accent: '#a78bfa', dark: '#c4b5fd', soft: '#2e1065', fill: '#7c3aed', hover: '#6d28d9', on: '#ffffff' },
      rose: { accent: '#fb7185', dark: '#fda4af', soft: '#4c0519', fill: '#be123c', hover: '#9f1239', on: '#ffffff' },
      graphite: { accent: '#94a3b8', dark: '#cbd5e1', soft: '#1e293b', fill: '#475569', hover: '#374151', on: '#ffffff' },
    },
  });
  const typographyDefaults = Object.freeze({ fontSize: 100, lineHeight: 172, pageMargin: 100 });
  const typographyLimits = Object.freeze({
    fontSize: Object.freeze({ min: 70, max: 200 }),
    lineHeight: Object.freeze({ min: 100, max: 300 }),
    pageMargin: Object.freeze({ min: 0, max: 250 }),
  });
  const desktopPlatform = window.myScholarDesktop?.platform;
  const browserPlatform = navigator.userAgentData?.platform || navigator.platform || '';
  const appPlatform = ['darwin', 'win32', 'linux'].includes(desktopPlatform) ? desktopPlatform
    : /mac/iu.test(browserPlatform) ? 'darwin' : /win/iu.test(browserPlatform) ? 'win32' : 'linux';
  const isMacPlatform = appPlatform === 'darwin';
  const shortcutPrimaryModifier = isMacPlatform ? 'Cmd' : 'Ctrl';
  const shortcutAltModifier = isMacPlatform ? 'Option' : 'Alt';
  const shortcutMetaModifier = isMacPlatform ? 'Cmd' : appPlatform === 'win32' ? 'Windows' : 'Meta';
  const shortcutModifierDescription = isMacPlatform ? 'Command 或 Control' : `Control 或 ${shortcutMetaModifier}`;
  const primaryShortcutLabel = (key) => isMacPlatform ? `⌘${key.replace('Shift+', '⇧').replace('Backspace', '⌫')}` : `Ctrl+${key}`;
  const primaryModifierPressed = (event) => isMacPlatform ? event.metaKey : event.ctrlKey;
  const shortcutDefaults = Object.freeze({ open_library: `${shortcutPrimaryModifier}+1`, open_settings: `${shortcutPrimaryModifier}+,`, highlight: `${shortcutPrimaryModifier}+Shift+H`, underline: `${shortcutPrimaryModifier}+Shift+U`, highlight_note: `${shortcutPrimaryModifier}+Shift+J`, underline_note: `${shortcutPrimaryModifier}+Shift+K`, full_translation: `${shortcutPrimaryModifier}+Shift+Enter`, reflow: `${shortcutPrimaryModifier}+${shortcutAltModifier}+Enter` });
  const state = {
    aiProfiles: {}, aiModelCapabilities: {},
    jobs: [], activeJob: null, selection: null, chatSelection: null, annotations: [], aiHighlights: [], chat: [], chatSessions: new Map(),
    openDocuments: [], translationCache: [], translationCaches: new Map(), translationRun: null, translationRuns: new Map(),
    translationPreferences: { displayMode: 'bilingual' },
    annotationActions: { hidden_builtin: [], custom: [], show_shortcut_hints: true },
    mediaLayouts: new Map(),
    health: null, library: null, activeFolderId: 'system-all', activeViewId: 'view-all', librarySort: 'updated_at-desc', libraryStatusFilter: '', libraryMode: 'list', primaryView: 'library-view',
    selectedLibraryJobId: null, selectedLibraryJobIds: new Set(), activeGroupValue: null, groupingMenuOpen: false,
    graphController: null, graphData: null, graphConfig: { showSimilarity: false, showAttributes: true, attributeIds: null, topK: 2, viewportScale: 0.85 },
    inlineImportanceSaving: new Set(),
    assistantInitialized: false, quickPreview: null, highlightColor: '#f59e0b', annotationColors: { highlight: '#f59e0b', underline: '#f59e0b' }, appearance: { ...appearanceDefaults }, pendingAppearance: { ...appearanceDefaults },
    shortcuts: { ...shortcutDefaults },
    highlightFilter: 'all', typography: { ...typographyDefaults }, importQueue: [], importRunning: false, metadataAutoRetrieve: true,
  };
  function applyPlatformCopy() {
    const chatInput = $('#chat-input');
    if (chatInput) chatInput.placeholder = `针对当前文章提问…（Enter 发送，${isMacPlatform ? '⌘ Enter' : 'Ctrl+Enter'} 换行）`;
    $$('[data-format="bold"], [data-note-format="bold"]').forEach((button) => { button.title = `加粗（${primaryShortcutLabel('B')}）`; });
    $$('[data-format="italic"], [data-note-format="italic"]').forEach((button) => { button.title = `斜体（${primaryShortcutLabel('I')}）`; });
    const shortcutDescription = $('#shortcut-description');
    if (shortcutDescription) shortcutDescription.textContent = `点击字段后按下组合键；为避免误触，快捷键需要包含 ${shortcutModifierDescription}。`;
  }
  applyPlatformCopy();
  const openTabsStorageKey = 'my-scholar-open-documents';
  const readingLocationsStorageKey = 'my-scholar-reading-locations-v1';
  const readingLocationsVersion = 1;
  const readingLocationsMaxEntries = 256;
  const readingLocationsMaxBytes = 128 * 1024;
  const readerJobIdPattern = /^[a-f0-9]{16}$/u;
  const readerBlockIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/u;
  const articleNoteDraftStorageKey = 'my-scholar-article-note-drafts-v1';
  const translationPreferencesStorageKey = 'my-scholar-translation-preferences-v1';
  const translationDisplayStorageKey = 'my-scholar-translation-display-v1';
  let translationDisplayChoices = {};
  try {
    const saved = JSON.parse(persistentStateGet(translationDisplayStorageKey) || '{}');
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) translationDisplayChoices = saved;
  } catch (_) { /* Keep existing translations when a preference cannot be read. */ }
  try {
    state.translationPreferences = normalizedTranslationPreferences(JSON.parse(persistentStateGet(translationPreferencesStorageKey) || 'null'));
  } catch (_) { /* Ignore malformed local display preferences. */ }
  const graphPreferencesStorageKey = 'my-scholar-graph-preferences-v2';
  const legacyGraphPreferencesStorageKey = 'my-scholar-graph-preferences-v1';
  try {
    const currentGraphConfig = JSON.parse(persistentStateGet(graphPreferencesStorageKey) || 'null');
    const hasCurrentGraphConfig = Boolean(currentGraphConfig && typeof currentGraphConfig === 'object' && !Array.isArray(currentGraphConfig));
    const storedGraphConfig = hasCurrentGraphConfig
      ? currentGraphConfig
      : JSON.parse(persistentStateGet(legacyGraphPreferencesStorageKey) || 'null');
    if (storedGraphConfig && typeof storedGraphConfig === 'object') {
      state.graphConfig = {
        ...state.graphConfig,
        showSimilarity: hasCurrentGraphConfig && storedGraphConfig.showSimilarity === true,
        showAttributes: storedGraphConfig.showAttributes !== false,
        attributeIds: Array.isArray(storedGraphConfig.attributeIds) ? storedGraphConfig.attributeIds.map(String) : null,
        viewportScale: normalizeGraphViewportScale(storedGraphConfig.viewportScale ?? storedGraphConfig.nodeScale),
      };
    }
  } catch (_) { /* Ignore malformed local display preferences. */ }
  function finiteBetween(value, minimum, maximum) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : null;
  }

  function normalizedReadingLocation(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const blockId = String(value.blockId || '');
    const page = Number(value.page);
    const offsetPx = finiteBetween(value.offsetPx, 0, 1_000_000);
    const offsetRatio = finiteBetween(value.offsetRatio, 0, 1);
    const blockHeight = finiteBetween(value.blockHeight, 1, 1_000_000);
    const progress = finiteBetween(value.progress, 0, 1);
    const generation = String(value.generation || 'base');
    const updatedAt = new Date(String(value.updatedAt || ''));
    if (!readerBlockIdPattern.test(blockId) || !Number.isInteger(page) || page < 1 || page > 100_000
      || offsetPx === null || offsetRatio === null || blockHeight === null || progress === null
      || !/^(?:base|[1-9][0-9]{0,8})$/u.test(generation) || !Number.isFinite(updatedAt.getTime())) return null;
    return { blockId, page, offsetPx, offsetRatio, blockHeight, progress, generation, updatedAt: updatedAt.toISOString() };
  }

  function readingLocationsByteLength(value) {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  }

  function normalizeReadingLocations(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) && value.version === readingLocationsVersion ? value : {};
    const sourceLocations = source.locations && typeof source.locations === 'object' && !Array.isArray(source.locations) ? source.locations : {};
    const result = { version: readingLocationsVersion, lastActiveJobId: null, locations: {}, lru: [] };
    const seen = new Set();
    const order = [
      ...(Array.isArray(source.lru) ? source.lru : []),
      ...Object.keys(sourceLocations).sort((left, right) => String(sourceLocations[right]?.updatedAt || '').localeCompare(String(sourceLocations[left]?.updatedAt || ''))),
    ];
    for (const rawJobId of order) {
      const jobId = String(rawJobId || '');
      if (seen.has(jobId) || !readerJobIdPattern.test(jobId)) continue;
      seen.add(jobId);
      const location = normalizedReadingLocation(sourceLocations[jobId]);
      if (!location || result.lru.length >= readingLocationsMaxEntries) continue;
      result.locations[jobId] = location;
      result.lru.push(jobId);
      if (readingLocationsByteLength(result) > readingLocationsMaxBytes) {
        delete result.locations[jobId];
        result.lru.pop();
      }
    }
    const lastActiveJobId = String(source.lastActiveJobId || '');
    if (readerJobIdPattern.test(lastActiveJobId) && result.locations[lastActiveJobId]) result.lastActiveJobId = lastActiveJobId;
    return result;
  }

  let readingLocationsState;
  try {
    readingLocationsState = normalizeReadingLocations(JSON.parse(persistentStateGet(readingLocationsStorageKey) || 'null'));
  } catch (_) {
    readingLocationsState = normalizeReadingLocations(null);
  }
  let readerMountSequence = 0;
  let readerMount = null;
  const readerMounts = new Map();
  const readerDocumentStates = new WeakMap();
  function readerDocumentState(doc) {
    if (!readerDocumentStates.has(doc)) readerDocumentStates.set(doc, {});
    return readerDocumentStates.get(doc);
  }
  let readerSections = [];
  const readerSearchState = {
    open: false,
    query: '',
    matches: [],
    activeIndex: -1,
    usingCustomHighlight: false,
  };
  function persistReadingLocations() {
    readingLocationsState = normalizeReadingLocations(readingLocationsState);
    persistentStateSet(readingLocationsStorageKey, JSON.stringify(readingLocationsState));
  }

  function rememberReadingLocation(jobId, location) {
    const normalized = normalizedReadingLocation(location);
    if (!readerJobIdPattern.test(String(jobId || '')) || !normalized) return false;
    readingLocationsState.locations[jobId] = normalized;
    readingLocationsState.lru = [jobId, ...readingLocationsState.lru.filter((candidate) => candidate !== jobId)].slice(0, readingLocationsMaxEntries);
    readingLocationsState.lastActiveJobId = jobId;
    persistReadingLocations();
    return true;
  }
  let activeJobId = null;
  let importQueueDismissTimer = null;
  let importControllerPromise = null;
  const importUploadTasks = new Set();
  let importLibraryRefreshTimer = null;
  let importLibraryRefreshInFlight = null;
  let importLibraryRefreshPending = false;
  let importPollFailures = 0;
  const importMetadataWatches = new Map();
  let importMetadataPollTimer = null;
  let importMetadataPollInFlight = null;
  let notesTimer = null;
  let pendingNotesSnapshot = null;
  let notesSaveQueue = Promise.resolve();
  let notesStatusTimer = null;
  let notesEditorRevision = 0;
  let notesEditorSession = 0;
  let articleNoteImageRange = null;
  const articleNoteDrafts = new Map();
  const articleNoteServerRevisions = new Map();
  const articleNoteConflicts = new Map();
  const assistantOverlayQuery = window.matchMedia('(max-width: 880px)');
  const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const colorSchemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
  const transientCloseTimers = new WeakMap();
  function openTransient(node) {
    if (!node) return false;
    const timer = transientCloseTimers.get(node);
    if (timer) window.clearTimeout(timer);
    transientCloseTimers.delete(node);
    node.classList.remove('is-closing');
    node.inert = false;
    node.hidden = false;
    return true;
  }
  function closeTransient(node, { immediate = false, duration = 160, onFinish = null } = {}) {
    if (!node || node.hidden) {
      if (typeof onFinish === 'function') onFinish();
      return false;
    }
    const prior = transientCloseTimers.get(node);
    if (prior) window.clearTimeout(prior);
    const finish = () => {
      transientCloseTimers.delete(node);
      node.hidden = true;
      node.classList.remove('is-closing');
      if (typeof onFinish === 'function') onFinish();
    };
    node.classList.add('is-closing');
    node.inert = true;
    const complete = () => {
      node.inert = false;
      finish();
    };
    if (immediate || reducedMotionQuery.matches) complete();
    else transientCloseTimers.set(node, window.setTimeout(complete, duration));
    return true;
  }
  const assistantWidthStorageKey = 'my-scholar-assistant-width-v1';
  const assistantDefaultWidth = 380;
  const assistantMinWidth = 320;
  const assistantMaxWidth = 620;
  const assistantMinReaderWidth = 520;
  const storedAssistantWidth = Number.parseFloat(persistentStateGet(assistantWidthStorageKey) || '');
  let assistantPreferredWidth = Number.isFinite(storedAssistantWidth) ? storedAssistantWidth : assistantDefaultWidth;
  const assistantResize = { active: false, pointerId: null, startX: 0, startWidth: assistantDefaultWidth };
  let imageLightboxTrigger = null;
  let imageLightboxDetails = null;
  let imageLightboxCloseTimer = null;
  let imageContextTrigger = null;
  let imageContextDetails = null;
  const mediaWidthMinimum = 24;
  const mediaWidthMaximum = 100;
  const mediaLayoutSaveQueues = new Map();
  const mediaResize = {
    active: false, pointerId: null, handle: null, block: null, doc: null, jobId: '', key: '', side: 'right',
    startX: 0, startWidth: 0, containerWidth: 0, startPercent: mediaWidthMaximum, currentPercent: mediaWidthMaximum,
  };
  let mobileSidebarTrigger = null;
  let mobileDetailsTrigger = null;

  if (window.myScholarDesktop?.platform === 'darwin') document.documentElement.classList.add('desktop-macos');

  const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const requestAPI = async (url, options = {}) => {
    const response = await request(url, options);
    const payload = await response.json().catch(() => ({}));
    await waitForCloseResume(options.closeSave === true);
    if (!response.ok) {
      const errorBody = payload?.error && typeof payload.error === 'object' ? payload.error : {};
      const error = new Error(String(errorBody.message || payload.error || payload.message || `请求失败（${response.status}）`));
      error.code = String(payload.code || errorBody.code || 'http_error');
      error.details = payload.details || errorBody.details || {};
      error.status = response.status;
      throw error;
    }
    return payload;
  };
  const annotationOperations = window.MyScholarAnnotationOperations.create({
    request: requestAPI, getCloseGate: () => request.closeGate, waitForCloseResume,
    state, mounts: readerMounts, getCurrentMount: () => readerMount,
    isCurrentMount: readerMountIsCurrent, matchesMount: readerMountMatches, isAIAnnotation,
  });
  const api = annotationOperations.api;
  const jsonOptions = (body, method = 'POST') => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const pluginHost = window.MyScholarPluginHost.create({
    api, jsonOptions, navigate: openPrimaryView, toast: showToast, confirm: requestConfirmation,
    onRemoved: () => switchView('library-view'),
    onContributionsChanged: renderSelectionActions,
    openSource: openPluginSource,
    translate: async (term, jobId) => {
      if (!aiServiceEnabled('translation')) throw new Error('翻译服务当前不可用，词条已保留，可稍后重试。');
      return (await requestTranslation(term, null, [], { jobId })).text;
    },
  });
  const market = window.MyScholarMarket.create({ host: pluginHost, escapeHTML, confirm: requestConfirmation, navigate: openPrimaryView, toast: showToast });
  const mcpSettings = window.MyScholarMcpSettings.create({ api, jsonOptions, escapeHTML, confirm: requestConfirmation, toast: showToast });

  const onboarding = window.MyScholarOnboarding.create({ reducedMotionQuery });
  window.MyScholarZoteroImport.create({
    dialog: $('#zotero-import-dialog'), request: api,
    getTargetFolder: () => { const folder = folderById(state.activeFolderId); return folder && !folder.system ? { id: folder.id, name: folder.name } : null; },
    onComplete: async () => { await loadLibrary(); },
  });

  function healthAIService(service) {
    return state.health?.ai?.services?.[service] || null;
  }

  function aiServiceEnabled(service) {
    return healthAIService(service)?.enabled !== false;
  }

  function translationProfileId() {
    return String(healthAIService('translation')?.profile_id || '');
  }

  function translationsForActiveProfile(records) {
    const values = Array.isArray(records) ? records : [];
    const normalizedLanguage = (value) => ['zh', 'ZH', '中文', 'Chinese'].includes(String(value)) ? 'zh' : String(value).toLowerCase();
    const choices = translationDisplayChoices[state.activeJob?.job_id] || {};
    return values.filter((record) => normalizedLanguage(record?.target_language) === normalizedLanguage(translationTargetLanguage()))
      .slice().sort((left, right) => {
        const chosen = (record) => choices[record.block_id] === translationRecordIdentity(record) ? 1 : 0;
        return chosen(right) - chosen(left) || String(right.updated_at || '').localeCompare(String(left.updated_at || ''));
      });
  }

  function translationRecordIdentity(record) {
    return record.cache_key || [record.profile_id || '', record.source_hash || '', record.alignment_version || ''].join(':');
  }

  function rememberDisplayedTranslation(jobId, record) {
    if (!jobId || !record?.block_id) return;
    translationDisplayChoices[jobId] ||= {};
    translationDisplayChoices[jobId][record.block_id] = translationRecordIdentity(record);
    persistentStateSet(translationDisplayStorageKey, JSON.stringify(translationDisplayChoices));
  }

  function translationProviderLabel(record) {
    const snapshot = record?.provider_snapshot || {};
    return snapshot.model || record?.model || snapshot.provider || record?.provider || '先前保存的译文';
  }

  function translationCacheFor(jobId = state.activeJob?.job_id) {
    const key = String(jobId || '');
    if (!key || key === state.activeJob?.job_id) return state.translationCache;
    return state.translationCaches.get(key) || [];
  }

  function setTranslationCacheFor(jobId, records) {
    const key = String(jobId || '');
    // Display choices and request-cache identities are independent.
    const value = Array.isArray(records) ? records : [];
    if (key && (state.openDocuments.some((job) => job.job_id === key) || state.translationRuns.get(key)?.running)) state.translationCaches.set(key, value);
    if (!key || key === state.activeJob?.job_id) state.translationCache = value;
    return value;
  }

  function selectionElement(rootDocument, event) {
    const eventNode = event?.target;
    const eventElement = eventNode?.nodeType === Node.TEXT_NODE ? eventNode.parentElement : eventNode;
    if (event?.type === 'selectstart' && eventElement) return eventElement;
    if (eventElement?.closest?.('input, textarea, [contenteditable="true"]')) return eventElement;
    const selection = rootDocument?.getSelection?.();
    const node = (!selection?.isCollapsed && selection?.anchorNode) || event?.target || rootDocument?.activeElement;
    if (!node) return null;
    return node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  }

  function isEditableAppSurface(element) {
    return Boolean(element?.closest?.('input, textarea, select, [contenteditable="true"], .chat-bubble, .copyable-data, .library-details, .vocabulary-card, .vocabulary-review'));
  }

  function guardAppSelection(event) {
    if (!isEditableAppSurface(selectionElement(document, event))) event.preventDefault();
  }

  // Keep navigation, library metadata and action labels from becoming
  // accidental clipboard content; fields, notes and chat replies stay copyable.
  document.addEventListener('selectstart', guardAppSelection);
  document.addEventListener('copy', guardAppSelection);

  // Application shell, primary views, assistant visibility and document tabs.
  function showError(message) {
    const node = $('#upload-error');
    delete node.dataset.importPollError;
    node.textContent = message || '';
    node.hidden = !message;
  }

  // The outgoing view stays painted for one short exit animation, laid over
  // the incoming one; the new view is active synchronously, so callers and
  // tests that look for `.active-view` right away still find it.
  function retireView(view) {
    if (view.id === 'reader-view' && readerMounts.size) {
      // display:none collapses iframe viewports and can reset their live scroll.
      const { width, height } = view.getBoundingClientRect();
      view.style.setProperty('--parked-reader-width', `${width}px`);
      view.style.setProperty('--parked-reader-height', `${height}px`);
      view.classList.add('is-reader-parked');
      view.inert = true;
      view.setAttribute('aria-hidden', 'true');
      return;
    }
    if (reducedMotionQuery.matches) {
      view.hidden = true;
      return;
    }
    view.classList.add('is-leaving');
    const finish = () => {
      if (!view.classList.contains('is-leaving')) return;
      view.classList.remove('is-leaving');
      if (!view.classList.contains('active-view')) view.hidden = true;
    };
    view.addEventListener('animationend', finish, { once: true });
    window.setTimeout(finish, 240);
  }
  function switchView(viewId, { enteringDocumentId = null } = {}) {
    if (browserDemo && ['market-view', 'plugin-preview-view'].includes(viewId)) {
      showToast('浏览器本地测试版不安装或开发插件，请使用桌面版。');
      return;
    }
    if (viewId !== 'plugin-preview-view') void market.leavePreview();
    if (viewId !== 'library-view' && state.groupingMenuOpen) setGroupingMenuOpen(false);
    if (viewId !== 'library-view' && viewId !== 'views-view') closeLibraryCellEditor();
    if (viewId !== 'reader-view') closeChatSessionMenu();
    if (viewId !== 'reader-view') closeTranslationScopeMenu();
    if (viewId !== 'reader-view') closeReaderSearch({ reset: true });
    if (viewId !== 'reader-view' && $('#reader-view')?.classList.contains('active-view')) captureCurrentReadingLocation();
    if (viewId !== 'settings-view' && $('#settings-view')?.classList.contains('active-view')) {
      void flushPendingSettings();
      // The section hash exists so a reload lands back on the open settings
      // category. Once the user leaves settings it must not hijack the next
      // reload, so drop it together with the view.
      if (/^#settings-[a-z-]+$/u.test(location.hash)) history.replaceState(null, '', location.pathname + location.search);
    }
    if (viewId !== 'library-view' && state.graphController) teardownLibraryGraph();
    if (viewId !== 'reader-view') {
      closeImageContextMenu();
      closeImageLightbox({ restoreFocus: false });
    }
    if (viewId !== 'reader-view' && state.activeJob) {
      flushPendingArticleNotes(state.activeJob.job_id);
    }
    $$('.view').forEach((view) => {
      const active = view.id === viewId;
      if (active) {
        view.classList.remove('is-leaving');
        view.classList.remove('is-reader-parked');
        view.inert = false;
        view.removeAttribute('aria-hidden');
        view.hidden = false;
      } else if (view.classList.contains('active-view')) {
        retireView(view);
      } else if (!view.classList.contains('is-leaving') && !view.classList.contains('is-reader-parked')) {
        view.hidden = true;
      }
      view.classList.toggle('active-view', active);
    });
    if (viewId !== 'reader-view') state.primaryView = viewId === 'plugin-preview-view' ? 'market-view' : viewId;
    // The document tab is the active surface while reading. Keep the library
    // or saved-view context in state for returning there, but do not paint a
    // second, misleading underline in the primary navigation.
    const activeNavView = viewId === 'reader-view' ? null : viewId === 'plugin-preview-view' ? 'market-view' : viewId;
    $$('.nav-button').forEach((button) => button.classList.toggle('active', button.dataset.view === activeNavView));
    document.body.classList.toggle('reader-mode', viewId === 'reader-view');
    // Open document tabs remain available outside the reader, but only the
    // surface currently on screen may own the single active underline.
    renderDocumentTabs({ enteringJobId: enteringDocumentId });
    if (viewId === 'reader-view') {
      if (!state.assistantInitialized) {
        setAssistantOpen(!assistantOverlayQuery.matches);
        state.assistantInitialized = true;
      }
    }
    if (viewId === 'library-view') renderLibrary(state.jobs, { reuse: true });
    if (viewId === 'views-view') renderViews();
    pluginHost.openView(viewId);
    if (viewId === 'market-view') void market.load();
    if (viewId === 'settings-view') {
      loadSettings();
      window.requestAnimationFrame(updateSettingsNavigation);
    }
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  function openPrimaryView(viewId) {
    if (viewId === 'library-view') {
      state.activeViewId = null;
      state.activeFolderId ||= 'system-all';
    }
    switchView(viewId);
  }
  $$('.nav-button').forEach((button) => button.addEventListener('click', () => openPrimaryView(button.dataset.view)));

  const settingsNavigationLinks = $$('.settings-navigation a[href^="#settings-"]');
  let activeSettingsSectionId = settingsNavigationLinks[0]?.getAttribute('href')?.slice(1) || 'settings-reading';
  function setActiveSettingsNavigation(targetId) {
    settingsNavigationLinks.forEach((link) => {
      const active = link.getAttribute('href') === `#${targetId}`;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
  }
  function showSettingsSection(targetId, { updateHash = true, scroll = true } = {}) {
    const sections = $$('.settings-section');
    const target = sections.find((section) => section.id === targetId) || sections[0];
    if (!target) return;
    activeSettingsSectionId = target.id;
    sections.forEach((section) => {
      const active = section === target;
      section.hidden = !active;
      section.classList.toggle('is-active', active);
    });
    setActiveSettingsNavigation(target.id);
    if (!browserDemo && target.id === 'settings-parsing') void loadParsingProviders();
    if (!browserDemo && target.id === 'settings-mcp') void mcpSettings.load();
    if (updateHash && location.hash !== `#${target.id}`) history.replaceState(null, '', `#${target.id}`);
    if (scroll) window.scrollTo({ top: 0, behavior: 'auto' });
  }
  function updateSettingsNavigation() {
    if (!$('#settings-view')?.classList.contains('active-view')) return;
    showSettingsSection(activeSettingsSectionId, { updateHash: false, scroll: false });
  }
  settingsNavigationLinks.forEach((link) => link.addEventListener('click', (event) => {
    event.preventDefault();
    showSettingsSection(link.getAttribute('href')?.slice(1));
  }));

  function assistantWidthBounds() {
    const gridWidth = $('.reader-grid')?.clientWidth || window.innerWidth;
    const maximum = Math.max(assistantMinWidth, Math.min(assistantMaxWidth, gridWidth - assistantMinReaderWidth));
    return { minimum: assistantMinWidth, maximum };
  }

  function applyAssistantWidth({ persist = false } = {}) {
    const { minimum, maximum } = assistantWidthBounds();
    const width = Math.round(Math.max(minimum, Math.min(maximum, assistantPreferredWidth)));
    $('#reader-view')?.style.setProperty('--reader-assistant-width', `${width}px`);
    const handle = $('#reader-sidebar-resizer');
    if (handle) {
      handle.setAttribute('aria-valuemin', String(minimum));
      handle.setAttribute('aria-valuemax', String(Math.round(maximum)));
      handle.setAttribute('aria-valuenow', String(width));
    }
    if (persist) {
      assistantPreferredWidth = width;
      persistentStateSet(assistantWidthStorageKey, String(width));
    }
    return width;
  }

  function finishAssistantResize(event = null) {
    if (!assistantResize.active || (event?.pointerId != null && event.pointerId !== assistantResize.pointerId)) return;
    const handle = $('#reader-sidebar-resizer');
    try {
      if (handle?.hasPointerCapture?.(assistantResize.pointerId)) handle.releasePointerCapture(assistantResize.pointerId);
    } catch (_error) {}
    assistantResize.active = false;
    assistantResize.pointerId = null;
    $('#reader-view')?.classList.remove('is-resizing-assistant');
    document.body.classList.remove('resizing-reader-assistant');
    applyAssistantWidth({ persist: true });
    if (frameDocument()?.getSelection()?.toString().trim()) showSelection();
  }

  function handleAssistantResizeDown(event) {
    if (assistantOverlayQuery.matches || event.button !== 0) return;
    event.preventDefault();
    assistantResize.active = true;
    assistantResize.pointerId = event.pointerId;
    assistantResize.startX = event.clientX;
    assistantResize.startWidth = applyAssistantWidth();
    try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch (_error) {}
    $('#reader-view')?.classList.add('is-resizing-assistant');
    document.body.classList.add('resizing-reader-assistant');
  }

  function handleAssistantResizeMove(event) {
    if (!assistantResize.active || event.pointerId !== assistantResize.pointerId) return;
    event.preventDefault();
    const { minimum, maximum } = assistantWidthBounds();
    assistantPreferredWidth = Math.max(minimum, Math.min(maximum, assistantResize.startWidth + assistantResize.startX - event.clientX));
    applyAssistantWidth();
  }

  function handleAssistantResizeKeyDown(event) {
    if (assistantOverlayQuery.matches || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const { minimum, maximum } = assistantWidthBounds();
    const current = applyAssistantWidth();
    const step = event.shiftKey ? 40 : 16;
    if (event.key === 'Home') assistantPreferredWidth = minimum;
    else if (event.key === 'End') assistantPreferredWidth = maximum;
    else assistantPreferredWidth = current + (event.key === 'ArrowLeft' ? step : -step);
    applyAssistantWidth({ persist: true });
    if (frameDocument()?.getSelection()?.toString().trim()) showSelection();
  }

  const assistantResizer = $('#reader-sidebar-resizer');
  assistantResizer?.addEventListener('pointerdown', handleAssistantResizeDown);
  assistantResizer?.addEventListener('pointermove', handleAssistantResizeMove);
  assistantResizer?.addEventListener('pointerup', finishAssistantResize);
  assistantResizer?.addEventListener('pointercancel', finishAssistantResize);
  assistantResizer?.addEventListener('keydown', handleAssistantResizeKeyDown);

  function setAssistantOpen(open) {
    const sidebar = $('#reader-sidebar');
    const toggle = $('#assistant-toggle');
    if (!sidebar || !toggle) return;
    const next = Boolean(open);
    if (!next) closeChatSessionMenu();
    sidebar.classList.toggle('is-open', next);
    sidebar.setAttribute('aria-hidden', String(!next));
    toggle.setAttribute('aria-expanded', String(next));
    toggle.classList.toggle('active', next);
    const overlay = assistantOverlayQuery.matches;
    const label = next ? (overlay ? '关闭阅读助手' : '折叠阅读助手') : (overlay ? '打开阅读助手' : '展开阅读助手');
    toggle.title = label;
    toggle.setAttribute('aria-label', label);
    if (next && !overlay) applyAssistantWidth();
    window.setTimeout(() => {
      if (frameDocument()?.getSelection()?.toString().trim()) showSelection();
    }, 220);
  }

  $('#assistant-toggle')?.addEventListener('click', () => {
    const sidebar = $('#reader-sidebar');
    setAssistantOpen(!sidebar?.classList.contains('is-open'));
  });
  document.addEventListener('keydown', (event) => {
    const lightbox = $('#image-lightbox');
    if (event.key === 'Tab' && lightbox && !lightbox.hidden && $('#image-context-menu')?.hidden !== false) {
      event.preventDefault();
      $('#image-lightbox-close')?.focus({ preventScroll: true });
      return;
    }
    if (event.key !== 'Escape') return;
    if (closeImageContextMenu({ restoreFocus: true })) {
      event.preventDefault();
      return;
    }
    if (closeImageLightbox()) {
      event.preventDefault();
      return;
    }
    if (assistantOverlayQuery.matches && $('#reader-sidebar')?.classList.contains('is-open')) {
      event.preventDefault();
      setAssistantOpen(false);
      $('#assistant-toggle')?.focus();
    }
  });
  assistantOverlayQuery.addEventListener('change', (event) => {
    if (!$('#reader-view')?.classList.contains('active-view')) return;
    setAssistantOpen(!event.matches);
  });

  function persistOpenDocuments() {
    persistentStateSet(openTabsStorageKey, JSON.stringify(state.openDocuments.map((job) => job.job_id).slice(-12)));
  }

  function renderDocumentTabs({ enteringJobId = null } = {}) {
    const container = $('#document-tabs');
    if (!container) return;
    if (!state.openDocuments.length) {
      container.hidden = true;
      container.innerHTML = '';
      delete container.dataset.structureKey;
      container.closest('.app-header')?.classList.remove('has-document-tabs');
      return;
    }
    container.hidden = false;
    container.closest('.app-header')?.classList.add('has-document-tabs');
    const readerIsActive = Boolean($('#reader-view')?.classList.contains('active-view'));
    const rovingJobId = (readerIsActive ? state.activeJob?.job_id : null) || state.activeJob?.job_id || state.openDocuments[0]?.job_id;
    const tabsModel = state.openDocuments.map((job) => ({ job, title: itemTitle({ job, item: state.library?.items?.[job.job_id] || {} }) }));
    const structureKey = JSON.stringify(tabsModel.map(({ job, title }) => [job.job_id, title]));
    const busyDocuments = busyDocumentIds();
    if (container.dataset.structureKey === structureKey) {
      container.querySelectorAll('.document-tab').forEach((tab) => {
        const active = readerIsActive && state.activeJob?.job_id === tab.dataset.jobId;
        tab.classList.toggle('active', active);
        tab.setAttribute('aria-selected', String(active));
        tab.tabIndex = tab.dataset.jobId === rovingJobId ? 0 : -1;
        tab.classList.toggle('is-busy', busyDocuments.has(tab.dataset.jobId));
      });
      return;
    }
    container.dataset.structureKey = structureKey;
    container.innerHTML = tabsModel.map(({ job, title }) => {
      const active = readerIsActive && state.activeJob?.job_id === job.job_id ? ' active' : '';
      const entering = enteringJobId === job.job_id ? ' is-entering' : '';
      return `<div class="document-tab${active}${entering}" data-job-id="${escapeHTML(job.job_id)}" role="tab" aria-selected="${active ? 'true' : 'false'}" tabindex="${job.job_id === rovingJobId ? '0' : '-1'}"><span class="document-tab-label" title="${escapeHTML(title)}">${escapeHTML(title)}</span><button class="document-tab-close" data-close-job-id="${escapeHTML(job.job_id)}" type="button" tabindex="-1" aria-label="关闭 ${escapeHTML(title)}">×</button></div>`;
    }).join('');
    container.querySelectorAll('.document-tab').forEach((tab) => tab.classList.toggle('is-busy', busyDocuments.has(tab.dataset.jobId)));
    container.querySelectorAll('.document-tab').forEach((tab) => tab.addEventListener('click', (event) => {
      if (event.target.closest('[data-close-job-id]')) return;
      const job = state.openDocuments.find((item) => item.job_id === tab.dataset.jobId) || state.jobs.find((item) => item.job_id === tab.dataset.jobId);
      // Clicking the already-mounted tab must not tear down and rebuild the
      // whole reader; only genuinely different documents remount the iframe.
      if (job && !($('#reader-view')?.classList.contains('active-view') && state.activeJob?.job_id === job.job_id)) openReader(job, { addTab: false });
    }));
    container.querySelectorAll('.document-tab').forEach((tab) => tab.addEventListener('keydown', (event) => {
      const tabs = [...container.querySelectorAll('.document-tab:not(.is-closing)')];
      const index = tabs.indexOf(tab);
      let target = null;
      if (event.key === 'ArrowLeft') target = tabs[(index - 1 + tabs.length) % tabs.length];
      else if (event.key === 'ArrowRight') target = tabs[(index + 1) % tabs.length];
      else if (event.key === 'Home') target = tabs[0];
      else if (event.key === 'End') target = tabs.at(-1);
      else if (['Enter', ' '].includes(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        tab.click();
        return;
      } else if (['Backspace', 'Delete'].includes(event.key) || (primaryModifierPressed(event) && event.key.toLowerCase() === 'w')) {
        event.preventDefault();
        closeDocumentTab(tab.dataset.jobId);
        return;
      }
      if (!target) return;
      event.preventDefault();
      tabs.forEach((candidate) => { candidate.tabIndex = candidate === target ? 0 : -1; });
      target.focus({ preventScroll: true });
      target.scrollIntoView({ behavior: reducedMotionQuery.matches ? 'auto' : 'smooth', inline: 'nearest', block: 'nearest' });
    }));
    container.querySelectorAll('[data-close-job-id]').forEach((close) => close.addEventListener('click', (event) => {
      event.stopPropagation();
      closeDocumentTab(close.dataset.closeJobId);
    }));
  }

  async function closeDocumentTab(jobId) {
    const tab = $('#document-tabs')?.querySelector(`.document-tab[data-job-id="${cssEscape(jobId)}"]`);
    if (tab?.classList.contains('is-closing')) return;
    if (state.activeJob?.job_id === jobId) captureCurrentReadingLocation();
    const restoreTabFocus = Boolean(tab?.contains(document.activeElement));
    if (tab && !reducedMotionQuery.matches) {
      tab.classList.add('is-closing');
      const closeButton = tab.querySelector('[data-close-job-id]');
      if (closeButton) closeButton.disabled = true;
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          tab.removeEventListener('animationend', onAnimationEnd);
          window.clearTimeout(fallback);
          resolve();
        };
        const onAnimationEnd = (event) => {
          if (event.target === tab && event.animationName === 'scholar-tab-exit') finish();
        };
        const fallback = window.setTimeout(finish, 190);
        tab.addEventListener('animationend', onAnimationEnd);
      });
    }
    const index = state.openDocuments.findIndex((job) => job.job_id === jobId);
    if (index < 0) return;
    const wasActive = state.activeJob?.job_id === jobId;
    if (wasActive) flushPendingArticleNotes(jobId);
    disposeReaderMount(jobId);
    state.openDocuments.splice(index, 1);
    releaseClosedDocumentCaches(jobId);
    persistOpenDocuments();
    if (!wasActive) {
      renderDocumentTabs();
      if (restoreTabFocus) window.requestAnimationFrame(() => $('#document-tabs .document-tab[tabindex="0"]')?.focus({ preventScroll: true }));
      return;
    }
    const next = state.openDocuments[index] || state.openDocuments[index - 1];
    if (next) openReader(next, { addTab: false });
    else {
      state.activeJob = null;
      activeJobId = null;
      state.translationCache = [];
      state.translationRun = null;
      state.chat = [];
      state.annotations = [];
      state.aiHighlights = [];
      state.chatSelection = null;
      prepareArticleNotes(null);
      resetNoteHistory();
      $('#notes-editor')?.setAttribute('aria-busy', 'false');
      renderChat();
      renderAnnotations();
      renderSelectedContext();
      $('#outline-list')?.replaceChildren();
      $('#reader-chapter-list')?.replaceChildren();
      switchView('library-view');
    }
  }

  function releaseClosedDocumentCaches(jobId) {
    if (state.openDocuments.some((job) => job.job_id === jobId)) return;
    if (!state.translationRuns.get(jobId)?.running) {
      state.translationCaches.delete(jobId);
      state.translationRuns.delete(jobId);
    }
    if (!mediaLayoutSaveQueues.has(jobId)) state.mediaLayouts.delete(jobId);
    const chat = state.chatSessions.get(jobId);
    if (chat && !chat.sessions.some((session) => session.messages.some((message) => message.streaming))) {
      persistChatSession(jobId);
      state.chatSessions.delete(jobId);
    }
  }

  // PDF import queue. Uploads are bounded independently from conversion so the
  // backend worker pool can start the next document without waiting for the
  // previous document to finish.
  const importUploadConcurrency = 2;
  const importPollInterval = 700;
  const importMetadataPollInterval = 900;
  const importMetadataFollowupTimeout = 30000;
  const terminalImportStatuses = new Set(['done', 'failed']);
  const activeImportStatuses = new Set(['uploading', 'processing']);
  const terminalMetadataStatuses = new Set(['local', 'complete', 'needs-review', 'failed']);
  const delay = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

  function importItemProgress(item) {
    if (terminalImportStatuses.has(item.status)) return 1;
    const progress = Number(item.progress || 0);
    return Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
  }

  function importItemStatusLabel(item) {
    if (item.status === 'done') return '已完成';
    if (item.status === 'failed') return '失败';
    if (item.status === 'uploading') return '上传中';
    if (item.status === 'processing') return `${Math.round(importItemProgress(item) * 100)}%`;
    return '等待中';
  }

  function renderImportQueue() {
    const card = $('#progress-card'); const list = $('#import-queue-list');
    if (!card || !list) return;
    card.hidden = !state.importQueue.length;
    list.innerHTML = state.importQueue.slice(-20).map((item) => `<div class="import-queue-item ${escapeHTML(item.status || '')}"><strong title="${escapeHTML(item.file.name)}">${escapeHTML(item.file.name)}</strong><span>${escapeHTML(importItemStatusLabel(item))}</span></div>`).join('');
    const total = state.importQueue.length;
    const complete = state.importQueue.filter((item) => terminalImportStatuses.has(item.status)).length;
    const active = state.importQueue.filter((item) => activeImportStatuses.has(item.status));
    const value = total ? Math.round((state.importQueue.reduce((sum, item) => sum + importItemProgress(item), 0) / total) * 100) : 0;
    $('#progress-bar').style.width = `${value}%`; $('#progress-value').textContent = `${value}%`;
    $('#progress-stage').textContent = active.length > 1 ? `正在并行导入 · ${active.length} 个文件` : active.length === 1 ? `正在导入 · ${active[0].file.name}` : complete === total ? '导入完成' : '导入队列';
    const activeStages = active.slice(0, 2).map((item) => `${item.file.name}：${item.stage || (item.status === 'uploading' ? '正在上传' : '处理中')}`);
    $('#progress-detail').textContent = activeStages.length ? `${activeStages.join(' · ')}${active.length > 2 ? ` · 另有 ${active.length - 2} 个` : ''}` : complete === total ? `${total} 个文件已处理` : `${total - complete} 个文件等待处理`;
  }

  function scheduleImportQueueDismiss() {
    if (importQueueDismissTimer) window.clearTimeout(importQueueDismissTimer);
    importQueueDismissTimer = null;
    if (!state.importQueue.length || state.importRunning || state.importQueue.some((item) => !['done', 'failed'].includes(item.status))) return;
    // Keep the completed state visible briefly so the user can confirm the
    // result, then clear it so a finished import never occupies the library.
    importQueueDismissTimer = window.setTimeout(() => {
      importQueueDismissTimer = null;
      if (state.importRunning || state.importQueue.some((item) => !['done', 'failed'].includes(item.status))) return;
      state.importQueue = [];
      renderImportQueue();
    }, 1200);
  }

  function validPDF(file) { return file && (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')); }
  function importFileKey(file) { return `${file.name}:${file.size}:${Number(file.lastModified || 0)}`; }

  function enqueueFiles(files) {
    if (browserDemo) { showToast('浏览器本地测试版仅使用内置样例，不支持上传 PDF。'); return; }
    showError('');
    if (importQueueDismissTimer) { window.clearTimeout(importQueueDismissTimer); importQueueDismissTimer = null; }
    const incoming = [...(files || [])];
    const accepted = incoming.filter(validPDF);
    const rejected = incoming.length - accepted.length;
    if (rejected) showError(`${rejected} 个文件不是 PDF，已跳过。`);
    const existing = new Set(state.importQueue.filter((item) => item.status !== 'failed').map((item) => importFileKey(item.file)));
    const currentFolder = folderById(state.activeFolderId);
    // Snapshot the custom folder at enqueue time. This prevents a user who
    // changes folders while conversion is running from silently reassigning
    // the pending files to a different folder.
    const targetFolderId = currentFolder && !currentFolder.system ? currentFolder.id : null;
    accepted.forEach((file) => {
      const key = importFileKey(file);
      if (existing.has(key)) return;
      existing.add(key);
      state.importQueue.push({ id: `${Date.now()}-${Math.random()}`, file, folderId: targetFolderId, status: 'queued', progress: 0 });
    });
    renderImportQueue();
    processImportQueue().catch((error) => showError(error.message));
  }

  function requestImportLibraryRefresh() {
    importLibraryRefreshPending = true;
    if (importLibraryRefreshTimer || importLibraryRefreshInFlight) return;
    importLibraryRefreshTimer = window.setTimeout(runImportLibraryRefresh, 180);
  }

  async function runImportLibraryRefresh() {
    if (importLibraryRefreshTimer) window.clearTimeout(importLibraryRefreshTimer);
    importLibraryRefreshTimer = null;
    if (!importLibraryRefreshPending || importLibraryRefreshInFlight) return importLibraryRefreshInFlight;
    importLibraryRefreshPending = false;
    importLibraryRefreshInFlight = loadLibrary();
    try {
      await importLibraryRefreshInFlight;
    } finally {
      importLibraryRefreshInFlight = null;
      if (importLibraryRefreshPending) requestImportLibraryRefresh();
    }
  }

  async function flushImportLibraryRefresh() {
    if (importLibraryRefreshTimer) await runImportLibraryRefresh();
    while (importLibraryRefreshInFlight || importLibraryRefreshPending) {
      if (importLibraryRefreshInFlight) await importLibraryRefreshInFlight;
      else await runImportLibraryRefresh();
    }
  }

  function cancelImportMetadataFollowup() {
    importMetadataWatches.clear();
    if (importMetadataPollTimer) window.clearTimeout(importMetadataPollTimer);
    importMetadataPollTimer = null;
  }

  function scheduleImportMetadataPoll(wait = importMetadataPollInterval) {
    if (!importMetadataWatches.size || importMetadataPollTimer || importMetadataPollInFlight) return;
    importMetadataPollTimer = window.setTimeout(runImportMetadataPoll, wait);
  }

  function trackImportMetadata(item, job) {
    if (!state.metadataAutoRetrieve || !job?.job_id) return;
    if (job.metadata_phase === 'refine' && terminalMetadataStatuses.has(String(job.metadata_status || ''))) return;
    const current = importMetadataWatches.get(job.job_id);
    importMetadataWatches.set(job.job_id, current || { deadline: Date.now() + importMetadataFollowupTimeout });
    if (!state.importRunning) scheduleImportMetadataPoll(250);
  }

  function updateImportMetadataWatches(jobs) {
    if (!importMetadataWatches.size) return;
    const now = Date.now();
    let shouldRefresh = false;
    for (const [jobId, watch] of importMetadataWatches) {
      const job = jobs.get(jobId);
      const refined = job?.metadata_phase === 'refine';
      const settled = refined && terminalMetadataStatuses.has(String(job?.metadata_status || ''));
      if (!settled && now < watch.deadline) continue;
      importMetadataWatches.delete(jobId);
      shouldRefresh = true;
    }
    if (shouldRefresh) requestImportLibraryRefresh();
  }

  async function runImportMetadataPoll() {
    if (importMetadataPollTimer) window.clearTimeout(importMetadataPollTimer);
    importMetadataPollTimer = null;
    if (!importMetadataWatches.size || importMetadataPollInFlight) return;
    if (state.importRunning) {
      scheduleImportMetadataPoll();
      return;
    }
    const abortController = new AbortController();
    const abortTimer = window.setTimeout(() => abortController.abort(), 5000);
    importMetadataPollInFlight = (async () => {
      try {
        const payload = await api('/api/jobs', { signal: abortController.signal });
        updateImportMetadataWatches(new Map((payload.jobs || []).map((job) => [job.job_id, job])));
      } catch (_error) {
        updateImportMetadataWatches(new Map());
      } finally {
        window.clearTimeout(abortTimer);
      }
    })();
    try {
      await importMetadataPollInFlight;
    } finally {
      importMetadataPollInFlight = null;
      if (importMetadataWatches.size) scheduleImportMetadataPoll();
    }
  }

  function completeImportItem(item, job) {
    const wasTerminal = terminalImportStatuses.has(item.status);
    item.job = job;
    item.progress = 1;
    item.stage = job?.stage || '';
    if (job?.status === 'completed') {
      item.status = 'done';
      if (!wasTerminal) trackImportMetadata(item, job);
      if (item.autoOpen && !item.opened) {
        item.opened = true;
        openReader(job);
      }
    } else {
      item.status = 'failed';
      item.error = job?.error || '转换失败';
      showError(`${item.file.name}：${item.error}`);
    }
    if (!wasTerminal) requestImportLibraryRefresh();
  }

  function applyImportJob(item, job) {
    if (!job) return;
    item.jobId = job.job_id || item.jobId;
    item.job = job;
    if (job.status === 'completed' || job.status === 'failed') {
      completeImportItem(item, job);
      return;
    }
    item.status = 'processing';
    item.progress = Number(job.progress || 0);
    item.stage = job.stage || '等待转换';
  }

  async function uploadImportItem(item) {
    item.status = 'uploading';
    item.stage = '正在上传';
    item.progress = 0;
    renderImportQueue();
    try {
      const form = new FormData(); form.append('file', item.file, item.file.name);
      if (item.folderId) form.append('folder_id', item.folderId);
      const payload = await api('/api/jobs', { method: 'POST', body: form });
      item.deduplicated = Boolean(payload.deduplicated);
      applyImportJob(item, payload.job);
    } catch (error) {
      item.status = 'failed';
      item.progress = 1;
      item.error = error.message;
      item.stage = '';
      showError(`${item.file.name}：${error.message}`);
      requestImportLibraryRefresh();
    }
    renderImportQueue();
  }

  function startQueuedImportUploads() {
    const available = Math.max(0, importUploadConcurrency - importUploadTasks.size);
    state.importQueue.filter((item) => item.status === 'queued').slice(0, available).forEach((item) => {
      const task = uploadImportItem(item);
      importUploadTasks.add(task);
      task.finally(() => importUploadTasks.delete(task));
    });
  }

  async function pollImportJobs() {
    const processing = state.importQueue.filter((item) => item.status === 'processing' && item.jobId);
    if (!processing.length) return;
    try {
      const payload = await api('/api/jobs');
      const jobs = new Map((payload.jobs || []).map((job) => [job.job_id, job]));
      processing.forEach((item) => {
        const job = jobs.get(item.jobId);
        if (job) applyImportJob(item, job);
      });
      updateImportMetadataWatches(jobs);
      const errorNode = $('#upload-error');
      if (errorNode?.dataset.importPollError === 'true') showError('');
      importPollFailures = 0;
    } catch (_error) {
      importPollFailures += 1;
      processing.forEach((item) => { item.stage = '连接暂时中断，正在重试'; });
      if (importPollFailures >= 3) {
        const errorNode = $('#upload-error');
        if (!errorNode.textContent || errorNode.dataset.importPollError === 'true') {
          showError('暂时无法获取导入进度，后台任务仍在继续，将自动重试。');
          errorNode.dataset.importPollError = 'true';
        }
      }
    }
    renderImportQueue();
  }

  async function runImportController() {
    state.importRunning = true;
    const initialQueued = state.importQueue.filter((item) => item.status === 'queued');
    if (initialQueued.length === 1 && !state.openDocuments.length) initialQueued[0].autoOpen = true;
    try {
      while (state.importQueue.some((item) => !terminalImportStatuses.has(item.status)) || importUploadTasks.size) {
        startQueuedImportUploads();
        await pollImportJobs();
        if (!state.importQueue.some((item) => !terminalImportStatuses.has(item.status)) && !importUploadTasks.size) break;
        const waiters = [...importUploadTasks, delay(state.importQueue.some((item) => item.status === 'processing') ? importPollInterval : 60)];
        await Promise.race(waiters);
      }
      await flushImportLibraryRefresh();
    } finally {
      state.importRunning = false;
      renderImportQueue();
      scheduleImportQueueDismiss();
      scheduleImportMetadataPoll(250);
    }
  }

  function processImportQueue() {
    if (importControllerPromise) return importControllerPromise;
    importControllerPromise = runImportController().finally(() => {
      importControllerPromise = null;
      if (state.importQueue.some((item) => !terminalImportStatuses.has(item.status))) processImportQueue().catch((error) => showError(error.message));
    });
    return importControllerPromise;
  }

  $('#import-pdf-button')?.addEventListener('click', () => $('#file-input')?.click());
  $('#file-input')?.addEventListener('change', (event) => { enqueueFiles(event.target.files); event.target.value = ''; });
  let dragDepth = 0;
  const setDropState = (active) => { const overlay = $('#drop-overlay'); if (overlay) overlay.hidden = !active; };
  document.addEventListener('dragenter', (event) => { if (![...(event.dataTransfer?.types || [])].includes('Files')) return; event.preventDefault(); dragDepth += 1; setDropState(true); });
  document.addEventListener('dragover', (event) => { if (event.dataTransfer?.types?.includes('Files')) event.preventDefault(); });
  document.addEventListener('dragleave', (event) => { if (!event.dataTransfer?.types?.includes('Files')) return; event.preventDefault(); dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) setDropState(false); });
  document.addEventListener('drop', (event) => { if (!event.dataTransfer?.files?.length) return; event.preventDefault(); dragDepth = 0; setDropState(false); enqueueFiles(event.dataTransfer.files); });

  // Library folders, configurable properties, metadata and saved views.
  const systemLibraryColumnIds = new Set(['name', 'title', 'research_topic', 'importance', 'reading_status', 'venue']);
  function libraryState() { return state.library || { folders: [], properties: [], items: {}, views: [], folder_counts: {} }; }
  function libraryProperties() { return (libraryState().properties || []).filter((item) => item && !item.hidden).sort((a, b) => (a.order || 0) - (b.order || 0)); }
  // The status vocabulary is served by the library store; the literal list only
  // covers a render before the first snapshot arrives.
  function readingStatusOptions() {
    const options = (libraryState().properties || []).find((property) => property?.id === 'reading_status')?.options;
    return Array.isArray(options) && options.length ? options.map(String) : ['未开始', '计划中', '阅读中', '已完成'];
  }
  const PRE_READING_STATUSES = new Set(['未开始', '计划中']);
  function allLibraryProperties() { return (libraryState().properties || []).filter((item) => item).sort((a, b) => (a.order || 0) - (b.order || 0)); }
  function libraryDisplayColumns() {
    const library = libraryState();
    const propertyIds = new Set(libraryProperties().map((property) => String(property.id)));
    const configured = (Array.isArray(library.display?.columns) ? library.display.columns : []).filter((column) => column?.id && (systemLibraryColumnIds.has(String(column.id)) || propertyIds.has(String(column.id))));
    const known = new Map(configured.filter((column) => column?.id).map((column) => [String(column.id), column]));
    const custom = libraryProperties().filter((property) => !known.has(property.id)).map((property, index) => ({ id: property.id, label: property.label, visible: true, system: false, order: configured.length + index }));
    return [...configured, ...custom].filter((column) => column && column.id).sort((a, b) => (a.order || 0) - (b.order || 0));
  }
  function visibleLibraryColumns() { return libraryDisplayColumns().filter((column) => column.visible !== false); }
  function libraryColumnLabel(column) { return String(column?.label || ({ name: '名称', title: '标题', research_topic: '研究主题', importance: '重要程度', reading_status: '阅读状态', venue: '接收/来源' }[column?.id] || column?.id || '')); }
  function libraryColumnMinWidth(column) {
    if (column?.id === 'name') return 180;
    if (column?.id === 'title') return 160;
    if (column?.id === 'research_topic') return 116;
    if (column?.id === 'importance') return 100;
    if (column?.id === 'reading_status') return 96;
    if (column?.id === 'venue') return 110;
    return 96;
  }
  function libraryColumnWidth(column) {
    const value = Number(column?.width);
    return Number.isFinite(value) ? Math.max(libraryColumnMinWidth(column), Math.min(520, Math.round(value))) : null;
  }
  // One table of minimum widths and growth factors feeds both the grid
  // template and the row's minimum width, so a row is always at least as
  // wide as its tracks: a fixed-width column set that outgrows the default
  // minimum used to spill past the row box and lose its background.
  const libraryColumnTracks = { name: [150, '1.65fr'], title: [140, '1.35fr'], research_topic: [92, '1.05fr'], importance: [86, '.8fr'], reading_status: [84, '.82fr'], venue: [96, '1.08fr'] };
  const LIBRARY_ACTIONS_TRACK = 40;
  const LIBRARY_COLUMN_GAP = 8;
  const LIBRARY_ROW_INSET = 24;
  function libraryColumnTrack(column) {
    const fixed = libraryColumnWidth(column);
    if (fixed) return { min: fixed, track: `${fixed}px` };
    const [min, grow] = libraryColumnTracks[column?.id] || [88, '1fr'];
    return { min, track: `minmax(${min}px,${grow})` };
  }
  function libraryGridTemplate(columns) {
    return [...columns.map((column) => libraryColumnTrack(column).track), `minmax(${LIBRARY_ACTIONS_TRACK}px,auto)`].join(' ');
  }
  function libraryTableMinWidth(columns) {
    const tracks = columns.reduce((sum, column) => sum + libraryColumnTrack(column).min, LIBRARY_ACTIONS_TRACK);
    return `${tracks + columns.length * LIBRARY_COLUMN_GAP + LIBRARY_ROW_INSET}px`;
  }
  function libraryItemEntries() {
    // The library snapshot intentionally carries a compact job record for
    // metadata joins; use the full /api/jobs record when available so links
    // (HTML/PDF/JSON) remain usable when a row opens the reader.
    return Object.entries(libraryState().items || {}).map(([jobId, item]) => ({ jobId, item, job: state.jobs.find((candidate) => candidate.job_id === jobId) || item?.job })).filter((entry) => entry.job);
  }
  function itemValues(entry) { return entry.item?.values || {}; }
  function itemMetadata(entry) { return entry.item?.metadata?.fields || {}; }
  // The alias is what the reader wants to see; the original title is what the
  // paper is called, kept for tooltips, search and the metadata itself.
  function itemOriginalTitle(entry) { return String(itemMetadata(entry).title || entry.job?.source_filename || '未命名文献').replace(/\.pdf$/i, ''); }
  function itemAlias(entry) { return String(entry.item?.alias || '').trim(); }
  function itemTitle(entry) { return itemAlias(entry) || itemOriginalTitle(entry); }
  const VENUE_ABBREVIATIONS = [
    [/neural information processing systems/, 'NIPS'],
    [/international conference on machine learning/, 'ICML'],
    [/international conference on learning representations/, 'ICLR'],
    [/computer vision and pattern recognition/, 'CVPR'],
    [/international conference on computer vision/, 'ICCV'],
    [/european conference on computer vision/, 'ECCV'],
    [/winter conference on applications of computer vision/, 'WACV'],
    [/empirical methods in natural language processing/, 'EMNLP'],
    [/north american chapter of the association for computational linguistics/, 'NAACL'],
    [/transactions of the association for computational linguistics/, 'TACL'],
    [/meeting of the association for computational linguistics/, 'ACL'],
    [/international conference on computational linguistics/, 'COLING'],
    [/aaai conference on artificial intelligence/, 'AAAI'],
    [/international joint conference on artificial intelligence/, 'IJCAI'],
    [/knowledge discovery and data mining/, 'KDD'],
    [/research and development in information retrieval/, 'SIGIR'],
    [/world wide web conference|the web conference/, 'WWW'],
    [/pattern analysis and machine intelligence/, 'TPAMI'],
    [/international journal of computer vision/, 'IJCV'],
    [/journal of machine learning research/, 'JMLR'],
    [/transactions on machine learning research/, 'TMLR'],
    [/acoustics, speech,? and signal processing/, 'ICASSP'],
    [/medical image computing and computer.assisted intervention/, 'MICCAI'],
    [/international conference on robotics and automation/, 'ICRA'],
    [/intelligent robots and systems/, 'IROS'],
    [/acm international conference on multimedia|^acm multimedia/, 'ACM MM'],
    [/^arxiv/, 'arXiv'],
  ];

  function formatVenueDisplay(venue, year, arxivId = '') {
    let full = String(venue || '').replace(/\s+/g, ' ').trim();
    const yy = /^(19|20)\d{2}$/.test(String(year || '').trim()) ? String(year).trim().slice(-2) : '';
    if (!full) {
      if (!arxivId) return '';
      return yy ? `arXiv-${yy}: ${arxivId}` : `arXiv: ${arxivId}`;
    }
    let paren = '';
    full = full.replace(/\s*\(([A-Za-z][A-Za-z+&/. -]{1,18})\)\s*$/, (_match, inner) => { paren = inner.trim(); return ''; });
    full = full
      .replace(/^((19|20)\d{2})\s+/, '')
      .replace(/^proceedings of (the )?(\d+(st|nd|rd|th) )?/i, '')
      .replace(/\s+\d{1,3}$/, '')
      .trim();
    const lower = full.toLowerCase();
    let abbrev = '';
    for (const [pattern, name] of VENUE_ABBREVIATIONS) {
      if (pattern.test(lower)) { abbrev = name; break; }
    }
    if (!abbrev && paren && paren.length <= 12 && !/\s/.test(paren)) abbrev = paren;
    if (!abbrev) return full;
    if (abbrev.toLowerCase() === lower) return yy ? `${abbrev}-${yy}` : abbrev;
    return yy ? `${abbrev}-${yy}: ${full}` : `${abbrev}: ${full}`;
  }

  function itemVenue(entry) {
    // A manually edited column value always wins; otherwise derive the
    // "ABBREV-YY: Full Name" display from the fetched metadata.
    const manual = String(itemValues(entry).venue || '').trim();
    if (manual) return manual;
    const metadata = itemMetadata(entry);
    return formatVenueDisplay(metadata.venue, metadata.year, metadata.arxiv_id);
  }
  function itemMatchesFolder(entry, folderId) {
    if (folderId === 'system-trash') return Boolean(entry.item?.deleted_at);
    if (entry.item?.deleted_at) return false;
    if (folderId === 'system-all') return true;
    if (folderId === 'system-unfiled') return !(entry.item?.folder_ids || []).length;
    return (entry.item?.folder_ids || []).includes(folderId);
  }
  function itemSearchText(entry) {
    const values = itemValues(entry);
    const metadata = itemMetadata(entry);
    return [entry.job?.source_filename, itemTitle(entry), itemOriginalTitle(entry), itemVenue(entry), metadata.doi, metadata.arxiv_id, metadata.pmid, ...(values.research_topic || [])].join(' ').toLowerCase();
  }
  const systemGroupLabels = { name: '名称', title: '标题', research_topic: '研究主题', importance: '重要程度', reading_status: '阅读状态', venue: '接收/来源' };
  function groupableColumns() {
    const known = new Set();
    const columns = [];
    [...libraryDisplayColumns(), ...allLibraryProperties().map((property) => ({ id: property.id, label: property.label, system: Boolean(property.system) }))].forEach((column) => {
      const id = String(column?.id || '');
      if (!id || known.has(id)) return;
      known.add(id);
      columns.push({ id, label: libraryColumnLabel(column) || systemGroupLabels[id] || id, type: propertyById(id)?.type || (id === 'importance' ? 'rating' : 'text') });
    });
    return columns;
  }
  function activeGroupField() {
    const requested = String(libraryState().display?.group_by || 'reading_status');
    return groupableColumns().some((column) => column.id === requested) ? requested : 'reading_status';
  }
  function groupFieldLabel(field = activeGroupField()) { return groupableColumns().find((column) => column.id === field)?.label || systemGroupLabels[field] || field; }
  function groupValueLabels(entry, field) {
    const actual = filterValue(entry, field);
    if (Array.isArray(actual)) {
      const labels = [...new Set(actual.map((value) => String(value).trim()).filter(Boolean))];
      return labels.length ? labels : ['未设置'];
    }
    if (field === 'importance') return [String(Number(actual || 0))];
    const text = String(actual ?? '').trim();
    return [text || '未设置'];
  }
  function groupedEntries(entries, field = activeGroupField()) {
    const buckets = new Map();
    entries.forEach((entry) => groupValueLabels(entry, field).forEach((label) => { if (!buckets.has(label)) buckets.set(label, []); buckets.get(label).push(entry); }));
    const property = propertyById(field);
    const preferred = Array.isArray(property?.options) ? property.options.map((value) => String(value)) : [];
    const ordered = [...buckets.keys()].sort((left, right) => {
      const leftIndex = preferred.indexOf(left); const rightIndex = preferred.indexOf(right);
      if (leftIndex >= 0 || rightIndex >= 0) return (leftIndex < 0 ? preferred.length : leftIndex) - (rightIndex < 0 ? preferred.length : rightIndex);
      if (field === 'importance') return Number(right) - Number(left);
      if (left === '未设置') return 1;
      if (right === '未设置') return -1;
      return left.localeCompare(right, 'zh-CN');
    });
    return ordered.map((label) => ({ label, entries: buckets.get(label) || [] }));
  }
  function positionViewportMenu(menu, anchorRect, { clientX = null, clientY = null, preferredLeft = null, width = null, maximumHeight = 360 } = {}) {
    if (!menu || menu.hidden || !anchorRect) return false;
    const padding = 12;
    const gap = 6;
    const pointerX = Number(clientX);
    const pointerY = Number(clientY);
    const pointerAnchored = clientX !== null && clientY !== null && Number.isFinite(pointerX) && Number.isFinite(pointerY);
    const anchorTop = pointerAnchored ? pointerY : anchorRect.top;
    const anchorBottom = pointerAnchored ? pointerY : anchorRect.bottom;
    menu.style.removeProperty('top');
    menu.style.removeProperty('left');
    menu.style.width = Number.isFinite(width) ? `${Math.max(1, Math.min(window.innerWidth - padding * 2, width))}px` : '';
    menu.style.maxHeight = `${Math.max(44, Math.min(maximumHeight, window.innerHeight - padding * 2))}px`;
    let menuRect = menu.getBoundingClientRect();
    const spaceAbove = Math.max(0, anchorTop - padding);
    const spaceBelow = Math.max(0, window.innerHeight - anchorBottom - padding);
    const placeAbove = spaceBelow < menuRect.height + gap && spaceAbove > spaceBelow;
    const availableHeight = Math.max(44, (placeAbove ? spaceAbove : spaceBelow) - gap);
    menu.style.maxHeight = `${Math.min(maximumHeight, availableHeight)}px`;
    menuRect = menu.getBoundingClientRect();
    const rawLeft = Number.isFinite(preferredLeft) ? preferredLeft : pointerAnchored ? pointerX : anchorRect.left;
    const rawTop = placeAbove ? anchorTop - menuRect.height - gap : anchorBottom + gap;
    const left = Math.max(padding, Math.min(window.innerWidth - menuRect.width - padding, rawLeft));
    const top = Math.max(padding, Math.min(window.innerHeight - menuRect.height - padding, rawTop));
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
    menu.dataset.placement = placeAbove ? 'top' : 'bottom';
    return true;
  }

  function positionGroupingMenu() {
    const button = $('#grouping-button');
    const list = $('#library-grouping-list');
    const menu = $('#grouping-field-menu');
    if (!button || !list || !menu || menu.hidden) return false;
    const buttonRect = button.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    return positionViewportMenu(menu, buttonRect, {
      preferredLeft: listRect.left,
      width: Math.max(180, buttonRect.width, listRect.width),
    });
  }

  function renderGroupingSidebar() {
    const button = $('#grouping-button'); const list = $('#library-grouping-list'); const menu = $('#grouping-field-menu');
    if (!button || !list || !menu) return;
    const field = activeGroupField();
    button.textContent = `${groupFieldLabel(field)}⌄`;
    button.disabled = state.health?.readonly === true;
    button.dataset.groupBy = field;
    button.setAttribute('aria-expanded', String(state.groupingMenuOpen));
    const options = groupableColumns();
    const entries = libraryItemEntries().filter((entry) => itemMatchesFolder(entry, state.activeFolderId || 'system-all'));
    const groups = groupedEntries(entries, field);
    list.hidden = false;
    menu.innerHTML = options.map((column) => `<button class="grouping-option${column.id === field ? ' active' : ''}" data-group-by="${escapeHTML(column.id)}" role="option" aria-selected="${column.id === field ? 'true' : 'false'}" tabindex="${column.id === field ? '0' : '-1'}" type="button"><span>${escapeHTML(column.label)}</span>${column.id === field ? '<span aria-hidden="true">✓</span>' : ''}</button>`).join('');
    menu.hidden = !state.groupingMenuOpen;
    list.innerHTML = `<div class="grouping-value-list" role="listbox" aria-label="${escapeHTML(groupFieldLabel(field))}分类值">${groups.map((group) => `<button class="grouping-value${state.activeGroupValue === group.label ? ' active' : ''}" data-group-filter="${escapeHTML(group.label)}" type="button" role="option" aria-selected="${state.activeGroupValue === group.label ? 'true' : 'false'}"><span>${escapeHTML(group.label)}</span><b>${group.entries.length}</b></button>`).join('') || '<span class="grouping-empty">暂无分类值</span>'}</div>`;
    if (state.groupingMenuOpen) positionGroupingMenu();
    else {
      menu.style.removeProperty('top');
      menu.style.removeProperty('left');
      menu.style.removeProperty('width');
      menu.style.removeProperty('max-height');
      delete menu.dataset.placement;
    }
  }
  function setGroupingMenuOpen(open, { focus = '', restoreFocus = false } = {}) {
    state.groupingMenuOpen = Boolean(open);
    renderGroupingSidebar();
    if (state.groupingMenuOpen && focus) {
      window.requestAnimationFrame(() => {
        const options = $$('#grouping-field-menu .grouping-option');
        const selected = options.findIndex((option) => option.getAttribute('aria-selected') === 'true');
        const index = focus === 'last' ? options.length - 1 : focus === 'first' ? 0 : Math.max(0, selected);
        options.forEach((option, optionIndex) => { option.tabIndex = optionIndex === index ? 0 : -1; });
        options[index]?.focus({ preventScroll: true });
      });
    } else if (restoreFocus) {
      window.requestAnimationFrame(() => $('#grouping-button')?.focus({ preventScroll: true }));
    }
  }
  async function setGroupingField(field) {
    const valid = groupableColumns().some((column) => column.id === field);
    if (!valid) return;
    state.activeGroupValue = null;
    state.activeFolderId = 'system-all';
    state.activeViewId = null;
    setGroupingMenuOpen(false, { restoreFocus: true });
    const columns = libraryDisplayColumns().map((column, index) => ({ id: column.id, label: libraryColumnLabel(column), visible: column.visible !== false, width: libraryColumnWidth(column), order: index }));
    try {
      const payload = await api('/api/library/display', jsonOptions({ columns, group_by: field }, 'PATCH'));
      if (payload.library) state.library = payload.library;
      else if (payload.display) state.library.display = payload.display;
      renderLibrary(); renderViews();
    } catch (error) { showToast(`保存分类失败：${error.message}`, true); }
  }
  $('#grouping-button')?.addEventListener('click', (event) => { event.stopPropagation(); setGroupingMenuOpen(!state.groupingMenuOpen); });
  $('#grouping-button')?.addEventListener('keydown', (event) => {
    if (!['ArrowDown', 'ArrowUp', 'Escape'].includes(event.key)) return;
    if (event.key === 'Escape') {
      if (!state.groupingMenuOpen) return;
      event.preventDefault();
      event.stopPropagation();
      setGroupingMenuOpen(false, { restoreFocus: true });
      return;
    }
    event.preventDefault();
    setGroupingMenuOpen(true, { focus: event.key === 'ArrowDown' ? 'selected' : 'last' });
  });
  $('#grouping-field-menu')?.addEventListener('click', (event) => {
    const option = event.target.closest('[data-group-by]');
    if (option) void setGroupingField(option.dataset.groupBy);
  });
  $('#library-grouping-list')?.addEventListener('click', (event) => {
    const value = event.target.closest('[data-group-filter]');
    if (value) {
      const selected = state.activeGroupValue === value.dataset.groupFilter;
      state.activeGroupValue = selected ? null : value.dataset.groupFilter;
      state.activeFolderId = selected ? 'system-all' : null;
      state.activeViewId = null;
      clearLibrarySelection();
      renderLibrary();
    }
  });
  $('#grouping-field-menu')?.addEventListener('keydown', (event) => {
    const current = event.target.closest('.grouping-option');
    if (!current || !state.groupingMenuOpen) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setGroupingMenuOpen(false, { restoreFocus: true });
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const options = $$('#grouping-field-menu .grouping-option');
    const currentIndex = Math.max(0, options.indexOf(current));
    const nextIndex = event.key === 'Home' ? 0
      : event.key === 'End' ? options.length - 1
        : event.key === 'ArrowDown' ? (currentIndex + 1) % options.length
          : (currentIndex - 1 + options.length) % options.length;
    options.forEach((option, index) => { option.tabIndex = index === nextIndex ? 0 : -1; });
    options[nextIndex]?.focus({ preventScroll: true });
  });
  function compareLibraryEntries(a, b, sort) {
    const [field, direction] = String(sort || 'updated_at-desc').split('-');
    const values = (entry) => field === 'importance' ? Number(itemValues(entry).importance || 0) : field === 'title' ? itemTitle(entry).toLowerCase() : String(entry.item?.[field] || entry.job?.[field] || '').toLowerCase();
    const left = values(a); const right = values(b);
    const result = typeof left === 'number' ? left - right : left.localeCompare(right, 'zh-CN');
    return (direction === 'asc' ? 1 : -1) * result;
  }
  function folderById(id) { return (libraryState().folders || []).find((folder) => folder.id === id); }
  function renderFolderTree() {
    const node = $('#folder-tree'); if (!node) return;
    const folders = (libraryState().folders || []).filter((folder) => !folder.system);
    const counts = libraryState().folder_counts || {};
    const children = (parentId) => folders.filter((folder) => (folder.parent_id || null) === parentId).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    const render = (parentId, depth = 0) => children(parentId).map((folder) => `<div class="folder-tree-node" style="--folder-depth:${depth}"><div class="folder-row"><button class="folder-button${state.activeFolderId === folder.id ? ' active' : ''}" data-library-folder="${escapeHTML(folder.id)}" type="button"><svg class="sidebar-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"></path></svg><span class="folder-label">${escapeHTML(folder.name)}</span><b data-folder-count="${escapeHTML(folder.id)}">${counts[folder.id] || 0}</b></button><span class="folder-actions"><button class="folder-action" data-folder-edit="${escapeHTML(folder.id)}" type="button" title="重命名文件夹" aria-label="重命名文件夹">···</button><button class="folder-action folder-delete" data-folder-delete="${escapeHTML(folder.id)}" type="button" title="删除文件夹" aria-label="删除文件夹">×</button></span></div>${render(folder.id, depth + 1)}</div>`).join('');
    node.innerHTML = render(null) || '<div class="folder-empty">还没有自定义文件夹</div>';
    node.querySelectorAll('[data-library-folder]').forEach((button) => button.addEventListener('click', () => { state.libraryMode = 'list'; state.activeFolderId = button.dataset.libraryFolder; state.activeViewId = null; renderLibrary(); }));
    node.querySelectorAll('[data-folder-edit]').forEach((button) => button.addEventListener('click', (event) => { event.stopPropagation(); editFolder(button.dataset.folderEdit); }));
    node.querySelectorAll('[data-folder-delete]').forEach((button) => button.addEventListener('click', (event) => { event.stopPropagation(); deleteFolder(button.dataset.folderDelete); }));
    node.querySelectorAll('.folder-button').forEach((button) => button.addEventListener('contextmenu', (event) => { event.preventDefault(); editFolder(button.dataset.libraryFolder); }));
  }
  function updateFolderCounts() {
    const counts = libraryState().folder_counts || {};
    $$('[data-folder-count]').forEach((node) => { node.textContent = String(counts[node.dataset.folderCount] || 0); });
  }
  function persistGraphPreferences() {
    persistentStateSet(graphPreferencesStorageKey, JSON.stringify({
      showSimilarity: state.graphConfig.showSimilarity,
      showAttributes: state.graphConfig.showAttributes,
      attributeIds: state.graphConfig.attributeIds,
      viewportScale: normalizeGraphViewportScale(state.graphConfig.viewportScale),
    }));
  }
  function syncGraphViewportScaleControl() {
    const percent = Math.round(normalizeGraphViewportScale(state.graphConfig.viewportScale) * 100);
    const input = $('#graph-zoom');
    const output = $('#graph-zoom-value');
    if (input) {
      input.value = String(percent);
      input.setAttribute('aria-valuetext', `${percent}%`);
    }
    if (output) output.textContent = `${percent}%`;
  }
  function teardownLibraryGraph() {
    state.graphController?.destroy?.();
    state.graphController = null;
    state.graphData = null;
  }
  function setLibraryMode(mode) {
    const next = mode === 'graph' ? 'graph' : 'list';
    if (state.libraryMode === next) return;
    state.libraryMode = next;
    state.activeGroupValue = null;
    setGroupingMenuOpen(false);
    if (next === 'graph') {
      state.activeFolderId = 'system-all';
      state.activeViewId = null;
    }
    clearLibrarySelection();
    renderLibrary();
  }
  // Saved views live in the library sidebar (a view is just a stored filter);
  // the standalone views page remains as the management/editor surface.
  function renderSidebarViews() {
    const node = $('#sidebar-views-list');
    if (!node) return;
    const views = (libraryState().views || []).filter((view) => view.id !== 'view-all');
    const graphButton = `<button class="system-filter${state.libraryMode === 'graph' ? ' active' : ''}" data-library-mode="graph" type="button"><svg class="sidebar-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="5" cy="12" r="2.2"></circle><circle cx="12" cy="5" r="2.2"></circle><circle cx="19" cy="10" r="2.2"></circle><circle cx="13" cy="19" r="2.2"></circle><path d="m6.6 10.4 3.8-3.8M14 5.7l3.2 2.8M17.1 11.5l-2.8 5.6M11.1 17.3l-4.3-3.7"></path></svg><span class="system-filter-label">关系图谱</span></button>`;
    const savedViews = views.length
      ? views.map((view) => `<button class="system-filter${state.libraryMode === 'list' && !state.activeFolderId && state.activeViewId === view.id ? ' active' : ''}" data-sidebar-view="${escapeHTML(view.id)}" type="button"><svg class="sidebar-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 6h18M7 12h10M10 18h4"></path></svg><span class="system-filter-label">${escapeHTML(view.name || '未命名视图')}</span></button>`).join('')
      : '<div class="folder-empty">还没有保存的视图</div>';
    node.innerHTML = graphButton + savedViews;
    node.querySelector('[data-library-mode="graph"]')?.addEventListener('click', () => setLibraryMode('graph'));
    node.querySelectorAll('[data-sidebar-view]').forEach((button) => button.addEventListener('click', () => {
      state.libraryMode = 'list';
      state.activeFolderId = null;
      state.activeViewId = button.dataset.sidebarView;
      state.activeGroupValue = null;
      clearLibrarySelection();
      renderLibrary();
    }));
  }

  const graphSystemAttributes = Object.freeze([
    { id: 'research_topic', label: '研究主题', type: 'multi-select', defaultEnabled: true },
    { id: 'venue', label: '接收/来源', type: 'venue', defaultEnabled: true },
    { id: 'folders', label: '文件夹', type: 'folders', defaultEnabled: false },
    { id: 'authors', label: '作者', type: 'authors', defaultEnabled: false },
    { id: 'year', label: '年份', type: 'year', defaultEnabled: false },
  ]);
  function graphAvailableAttributes() {
    const custom = libraryProperties()
      .filter((property) => !property.system && property.id)
      .map((property) => ({
        id: String(property.id), label: String(property.label || property.id), type: String(property.type || 'text'),
        defaultEnabled: ['select', 'multi-select'].includes(property.type), custom: true,
      }));
    return [...graphSystemAttributes, ...custom];
  }
  function ensureGraphAttributeSelection() {
    if (Array.isArray(state.graphConfig.attributeIds)) return;
    state.graphConfig.attributeIds = graphAvailableAttributes().filter((attribute) => attribute.defaultEnabled).map((attribute) => attribute.id);
  }
  function graphRuntimeConfig() {
    ensureGraphAttributeSelection();
    return {
      ...state.graphConfig,
      includeSimilarity: state.graphConfig.showSimilarity,
      includeAttributes: state.graphConfig.showAttributes,
      jobs: state.jobs,
      theme: colorSchemeQuery.matches ? 'dark' : 'light',
      fontFamily: readerFontStacks[state.appearance.reader_font] || readerFontStacks.academic,
      layout: 'cose',
      autoFit: true,
    };
  }
  function renderGraphPropertyOptions() {
    const node = $('#graph-property-options');
    if (!node) return;
    ensureGraphAttributeSelection();
    const selected = new Set(state.graphConfig.attributeIds);
    const fragment = document.createDocumentFragment();
    graphAvailableAttributes().forEach((attribute) => {
      const label = document.createElement('label');
      label.className = 'graph-property-option';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = attribute.id;
      input.checked = selected.has(attribute.id);
      const text = document.createElement('span');
      text.textContent = attribute.label;
      const type = document.createElement('small');
      type.textContent = attribute.custom ? '自定义' : '系统';
      label.append(input, text, type);
      fragment.append(label);
    });
    node.replaceChildren(fragment);
  }
  function graphNodeById(nodeId) {
    return state.graphData?.nodes?.find((node) => node.data?.id === nodeId)?.data || null;
  }
  function clearGraphLibrarySelection() {
    state.selectedLibraryJobIds.clear();
    state.selectedLibraryJobId = null;
    refreshRowMenuLabels();
  }
  let pendingDetailsRender = null;
  function detailsSelectionTouches(panel) {
    const selection = document.getSelection();
    if (!panel || !selection || selection.isCollapsed || !selection.rangeCount) return false;
    for (let index = 0; index < selection.rangeCount; index += 1) {
      try {
        if (selection.getRangeAt(index).intersectsNode(panel)) return true;
      } catch (_) { /* A detached range cannot protect the mounted details panel. */ }
    }
    return false;
  }
  function renderDetailsPanel(panel, content, renderKey) {
    if (!panel) return;
    const key = String(renderKey || 'empty');
    if (panel.dataset.detailsRenderKey === key && detailsSelectionTouches(panel)) {
      pendingDetailsRender = { panel, content, key };
      return;
    }
    pendingDetailsRender = null;
    panel.dataset.detailsRenderKey = key;
    panel.innerHTML = `<button class="library-details-close" data-details-close type="button" aria-label="关闭文献详情">×</button>${content}`;
    panel.querySelectorAll('h2, .details-meta, .details-field > dd, .details-abstract, .graph-detail-kicker, .graph-connection-card p').forEach((node) => node.classList.add('copyable-data'));
  }
  document.addEventListener('selectionchange', () => {
    const pending = pendingDetailsRender;
    if (!pending || detailsSelectionTouches(pending.panel)) return;
    window.requestAnimationFrame(() => {
      if (pendingDetailsRender !== pending) return;
      pendingDetailsRender = null;
      renderDetailsPanel(pending.panel, pending.content, pending.key);
    });
  });
  function renderGraphEmptyDetails() {
    clearGraphLibrarySelection();
    setDetailsOpen(false);
    const panel = $('#library-details');
    renderDetailsPanel(panel, '<div class="library-details-empty">选择文献、属性或连接查看详情<br><small>双击文献节点打开阅读器</small></div>', 'graph-empty');
  }
  function selectGraphPaper(nodeData) {
    const jobId = String(nodeData?.jobId || '').trim();
    if (!jobId || !libraryEntryById(jobId)) return;
    state.selectedLibraryJobIds.clear();
    state.selectedLibraryJobIds.add(jobId);
    state.selectedLibraryJobId = jobId;
    refreshRowMenuLabels();
    renderLibraryDetails();
  }
  function renderGraphAttributeDetails(nodeData) {
    clearGraphLibrarySelection();
    const panel = $('#library-details');
    if (!panel) return;
    const jobIds = Array.isArray(nodeData?.jobIds) ? nodeData.jobIds : [];
    const related = jobIds.map((jobId) => libraryEntryById(String(jobId))).filter(Boolean);
    renderDetailsPanel(panel, `
      <p class="graph-detail-kicker">${escapeHTML(nodeData?.propertyLabel || '属性关系')}</p>
      <h2>${escapeHTML(nodeData?.label || '未命名属性')}</h2>
      <p class="details-meta secondary">连接 ${related.length} 篇文献</p>
      <div class="graph-related-list">${related.map((entry) => `<button class="graph-related-paper" data-graph-related-job="${escapeHTML(entry.jobId)}" type="button"><strong>${escapeHTML(itemTitle(entry))}</strong><span>${escapeHTML([itemMetadata(entry).year, itemVenue(entry)].filter(Boolean).join(' · ') || '来源未识别')}</span></button>`).join('') || '<span class="property-placeholder">暂无关联文献</span>'}</div>`, `graph-attribute:${nodeData?.id || nodeData?.propertyId || nodeData?.label || ''}`);
    setDetailsOpen(true);
  }
  function renderGraphEdgeDetails(edgeData) {
    clearGraphLibrarySelection();
    const panel = $('#library-details');
    if (!panel || !edgeData) return;
    const source = graphNodeById(edgeData.source);
    const target = graphNodeById(edgeData.target);
    const similarity = edgeData.type === 'similarity';
    const score = Math.max(0, Math.min(1, Number(edgeData.score) || 0));
    const reasons = Array.isArray(edgeData.reasons) ? edgeData.reasons.filter(Boolean) : [];
    const relatedJobs = [source, target].filter((node) => node?.type === 'paper' && node.jobId);
    renderDetailsPanel(panel, `
      <p class="graph-detail-kicker">${similarity ? '内容相似连接' : escapeHTML(edgeData.propertyLabel || edgeData.label || '属性连接')}</p>
      <h2>${escapeHTML(source?.label || '未知节点')} ↔ ${escapeHTML(target?.label || '未知节点')}</h2>
      <div class="graph-connection-card"><strong>${similarity ? `词面重合得分 ${Math.round(score * 100)}%` : escapeHTML(edgeData.label || '共享属性')}</strong><p>${similarity ? '这是标题、摘要、关键词和研究主题的本地 TF-IDF 比较，不代表语义概率。' : escapeHTML(reasons[0] || `${edgeData.propertyLabel || '属性'}相同`)}</p></div>
      ${reasons.length ? `<dl class="details-fields"><div class="details-field"><dt>连接依据</dt><dd>${reasons.map((reason) => `<span class="tag-chip">${escapeHTML(reason.replace(/^共同内容词：/, ''))}</span>`).join('')}</dd></div></dl>` : ''}
      <div class="graph-related-list">${relatedJobs.map((node) => `<button class="graph-related-paper" data-graph-related-job="${escapeHTML(node.jobId)}" type="button"><strong>${escapeHTML(node.label)}</strong><span>查看文献详情</span></button>`).join('')}</div>`, `graph-edge:${edgeData.id || `${edgeData.source || ''}:${edgeData.target || ''}`}`);
    setDetailsOpen(true);
  }
  function renderGraphPaperConnections(jobId) {
    if (state.libraryMode !== 'graph' || !state.graphData) return '';
    const paperId = `paper:${jobId}`;
    const edges = (state.graphData.edges || []).filter((edge) => edge.data?.source === paperId || edge.data?.target === paperId).slice(0, 8);
    if (!edges.length) return '<h3 class="details-abstract-heading">图谱连接</h3><p class="details-meta secondary">当前筛选条件下没有连接。</p>';
    return `<h3 class="details-abstract-heading">图谱连接</h3><div class="graph-related-list">${edges.map((edge) => {
      const data = edge.data || {};
      const otherId = data.source === paperId ? data.target : data.source;
      const other = graphNodeById(otherId);
      const detail = data.type === 'similarity'
        ? `内容相似 ${Math.round((Number(data.score) || 0) * 100)}%${data.reasons?.length ? ` · ${data.reasons.map((reason) => String(reason).replace(/^共同内容词：/, '')).slice(0, 3).join('、')}` : ''}`
        : `${data.propertyLabel || data.label || '属性关系'}：${other?.label || data.value || '未设置'}`;
      return `<div class="graph-connection-card"><strong>${escapeHTML(other?.label || '关联节点')}</strong><p>${escapeHTML(detail)}</p></div>`;
    }).join('')}</div>`;
  }
  function updateGraphStats(visibleStats = null) {
    const stats = state.graphData?.stats || {};
    const paperCount = visibleStats?.paperCount ?? stats.paperCount ?? 0;
    const attributeCount = visibleStats?.attributeCount ?? stats.attributeCount ?? 0;
    const edgeCount = visibleStats?.edgeCount ?? ((stats.propertyEdgeCount || 0) + (stats.similarityEdgeCount || 0));
    const summary = `${paperCount} 篇 · ${attributeCount} 个属性 · ${edgeCount} 条连接`;
    if ($('#graph-stats')) $('#graph-stats').textContent = summary;
    if (state.libraryMode === 'graph' && $('#library-subtitle')) $('#library-subtitle').textContent = `${summary} · 本地计算`;
  }
  function renderLibraryGraph() {
    renderGraphPropertyOptions();
    $('#graph-toggle-similarity').checked = state.graphConfig.showSimilarity;
    $('#graph-toggle-attributes').checked = state.graphConfig.showAttributes;
    syncGraphViewportScaleControl();
    if (!window.MyScholarGraphView?.create || !window.MyScholarGraphModel?.buildGraph) {
      const empty = $('#library-graph-empty');
      empty.textContent = '关系图谱组件未能加载，请重新打开应用后再试。';
      empty.hidden = false;
      return;
    }
    $('#library-graph-empty').hidden = true;
    if (!state.graphController) {
      state.graphController = window.MyScholarGraphView.create({
        container: $('#library-graph-canvas'),
        listElement: $('#graph-accessible-list'),
        summaryElement: $('#graph-accessible-summary'),
        config: graphRuntimeConfig(),
        onNodeSelect: (nodeData) => {
          if (!nodeData) { renderGraphEmptyDetails(); return; }
          if (nodeData.type === 'paper') selectGraphPaper(nodeData);
          else renderGraphAttributeDetails(nodeData);
        },
        onSelectEdge: (edgeData) => { if (edgeData) renderGraphEdgeDetails(edgeData); },
        onPaperOpen: (nodeData) => { if (nodeData?.jobId) performLibraryRowAction(nodeData.jobId, 'open'); },
        onAccessibilityUpdate: (stats) => updateGraphStats(stats),
        onError: (error) => showToast(`关系图谱加载失败：${error.message}`, true),
      });
    }
    state.graphData = state.graphController.setLibrary(libraryState());
    const query = ($('#graph-search')?.value || '').trim();
    if (query) state.graphController.setSearch(query);
    updateGraphStats();
  }
  function syncGraphSelectionDetails() {
    const paperEntries = (state.graphData?.nodes || [])
      .filter((node) => node.data?.type === 'paper' && node.data?.jobId)
      .map((node) => libraryEntryById(String(node.data.jobId)))
      .filter(Boolean);
    pruneLibrarySelection(paperEntries);
    if (state.selectedLibraryJobId) renderLibraryDetails();
    else renderGraphEmptyDetails();
  }
  function refreshLibraryGraph() {
    if (!state.graphController || state.libraryMode !== 'graph') return;
    state.graphData = state.graphController.updateConfig(graphRuntimeConfig());
    state.graphController.setSearch($('#graph-search')?.value || '');
    updateGraphStats();
    syncGraphSelectionDetails();
  }

  // Inline cell editing. The list used to be read-only data with every change
  // routed through the details panel; a quick change is faster where the value
  // is read. One popover serves every editable cell, shaped by the property's
  // own type.
  const libraryCellEditor = { jobId: '', propertyId: '', anchor: null };
  const CELL_EDITOR_WIDTH = 248;
  // What to offer when setting a property. A curated option list is offered
  // verbatim; an open one (研究主题 ships with none) is answered by what the
  // library already uses, most-used first, so a tag is picked rather than
  // retyped -- and retyping it slightly differently is how a library ends up
  // with two tags for one topic.
  function libraryPropertyChoices(property, current = []) {
    const chosen = (Array.isArray(current) ? current : [current]).map(String).filter(Boolean);
    const configured = (property?.options || []).map(String);
    if (configured.length) return [...new Set([...configured, ...chosen])];
    const usage = new Map();
    Object.values(libraryState().items || {}).forEach((item) => {
      if (!item || item.deleted_at) return;
      const value = item.values?.[property.id];
      (Array.isArray(value) ? value : [value]).forEach((entry) => {
        const text = String(entry ?? '').trim();
        if (text) usage.set(text, (usage.get(text) || 0) + 1);
      });
    });
    chosen.forEach((entry) => { if (!usage.has(entry)) usage.set(entry, 0); });
    return [...usage.keys()].sort((left, right) => (usage.get(right) - usage.get(left)) || left.localeCompare(right, 'zh-CN'));
  }
  function libraryCellCurrent(entry, property) {
    const values = itemValues(entry);
    if (property.type === 'multi-select') return Array.isArray(values[property.id]) ? [...values[property.id]] : [];
    if (property.type === 'rating') return Math.max(0, Math.min(Number(property.max) || 5, Number(values[property.id]) || 0));
    // A venue nobody edited by hand is still shown, derived from the metadata;
    // the editor opens on what the row displays.
    if (property.id === 'venue') return String(values.venue || itemVenue(entry) || '');
    return values[property.id] == null ? '' : String(values[property.id]);
  }
  function libraryCellEditorHTML(property, current) {
    const label = String(property.label || property.id);
    const heading = `<div class="cell-editor-title">${escapeHTML(label)}</div>`;
    if (property.type === 'rating') {
      const max = Math.max(1, Math.min(10, Number(property.max) || 5));
      return `${heading}<div class="cell-editor-stars" role="radiogroup" aria-label="${escapeHTML(label)}">${Array.from({ length: max }, (_, index) => { const score = index + 1; return `<button type="button" class="${score <= current ? 'is-filled' : ''}" data-cell-star="${score}" role="radio" aria-checked="${score === current ? 'true' : 'false'}" aria-label="${score} 星">★</button>`; }).join('')}</div><div class="cell-editor-hint">再次点击当前星级可清空。</div>`;
    }
    if (property.type === 'select') {
      const options = property.id === 'reading_status' ? readingStatusOptions() : libraryPropertyChoices(property, current);
      const clearable = property.id !== 'reading_status';
      return `${heading}<div class="cell-editor-options" role="listbox" aria-label="${escapeHTML(label)}">${options.map((option) => `<button type="button" class="cell-editor-option" role="option" aria-selected="${option === current ? 'true' : 'false'}" data-cell-option="${escapeHTML(option)}">${escapeHTML(option)}</button>`).join('')}${clearable ? `<button type="button" class="cell-editor-option" role="option" aria-selected="${current ? 'false' : 'true'}" data-cell-option="">清除</button>` : ''}</div>`;
    }
    if (property.type === 'multi-select') {
      const choices = libraryPropertyChoices(property, current);
      return `${heading}<div class="cell-editor-tags">${choices.length ? choices.map((choice) => `<button type="button" class="cell-editor-tag" data-cell-tag="${escapeHTML(choice)}" aria-pressed="${current.includes(choice) ? 'true' : 'false'}">${escapeHTML(choice)}</button>`).join('') : '<span class="cell-editor-hint">文献库里还没有这个属性的标签，在下面新建。</span>'}</div><input class="cell-editor-input" data-cell-input type="text" placeholder="输入后回车新增" aria-label="新增${escapeHTML(label)}"><div class="cell-editor-actions"><button type="button" class="tiny-button" data-cell-cancel>取消</button><button type="button" class="primary-button compact-button" data-cell-save>完成</button></div>`;
    }
    return `${heading}<input class="cell-editor-input" data-cell-input type="text" maxlength="1000" value="${escapeHTML(current)}" aria-label="${escapeHTML(label)}"><div class="cell-editor-actions"><button type="button" class="tiny-button" data-cell-cancel>取消</button><button type="button" class="primary-button compact-button" data-cell-save>保存</button></div>`;
  }
  function closeLibraryCellEditor({ restoreFocus = false } = {}) {
    const popover = $('#cell-editor-popover');
    if (!popover || popover.hidden) return false;
    const anchor = libraryCellEditor.anchor;
    popover.hidden = true;
    popover.replaceChildren();
    ['left', 'top', 'width', 'max-height'].forEach((property) => popover.style.removeProperty(property));
    delete popover.dataset.placement;
    libraryCellEditor.jobId = '';
    libraryCellEditor.propertyId = '';
    libraryCellEditor.anchor = null;
    if (restoreFocus && anchor?.isConnected) anchor.focus({ preventScroll: true });
    return true;
  }
  function openLibraryCellEditor(cell) {
    const popover = $('#cell-editor-popover');
    const jobId = cell?.dataset.cellJob || '';
    const propertyId = cell?.dataset.cellEdit || '';
    const entry = libraryEntryById(jobId);
    const property = propertyById(propertyId);
    const reopening = Boolean(popover && !popover.hidden && libraryCellEditor.anchor === cell);
    closeLibraryCellEditor();
    if (reopening || !popover || !entry || !property) return;
    libraryCellEditor.jobId = jobId;
    libraryCellEditor.propertyId = propertyId;
    libraryCellEditor.anchor = cell;
    popover.innerHTML = libraryCellEditorHTML(property, libraryCellCurrent(entry, property));
    popover.hidden = false;
    positionViewportMenu(popover, cell.getBoundingClientRect(), { width: CELL_EDITOR_WIDTH });
    window.requestAnimationFrame(() => {
      (popover.querySelector('[data-cell-input]') || popover.querySelector('[aria-selected="true"],[aria-checked="true"],button'))?.focus({ preventScroll: true });
    });
  }
  function libraryCellEditorValue(popover, property) {
    if (property.type !== 'multi-select') return String(popover.querySelector('[data-cell-input]')?.value || '');
    const chosen = [...popover.querySelectorAll('[data-cell-tag][aria-pressed="true"]')].map((node) => node.dataset.cellTag);
    String(popover.querySelector('[data-cell-input]')?.value || '').split(/[,，、]/).map((item) => item.trim()).filter(Boolean)
      .forEach((item) => { if (!chosen.includes(item)) chosen.push(item); });
    return chosen;
  }
  async function commitLibraryCellValue(value) {
    const { jobId, propertyId } = libraryCellEditor;
    if (!jobId || !propertyId) return;
    closeLibraryCellEditor();
    await updateLibraryItem(jobId, { values: { [propertyId]: value } });
  }
  // A save re-renders the list, so the popover's anchor is replaced rather
  // than moved; re-find the same cell instead of leaving the popover adrift.
  function resyncLibraryCellEditor() {
    const popover = $('#cell-editor-popover');
    if (!popover || popover.hidden || libraryCellEditor.anchor?.isConnected) return;
    const next = document.querySelector(`.library-row[data-job-id="${cssEscape(libraryCellEditor.jobId)}"] [data-cell-edit="${cssEscape(libraryCellEditor.propertyId)}"]`);
    if (!next) { closeLibraryCellEditor(); return; }
    libraryCellEditor.anchor = next;
    positionViewportMenu(popover, next.getBoundingClientRect(), { width: CELL_EDITOR_WIDTH });
  }
  function repositionLibraryCellEditor() {
    const popover = $('#cell-editor-popover');
    if (!popover || popover.hidden) return;
    if (!libraryCellEditor.anchor?.isConnected) { closeLibraryCellEditor(); return; }
    positionViewportMenu(popover, libraryCellEditor.anchor.getBoundingClientRect(), { width: CELL_EDITOR_WIDTH });
  }
  $('#cell-editor-popover')?.addEventListener('click', async (event) => {
    const popover = $('#cell-editor-popover');
    const property = propertyById(libraryCellEditor.propertyId);
    if (!property) return;
    const option = event.target.closest('[data-cell-option]');
    if (option) { await commitLibraryCellValue(option.dataset.cellOption); return; }
    const star = event.target.closest('[data-cell-star]');
    if (star) {
      const entry = libraryEntryById(libraryCellEditor.jobId);
      const current = entry ? libraryCellCurrent(entry, property) : 0;
      const next = Number(star.dataset.cellStar);
      await commitLibraryCellValue(next === current ? 0 : next);
      return;
    }
    const tag = event.target.closest('[data-cell-tag]');
    if (tag) { tag.setAttribute('aria-pressed', String(tag.getAttribute('aria-pressed') !== 'true')); return; }
    if (event.target.closest('[data-cell-cancel]')) { closeLibraryCellEditor({ restoreFocus: true }); return; }
    if (event.target.closest('[data-cell-save]')) await commitLibraryCellValue(libraryCellEditorValue(popover, property));
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && closeLibraryCellEditor({ restoreFocus: true })) event.preventDefault();
  });
  $('#cell-editor-popover')?.addEventListener('keydown', async (event) => {
    if (event.key !== 'Enter' || !event.target.closest('[data-cell-input]')) return;
    event.preventDefault();
    const popover = $('#cell-editor-popover');
    const property = propertyById(libraryCellEditor.propertyId);
    if (!property) return;
    const added = property.type === 'multi-select'
      ? String(event.target.value || '').split(/[,，、]/).map((item) => item.trim()).filter(Boolean)
      : [];
    if (!added.length) { await commitLibraryCellValue(libraryCellEditorValue(popover, property)); return; }
    // Enter on a non-empty field adds the tag and keeps the editor open, so
    // several can be typed in a row before committing.
    const list = popover.querySelector('.cell-editor-tags');
    added.forEach((item) => {
      const existing = list?.querySelector(`[data-cell-tag="${cssEscape(item)}"]`);
      if (existing) { existing.setAttribute('aria-pressed', 'true'); return; }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'cell-editor-tag';
      button.dataset.cellTag = item;
      button.setAttribute('aria-pressed', 'true');
      button.textContent = item;
      list?.append(button);
    });
    event.target.value = '';
  });
  document.addEventListener('pointerdown', (event) => {
    const popover = $('#cell-editor-popover');
    if (!popover || popover.hidden || popover.contains(event.target) || event.target.closest?.('[data-cell-edit]')) return;
    closeLibraryCellEditor();
  });

  function renderLibraryRows(entries) {
    const columns = visibleLibraryColumns();
    const propertyMap = new Map(libraryProperties().map((property) => [property.id, property]));
    return entries.map((entry) => {
      const values = itemValues(entry); const job = entry.job || {}; const counts = job.manifest?.counts || {};
      // A trashed paper is restored before it is edited, so its cells stay flat.
      const editableCell = (propertyId, inner, label) => (entry.item?.deleted_at
        ? inner
        : `<button class="row-cell-button" type="button"${state.health?.readonly === true ? ' disabled' : ''} data-cell-edit="${escapeHTML(propertyId)}" data-cell-job="${escapeHTML(entry.jobId)}" aria-haspopup="dialog" aria-label="设置${escapeHTML(label)}">${inner}</button>`);
      const topics = Array.isArray(values.research_topic) ? values.research_topic : [];
      const title = itemTitle(entry);
      const cell = (column) => {
        const id = String(column.id);
        if (id === 'name') return `<div class="library-row-name"><div class="library-row-name-text"><strong title="${escapeHTML(itemAlias(entry) ? `原题：${itemOriginalTitle(entry)}` : title)}">${escapeHTML(title || '未命名文献')}</strong><small>${escapeHTML(job.created_at ? new Date(job.created_at).toLocaleDateString('zh-CN') : '')} · ${counts.pages || '—'} 页</small></div></div>`;
        if (id === 'title') return `<div class="library-row-title" title="${escapeHTML(title)}">${escapeHTML(title)}</div>`;
        if (id === 'research_topic') return editableCell('research_topic', `<div class="library-tags">${topics.length ? topics.map((topic) => `<span class="tag-chip">${escapeHTML(topic)}</span>`).join('') : '<span class="property-placeholder">—</span>'}</div>`, '研究主题');
        if (id === 'importance') {
          const rating = Math.max(0, Math.min(5, Number(values.importance) || 0));
          return editableCell('importance', `<span class="row-stars" aria-label="重要程度 ${rating} 星">${'★'.repeat(rating)}<span class="star-empty">${'★'.repeat(5 - rating)}</span></span>`, '重要程度');
        }
        if (id === 'reading_status') {
          const currentStatus = String(values.reading_status || '未开始');
          return editableCell('reading_status', `<span class="row-status" data-status="${escapeHTML(currentStatus)}">${escapeHTML(currentStatus)}</span>`, '阅读状态');
        }
        if (id === 'venue') return editableCell('venue', `<span class="row-venue" title="${escapeHTML(itemVenue(entry))}">${escapeHTML(itemVenue(entry) || '—')}</span>`, '接收/来源');
        const property = propertyMap.get(id);
        const hasValue = Array.isArray(values[id]) ? values[id].length : values[id] != null && values[id] !== '';
        const plain = `<span class="row-plain">${hasValue ? escapeHTML(formatPropertyValue(property || { type: 'text' }, values[id])) : '—'}</span>`;
        return property ? editableCell(property.id, plain, property.label || property.id) : plain;
      };
      const shortcut = (label) => `<kbd>${escapeHTML(label)}</kbd>`;
      const selectedCount = selectedLibraryJobIds().length;
      const bulkLabel = selectedCount > 1 ? `（${selectedCount} 篇）` : '';
      const selectedIds = selectedLibraryJobIds();
      const actionIds = selectedIds.includes(entry.jobId) && selectedIds.length > 1 ? selectedIds : [entry.jobId];
      const permanentAllowed = actionIds.every((id) => Boolean(libraryEntryById(id)?.item?.deleted_at));
      const menu = entry.item?.deleted_at
        ? `<button data-row-action="metadata" data-job-id="${escapeHTML(entry.jobId)}" role="menuitem" type="button"${selectedCount > 1 ? ' disabled' : ''}><span>编辑元数据</span>${shortcut(primaryShortcutLabel('I'))}</button><div class="row-menu-separator" role="separator"></div><button data-row-action="restore" data-job-id="${escapeHTML(entry.jobId)}" role="menuitem" type="button"><span class="row-action-label">恢复文献${bulkLabel}</span>${shortcut(primaryShortcutLabel('Backspace'))}</button><button class="is-danger" data-row-action="permanent" data-job-id="${escapeHTML(entry.jobId)}" role="menuitem" type="button"${permanentAllowed ? '' : ' disabled'} title="只能彻底清除全部位于回收站的选中文献"><span class="row-action-label">彻底清除${bulkLabel}</span></button>`
        : `<button data-row-action="open" data-job-id="${escapeHTML(entry.jobId)}" role="menuitem" type="button"${job.status === 'completed' ? '' : ' disabled'}><span>打开文献</span>${shortcut('↩')}</button>${isDesktopApp ? `<button data-row-action="reveal" data-job-id="${escapeHTML(entry.jobId)}" role="menuitem" type="button"${selectedCount > 1 ? ' disabled' : ''}><span>跳转原始文件</span></button>` : ''}<button data-row-action="metadata" data-job-id="${escapeHTML(entry.jobId)}" role="menuitem" type="button"${selectedCount > 1 ? ' disabled' : ''}><span>编辑元数据</span>${shortcut(primaryShortcutLabel('I'))}</button><button data-row-action="folders" data-job-id="${escapeHTML(entry.jobId)}" role="menuitem" type="button"><span class="row-action-label">添加到文件夹${bulkLabel}…</span>${shortcut(primaryShortcutLabel('Shift+F'))}</button><div class="row-menu-separator" role="separator"></div><button class="is-danger" data-row-action="trash" data-job-id="${escapeHTML(entry.jobId)}" role="menuitem" type="button"><span class="row-action-label">移入回收站${bulkLabel}</span>${shortcut(primaryShortcutLabel('Backspace'))}</button>`;
      const selected = selectedLibraryJobIds().includes(entry.jobId);
      return `<article class="library-card library-row${entry.item?.deleted_at ? ' is-trashed' : ''}${selected ? ' is-selected' : ''}" style="--library-grid-template:${libraryGridTemplate(columns)}" data-job-id="${escapeHTML(entry.jobId)}" data-status="${escapeHTML(job.status || '')}" tabindex="0" aria-selected="${selected ? 'true' : 'false'}" aria-grabbed="false" aria-label="文献：${escapeHTML(title)}">${columns.map(cell).join('')}<div class="library-row-actions"><button class="row-more-button" data-row-menu-job-id="${escapeHTML(entry.jobId)}" type="button" aria-label="更多操作" aria-haspopup="menu" aria-expanded="false">⋯</button><div class="row-more-menu" data-row-more-menu data-menu-owner="${escapeHTML(entry.jobId)}" role="menu" aria-label="文献操作">${menu}</div></div></article>`;
    }).join('');
  }
  function renderLibraryContent(entries) {
    pruneLibrarySelection(entries);
    return renderLibraryRows(entries);
  }
  const columnResize = { id: null, pointerId: null, startX: 0, startWidth: 0, min: 0, active: false, handle: null, previousWidth: null, hadPreviousWidth: false };
  function syncColumnResizerARIA() {
    const measurements = $$('#library-columns [data-column-resizer]').map((handle) => {
      const column = visibleLibraryColumns().find((item) => item.id === handle.dataset.columnResizer);
      const header = handle.closest('[data-column-id]');
      if (!column || !header) return null;
      const measured = Math.round(header.getBoundingClientRect().width);
      return [handle, measured || libraryColumnWidth(column) || libraryColumnMinWidth(column)];
    });
    measurements.filter(Boolean).forEach(([handle, width]) => handle.setAttribute('aria-valuenow', String(width)));
  }
  function applyLibraryGridTemplate() {
    const template = libraryGridTemplate(visibleLibraryColumns());
    const minWidth = libraryTableMinWidth(visibleLibraryColumns());
    ['#library-columns', '#recent-list', '#view-results'].forEach((selector) => {
      const node = $(selector);
      if (!node) return;
      node.style.setProperty('--library-grid-template', template);
      node.style.setProperty('--library-table-min-width', minWidth);
    });
    $$('.library-row').forEach((row) => row.style.setProperty('--library-grid-template', template));
    syncColumnResizerARIA();
  }
  function columnDisplayPayload() {
    return libraryDisplayColumns().map((column, index) => ({ id: column.id, label: libraryColumnLabel(column), visible: column.visible !== false, width: libraryColumnWidth(column), order: index }));
  }
  async function persistColumnResize(columnId, previousWidth, hadPreviousWidth) {
    try {
      const payload = await api('/api/library/display', jsonOptions({ columns: columnDisplayPayload(), group_by: activeGroupField() }, 'PATCH'));
      if (payload.library) state.library = payload.library;
      else if (payload.display) state.library.display = payload.display;
      renderLibrary(); renderViews();
    } catch (error) {
      const column = libraryDisplayColumns().find((item) => item.id === columnId);
      if (column) {
        if (hadPreviousWidth) column.width = previousWidth;
        else delete column.width;
      }
      showToast(`保存列宽失败：${error.message}`, true);
      renderLibrary(); renderViews();
    }
  }
  function handleColumnResizeDown(event) {
    const handle = event.target.closest('[data-column-resizer]');
    if (!handle || event.button !== 0) return;
    const column = visibleLibraryColumns().find((item) => item.id === handle.dataset.columnResizer);
    const header = handle.closest('[data-column-id]');
    if (!column || !header) return;
    event.preventDefault(); event.stopPropagation();
    columnResize.id = column.id; columnResize.pointerId = event.pointerId; columnResize.startX = event.clientX; columnResize.startWidth = header.getBoundingClientRect().width; columnResize.min = libraryColumnMinWidth(column); columnResize.active = true; columnResize.handle = handle; columnResize.previousWidth = column.width; columnResize.hadPreviousWidth = Object.prototype.hasOwnProperty.call(column, 'width') && Number.isFinite(Number(column.width));
    try { handle.setPointerCapture?.(event.pointerId); } catch (_error) {}
    document.body.classList.add('resizing-library-column');
    handle.classList.add('is-active');
  }
  function handleColumnResizeMove(event) {
    if (!columnResize.active || event.pointerId !== columnResize.pointerId) return;
    event.preventDefault();
    const column = libraryDisplayColumns().find((item) => item.id === columnResize.id);
    if (!column) return;
    column.width = Math.max(columnResize.min, Math.min(520, Math.round(columnResize.startWidth + event.clientX - columnResize.startX)));
    applyLibraryGridTemplate();
  }
  function handleColumnResizeUp(event) {
    if (!columnResize.active || (event.pointerId != null && event.pointerId !== columnResize.pointerId)) return;
    const id = columnResize.id;
    const previousWidth = columnResize.previousWidth;
    const hadPreviousWidth = columnResize.hadPreviousWidth;
    const handle = columnResize.handle || document.querySelector(`[data-column-resizer="${cssEscape(id || '')}"]`);
    handle?.classList.remove('is-active');
    try { if (handle?.hasPointerCapture?.(columnResize.pointerId)) handle.releasePointerCapture(columnResize.pointerId); } catch (_error) {}
    const column = libraryDisplayColumns().find((item) => item.id === id);
    const changed = Boolean(column && libraryColumnWidth(column) !== Math.round(columnResize.startWidth));
    columnResize.id = null; columnResize.pointerId = null; columnResize.active = false; columnResize.handle = null; columnResize.previousWidth = null; columnResize.hadPreviousWidth = false;
    document.body.classList.remove('resizing-library-column');
    if (changed) persistColumnResize(id, previousWidth, hadPreviousWidth);
  }
  function handleColumnResizeKeyDown(event) {
    const handle = event.target.closest('[data-column-resizer]');
    if (!handle || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    const column = visibleLibraryColumns().find((item) => item.id === handle.dataset.columnResizer);
    const header = handle.closest('[data-column-id]');
    if (!column || !header) return;
    event.preventDefault();
    event.stopPropagation();
    const previousWidth = column.width;
    const hadPreviousWidth = Object.prototype.hasOwnProperty.call(column, 'width') && Number.isFinite(Number(column.width));
    const currentWidth = Math.round(header.getBoundingClientRect().width);
    const step = event.shiftKey ? 32 : 16;
    const nextWidth = Math.max(libraryColumnMinWidth(column), Math.min(520, currentWidth + (event.key === 'ArrowRight' ? step : -step)));
    if (nextWidth === currentWidth) return;
    column.width = nextWidth;
    applyLibraryGridTemplate();
    persistColumnResize(column.id, previousWidth, hadPreviousWidth);
  }
  function formatPropertyValue(property, value) { if (property.type === 'multi-select') return Array.isArray(value) ? value.join(', ') || '添加标签' : '添加标签'; if (property.type === 'rating') return `${value || 0}/${property.max || 5}`; return String(value || '设置'); }
  // The quick filter is a temporary overlay on whatever folder or saved view is
  // open; it is not persisted and never rewrites the view's own filters.
  function syncLibraryStatusFilter() {
    const select = $('#library-status-filter');
    if (!select) return;
    const options = readingStatusOptions();
    const rendered = [...select.options].slice(1).map((option) => option.value);
    if (rendered.join('\u0000') !== options.join('\u0000')) {
      select.replaceChildren(new Option('全部状态', ''), ...options.map((status) => new Option(status, status)));
    }
    if (!options.includes(state.libraryStatusFilter)) state.libraryStatusFilter = '';
    select.value = state.libraryStatusFilter;
    select.classList.toggle('is-filtering', Boolean(state.libraryStatusFilter));
  }
  let renderedLibraryMode = null;
  let renderedLibraryKey = null;
  function renderLibrary(jobs = state.jobs, { reuse = false } = {}) {
    const library = libraryState();
    const graphMode = state.libraryMode === 'graph';
    const query = ($('#library-search')?.value || '').trim().toLowerCase();
    const renderKey = JSON.stringify([library, jobs, state.activeFolderId, state.activeFolderId ? null : state.activeViewId,
      state.libraryMode, state.activeGroupValue, state.librarySort, state.libraryStatusFilter, query, [...state.selectedLibraryJobIds]]);
    if (reuse && !graphMode && renderedLibraryKey === renderKey) {
      syncLibrarySelection();
      return;
    }
    renderedLibraryKey = graphMode ? null : renderKey;
    document.body.classList.toggle('library-graph-mode', graphMode);
    syncLibrarySelection();
    $('#library-list-actions').hidden = graphMode;
    $('#library-graph-actions').hidden = !graphMode;
    $('#library-list-surface').hidden = graphMode;
    $('#library-graph-surface').hidden = !graphMode;
    if (renderedLibraryMode !== null && renderedLibraryMode !== state.libraryMode && !reducedMotionQuery.matches) {
      const surface = $(graphMode ? '#library-graph-surface' : '#library-list-surface');
      surface.classList.add('library-surface-entering');
      surface.addEventListener('animationend', () => surface.classList.remove('library-surface-entering'), { once: true });
    }
    renderedLibraryMode = state.libraryMode;
    $('#library-count').textContent = String(Object.keys(library.items || {}).filter((id) => !library.items[id]?.deleted_at).length || jobs.length);
    renderFolderTree(); updateFolderCounts(); renderSidebarViews();
    $$('[data-library-folder]').forEach((button) => button.classList.toggle('active', !graphMode && button.dataset.libraryFolder === state.activeFolderId));
    $('.library-grouping-heading').hidden = graphMode;
    $('#library-grouping-list').hidden = graphMode;
    if (graphMode) {
      $('#library-heading').textContent = '关系图谱';
      $('#library-subtitle').textContent = state.health?.readonly === true ? '公开样例 · 只读体验 · 关系图谱' : '属性关系与可解释的内容相似连接';
      renderLibraryGraph();
      syncGraphSelectionDetails();
      return;
    }
    teardownLibraryGraph();
    renderGroupingSidebar();
    let entries = libraryItemEntries();
    entries = state.activeFolderId ? entries.filter((entry) => itemMatchesFolder(entry, state.activeFolderId)) : applyActiveView(entries);
    if (!entries.length && jobs.length) {
      entries = jobs.map((job) => ({ jobId: job.job_id, job, item: library.items?.[job.job_id] || {} }));
      entries = state.activeFolderId ? entries.filter((entry) => itemMatchesFolder(entry, state.activeFolderId)) : applyActiveView(entries);
    }
    if (state.activeGroupValue) {
      const selectedGroup = groupedEntries(entries, activeGroupField()).find((group) => group.label === state.activeGroupValue);
      entries = selectedGroup?.entries || [];
    }
    if (query) entries = entries.filter((entry) => itemSearchText(entry).includes(query));
    syncLibraryStatusFilter();
    if (state.libraryStatusFilter) entries = entries.filter((entry) => String(itemValues(entry).reading_status || '未开始') === state.libraryStatusFilter);
    entries.sort((a, b) => compareLibraryEntries(a, b, state.librarySort));
    const activeFolder = folderById(state.activeFolderId); const selectedView = activeView(); $('#library-heading').textContent = activeFolder?.name || selectedView?.name || (state.activeGroupValue ? `${groupFieldLabel()}：${state.activeGroupValue}` : (state.activeFolderId === 'system-trash' ? '回收站' : '全部文献'));
    $('#library-subtitle').textContent = state.health?.readonly === true ? `${entries.length} 篇 · 公开样例 · 只读体验` : state.activeFolderId === 'system-trash' ? '可恢复的本地文献' : `${entries.length} 篇${state.libraryStatusFilter ? ` · 阅读状态：${state.libraryStatusFilter}` : ''} · 本机保存 · HTML 连续阅读`;
    if ($('#library-sort')) $('#library-sort').value = state.librarySort;
    const columns = visibleLibraryColumns();
    const template = libraryGridTemplate(columns);
    const header = $('#library-columns');
    if (header) {
      header.style.setProperty('--library-grid-template', template);
      header.style.setProperty('--library-table-min-width', libraryTableMinWidth(columns));
      header.innerHTML = `${columns.map((column) => `<span class="library-column-header" data-column-id="${escapeHTML(column.id)}" role="columnheader"><span class="library-column-label">${escapeHTML(libraryColumnLabel(column))}</span><button class="column-resizer" data-column-resizer="${escapeHTML(column.id)}" type="button" role="separator" aria-orientation="vertical" aria-valuemin="${libraryColumnMinWidth(column)}" aria-valuemax="520" aria-valuenow="${libraryColumnWidth(column) || libraryColumnMinWidth(column)}" aria-label="调整${escapeHTML(libraryColumnLabel(column))}列宽"></button></span>`).join('')}<span class="library-actions-header" aria-hidden="true"></span>`;
    }
    if (!entries.length) { clearLibrarySelection(); $('#recent-list').innerHTML = `<div class="empty-state">${state.activeFolderId === 'system-trash' ? '回收站为空。' : '没有匹配的文献。拖入一份 PDF 开始。'}</div>`; syncColumnResizerARIA(); return; }
    $('#recent-list').style.setProperty('--library-grid-template', template);
    $('#recent-list').style.setProperty('--library-table-min-width', libraryTableMinWidth(columns));
    $('#recent-list').innerHTML = renderLibraryContent(entries);
    syncLibrarySelection();
    renderLibraryDetails();
    resyncLibraryCellEditor();
    syncColumnResizerARIA();
  }
  async function loadLibrary() {
    try {
      const [jobsPayload, libraryPayload] = await Promise.all([api('/api/jobs'), api('/api/library')]);
      state.jobs = jobsPayload.jobs || []; state.library = libraryPayload.library || null;
      resumeRunningReflows();
      const stored = JSON.parse(persistentStateGet(openTabsStorageKey) || '[]');
      if (Array.isArray(stored)) state.openDocuments = stored.map((id) => state.jobs.find((job) => job.job_id === id)).filter((job) => job?.status === 'completed');
      renderLibrary(); renderViews(); renderDocumentTabs();
      if (state.activeJob) { const refreshed = state.jobs.find((item) => item.job_id === state.activeJob.job_id); if (refreshed) state.activeJob = refreshed; renderDocumentTabs(); }
    } catch (error) { $('#recent-list').innerHTML = `<div class="empty-state">文献库读取失败：${escapeHTML(error.message)}</div>`; }
  }
  $('#library-search').addEventListener('input', () => { clearLibrarySelection(); renderLibrary(); });
  $('#library-sort')?.addEventListener('change', (event) => { state.librarySort = event.target.value; renderLibrary(); });
  $('#library-status-filter')?.addEventListener('change', (event) => { state.libraryStatusFilter = event.target.value; clearLibrarySelection(); renderLibrary(); });
  function syncLibrarySelection() {
    $$('.library-row').forEach((row) => {
      const selected = state.selectedLibraryJobIds.has(row.dataset.jobId);
      row.classList.toggle('is-selected', selected);
      row.setAttribute('aria-selected', String(selected));
    });
  }
  $('#graph-toggle-similarity')?.addEventListener('change', (event) => {
    state.graphConfig.showSimilarity = event.target.checked;
    persistGraphPreferences();
    refreshLibraryGraph();
  });
  $('#graph-toggle-attributes')?.addEventListener('change', (event) => {
    state.graphConfig.showAttributes = event.target.checked;
    persistGraphPreferences();
    refreshLibraryGraph();
  });
  $('#graph-property-options')?.addEventListener('change', (event) => {
    if (!(event.target instanceof HTMLInputElement) || event.target.type !== 'checkbox') return;
    ensureGraphAttributeSelection();
    const selected = new Set(state.graphConfig.attributeIds);
    if (event.target.checked) selected.add(event.target.value);
    else selected.delete(event.target.value);
    state.graphConfig.attributeIds = [...selected];
    persistGraphPreferences();
    refreshLibraryGraph();
  });
  $('#graph-zoom')?.addEventListener('input', (event) => {
    state.graphConfig.viewportScale = normalizeGraphViewportScale(Number(event.target.value) / 100);
    syncGraphViewportScaleControl();
    state.graphController?.setViewportScale?.(state.graphConfig.viewportScale);
    persistGraphPreferences();
  });
  $('#graph-search')?.addEventListener('input', (event) => {
    const matches = state.graphController?.setSearch?.(event.target.value) || [];
    if (event.target.value.trim()) $('#library-subtitle').textContent = `找到 ${matches.length} 篇文献 · 保留直接属性关系`;
    else updateGraphStats();
  });
  $('#graph-fit-button')?.addEventListener('click', () => state.graphController?.fit?.({ animate: true }));
  $$('#library-system-filters .system-filter').forEach((button) => button.addEventListener('click', () => { state.libraryMode = 'list'; state.activeFolderId = button.dataset.libraryFolder; state.activeViewId = null; state.activeGroupValue = null; clearLibrarySelection(); renderLibrary(); }));
  $('#create-folder-button')?.addEventListener('click', createFolder);
  $('#manage-views-button')?.addEventListener('click', () => switchView('views-view'));
  $('#views-back-button')?.addEventListener('click', () => openPrimaryView('library-view'));
  function libraryEntryById(jobId) { return libraryItemEntries().find((candidate) => candidate.jobId === jobId); }
  function selectedLibraryJobIds() { return [...state.selectedLibraryJobIds]; }
  function refreshRowMenuLabels() {
    const selectedCount = state.selectedLibraryJobIds.size;
    const bulkLabel = selectedCount > 1 ? `（${selectedCount} 篇）` : '';
    document.querySelectorAll('[data-row-action="folders"] .row-action-label').forEach((node) => { node.textContent = `添加到文件夹${bulkLabel}…`; });
    document.querySelectorAll('[data-row-action="trash"] .row-action-label').forEach((node) => { node.textContent = `移入回收站${bulkLabel}`; });
    document.querySelectorAll('[data-row-action="restore"] .row-action-label').forEach((node) => { node.textContent = `恢复文献${bulkLabel}`; });
    document.querySelectorAll('[data-row-action="permanent"] .row-action-label').forEach((node) => { node.textContent = `彻底清除${bulkLabel}`; });
  }
  function pruneLibrarySelection(entries) {
    const visibleIds = new Set((entries || []).map((entry) => entry?.jobId).filter(Boolean));
    for (const jobId of state.selectedLibraryJobIds) {
      if (!visibleIds.has(jobId)) state.selectedLibraryJobIds.delete(jobId);
    }
    if (!state.selectedLibraryJobIds.size) state.selectedLibraryJobId = null;
    else if (!state.selectedLibraryJobIds.has(state.selectedLibraryJobId)) state.selectedLibraryJobId = [...state.selectedLibraryJobIds][0];
    refreshRowMenuLabels();
  }
  function clearLibrarySelection({ renderDetails = true } = {}) {
    state.selectedLibraryJobIds.clear();
    state.selectedLibraryJobId = null;
    refreshRowMenuLabels();
    syncLibrarySelection();
    if (renderDetails) renderLibraryDetails();
    else setDetailsOpen(false);
  }
  function renderedLibraryRows(root = document) { return [...root.querySelectorAll('.library-row')]; }
  function selectLibraryRow(row, { focus = false, additive = false, range = false } = {}) {
    if (!row) return;
    const jobId = row.dataset.jobId || null;
    const rows = renderedLibraryRows(row.closest('.library-list') || document);
    if (!additive && !range) clearLibrarySelection();
    if (range && state.selectedLibraryJobId) {
      const start = rows.findIndex((candidate) => candidate.dataset.jobId === state.selectedLibraryJobId);
      const end = rows.indexOf(row);
      if (start >= 0 && end >= 0) rows.slice(Math.min(start, end), Math.max(start, end) + 1).forEach((candidate) => state.selectedLibraryJobIds.add(candidate.dataset.jobId));
      else if (jobId) state.selectedLibraryJobIds.add(jobId);
    } else if (jobId) {
      if (additive && state.selectedLibraryJobIds.has(jobId)) state.selectedLibraryJobIds.delete(jobId);
      else state.selectedLibraryJobIds.add(jobId);
    }
    // A Command/Ctrl click can remove the last selected row. Keep the focus
    // anchor only while there is an actual selection so row shortcuts cannot
    // act on a visually unselected document.
    state.selectedLibraryJobId = state.selectedLibraryJobIds.size
      ? (state.selectedLibraryJobIds.has(jobId) ? jobId : [...state.selectedLibraryJobIds][0])
      : null;
    syncLibrarySelection();
    refreshRowMenuLabels();
    renderLibraryDetails();
    if (focus) row.focus({ preventScroll: true });
  }
  function closeRowMenu(row, { restoreFocus = false } = {}) {
    if (!row) return;
    row.classList.remove('menu-open');
    const trigger = row.querySelector('[data-row-menu-job-id]');
    const menu = row.querySelector('[data-row-more-menu]');
    trigger?.setAttribute('aria-expanded', 'false');
    if (menu) { delete menu.dataset.anchorX; delete menu.dataset.anchorY; delete menu.dataset.anchorOffsetX; delete menu.dataset.anchorOffsetY; }
    if (restoreFocus) row.focus({ preventScroll: true });
  }
  function closeAllRowMenus(except = null) {
    $$('.library-row.menu-open').forEach((row) => { if (row !== except) closeRowMenu(row); });
  }
  function openRowMenu(row, { clientX = null, clientY = null, focusFirst = false } = {}) {
    if (!row) return;
    closeAllRowMenus(row);
    if (!state.selectedLibraryJobIds.has(row.dataset.jobId)) selectLibraryRow(row);
    const menu = row.querySelector('[data-row-more-menu]');
    row.classList.add('menu-open');
    row.querySelector('[data-row-menu-job-id]')?.setAttribute('aria-expanded', 'true');
    if (menu && Number.isFinite(clientX) && Number.isFinite(clientY)) {
      menu.dataset.anchorX = String(clientX);
      menu.dataset.anchorY = String(clientY);
      delete menu.dataset.anchorOffsetX;
      delete menu.dataset.anchorOffsetY;
    }
    refreshRowMenuLabels();
    window.requestAnimationFrame(() => {
      positionRowMenu(row, menu);
      if (focusFirst) menu?.querySelector('button:not([disabled])')?.focus({ preventScroll: true });
    });
  }
  async function performLibraryRowAction(jobId, action) {
    const entry = libraryEntryById(jobId);
    if (!entry) return;
    const selectedIds = selectedLibraryJobIds();
    const actionIds = selectedIds.includes(jobId) && selectedIds.length > 1 ? selectedIds : [jobId];
    if (action === 'permanent' && actionIds.some((id) => !libraryEntryById(id)?.item?.deleted_at)) {
      showToast('只能彻底清除全部位于回收站的选中文献。', true);
      return;
    }
    if (action === 'folders' || action === 'trash' || action === 'restore' || action === 'permanent') {
      if (actionIds.length > 1) { await applyBulkRowAction(actionIds, action); return; }
    }
    if (action === 'open') {
      if (entry.item?.deleted_at) await restoreLibraryItem(jobId);
      else if (entry.job?.status === 'completed') openReader(entry.job);
    } else if (action === 'reveal') {
      if (!window.myScholarDesktop?.showItemInFolder) return;
      try {
        const result = await window.myScholarDesktop.showItemInFolder(jobId);
        if (result && result.ok === false) throw new Error(result.error || '无法打开原始文件。');
      } catch (error) {
        showToast(error.message || '无法打开原始文件。', true);
      }
    } else if (action === 'folders') await editLibraryFolders(jobId);
    else if (action === 'metadata') openMetadataDialog(jobId);
    else if (action === 'trash') await trashLibraryItem(jobId);
    else if (action === 'restore') await restoreLibraryItem(jobId);
    else if (action === 'permanent') await permanentlyDeleteLibraryItem(jobId);
  }
  async function setInlineImportance(jobId, rating) {
    const item = libraryState().items?.[jobId];
    const next = Math.max(0, Math.min(5, Number(rating) || 0));
    if (!item || state.inlineImportanceSaving.has(jobId) || Number(item.values?.importance || 0) === next) return;
    const hadValue = Object.prototype.hasOwnProperty.call(item.values || {}, 'importance');
    const previous = item.values?.importance;
    item.values ||= {};
    item.values.importance = next;
    state.inlineImportanceSaving.add(jobId);
    renderLibrary(); renderViews();
    try {
      const payload = await api(`/api/library/items/${jobId}`, jsonOptions({ values: { importance: next } }, 'PATCH'));
      if (payload?.library) state.library = payload.library;
    } catch (error) {
      if (hadValue) item.values.importance = previous;
      else delete item.values.importance;
      showToast(`重要程度保存失败：${error.message}`, true);
    } finally {
      state.inlineImportanceSaving.delete(jobId);
      renderLibrary(); renderViews();
      window.requestAnimationFrame(() => {
        const group = document.querySelector('#library-details .details-stars');
        (group?.querySelector('[aria-checked="true"]') || group?.querySelector('[data-details-importance]'))?.focus({ preventScroll: true });
      });
    }
  }
  // Mobile shell helpers: on phones the sidebar and details panel are
  // overlays. Declarations are hoisted so the renderers below can call them.
  const mobileLayout = window.matchMedia('(max-width: 860px)');
  const sheetLayout = window.matchMedia('(max-width: 1119px)');
  function isMobileLayout() { return mobileLayout.matches; }
  function syncLibraryOverlayAccessibility() {
    const sidebar = $('.library-sidebar');
    const main = $('.library-main');
    const details = $('#library-details');
    const sidebarOpen = isMobileLayout() && document.body.classList.contains('sidebar-open');
    const detailsOpen = sheetLayout.matches && document.body.classList.contains('details-open');
    if (sidebar) {
      sidebar.inert = isMobileLayout() && !sidebarOpen;
      sidebar.setAttribute('aria-hidden', String(isMobileLayout() && !sidebarOpen));
    }
    if (main) main.inert = sidebarOpen;
    if (details) {
      details.inert = sidebarOpen || (sheetLayout.matches && !detailsOpen);
      details.setAttribute('aria-hidden', String(sidebarOpen || (sheetLayout.matches && !detailsOpen)));
    }
  }
  function setSidebarOpen(open, { restoreFocus = false } = {}) {
    const next = Boolean(open) && isMobileLayout();
    const wasOpen = document.body.classList.contains('sidebar-open');
    const focusWasInside = Boolean($('.library-sidebar')?.contains(document.activeElement));
    if (!next && state.groupingMenuOpen) setGroupingMenuOpen(false);
    if (next && !wasOpen) mobileSidebarTrigger = document.activeElement;
    document.body.classList.toggle('sidebar-open', next);
    const scrim = $('#library-scrim');
    if (scrim) scrim.hidden = !next;
    const toggle = $('#mobile-sidebar-toggle');
    toggle?.setAttribute('aria-expanded', String(next));
    toggle?.setAttribute('aria-label', next ? '关闭文件夹与视图' : '打开文件夹与视图');
    syncLibraryOverlayAccessibility();
    if (next) window.requestAnimationFrame(() => $('.library-sidebar button:not([disabled]), .library-sidebar a[href]')?.focus({ preventScroll: true }));
    else if (wasOpen && (restoreFocus || focusWasInside)) {
      const trigger = mobileSidebarTrigger?.isConnected ? mobileSidebarTrigger : toggle;
      window.requestAnimationFrame(() => trigger?.focus({ preventScroll: true }));
    }
    if (!next) mobileSidebarTrigger = null;
  }
  function setDetailsOpen(open, { restoreFocus = false } = {}) {
    const next = Boolean(open) && sheetLayout.matches;
    const wasOpen = document.body.classList.contains('details-open');
    const focusWasInside = Boolean($('#library-details')?.contains(document.activeElement));
    if (next && !wasOpen) mobileDetailsTrigger = document.activeElement;
    document.body.classList.toggle('details-open', next);
    syncLibraryOverlayAccessibility();
    if (!next && wasOpen && (restoreFocus || focusWasInside) && mobileDetailsTrigger?.isConnected) {
      window.requestAnimationFrame(() => mobileDetailsTrigger?.focus({ preventScroll: true }));
    }
    if (!next) mobileDetailsTrigger = null;
  }

  // Zotero-style details panel: the third column shows the selected paper
  // and owns all per-item editing that used to live inline in the rows.
  function renderLibraryDetails() {
    setDetailsOpen(state.selectedLibraryJobIds.size > 0);
    const panel = $('#library-details');
    if (!panel) return;
    const ids = selectedLibraryJobIds();
    if (!ids.length) {
      renderDetailsPanel(panel, '<div class="library-details-empty">选择一篇文献查看详情<br><small>双击或回车打开阅读器</small></div>', 'library-empty');
      return;
    }
    if (ids.length > 1) {
      const allTrashed = ids.every((id) => libraryEntryById(id)?.item?.deleted_at);
      const permanentAction = allTrashed ? `<button class="secondary-button danger-button" data-details-action="permanent" type="button">彻底清除已选文献</button>` : '';
      renderDetailsPanel(panel, `<div class="library-details-empty">已选中 ${ids.length} 篇文献</div><div class="details-actions"><button class="secondary-button" data-details-action="folders" type="button">添加到文件夹…</button><button class="secondary-button" data-details-action="trash" type="button">移入回收站</button>${permanentAction}</div>`, `library-multi:${[...ids].sort().join(',')}`);
      return;
    }
    const entry = libraryEntryById(ids[0]);
    if (!entry) { renderDetailsPanel(panel, '<div class="library-details-empty">选择一篇文献查看详情</div>', `library-missing:${ids[0]}`); return; }
    const values = itemValues(entry);
    const metadata = itemMetadata(entry);
    const job = entry.job || {};
    const trashed = Boolean(entry.item?.deleted_at);
    const rating = Math.max(0, Math.min(5, Number(values.importance) || 0));
    const currentStatus = String(values.reading_status || '未开始');
    const authors = Array.isArray(metadata.authors) ? metadata.authors : [];
    const topics = Array.isArray(values.research_topic) ? values.research_topic : [];
    const folders = (entry.item?.folder_ids || []).map((id) => folderById(id)?.name).filter(Boolean);
    const customProperties = libraryProperties().filter((property) => !systemLibraryColumnIds.has(property.id));
    const field = (label, value) => `<div class="details-field"><dt>${escapeHTML(label)}</dt><dd>${value}</dd></div>`;
    const editButton = (propertyId) => `<button class="details-edit-button" data-details-edit="${escapeHTML(propertyId)}" type="button">编辑</button>`;
    const actions = trashed
      ? `<button class="primary-button" data-details-action="restore" type="button">恢复文献</button><button class="secondary-button" data-details-action="metadata" type="button">元数据</button>`
      // Opening and trashing both live on the row itself (double-click, the
      // ⋯ menu), so the panel keeps only what it alone offers.
      : `<button class="secondary-button" data-details-action="metadata" type="button">元数据</button><button class="secondary-button" data-details-action="folders" type="button">文件夹…</button>`;
    renderDetailsPanel(panel, `
      <h2 title="${escapeHTML(itemOriginalTitle(entry))}">${escapeHTML(itemTitle(entry))}</h2>
      ${itemAlias(entry) ? `<p class="details-meta secondary details-original-title">原题：${escapeHTML(itemOriginalTitle(entry))}</p>` : ''}
      ${authors.length ? `<p class="details-meta">${escapeHTML(authors.slice(0, 6).join('，'))}${authors.length > 6 ? ' 等' : ''}</p>` : ''}
      <p class="details-meta secondary">${escapeHTML([metadata.year, itemVenue(entry)].filter(Boolean).join(' · ') || '来源未识别')}</p>
      <div class="details-actions">${actions}</div>
      <dl class="details-fields">
        ${field('显示名称', `<span class="details-edit-value"><span>${itemAlias(entry) ? escapeHTML(itemAlias(entry)) : '<span class="property-placeholder">未设置</span>'}</span>${editButton('alias')}</span>`)}
        ${field('重要程度', `<span class="details-stars" role="radiogroup" aria-label="重要程度">${Array.from({ length: 5 }, (_, index) => { const score = index + 1; return `<button type="button"${state.health?.readonly === true ? ' disabled' : ''} class="${score <= rating ? 'is-filled' : ''}" data-details-importance="${score}" role="radio" aria-checked="${score === rating ? 'true' : 'false'}" aria-label="设为 ${score} 星">★</button>`; }).join('')}</span>`)}
        ${field('阅读状态', `<select class="details-status-select"${state.health?.readonly === true ? ' disabled' : ''} data-details-status-select aria-label="阅读状态">${readingStatusOptions().map((option) => `<option${option === currentStatus ? ' selected' : ''}>${escapeHTML(option)}</option>`).join('')}</select>`)}
        ${field('研究主题', `<span class="details-edit-value">${topics.length ? topics.map((topic) => `<span class="tag-chip">${escapeHTML(topic)}</span>`).join('') : '<span class="property-placeholder">未设置</span>'}${editButton('research_topic')}</span>`)}
        ${field('接收/来源', `<span class="details-edit-value"><span>${escapeHTML(itemVenue(entry) || '未设置')}</span>${editButton('venue')}</span>`)}
        ${customProperties.map((property) => { const raw = values[property.id]; const has = Array.isArray(raw) ? raw.length : raw != null && raw !== ''; return field(property.label || property.id, `<span class="details-edit-value"><span>${has ? escapeHTML(formatPropertyValue(property, raw)) : '<span class="property-placeholder">未设置</span>'}</span>${editButton(property.id)}</span>`); }).join('')}
        ${folders.length ? field('文件夹', escapeHTML(folders.join('，'))) : ''}
        ${field('加入时间', escapeHTML(job.created_at ? new Date(job.created_at).toLocaleDateString('zh-CN') : '—'))}
        ${metadata.doi ? field('DOI', escapeHTML(metadata.doi)) : ''}
      </dl>
      ${metadata.abstract ? `<h3 class="details-abstract-heading">摘要</h3><p class="details-abstract">${escapeHTML(String(metadata.abstract).slice(0, 900))}${String(metadata.abstract).length > 900 ? '…' : ''}</p>` : ''}
      ${renderGraphPaperConnections(entry.jobId)}`, `library-paper:${entry.jobId}`);
  }
  $('#library-details')?.addEventListener('change', (event) => {
    const select = event.target.closest('[data-details-status-select]');
    const jobId = state.selectedLibraryJobId;
    if (select && jobId) updateLibraryItem(jobId, { values: { reading_status: select.value } });
  });
  $('#library-details')?.addEventListener('click', async (event) => {
    if (event.target.closest('[data-details-close]')) {
      setDetailsOpen(false, { restoreFocus: true });
      return;
    }
    const related = event.target.closest('[data-graph-related-job]');
    if (related) {
      const jobId = related.dataset.graphRelatedJob;
      state.graphController?.focusNode?.(jobId, { select: true, notify: true });
      return;
    }
    const jobId = state.selectedLibraryJobId;
    if (!jobId) return;
    const action = event.target.closest('[data-details-action]');
    if (action) { await performLibraryRowAction(jobId, action.dataset.detailsAction); return; }
    const star = event.target.closest('[data-details-importance]');
    if (star) {
      const current = Number(itemValues(libraryEntryById(jobId) || {})?.importance || 0);
      const next = Number(star.dataset.detailsImportance);
      await setInlineImportance(jobId, next === current ? 0 : next);
      return;
    }
    const edit = event.target.closest('[data-details-edit]');
    if (edit) {
      if (edit.dataset.detailsEdit === 'alias') editLibraryAlias(jobId);
      else editLibraryProperty(jobId, edit.dataset.detailsEdit);
    }
  });

  async function handleLibraryListClick(event) {
    if (event.target.closest?.('#library-graph-surface')) return;
    if (libraryDrag.suppressClickUntil > Date.now()) { event.preventDefault(); event.stopPropagation(); return; }
    // Pointer capture retargets the click generated after a marquee release to
    // the list itself. Consume that one click regardless of dispatch latency.
    if (libraryMarquee.suppressNextClick) {
      libraryMarquee.suppressNextClick = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    // Close any other transient surface first, keeping one popup open at a time.
    if (!event.target.closest('[data-row-more-menu],[data-row-menu-job-id]')) closeAllRowMenus();
    const row = event.target.closest('.library-row');
    const groupFilter = event.target.closest('[data-group-filter]');
    if (groupFilter) {
      event.stopPropagation();
      const value = groupFilter.dataset.groupFilter || null;
      state.activeGroupValue = state.activeGroupValue === value ? null : value;
      renderLibrary();
      return;
    }
    const rowSurface = row && !event.target.closest('button, select, input, a, [data-row-more-menu]');
    if (!row && !event.target.closest('button, select, input, a, [data-row-more-menu]')) {
      clearLibrarySelection();
      return;
    }
    if (rowSurface) selectLibraryRow(row, { additive: event.metaKey || event.ctrlKey, range: event.shiftKey });
    const menuTrigger = event.target.closest('[data-row-menu-job-id]');
    if (menuTrigger) {
      event.stopPropagation();
      const menuRow = menuTrigger.closest('.library-row');
      if (menuRow?.classList.contains('menu-open')) closeRowMenu(menuRow);
      else openRowMenu(menuRow, { focusFirst: event.detail === 0 });
      return;
    }
    const rowAction = event.target.closest('[data-row-action]');
    if (rowAction) {
      event.stopPropagation();
      const jobId = rowAction.dataset.jobId;
      const action = rowAction.dataset.rowAction;
      closeRowMenu(rowAction.closest('.library-row'));
      await performLibraryRowAction(jobId, action);
      return;
    }
    const cell = event.target.closest('[data-cell-edit]');
    if (cell) {
      event.stopPropagation();
      const cellRow = cell.closest('.library-row');
      if (cellRow && !state.selectedLibraryJobIds.has(cellRow.dataset.jobId)) selectLibraryRow(cellRow);
      openLibraryCellEditor(cell);
    }
  }
  async function handleLibraryListDblClick(event) {
    const row = event.target.closest('.library-row');
    if (!row) return;
    // Value cells are buttons, and they cover most of a row. Double-clicking
    // one still means "open this paper" -- the quick editor the first click
    // opened gives way rather than swallowing the gesture.
    const control = event.target.closest('button, select, input, a, [data-row-more-menu]');
    if (control && !control.closest('[data-cell-edit]')) return;
    closeLibraryCellEditor();
    event.preventDefault();
    selectLibraryRow(row);
    await performLibraryRowAction(row.dataset.jobId, 'open');
  }
  const libraryDrag = { timer: null, row: null, pointerId: null, startX: 0, startY: 0, active: false, additive: false, targetFolder: null, ghost: null, suppressClickUntil: 0 };
  const libraryMarquee = { list: null, pointerId: null, startX: 0, startY: 0, active: false, additive: false, pendingClear: false, originSelected: new Set(), element: null, suppressNextClick: false };
  function librarySelectionSurface(node) {
    if (!node) return null;
    if (node.matches?.('.library-main, .view-editor')) return node;
    return node.closest?.('.library-main, .view-editor') || null;
  }
  function isLibraryGraphSurface(node) {
    return Boolean(node?.closest?.('#library-graph-surface'));
  }
  function clearLibraryMarquee({ preserveSuppression = false } = {}) {
    const list = libraryMarquee.list;
    const pointerId = libraryMarquee.pointerId;
    if (list && pointerId != null && list.hasPointerCapture?.(pointerId)) {
      try { list.releasePointerCapture(pointerId); } catch (_error) {}
    }
    libraryMarquee.element?.remove();
    document.body.classList.remove('library-marquee-selecting');
    libraryMarquee.list = null;
    libraryMarquee.pointerId = null;
    libraryMarquee.startX = 0;
    libraryMarquee.startY = 0;
    libraryMarquee.active = false;
    libraryMarquee.additive = false;
    libraryMarquee.pendingClear = false;
    libraryMarquee.originSelected = new Set();
    libraryMarquee.element = null;
    if (!preserveSuppression) libraryMarquee.suppressNextClick = false;
  }
  function beginLibraryMarquee(list, event, { startX = event.clientX, startY = event.clientY, additive = event.metaKey || event.ctrlKey } = {}) {
    if (!list) return;
    clearLibraryMarquee();
    libraryMarquee.list = list;
    libraryMarquee.pointerId = event.pointerId;
    libraryMarquee.startX = startX;
    libraryMarquee.startY = startY;
    libraryMarquee.additive = additive;
    libraryMarquee.pendingClear = !additive;
    libraryMarquee.originSelected = new Set(state.selectedLibraryJobIds);
    try { list.setPointerCapture?.(event.pointerId); } catch (_error) {}
  }
  function applyMarqueeSelection(nextIds, { renderDetails = true } = {}) {
    const previous = state.selectedLibraryJobIds;
    if (previous.size === nextIds.size && [...previous].every((jobId) => nextIds.has(jobId))) return;
    previous.clear();
    nextIds.forEach((jobId) => previous.add(jobId));
    state.selectedLibraryJobId = previous.size ? [...previous][0] : null;
    syncLibrarySelection();
    refreshRowMenuLabels();
    if (renderDetails) renderLibraryDetails();
  }
  function updateLibraryMarquee(event) {
    if (!libraryMarquee.list || event.pointerId !== libraryMarquee.pointerId) return;
    const moved = Math.hypot(event.clientX - libraryMarquee.startX, event.clientY - libraryMarquee.startY) > 6;
    if (!libraryMarquee.active && !moved) return;
    if (!libraryMarquee.active) {
      libraryMarquee.active = true;
      setDetailsOpen(false);
      if (libraryMarquee.pendingClear) {
        libraryMarquee.pendingClear = false;
        clearLibrarySelection({ renderDetails: false });
      }
      document.body.classList.add('library-marquee-selecting');
      libraryMarquee.element = document.createElement('div');
      libraryMarquee.element.className = 'library-selection-marquee';
      document.body.append(libraryMarquee.element);
    }
    event.preventDefault();
    const listRect = libraryMarquee.list.getBoundingClientRect();
    const left = Math.max(listRect.left, Math.min(libraryMarquee.startX, event.clientX));
    const right = Math.min(listRect.right, Math.max(libraryMarquee.startX, event.clientX));
    const top = Math.max(listRect.top, Math.min(libraryMarquee.startY, event.clientY));
    const bottom = Math.min(listRect.bottom, Math.max(libraryMarquee.startY, event.clientY));
    if (libraryMarquee.element) {
      libraryMarquee.element.style.left = `${left}px`;
      libraryMarquee.element.style.top = `${top}px`;
      libraryMarquee.element.style.width = `${Math.max(1, right - left)}px`;
      libraryMarquee.element.style.height = `${Math.max(1, bottom - top)}px`;
    }
    const nextIds = new Set(libraryMarquee.additive ? libraryMarquee.originSelected : []);
    renderedLibraryRows(libraryMarquee.list).forEach((row) => {
      const rect = row.getBoundingClientRect();
      if (rect.right >= left && rect.left <= right && rect.bottom >= top && rect.top <= bottom) nextIds.add(row.dataset.jobId);
    });
    applyMarqueeSelection(nextIds, { renderDetails: false });
  }
  function finishLibraryMarquee(event) {
    if (!libraryMarquee.list || event.pointerId !== libraryMarquee.pointerId) return false;
    const active = libraryMarquee.active;
    const cancelled = event.type === 'pointercancel';
    if (active && !cancelled) {
      event.preventDefault();
      libraryMarquee.suppressNextClick = true;
    }
    clearLibraryMarquee({ preserveSuppression: active && !cancelled });
    if (active) renderLibraryDetails();
    return true;
  }
  function clearLibraryDrag({ preserveSuppression = false } = {}) {
    if (libraryDrag.timer) window.clearTimeout(libraryDrag.timer);
    libraryDrag.timer = null;
    if (libraryDrag.row) {
      libraryDrag.row.classList.remove('is-dragging');
      libraryDrag.row.setAttribute('aria-grabbed', 'false');
    }
    document.querySelectorAll('.library-drop-target').forEach((node) => node.classList.remove('library-drop-target'));
    libraryDrag.ghost?.remove();
    libraryDrag.ghost = null;
    document.body.classList.remove('library-dragging');
    libraryDrag.row = null;
    libraryDrag.pointerId = null;
    libraryDrag.active = false;
    libraryDrag.additive = false;
    libraryDrag.targetFolder = null;
    if (!preserveSuppression) libraryDrag.suppressClickUntil = 0;
  }
  function updateLibraryDragTarget(clientX, clientY) {
    const target = document.elementFromPoint(clientX, clientY)?.closest?.('[data-library-folder]');
    document.querySelectorAll('.library-drop-target').forEach((node) => node.classList.remove('library-drop-target'));
    libraryDrag.targetFolder = target?.dataset.libraryFolder || null;
    if (target && !['system-all', 'system-unfiled', 'system-trash'].includes(libraryDrag.targetFolder)) target.classList.add('library-drop-target');
  }
  async function finishLibraryDrag() {
    const row = libraryDrag.row;
    const folderId = libraryDrag.targetFolder;
    const ids = selectedLibraryJobIds().includes(row?.dataset.jobId) ? selectedLibraryJobIds() : [row?.dataset.jobId];
    const active = libraryDrag.active;
    clearLibraryDrag({ preserveSuppression: active });
    if (!active || !row || !folderId || ['system-all', 'system-unfiled', 'system-trash'].includes(folderId)) return;
    try {
      for (const jobId of ids.filter(Boolean)) {
        const entry = libraryEntryById(jobId);
        const folderIds = [...new Set([...(entry?.item?.folder_ids || []), folderId])];
        await api(`/api/library/items/${jobId}`, jsonOptions({ folder_ids: folderIds }, 'PATCH'));
      }
      clearLibrarySelection();
      await loadLibrary();
      renderLibrary();
      showToast(ids.length > 1 ? `已将 ${ids.length} 篇文献加入文件夹。` : '已加入文件夹。');
    } catch (error) { showToast(`拖拽归类失败：${error.message}`, true); }
  }
  function handleLibraryPointerDown(event) {
    if (event.button !== 0) return;
    if (isLibraryGraphSurface(event.target)) return;
    // A new pointer gesture supersedes a pending click from the previous
    // marquee; this prevents an unrelated button click from being consumed if
    // the browser delivered events out of order.
    libraryMarquee.suppressNextClick = false;
    const row = event.target.closest('.library-row');
    const interactive = event.target.closest('button, select, input, a, [data-row-more-menu]');
    const surface = librarySelectionSurface(event.currentTarget);
    if (!row && !interactive && surface) {
      clearLibraryDrag();
      beginLibraryMarquee(surface, event);
      return;
    }
    if (!row || interactive) return;
    clearLibraryMarquee();
    clearLibraryDrag();
    libraryDrag.row = row;
    libraryDrag.pointerId = event.pointerId;
    libraryDrag.startX = event.clientX;
    libraryDrag.startY = event.clientY;
    libraryDrag.additive = event.metaKey || event.ctrlKey;
    libraryDrag.timer = window.setTimeout(() => {
      if (!libraryDrag.row) return;
      libraryDrag.active = true;
      libraryDrag.suppressClickUntil = Date.now() + 650;
      row.classList.add('is-dragging');
      row.setAttribute('aria-grabbed', 'true');
      document.body.classList.add('library-dragging');
      const title = row.querySelector('.library-row-name strong')?.textContent?.trim() || '文献';
      libraryDrag.ghost = document.createElement('div');
      libraryDrag.ghost.className = 'library-drag-ghost';
      libraryDrag.ghost.textContent = title;
      document.body.append(libraryDrag.ghost);
      updateLibraryDragTarget(event.clientX, event.clientY);
    }, 420);
  }
  function handleLibraryPointerMove(event) {
    if (libraryMarquee.list && event.pointerId === libraryMarquee.pointerId) {
      updateLibraryMarquee(event);
      return;
    }
    if (!libraryDrag.row || event.pointerId !== libraryDrag.pointerId) return;
    const moved = Math.hypot(event.clientX - libraryDrag.startX, event.clientY - libraryDrag.startY) > 8;
    if (!libraryDrag.active && moved) {
      const surface = librarySelectionSurface(libraryDrag.row);
      const startX = libraryDrag.startX;
      const startY = libraryDrag.startY;
      const additive = libraryDrag.additive;
      clearLibraryDrag();
      if (surface) {
        beginLibraryMarquee(surface, event, { startX, startY, additive });
        updateLibraryMarquee(event);
      }
      return;
    }
    if (!libraryDrag.active) return;
    event.preventDefault();
    if (libraryDrag.ghost) { libraryDrag.ghost.style.left = `${event.clientX + 14}px`; libraryDrag.ghost.style.top = `${event.clientY + 14}px`; }
    updateLibraryDragTarget(event.clientX, event.clientY);
  }
  function handleLibraryPointerUp(event) {
    if (libraryMarquee.list && event.pointerId === libraryMarquee.pointerId) {
      finishLibraryMarquee(event);
      return;
    }
    if (!libraryDrag.row || event.pointerId !== libraryDrag.pointerId) return;
    if (libraryDrag.active) { event.preventDefault(); finishLibraryDrag(); }
    else clearLibraryDrag();
  }
  $$('.library-main, .view-editor').forEach((surface) => {
    surface.addEventListener('click', handleLibraryListClick);
    surface.addEventListener('pointerdown', handleLibraryPointerDown);
  });
  ['#recent-list', '#view-results'].forEach((selector) => {
    const list = $(selector);
    list?.addEventListener('dblclick', handleLibraryListDblClick);
    list?.addEventListener('focusin', (event) => { const row = event.target.closest('.library-row'); if (row && !state.selectedLibraryJobIds.size) selectLibraryRow(row); });
    list?.addEventListener('keydown', handleLibraryListKeydown);
    list?.addEventListener('contextmenu', handleLibraryListContextMenu);
    list?.addEventListener('scroll', repositionOpenRowMenus, { passive: true });
  });
  function handleLibraryListContextMenu(event) {
    const row = event.target.closest('.library-row');
    if (!row) return;
    event.preventDefault();
    if (!state.selectedLibraryJobIds.has(row.dataset.jobId)) selectLibraryRow(row, { focus: true });
    else row.focus({ preventScroll: true });
    openRowMenu(row, { clientX: event.clientX, clientY: event.clientY, focusFirst: true });
  }
  function handleLibraryListKeydown(event) {
    const menu = event.target.closest('[data-row-more-menu]');
    if (menu) {
      const items = [...menu.querySelectorAll('button:not([disabled])')];
      const index = items.indexOf(event.target);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      } else if (event.key === 'Escape') {
        event.preventDefault(); closeRowMenu(menu.closest('.library-row'), { restoreFocus: true });
      } else if (event.key === 'Tab') closeRowMenu(menu.closest('.library-row'));
      return;
    }
    const row = event.target.closest('.library-row');
    if (!row || event.target !== row) return;
    if (event.key === 'Enter') { event.preventDefault(); selectLibraryRow(row); performLibraryRowAction(row.dataset.jobId, 'open'); }
    else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); openRowMenu(row, { focusFirst: true }); }
    else if (event.key === 'Escape') { event.preventDefault(); closeRowMenu(row); }
  }
  function positionRowMenu(row, menu) {
    if (!row || !menu || !row.classList.contains('menu-open')) return;
    const rowRect = row.getBoundingClientRect();
    const menuHeight = menu.getBoundingClientRect().height;
    const menuWidth = menu.getBoundingClientRect().width;
    const gap = 4;
    const padding = 8;
    const anchorX = Number(menu.dataset.anchorX); const anchorY = Number(menu.dataset.anchorY);
    const pointerAnchored = Number.isFinite(anchorX) && Number.isFinite(anchorY);
    const spaceBelow = window.innerHeight - rowRect.bottom - padding;
    const spaceAbove = rowRect.top - padding;
    let menuUp = !pointerAnchored && spaceBelow < menuHeight + gap && spaceAbove >= menuHeight + gap;
    let top;
    let left;
    if (pointerAnchored) {
      menuUp = window.innerHeight - anchorY < menuHeight + padding && anchorY - menuHeight - padding >= 0;
      left = anchorX;
      top = menuUp ? anchorY - menuHeight - gap : anchorY;
    } else {
      top = menuUp ? rowRect.top - menuHeight - gap : rowRect.bottom + gap;
      left = rowRect.right - menuWidth - 14;
    }
    left = Math.max(padding, Math.min(window.innerWidth - menuWidth - padding, left));
    top = Math.max(padding, Math.min(window.innerHeight - menuHeight - padding, top));
    menu.style.top = `${Math.round(top)}px`;
    menu.style.left = `${Math.round(left)}px`;
    menu.style.right = 'auto';
    menu.style.bottom = 'auto';
    menu.classList.toggle('menu-up', menuUp);
  }
  function repositionOpenRowMenus() {
    $$('.library-row.menu-open').forEach((row) => positionRowMenu(row, row.querySelector('.row-more-menu')));
    repositionLibraryCellEditor();
  }
  window.addEventListener('resize', repositionOpenRowMenus, { passive: true });
  window.addEventListener('scroll', repositionOpenRowMenus, { passive: true });
  document.addEventListener('pointermove', handleLibraryPointerMove, { passive: false });
  document.addEventListener('pointerup', handleLibraryPointerUp, { passive: false });
  document.addEventListener('pointercancel', handleLibraryPointerUp, { passive: false });
  document.addEventListener('pointerdown', handleColumnResizeDown, { passive: false });
  document.addEventListener('pointermove', handleColumnResizeMove, { passive: false });
  document.addEventListener('pointerup', handleColumnResizeUp, { passive: false });
  document.addEventListener('pointercancel', handleColumnResizeUp, { passive: false });
  document.addEventListener('keydown', handleColumnResizeKeyDown);
  function handleLibrarySelectAllShortcut(event) {
    if (event.defaultPrevented || event.repeat || event.isComposing) return;
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || String(event.key || '').toLowerCase() !== 'a') return;
    if (!$('#library-view')?.classList.contains('active-view') && !$('#views-view')?.classList.contains('active-view')) return;
    if ($('dialog[open]') || isEditableAppSurface(event.target) || event.target?.closest?.('select')) return;
    const list = $('#library-view')?.classList.contains('active-view') ? $('#recent-list') : $('#view-results');
    const ids = renderedLibraryRows(list).map((row) => row.dataset.jobId).filter(Boolean);
    if (!ids.length) return;
    event.preventDefault();
    closeAllRowMenus();
    applyMarqueeSelection(new Set(ids));
  }
  document.addEventListener('keydown', handleLibrarySelectAllShortcut);
  document.addEventListener('click', (event) => {
    if (event.target.closest('.row-more-menu,[data-row-menu-job-id]')) return;
    closeAllRowMenus();
    if (state.libraryMode === 'list' && !event.target.closest('.library-grouping-heading,#library-grouping-list,#grouping-field-menu')) setGroupingMenuOpen(false);
  });

  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.repeat || !state.selectedLibraryJobId) return;
    if (!$('#library-view')?.classList.contains('active-view') && !$('#views-view')?.classList.contains('active-view')) return;
    if ($('dialog[open]') || isEditableAppSurface(event.target) || event.target.closest('select')) return;
    const focusedRow = document.activeElement?.closest?.('.library-row');
    if (!focusedRow || focusedRow.dataset.jobId !== state.selectedLibraryJobId || !focusedRow.closest('.active-view')) return;
    // Keep Control free for native text editing on macOS.
    const command = primaryModifierPressed(event);
    const key = String(event.key || '').toLowerCase();
    let action = null;
    if (command && !event.altKey && !event.shiftKey && key === 'i') action = 'metadata';
    else if (command && !event.altKey && event.shiftKey && key === 'f') action = 'folders';
    else if (command && !event.altKey && !event.shiftKey && ['backspace', 'delete'].includes(key)) action = libraryEntryById(state.selectedLibraryJobId)?.item?.deleted_at ? 'restore' : 'trash';
    if (!action) return;
    event.preventDefault();
    closeAllRowMenus();
    performLibraryRowAction(state.selectedLibraryJobId, action);
  });

  async function refreshLibraryFrom(payload) {
    if (payload?.library) state.library = payload.library;
    else return loadLibrary();
    renderLibrary(); renderViews();
  }
  async function updateLibraryItem(jobId, body) {
    try { const payload = await api(`/api/library/items/${jobId}`, jsonOptions(body, 'PATCH')); await refreshLibraryFrom(payload); showToast('文献属性已保存。'); }
    catch (error) { showToast(error.message, true); }
  }
  function openLibraryEditor(title, content, submit) {
    const dialog = $('#library-editor-dialog'); const form = $('#library-editor-form');
    if (!dialog || !form) return;
    $('#library-editor-title').textContent = title;
    $('#library-editor-content').innerHTML = content;
    state.libraryEditorSubmit = submit;
    if (dialog.open) dialog.close();
    dialog.showModal();
  }
  function resolveConfirmation(value) {
    const resolver = state.confirmResolver;
    state.confirmResolver = null;
    const dialog = $('#confirm-dialog');
    if (dialog?.open) dialog.close();
    if (resolver) resolver(Boolean(value));
  }
  function requestConfirmation(message, title = '请确认', { accept = '确定', cancel = '取消' } = {}) {
    const dialog = $('#confirm-dialog');
    if (!dialog) return Promise.resolve(false);
    if (state.confirmResolver) resolveConfirmation(false);
    $('#confirm-title').textContent = title;
    $('#confirm-message').textContent = message;
    $('#confirm-accept').textContent = accept;
    $('#confirm-cancel').textContent = cancel;
    dialog.showModal();
    return new Promise((resolve) => { state.confirmResolver = resolve; });
  }
  $('#confirm-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    resolveConfirmation(event.submitter?.value === 'default');
  });
  $('#confirm-dialog')?.addEventListener('cancel', (event) => {
    event.preventDefault();
    resolveConfirmation(false);
  });
  $('#confirm-dialog')?.addEventListener('close', () => {
    if (state.confirmResolver) resolveConfirmation(false);
  });
  ['#library-editor-dialog', '#metadata-dialog'].forEach((selector) => {
    const dialog = $(selector);
    dialog?.addEventListener('click', (event) => {
      if (event.target !== dialog) return;
      event.preventDefault();
      dialog.close('cancel');
    });
  });
  $('#library-editor-form')?.addEventListener('submit', async (event) => {
    if (event.submitter && event.submitter.value !== 'default') { state.libraryEditorSubmit = null; return; }
    event.preventDefault();
    const save = $('#library-editor-save'); save.disabled = true;
    try { if (state.libraryEditorSubmit) await state.libraryEditorSubmit($('#library-editor-content')); $('#library-editor-dialog').close(); }
    catch (error) { showToast(error.message, true); }
    finally { save.disabled = false; }
  });
  // In a `method="dialog"` form WebKit may choose the first (cancel) submit
  // button for an implicit Enter press. Explicitly route Enter from a library
  // property field through the save button so a topic is never discarded.
  $('#library-editor-dialog')?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing || event.shiftKey || event.target.matches('textarea')) return;
    if (!event.target.closest('#library-editor-content')) return;
    event.preventDefault();
    $('#library-editor-save')?.click();
  });
  $('#library-editor-dialog')?.addEventListener('close', () => { state.libraryEditorSubmit = null; });
  async function editLibraryFolders(jobId) {
    const entry = libraryItemEntries().find((candidate) => candidate.jobId === jobId);
    if (!entry) return;
    const folders = (libraryState().folders || []).filter((folder) => !folder.system);
    if (!folders.length) { showToast('请先在左侧新建一个文件夹。', true); return; }
    const selected = new Set(entry.item?.folder_ids || []);
    openLibraryEditor('选择文献分类', `<div class="folder-option-list">${folders.map((folder) => `<label class="folder-option${selected.has(folder.id) ? ' active' : ''}"><input type="checkbox" data-folder-choice="${escapeHTML(folder.id)}"${selected.has(folder.id) ? ' checked' : ''} hidden>${escapeHTML(folder.name)}</label>`).join('')}</div>`, async (content) => {
      const ids = [...content.querySelectorAll('[data-folder-choice]:checked')].map((input) => input.dataset.folderChoice);
      await updateLibraryItem(jobId, { folder_ids: ids });
    });
    $('#library-editor-content')?.querySelectorAll('.folder-option').forEach((label) => label.addEventListener('click', () => { const input = label.querySelector('input'); window.setTimeout(() => label.classList.toggle('active', input.checked), 0); }));
  }
  async function editLibraryFoldersBulk(jobIds) {
    const ids = [...new Set(jobIds)].filter(Boolean);
    if (ids.length <= 1) { if (ids[0]) await editLibraryFolders(ids[0]); return; }
    const folders = (libraryState().folders || []).filter((folder) => !folder.system);
    if (!folders.length) { showToast('请先在左侧新建一个文件夹。', true); return; }
    const first = libraryEntryById(ids[0]);
    const selected = new Set(first?.item?.folder_ids || []);
    openLibraryEditor(`选择 ${ids.length} 篇文献的分类`, `<p class="dialog-hint">选择后会应用到当前选中的全部文献。</p><div class="folder-option-list">${folders.map((folder) => `<label class="folder-option${selected.has(folder.id) ? ' active' : ''}"><input type="checkbox" data-folder-choice="${escapeHTML(folder.id)}"${selected.has(folder.id) ? ' checked' : ''} hidden>${escapeHTML(folder.name)}</label>`).join('')}</div>`, async (content) => {
      const folderIds = [...content.querySelectorAll('[data-folder-choice]:checked')].map((input) => input.dataset.folderChoice);
      for (const id of ids) await api(`/api/library/items/${id}`, jsonOptions({ folder_ids: folderIds }, 'PATCH'));
      await loadLibrary();
      clearLibrarySelection();
      renderLibrary(); renderViews();
    });
    $('#library-editor-content')?.querySelectorAll('.folder-option').forEach((label) => label.addEventListener('click', () => { const input = label.querySelector('input'); window.setTimeout(() => label.classList.toggle('active', input.checked), 0); }));
  }
  async function createFolder() {
    openLibraryEditor('新建文件夹', '<label>文件夹名称<input id="editor-folder-name" maxlength="120" placeholder="例如：项目 / 月份" autofocus></label>', async (content) => {
      const name = content.querySelector('#editor-folder-name').value.trim();
      if (!name) throw new Error('文件夹名称不能为空。');
      const payload = await api('/api/library/folders', jsonOptions({ name })); await refreshLibraryFrom(payload);
    });
  }

  function openColumnsEditor() {
    const columns = libraryDisplayColumns();
    const columnRows = columns.map((column) => {
      const id = escapeHTML(column.id);
      const label = escapeHTML(libraryColumnLabel(column));
      const deleteControl = column.system
        ? '<span class="column-delete-spacer" aria-hidden="true"></span>'
        : `<button class="column-delete-button" data-column-delete="${id}" type="button" title="删除自定义列" aria-label="删除${label}自定义列"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"></path><path d="M9 7V4h6v3"></path><path d="m6 7 1 13h10l1-13"></path><path d="M10 11v5M14 11v5"></path></svg></button>`;
      return `<div class="column-option" data-column-id="${id}" draggable="true"><button class="column-grip" type="button" data-column-grip="${id}" aria-label="移动${label}列，使用方向键调整顺序">⋮⋮</button><label class="column-visibility"><input type="checkbox" data-column-visible="${id}" aria-label="显示${label}列"${column.visible !== false ? ' checked' : ''}><span class="custom-check" aria-hidden="true">✓</span></label><div class="column-option-main"><input class="column-label-input" data-column-label="${id}" aria-label="${label}列名称" value="${label}" maxlength="80"><span class="column-system-note">${column.system ? '系统列 · 可隐藏，不可删除' : '自定义列'}</span></div>${deleteControl}</div>`;
    }).join('');
    const content = `<div class="columns-editor"><div class="columns-editor-intro"><p>把常用信息排到前面，通过勾选决定哪些列显示在文献库中。</p><span>列宽请在文献库表头拖动调整</span></div><section class="columns-existing"><div class="columns-editor-heading"><strong>当前列</strong><span>拖动卡片或使用方向键调整顺序</span></div><div class="columns-list">${columnRows}</div></section><aside class="column-creator"><div class="columns-editor-heading"><strong>添加自定义列</strong><span>创建适合当前研究流程的新字段</span></div><div class="column-creator-grid"><label>列名称<input id="editor-new-column-label" maxlength="80" placeholder="例如：实验阶段"></label><label>列类型<select id="editor-new-column-type"><option value="text">文本</option><option value="select">单选</option><option value="multi-select">多选标签</option><option value="rating">评分</option></select></label></div><label id="editor-new-column-options" hidden>可选值（用逗号分隔）<input id="editor-new-column-options-value" placeholder="例如：待读，精读，已归档"></label><label class="column-visibility-toggle"><input id="editor-new-column-visible" type="checkbox" checked><span class="custom-check" aria-hidden="true">✓</span><span>创建后立即显示</span></label><p class="column-creator-note">系统列可以隐藏但不能删除；自定义列可通过卡片右侧的删除按钮移除。</p></aside></div>`;
    openLibraryEditor('文献库列设置', content, async (node) => {
      const ordered = [...node.querySelectorAll('.column-option')].map((option) => option.dataset.columnId);
      const configured = ordered.map((id, index) => {
        const column = columns.find((item) => item.id === id) || {};
        return {
        id: column.id,
        label: node.querySelector(`[data-column-label="${cssEscape(column.id)}"]`)?.value.trim() || libraryColumnLabel(column),
        visible: Boolean(node.querySelector(`[data-column-visible="${cssEscape(column.id)}"]`)?.checked),
        system: Boolean(column.system),
        order: index,
        };
      });
      const label = node.querySelector('#editor-new-column-label')?.value.trim() || '';
      const type = node.querySelector('#editor-new-column-type')?.value || 'text';
      const visible = Boolean(node.querySelector('#editor-new-column-visible')?.checked);
      if (!configured.some((column) => column.visible) && (!label || !visible)) throw new Error('至少显示一列。');
      let payload = await api('/api/library/display', jsonOptions({ columns: configured, group_by: activeGroupField() }, 'PATCH'));
      if (label) {
        const options = (node.querySelector('#editor-new-column-options-value')?.value || '').split(/[,，、]/).map((item) => item.trim()).filter(Boolean);
        payload = await api('/api/library/properties', jsonOptions({ label, type, options, visible }));
      }
      await refreshLibraryFrom(payload);
    });
    $('#editor-new-column-type')?.addEventListener('change', (event) => { $('#editor-new-column-options').hidden = !['select', 'multi-select'].includes(event.target.value); });
    const list = $('#library-editor-content .columns-list');
    list?.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-column-delete]');
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      const columnId = button.dataset.columnDelete;
      const columnIndex = columns.findIndex((column) => String(column.id) === columnId);
      const column = columns[columnIndex];
      if (!column || column.system) return;
      const option = button.closest('.column-option');
      const currentLabel = option?.querySelector(`[data-column-label="${cssEscape(columnId)}"]`)?.value.trim() || libraryColumnLabel(column);
      if (!await requestConfirmation(`删除自定义列“${currentLabel}”？现有文献中的该字段值也会被移除。`, '删除自定义列')) return;
      button.disabled = true;
      try {
        const payload = await api(`/api/library/properties/${columnId}`, { method: 'DELETE' });
        columns.splice(columnIndex, 1);
        option?.remove();
        await refreshLibraryFrom(payload);
        showToast('自定义列已删除。');
      } catch (error) {
        button.disabled = false;
        showToast(error.message, true);
      }
    });
    let draggedColumn = null;
    const visualColumnCount = () => {
      const options = [...list.querySelectorAll(':scope > .column-option')];
      if (options.length < 2) return 1;
      const firstTop = options[0].offsetTop;
      const rowBreak = options.findIndex((option) => Math.abs(option.offsetTop - firstTop) > 1);
      return rowBreak > 0 ? rowBreak : options.length;
    };
    list?.addEventListener('dragstart', (event) => { const option = event.target.closest('.column-option'); if (!option) return; draggedColumn = option; option.classList.add('is-dragging'); event.dataTransfer.effectAllowed = 'move'; });
    list?.addEventListener('dragover', (event) => {
      if (!draggedColumn) return;
      event.preventDefault();
      const target = event.target.closest('.column-option');
      if (!target || target === draggedColumn) return;
      const targetRect = target.getBoundingClientRect();
      const insertBefore = visualColumnCount() > 1
        ? event.clientX < targetRect.left + targetRect.width / 2
        : event.clientY < targetRect.top + targetRect.height / 2;
      target.parentElement.insertBefore(draggedColumn, insertBefore ? target : target.nextSibling);
    });
    list?.addEventListener('dragend', () => { draggedColumn?.classList.remove('is-dragging'); draggedColumn = null; });
    list?.addEventListener('keydown', (event) => {
      const grip = event.target.closest('[data-column-grip]');
      if (!grip || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      const option = grip.closest('.column-option');
      if (!option) return;
      const options = [...list.querySelectorAll(':scope > .column-option')];
      const currentIndex = options.indexOf(option);
      const rowSize = visualColumnCount();
      const offset = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' ? -rowSize : rowSize;
      const targetIndex = currentIndex + offset;
      if (currentIndex < 0 || targetIndex < 0 || targetIndex >= options.length) return;
      const target = options[targetIndex];
      event.preventDefault();
      if (targetIndex < currentIndex) list.insertBefore(option, target);
      else list.insertBefore(option, target.nextElementSibling);
      grip.focus();
    });
  }
  $('#columns-button')?.addEventListener('click', openColumnsEditor);
  async function editFolder(folderId) {
    const folder = folderById(folderId); if (!folder || folder.system) return;
    openLibraryEditor('重命名文件夹', `<label>文件夹名称<input id="editor-folder-name" maxlength="120" value="${escapeHTML(folder.name)}" autofocus></label>`, async (content) => {
      const name = content.querySelector('#editor-folder-name').value.trim();
      if (!name || name === folder.name) return;
      const payload = await api(`/api/library/folders/${folderId}`, jsonOptions({ name }, 'PATCH')); await refreshLibraryFrom(payload);
    });
  }
  async function deleteFolder(folderId) {
    const folder = folderById(folderId); if (!folder || folder.system) return;
    if (!await requestConfirmation(`删除文件夹“${folder.name}”？文献不会被删除，只会回到未分类。`, '删除文件夹')) return;
    try {
      const payload = await api(`/api/library/folders/${folderId}`, { method: 'DELETE' });
      if (state.activeFolderId === folderId) { state.activeFolderId = 'system-unfiled'; state.activeViewId = null; }
      await refreshLibraryFrom(payload);
    } catch (error) { showToast(error.message, true); }
  }
  async function trashLibraryItem(jobId) {
    if (!await requestConfirmation('将这篇文献移入本机回收站？原始 PDF 和阅读产物会保留。', '移入回收站')) return;
    try { const payload = await api(`/api/library/items/${jobId}/trash`, jsonOptions({})); await refreshLibraryFrom(payload); }
    catch (error) { showToast(error.message, true); }
  }

  async function removeDeletedDocumentState(jobId) {
    const run = state.translationRuns.get(jobId);
    if (run?.running) cancelTranslationRun(run);
    state.translationRuns.delete(jobId);
    state.translationCaches.delete(jobId);
    dropReflowRun(jobId);
    state.jobs = state.jobs.filter((job) => job.job_id !== jobId);
    state.mediaLayouts.delete(jobId);
    state.chatSessions.delete(jobId);
    disposeReaderMount(jobId);
    if (readingLocationsState.locations[jobId]) {
      delete readingLocationsState.locations[jobId];
      readingLocationsState.lru = readingLocationsState.lru.filter((candidate) => candidate !== jobId);
      if (readingLocationsState.lastActiveJobId === jobId) readingLocationsState.lastActiveJobId = null;
      persistReadingLocations();
    }
    const index = state.openDocuments.findIndex((item) => item.job_id === jobId);
    if (index < 0) {
      if (state.activeJob?.job_id === jobId) {
        state.activeJob = null;
        activeJobId = null;
        state.translationCache = [];
        state.translationRun = null;
        switchView('library-view');
      } else {
        renderDocumentTabs();
      }
      return;
    }
    const wasActive = state.activeJob?.job_id === jobId;
    state.openDocuments.splice(index, 1);
    persistOpenDocuments();
    if (!wasActive) {
      renderDocumentTabs();
      return;
    }
    const next = state.openDocuments[index] || state.openDocuments[index - 1];
    if (next) {
      openReader(next, { addTab: false });
      // openReader captures the outgoing viewport before mounting the next
      // tab; remove that location again because this document no longer exists.
      delete readingLocationsState.locations[jobId];
      readingLocationsState.lru = readingLocationsState.lru.filter((candidate) => candidate !== jobId);
      if (readingLocationsState.lastActiveJobId === jobId) readingLocationsState.lastActiveJobId = null;
      persistReadingLocations();
      return;
    }
    state.activeJob = null;
    activeJobId = null;
    state.translationCache = [];
    state.translationRun = null;
    switchView('library-view');
  }

  async function permanentlyDeleteLibraryItem(jobId) {
    const entry = libraryEntryById(jobId);
    if (!entry?.item?.deleted_at) { showToast('只有回收站中的文献可以彻底清除。', true); return; }
    if (!await requestConfirmation('彻底清除这篇文献？原始 PDF、解析结果、译文、笔记和批注都会被删除，且无法恢复。', '彻底清除文献')) return;
    try {
      const payload = await api(`/api/library/items/${jobId}/permanent`, { method: 'DELETE' });
      await removeDeletedDocumentState(jobId);
      await refreshLibraryFrom(payload);
      clearLibrarySelection();
    } catch (error) { showToast(error.message, true); }
  }
  async function applyBulkRowAction(jobIds, action) {
    const ids = [...new Set(jobIds)].filter(Boolean);
    if (!ids.length) return;
    if (action === 'permanent' && ids.some((id) => !libraryEntryById(id)?.item?.deleted_at)) {
      showToast('只能彻底清除全部位于回收站的选中文献。', true);
      return;
    }
    if (action === 'folders') { await editLibraryFoldersBulk(ids); return; }
    if (action === 'trash' && !await requestConfirmation(`将选中的 ${ids.length} 篇文献移入本机回收站？`, '批量移入回收站')) return;
    if (action === 'permanent' && !await requestConfirmation(`彻底清除选中的 ${ids.length} 篇文献？原始 PDF、解析结果、译文、笔记和批注都会被删除，且无法恢复。`, '批量彻底清除')) return;
    try {
      const deletedIds = [];
      let batchPayload = null;
      if (action === 'permanent') {
        batchPayload = await api('/api/library/items/permanent', jsonOptions({ job_ids: ids }));
        (Array.isArray(batchPayload.deleted) ? batchPayload.deleted : []).forEach((id) => deletedIds.push(id));
      } else {
        for (const id of ids) {
          const endpoint = action === 'trash' ? 'trash' : 'restore';
          await api(`/api/library/items/${id}/${endpoint}`, jsonOptions({}));
        }
      }
      for (const id of deletedIds) await removeDeletedDocumentState(id);
      if (batchPayload?.library) state.library = batchPayload.library;
      else await loadLibrary();
      clearLibrarySelection();
      renderLibrary(); renderViews();
      const failed = Array.isArray(batchPayload?.failed) ? batchPayload.failed : [];
      if (failed.length) {
        const detail = failed.slice(0, 2).map((item) => item?.error).filter(Boolean).join('；');
        showToast(`已清除 ${deletedIds.length} 篇，${failed.length} 篇失败${detail ? `：${detail}` : '。'}`, true);
      }
    } catch (error) {
      await loadLibrary();
      renderLibrary(); renderViews();
      showToast(`批量操作失败：${error.message}`, true);
    }
  }
  async function restoreLibraryItem(jobId) {
    try { const payload = await api(`/api/library/items/${jobId}/restore`, jsonOptions({})); await refreshLibraryFrom(payload); }
    catch (error) { showToast(error.message, true); }
  }
  function propertyById(propertyId) { return libraryProperties().find((property) => property.id === propertyId) || (libraryState().properties || []).find((property) => property.id === propertyId); }
  function editLibraryAlias(jobId) {
    const entry = libraryItemEntries().find((candidate) => candidate.jobId === jobId);
    if (!entry) return;
    const content = `<label>显示名称<input id="editor-value" maxlength="200" value="${escapeHTML(itemAlias(entry))}" placeholder="留空则显示原始标题" autofocus></label><p class="details-meta secondary">原题：${escapeHTML(itemOriginalTitle(entry))}</p>`;
    openLibraryEditor('设置显示名称', content, async (node) => {
      await updateLibraryItem(jobId, { alias: node.querySelector('#editor-value').value });
    });
  }
  async function editLibraryProperty(jobId, propertyId) {
    const property = propertyById(propertyId); const entry = libraryItemEntries().find((candidate) => candidate.jobId === jobId); if (!property || !entry) return;
    const values = itemValues(entry); let value;
    const current = values[propertyId] ?? (propertyId === 'venue' ? itemVenue(entry) : property.type === 'multi-select' ? [] : '');
    let content = '';
    if (property.type === 'rating') content = `<div class="rating-picker">${Array.from({ length: property.max || 5 }, (_, index) => `<button type="button" data-rating="${index + 1}" aria-label="${index + 1} 星">${index < Number(current || 0) ? '★' : '☆'}</button>`).join('')}</div><input id="editor-rating" type="hidden" value="${Number(current || 0)}">`;
    else if (property.type === 'multi-select') {
      const choices = libraryPropertyChoices(property, current);
      content = `<label>${escapeHTML(property.label)}<input id="editor-multi" value="${escapeHTML((current || []).join(', '))}" placeholder="多个标签用逗号分隔"></label><div class="tag-option-list">${[...choices].map((item) => `<button class="tag-option${(current || []).includes(item) ? ' active' : ''}" type="button" data-tag-choice="${escapeHTML(item)}">${escapeHTML(item)}</button>`).join('')}</div>`;
    } else if (property.type === 'select') content = `<label>${escapeHTML(property.label)}<select id="editor-value">${libraryPropertyChoices(property, current).map((item) => `<option${item === current ? ' selected' : ''}>${escapeHTML(item)}</option>`).join('')}</select></label>`;
    else content = `<label>${escapeHTML(property.label)}<input id="editor-value" maxlength="1000" value="${escapeHTML(current)}" autofocus></label>`;
    openLibraryEditor(`设置${property.label}`, content, async (node) => {
      if (property.type === 'rating') value = Number(node.querySelector('#editor-rating').value);
      else if (property.type === 'multi-select') value = node.querySelector('#editor-multi').value.split(/[,，、]/).map((item) => item.trim()).filter(Boolean);
      else value = node.querySelector('#editor-value').value;
      await updateLibraryItem(jobId, { values: { [propertyId]: value } });
    });
    $('#library-editor-content')?.querySelectorAll('[data-rating]').forEach((button) => button.addEventListener('click', () => { const selected = Number(button.dataset.rating); $('#editor-rating').value = String(selected); $('#library-editor-content').querySelectorAll('[data-rating]').forEach((item) => { item.textContent = Number(item.dataset.rating) <= selected ? '★' : '☆'; }); }));
    $('#library-editor-content')?.querySelectorAll('[data-tag-choice]').forEach((button) => button.addEventListener('click', () => { const input = $('#editor-multi'); const tags = input.value.split(/[,，、]/).map((item) => item.trim()).filter(Boolean); const tag = button.dataset.tagChoice; const next = tags.includes(tag) ? tags.filter((item) => item !== tag) : [...tags, tag]; input.value = next.join(', '); button.classList.toggle('active', next.includes(tag)); }));
  }
  const metadataFieldLabels = { title: '标题', authors: '作者', year: '年份', venue: '期刊 / 会议', doi: 'DOI', arxiv_id: 'arXiv ID', pmid: 'PMID', url: '链接', publisher: '出版社', volume: '卷', issue: '期', pages: '页码', language: '语言', keywords: '关键词', abstract: '摘要' };
  let metadataPollingTimer = null;
  let metadataDialogGeneration = 0;
  function cancelMetadataPolling() {
    window.clearTimeout(metadataPollingTimer);
    metadataPollingTimer = null;
    metadataDialogGeneration += 1;
    return metadataDialogGeneration;
  }
  function metadataDialogIsCurrent(generation, jobId) {
    return generation === metadataDialogGeneration
      && state.metadataEditorJobId === jobId
      && Boolean($('#metadata-dialog')?.open);
  }
  function metadataFieldValue(metadata, field) { const value = metadata?.fields?.[field]; return Array.isArray(value) ? value.join(', ') : value ?? ''; }
  function renderMetadataEditor(metadata) {
    const fields = ['title', 'authors', 'year', 'venue', 'doi', 'arxiv_id', 'pmid', 'url', 'publisher', 'volume', 'issue', 'pages', 'language', 'keywords', 'abstract'];
    const full = new Set(['title', 'authors', 'abstract', 'keywords']);
    const content = $('#metadata-content');
    content.innerHTML = `<div class="metadata-grid">${fields.map((field) => { const value = escapeHTML(metadataFieldValue(metadata, field)); const source = metadata?.sources?.[field]; const hint = source ? `${escapeHTML(source.provider || '本地')} · 置信度 ${Math.round(Number(source.confidence || 0) * 100)}%` : '未识别'; const isLong = field === 'abstract'; return `<label class="metadata-field${full.has(field) ? ' full' : ''}">${metadataFieldLabels[field]}${isLong ? `<textarea data-metadata-field="${field}">${value}</textarea>` : `<input data-metadata-field="${field}" value="${value}"${field === 'year' ? ' inputmode="numeric"' : ''}>`}<small>${hint}${(metadata.locked_fields || []).includes(field) ? ' · 已锁定' : ''}</small></label>`; }).join('')}</div>${(metadata.candidates || []).length ? `<div><div class="eyebrow">MATCH CANDIDATES</div><div class="metadata-candidate-list">${metadata.candidates.map((candidate, index) => `<div class="metadata-candidate"><strong>${escapeHTML(candidate.fields?.title || '候选记录')}</strong><span> · ${Math.round(Number(candidate.confidence || 0) * 100)}% · ${escapeHTML(candidate.fields?.venue || '')}</span><br><button type="button" class="tiny-button" data-apply-metadata-candidate="${index}">采用候选</button></div>`).join('')}</div></div>` : ''}`;
    content.querySelectorAll('[data-apply-metadata-candidate]').forEach((button) => button.addEventListener('click', () => { const candidate = metadata.candidates[Number(button.dataset.applyMetadataCandidate)]; if (!candidate?.fields) return; Object.entries(candidate.fields).forEach(([field, value]) => { const input = content.querySelector(`[data-metadata-field="${field}"]`); if (input) input.value = Array.isArray(value) ? value.join(', ') : value ?? ''; }); showToast('已填入候选元数据，请确认后保存。'); }));
  }
  async function openMetadataDialog(jobId) {
    const dialog = $('#metadata-dialog');
    if (!dialog) return;
    const wasOpen = dialog.open;
    const generation = cancelMetadataPolling();
    try {
      const payload = await api(`/api/library/items/${jobId}/metadata`);
      if (generation !== metadataDialogGeneration) return;
      state.metadataEditorJobId = jobId; state.metadataEditorOriginal = payload.metadata;
      renderMetadataEditor(payload.metadata); $('#metadata-status').textContent = payload.metadata.status === 'retrieving' ? '正在检索…' : (payload.metadata.error || '');
      if (!wasOpen) dialog.showModal();
    } catch (error) { showToast(error.message, true); }
  }
  async function saveMetadataEditor() {
    const jobId = state.metadataEditorJobId; const content = $('#metadata-content'); if (!jobId || !content) return;
    const generation = metadataDialogGeneration;
    const fields = {};
    content.querySelectorAll('[data-metadata-field]').forEach((input) => { const field = input.dataset.metadataField; const raw = input.value.trim(); fields[field] = ['authors', 'keywords'].includes(field) ? raw.split(/[,，、]/).map((item) => item.trim()).filter(Boolean) : field === 'year' ? (raw ? Number(raw) : null) : raw; });
    const original = state.metadataEditorOriginal?.fields || {};
    const changed = Object.fromEntries(Object.entries(fields).filter(([field, value]) => JSON.stringify(value) !== JSON.stringify(original[field] ?? (Array.isArray(value) ? [] : ''))));
    if (!Object.keys(changed).length) { $('#metadata-dialog').close(); return; }
    const payload = await api(`/api/library/items/${jobId}/metadata`, jsonOptions({ fields: changed }, 'PATCH'));
    if (!metadataDialogIsCurrent(generation, jobId)) return;
    state.metadataEditorOriginal = payload.metadata; await loadLibrary(); renderMetadataEditor(payload.metadata); $('#metadata-status').textContent = '已保存，修改字段已锁定。';
  }
  $('#metadata-form')?.addEventListener('submit', async (event) => {
    if (event.submitter && event.submitter.id !== 'metadata-save-button') return;
    event.preventDefault();
    try { await saveMetadataEditor(); } catch (error) { $('#metadata-status').textContent = error.message; $('#metadata-status').classList.add('error'); }
  });
  $('#metadata-retrieve-button')?.addEventListener('click', async () => {
    const jobId = state.metadataEditorJobId;
    if (!jobId) return;
    const generation = cancelMetadataPolling();
    const status = $('#metadata-status'); status.classList.remove('error'); status.textContent = '已加入检索队列…';
    try {
      await api(`/api/library/items/${jobId}/metadata/retrieve`, jsonOptions({}));
      if (!metadataDialogIsCurrent(generation, jobId)) return;
      const pollMetadata = async () => {
        if (!metadataDialogIsCurrent(generation, jobId)) return;
        try {
          const payload = await api(`/api/library/items/${jobId}/metadata`);
          if (!metadataDialogIsCurrent(generation, jobId)) return;
          renderMetadataEditor(payload.metadata);
          if (payload.metadata.status === 'retrieving') {
            metadataPollingTimer = window.setTimeout(pollMetadata, 900);
            return;
          }
          metadataPollingTimer = null;
          status.textContent = payload.metadata.error || (payload.metadata.status === 'needs-review' ? '找到候选记录，请确认。' : '检索完成。');
          await loadLibrary();
        } catch (error) {
          if (!metadataDialogIsCurrent(generation, jobId)) return;
          metadataPollingTimer = null;
          status.textContent = `检索状态读取失败：${error.message}`;
          status.classList.add('error');
        }
      };
      metadataPollingTimer = window.setTimeout(pollMetadata, 500);
    } catch (error) {
      if (!metadataDialogIsCurrent(generation, jobId)) return;
      status.textContent = error.message;
      status.classList.add('error');
    }
  });
  $('#metadata-dialog')?.addEventListener('close', () => {
    cancelMetadataPolling();
    state.metadataEditorJobId = null;
    state.metadataEditorOriginal = null;
  });
  function activeView() { return (libraryState().views || []).find((view) => view.id === state.activeViewId); }
  function filterValue(entry, field) {
    const values = itemValues(entry);
    if (field === 'name' || field === 'title') return itemTitle(entry);
    if (field === 'status') return entry.job?.status === 'completed' ? '可阅读' : entry.job?.status === 'failed' ? '失败' : '处理中';
    if (field === 'folder') return entry.item?.folder_ids || [];
    if (field === 'reading_status' || field === 'importance' || field === 'research_topic') return values[field];
    if (field === 'venue') return itemVenue(entry);
    return values[field];
  }
  function matchesFilter(entry, filter) {
    const field = String(filter?.field || ''); const operator = String(filter?.operator || 'equals'); const expected = filter?.value;
    const actual = filterValue(entry, field);
    if (field === 'folder') return Array.isArray(actual) && actual.includes(expected);
    if (Array.isArray(actual)) return operator === 'contains' ? actual.includes(expected) : actual.some((item) => String(item).toLowerCase().includes(String(expected || '').toLowerCase()));
    if (operator === 'gte') return Number(actual || 0) >= Number(expected || 0);
    if (operator === 'lte') return Number(actual || 0) <= Number(expected || 0);
    if (operator === 'contains') return String(actual || '').toLowerCase().includes(String(expected || '').toLowerCase());
    return String(actual || '') === String(expected || '');
  }
  function applyActiveView(entries) {
    const view = activeView(); if (!view || !Array.isArray(view.filters)) return entries;
    return entries.filter((entry) => view.filters.every((filter) => matchesFilter(entry, filter)));
  }
  function renderViews() {
    const library = libraryState(); const list = $('#saved-views-list');
    if (list) {
      list.innerHTML = (library.views || []).map((view) => `<button class="saved-view${view.id === state.activeViewId ? ' active' : ''}" data-view-id="${escapeHTML(view.id)}" type="button"><span>☷</span><span>${escapeHTML(view.name)}</span></button>`).join('') || '<div class="empty-state">还没有保存的视图。</div>';
      list.querySelectorAll('[data-view-id]').forEach((button) => button.addEventListener('click', () => selectView(button.dataset.viewId)));
    }
    const props = $('#properties-list');
    if (props) props.innerHTML = libraryProperties().map((property) => `<div class="property-row"><span>${escapeHTML(property.label)}</span><small>${escapeHTML(property.type)}</small>${property.system ? '<em>系统</em>' : `<button data-delete-property="${escapeHTML(property.id)}" type="button">删除</button>`}</div>`).join('');
    props?.querySelectorAll('[data-delete-property]').forEach((button) => button.addEventListener('click', async () => {
      if (!await requestConfirmation('删除这个自定义属性？现有文献中的该字段会被移除。', '删除文献属性')) return;
      try { const payload = await api(`/api/library/properties/${button.dataset.deleteProperty}`, { method: 'DELETE' }); await refreshLibraryFrom(payload); }
      catch (error) { showToast(error.message, true); }
    }));
    renderViewResults();
    renderViewForm();
  }
  function renderViewResults() {
    const target = $('#view-results');
    if (!target) return;
    const view = activeView();
    let entries = applyActiveView(libraryItemEntries()).filter((entry) => !entry.item?.deleted_at);
    entries.sort((a, b) => compareLibraryEntries(a, b, state.librarySort));
    const columns = visibleLibraryColumns();
    const template = libraryGridTemplate(columns);
    const count = $('#view-results-count'); if (count) count.textContent = `${entries.length} 篇`;
    const label = $('#view-results-label'); if (label) label.textContent = view?.name || '当前视图文献';
    target.style.setProperty('--library-grid-template', template);
    target.style.setProperty('--library-table-min-width', libraryTableMinWidth(columns));
    target.innerHTML = entries.length ? renderLibraryContent(entries) : '<div class="empty-state">这个视图暂时没有匹配的文献。</div>';
    applyLibraryGridTemplate();
  }
  function selectView(viewId) { clearLibrarySelection(); state.activeViewId = viewId; state.activeFolderId = null; state.primaryView = 'views-view'; renderViews(); switchView('views-view'); }
  function renderViewForm() {
    const view = activeView(); const title = $('#view-editor-title'); const name = $('#view-name'); const filters = $('#view-filters');
    if (!title || !name || !filters) return;
    title.textContent = view?.name || '新建视图'; name.value = view?.name || '';
    const values = view?.filters || [];
    filters.innerHTML = values.length ? values.map((filter, index) => `<div class="filter-row" data-filter-index="${index}"><select data-filter-field><option value="reading_status"${filter.field === 'reading_status' ? ' selected' : ''}>阅读状态</option><option value="importance"${filter.field === 'importance' ? ' selected' : ''}>重要程度</option><option value="research_topic"${filter.field === 'research_topic' ? ' selected' : ''}>研究主题</option><option value="venue"${filter.field === 'venue' ? ' selected' : ''}>接收/来源</option></select><select data-filter-operator><option value="equals"${filter.operator === 'equals' ? ' selected' : ''}>是</option><option value="contains"${filter.operator === 'contains' ? ' selected' : ''}>包含</option><option value="gte"${filter.operator === 'gte' ? ' selected' : ''}>不低于</option><option value="lte"${filter.operator === 'lte' ? ' selected' : ''}>不高于</option></select><input data-filter-value value="${escapeHTML(filter.value ?? '')}" placeholder="条件值"><button data-remove-filter type="button" aria-label="删除条件">×</button></div>`).join('') : '<div class="empty-state">没有筛选条件，视图将显示全部文献。</div>';
    filters.querySelectorAll('[data-remove-filter]').forEach((button) => button.addEventListener('click', () => { button.closest('.filter-row').remove(); if (!filters.querySelector('.filter-row')) filters.innerHTML = '<div class="empty-state">没有筛选条件，视图将显示全部文献。</div>'; }));
  }
  $('#add-filter-button')?.addEventListener('click', () => { const filters = $('#view-filters'); if (filters.querySelector('.empty-state')) filters.replaceChildren(); const row = document.createElement('div'); row.className = 'filter-row'; row.innerHTML = '<select data-filter-field><option value="reading_status">阅读状态</option><option value="importance">重要程度</option><option value="research_topic">研究主题</option><option value="venue">接收/来源</option></select><select data-filter-operator><option value="equals">是</option><option value="contains">包含</option><option value="gte">不低于</option><option value="lte">不高于</option></select><input data-filter-value placeholder="条件值"><button data-remove-filter type="button" aria-label="删除条件">×</button>'; row.querySelector('[data-remove-filter]').addEventListener('click', () => { row.remove(); }); filters.appendChild(row); });
  $('#create-view-button')?.addEventListener('click', () => { state.activeViewId = null; switchView('views-view'); renderViewForm(); });
  $('#view-form')?.addEventListener('submit', async (event) => {
    event.preventDefault(); const name = $('#view-name').value.trim(); if (!name) { showToast('请填写视图名称。', true); return; }
    const filters = [...document.querySelectorAll('#view-filters .filter-row')].map((row) => ({ field: row.querySelector('[data-filter-field]').value, operator: row.querySelector('[data-filter-operator]').value, value: row.querySelector('[data-filter-value]').value.trim() }));
    try { const payload = state.activeViewId ? await api(`/api/library/views/${state.activeViewId}`, jsonOptions({ name, filters }, 'PATCH')) : await api('/api/library/views', jsonOptions({ name, filters })); state.activeViewId = payload.view?.id || state.activeViewId; await refreshLibraryFrom(payload); $('#view-status').textContent = '已保存'; $('#view-status').hidden = false; } catch (error) { $('#view-status').textContent = error.message; $('#view-status').hidden = false; $('#view-status').classList.add('error'); }
  });
  $('#delete-view-button')?.addEventListener('click', async () => { if (!state.activeViewId || !activeView() || activeView().system || !await requestConfirmation('删除当前视图？', '删除保存视图')) return; try { const payload = await api(`/api/library/views/${state.activeViewId}`, { method: 'DELETE' }); state.activeViewId = 'view-all'; await refreshLibraryFrom(payload); } catch (error) { showToast(error.message, true); } });
  $('#create-property-button')?.addEventListener('click', () => {
    openLibraryEditor('新增文献属性', '<label>属性名称<input id="editor-property-label" maxlength="80" placeholder="例如：研究方向" autofocus></label><label>属性类型<select id="editor-property-type"><option value="multi-select">多选标签</option><option value="select">单选</option><option value="rating">评分</option><option value="text">文本</option></select></label><label id="editor-property-options-label">选项（用逗号分隔，可留空）<input id="editor-property-options" placeholder="例如：方法、数据集、实验"></label>', async (content) => {
      const label = content.querySelector('#editor-property-label').value.trim(); const type = content.querySelector('#editor-property-type').value; const options = content.querySelector('#editor-property-options').value.split(/[,，、]/).map((item) => item.trim()).filter(Boolean);
      if (!label) throw new Error('属性名称不能为空。');
      const payload = await api('/api/library/properties', jsonOptions({ label, type, options })); await refreshLibraryFrom(payload);
    });
    $('#editor-property-type')?.addEventListener('change', (event) => { $('#editor-property-options-label').hidden = !['select', 'multi-select'].includes(event.target.value); });
  });

  // Reader iframe, text selection and persisted annotations.
  function frameDocument() { return $('#html-preview')?.contentDocument || null; }

  const readerSearchHighlightName = 'my-scholar-reader-search';
  const readerSearchCurrentHighlightName = 'my-scholar-reader-search-current';
  const readerTextSelectionStates = new WeakMap();

  function readerHighlightRegistry(doc = frameDocument()) {
    const registry = doc?.defaultView?.CSS?.highlights;
    return registry && typeof registry.set === 'function' && typeof registry.delete === 'function' ? registry : null;
  }

  function readerHighlightForRanges(doc, ranges) {
    const HighlightConstructor = doc?.defaultView?.Highlight;
    if (!doc || !Array.isArray(ranges) || !ranges.length || typeof HighlightConstructor !== 'function') return null;
    try {
      const highlight = new HighlightConstructor();
      ranges.forEach((range) => { if (range) highlight.add(range); });
      return highlight;
    } catch (_) {
      return null;
    }
  }

  function unwrapReaderSearchMarks(doc = frameDocument()) {
    doc?.querySelectorAll('mark.reader-search-match').forEach((mark) => {
      const parent = mark.parentNode;
      if (!parent) return;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      mark.remove();
    });
    doc?.querySelector('.reader-content')?.normalize();
  }

  function clearReaderSearchMatches(doc = frameDocument()) {
    const registry = readerHighlightRegistry(doc);
    registry?.delete(readerSearchHighlightName);
    registry?.delete(readerSearchCurrentHighlightName);
    unwrapReaderSearchMarks(doc);
    readerSearchState.matches = [];
    readerSearchState.activeIndex = -1;
    readerSearchState.usingCustomHighlight = false;
  }

  function normalizeReaderSearchText(value) {
    return String(value || '').replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
  }

  function readerSearchRoots(doc = frameDocument()) {
    if (!doc) return [];
    const roots = [...doc.querySelectorAll('.reader-content h1[data-block-id], .reader-content h2[data-block-id], .reader-content h3[data-block-id], .reader-content h4[data-block-id], .reader-content h5[data-block-id], .reader-content h6[data-block-id], .reader-content p[data-block-id], .reader-content ul[data-block-id], .reader-content ol[data-block-id], .reader-content figcaption[data-translate-block-id], .reader-content .my-scholar-translation')];
    return roots.filter((root) => !root.closest('.annotation-note-popover') && root.getClientRects().length > 0);
  }

  function readerVisibleTarget(node, doc = frameDocument()) {
    if (!node || !doc) return null;
    if (node.getClientRects().length) return node;
    const block = node.closest('[data-block-id],[data-translate-block-id],[data-translation-placeholder-for]');
    if (!block) return null;
    const sourceId = block.dataset.translationPlaceholderFor || block.dataset.translationFor
      || block.dataset.for || block.dataset.translateBlockId || block.dataset.blockId;
    if (!sourceId) return null;
    const id = cssEscape(sourceId);
    return [...doc.querySelectorAll(`[data-block-id="${id}"],[data-translate-block-id="${id}"],.my-scholar-translation[data-for="${id}"],.my-scholar-translation-placeholder[data-translation-placeholder-for="${id}"]`)]
      .find((candidate) => candidate.getClientRects().length > 0) || null;
  }

  function readerSearchMap(root, doc = frameDocument()) {
    const nodes = textNodes(root, doc).filter((node) => {
      const parent = node.parentElement;
      return Boolean(parent && !parent.closest('script,style,button,input,textarea,select,summary,.annotation-note-popover,.paragraph-translate-trigger,.annotation-note-trigger') && node.nodeValue);
    });
    let text = '';
    const positions = [];
    nodes.forEach((node) => {
      const value = String(node.nodeValue || '');
      for (let index = 0; index < value.length; index += 1) {
        const character = value[index];
        if (/\s/u.test(character)) {
          if (!text.endsWith(' ')) {
            text += ' ';
            positions.push([node, index]);
          }
          continue;
        }
        const lowered = character.toLocaleLowerCase();
        for (const lowerCharacter of lowered) {
          text += lowerCharacter;
          positions.push([node, index]);
        }
      }
    });
    return { text, positions };
  }

  function readerSearchRangeFromMap(map, start, length, doc = frameDocument()) {
    if (!doc || !map?.positions?.length || !Number.isInteger(start) || !Number.isInteger(length) || length < 1) return null;
    const first = map.positions[start];
    const last = map.positions[start + length - 1];
    if (!first || !last) return null;
    try {
      const range = doc.createRange();
      range.setStart(first[0], first[1]);
      range.setEnd(last[0], last[1] + 1);
      return range;
    } catch (_) {
      return null;
    }
  }

  function renderReaderSearchMatches() {
    const doc = frameDocument();
    clearReaderSearchMatches(doc);
    const query = normalizeReaderSearchText(readerSearchState.query);
    if (!doc || !query || !$('#reader-view')?.classList.contains('active-view')) return;
    const ranges = [];
    for (const root of readerSearchRoots(doc)) {
      const map = readerSearchMap(root, doc);
      let cursor = 0;
      for (;;) {
        const start = map.text.indexOf(query, cursor);
        if (start < 0) break;
        const range = readerSearchRangeFromMap(map, start, query.length, doc);
        if (range && !range.collapsed) ranges.push(range);
        cursor = start + Math.max(1, query.length);
      }
    }
    const registry = readerHighlightRegistry(doc);
    const highlight = readerHighlightForRanges(doc, ranges);
    if (registry && highlight) {
      registry.set(readerSearchHighlightName, highlight);
      readerSearchState.usingCustomHighlight = true;
      readerSearchState.matches = ranges.map((range) => ({ range }));
    } else {
      const fallback = [];
      ranges.slice().reverse().forEach((range) => {
        try {
          const mark = doc.createElement('mark');
          mark.className = 'reader-search-match';
          mark.dataset.searchMatch = 'true';
          mark.append(range.extractContents());
          range.insertNode(mark);
          fallback.push(mark);
        } catch (_) { /* A stale range is ignored; the remaining matches stay usable. */ }
      });
      readerSearchState.matches = fallback.reverse().map((node) => ({ node }));
    }
    if (readerSearchState.matches.length) readerSearchState.activeIndex = 0;
    applyReaderSearchCurrent();
  }

  function applyReaderSearchCurrent() {
    const doc = frameDocument();
    const registry = readerHighlightRegistry(doc);
    registry?.delete(readerSearchCurrentHighlightName);
    doc?.querySelectorAll('mark.reader-search-match.is-current').forEach((node) => node.classList.remove('is-current'));
    const current = readerSearchState.matches[readerSearchState.activeIndex];
    if (!current) return;
    if (readerSearchState.usingCustomHighlight && registry) {
      const highlight = readerHighlightForRanges(doc, [current.range]);
      if (highlight) registry.set(readerSearchCurrentHighlightName, highlight);
    } else current.node?.classList.add('is-current');
  }

  function updateReaderSearchUI() {
    const input = $('#reader-search-input');
    const count = $('#reader-search-count');
    const previous = $('#reader-search-prev');
    const next = $('#reader-search-next');
    const hasMatches = readerSearchState.matches.length > 0;
    const hasQuery = Boolean(normalizeReaderSearchText(readerSearchState.query));
    if (input && input.value !== readerSearchState.query) input.value = readerSearchState.query;
    if (count) count.textContent = hasQuery ? (hasMatches ? `${readerSearchState.activeIndex + 1}/${readerSearchState.matches.length}` : '无匹配') : '';
    if (previous) previous.disabled = !hasMatches;
    if (next) next.disabled = !hasMatches;
  }

  function refreshReaderSearch() {
    if (!readerSearchState.open) {
      clearReaderSearchMatches();
      updateReaderSearchUI();
      return;
    }
    renderReaderSearchMatches();
    updateReaderSearchUI();
  }

  function readerSearchNavigate(delta) {
    const total = readerSearchState.matches.length;
    if (!total) return;
    readerSearchState.activeIndex = (readerSearchState.activeIndex + delta + total) % total;
    applyReaderSearchCurrent();
    scrollReaderSearchCurrent();
    updateReaderSearchUI();
  }

  function scrollReaderSearchCurrent(behavior = reducedMotionQuery.matches ? 'auto' : 'smooth') {
    const current = readerSearchState.matches[readerSearchState.activeIndex];
    const target = current?.node || current?.range?.startContainer?.parentElement;
    target?.scrollIntoView?.({ behavior, block: 'center', inline: 'nearest' });
  }

  function openReaderSearch({ select = true } = {}) {
    if (!$('#reader-view')?.classList.contains('active-view')) return false;
    const panel = $('#reader-search');
    const input = $('#reader-search-input');
    if (!panel || !input) return false;
    readerSearchState.open = true;
    panel.hidden = false;
    refreshReaderSearch();
    input.focus({ preventScroll: true });
    if (select) input.select();
    scrollReaderSearchCurrent('auto');
    return true;
  }

  function closeReaderSearch({ reset = false } = {}) {
    readerSearchState.open = false;
    clearReaderSearchMatches();
    if (reset) {
      readerSearchState.query = '';
      const input = $('#reader-search-input');
      if (input) input.value = '';
    }
    const panel = $('#reader-search');
    if (panel) panel.hidden = true;
    updateReaderSearchUI();
  }

  function readerSearchShortcut(event) {
    return !event.altKey && !event.shiftKey && (event.metaKey || event.ctrlKey) && String(event.key || '').toLowerCase() === 'f';
  }

  function handleReaderSearchShortcut(event) {
    if (event.defaultPrevented || event.isComposing || !$('#reader-view')?.classList.contains('active-view')) return false;
    if (readerSearchShortcut(event) && !isEditableAppSurface(event.target)) {
      event.preventDefault();
      event.stopPropagation();
      openReaderSearch();
      return true;
    }
    if (event.key === 'Escape' && readerSearchState.open && !isEditableAppSurface(event.target)) {
      event.preventDefault();
      event.stopPropagation();
      closeReaderSearch();
      return true;
    }
    return false;
  }

  $('#reader-search-input')?.addEventListener('input', (event) => {
    readerSearchState.query = event.target.value;
    refreshReaderSearch();
    scrollReaderSearchCurrent('auto');
  });
  $('#reader-search-input')?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeReaderSearch();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      readerSearchNavigate(event.shiftKey ? -1 : 1);
    }
  });
  $('#reader-search-prev')?.addEventListener('click', () => readerSearchNavigate(-1));
  $('#reader-search-next')?.addEventListener('click', () => readerSearchNavigate(1));
  $('#reader-search-close')?.addEventListener('click', () => closeReaderSearch());
  document.addEventListener('keydown', handleReaderSearchShortcut, true);

  function readerSentenceSegments(value, protectedRanges = []) {
    const text = String(value || '');
    const segments = [];
    let start = 0;
    const isBoundary = (index) => {
      const character = text[index];
      if (!character || !/[.!?。！？；;\n]/u.test(character)) return false;
      if (protectedRanges.some((range) => index >= range.start && index < range.end)) return false;
      if (character === '.' && /\d/u.test(text[index - 1] || '') && /\d/u.test(text[index + 1] || '')) return false;
      if (character === '.') {
        const prefix = text.slice(0, index + 1);
        if (/\b(?:et\s+al|e\.g|i\.e|Fig|Figs|Eq|Eqs|Sec|Secs|Tab|Dr|Prof|Mr|Mrs|vs|etc|No|Vol)\.$/iu.test(prefix)) return false;
        if (/[A-Za-z]\.[A-Za-z]$/u.test(text.slice(Math.max(0, index - 1), index + 2))) return false;
        if (/\b[A-Z]\.$/u.test(prefix) && /^\s+[A-Z][a-z]/u.test(text.slice(index + 1))) return false;
      }
      return true;
    };
    const push = (from, to) => {
      const raw = text.slice(from, to);
      const leading = raw.search(/\S/u);
      if (leading < 0) return;
      const trailing = raw.replace(/\s+$/u, '').length;
      const segmentStart = from + leading;
      const segmentEnd = from + trailing;
      if (segmentEnd > segmentStart) segments.push({ start: segmentStart, end: segmentEnd });
    };
    for (let index = 0; index < text.length; index += 1) {
      if (!isBoundary(index)) continue;
      let end = index + 1;
      while (end < text.length && /[.!?。！？；;]/u.test(text[end])) end += 1;
      push(start, end);
      start = end;
      index = end - 1;
    }
    push(start, text.length);
    return segments;
  }

  function readerBlockSentenceSegments(block, doc = block?.ownerDocument) {
    const atoms = new Map();
    let offset = 0;
    for (const node of textNodes(block, doc)) {
      const atom = node.parentElement?.closest('math, .math-source-visual, sup, sub, a');
      if (atom && block.contains(atom)) {
        const bounds = atoms.get(atom) || { start: offset, end: offset };
        bounds.end = offset + node.nodeValue.length;
        atoms.set(atom, bounds);
      }
      offset += node.nodeValue.length;
    }
    const text = canonicalBlockText(block, doc);
    if (block.matches('ul, ol')) {
      return [...block.querySelectorAll(':scope > li')].flatMap((item) => {
        const start = textOffset(block, item, 0, doc);
        const end = textOffset(block, item, item.childNodes.length, doc);
        const protectedRanges = [...atoms.values()].map((range) => ({ start: range.start - start, end: range.end - start }));
        return readerSentenceSegments(text.slice(start, end), protectedRanges).map((range) => ({ start: range.start + start, end: range.end + start }));
      });
    }
    return readerSentenceSegments(text, [...atoms.values()]);
  }

  function hasAnnotationHoverDetails(annotation) {
    return Boolean(annotation && !isAIAnnotation(annotation) && (String(annotation.label || '').trim() || hasAnnotationNote(annotation)));
  }

  function installReaderAnnotationHover(doc = frameDocument()) {
    if (!doc || doc.documentElement.dataset.annotationHoverReady === 'true') return;
    doc.documentElement.dataset.annotationHoverReady = 'true';
    const schedule = (event) => {
      if (doc !== frameDocument()) return;
      if (event.target?.closest?.('.annotation-note-popover')) {
        cancelNoteHoverOpen();
        cancelNoteHoverClose();
        return;
      }
      if (event.buttons || doc.getSelection()?.toString().trim()) {
        cancelNoteHoverOpen();
        if (!notePopoverHover.pinned) closeInlineAnnotation(doc);
        return;
      }
      if (notePopoverHover.pinned) return;
      const noteTrigger = event.target?.closest?.('.annotation-note-trigger');
      if (noteTrigger) { scheduleNoteHoverOpen(noteTrigger); return; }
      if (event.pointerType === 'mouse') {
        let mark = event.target?.closest?.(':is(mark, mrow)[data-annotation-id]');
        while (mark) {
          const annotation = state.annotations.find((item) => item.id === mark.dataset.annotationId);
          if (hasAnnotationHoverDetails(annotation)) {
            scheduleNoteHoverOpen(mark);
            return;
          }
          mark = mark.parentElement?.closest(':is(mark, mrow)[data-annotation-id]');
        }
      }
      cancelNoteHoverOpen();
      scheduleNoteHoverClose();
    };
    const dismissHover = () => {
      cancelNoteHoverOpen();
      cancelNoteHoverClose();
      if (!notePopoverHover.pinned) closeInlineAnnotation(doc);
    };
    doc.addEventListener('pointermove', schedule, { passive: true });
    doc.addEventListener('pointerup', schedule, { passive: true });
    doc.addEventListener('mouseleave', () => {
      if (doc !== frameDocument()) return;
      cancelNoteHoverOpen();
      scheduleNoteHoverClose();
    }, { passive: true });
    doc.addEventListener('pointerdown', (event) => {
      if (doc !== frameDocument() || isAnnotationInteraction(event.target)) return;
      dismissHover();
      if (notePopoverHover.pinned) closeInlineAnnotation(doc, { immediate: true });
    }, { passive: true, capture: true });
    doc.addEventListener('selectionchange', () => { if (doc === frameDocument() && doc.getSelection()?.toString().trim()) dismissHover(); });
    doc.addEventListener('scroll', (event) => {
      if (doc !== frameDocument() || event.target?.closest?.('.annotation-note-popover')) return;
      dismissHover();
    }, { passive: true, capture: true });
    doc.addEventListener('keydown', (event) => {
      if (doc !== frameDocument() || event.key !== 'Escape') return;
      dismissHover();
      clearSelectionPopover({ clearState: true, immediate: true });
      if (!event.defaultPrevented) closeInlineAnnotation(doc);
    });
    doc.defaultView?.addEventListener('blur', () => {
      if (doc === frameDocument()) dismissHover();
    }, { passive: true });
  }
  function readerURLIdentity(value) {
    try {
      const url = new URL(String(value || ''), window.location.href);
      return `${url.origin}${url.pathname}${url.search}`;
    } catch (_) {
      return '';
    }
  }

  function readerGeneration(job = state.activeJob) {
    const generation = job?.reflow?.status === 'completed' ? String(job.reflow.generation || '') : '';
    return /^[1-9][0-9]{0,8}$/u.test(generation) ? generation : 'base';
  }

  function readerMountMatches(mount = readerMount, doc = frameDocument()) {
    if (!readerMountIsCurrent(mount) || mount !== readerMount || !doc || state.activeJob?.job_id !== mount.jobId || activeJobId !== mount.jobId) return false;
    return readerURLIdentity(doc.URL) === mount.urlIdentity && $('#html-preview')?.contentDocument === doc;
  }

  function readerMountIsCurrent(mount) {
    return Boolean(mount && readerMounts.get(mount.jobId) === mount);
  }

  function deactivateReaderMount() {
    clearAnnotationDrawAnimation(frameDocument());
    clearChatReferenceHighlight();
    closeQuickPreview();
    if (mediaResize.active && mediaResize.doc === frameDocument()) finishMediaResize(null, true);
    closeReaderSearch({ reset: true });
    clearSelectionPopover({ clearState: true, immediate: true });
    closeInlineAnnotation(frameDocument());
    if (!readerMount) return;
    window.clearTimeout(readerMount.saveTimer);
    window.clearTimeout(readerMount.saveMaxTimer);
    readerMount.cancelFontWait?.();
    readerMount.activation += 1;
    readerMount.transition?.cancel();
    readerMount.frame.removeAttribute('id');
    readerMount.frame.setAttribute('aria-hidden', 'true');
    readerMount.frame.inert = true;
  }

  function disposeReaderMount(jobId) {
    const mount = readerMounts.get(jobId);
    if (!mount) return;
    if (readerMount === mount) {
      deactivateReaderMount();
      readerMount = null;
      readerSections = [];
    }
    window.clearTimeout(mount.saveTimer);
    window.clearTimeout(mount.saveMaxTimer);
    mount.cancelFontWait?.();
    mount.frame.contentWindow?.cancelAnimationFrame(mount.viewportRAF);
    disposeInterlinearTranslations(mount.frame.contentDocument);
    mount.transition?.cancel();
    mount.transition = null;
    mount.wiredDocument = null;
    const run = state.translationRuns.get(jobId);
    if (run?.mount === mount) {
      run.mount = null;
      run.document = null;
    }
    readerMounts.delete(jobId);
    mount.resolveDocumentReady?.();
    mount.resolveDocumentReady = null;
    mount.frame.remove();
  }

  function resetReaderProgress() {
    const progressbar = $('#reader-progress-track');
    const bar = $('#reader-progress-bar');
    if (progressbar) progressbar.setAttribute('aria-valuenow', '0');
    if (bar) bar.style.transform = 'scaleX(0)';
  }

  function beginReaderMount(jobId, source) {
    const url = readerDocumentURL(source);
    const identity = readerURLIdentity(url);
    deactivateReaderMount();
    let mount = readerMounts.get(jobId);
    if (mount && (mount.urlIdentity !== identity || mount.generation !== readerGeneration())) {
      disposeReaderMount(jobId);
      mount = null;
    }
    if (!mount) {
      const frame = document.createElement('iframe');
      frame.className = 'reader-document-frame';
      frame.title = '论文阅读器';
      frame.loading = 'eager';
      frame.dataset.jobId = jobId;
      mount = {
      token: ++readerMountSequence,
      jobId,
      frame,
      activation: 0,
      loaded: false,
      wiredDocument: null,
      annotations: [],
      aiHighlights: [],
      urlIdentity: identity,
      generation: readerGeneration(),
      restoreLocation: normalizedReadingLocation(readingLocationsState.locations[jobId]),
      restorePending: true,
      ready: false,
      layoutReady: Promise.resolve(),
      userInteracted: false,
      restoring: false,
      viewportRAF: 0,
      saveTimer: null,
      saveMaxTimer: null,
      activeSectionIndex: -1,
      };
      mount.documentReady = new Promise((resolve) => { mount.resolveDocumentReady = resolve; });
      readerMounts.set(jobId, mount);
      frame.addEventListener('load', () => {
        if (!readerMountIsCurrent(mount) || readerURLIdentity(frame.contentDocument?.URL) !== mount.urlIdentity) return;
        if (mount.wiredDocument !== frame.contentDocument) {
          mount.ready = false;
          mount.preparingActivation = null;
        }
        mount.loaded = true;
        mount.resolveDocumentReady?.();
        mount.resolveDocumentReady = null;
        if (readerMount === mount) void prepareMountedReader(mount);
      });
      frame.src = url;
      $('#reader-documents').append(frame);
    }
    readerMount = mount;
    mount.activation += 1;
    mount.frame.id = 'html-preview';
    mount.frame.removeAttribute('aria-hidden');
    mount.frame.inert = false;
    $('#reader-view')?.classList.toggle('is-document-loading', !mount.ready);
    readerSections = [];
    resetReaderProgress();
    const rail = $('#reader-chapter-rail');
    if (rail) rail.hidden = true;
    $('#reader-chapter-list')?.replaceChildren();
    setChapterRailOpen(false);
    if (!mount.ready) primeReaderAppearance(mount);
    return mount;
  }

  // wireFrame() pushes the reader's accent and fonts into the document, but it
  // runs on the iframe's load event -- which waits for every image. Until then
  // the document renders with its own stylesheet defaults, so a figure-heavy
  // paper visibly opens in the wrong accent and font and then snaps. Push once
  // as soon as the new document exists; wireFrame() re-applies at load.
  function primeReaderAppearance(mount) {
    const frame = mount?.frame;
    if (!frame || !mount) return;
    const deadline = performance.now() + 10000;
    const attempt = () => {
      if (!readerMountIsCurrent(mount)) return;
      const doc = frame.contentDocument;
      if (doc?.documentElement && readerURLIdentity(doc.URL) === mount.urlIdentity) {
        setAppearanceVariables(doc.documentElement, state.appearance, { readerDocument: true, important: true });
        return;
      }
      if (performance.now() < deadline) window.requestAnimationFrame(attempt);
    };
    window.requestAnimationFrame(attempt);
  }

  function readerScrollMetrics(doc = frameDocument()) {
    const view = doc?.defaultView;
    const scroller = doc?.scrollingElement || doc?.documentElement;
    if (!view || !scroller) return null;
    const scrollTop = Math.max(0, Number(view.scrollY ?? scroller.scrollTop) || 0);
    const viewportHeight = Math.max(0, Number(view.innerHeight || scroller.clientHeight) || 0);
    const maximum = Math.max(0, Number(scroller.scrollHeight) - viewportHeight);
    return { view, scroller, scrollTop, viewportHeight, maximum, progress: maximum > 0 ? Math.min(1, scrollTop / maximum) : 0 };
  }

  function updateReaderProgress(doc = frameDocument()) {
    const metrics = readerScrollMetrics(doc);
    if (!metrics) return 0;
    const progress = Math.min(1, Math.max(0, metrics.progress));
    const percent = Math.round(progress * 100);
    const progressbar = $('#reader-progress-track');
    const bar = $('#reader-progress-bar');
    if (progressbar) progressbar.setAttribute('aria-valuenow', String(percent));
    if (bar) bar.style.transform = `scaleX(${progress})`;
    return progress;
  }

  function readerAnchorAtViewport(doc, metrics) {
    const probeY = Math.min(64, Math.max(24, metrics.viewportHeight * 0.08));
    const probeX = Math.max(1, Math.min((doc.documentElement?.clientWidth || 1) - 1, (doc.documentElement?.clientWidth || 1) / 2));
    let anchor = doc.elementFromPoint?.(probeX, probeY)?.closest?.('[data-block-id]') || null;
    if (!anchor) {
      const blocks = [...doc.querySelectorAll('[data-block-id]')].filter((block) => block.getClientRects().length > 0);
      anchor = blocks.find((block) => {
        const rect = block.getBoundingClientRect();
        return rect.top <= probeY && rect.bottom > probeY;
      }) || [...blocks].reverse().find((block) => block.getBoundingClientRect().top <= probeY) || blocks[0] || null;
    }
    return anchor;
  }

  function captureCurrentReadingLocation({ mount = readerMount, forClose = false } = {}) {
    if (request.closeGate && !forClose) return false;
    const doc = frameDocument();
    const frame = $('#html-preview');
    if (!$('#reader-view')?.classList.contains('active-view') || !frame || frame.clientWidth < 1 || frame.clientHeight < 1
      || !readerMountMatches(mount, doc) || !mount.ready || !readerJobIdPattern.test(mount.jobId)) return false;
    const metrics = readerScrollMetrics(doc);
    const anchor = metrics && readerAnchorAtViewport(doc, metrics);
    const blockId = String(anchor?.dataset?.blockId || '');
    const page = Number(anchor?.dataset?.page || anchor?.closest?.('[data-page]')?.dataset?.page);
    if (!metrics || !anchor || !readerBlockIdPattern.test(blockId) || !Number.isInteger(page) || page < 1) return false;
    const rect = anchor.getBoundingClientRect();
    const blockHeight = Number(rect.height);
    if (!Number.isFinite(blockHeight) || blockHeight < 1) return false;
    const offsetPx = Math.min(blockHeight, Math.max(0, -Number(rect.top || 0)));
    return rememberReadingLocation(mount.jobId, {
      blockId,
      page,
      offsetPx,
      offsetRatio: Math.min(1, Math.max(0, offsetPx / blockHeight)),
      blockHeight,
      progress: metrics.progress,
      generation: mount.generation,
      updatedAt: new Date().toISOString(),
    });
  }

  function scheduleReadingLocationSave(mount = readerMount) {
    if (!readerMountMatches(mount)) return;
    const flush = () => {
      window.clearTimeout(mount.saveTimer);
      window.clearTimeout(mount.saveMaxTimer);
      mount.saveTimer = null;
      mount.saveMaxTimer = null;
      captureCurrentReadingLocation({ mount });
    };
    window.clearTimeout(mount.saveTimer);
    mount.saveTimer = window.setTimeout(flush, 280);
    if (!mount.saveMaxTimer) mount.saveMaxTimer = window.setTimeout(flush, 1000);
  }
  const readerImageSelector = 'figure.pdf-figure img, figure.pdf-table img, .figure-cluster img, .reader-content img';

  function readerImageTarget(target) {
    const image = target?.closest?.('img');
    if (!image?.matches?.(readerImageSelector)) return null;
    if (image.matches('.page-raster, .math-source-inline, .source-block-crop') || image.closest('.pdf-source-block, .pdf-equation, .annotation-note-popover, .annotation-note-editor, .source-crop, .page-source')) return null;
    return image;
  }

  function readerImageDetails(image, doc = frameDocument()) {
    if (!image || !doc || !state.activeJob?.job_id) return null;
    const source = image.currentSrc || image.getAttribute('src') || '';
    if (!source) return null;
    let url;
    try { url = new URL(source, doc.baseURI); } catch (_) { return null; }
    const figure = image.closest('figure, .figure-cluster') || image.closest('.my-scholar-media-block');
    const captionNode = doc.getElementById(figure?.dataset.captionId || '') || figure?.querySelector('figcaption');
    const caption = captionNode ? paragraphText(captionNode) : '';
    const jobId = state.activeJob.job_id;
    const prefix = `/api/jobs/${jobId}/`;
    let assetPath = '';
    if (url.origin === window.location.origin && url.pathname.startsWith(prefix)) {
      try { assetPath = decodeURIComponent(url.pathname.slice(prefix.length)); } catch (_) { assetPath = ''; }
    }
    const imageAssetMatch = assetPath.match(/^(?:renders\/[1-9][0-9]{0,8}\/)?(assets\/images\/[a-z0-9][a-z0-9._@-]{0,180}\.(?:png|jpe?g|webp))$/i);
    assetPath = imageAssetMatch?.[1] || '';
    return {
      src: url.href,
      assetPath,
      alt: String(image.alt || '').trim(),
      caption,
      blockId: figure?.dataset.blockId || captionNode?.dataset.translateBlockId || '',
      page: figure?.dataset.page || figure?.closest('.pdf-page')?.dataset.page || '',
    };
  }

  function prepareReaderImages(doc = frameDocument()) {
    doc?.querySelectorAll(readerImageSelector).forEach((image) => {
      if (!readerImageTarget(image)) return;
      const details = readerImageDetails(image, doc);
      image.tabIndex = 0;
      image.draggable = false;
      image.setAttribute('role', 'button');
      image.setAttribute('aria-label', details?.caption ? `放大查看图片：${details.caption.slice(0, 120)}` : '放大查看图片');
      const link = image.closest('a.asset-link');
      if (link) link.tabIndex = -1;
    });
  }

  function normalizedMediaWidth(value, fallback = mediaWidthMaximum) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.round(Math.max(mediaWidthMinimum, Math.min(mediaWidthMaximum, numeric)) * 10) / 10;
  }

  function emptyMediaLayout() {
    return { version: 1, items: {} };
  }

  function normalizeMediaLayout(value) {
    const layout = emptyMediaLayout();
    if (!value || Number(value.version) !== 1 || !value.items || typeof value.items !== 'object' || Array.isArray(value.items)) return layout;
    Object.entries(value.items).forEach(([key, item]) => {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(key)) return;
      const width = Number(item?.width_percent);
      if (!Number.isFinite(width) || width < mediaWidthMinimum || width > mediaWidthMaximum) return;
      layout.items[key] = { width_percent: normalizedMediaWidth(width) };
    });
    return layout;
  }

  function mediaLayoutForJob(jobId) {
    if (!state.mediaLayouts.has(jobId)) state.mediaLayouts.set(jobId, emptyMediaLayout());
    return state.mediaLayouts.get(jobId);
  }

  function mediaWidthFor(jobId, key) {
    return normalizedMediaWidth(mediaLayoutForJob(jobId).items[key]?.width_percent);
  }

  function applyMediaWidth(block, width) {
    if (!block) return mediaWidthMaximum;
    const next = normalizedMediaWidth(width);
    block.dataset.mediaWidth = String(next);
    block.style.setProperty('--my-scholar-media-width', `${next}%`);
    block.style.setProperty('--my-scholar-media-scale', String(next / 100));
    block.querySelectorAll('.my-scholar-media-resize-handle').forEach((handle) => {
      handle.setAttribute('aria-valuenow', String(next));
      handle.setAttribute('aria-valuetext', `${next}%`);
    });
    return next;
  }

  function mediaBlockKey(block, type, index, source = block) {
    const stable = String(source.dataset.blockId || block.dataset.mediaKey || '').trim();
    if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(stable)) return stable;
    const page = String(source.dataset.page || source.closest('.pdf-page')?.dataset.page || '0').replace(/[^0-9A-Za-z_-]/gu, '') || '0';
    const sources = [...block.querySelectorAll('img')].map((image) => image.getAttribute('src') || '').join('|');
    const fingerprint = sources || block.textContent?.trim().slice(0, 2000) || `${type}-${index}`;
    return `legacy-${type}-p${page}-${index}-${hashText(fingerprint)}`;
  }

  function wrapFigureMedia(figure, type) {
    const existing = figure.querySelector(':scope > .my-scholar-media-visual');
    if (existing) return existing;
    const movable = [...figure.children].filter((child) => !child.matches('figcaption, .source-crop, .page-source, .table-structure, .my-scholar-translation, .my-scholar-media-resize-handle'));
    if (!movable.length) return null;
    const wrapper = figure.ownerDocument.createElement('div');
    wrapper.className = `my-scholar-media-block my-scholar-media-visual my-scholar-media-${type}-visual`;
    figure.insertBefore(wrapper, movable[0]);
    movable.forEach((child) => wrapper.append(child));
    return wrapper;
  }

  function wrapLegacyMedia(node, className) {
    if (node.parentElement?.classList.contains(className)) return node.parentElement;
    const wrapper = node.ownerDocument.createElement('div');
    wrapper.className = `my-scholar-media-block ${className}`;
    node.before(wrapper);
    wrapper.append(node);
    return wrapper;
  }

  function readerMediaBlocks(doc) {
    const descriptors = [];
    const seen = new Set();
    const add = (block, type, index, source = block) => {
      if (!block || seen.has(block)) return;
      seen.add(block);
      descriptors.push({ block, key: mediaBlockKey(block, type, index, source), type });
    };
    doc.querySelectorAll('figure.pdf-figure').forEach((figure, index) => add(wrapFigureMedia(figure, 'figure'), 'figure', index, figure));
    doc.querySelectorAll('figure.pdf-table').forEach((figure, index) => add(wrapFigureMedia(figure, 'table'), 'table', index, figure));
    doc.querySelectorAll('.figure-cluster').forEach((cluster, index) => add(wrapFigureMedia(cluster, 'cluster'), 'cluster', index, cluster));
    doc.querySelectorAll('.my-scholar-media-table-wrapper').forEach((block, index) => add(block, 'table', index));
    doc.querySelectorAll('.my-scholar-media-image-wrapper').forEach((block, index) => add(block, 'image', index));
    doc.querySelectorAll('table.extracted-table').forEach((table, index) => {
      if (table.closest('figure.pdf-figure, figure.pdf-table, .figure-cluster, .my-scholar-media-block')) return;
      const wrapper = wrapLegacyMedia(table, 'my-scholar-media-table-wrapper');
      const scroll = doc.createElement('div');
      scroll.className = 'table-scroll';
      table.before(scroll);
      scroll.append(table);
      add(wrapper, 'table', index);
    });
    doc.querySelectorAll(readerImageSelector).forEach((image, index) => {
      if (!readerImageTarget(image) || image.closest('figure.pdf-figure, figure.pdf-table, .figure-cluster, .my-scholar-media-block')) return;
      const content = image.closest('a.asset-link') || image;
      const wrapper = wrapLegacyMedia(content, 'my-scholar-media-image-wrapper');
      add(wrapper, 'image', index);
    });
    return descriptors;
  }

  function prepareMediaSizing(block) {
    if (block.querySelector('table')) return;
    const images = [...block.querySelectorAll('img')];
    if (block.classList.contains('my-scholar-media-cluster-visual') && images.length > 1) {
      if (block.dataset.mediaSizingReady) return;
      const view = block.ownerDocument.defaultView;
      const limits = images.map((image) => {
        const style = view.getComputedStyle(image);
        return { width: parseFloat(style.maxWidth) || Infinity, height: parseFloat(style.maxHeight) || Infinity };
      });
      const update = () => {
        if (images.some((image) => !image.naturalWidth)) return;
        const widths = images.map((image, index) => Math.min(image.naturalWidth, limits[index].width, limits[index].height * image.naturalWidth / image.naturalHeight));
        const gap = parseFloat(view.getComputedStyle(block.parentElement).columnGap) || 0;
        block.style.setProperty('--my-scholar-media-preferred-width', `${widths.reduce((sum, width) => sum + width, 0) + gap * (images.length - 1)}px`);
        widths.forEach((width, index) => images[index].style.setProperty('--my-scholar-media-panel-weight', String(width)));
        block.classList.add('my-scholar-media-sized-cluster');
      };
      images.forEach((image) => image.addEventListener('load', update));
      update();
      block.dataset.mediaSizingReady = 'true';
      return;
    }
    if (images.length !== 1) return;
    const image = images[0];
    if (image.classList.contains('my-scholar-media-primary-image')) return;
    const declared = image.style.width.match(/^([\d.]+)px$/u)?.[1] || image.getAttribute('width');
    const preferredWidth = Number(declared);
    const update = () => {
      const width = preferredWidth > 0 ? preferredWidth : image.naturalWidth;
      if (width > 0) block.style.setProperty('--my-scholar-media-preferred-width', `${width}px`);
    };
    update();
    image.addEventListener('load', update);
    image.classList.add('my-scholar-media-primary-image');
  }

  function mediaBlockLabel(type) {
    if (type === 'table') return '表格';
    if (type === 'cluster') return '图片组';
    return '图片';
  }

  function restoreMediaWidth(jobId, key, previousWidth) {
    const layout = mediaLayoutForJob(jobId);
    if (previousWidth == null) delete layout.items[key];
    else layout.items[key] = { width_percent: previousWidth };
    if (!isActiveReaderJob(jobId)) return;
    const block = frameDocument()?.querySelector(`[data-media-key="${cssEscape(key)}"]`);
    applyMediaWidth(block, previousWidth ?? mediaWidthMaximum);
  }

  function persistMediaWidth(jobId, key, width, previousWidth) {
    if (!jobId || state.health?.readonly) return Promise.resolve(false);
    const layout = mediaLayoutForJob(jobId);
    const next = normalizedMediaWidth(width);
    layout.items[key] = { width_percent: next };
    const queued = mediaLayoutSaveQueues.get(jobId) || Promise.resolve();
    const task = queued.catch(() => {}).then(async () => {
      try {
        await api(`/api/jobs/${jobId}/media-layout`, jsonOptions({ items: { [key]: { width_percent: next } } }, 'PATCH'));
        return true;
      } catch (error) {
        if (layout.items[key]?.width_percent === next) restoreMediaWidth(jobId, key, previousWidth);
        showToast(`媒体宽度保存失败：${error.message}`, true);
        return false;
      }
    });
    mediaLayoutSaveQueues.set(jobId, task);
    task.finally(() => {
      if (mediaLayoutSaveQueues.get(jobId) === task) mediaLayoutSaveQueues.delete(jobId);
      releaseClosedDocumentCaches(jobId);
    });
    return task;
  }

  function setMediaWidth(block, jobId, key, width, { persist = false, previousWidth = null } = {}) {
    const next = applyMediaWidth(block, width);
    mediaLayoutForJob(jobId).items[key] = { width_percent: next };
    if (persist) void persistMediaWidth(jobId, key, next, previousWidth);
    return next;
  }

  function finishMediaResize(event, cancelled = false) {
    if (!mediaResize.active || (event?.pointerId != null && event.pointerId !== mediaResize.pointerId)) return;
    event?.preventDefault?.();
    event?.stopPropagation?.();
    try {
      if (mediaResize.handle?.hasPointerCapture?.(mediaResize.pointerId)) mediaResize.handle.releasePointerCapture(mediaResize.pointerId);
    } catch (_) {}
    const { block, doc, jobId, key, startPercent, currentPercent } = mediaResize;
    block?.classList.remove('is-resizing');
    doc?.documentElement.classList.remove('is-resizing-media');
    mediaResize.active = false;
    mediaResize.pointerId = null;
    mediaResize.block = null;
    mediaResize.doc = null;
    mediaResize.handle = null;
    if (cancelled) {
      setMediaWidth(block, jobId, key, startPercent);
      return;
    }
    if (currentPercent !== startPercent) void persistMediaWidth(jobId, key, currentPercent, startPercent);
  }

  function startMediaResize(event) {
    if (event.button !== 0 || state.health?.readonly) return;
    const handle = event.currentTarget;
    const block = handle.closest('.my-scholar-media-resizable');
    const doc = handle.ownerDocument;
    const jobId = String(block?.dataset.mediaJobId || '');
    const key = String(block?.dataset.mediaKey || '');
    if (!block || !jobId || !key) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = block.getBoundingClientRect();
    const containerWidth = rect.width / (Number(block.dataset.mediaWidth) / 100 || 1);
    Object.assign(mediaResize, {
      active: true, pointerId: event.pointerId, handle, block, doc, jobId, key,
      side: handle.dataset.mediaResizeSide || 'right', startX: event.clientX,
      startWidth: rect.width, containerWidth: Math.max(1, containerWidth),
      startPercent: mediaWidthFor(jobId, key), currentPercent: mediaWidthFor(jobId, key),
    });
    try { handle.setPointerCapture?.(event.pointerId); } catch (_) {}
    block.classList.add('is-resizing');
    doc.documentElement.classList.add('is-resizing-media');
    doc.getSelection()?.removeAllRanges();
    clearSelectionPopover({ clearState: true });
  }

  function moveMediaResize(event) {
    if (!mediaResize.active || event.pointerId !== mediaResize.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const delta = (event.clientX - mediaResize.startX) * (mediaResize.side === 'left' ? -2 : 2);
    const width = ((mediaResize.startWidth + delta) / mediaResize.containerWidth) * 100;
    mediaResize.currentPercent = setMediaWidth(mediaResize.block, mediaResize.jobId, mediaResize.key, width);
  }

  function handleMediaResizeKeyDown(event) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || state.health?.readonly) return;
    event.preventDefault();
    event.stopPropagation();
    const block = event.currentTarget.closest('.my-scholar-media-resizable');
    const jobId = String(block?.dataset.mediaJobId || '');
    const key = String(block?.dataset.mediaKey || '');
    if (!block || !jobId || !key) return;
    const previous = mediaWidthFor(jobId, key);
    const step = event.shiftKey ? 10 : 2;
    const next = event.key === 'Home' ? mediaWidthMinimum
      : event.key === 'End' ? mediaWidthMaximum
        : previous + (event.key === 'ArrowRight' ? step : -step);
    setMediaWidth(block, jobId, key, next, { persist: true, previousWidth: previous });
  }

  function resetMediaWidth(event) {
    if (state.health?.readonly) return;
    event.preventDefault();
    event.stopPropagation();
    const block = event.currentTarget.closest('.my-scholar-media-resizable');
    const jobId = String(block?.dataset.mediaJobId || '');
    const key = String(block?.dataset.mediaKey || '');
    if (!block || !jobId || !key) return;
    const previous = mediaWidthFor(jobId, key);
    setMediaWidth(block, jobId, key, mediaWidthMaximum, { persist: true, previousWidth: previous });
  }

  function prepareReaderMedia(doc = frameDocument(), jobId = state.activeJob?.job_id) {
    if (!doc || !jobId) return;
    readerMediaBlocks(doc).forEach(({ block, key, type }) => {
      prepareMediaSizing(block);
      block.classList.add('my-scholar-media-resizable');
      block.dataset.mediaKey = key;
      block.dataset.mediaJobId = jobId;
      applyMediaWidth(block, mediaWidthFor(jobId, key));
      if (state.health?.readonly || block.querySelector('.my-scholar-media-resize-handle')) return;
      const label = mediaBlockLabel(type);
      for (const side of ['left', 'right']) {
        const handle = doc.createElement('button');
        handle.type = 'button';
        handle.className = `my-scholar-media-resize-handle is-${side}`;
        handle.dataset.mediaResizeSide = side;
        handle.setAttribute('role', 'separator');
        handle.setAttribute('aria-orientation', 'vertical');
        handle.setAttribute('aria-label', `从${side === 'left' ? '左' : '右'}侧调整${label}宽度`);
        handle.setAttribute('aria-valuemin', String(mediaWidthMinimum));
        handle.setAttribute('aria-valuemax', String(mediaWidthMaximum));
        handle.addEventListener('pointerdown', startMediaResize);
        handle.addEventListener('pointermove', moveMediaResize);
        handle.addEventListener('pointerup', (event) => finishMediaResize(event));
        handle.addEventListener('pointercancel', (event) => finishMediaResize(event, true));
        handle.addEventListener('keydown', handleMediaResizeKeyDown);
        handle.addEventListener('dblclick', resetMediaWidth);
        block.append(handle);
      }
      applyMediaWidth(block, mediaWidthFor(jobId, key));
    });
  }

  async function loadMediaLayout(jobId, mount = readerMounts.get(jobId)) {
    const payload = await api(`/api/jobs/${jobId}/media-layout`);
    if (!readerMountIsCurrent(mount)) return;
    state.mediaLayouts.set(jobId, normalizeMediaLayout(payload.media_layout));
    if (isActiveReaderJob(jobId) && mount.wiredDocument === frameDocument()) prepareReaderMedia(frameDocument(), jobId);
    return state.mediaLayouts.get(jobId);
  }

  function setLightboxBackgroundInert(inert) {
    [$('.app-header'), $('.app-shell')].forEach((surface) => {
      if (!surface) return;
      surface.inert = Boolean(inert);
      if (inert) surface.setAttribute('aria-hidden', 'true');
      else surface.removeAttribute('aria-hidden');
    });
  }

  function openImageLightbox(details, trigger = null) {
    const lightbox = $('#image-lightbox');
    const image = $('#image-lightbox-image');
    const caption = $('#image-lightbox-caption');
    if (!lightbox || !image || !details?.src) return false;
    closeImageContextMenu();
    window.clearTimeout(imageLightboxCloseTimer);
    imageLightboxCloseTimer = null;
    lightbox.classList.remove('is-closing');
    imageLightboxTrigger = trigger;
    imageLightboxDetails = details;
    image.src = details.src;
    image.alt = details.alt || details.caption || '论文图片';
    caption.textContent = details.caption || '';
    caption.hidden = !details.caption;
    lightbox.hidden = false;
    lightbox.setAttribute('aria-hidden', 'false');
    setLightboxBackgroundInert(true);
    document.body.classList.add('image-lightbox-open');
    window.requestAnimationFrame(() => $('#image-lightbox-close')?.focus({ preventScroll: true }));
    return true;
  }

  function closeImageLightbox({ restoreFocus = true } = {}) {
    const lightbox = $('#image-lightbox');
    if (!lightbox || lightbox.hidden) return false;
    if (lightbox.classList.contains('is-closing')) return true;
    closeImageContextMenu();
    imageLightboxDetails = null;
    const trigger = imageLightboxTrigger;
    imageLightboxTrigger = null;
    const finish = () => {
      imageLightboxCloseTimer = null;
      lightbox.classList.remove('is-closing');
      lightbox.hidden = true;
      lightbox.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('image-lightbox-open');
      const image = $('#image-lightbox-image');
      if (image) image.removeAttribute('src');
      setLightboxBackgroundInert(false);
      if (restoreFocus && trigger?.isConnected) {
        try { trigger.focus({ preventScroll: true }); } catch (_) {}
      }
    };
    lightbox.classList.add('is-closing');
    if (reducedMotionQuery.matches) finish();
    else imageLightboxCloseTimer = window.setTimeout(finish, 190);
    return true;
  }

  function closeImageContextMenu({ restoreFocus = false } = {}) {
    const menu = $('#image-context-menu');
    if (!menu || menu.hidden) return false;
    const trigger = imageContextTrigger;
    imageContextTrigger = null;
    imageContextDetails = null;
    closeTransient(menu, { onFinish: () => {
      if (restoreFocus && trigger?.isConnected) {
        try { trigger.focus({ preventScroll: true }); } catch (_) {}
      }
    } });
    return true;
  }

  function openImageContextMenu(details, trigger, clientX, clientY) {
    const menu = $('#image-context-menu');
    if (!menu || !details) return;
    closeImageContextMenu();
    imageContextTrigger = trigger;
    imageContextDetails = details;
    openTransient(menu);
    menu.style.left = '0px';
    menu.style.top = '0px';
    const width = menu.offsetWidth || 210;
    const height = menu.offsetHeight || 90;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, Number(clientX) || 8));
    const top = Math.max(8, Math.min(window.innerHeight - height - 8, Number(clientY) || 8));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.querySelector('[role="menuitem"]')?.focus({ preventScroll: true });
  }

  async function readerImagePNGBlob(src) {
    const response = await fetch(src);
    if (!response.ok) throw new Error(`读取图片失败（${response.status}）。`);
    const blob = await response.blob();
    if (blob.type === 'image/png') return blob;
    const bitmap = await createImageBitmap(blob);
    const maximumEdge = 2600;
    const maximumPixels = 6_000_000;
    const scale = Math.min(1, maximumEdge / Math.max(bitmap.width, bitmap.height), Math.sqrt(maximumPixels / (bitmap.width * bitmap.height)));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d', { alpha: false });
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return new Promise((resolve, reject) => {
      canvas.toBlob((value) => value ? resolve(value) : reject(new Error('无法转换图片。')), 'image/png');
    });
  }

  function blobDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener('load', () => resolve(String(reader.result || '')), { once: true });
      reader.addEventListener('error', () => reject(reader.error || new Error('无法读取图片。')), { once: true });
      reader.readAsDataURL(blob);
    });
  }

  async function copyReaderImage(details) {
    if (!details?.src) throw new Error('没有找到可复制的图片。');
    const png = await readerImagePNGBlob(details.src);
    if (window.myScholarDesktop?.copyImage) {
      await window.myScholarDesktop.copyImage(await blobDataURL(png));
    } else {
      if (!navigator.clipboard?.write || !window.ClipboardItem) throw new Error('当前环境不支持复制图片。');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    }
    showToast('图片已复制到剪贴板。');
  }

  function addReaderImageToChat(details) {
    if (!details?.assetPath) throw new Error('这张图片不是当前文献的本地资源，无法加入 Chat。');
    state.chatSelection = {
      kind: 'image',
      image: {
        path: details.assetPath,
        src: details.src,
        alt: details.alt,
        caption: details.caption,
        block_id: details.blockId,
        page: details.page,
      },
    };
    renderSelectedContext();
    closeImageContextMenu();
    closeImageLightbox({ restoreFocus: false });
    setAssistantOpen(true);
    switchSidebar('chat-panel');
    $('#chat-input')?.focus({ preventScroll: true });
    showToast('图片已加入 Chat，可以直接针对它提问。');
  }

  $('#image-lightbox')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closeImageLightbox();
  });
  $('.image-lightbox-content')?.addEventListener('click', (event) => event.stopPropagation());
  $('#image-lightbox-close')?.addEventListener('click', () => closeImageLightbox());
  $('#image-lightbox-image')?.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (imageLightboxDetails) openImageContextMenu(imageLightboxDetails, event.currentTarget, event.clientX, event.clientY);
  });
  $('#image-context-menu')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-image-action]');
    if (!button || button.disabled || !imageContextDetails) return;
    const details = imageContextDetails;
    if (button.dataset.imageAction === 'add-chat') {
      try { addReaderImageToChat(details); } catch (error) { showToast(error.message, true); }
      return;
    }
    if (button.dataset.imageAction !== 'copy') return;
    button.disabled = true;
    try {
      await copyReaderImage(details);
      if (imageContextDetails === details) closeImageContextMenu();
    } catch (error) {
      showToast(`复制失败：${error.message}`, true);
    } finally {
      button.disabled = false;
    }
  });
  $('#image-context-menu')?.addEventListener('keydown', (event) => {
    const items = [...event.currentTarget.querySelectorAll('[role="menuitem"]:not(:disabled)')];
    const index = items.indexOf(document.activeElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      closeImageContextMenu({ restoreFocus: true });
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      items[(index + direction + items.length) % items.length]?.focus();
    }
  });
  document.addEventListener('pointerdown', (event) => {
    if (!event.target.closest?.('#image-context-menu')) closeImageContextMenu();
  });
  window.addEventListener('resize', () => closeImageContextMenu(), { passive: true });

  function isPaperSelectionSurface(element) {
    if (!element?.closest?.('.reader-content')) return false;
    return !element.closest('button, input, textarea, select, summary, .paragraph-translate-trigger, .annotation-note-trigger, .annotation-note-popover, .source-crop, .page-source');
  }

  function beginFrameTextSelection(event) {
    if (event.button !== 0 || !isPaperSelectionSurface(event.target)) return;
    const doc = event.currentTarget;
    const element = event.shiftKey ? selectionElement(doc, event) : event.target;
    const surface = element.closest('.my-scholar-translation') ? 'translation' : 'paper';
    if (doc.documentElement.dataset.readerSelectionSurface !== surface) doc.documentElement.dataset.readerSelectionSurface = surface;
  }

  function renderFrameTextSelection(doc, { reposition = false } = {}) {
    const selection = doc.getSelection();
    const anchor = selectionElement(doc);
    if (!selection?.rangeCount || selection.isCollapsed || !isPaperSelectionSurface(anchor)) {
      readerTextSelectionStates.delete(doc);
      doc.getElementById('reader-text-selection-overlay')?.remove();
      return;
    }
    let current = readerTextSelectionStates.get(doc);
    const unchanged = current && current.anchor === selection.anchorNode && current.focus === selection.focusNode
      && current.start === selection.anchorOffset && current.end === selection.focusOffset;
    if (unchanged && !reposition) return;
    if (!unchanged) {
      const selected = selectionTextRange(selection.getRangeAt(0), doc);
      if (!selected) {
        readerTextSelectionStates.delete(doc);
        doc.getElementById('reader-text-selection-overlay')?.remove();
        return;
      }
      const original = selection.getRangeAt(0);
      const backwards = selection.anchorNode === original.endContainer && selection.anchorOffset === original.endOffset;
      const boundary = backwards ? selected.endContainer : selected.startContainer;
      const translated = Boolean(boundary.parentElement.closest('.my-scholar-translation'));
      const surface = translated ? 'translation' : 'paper';
      if (doc.documentElement.dataset.readerSelectionSurface !== surface) doc.documentElement.dataset.readerSelectionSurface = surface;
      const ranges = [];
      const root = selected.commonAncestorContainer;
      const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node = root.nodeType === Node.TEXT_NODE ? root : walker.nextNode();
      while (node) {
        const element = node.parentElement;
        if (isPaperSelectionSurface(element) && Boolean(element.closest('.my-scholar-translation')) === translated
          && !element.closest('.translation-source-label,.translation-retained-status') && selected.intersectsNode(node)) {
          const range = doc.createRange();
          range.selectNodeContents(node);
          if (selected.compareBoundaryPoints(Range.START_TO_START, range) > 0) range.setStart(selected.startContainer, selected.startOffset);
          if (selected.compareBoundaryPoints(Range.END_TO_END, range) < 0) range.setEnd(selected.endContainer, selected.endOffset);
          if (!range.collapsed) ranges.push(range);
        }
        node = walker.nextNode();
      }
      const images = [...(root.querySelectorAll?.('img') || [])].filter((image) => selected.intersectsNode(image)
        && isPaperSelectionSurface(image) && Boolean(image.closest('.my-scholar-translation')) === translated);
      current = { anchor: selection.anchorNode, focus: selection.focusNode, start: selection.anchorOffset, end: selection.focusOffset, surface, ranges, images };
      readerTextSelectionStates.set(doc, current);
    }
    const rectangles = [...current.ranges.flatMap((range) => [...range.getClientRects()]), ...current.images.map((image) => image.getBoundingClientRect())]
      .filter((rect) => rect.width > 0 && rect.height > 0);
    let overlay = doc.getElementById('reader-text-selection-overlay');
    if (!overlay) {
      overlay = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
      overlay.id = 'reader-text-selection-overlay';
      overlay.setAttribute('aria-hidden', 'true');
      overlay.append(doc.createElementNS('http://www.w3.org/2000/svg', 'path'));
      doc.body.append(overlay);
    }
    overlay.dataset.surface = current.surface;
    // Native selection fills enlarged bilingual line boxes. A single SVG path
    // paints only glyphs without Custom Highlight's document-wide style work.
    const outline = rectangles.map((rect) => `M${rect.left} ${rect.top}h${rect.width}v${rect.height}h${-rect.width}Z`).join('');
    const path = overlay.firstElementChild;
    if (path.getAttribute('d') !== outline) path.setAttribute('d', outline);
  }

  function guardFrameSelection(event) {
    const doc = event.currentTarget;
    const element = selectionElement(doc, event);
    if (element?.closest?.('input, textarea, [contenteditable="true"]')) return;
    if (!isPaperSelectionSurface(element)) { event.preventDefault(); return; }
    if (event.type === 'copy' && event.clipboardData) {
      const selection = doc.getSelection();
      if (!selection?.rangeCount || selection.isCollapsed) return;
      const range = selection.getRangeAt(0);
      const selected = range.cloneContents();
      if (!selected.querySelector('.reader-source-sentence, .my-scholar-translation, .math-source-visual, .math-source-text, math, semantics, annotation, .katex-html, button, input, textarea, select, .annotation-note-popover, .translation-source-label, .translation-retained-status, [hidden], [aria-hidden="true"], [style]')) return;
      const start = selection.anchorNode?.nodeType === Node.TEXT_NODE ? selection.anchorNode.parentElement : selection.anchorNode;
      const mode = doc.documentElement.dataset.translationDisplay || state.translationPreferences.displayMode;
      const copyTranslation = mode === 'translation' || mode !== 'original' && Boolean(start.closest?.('.my-scholar-translation'));
      selected.querySelectorAll('button, input, textarea, select, .paragraph-translate-trigger, .annotation-note-trigger, .annotation-note-popover, .translation-source-label, .translation-retained-status').forEach((node) => node.remove());
      selected.querySelectorAll(copyTranslation ? '.reader-source-sentence, .my-scholar-translation-original:not(.reader-sentence-pairs)' : '.my-scholar-translation').forEach((node) => node.remove());
      selected.querySelectorAll('.math-source-visual').forEach((node) => node.replaceWith(node.querySelector('.math-source-text')?.textContent || node.textContent || ''));
      selected.querySelectorAll('math, semantics').forEach((node) => {
        const tex = node.querySelector('annotation[encoding="application/x-tex"], annotation[encoding="application/tex"]')?.textContent;
        node.querySelectorAll('annotation, annotation-xml').forEach((annotation) => annotation.remove());
        node.replaceWith(tex || node.textContent || '');
      });
      selected.querySelectorAll('annotation, annotation-xml').forEach((node) => node.remove());
      selected.querySelectorAll('.katex-html, [hidden], [aria-hidden="true"], [style]').forEach((node) => {
        if (node.matches('.katex-html, [hidden], [aria-hidden="true"]') || node.style.display === 'none' || node.style.visibility === 'hidden') node.remove();
      });
      const walker = doc.createTreeWalker(selected, doc.defaultView.NodeFilter.SHOW_TEXT);
      const parts = [];
      let node;
      while ((node = walker.nextNode())) parts.push(node.nodeValue);
      event.clipboardData.setData('text/plain', parts.join(''));
      event.preventDefault();
    }
  }

  function blockForNode(node) { return node?.nodeType === Node.ELEMENT_NODE ? node.closest('[data-block-id]') : node?.parentElement?.closest('[data-block-id]'); }
  function canonicalSelectionOffsets(block, range, doc = frameDocument()) {
    let start = textOffset(block, range.startContainer, range.startOffset, doc);
    let end = textOffset(block, range.endContainer, range.endOffset, doc);
    const text = canonicalBlockText(block, doc);
    if (Number.isFinite(start) && Number.isFinite(end)) {
      const selected = text.slice(start, end);
      start += selected.length - selected.trimStart().length;
      end -= selected.length - selected.trimEnd().length;
    }
    return { start, end, text };
  }
  let selectionTranslationTimer = null;
  let selectionTranslationToken = 0;
  let selectionTranslationKey = '';
  let selectionTranslationAbortController = null;
  let selectionTranslationRecord = null;

  function clearSelectionPopover({ clearState = false, immediate = false } = {}) {
    if (!selectionTranslationRecord?.keepForVocabulary) window.clearTimeout(selectionTranslationRecord?.timer ?? selectionTranslationTimer);
    selectionTranslationTimer = null;
    if (!selectionTranslationRecord?.keepForVocabulary) {
      selectionTranslationAbortController?.abort();
      selectionTranslationRecord?.resolve?.('');
    }
    selectionTranslationAbortController = null;
    selectionTranslationToken += 1;
    selectionTranslationKey = '';
    selectionTranslationRecord = null;
    const popover = $('#selection-popover');
    const result = $('#selection-translation-result');
    const resetResult = () => {
      if (!result) return;
      result.replaceChildren();
      result.hidden = false;
      delete result.dataset.state;
      result.removeAttribute('aria-busy');
      if (popover) popover.style.maxHeight = '';
    };
    if (popover) closeTransient(popover, { immediate, onFinish: resetResult });
    else resetResult();
    if (clearState) {
      state.selection = null;
      renderSelectedContext();
    }
  }

  function selectionRequestKey(selection) {
    if (!selection?.quote) return '';
    return [state.activeJob?.job_id || '', selection.surface || 'paper', selection.block_id || '', selection.source_block_id || '', selection.start ?? '', selection.end ?? '', hashText(selection.quote)].join(':');
  }

  function activeSelectionActionTarget() {
    const selection = state.selection;
    const popover = $('#selection-popover');
    const doc = frameDocument();
    if (!selection?.quote || !doc || !popover || popover.hidden || popover.classList.contains('is-closing') || !$('#reader-view')?.classList.contains('active-view')) return null;
    if (selection.job_id !== state.activeJob?.job_id || selection.render_generation !== activeChatSourceGeneration()) return null;
    return selection;
  }

  $('#selection-popover')?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') clearSelectionPopover({ clearState: true, immediate: true });
  });

  function positionSelectionPopover() {
    const frame = $('#html-preview');
    const wrap = $('.reader-frame-wrap');
    const popover = $('#selection-popover');
    const anchor = state.selection?.anchorRect;
    if (!frame || !wrap || !popover || popover.hidden || !anchor) return;
    const frameRect = frame.getBoundingClientRect();
    const wrapRect = wrap.getBoundingClientRect();
    const scaleX = frame.clientWidth ? frameRect.width / frame.clientWidth : 1;
    const scaleY = frame.clientHeight ? frameRect.height / frame.clientHeight : 1;
    const popoverWidth = popover.offsetWidth || 320;
    const popoverHeight = popover.offsetHeight || 96;
    const anchorLeft = frameRect.left - wrapRect.left + anchor.left * scaleX;
    const below = frameRect.top - wrapRect.top + anchor.bottom * scaleY + 6;
    const above = frameRect.top - wrapRect.top + anchor.top * scaleY - popoverHeight - 6;
    const maxLeft = Math.max(8, wrapRect.width - popoverWidth - 8);
    const maxTop = Math.max(8, wrapRect.height - popoverHeight - 8);
    popover.style.left = `${Math.max(8, Math.min(maxLeft, anchorLeft))}px`;
    popover.style.top = `${Math.max(8, Math.min(maxTop, below <= maxTop ? below : above))}px`;
  }

  function renderSelectionTranslation(status, { text = '', formulas = [], markers = [], emphasis = [], message = '' } = {}) {
    const result = $('#selection-translation-result');
    if (!result) return;
    result.replaceChildren();
    result.dataset.state = status;
    result.setAttribute('aria-busy', String(status === 'loading' || status === 'streaming'));
    if (status === 'ready' || status === 'streaming') {
      const rendered = renderTranslationText(text, formulas, document, markers, emphasis);
      if (rendered) result.append(rendered); else result.textContent = text;
    } else if (status === 'error') {
      const label = document.createElement('span');
      label.className = 'selection-translation-error';
      label.textContent = message || '翻译失败。';
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.dataset.selectionTranslationRetry = '';
      retry.textContent = '重试';
      result.append(label, retry);
    } else {
      const label = document.createElement('span');
      label.className = 'selection-translation-loading';
      label.textContent = '正在翻译选中文本…';
      result.append(label);
    }
    window.requestAnimationFrame(positionSelectionPopover);
  }

  function displayedSentenceTranslation(selection, doc = frameDocument()) {
    if (selection?.surface !== 'paper' || !selection.block_id || !doc) return null;
    const block = translationTarget(selection.block_id, doc);
    if (!block || !Number.isInteger(selection.start) || !Number.isInteger(selection.end)) return null;
    const selected = canonicalBlockText(block, doc).slice(selection.start, selection.end);
    if (!selected.trim() || selected !== selection.quote) return null;
    const start = selection.start + selected.length - selected.trimStart().length;
    const end = selection.end - selected.length + selected.trimEnd().length;
    const sentenceId = `s${start}-${end}`;
    const translated = [...block.querySelectorAll('.reader-sentence-translation:not(.is-pending):not(.is-error)')]
      .find((node) => node.dataset.for === selection.block_id && node.dataset.sentenceId === sentenceId);
    return translated?.translationResult?.text ? translated.translationResult : null;
  }

  function beginSelectionTranslation(selection, { immediate = false } = {}) {
    const key = selectionRequestKey(selection);
    if (!key) return;
    if (!selectionTranslationRecord?.keepForVocabulary) {
      window.clearTimeout(selectionTranslationRecord?.timer ?? selectionTranslationTimer);
      selectionTranslationAbortController?.abort();
      selectionTranslationRecord?.resolve?.('');
    }
    selectionTranslationRecord = null;
    selectionTranslationKey = key;
    const token = ++selectionTranslationToken;
    if (selection.surface === 'translation') {
      renderSelectionTranslation('ready', { text: '当前选区已是译文，可直接高亮、划线、记录笔记或加入 Chat。' });
      return;
    }
    const displayed = immediate ? null : displayedSentenceTranslation(selection);
    if (displayed) {
      selectionTranslationTimer = null;
      selectionTranslationAbortController = null;
      selectionTranslationRecord = { key, jobId: state.activeJob?.job_id, text: displayed.text, keepForVocabulary: false, promise: Promise.resolve(displayed.text) };
      renderSelectionTranslation('ready', displayed);
      return;
    }
    if (!aiServiceEnabled('translation')) {
      renderSelectionTranslation('error', { message: '翻译服务当前不可用。' });
      return;
    }
    renderSelectionTranslation('loading');
    const jobId = state.activeJob?.job_id;
    const abortController = new AbortController();
    selectionTranslationAbortController = abortController;
    const record = { key, jobId, text: '', keepForVocabulary: false, resolve: null, promise: null };
    record.promise = new Promise((resolve) => { record.resolve = resolve; });
    selectionTranslationRecord = record;
    // Collapse whitespace only in the translation copy; the persisted
    // annotation anchor already uses the canonical block text and offsets.
    const quote = String(selection.quote || '').replace(/\s+/g, ' ').trim();
    // The debounce exists to avoid firing gateway requests while the user is
    // still adjusting the selection; a locally cached quote costs nothing.
    const cachedHit = cachedTranslation(null, hashText(quote), translationTargetLanguage(), jobId);
    const stale = () => token !== selectionTranslationToken || key !== selectionTranslationKey || key !== selectionRequestKey(state.selection) || $('#selection-popover')?.hidden;
    selectionTranslationTimer = window.setTimeout(async () => {
      if (selectionTranslationRecord === record) selectionTranslationTimer = null;
      try {
        const translated = await requestTranslation(quote, null, [], {
          jobId,
          onDelta: (partial) => { if (!stale()) renderSelectionTranslation('streaming', { text: partial }); },
          signal: abortController.signal,
        });
        record.text = translated.text;
        record.resolve(translated.text);
        if (stale()) return;
        renderSelectionTranslation('ready', { text: translated.text, formulas: translated.formulas });
      } catch (error) {
        record.resolve('');
        if (stale()) return;
        renderSelectionTranslation('error', { message: translationErrorMessage(error) });
      } finally {
        if (selectionTranslationAbortController === abortController) selectionTranslationAbortController = null;
      }
    }, immediate || cachedHit ? 0 : 180);
    record.timer = selectionTranslationTimer;
  }

  function isAnnotationInteraction(target) {
    return Boolean(target?.closest?.('.annotation-note-popover, .annotation-note-trigger'));
  }

  function textNodes(root, doc = frameDocument()) {
    if (!root || !doc) return [];
    const showText = doc.defaultView?.NodeFilter?.SHOW_TEXT || NodeFilter.SHOW_TEXT;
    const walker = doc.createTreeWalker(root, showText);
    const nodes = [];
    let node;
    while ((node = walker.nextNode())) {
      if (node.parentElement?.closest('.annotation-note-trigger, .paragraph-translate-trigger')) continue;
      const translated = node.parentElement?.closest('.reader-sentence-translation');
      if (translated && root !== translated && !root.closest?.('.reader-sentence-translation')) continue;
      if (node.parentElement?.closest('.translation-source-label, .translation-retained-status')) continue;
      if (node.nodeValue) nodes.push(node);
    }
    return nodes;
  }

  function textOffset(root, target, offset, doc = frameDocument()) {
    if (!root || !target || !doc || !root.contains(target) && root !== target) return null;
    if (target.nodeType === Node.TEXT_NODE) {
      let total = 0;
      for (const node of textNodes(root, doc)) {
        if (node === target) return total + Math.max(0, Math.min(offset, node.nodeValue.length));
        total += node.nodeValue.length;
      }
      return null;
    }
    if (target.nodeType !== Node.ELEMENT_NODE) return null;
    try {
      const boundary = doc.createRange();
      boundary.setStart(root, 0);
      boundary.setEnd(target, Math.max(0, Math.min(Number(offset) || 0, target.childNodes.length)));
      return textNodes(boundary.cloneContents(), doc).reduce((total, node) => total + node.nodeValue.length, 0);
    } catch (_) {
      return null;
    }
  }

  function canonicalBlockText(root, doc = frameDocument()) {
    return textNodes(root, doc).map((node) => node.nodeValue).join('');
  }

  function rangeAtOffsets(root, start, end, doc = frameDocument()) {
    const nodes = textNodes(root, doc);
    if (!nodes.length || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    let cursor = 0;
    let startPoint;
    let endPoint;
    for (const node of nodes) {
      const next = cursor + node.nodeValue.length;
      if (!startPoint && start >= cursor && start <= next) startPoint = [node, start - cursor];
      if (!endPoint && end >= cursor && end <= next) { endPoint = [node, end - cursor]; break; }
      cursor = next;
    }
    if (!startPoint || !endPoint) return null;
    const range = doc.createRange();
    range.setStart(startPoint[0], startPoint[1]);
    range.setEnd(endPoint[0], endPoint[1]);
    const startObject = startPoint[0].parentElement?.closest('.math-source-visual');
    const endObject = endPoint[0].parentElement?.closest('.math-source-visual');
    if (startObject && startPoint[1] === 0) range.setStartBefore(startObject);
    if (endObject && endPoint[1] === endPoint[0].nodeValue.length) range.setEndAfter(endObject);
    return range;
  }

  function annotationRange(root, annotation, doc = frameDocument()) {
    const quote = String(annotation.quote || '');
    const fullText = canonicalBlockText(root, doc);
    let start = Number(annotation.start);
    let end = Number(annotation.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || fullText.slice(start, end) !== quote) {
      const expected = Number.isFinite(start) ? start : 0;
      const matches = [];
      let cursor = quote ? fullText.indexOf(quote) : -1;
      while (cursor >= 0) {
        matches.push(cursor);
        cursor = fullText.indexOf(quote, cursor + 1);
      }
      start = matches.sort((left, right) => Math.abs(left - expected) - Math.abs(right - expected))[0] ?? -1;
      end = start >= 0 ? start + quote.length : -1;
    }
    return start >= 0 && end > start ? rangeAtOffsets(root, start, end, doc) : null;
  }

  function translationAnnotationGroup(sourceBlockId, doc = frameDocument()) {
    if (!sourceBlockId || !doc) return null;
    const roots = [...doc.querySelectorAll(`.my-scholar-translation[data-for="${cssEscape(sourceBlockId)}"]`)]
      .filter((root) => (root.dataset.translationFor || root.dataset.for) === sourceBlockId && !root.classList.contains('is-pending') && !root.classList.contains('is-error'));
    if (!roots.length) return null;
    let text = '';
    // Match persisted aligned text without inserting separators into the source DOM.
    const spans = roots.map((root, index) => {
      if (index) text += ' ';
      const start = text.length;
      text += canonicalBlockText(root, doc);
      return { root, start, end: text.length };
    });
    return { sourceBlockId, spans, text };
  }

  function translationGroupSelectionOffsets(group, range, doc = frameDocument()) {
    const offsetAt = (node, offset) => {
      const span = group.spans.find(({ root }) => root === node || root.contains(node));
      if (!span) return null;
      const local = textOffset(span.root, node, offset, doc);
      return Number.isFinite(local) ? span.start + local : null;
    };
    let start = offsetAt(range.startContainer, range.startOffset);
    let end = offsetAt(range.endContainer, range.endOffset);
    if (Number.isFinite(start) && Number.isFinite(end)) {
      const quote = group.text.slice(start, end);
      start += quote.length - quote.trimStart().length;
      end -= quote.length - quote.trimEnd().length;
    }
    return { start, end, text: group.text };
  }

  function translationGroupAnchor(group, start, end, doc = frameDocument()) {
    if (!group || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > group.text.length) return null;
    const ranges = group.spans.filter((span) => end > span.start && start < span.end).map((span) => ({
      root: span.root,
      range: rangeAtOffsets(span.root, Math.max(0, start - span.start), Math.min(span.end - span.start, end - span.start), doc),
    }));
    return ranges.length && ranges.every((entry) => entry.range && !entry.range.collapsed) ? { root: ranges[0].root, ranges } : null;
  }

  function resolveTranslationGroupAnnotation(annotation, sourceBlockId, doc = frameDocument(), { useOffsets = false } = {}) {
    const group = translationAnnotationGroup(sourceBlockId, doc);
    if (!group || annotation.page != null && !group.spans.some(({ root }) => String(root.dataset.page || '') === String(annotation.page))) return null;
    const quote = String(annotation.quote || '');
    const start = Number(annotation.start);
    const end = Number(annotation.end);
    if (useOffsets && Number.isFinite(start) && Number.isFinite(end) && group.text.slice(start, end) === quote) return translationGroupAnchor(group, start, end, doc);
    const matches = [];
    let cursor = quote ? group.text.indexOf(quote) : -1;
    while (cursor >= 0) {
      const prefix = String(annotation.quote_prefix || '');
      const suffix = String(annotation.quote_suffix || '');
      if ((!prefix || group.text.slice(Math.max(0, cursor - prefix.length), cursor) === prefix)
        && (!suffix || group.text.slice(cursor + quote.length, cursor + quote.length + suffix.length) === suffix)) matches.push(cursor);
      cursor = group.text.indexOf(quote, cursor + 1);
    }
    return matches.length === 1 ? translationGroupAnchor(group, matches[0], matches[0] + quote.length, doc) : null;
  }

  function selectionTextRange(range, doc = frameDocument(), surface = null) {
    const root = range.commonAncestorContainer;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const normalized = range.cloneRange();
    let first = null;
    let last = null;
    let node = root.nodeType === Node.TEXT_NODE ? root : walker.nextNode();
    while (node) {
      if (!node.parentElement?.closest('.annotation-note-trigger, .paragraph-translate-trigger, .translation-source-label, .translation-retained-status')
        && (!surface || Boolean(node.parentElement?.closest('.my-scholar-translation')) === (surface === 'translation')) && range.intersectsNode(node)) {
        const overlap = doc.createRange();
        overlap.selectNodeContents(node);
        if (range.compareBoundaryPoints(Range.START_TO_START, overlap) > 0) overlap.setStart(range.startContainer, range.startOffset);
        if (range.compareBoundaryPoints(Range.END_TO_END, overlap) < 0) overlap.setEnd(range.endContainer, range.endOffset);
        if (overlap.toString().trim()) {
          first ||= node;
          last = node;
        }
      }
      node = walker.nextNode();
    }
    if (!first) return null;
    // Native paragraph selection can end at the next surface's empty start.
    normalized.setStart(first, first === range.startContainer ? range.startOffset : 0);
    normalized.setEnd(last, last === range.endContainer ? range.endOffset : last.nodeValue.length);
    return normalized;
  }

  function showSelection(event = null) {
    // Read-only showcase deployments have no annotation/translation/chat
    // actions, so the selection popover has nothing to offer.
    if (state.health?.readonly) return;
    const doc = frameDocument();
    if (!doc) return;
    if (isAnnotationInteraction(event?.target)) {
      clearSelectionPopover({ clearState: true, immediate: true });
      return;
    }
    const selection = doc.getSelection();
    if (!selection?.rangeCount || !selection.toString().trim()) { clearSelectionPopover({ clearState: true }); return; }
    const originalRange = selection.getRangeAt(0);
    const trimmedRange = selectionTextRange(originalRange, doc);
    if (!trimmedRange) { clearSelectionPopover({ clearState: true }); return; }
    const backwards = selection.anchorNode === originalRange.endContainer && selection.anchorOffset === originalRange.endOffset;
    const anchor = backwards ? trimmedRange.endContainer : trimmedRange.startContainer;
    const surface = anchor.parentElement.closest('.my-scholar-translation') ? 'translation' : 'paper';
    const range = selectionTextRange(trimmedRange, doc, surface);
    if (!range) { clearSelectionPopover({ clearState: true }); return; }
    const block = blockForNode(range.startContainer); const focusBlock = blockForNode(range.endContainer);
    const translation = block?.closest?.('.my-scholar-translation');
    const focusTranslation = focusBlock?.closest?.('.my-scholar-translation');
    const sourceBlockId = translation?.dataset.translationFor || translation?.dataset.for;
    const focusSourceBlockId = focusTranslation?.dataset.translationFor || focusTranslation?.dataset.for;
    const group = sourceBlockId && sourceBlockId === focusSourceBlockId ? translationAnnotationGroup(sourceBlockId, doc) : null;
    if (!block || block !== focusBlock && !group) {
      clearSelectionPopover({ clearState: true });
      showToast('首版高亮与划线请在同一段落内完成。', true);
      return;
    }
    const rects = [...range.getClientRects()].filter((item) => item.width || item.height);
    const rect = rects.at(-1) || range.getBoundingClientRect();
    const { start, end, text: canonicalText } = group ? translationGroupSelectionOffsets(group, range, doc) : canonicalSelectionOffsets(block, range, doc);
    const text = Number.isFinite(start) && Number.isFinite(end) ? canonicalText.slice(start, end) : '';
    if (!text) {
      clearSelectionPopover({ clearState: true });
      showToast('无法定位这个选区，请重新选择文字。', true);
      return;
    }
    const nextSelection = {
      origin: 'selection',
      job_id: state.activeJob?.job_id,
      quote: text.slice(0, 10000),
      sentence: window.MyScholarCore.sentenceContext(canonicalText, start, end),
      block_id: group ? `translation-${sourceBlockId}` : block?.dataset.blockId || null,
      source_block_id: sourceBlockId || null,
      surface: translation ? 'translation' : 'paper',
      page: block?.dataset.page || translation?.dataset.page || null,
      start,
      end,
      quote_prefix: canonicalText.slice(Math.max(0, start - 48), start),
      quote_suffix: canonicalText.slice(end, end + 48),
      render_generation: activeChatSourceGeneration(),
      anchorRect: { left: rect.left, top: rect.top, bottom: rect.bottom },
    };
    const nextKey = selectionRequestKey(nextSelection);
    const selectionChanged = nextKey !== selectionTranslationKey;
    state.selection = nextSelection;
    renderSelectedContext();
    const popover = $('#selection-popover');
    const result = $('#selection-translation-result');
    if (result) result.hidden = false;
    renderSelectionActions();
    openTransient(popover);
    if (selectionChanged) beginSelectionTranslation(nextSelection);
    positionSelectionPopover();
  }

  function renderSelectedContext() {
    const node = $('#selected-context');
    if (!node) return;
    const attached = state.chatSelection;
    if (attached?.kind === 'image' && attached.image?.src) {
      const image = attached.image;
      const description = image.caption || image.alt || `第 ${image.page || '—'} 页图片`;
      node.hidden = false;
      node.innerHTML = `<span class="selected-context-label">已加入 Chat · 图片</span><img class="selected-context-image" src="${escapeHTML(image.src)}" alt="${escapeHTML(image.alt || '已选择的论文图片')}"><span class="selected-context-quote">${escapeHTML(description)}</span><button class="selected-context-clear" type="button" aria-label="移除图片上下文">×</button>`;
      return;
    }
    if (attached?.kind === 'text' && attached.selection?.quote) {
      node.hidden = false;
      node.innerHTML = `<span class="selected-context-label">已加入 Chat · 文本</span><span class="selected-context-quote">${escapeHTML(attached.selection.quote)}</span><button class="selected-context-clear" type="button" aria-label="移除文本上下文">×</button>`;
      return;
    }
    // Text context mirrors the live reader selection (VS Code style): it
    // appears while text is selected and vanishes when the selection does.
    const quote = state.selection?.quote || '';
    if (!quote) {
      node.hidden = true;
      node.replaceChildren();
      return;
    }
    node.hidden = false;
    node.innerHTML = `<span class="selected-context-label">当前选中 · 随提问发送</span><span class="selected-context-quote">${escapeHTML(quote)}</span>`;
  }

  $('#selected-context')?.addEventListener('click', (event) => {
    if (!event.target.closest('.selected-context-clear')) return;
    state.chatSelection = null;
    renderSelectedContext();
  });

  let previousSidebarPanelId = 'chat-panel';

  function currentSidebarPanelId() {
    return $('.sidebar-panel.active-panel:not([hidden])')?.id || 'chat-panel';
  }

  function showQuickPreview(content, subtitle = '') {
    const tab = $('#quick-preview-tab');
    const container = $('#quick-preview-content');
    if (!tab || !container) return;
    const current = currentSidebarPanelId();
    if (current !== 'quick-preview-panel') previousSidebarPanelId = current;
    tab.hidden = false;
    container.replaceChildren(content);
    $('#quick-preview-subtitle').textContent = subtitle || '图表与参考文献不会打断阅读位置';
    switchSidebar('quick-preview-panel');
  }

  function closeQuickPreview() {
    const tab = $('#quick-preview-tab');
    if (currentSidebarPanelId() === 'quick-preview-panel') switchSidebar(previousSidebarPanelId || 'chat-panel');
    if (tab) tab.hidden = true;
    $('#quick-preview-content')?.replaceChildren();
    state.quickPreview = null;
  }

  $('#close-quick-preview')?.addEventListener('click', closeQuickPreview);

  function safePreviewAssetURL(source) {
    try {
      const url = new URL(String(source || ''), frameDocument()?.baseURI || location.href);
      const jobId = String(state.activeJob?.job_id || '');
      if (!/^[a-f0-9]{12,40}$/.test(jobId) || url.origin !== location.origin) return '';
      const assetPath = new RegExp(`^/api/jobs/${jobId}/(?:renders/[1-9][0-9]{0,8}/)?assets/images/[a-z0-9][a-z0-9._@-]{0,180}\\.(?:png|jpe?g|webp|gif)$`, 'i');
      return assetPath.test(url.pathname) ? url.href : '';
    } catch (_) {
      return '';
    }
  }

  const INLINE_MARKER_SHAPES = new Set(['circle', 'square']);
  const INLINE_MARKER_TONES = new Set(['gray', 'blue', 'orange', 'green', 'red', 'purple', 'pink']);
  const PDF_TEXT_TONES = new Set(['blue', 'orange', 'green', 'red', 'purple', 'pink']);

  function inlineLegendMarkerSpec(node) {
    if (!node?.classList?.contains('inline-legend-marker')) return null;
    const shapes = [...INLINE_MARKER_SHAPES].filter((shape) => node.classList.contains(`inline-legend-marker-${shape}`));
    const tones = [...INLINE_MARKER_TONES].filter((tone) => node.classList.contains(`inline-legend-marker-${tone}`));
    if (shapes.length !== 1 || tones.length !== 1) return null;
    return { shape: shapes[0], tone: tones[0] };
  }

  function inlineLegendMarkerNode(spec, doc = document) {
    if (!doc || !INLINE_MARKER_SHAPES.has(spec?.shape) || !INLINE_MARKER_TONES.has(spec?.tone)) return null;
    const marker = doc.createElement('span');
    marker.className = `inline-legend-marker inline-legend-marker-${spec.shape} inline-legend-marker-${spec.tone}`;
    marker.setAttribute('role', 'img');
    marker.setAttribute('aria-label', `line with ${spec.shape} marker`);
    const line = doc.createElement('span');
    line.className = 'inline-legend-line';
    line.setAttribute('aria-hidden', 'true');
    const shape = doc.createElement('span');
    shape.className = 'inline-legend-shape';
    shape.setAttribute('aria-hidden', 'true');
    marker.append(line, shape);
    return marker;
  }

  function pdfTextToneSpec(node) {
    if (!node?.classList?.contains('pdf-text-tone')) return null;
    const tones = [...PDF_TEXT_TONES].filter((tone) => node.classList.contains(`pdf-text-tone-${tone}`));
    if (tones.length !== 1 || (node.dataset.textTone && node.dataset.textTone !== tones[0])) return null;
    return { tone: tones[0] };
  }

  function pdfTextToneNode(spec, doc = document) {
    if (!doc || !PDF_TEXT_TONES.has(spec?.tone)) return null;
    const span = doc.createElement('span');
    span.className = `pdf-text-tone pdf-text-tone-${spec.tone}`;
    span.dataset.textTone = spec.tone;
    return span;
  }

  function previewStructuredClone(source) {
    const htmlAllowed = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'figcaption', 'div', 'span', 'p', 'strong', 'b', 'em', 'i', 'sup', 'sub', 'br', 'code']);
    const mathAllowed = new Set(['math', 'mrow', 'mi', 'mn', 'mo', 'mtext', 'mfrac', 'msqrt', 'mroot', 'msub', 'msup', 'msubsup', 'munder', 'mover', 'munderover', 'mtable', 'mtr', 'mtd', 'mstyle', 'mpadded', 'mphantom', 'menclose', 'ms', 'semantics', 'annotation', 'mspace', 'mmultiscripts', 'mprescripts', 'none']);
    const mathAttributes = new Set(['display', 'mathvariant', 'displaystyle', 'scriptlevel', 'stretchy', 'fence', 'separator', 'accent', 'accentunder', 'linethickness', 'bevelled', 'notation', 'rowalign', 'columnalign', 'rowspan', 'columnspan', 'width', 'height', 'depth', 'lspace', 'rspace']);
    function clone(node) {
      if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.nodeValue);
      if (node.nodeType !== Node.ELEMENT_NODE) return null;
      if (node.classList?.contains('inline-legend-marker')) {
        return inlineLegendMarkerNode(inlineLegendMarkerSpec(node), document);
      }
      if (node.classList?.contains('pdf-text-tone')) {
        const copy = pdfTextToneNode(pdfTextToneSpec(node), document);
        if (!copy) return null;
        [...node.childNodes].forEach((child) => { const childCopy = clone(child); if (childCopy) copy.append(childCopy); });
        return copy;
      }
      // KaTeX output carries a visual HTML twin next to the accessibility
      // MathML; previews keep only the MathML half to avoid duplicated glyphs.
      if (node.classList?.contains('katex-html')) return null;
      const name = String(node.localName || node.tagName || '').toLowerCase();
      if (name === 'img' && node.classList.contains('math-source-inline')) {
        const url = safePreviewAssetURL(node.currentSrc || node.src);
        if (!url) return null;
        const crop = document.createElement('img');
        crop.className = 'math-source-inline';
        crop.src = url;
        crop.alt = node.alt || '';
        crop.setAttribute('aria-hidden', 'true');
        const height = Number(node.dataset.heightEm);
        const baseline = Number(node.dataset.baselineOffsetEm);
        if (Number.isFinite(height) && height > 0 && height <= 3.6) crop.dataset.heightEm = String(height);
        if (Number.isFinite(baseline) && Math.abs(baseline) <= 3.6) crop.dataset.baselineOffsetEm = String(baseline);
        Object.assign(crop.style, { display: 'inline', verticalAlign: `${Number.isFinite(baseline) ? -baseline : 0}em`, maxHeight: '3.6em', maxWidth: '100%', width: 'auto', height: height > 0 && height <= 3.6 ? `${height}em` : 'auto' });
        return crop;
      }
      const isMath = mathAllowed.has(name);
      if (!isMath && !htmlAllowed.has(name)) return null;
      const annotationEncoding = name === 'annotation' ? String(node.getAttribute('encoding') || '').toLowerCase() : '';
      if (name === 'annotation' && !['application/x-tex', 'application/tex'].includes(annotationEncoding)) return null;
      const copy = isMath
        ? document.createElementNS('http://www.w3.org/1998/Math/MathML', name)
        : document.createElement(name);
      if (name === 'span' && node.matches('.math-source-visual, .math-source-text')) copy.className = node.className;
      ['rowspan', 'colspan', 'scope'].forEach((attribute) => {
        const value = node.getAttribute(attribute);
        if (value && /^[a-z0-9-]{1,16}$/i.test(value)) copy.setAttribute(attribute, value);
      });
      if (isMath) mathAttributes.forEach((attribute) => {
        const value = node.getAttribute(attribute);
        if (value && /^[a-z0-9+.,%()\s/-]{1,80}$/i.test(value)) copy.setAttribute(attribute, value);
      });
      if (annotationEncoding) copy.setAttribute('encoding', annotationEncoding);
      const ariaLabel = node.getAttribute('aria-label');
      if (ariaLabel) copy.setAttribute('aria-label', ariaLabel.slice(0, 500));
      [...node.childNodes].forEach((child) => { const childCopy = clone(child); if (childCopy) copy.append(childCopy); });
      return copy;
    }
    return clone(source);
  }

  function previewCaptionTranslation(caption) {
    const blockId = caption?.dataset?.translateBlockId || caption?.dataset?.blockId || '';
    if (!blockId) return null;
    const source = paragraphSource(caption);
    const rendered = caption.ownerDocument?.querySelector(`.my-scholar-translation[data-for="${cssEscape(blockId)}"] .translation-text`);
    const node = document.createElement('div');
    node.className = 'quick-preview-translation';
    node.lang = 'zh-CN';
    const renderedHash = rendered?.closest('.my-scholar-translation')?.dataset.sourceHash;
    if (rendered && (renderedHash === translationSourceHash(source) || (!renderedHash && !source.formulas.length && !source.markers.length && !source.emphasis.length))) {
      const clone = previewStructuredClone(rendered);
      if (!clone) return null;
      node.append(...clone.childNodes);
      return node;
    }
    const record = cachedTranslationForSource(blockId, source);
    if (!record?.text) return null;
    const formulas = source.formulas;
    const tokenPayload = protectSpecialTokens(source.text);
    const repaired = repairFormulaTokens(record.text, formulas);
    const translated = restoreSpecialTokens(restoreInlineMarkers(restoreInlineMath(repaired, formulas), source.markers), tokenPayload.tokens);
    const fragment = renderTranslationText(translated, formulas, document, source.markers, source.emphasis);
    if (!fragment) return null;
    node.append(fragment);
    return node;
  }

  function attachQuickPreviewZoom(previewImage, sourceImage) {
    // The preview lives in the host document while the figure it mirrors sits
    // in the reader frame. Describing the original keeps the lightbox — and
    // its caption, download and copy actions — identical to a click in the text.
    const details = readerImageDetails(sourceImage, frameDocument());
    if (!details) return;
    previewImage.classList.add('quick-preview-zoomable');
    previewImage.tabIndex = 0;
    previewImage.setAttribute('role', 'button');
    previewImage.setAttribute('aria-label', details.caption ? `放大查看图片：${details.caption.slice(0, 120)}` : '放大查看图片');
    previewImage.addEventListener('click', () => { openImageLightbox(details, previewImage); });
    previewImage.addEventListener('keydown', (event) => {
      if (!['Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      openImageLightbox(details, previewImage);
    });
  }

  function openMediaQuickPreview(target, link) {
    if (!target) return false;
    const isTable = target.classList.contains('pdf-table') || target.id?.startsWith('table-');
    const isFigure = target.classList.contains('pdf-figure') || target.id?.startsWith('fig-');
    if (!isTable && !isFigure) return false;
    const card = document.createElement('article');
    card.className = 'quick-preview-card';
    const title = document.createElement('h3');
    title.textContent = link?.textContent?.trim() || (isTable ? '表格预览' : '图片预览');
    card.append(title);
    const group = target.dataset.mediaGroup;
    const members = group
      ? [...target.ownerDocument.querySelectorAll(`[data-media-group="${cssEscape(group)}"]`)]
      : [target];
    for (const member of members) {
      if (isTable) {
        const sourceTable = member.querySelector('table');
        if (sourceTable) {
          const shell = document.createElement('div');
          shell.className = 'quick-preview-table';
          const table = previewStructuredClone(sourceTable);
          if (table) shell.append(table);
          card.append(shell);
          continue;
        }
      }
      const sourceImages = [...member.querySelectorAll('img')].filter((image) => readerImageTarget(image));
      for (const sourceImage of sourceImages) {
        const url = safePreviewAssetURL(sourceImage.currentSrc || sourceImage.src);
        if (!url) continue;
        const image = document.createElement('img');
        image.src = url;
        image.alt = sourceImage.alt || (isTable ? '表格原图' : '论文图片');
        attachQuickPreviewZoom(image, sourceImage);
        card.append(image);
      }
    }
    const sourceCaption = target.ownerDocument.getElementById(target.dataset.captionId || '') || target.querySelector('figcaption');
    if (sourceCaption) {
      const caption = previewStructuredClone(sourceCaption);
      if (caption) {
        caption.classList.add('quick-preview-caption');
        card.append(caption);
      }
      const translation = previewCaptionTranslation(sourceCaption);
      if (translation) card.append(translation);
    }
    state.quickPreview = { kind: isTable ? 'table' : 'figure', targetId: target.id || '' };
    showQuickPreview(card, isTable ? '表格预览' : '图片预览');
    return true;
  }

  function citationDetails(link, doc = frameDocument()) {
    const cleanText = (node) => {
      const clone = node?.cloneNode(true);
      clone?.querySelectorAll('button,.annotation-note-trigger,.annotation-note-popover,.my-scholar-translation').forEach((element) => element.remove());
      return clone?.textContent || '';
    };
    const number = String(link?.dataset?.ref || '').trim();
    const reference = number ? doc?.getElementById(`ref-${number}`) : null;
    const contextBlock = link?.closest?.('[data-block-id]');
    let referenceText = cleanText(reference);
    if (reference && !referenceText.trim()) {
      const container = reference.closest('[data-block-id]') || reference.parentElement;
      const anchors = Array.from(container.querySelectorAll('[id^="ref-"]'));
      const next = anchors[anchors.indexOf(reference) + 1];
      const range = doc.createRange();
      range.selectNodeContents(container);
      range.setStartAfter(reference);
      if (next) range.setEndBefore(next);
      referenceText = cleanText(range.cloneContents());
    }
    return {
      number,
      text: String(referenceText).replace(/^\s*(?:\[\d+\]|\d+[.)]?)\s*/u, '').replace(/\s+/g, ' ').trim(),
      context: cleanText(contextBlock).replace(/\s+/g, ' ').trim(),
    };
  }

  async function runReferenceQuickRead(details, output, button) {
    if (!state.activeJob || !details.text || !aiServiceEnabled('chat')) {
      showToast('AI 速读当前不可用。', true);
      return;
    }
    button.disabled = true;
    button.textContent = '正在检索…';
    const jobId = state.activeJob.job_id;
    output.replaceChildren();
    const loading = document.createElement('div');
    loading.className = 'quick-preview-ai-source';
    loading.textContent = browserDemo ? '正在准备 AI 示例分析…' : '正在从可信学术来源检索元数据、摘要或公开内容…';
    output.append(loading);
    try {
      const payload = await api(`/api/jobs/${jobId}/reference-summary`, jsonOptions({
        reference_number: details.number,
        reference_text: details.text.slice(0, 6000),
        context: details.context.slice(0, 8000),
      }));
      if (state.activeJob?.job_id !== jobId || !output.isConnected) return;
      const result = payload.result || {};
      output.replaceChildren(renderChatMarkdown(result.text || '没有获得可用摘要。'));
      const source = document.createElement('div');
      source.className = 'quick-preview-ai-source';
      const providers = Array.isArray(result.sources) ? result.sources.map((item) => item.label || item.provider).filter(Boolean) : [];
      source.textContent = browserDemo ? 'AI 示例分析 · 基于内置样例，无在线检索或真实模型调用。' : providers.length ? `证据来源：${providers.join(' · ')}` : '未找到可核验的在线摘要；以上分析仅基于参考文献条目和当前上下文。';
      output.append(source);
    } catch (error) {
      if (state.activeJob?.job_id !== jobId || !output.isConnected) return;
      output.replaceChildren();
      const failed = document.createElement('div');
      failed.className = 'panel-status error';
      failed.textContent = error.message;
      output.append(failed);
    } finally {
      if (button.isConnected) {
        button.disabled = false;
        button.textContent = 'AI 速读';
      }
    }
  }

  function openReferenceQuickPreview(link) {
    const details = citationDetails(link);
    if (!details.number || !details.text) return false;
    const card = document.createElement('article');
    card.className = 'quick-preview-card';
    const title = document.createElement('h3');
    title.textContent = `参考文献 [${details.number}]`;
    const reference = document.createElement('div');
    reference.className = 'quick-preview-reference';
    reference.textContent = details.text;
    const actions = document.createElement('div');
    actions.className = 'quick-preview-actions';
    const jump = document.createElement('button');
    jump.type = 'button';
    jump.className = 'secondary-button';
    jump.textContent = '跳转到参考文献';
    jump.addEventListener('click', () => readerVisibleTarget(frameDocument()?.getElementById(`ref-${details.number}`))?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    actions.append(jump);
    const quickRead = document.createElement('button');
    quickRead.type = 'button';
    quickRead.className = 'primary-button';
    quickRead.textContent = 'AI 速读';
    const output = document.createElement('div');
    output.className = 'quick-preview-ai';
    output.hidden = true;
    if (!state.health?.readonly) {
      quickRead.disabled = !aiServiceEnabled('chat');
      quickRead.title = quickRead.disabled ? '配置文章助手 API 后可使用' : '';
      quickRead.addEventListener('click', () => { output.hidden = false; runReferenceQuickRead(details, output, quickRead); });
      actions.append(quickRead);
    }
    card.append(title, reference, actions, output);
    state.quickPreview = { kind: 'reference', ...details };
    showQuickPreview(card, `当前段落引用 [${details.number}]`);
    return true;
  }

  function installCitationHoverPreviews(doc = frameDocument()) {
    if (!doc) return;
    doc.querySelectorAll('a.citation[data-ref]').forEach((link) => {
      if (link.dataset.quickPreviewReady === 'true') return;
      link.dataset.quickPreviewReady = 'true';
      let closeTimer = null;
      const open = () => {
        doc.defaultView.clearTimeout(closeTimer);
        const details = citationDetails(link, doc);
        if (!details.text) return;
        doc.querySelector('.reference-hover-card')?.remove();
        const card = doc.createElement('div');
        card.className = 'reference-hover-card';
        card.setAttribute('role', 'tooltip');
        card.textContent = `[${details.number}] ${details.text}`;
        doc.body.append(card);
        const rect = link.getBoundingClientRect();
        const width = Math.min(420, Math.max(240, doc.documentElement.clientWidth - 24));
        card.style.width = `${width}px`;
        card.style.left = `${Math.max(12, Math.min(doc.documentElement.clientWidth - width - 12, rect.left))}px`;
        const height = card.offsetHeight;
        card.style.top = `${Math.max(12, rect.top - height - 8)}px`;
      };
      const close = () => {
        const card = doc.querySelector('.reference-hover-card');
        if (!card) return;
        card.classList.add('is-closing');
        closeTimer = doc.defaultView.setTimeout(() => card.remove(), reducedMotionQuery.matches ? 0 : 140);
      };
      link.addEventListener('mouseenter', open);
      link.addEventListener('focus', open);
      link.addEventListener('mouseleave', close);
      link.addEventListener('blur', close);
    });
  }

  let chapterRailTooltipOwner = null;
  function hideChapterRailTooltip(owner = null) {
    if (owner && chapterRailTooltipOwner !== owner) return;
    const tooltip = $('#reader-chapter-tooltip');
    chapterRailTooltipOwner?.removeAttribute('aria-describedby');
    chapterRailTooltipOwner = null;
    if (tooltip) tooltip.hidden = true;
  }

  function positionChapterRailTooltip() {
    const tooltip = $('#reader-chapter-tooltip');
    const owner = chapterRailTooltipOwner;
    if (!tooltip || tooltip.hidden || !owner?.isConnected || assistantOverlayQuery.matches) return;
    const ownerRect = owner.getBoundingClientRect();
    const width = tooltip.offsetWidth;
    const height = tooltip.offsetHeight;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, ownerRect.right + 8));
    const top = Math.max(8, Math.min(window.innerHeight - height - 8, ownerRect.top + (ownerRect.height - height) / 2));
    tooltip.style.left = `${Math.round(left)}px`;
    tooltip.style.top = `${Math.round(top)}px`;
  }

  function showChapterRailTooltip(button) {
    if (!button || assistantOverlayQuery.matches) {
      hideChapterRailTooltip();
      return;
    }
    const tooltip = $('#reader-chapter-tooltip');
    const title = String(button.dataset.readerSectionTitle || '').trim();
    if (!tooltip || !title) return;
    if (chapterRailTooltipOwner !== button) chapterRailTooltipOwner?.removeAttribute('aria-describedby');
    chapterRailTooltipOwner = button;
    tooltip.textContent = title;
    tooltip.hidden = false;
    button.setAttribute('aria-describedby', tooltip.id);
    positionChapterRailTooltip();
    window.requestAnimationFrame(positionChapterRailTooltip);
  }

  function setChapterRailOpen(open, { restoreFocus = false } = {}) {
    const rail = $('#reader-chapter-rail');
    const toggle = $('#reader-chapter-rail-toggle');
    const expanded = Boolean(open && assistantOverlayQuery.matches && rail && !rail.hidden);
    hideChapterRailTooltip();
    rail?.classList.toggle('is-open', expanded);
    toggle?.setAttribute('aria-expanded', String(expanded));
    if (!expanded && restoreFocus && assistantOverlayQuery.matches && toggle) toggle.focus({ preventScroll: true });
  }

  function cancelReadingLocationRestore(mount = readerMount) {
    if (!mount) return;
    mount.userInteracted = true;
    mount.restorePending = false;
  }

  function markReaderUserInteraction(mount, event) {
    if (!readerMountMatches(mount)) return;
    if (event?.type === 'keydown' && !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Spacebar'].includes(event.key)) return;
    cancelReadingLocationRestore(mount);
  }

  function updateActiveReaderSection(mount = readerMount) {
    const doc = frameDocument();
    if (!readerMountMatches(mount, doc) || !readerSections.length) return -1;
    const view = doc.defaultView;
    const threshold = Math.min(96, Math.max(48, (view?.innerHeight || 0) * 0.12));
    let activeIndex = 0;
    readerSections.forEach((section, index) => {
      if (section.node.getBoundingClientRect().top <= threshold) activeIndex = index;
    });
    if (mount.activeSectionIndex === activeIndex) return activeIndex;
    mount.activeSectionIndex = activeIndex;
    $$('[data-reader-section-index]').forEach((button) => {
      const active = Number(button.dataset.readerSectionIndex) === activeIndex;
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'location');
      else button.removeAttribute('aria-current');
    });
    return activeIndex;
  }

  function scheduleReaderViewportUpdate(mount = readerMount) {
    const doc = frameDocument();
    if (!readerMountMatches(mount, doc) || mount.viewportRAF) return;
    mount.viewportRAF = doc.defaultView.requestAnimationFrame(() => {
      mount.viewportRAF = 0;
      if (!readerMountMatches(mount, doc)) return;
      updateReaderProgress(doc);
      updateActiveReaderSection(mount);
      if (!mount.restorePending) scheduleReadingLocationSave(mount);
    });
  }

  function readerSectionTarget(index) {
    return Number.isInteger(index) && index >= 0 && index < readerSections.length ? readerSections[index] : null;
  }

  function scrollToReaderSection(index, { focusButton = null } = {}) {
    const section = readerSectionTarget(index);
    const mount = readerMount;
    if (!section || !readerMountMatches(mount)) return;
    cancelReadingLocationRestore(mount);
    section.node.scrollIntoView({ behavior: reducedMotionQuery.matches ? 'auto' : 'smooth', block: 'start' });
    mount.activeSectionIndex = -1;
    updateActiveReaderSection(mount);
    window.clearTimeout(mount.saveTimer);
    mount.saveTimer = window.setTimeout(() => {
      mount.saveTimer = null;
      if (readerMountMatches(mount)) captureCurrentReadingLocation({ mount });
    }, reducedMotionQuery.matches ? 0 : 420);
    if (assistantOverlayQuery.matches) setChapterRailOpen(false);
    focusButton?.focus?.({ preventScroll: true });
  }

  function bindReaderSectionButtons(container, { rail = false } = {}) {
    const buttons = [...container.querySelectorAll('[data-reader-section-index]')];
    buttons.forEach((button) => button.addEventListener('click', () => {
      if (rail) hideChapterRailTooltip(button);
      scrollToReaderSection(Number(button.dataset.readerSectionIndex));
    }));
    if (!rail) return;
    buttons.forEach((button, index) => {
      button.tabIndex = index === 0 ? 0 : -1;
      button.addEventListener('mouseenter', () => showChapterRailTooltip(button));
      button.addEventListener('mouseleave', () => hideChapterRailTooltip(button));
      button.addEventListener('focus', () => showChapterRailTooltip(button));
      button.addEventListener('blur', () => hideChapterRailTooltip(button));
      button.addEventListener('keydown', (event) => {
        let targetIndex = null;
        if (event.key === 'ArrowUp') targetIndex = (index - 1 + buttons.length) % buttons.length;
        else if (event.key === 'ArrowDown') targetIndex = (index + 1) % buttons.length;
        else if (event.key === 'Home') targetIndex = 0;
        else if (event.key === 'End') targetIndex = buttons.length - 1;
        else if (['Enter', ' '].includes(event.key)) {
          event.preventDefault();
          scrollToReaderSection(index, { focusButton: button });
          return;
        } else if (event.key === 'Escape') {
          event.preventDefault();
          if (assistantOverlayQuery.matches) setChapterRailOpen(false, { restoreFocus: true });
          else hideChapterRailTooltip(button);
          return;
        }
        if (targetIndex === null) return;
        event.preventDefault();
        buttons.forEach((candidate, candidateIndex) => { candidate.tabIndex = candidateIndex === targetIndex ? 0 : -1; });
        buttons[targetIndex].focus({ preventScroll: true });
      });
    });
  }

  function inferReaderSectionLevel(title, tagLevel) {
    const value = String(title || '').replace(/\s+/gu, ' ').trim();
    const numbered = value.match(/^(\d+(?:\.\d+)*|[A-Z](?:\.\d+)*|[IVX]+)(?:[.)])?\s+/iu);
    if (numbered) return Math.min(6, Math.max(1, numbered[1].split('.').length));
    if (/^(?:abstract|摘要|references?|bibliography|acknowledg(?:e)?ment|appendix(?:\s|$)|附录)/iu.test(value)) return 1;
    const parsed = Number(tagLevel);
    return Math.min(6, Math.max(1, Number.isFinite(parsed) ? parsed : 2));
  }

  function buildReaderIndexes() {
    const doc = frameDocument();
    if (!doc) return [];
    const seen = new Set();
    const documentState = readerDocumentState(doc);
    readerSections = documentState.sections || [...doc.querySelectorAll('h1, h2, h3, h4')].map((heading) => {
      const node = heading.matches('[data-block-id]') ? heading : heading.closest('[data-block-id]');
      const blockId = String(node?.dataset?.blockId || '');
      const title = String(heading.textContent || '').replace(/\s+/g, ' ').trim();
      const level = inferReaderSectionLevel(title, Number(heading.tagName.slice(1)));
      if (!node || heading.matches('h1.paper-title, [data-reader-toc-excluded]') || !readerBlockIdPattern.test(blockId) || seen.has(blockId) || !title || title.length > 180) return null;
      if (/^(?:keywords?|ccs concepts?)\b/iu.test(title)) return null;
      seen.add(blockId);
      return { blockId, level, title, node };
    }).filter(Boolean);
    documentState.sections = readerSections;
    if (readerMountMatches(readerMount, doc)) readerMount.activeSectionIndex = -1;
    const outline = $('#outline-list');
    const rail = $('#reader-chapter-rail');
    const railList = $('#reader-chapter-list');
    if (outline) {
      outline.innerHTML = readerSections.length ? readerSections.map((section, index) => {
        const level = Math.min(6, Math.max(1, Number(section.level) || 1));
        const indent = Math.min(4, level - 1) * 9;
        return `<button class="outline-item" type="button" data-reader-section-index="${index}" data-outline-level="${level}" style="--outline-indent:${indent}px"><small>${level}</small><span>${escapeHTML(section.title.slice(0, 100))}</span></button>`;
      }).join('') : '<div class="chat-empty">没有检测到章节标题。</div>';
      bindReaderSectionButtons(outline);
    }
    if (rail && railList) {
      hideChapterRailTooltip();
      rail.hidden = !readerSections.length;
      railList.dataset.sectionCount = String(readerSections.length);
      railList.innerHTML = readerSections.map((section, index) => {
        const level = Math.min(6, Math.max(1, Number(section.level) || 1));
        const indent = Math.min(3, level - 1) * 8;
        const railIndent = Math.min(3, level - 1) * 3;
        const barWidth = [23, 18, 14, 11, 8, 6][level - 1] || 6;
        return `<div class="reader-chapter-list-item" role="listitem"><button class="reader-chapter-item" type="button" data-reader-section-index="${index}" data-reader-section-level="${level}" data-reader-section-title="${escapeHTML(section.title)}" aria-label="跳转到章节：${escapeHTML(section.title)}" style="--reader-section-indent:${indent}px;--reader-section-rail-indent:${railIndent}px;--reader-section-bar-width:${barWidth}px"><span class="reader-chapter-dot" aria-hidden="true"></span><span class="reader-chapter-title">${escapeHTML(section.title)}</span></button></div>`;
      }).join('');
      bindReaderSectionButtons(railList, { rail: true });
      if (!readerSections.length) setChapterRailOpen(false);
    }
    updateActiveReaderSection(readerMount);
    return readerSections;
  }

  $('#reader-chapter-rail-toggle')?.addEventListener('click', () => setChapterRailOpen(!$('#reader-chapter-rail')?.classList.contains('is-open')));
  assistantOverlayQuery.addEventListener('change', () => setChapterRailOpen(false));
  window.addEventListener('resize', () => {
    if (assistantOverlayQuery.matches) hideChapterRailTooltip();
    else positionChapterRailTooltip();
  }, { passive: true });
  document.addEventListener('pointerdown', (event) => {
    if (assistantOverlayQuery.matches && $('#reader-chapter-rail')?.classList.contains('is-open') && !event.target.closest('#reader-chapter-rail')) setChapterRailOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !$('#reader-chapter-rail')?.classList.contains('is-open')) return;
    event.preventDefault();
    setChapterRailOpen(false, { restoreFocus: true });
  });

  function readerFrames(doc, count = 2) {
    return new Promise((resolve) => {
      const next = (remaining) => {
        if (remaining <= 0) resolve();
        else doc.defaultView.requestAnimationFrame(() => next(remaining - 1));
      };
      next(count);
    });
  }

  function restoreReadingLocation(mount) {
    const doc = frameDocument();
    if (!readerMountMatches(mount, doc) || mount.userInteracted) return false;
    const location = mount.restoreLocation;
    const metrics = readerScrollMetrics(doc);
    if (!location || !metrics) {
      updateReaderProgress(doc);
      updateActiveReaderSection(mount);
      return false;
    }
    const blocks = [...doc.querySelectorAll('[data-block-id]')].filter((block) => block.getClientRects().length > 0);
    const savedBlock = readerBlockById(location.blockId, doc)
      || (location.blockId.startsWith('translation-') ? readerBlockById(location.blockId.slice('translation-'.length), doc) : null);
    let target = readerVisibleTarget(savedBlock, doc);
    const exactBlock = Boolean(target);
    if (!target) target = blocks.find((block) => Number(block.dataset.page || block.closest('[data-page]')?.dataset?.page) === location.page) || null;
    let top;
    if (target) {
      const rect = target.getBoundingClientRect();
      const height = Math.max(1, Number(rect.height) || 1);
      const geometryChanged = mount.generation !== location.generation
        || Math.abs(height - location.blockHeight) > Math.max(12, location.blockHeight * 0.1);
      const offset = exactBlock ? Math.min(height, Math.max(0, geometryChanged ? location.offsetRatio * height : location.offsetPx)) : 0;
      top = metrics.scrollTop + rect.top + offset;
    } else {
      top = location.progress * metrics.maximum;
    }
    mount.restoring = true;
    // 'auto' inherits the paper's smooth-scroll CSS, exposing the trip from the top.
    metrics.view.scrollTo({ top: Math.max(0, top), left: 0, behavior: 'instant' });
    metrics.view.requestAnimationFrame(() => {
      if (!readerMountMatches(mount, doc)) return;
      mount.restoring = false;
      updateReaderProgress(doc);
      updateActiveReaderSection(mount);
    });
    return true;
  }

  async function restoreReadingLocationAfterLoad(mount, activation = mount.activation) {
    const doc = frameDocument();
    const current = () => readerMountMatches(mount, doc) && mount.activation === activation;
    if (!current()) return false;
    // Cached paragraphs and saved figure widths change the anchor's position.
    // Settle those before the first visible frame, independently of notes/AI.
    await mount.layoutReady;
    if (!current()) return false;
    if (doc.fonts?.ready) {
      await new Promise((resolve) => {
        const finish = () => {
          window.clearTimeout(timer);
          if (mount.cancelFontWait === finish) mount.cancelFontWait = null;
          resolve();
        };
        const timer = window.setTimeout(finish, 600);
        mount.cancelFontWait = finish;
        doc.fonts.ready.then(finish, finish);
      });
    }
    if (!current()) return false;
    await readerFrames(doc, 2);
    if (!current()) return false;
    restoreReadingLocation(mount);
    await readerFrames(doc, 1);
    if (!current()) return false;
    mount.restorePending = false;
    scheduleReadingLocationSave(mount);
    return true;
  }

  function renderCachedTranslations({ reconcile = true } = {}) {
    const doc = frameDocument();
    if (!doc || !state.translationCache.length) return;
    let inserted = 0;
    for (const record of translationsForActiveProfile(state.translationCache)) {
      const blockId = record?.block_id;
      const translated = String(record?.text || '').trim();
      if (!blockId || !translated) continue;
      if (doc.querySelector(`.my-scholar-translation[data-for="${cssEscape(blockId)}"]`)) continue;
      const block = translationTarget(blockId);
      if (!block || !translatableParagraph(block)) continue;
      const source = paragraphSource(block);
      if (!translationSourceMatches(record, source, true)) continue;
      if (block.dataset.continuationPages && !record.source_hash && String(record.source_text || '') !== source.text) continue;
      const role = block.matches('h1.paper-title, h1[data-translate-block-id]') ? 'title' : '';
      const tokenPayload = protectSpecialTokens(source.text);
      const formulas = source.formulas;
      const repaired = repairFormulaTokens(translated, formulas);
      const node = insertTranslation(blockId, restoreSpecialTokens(restoreInlineMarkers(restoreInlineMath(repaired, formulas), source.markers), tokenPayload.tokens), {
        cached: true,
        sourceHash: translationSourceHash(source),
        role,
        formulas,
        markers: source.markers,
        emphasis: source.emphasis,
        segments: (record.segments || []).map((item) => ({ ...item, text: restoreSpecialTokens(restoreInlineMarkers(restoreInlineMath(item.text, formulas), source.markers), tokenPayload.tokens) })),
        record,
        batch: true,
      });
      if (node) { inserted += 1; rememberDisplayedTranslation(state.activeJob?.job_id, record); }
    }
    // One rebuild after the whole replay instead of one per inserted node.
    if (inserted) {
      if (reconcile) {
        if (state.annotations.length) renderFrameAnnotations();
      }
      refreshReaderSearch();
      applyTranslationVisibility(doc);
    }
  }

  async function loadTranslationCache(jobId, mount = readerMounts.get(jobId)) {
    const before = [...translationCacheFor(jobId)];
    try {
      const payload = await api(`/api/jobs/${jobId}/translations?scope=all`);
      if (!readerMountIsCurrent(mount)) return;
      // In-flight translations can finish after this GET started.
      const added = translationCacheFor(jobId).filter((record) => !before.includes(record));
      const records = Array.isArray(payload.translations) ? [...payload.translations] : [];
      for (const record of added) {
        const index = records.findIndex((item) => item.block_id === record.block_id && item.source_hash === record.source_hash
          && item.target_language === record.target_language && item.profile_id === record.profile_id);
        if (index < 0) records.push(record); else records[index] = record;
      }
      return setTranslationCacheFor(jobId, records);
    } catch (_) { return readerMountIsCurrent(mount) ? translationCacheFor(jobId) : []; }
  }

  function libraryEntry(jobId) {
    return libraryItemEntries().find((entry) => entry.jobId === jobId);
  }

  async function markReadingStarted(jobId) {
    const entry = libraryEntry(jobId);
    if (!entry || entry.item?.deleted_at || !PRE_READING_STATUSES.has(String(itemValues(entry).reading_status || '未开始'))) return;
    try {
      const payload = await api(`/api/library/items/${jobId}`, jsonOptions({ values: { reading_status: '阅读中' } }, 'PATCH'));
      if (payload.library) { state.library = payload.library; renderLibrary(); renderViews(); }
    } catch (_) {
      // Reading must remain usable if metadata persistence is temporarily unavailable.
    }
  }

  function isAbstractHeading(heading) {
    return /^(?:abstract|摘\s*要)\s*(?:[:：.—-])?$/iu.test(heading?.textContent?.trim() || '');
  }

  const inlineAbstractLabelPattern = /^\s*(?:abstract|摘\s*要)\s*(?:[:：.—-]+)\s*/iu;
  const inlineKeywordsLabelPattern = /^\s*(?:index\s+terms?|key\s*words?|keywords?|关\s*键\s*词)\s*(?:[:：.—-]+)\s*/iu;

  function hasInlineSectionLabel(block, pattern) {
    return Boolean(block?.matches?.('p') && pattern.test(block.textContent || ''));
  }

  function decorateInlineSectionLabel(container, pattern, className) {
    if (!container || container.querySelector(`.${className.split(' ')[0]}`)) return;
    const view = container.ownerDocument?.defaultView;
    if (!view) return;
    const walker = container.ownerDocument.createTreeWalker(container, view.NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && !node.data.trim()) node = walker.nextNode();
    if (!node) return;
    const match = node.data.match(pattern);
    if (!match) return;
    const leading = match[0].match(/^\s*/u)?.[0] || '';
    const label = container.ownerDocument.createElement('strong');
    label.className = className;
    label.textContent = match[0].slice(leading.length);
    node.data = node.data.slice(match[0].length);
    node.parentNode.insertBefore(label, node);
    if (leading) node.parentNode.insertBefore(container.ownerDocument.createTextNode(leading), label);
  }

  function markAbstractSection(doc = frameDocument()) {
    const root = doc?.querySelector('.reader-content');
    if (!root) return;
    const blocks = [...root.querySelectorAll('h1, h2, h3, h4, h5, h6, p, .my-scholar-translation')];
    let abstractIndex = blocks.findIndex((block) => block.matches('h1, h2, h3, h4, h5, h6') && isAbstractHeading(block));
    const inlineAbstract = abstractIndex < 0
      ? blocks.findIndex((block) => hasInlineSectionLabel(block, inlineAbstractLabelPattern))
      : -1;
    if (abstractIndex < 0) abstractIndex = inlineAbstract;
    if (abstractIndex < 0) return;
    const abstractBlock = blocks[abstractIndex];
    const firstPage = abstractBlock.closest('.pdf-page');
    if (firstPage?.dataset.page === '1') {
      [...firstPage.querySelectorAll('p')].forEach((block) => {
        if (!(block.compareDocumentPosition(abstractBlock) & Node.DOCUMENT_POSITION_FOLLOWING)) return;
        block.classList.add('paper-metadata');
        block.dataset.translationExcluded = 'metadata';
      });
    }
    if (inlineAbstract >= 0) {
      abstractBlock.classList.add('paper-abstract-body');
      decorateInlineSectionLabel(abstractBlock, inlineAbstractLabelPattern, 'paper-section-label paper-abstract-label');
    } else {
      abstractBlock.classList.add('paper-abstract-heading');
    }
    for (const block of blocks.slice(abstractIndex + 1)) {
      if (block.matches('h1, h2, h3, h4, h5, h6')) break;
      if (hasInlineSectionLabel(block, inlineKeywordsLabelPattern)) {
        block.classList.add('paper-keywords');
        decorateInlineSectionLabel(block, inlineKeywordsLabelPattern, 'paper-section-label paper-keywords-label');
        break;
      }
      if (block.matches('p:not(.paper-metadata)')) block.classList.add('paper-abstract-body');
      if (block.matches('.my-scholar-translation')) block.classList.add('paper-abstract-translation');
    }
  }

  function hydrateFrameMath(doc) {
    if (!doc?.querySelector('[data-tex]')) return;
    const renderAll = () => {
      const katex = doc.defaultView?.katex;
      if (!katex) return;
      doc.querySelectorAll('[data-tex]').forEach((node) => {
        const tex = node.getAttribute('data-tex') || '';
        if (!tex.trim()) return;
        const original = node.innerHTML;
        try {
          katex.render(tex, node, {
            throwOnError: true,
            strict: false,
            displayMode: node.classList.contains('math-display'),
          });
        } catch (_) {
          // Keep the build-time MathML (or visible TeX fallback) untouched.
          node.innerHTML = original;
        }
      });
      if (readerDocumentStates.has(doc)) {
        scheduleInterlinearTranslations(doc);
      }
    };
    if (doc.defaultView?.katex) {
      renderAll();
      return;
    }
    if (!doc.querySelector('#my-scholar-katex-style')) {
      const link = doc.createElement('link');
      link.id = 'my-scholar-katex-style';
      link.rel = 'stylesheet';
      link.href = '/web/vendor/katex/katex.min.css';
      doc.head.append(link);
    }
    let script = doc.querySelector('#my-scholar-katex-script');
    if (!script) {
      script = doc.createElement('script');
      script.id = 'my-scholar-katex-script';
      script.src = '/web/vendor/katex/katex.min.js';
      script.addEventListener('load', () => {
        script.dataset.loaded = '1';
        renderAll();
      });
      doc.head.append(script);
      return;
    }
    if (script.dataset.loaded) renderAll();
    else script.addEventListener('load', renderAll, { once: true });
  }

  const translationVisibilityStyleId = 'my-scholar-translation-visibility';

  function normalizedTranslationPreferences(value) {
    return {
      displayMode: ['original', 'bilingual', 'translation'].includes(value?.displayMode) ? value.displayMode : 'bilingual',
    };
  }

  function setTranslationPreferences(values) {
    state.translationPreferences = normalizedTranslationPreferences({ ...state.translationPreferences, ...values });
    persistentStateSet(translationPreferencesStorageKey, JSON.stringify(state.translationPreferences));
    readerMounts.forEach((mount) => applyTranslationVisibility(mount.frame.contentDocument));
    applyTranslationVisibility();
    syncTranslationVisibilityButton();
    refreshReaderSearch();
  }

  function translationStatusAction(blockId, doc, label, refresh = false) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'translation-status-action';
    button.textContent = label;
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (doc === frameDocument()) void translateBlock(blockId, null, { doc, refresh });
    });
    return button;
  }

  function syncTranslationBlockVisibility(block, node) {
    if (!block) return;
    block.classList.toggle('has-paragraph-translation', Boolean(block.nextElementSibling?.classList.contains('my-scholar-translation')));
    const preserve = !block.matches('figcaption') && Boolean(block.closest('.pdf-equation, .equation, .display-math, .pdf-table, table'));
    block.classList.toggle('my-scholar-translation-original', !preserve);
    if (preserve) return;
    const doc = block.ownerDocument;
    const blockId = block.dataset.translateBlockId || block.dataset.blockId;
    const placeholder = doc.querySelector(`[data-translation-placeholder-for="${cssEscape(blockId)}"]`);
    if (node || state.translationPreferences.displayMode !== 'translation') placeholder?.remove();
    else if (!placeholder) {
      const status = doc.createElement('div');
      status.className = 'my-scholar-translation-placeholder';
      status.dataset.translationPlaceholderFor = blockId;
      status.dataset.blockId = `translation-${blockId}`;
      status.dataset.page = block.dataset.page || block.closest('[data-page]')?.dataset.page || '';
      const label = doc.createElement('span');
      label.textContent = '待翻译';
      status.append(label, translationStatusAction(blockId, doc, '翻译本段'));
      block.insertAdjacentElement('afterend', status);
    }
    if (node?.classList.contains('is-error') && !node.querySelector('.translation-status-action')) {
      node.append(translationStatusAction(blockId, doc, '重试', true));
    }
  }

  function applyTranslationVisibility(doc = frameDocument()) {
    if (!doc?.head) return;
    let style = doc.getElementById(translationVisibilityStyleId);
    if (!style) {
      style = doc.createElement('style');
      style.id = translationVisibilityStyleId;
      style.textContent = `
        :root[data-translation-display="original"] .my-scholar-translation { display:none!important; }
        :root[data-translation-display="translation"] .my-scholar-translation-original:not(.reader-sentence-pairs) { display:none!important; }
        :root[data-translation-display="translation"] .reader-source-sentence { display:none!important; }
        :root[data-translation-display="original"] .reader-source-sentence { display:inline!important; }
        .reader-content .reader-source-sentence { display:inline; }
        .reader-content .reader-sentence-pairs .reader-sentence-translation {
          display:inline; margin:0 .65em 0 0!important; padding:0!important; border:0!important;
          font-size:80%!important; font-weight:400; line-height:1.3!important; color:var(--reader-ui-muted,#625c56);
          background:transparent!important; text-indent:0!important;
        }
        .reader-content .reader-interlinear-container {
          position:relative; line-height:var(--reader-interlinear-line-height,1.4)!important;
          padding-bottom:var(--reader-interlinear-bottom,0px)!important;
        }
        .reader-content .reader-interlinear-container > .reader-sentence-translation {
          display:block; position:absolute; inset:0; margin:0!important; text-indent:0!important; pointer-events:none;
        }
        .reader-interlinear-container > .reader-sentence-translation > .translation-text { display:contents; }
        .reader-translation-line { display:block; position:absolute; top:0; left:0; right:0; text-indent:0; white-space:normal; overflow-wrap:anywhere; pointer-events:none; }
        .reader-translation-run { pointer-events:auto; }
        .reader-interlinear-gap { display:inline-block; width:0; vertical-align:top; padding:0; margin:0; border:0; user-select:none!important; -webkit-user-select:none!important; }
        :root[data-reader-selection-surface="paper"] .reader-content .my-scholar-translation,
        :root[data-reader-selection-surface="paper"] .reader-content .my-scholar-translation *,
        :root[data-reader-selection-surface="translation"] .reader-content,
        :root[data-reader-selection-surface="translation"] .reader-content * { user-select:none!important; -webkit-user-select:none!important; }
        :root[data-reader-selection-surface="translation"] .reader-content .my-scholar-translation,
        :root[data-reader-selection-surface="translation"] .reader-content .my-scholar-translation * { user-select:text!important; -webkit-user-select:text!important; }
        :root[data-reader-selection-surface] .reader-content :is(input,textarea,[contenteditable="true"]),
        :root[data-reader-selection-surface] .reader-content [contenteditable="true"] * { user-select:text!important; -webkit-user-select:text!important; }
        *::selection { background:transparent; }
        .reader-content :is(input,textarea,[contenteditable="true"])::selection,
        .reader-content [contenteditable="true"] *::selection { background:Highlight; color:HighlightText; }
        #reader-text-selection-overlay { position:fixed; inset:0; width:100%; height:100%; overflow:hidden; pointer-events:none; user-select:none; z-index:2147483000; }
        #reader-text-selection-overlay path { fill:Highlight; fill-opacity:.4; }
        .reader-interlinear-container .annotation-note-trigger { pointer-events:auto; }
        .reader-content .reader-sentence-translation .translation-text { font-size:inherit!important; line-height:inherit!important; }
        .translation-source-label { display:block; font:10px/1.4 system-ui,sans-serif; opacity:.75; margin-top:2px; user-select:none; }
        .reader-sentence-translation .translation-source-label { display:inline-block; margin:0 0 0 8px; }
        .reader-interlinear-container .translation-source-label { display:none; }
        .translation-retained-status { display:block; color:var(--reader-ui-muted,#756b60); font:12px/1.5 system-ui,sans-serif; margin:4px 0; user-select:none; }
        :root:not([data-translation-display="translation"]) .my-scholar-translation-placeholder { display:none!important; }
        .my-scholar-translation-placeholder { display:flex; align-items:center; gap:12px; margin:.6em 0; padding:8px 0; color:var(--muted,#756b60); font:13px/1.6 system-ui,sans-serif; }
        .translation-status-action { padding:3px 9px; border:1px solid var(--line,#d5d9df); border-radius:5px; background:var(--paper,#fff); color:var(--accent,#b45309); font:12px/1.5 system-ui,sans-serif; cursor:pointer; }
        .my-scholar-translation.is-error .translation-status-action { margin-top:6px; }
      `;
      doc.head.append(style);
    }
    doc.documentElement.dataset.translationDisplay = state.translationPreferences.displayMode;
    scheduleInterlinearTranslations(doc);
    if (state.translationPreferences.displayMode !== 'translation') {
      doc.querySelectorAll('.my-scholar-translation-placeholder').forEach((node) => node.remove());
      return;
    }
    for (const block of translatableBlocks(doc, 'all')) {
      const blockId = block.dataset.translateBlockId || block.dataset.blockId;
      const node = doc.querySelector(`.my-scholar-translation[data-for="${cssEscape(blockId)}"]`);
      syncTranslationBlockVisibility(block, node);
    }
  }

  function syncTranslationVisibilityButton() {
    $$('#translation-scope-menu [data-translation-display]').forEach((item) => {
      item.setAttribute('aria-checked', String(item.dataset.translationDisplay === state.translationPreferences.displayMode));
    });
  }

  function scheduleReaderIdle(fn) {
    if (window.requestIdleCallback) window.requestIdleCallback(fn, { timeout: 1500 });
    else window.setTimeout(fn, 60);
  }

  const readerContinuations = new WeakMap();

  function readerBlockById(blockId, doc = frameDocument()) {
    return doc?.querySelector(`[data-block-id="${cssEscape(blockId || '')}"]`)
      || readerContinuations.get(doc)?.get(String(blockId))?.root || null;
  }

  function joinReaderContinuations(doc) {
    if (readerContinuations.has(doc)) return;
    const aliases = new Map();
    readerContinuations.set(doc, aliases);
    const pages = [...doc.querySelectorAll('.reader-content > .pdf-page')];
    let referenceDepth = 0;
    const blocks = pages.flatMap((page) => {
      const blocks = [...page.children].filter((node) => !node.matches('.page-number, .page-label, [data-render-mode="suppressed-margin"]'));
      return blocks.map((node) => {
        const text = canonicalBlockText(node, doc);
        const headingDepth = /^H[1-6]$/u.test(node.tagName) ? Number(node.tagName.slice(1)) : 0;
        if (headingDepth) {
          if (/^(?:references|bibliography|参考文献)\s*$/iu.test(text.trim())) referenceDepth = headingDepth;
          else if (referenceDepth && headingDepth <= referenceDepth) referenceDepth = 0;
        }
        let bbox = null;
        try { bbox = JSON.parse(node.dataset.bbox || 'null'); } catch (_) {}
        return { node, page: Number(node.dataset.page || page.dataset.page), bbox, text, tag: node.tagName.toLowerCase(),
          media: !referenceDepth && node.matches('figure.pdf-figure:not([data-reader-toc-excluded]):not([data-translation-excluded])') && Boolean(node.querySelector('img')),
          excluded: Boolean(referenceDepth || !node.dataset.blockId || node.matches('.footnote, .paper-metadata, [data-reader-toc-excluded], [data-translation-excluded]')) };
      });
    });
    let previous = null;
    let media = [];
    for (const next of blocks) {
      if (next.media) {
        media.push(next);
        continue;
      }
      const joins = previous && window.GuziParagraphContinuation.canJoin(previous, next, { media });
      media = [];
      if (!joins) { previous = next; continue; }
      const root = aliases.get(previous.node.dataset.blockId)?.root || previous.node;
      if (!aliases.has(root.dataset.blockId)) {
        const segment = doc.createElement('span');
        segment.dataset.continuationBlockId = root.dataset.blockId;
        segment.dataset.page = root.dataset.page;
        segment.append(...root.childNodes);
        root.append(segment);
        aliases.set(root.dataset.blockId, { root, page: String(previous.page), start: 0, end: previous.text.length });
      }
      const before = canonicalBlockText(root, doc);
      const separator = /[\s\-\u00ad]$/u.test(before) || /^\s/u.test(next.text) ? '' : ' ';
      const start = before.length + separator.length;
      const segment = doc.createElement('span');
      segment.dataset.continuationBlockId = next.node.dataset.blockId;
      segment.dataset.page = String(next.page);
      segment.append(...next.node.childNodes);
      root.append(doc.createTextNode(separator), segment);
      aliases.set(next.node.dataset.blockId, { root, page: String(next.page), start, end: start + next.text.length });
      root.dataset.continuationPages = [...new Set([...aliases.values()].filter((source) => source.root === root).map((source) => source.page))].join(',');
      next.node.remove();
      previous = next;
    }
  }

  function wireFrame(mount = readerMount) {
    const doc = frameDocument(); if (!readerMountMatches(mount, doc)) return;
    readerDocumentStates.delete(doc);
    doc.documentElement.classList.add('my-scholar-reader-restoring');
    joinReaderContinuations(doc);
    doc.body.classList.add('reader-embedded');
    const mathRules = document.getElementById('reader-math-style')?.sheet?.cssRules;
    if (mathRules && !doc.getElementById('my-scholar-math-style')) {
      // Exported readers allow inline styles but intentionally block assets.
      const mathStyle = doc.createElement('style');
      mathStyle.id = 'my-scholar-math-style';
      mathStyle.textContent = Array.from(mathRules, (rule) => rule.cssText).join('\n');
      doc.head.append(mathStyle);
    }
    let runtimeStyle = doc.querySelector('#my-scholar-annotation-runtime-style');
    if (!runtimeStyle) {
      runtimeStyle = doc.createElement('style');
      runtimeStyle.id = 'my-scholar-annotation-runtime-style';
      runtimeStyle.textContent = `
        body.reader-embedded {
          --reader-ui-paper:#fff;
          --reader-ui-ink:#191919;
          --reader-ui-muted:#756b60;
          background:var(--paper,var(--reader-ui-paper));
        }
        /* Some saved documents define the theme variables without applying them to text. */
        body.reader-embedded,
        body.reader-embedded .reader-content,
        body.reader-embedded .reader-content :is(h1,h2,h3,h4,h5,h6) {
          color:var(--ink,var(--reader-ui-ink));
        }
        body.reader-embedded .my-scholar-highlight { color:inherit; }
        @media (prefers-color-scheme:dark) {
          body.reader-embedded { --reader-ui-paper:#1e2124; --reader-ui-ink:#dcdcde; --reader-ui-muted:#b6afa6; }
          body.reader-embedded .reader-content img.math-source-inline { filter:invert(.86); }
          /* Older reader styles force their original link color. */
          body.reader-embedded .reader-content a:is(.citation,.cross-reference,[href^="#ref-"]) {
            color:#b8c8d8!important;
            text-decoration-line:underline;
            text-decoration-color:currentColor;
            text-decoration-thickness:1px;
            text-underline-offset:.15em;
          }
          body.reader-embedded .reader-content a:is(.citation,.cross-reference,[href^="#ref-"]):is(:hover,:focus-visible) {
            color:#e2ebf3!important;
            text-decoration-thickness:2px;
          }
          body.reader-embedded .reader-content a:is(.citation,.cross-reference,[href^="#ref-"]):focus-visible {
            outline:2px solid currentColor;
            outline-offset:3px;
            border-radius:2px;
          }
        }
        .annotation-note-popover,.annotation-note-popover *,
        .paragraph-translate-trigger,.annotation-note-trigger,.reference-hover-card {
          box-sizing:border-box;
        }
        .annotation-note-popover,.paragraph-translate-trigger,.annotation-note-trigger {
          font-family:var(--ui-font,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);
        }
        .my-scholar-underline {
          background:transparent;
          color:inherit;
          text-decoration:underline 2px var(--highlight-orange,#f59e0b);
          text-underline-offset:3px;
        }
        /* Saved documents can contain fixed annotation colors with !important. */
        body.reader-embedded .my-scholar-underline[data-user-color="true"] {
          text-decoration-color:var(--user-highlight,#f59e0b)!important;
        }
        body.reader-embedded .my-scholar-highlight[data-user-color="true"] {
          background:color-mix(in srgb,var(--user-highlight,#f59e0b) 32%,transparent)!important;
          box-shadow:inset 0 -.09em 0 color-mix(in srgb,var(--user-highlight,#f59e0b) 62%,transparent)!important;
        }
        @media (prefers-color-scheme:dark) {
          body.reader-embedded .my-scholar-highlight[data-user-color="true"] {
            background:color-mix(in srgb,var(--user-highlight,#f59e0b) 42%,transparent)!important;
            box-shadow:inset 0 -.09em 0 color-mix(in srgb,var(--user-highlight,#f59e0b) 72%,transparent)!important;
          }
        }
        body.reader-embedded .reader-content .my-scholar-highlight[data-annotation-drawing="true"] {
          background:transparent!important;
          box-shadow:none!important;
        }
        body.reader-embedded .reader-content .my-scholar-underline[data-annotation-drawing="true"] {
          text-decoration-color:transparent!important;
        }
        .annotation-draw-layer {
          position:fixed;
          inset:0;
          z-index:3;
          pointer-events:none!important;
        }
        .annotation-draw-stroke {
          position:absolute;
          transform-origin:left center;
          border-radius:2px;
          pointer-events:none!important;
        }
        :is(p,ul,ol)[data-block-id] { position:relative; }
        .paragraph-translate-trigger {
          position:absolute;
          right:-34px;
          top:50%;
          transform:translateY(-50%);
          opacity:0;
          padding:3px 7px;
          border:1px solid var(--line,#e7ded2);
          border-radius:6px;
          background:var(--paper,var(--reader-ui-paper));
          color:var(--muted,var(--reader-ui-muted));
          font-size:11px;
          line-height:1.2;
          cursor:pointer;
          transition:opacity .15s ease,background .15s ease;
        }
        .paragraph-translate-trigger:hover,.paragraph-translate-trigger:focus-visible,
        :is(p,ul,ol)[data-block-id]:hover > .paragraph-translate-trigger {
          opacity:1;
          background:var(--soft,#fbf6ed);
        }
        @media (max-width:760px) {
          .paragraph-translate-trigger { right:0; top:-22px; transform:none; opacity:.7; }
        }
        ::highlight(${readerSearchHighlightName}) {
          background:color-mix(in srgb,var(--accent,#d97706) 12%,transparent);
          color:inherit;
        }
        ::highlight(${readerSearchCurrentHighlightName}) {
          background:color-mix(in srgb,var(--accent,#d97706) 24%,transparent);
          color:inherit;
        }
        mark.reader-search-match {
          border-radius:.16em;
          background:color-mix(in srgb,var(--accent,#d97706) 12%,transparent);
          color:inherit;
        }
        mark.reader-search-match.is-current {
          background:color-mix(in srgb,var(--accent,#d97706) 24%,transparent);
        }
        .annotation-note-editor[contenteditable="true"],
        .annotation-note-editor[contenteditable="true"] * {
          -webkit-user-select:text!important;
          user-select:text!important;
        }
        .annotation-note-editor[contenteditable="true"] {
          min-height:88px;
          max-height:240px;
          overflow:auto;
          resize:vertical;
          white-space:pre-wrap;
          overflow-wrap:anywhere;
          outline:none;
        }
        .annotation-note-editor[contenteditable="true"]:focus {
          border-color:transparent;
          box-shadow:none;
        }
        .annotation-note-editor.is-empty::before {
          content:attr(data-placeholder);
          color:var(--muted,var(--reader-ui-muted));
          pointer-events:none;
        }
        .annotation-note-editor > :first-child { margin-top:0; }
        .annotation-note-editor > :last-child { margin-bottom:0; }
        .annotation-color-palette {
          display:flex;
          align-items:center;
          gap:5px;
          margin:0 0 9px;
          padding:2px 1px;
        }
        .annotation-color-swatch {
          position:relative;
          width:20px;
          height:20px;
          flex:0 0 20px;
          padding:0;
          border:2px solid var(--paper,var(--reader-ui-paper));
          border-radius:50%;
          background:var(--swatch-color);
          box-shadow:0 0 0 1px color-mix(in srgb,var(--swatch-color) 70%,var(--line,#e7ded2));
          cursor:pointer;
        }
        .annotation-color-swatch:hover { transform:scale(1.08); }
        .annotation-color-swatch[aria-pressed="true"] {
          box-shadow:0 0 0 2px var(--paper,var(--reader-ui-paper)),0 0 0 4px var(--swatch-color);
        }
        .annotation-color-swatch[aria-pressed="true"]::after {
          content:'✓';
          position:absolute;
          inset:0;
          display:grid;
          place-items:center;
          color:#20252a;
          font-size:11px;
          font-weight:800;
          text-shadow:0 1px rgba(255,255,255,.72);
        }
        .my-scholar-ai-suggestion {
          --ai-suggestion-color:var(--highlight-method,#e39a22);
          padding:.03em .06em;
          border-radius:.14em;
          background:color-mix(in srgb,var(--ai-suggestion-color) 9%,transparent)!important;
          box-shadow:none!important;
          color:inherit;
          text-decoration-line:underline;
          text-decoration-style:dotted;
          text-decoration-thickness:1.5px;
          text-decoration-color:color-mix(in srgb,var(--ai-suggestion-color) 78%,currentColor);
          text-underline-offset:.18em;
          cursor:pointer;
        }
        .my-scholar-ai-suggestion::after {
          content:' ✦';
          color:var(--ai-suggestion-color);
          font-family:var(--ui-font);
          font-size:.62em;
          font-weight:760;
          vertical-align:super;
          user-select:none;
        }
        .my-scholar-ai-suggestion-research_goal { --ai-suggestion-color:var(--highlight-goal,#2f9d72); }
        .my-scholar-ai-suggestion-method { --ai-suggestion-color:var(--highlight-method,#e39a22); }
        .my-scholar-ai-suggestion-innovation { --ai-suggestion-color:var(--highlight-innovation,#8b6edb); }
        .my-scholar-ai-suggestion-conclusion { --ai-suggestion-color:var(--highlight-conclusion,#d15d79); }
        .my-scholar-ai-suggestion:focus-visible {
          outline:2px solid color-mix(in srgb,var(--ai-suggestion-color) 55%,transparent);
          outline-offset:2px;
        }
        .annotation-note-trigger {
          --annotation-color:var(--highlight-orange,#f59e0b);
          display:inline-flex;
          width:17px;
          height:17px;
          align-items:center;
          justify-content:center;
          margin:0 3px;
          border:1px solid;
          border-radius:50%;
          font-size:10px;
          line-height:1;
          vertical-align:2px;
          cursor:pointer;
          border-color:color-mix(in srgb,var(--annotation-color) 72%,var(--line,#e7ded2));
          background:color-mix(in srgb,var(--annotation-color) 16%,transparent);
          color:color-mix(in srgb,var(--annotation-color) 72%,var(--ink,var(--reader-ui-ink)));
        }
        .annotation-note-popover { --annotation-color:var(--highlight-orange,#f59e0b); }
        .annotation-note-popover {
          position:absolute;
          z-index:30;
          padding:11px 12px;
          border:1px solid var(--line,#e7ded2);
          border-radius:10px;
          background:var(--paper,var(--reader-ui-paper));
          box-shadow:0 12px 32px rgba(30,48,65,.2);
          color:var(--ink,var(--reader-ui-ink));
          overflow-wrap:anywhere;
          font-size:calc(var(--reader-content-font-size,17px) * .82);
          line-height:1.48;
          transform-origin:top center;
          animation:annotation-popover-in 160ms cubic-bezier(.22,1,.36,1) both;
        }
        .annotation-note-popover.is-closing {
          opacity:0;
          transform:translateY(-2px) scale(.985);
          pointer-events:none;
          animation:none;
          transition:opacity 150ms ease-in,transform 150ms ease-in;
        }
        @keyframes annotation-popover-in { from { opacity:0; transform:translateY(3px) scale(.985); } to { opacity:1; transform:none; } }
        .annotation-note-popover.ai-suggestion-popover { --annotation-color:var(--ai-suggestion-color,var(--highlight-orange)); }
        .ai-suggestion-label {
          display:inline-flex;
          align-items:center;
          gap:4px;
          margin-bottom:8px;
          padding:3px 7px;
          border:1px dashed color-mix(in srgb,var(--annotation-color) 64%,var(--line,#e7ded2));
          border-radius:99px;
          background:color-mix(in srgb,var(--annotation-color) 8%,var(--paper,var(--reader-ui-paper)));
          color:color-mix(in srgb,var(--annotation-color) 76%,var(--ink,var(--reader-ui-ink)));
          font-size:var(--reader-caption-font-size,12px);
          line-height:1.35;
          font-weight:700;
        }
        .ai-suggestion-reason {
          margin-top:8px;
          color:var(--muted,var(--reader-ui-muted));
          font-size:calc(var(--reader-content-font-size,17px) * .78);
          line-height:1.48;
        }
        .ai-suggestion-reason strong { color:var(--ink,var(--reader-ui-ink)); }
        .annotation-note-popover-head {
          display:flex;
          align-items:baseline;
          justify-content:space-between;
          gap:12px;
          margin-bottom:7px;
          color:color-mix(in srgb,var(--annotation-color) 72%,var(--ink,var(--reader-ui-ink)));
        }
        .annotation-note-popover-head strong {
          font-size:calc(var(--reader-content-font-size,17px) * .78);
          line-height:1.35;
        }
        .annotation-note-popover-head span {
          color:var(--muted,var(--reader-ui-muted));
          font-size:var(--reader-caption-font-size,12px);
          line-height:1.35;
        }
        .annotation-note-popover-quote {
          max-height:100px;
          overflow:auto;
          padding:7px 8px;
          border-left:3px solid var(--annotation-color);
          color:var(--ink,var(--reader-ui-ink));
          background:color-mix(in srgb,var(--annotation-color) 9%,var(--paper,var(--reader-ui-paper)));
          font-family:var(--reader-content-font-family,var(--paper-font,"Times New Roman",Times,serif));
          font-size:calc(var(--reader-content-font-size,17px) * .78);
          line-height:1.48;
        }
        .annotation-note-popover.is-editing .annotation-note-popover-quote { display:none; }
        .annotation-note-popover-body,.annotation-note-editor {
          font-family:var(--reader-content-font-family,var(--paper-font,"Times New Roman",Times,serif));
          font-size:calc(var(--reader-content-font-size,17px) * .82);
          line-height:1.48;
        }
        .annotation-note-popover-body { margin-top:8px; white-space:normal; }
        .annotation-note-popover-body p,.annotation-note-editor p { margin:.35em 0; }
        .annotation-note-popover-body ul,.annotation-note-popover-body ol,
        .annotation-note-editor ul,.annotation-note-editor ol { margin:.35em 0; padding-left:20px; }
        .annotation-note-popover-body blockquote,.annotation-note-editor blockquote {
          margin:.45em 0;
          padding-left:8px;
          border-left:3px solid var(--annotation-color);
          color:var(--muted,var(--reader-ui-muted));
        }
        .annotation-note-popover-body h1,.annotation-note-popover-body h2,.annotation-note-popover-body h3,
        .annotation-note-editor h1,.annotation-note-editor h2,.annotation-note-editor h3 {
          margin:.5em 0 .3em;
          font-family:inherit;
          font-size:1.12em;
          line-height:inherit;
        }
        .annotation-note-popover-body code,.annotation-note-editor code {
          padding:1px 3px;
          border-radius:3px;
          background:color-mix(in srgb,var(--annotation-color) 10%,var(--soft,#fbf6ed));
          font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
          font-size:.92em;
        }
        .annotation-note-popover-body a,.annotation-note-editor a { color:color-mix(in srgb,var(--annotation-color) 70%,var(--ink,var(--reader-ui-ink))); }
        .annotation-note-popover-body img,.annotation-note-editor img {
          display:block;
          max-width:100%;
          height:auto;
          margin:8px 0;
          border-radius:7px;
        }
        .annotation-note-editor-shell {
          overflow:hidden;
          border:1px solid var(--line,#e7ded2);
          border-radius:8px;
          background:var(--paper,var(--reader-ui-paper));
        }
        .annotation-note-editor-shell:focus-within {
          border-color:var(--annotation-color);
          box-shadow:0 0 0 3px color-mix(in srgb,var(--annotation-color) 18%,transparent);
        }
        .annotation-note-formatbar {
          display:flex;
          flex-wrap:wrap;
          gap:3px;
          padding:5px;
          border-bottom:1px solid var(--line,#e7ded2);
          background:color-mix(in srgb,var(--annotation-color) 6%,var(--soft,#fbf6ed));
        }
        .annotation-note-formatbar button {
          min-height:25px;
          padding:3px 6px;
          border:0;
          border-radius:5px;
          background:transparent;
          color:var(--ink,var(--reader-ui-ink));
          font:inherit;
          font-size:var(--reader-caption-font-size,12px);
          cursor:pointer;
        }
        .annotation-note-formatbar button:hover,.annotation-note-formatbar button:focus-visible {
          background:color-mix(in srgb,var(--annotation-color) 16%,var(--paper,var(--reader-ui-paper)));
          outline:none;
        }
        .annotation-note-editor[contenteditable="true"] {
          min-height:92px;
          max-height:230px;
          padding:8px 9px;
          border:0;
          border-radius:0;
          caret-color:var(--annotation-color);
        }
        .annotation-note-popover-actions { display:flex; flex-wrap:wrap; gap:5px; margin-top:10px; }
        .annotation-note-popover-actions button {
          padding:4px 7px;
          border:1px solid var(--line,#e7ded2);
          border-radius:6px;
          background:var(--paper,var(--reader-ui-paper));
          color:var(--ink,var(--reader-ui-ink));
          font:inherit;
          cursor:pointer;
          font-size:calc(var(--reader-caption-font-size,12px) * .96);
          line-height:1.25;
        }
        .annotation-note-popover-actions button:hover,
        .annotation-note-popover-actions button:focus-visible {
          border-color:var(--annotation-color);
          background:color-mix(in srgb,var(--annotation-color) 12%,var(--paper,var(--reader-ui-paper)));
        }
        .reference-hover-card {
          position:fixed;
          z-index:40;
          max-height:min(220px,42vh);
          overflow:auto;
          padding:9px 11px;
          border:1px solid var(--line,#e7ded2);
          border-radius:9px;
          background:color-mix(in srgb,var(--paper,var(--reader-ui-paper)) 94%,transparent);
          backdrop-filter:blur(20px) saturate(160%);
          box-shadow:0 10px 30px rgba(30,48,65,.18);
          color:var(--ink,var(--reader-ui-ink));
          font-family:var(--paper-font);
          font-size:calc(var(--reader-content-font-size,17px) * .78);
          line-height:1.5;
          pointer-events:none;
          user-select:none;
          animation:reference-preview-in 150ms cubic-bezier(.22,1,.36,1) both;
        }
        .reference-hover-card.is-closing { opacity:0; transform:translateY(2px) scale(.99); animation:none; transition:opacity 130ms ease-in,transform 130ms ease-in; }
        @keyframes reference-preview-in { from { opacity:0; transform:translateY(3px) scale(.985); } to { opacity:1; transform:none; } }
        .reader-content .pdf-figure,
        .reader-content .pdf-table {
          background:transparent!important;
        }
        .reader-content .my-scholar-media-resizable {
          --my-scholar-media-width:100%;
          --my-scholar-media-scale:1;
          position:relative!important;
          box-sizing:border-box;
          width:calc(min(var(--my-scholar-media-preferred-width,100%),100%) * var(--my-scholar-media-scale))!important;
          max-width:100%!important;
          margin-left:auto!important;
          margin-right:auto!important;
          transition:width 140ms ease;
        }
        html.my-scholar-reader-restoring .my-scholar-media-resizable { transition:none; }
        .reader-content .my-scholar-media-visual {
          min-width:0;
        }
        .reader-content .my-scholar-media-resizable .my-scholar-media-primary-image {
          display:block!important;
          width:100%!important;
          max-width:100%!important;
          height:auto!important;
          margin-left:auto!important;
          margin-right:auto!important;
        }
        .reader-content .my-scholar-media-resizable :is(.table-source-primary,a.asset-link) {
          display:block;
          width:100%;
        }
        .reader-content .my-scholar-media-resizable table {
          width:100%!important;
          margin-left:auto;
          margin-right:auto;
        }
        .reader-content .my-scholar-media-sized-cluster {
          display:flex;
          align-items:flex-start;
          gap:inherit;
        }
        .reader-content .my-scholar-media-sized-cluster > img {
          flex:var(--my-scholar-media-panel-weight) 1 0;
          min-width:0;
          max-width:100%;
          max-height:none;
          height:auto;
          margin:0;
        }
        .reader-content .my-scholar-media-resizable.is-resizing {
          transition:none;
          user-select:none;
        }
        .reader-content .my-scholar-media-image-wrapper,
        .reader-content .my-scholar-media-table-wrapper {
          margin-top:28px;
          margin-bottom:28px;
        }
        .reader-content .my-scholar-media-image-wrapper > :is(img,a),
        .reader-content .my-scholar-media-image-wrapper img {
          display:block;
          max-width:100%;
          height:auto;
          margin-left:auto;
          margin-right:auto;
        }
        .reader-content .my-scholar-media-table-wrapper {
          overflow:visible;
        }
        .reader-content .my-scholar-media-table-wrapper > .table-scroll {
          overflow-x:auto;
        }
        .reader-content img.math-source-inline {
          display:inline!important;
          max-height:3.6em!important;
          max-width:100%;
          width:auto!important;
          height:auto;
        }
        .math-source-visual { display:inline; position:relative; }
        .math-source-text { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
        .reader-content .my-scholar-media-resize-handle {
          position:absolute;
          z-index:12;
          top:10px;
          bottom:10px;
          width:20px;
          min-width:20px;
          margin:0;
          padding:0;
          border:0;
          border-radius:4px;
          background:transparent;
          box-shadow:none;
          color:var(--accent,#b45309);
          cursor:col-resize;
          opacity:0;
          touch-action:none;
          user-select:none;
          transition:opacity 120ms ease,background-color 120ms ease;
        }
        .reader-content .my-scholar-media-resize-handle.is-left { left:-10px; }
        .reader-content .my-scholar-media-resize-handle.is-right { right:-10px; }
        .reader-content .my-scholar-media-resize-handle::before {
          content:'';
          position:absolute;
          top:0;
          bottom:0;
          left:50%;
          width:3px;
          border-radius:99px;
          background:currentColor;
          box-shadow:0 0 0 1px color-mix(in srgb,var(--paper,#fff) 72%,transparent);
          transform:translateX(-50%);
        }
        .reader-content .my-scholar-media-resizable:hover > .my-scholar-media-resize-handle,
        .reader-content .my-scholar-media-resizable:focus-within > .my-scholar-media-resize-handle,
        .reader-content .my-scholar-media-resizable.is-resizing > .my-scholar-media-resize-handle {
          opacity:.86;
        }
        .reader-content .my-scholar-media-resize-handle:hover,
        .reader-content .my-scholar-media-resize-handle:focus-visible {
          opacity:1!important;
          background:color-mix(in srgb,var(--accent,#b45309) 10%,transparent);
          outline:none;
        }
        .reader-content .my-scholar-media-resize-handle:focus-visible::before {
          box-shadow:0 0 0 2px var(--paper,#fff),0 0 0 4px color-mix(in srgb,var(--accent,#b45309) 58%,transparent);
        }
        .is-resizing-media,
        .is-resizing-media * { cursor:col-resize!important; }
        @media (hover:none) {
          .reader-content .my-scholar-media-resize-handle { opacity:.62; }
        }
        @media (prefers-reduced-motion:reduce) {
          .reader-content .my-scholar-media-resizable,
          .reader-content .my-scholar-media-resize-handle,
          .annotation-note-popover { transition:none; animation:none; }
        }
        :root:not([data-translation-display="original"]) .reader-content :is(
          h1.paper-title[data-block-id],
          h1[data-translate-block-id],
          p[data-block-id],
          figcaption[data-translate-block-id]
        ).has-paragraph-translation {
          margin-bottom:0!important;
        }
        .reader-content .pdf-page > .my-scholar-translation:last-child {
          margin-bottom:.86em!important;
        }
        .pdf-table figcaption[data-translate-block-id],
        .pdf-figure figcaption[data-translate-block-id] {
          padding-right:0!important;
        }
        .paper-metadata {
          color:color-mix(in srgb,var(--ink,var(--reader-ui-ink)) 42%,var(--paper,var(--reader-ui-paper)));
          font-size:.92em;
          line-height:1.55;
        }
        .paper-abstract-heading { font-style:normal; font-weight:700; }
        .paper-abstract-body,
        .paper-abstract-translation {
          font-style:italic;
        }
        .paper-section-label { font-weight:700; }
        .paper-keywords,
        .paper-keywords-translation { font-style:italic; font-size:.95em; }
        .paper-abstract-body .paragraph-translate-trigger,
        .paper-abstract-body .annotation-note-trigger,
        .paper-keywords .paragraph-translate-trigger,
        .paper-keywords .annotation-note-trigger {
          font-style:normal;
        }
      `;
      doc.head.appendChild(runtimeStyle);
    }
    markAbstractSection(doc);
    if (state.health?.readonly && !doc.getElementById('readonly-frame-style')) {
      const style = doc.createElement('style');
      style.id = 'readonly-frame-style';
      style.textContent = '.paragraph-translate-trigger, .annotation-note-trigger { display: none !important; }';
      doc.head?.append(style);
    }
    doc.addEventListener('pointerdown', beginFrameTextSelection, { capture: true });
    doc.addEventListener('selectionchange', () => renderFrameTextSelection(doc));
    doc.defaultView?.addEventListener('resize', () => renderFrameTextSelection(doc, { reposition: true }), { passive: true });
    doc.addEventListener('selectstart', guardFrameSelection);
    doc.addEventListener('copy', guardFrameSelection);
    const delayedSelection = (event) => window.setTimeout(() => {
      if (!readerMountMatches(mount, doc)) return;
      if (event.type === 'keyup' && (/^[0-9]$/u.test(event.key) || event.key === 'Escape' || event.key === 'Enter')) return;
      showSelection(event);
    }, 20);
    doc.addEventListener('mouseup', delayedSelection);
    doc.addEventListener('keyup', delayedSelection);
    const closeHostTypographyPopover = () => {
      if (readerMountMatches(mount, doc) && typographyPopoverOpen) setTypographyPopover(false);
    };
    doc.addEventListener('pointerdown', closeHostTypographyPopover, { passive: true, capture: true });
    doc.addEventListener('click', closeHostTypographyPopover, { passive: true, capture: true });
    ['wheel', 'touchstart', 'pointerdown'].forEach((eventName) => doc.defaultView?.addEventListener(eventName, (event) => markReaderUserInteraction(mount, event), { passive: true, capture: true }));
    doc.defaultView?.addEventListener('scroll', () => {
      if (!readerMountMatches(mount, doc)) return;
      renderFrameTextSelection(doc, { reposition: true });
      closeImageContextMenu();
      if (doc.getSelection()?.toString().trim()) showSelection();
      else clearSelectionPopover({ clearState: true });
      const popover = doc.querySelector('.annotation-note-popover');
      if (popover?.dataset.annotationId && notePopoverHover.pinned && !popover.classList.contains('is-closing')) {
        const originalAnchor = notePopoverHover.anchor;
        const anchor = originalAnchor?.isConnected && originalAnchor.ownerDocument === doc
          ? originalAnchor : annotationAnchor(doc, popover.dataset.annotationId);
        if (anchor) positionInlineAnnotation(doc, popover, anchor);
      }
      scheduleReaderViewportUpdate(mount);
    }, { passive: true });
    doc.addEventListener('contextmenu', (event) => {
      if (!readerMountMatches(mount, doc)) return;
      const image = readerImageTarget(event.target);
      if (image) {
        event.preventDefault();
        event.stopPropagation();
        doc.getSelection()?.removeAllRanges();
        clearSelectionPopover({ clearState: true });
        const frame = $('#html-preview');
        const frameRect = frame.getBoundingClientRect();
        const scaleX = frame.clientWidth ? frameRect.width / frame.clientWidth : 1;
        const scaleY = frame.clientHeight ? frameRect.height / frame.clientHeight : 1;
        openImageContextMenu(readerImageDetails(image, doc), image, frameRect.left + event.clientX * scaleX, frameRect.top + event.clientY * scaleY);
        return;
      }
      if (doc.getSelection()?.toString().trim()) {
        event.preventDefault();
        showSelection();
      }
    });
    doc.addEventListener('click', (event) => {
      if (!readerMountMatches(mount, doc)) return;
      closeImageContextMenu();
      if (assistantOverlayQuery.matches) setChapterRailOpen(false);
      const readerImage = readerImageTarget(event.target);
      if (readerImage) {
        event.preventDefault();
        event.stopPropagation();
        doc.getSelection()?.removeAllRanges();
        clearSelectionPopover({ clearState: true });
        openImageLightbox(readerImageDetails(readerImage, doc), readerImage);
        return;
      }
      const trigger = event.target.closest?.('.annotation-note-trigger');
      if (trigger) {
        event.preventDefault();
        event.stopPropagation();
        doc.getSelection()?.removeAllRanges();
        clearSelectionPopover({ clearState: true });
        const annotation = state.annotations.find((item) => item.id === trigger.dataset.annotationId);
        if (annotation) showInlineAnnotation(annotation, trigger);
        return;
      }
      const suggestionMark = event.target.closest?.('.my-scholar-ai-suggestion[data-annotation-id]');
      if (suggestionMark && !doc.getSelection()?.toString().trim()) {
        event.preventDefault();
        event.stopPropagation();
        clearSelectionPopover({ clearState: true });
        const annotation = state.annotations.find((item) => item.id === suggestionMark.dataset.annotationId);
        if (annotation && !isIgnoredAISuggestion(annotation)) showAISuggestion(annotation, suggestionMark);
        return;
      }
      const link = event.target.closest?.('a.citation, a.cross-reference');
      if (link) {
        event.preventDefault();
        const href = String(link.getAttribute('href') || '');
        const targetId = href.startsWith('#') ? href.slice(1) : '';
        const target = targetId && /^[a-z0-9_-]{1,128}$/iu.test(targetId) ? doc.getElementById(targetId) : null;
        if (primaryModifierPressed(event)) {
          readerVisibleTarget(target, doc)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else if (link.classList.contains('citation')) {
          openReferenceQuickPreview(link);
          readerVisibleTarget(target, doc)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else if (!openMediaQuickPreview(target, link)) {
          readerVisibleTarget(target, doc)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        return;
      }
      if (!event.target.closest?.('.annotation-note-popover')) closeInlineAnnotation(doc);
    });
    doc.addEventListener('keydown', (event) => {
      if (!readerMountMatches(mount, doc)) return;
      if (handleReaderSearchShortcut(event)) return;
      markReaderUserInteraction(mount, event);
      if (event.key === 'Escape' && $('#reader-chapter-rail')?.classList.contains('is-open')) {
        event.preventDefault();
        setChapterRailOpen(false, { restoreFocus: true });
        return;
      }
      if (event.key === 'Escape' && (closeImageContextMenu({ restoreFocus: true }) || closeImageLightbox())) {
        event.preventDefault();
        return;
      }
      if (handleApplicationShortcut(event)) return;
      const image = readerImageTarget(event.target);
      if (image && ['Enter', ' '].includes(event.key)) {
        event.preventDefault();
        openImageLightbox(readerImageDetails(image, doc), image);
        return;
      }
      const suggestionMark = event.target.closest?.('.my-scholar-ai-suggestion[data-annotation-id]');
      if (!suggestionMark || !['Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      const annotation = state.annotations.find((item) => item.id === suggestionMark.dataset.annotationId);
      if (annotation && !isIgnoredAISuggestion(annotation)) showAISuggestion(annotation, suggestionMark);
    });
    prepareReaderMedia(doc, state.activeJob?.job_id);
    prepareReaderImages(doc);
    hydrateFrameMath(doc);
    applyTranslationVisibility(doc);
    syncTranslationVisibilityButton();
    installParagraphTranslationControls();
    renderCachedTranslations({ reconcile: false });
    buildReaderIndexes();
    renderFrameAnnotations();
    installReaderAnnotationHover(doc);
    refreshReaderSearch();
    applyAppearance();
    applyHighlightColor();
    // Non-critical wiring runs when the main thread is idle so the document
    // becomes interactive sooner after a switch.
    scheduleReaderIdle(() => {
      if (!readerMountMatches(mount)) return;
      installCitationHoverPreviews(doc);
      ensureTitleTranslation();
    });
  }
  async function prepareMountedReader(mount) {
    if (!mount.loaded || !readerMountMatches(mount)) return;
    const activation = mount.activation;
    const doc = frameDocument();
    const current = () => readerMountMatches(mount, doc) && mount.activation === activation;
    if (mount.preparingActivation === activation) return;
    mount.preparingActivation = activation;
    try {
      if (mount.wiredDocument !== doc) {
        state.annotations = mount.annotations;
        state.aiHighlights = mount.aiHighlights;
        wireFrame(mount);
        mount.wiredDocument = doc;
      } else {
        applyAppearance();
        applyHighlightColor();
        applyTranslationVisibility(doc);
        syncTranslationVisibilityButton();
        renderCachedTranslations({ reconcile: false });
        buildReaderIndexes();
        renderFrameAnnotations();
        installCitationHoverPreviews(doc);
        updateReaderProgress(doc);
      }
      if (!mount.ready) await restoreReadingLocationAfterLoad(mount, activation);
    } catch (error) {
      if (current()) setPanelStatus(`阅读位置恢复失败：${error.message}`, true);
    } finally {
      if (current()) {
        mount.ready = true;
        mount.restorePending = false;
        doc.documentElement.classList.remove('my-scholar-reader-restoring');
        $('#reader-view')?.classList.remove('is-document-loading');
      }
    }
  }
  window.addEventListener('resize', () => {
    if (!assistantOverlayQuery.matches) applyAssistantWidth();
    if (frameDocument()?.getSelection()?.toString().trim()) showSelection();
  }, { passive: true });

  function cssEscape(value) { return window.CSS?.escape ? window.CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&'); }
  const annotationColors = [
    { value: '#ffd400', label: '黄色' },
    { value: '#ff6666', label: '红色' },
    { value: '#5fb236', label: '绿色' },
    { value: '#2ea8e5', label: '蓝色' },
    { value: '#a28ae5', label: '紫色' },
    { value: '#e56eee', label: '洋红色' },
    { value: '#f19837', label: '橙色' },
    { value: '#aaaaaa', label: '灰色' },
  ];
  const highlightCategoryColorValues = {
    research_goal: '#2f9d72',
    method: '#e39a22',
    innovation: '#8b6edb',
    conclusion: '#d15d79',
  };
  const legacyAnnotationColors = { yellow: '#ffd400', red: '#ff6666', green: '#5fb236', blue: '#2ea8e5', purple: '#a28ae5', magenta: '#e56eee', orange: '#f19837', gray: '#aaaaaa' };
  function isAIAnnotation(annotation) {
    if (annotation?.source === 'ai') return true;
    if (annotation?.source === 'manual') return false;
    return annotation?.kind === 'highlight' && annotation?.start == null && annotation?.end == null;
  }
  function hasAnnotationNote(annotation) {
    return Boolean(String(annotation?.note || '').trim());
  }
  function isIgnoredAISuggestion(annotation) {
    return isAIAnnotation(annotation) && annotation?.suggestion_state === 'ignored';
  }
  function normalizedAnnotationTarget(value) {
    return String(value || '').trim().replace(/\s+/gu, ' ');
  }
  function sameAnnotationTarget(left, right) {
    return Boolean(left && right
      && normalizedAnnotationTarget(left.block_id) === normalizedAnnotationTarget(right.block_id)
      && normalizedAnnotationTarget(left.quote) === normalizedAnnotationTarget(right.quote));
  }
  function aiAnnotationForSuggestion(suggestion) {
    return state.annotations.find((item) => isAIAnnotation(item) && sameAnnotationTarget(item, suggestion)) || null;
  }
  function manualAnnotationForSuggestion(suggestion) {
    return state.annotations.find((item) => !isAIAnnotation(item) && sameAnnotationTarget(item, suggestion)) || null;
  }
  function isCurrentAISuggestion(annotation) {
    return isAIAnnotation(annotation) && state.aiHighlights.some((suggestion) => sameAnnotationTarget(annotation, suggestion));
  }

  function clipboardImageFile(dataTransfer) {
    for (const item of [...(dataTransfer?.items || [])]) {
      if (item.kind !== 'file' || !item.type?.startsWith('image/')) continue;
      const file = item.getAsFile?.();
      if (file) return file;
    }
    return [...(dataTransfer?.files || [])].find((file) => file.type?.startsWith('image/')) || null;
  }
  function normalizeAnnotationColor(value) {
    return normalizeHexColor(legacyAnnotationColors[String(value || '').toLowerCase()] || value, state.highlightColor);
  }
  function annotationColorSlot(kind) {
    return kind === 'underline' ? 'underline' : 'highlight';
  }
  function annotationColorFor(kind) {
    return normalizeAnnotationColor(state.annotationColors?.[annotationColorSlot(kind)]);
  }
  function rememberAnnotationColor(kind, color) {
    const slot = annotationColorSlot(kind);
    const value = normalizeAnnotationColor(color);
    if (state.annotationColors?.[slot] === value) return;
    state.annotationColors = { ...state.annotationColors, [slot]: value };
    api('/api/settings', jsonOptions({ annotation_colors: state.annotationColors }, 'PUT')).catch(() => {});
  }
  function annotationPaletteHTML(annotation) {
    if (isAIAnnotation(annotation)) return '';
    const selected = normalizeAnnotationColor(annotation.color);
    return `<div class="annotation-color-palette" role="group" aria-label="标注颜色">${annotationColors.map((color) => `<button type="button" class="annotation-color-swatch" data-annotation-color="${color.value}" style="--swatch-color:${color.value}" title="${color.label}" aria-label="${color.label}" aria-pressed="${color.value === selected}"></button>`).join('')}</div>`;
  }
  function applyAnnotationColor(mark, annotation) {
    if (!mark || isAIAnnotation(annotation)) return;
    mark.dataset.userColor = 'true';
    mark.style.setProperty('--user-highlight', normalizeAnnotationColor(annotation.color));
  }
  function applyAnnotationTheme(node, annotation) {
    if (!node || isAIAnnotation(annotation)) return;
    node.style.setProperty('--annotation-color', normalizeAnnotationColor(annotation.color));
  }
  function repairEmphasisFragments(root) {
    if (!root) return;
    root.normalize();
    root.querySelectorAll('strong[data-emphasis-source]').forEach((strong) => {
      [...strong.querySelectorAll('strong[data-emphasis-source]')].forEach((nested) => {
        if (nested.dataset.emphasisSource !== strong.dataset.emphasisSource) return;
        nested.replaceWith(...nested.childNodes);
      });
    });
    [root, ...root.querySelectorAll('*')].forEach((parent) => {
      let previous = null;
      [...parent.childNodes].forEach((child) => {
        const isStrong = child.nodeType === 1 && child.tagName === 'STRONG' && child.hasAttribute('data-emphasis-source');
        if (isStrong && previous && previous.dataset.emphasisSource === child.dataset.emphasisSource) {
          previous.append(...child.childNodes);
          child.remove();
          return;
        }
        previous = isStrong ? child : null;
      });
    });
    root.querySelectorAll('strong[data-emphasis-source]').forEach((strong) => {
      if (!strong.textContent && !strong.querySelector('math, img')) strong.remove();
    });
    root.normalize();
  }
  function removeMark(annotationId) {
    const doc = frameDocument(); if (!doc) return;
    const affectedBlocks = new Set();
    doc.querySelectorAll(`[data-annotation-id="${cssEscape(annotationId || '')}"]`).forEach((node) => {
      if (node.classList.contains('annotation-note-trigger')) { node.remove(); return; }
      const parent = node.parentNode;
      if (!parent) return;
      const block = node.closest?.('[data-block-id]');
      if (block) affectedBlocks.add(block);
      while (node.firstChild) parent.insertBefore(node.firstChild, node);
      node.remove();
    });
    affectedBlocks.forEach(repairEmphasisFragments);
  }

  function resolveAnnotationAnchor(annotation, doc = frameDocument()) {
    if (!doc || !annotation.quote || annotation.import_anchor_disabled === true) return null;
    const root = doc.querySelector(`[data-block-id="${cssEscape(annotation.block_id || '')}"]`);
    const generation = normalizeChatSourceGeneration(annotation.render_generation) || 'base';
    if (generation === activeChatSourceGeneration() && root) {
      const range = annotationRange(root, annotation, doc);
      if (range) return { root, range };
    }
    if (annotation.surface === 'translation') {
      const sourceBlockId = annotation.source_block_id || root?.dataset.translationFor || root?.dataset.for
        || (String(annotation.block_id || '').startsWith('translation-') ? annotation.block_id.slice('translation-'.length) : '');
      if (translationAnnotationGroup(sourceBlockId, doc)) {
        return resolveTranslationGroupAnnotation(annotation, sourceBlockId, doc, {
          useOffsets: generation === activeChatSourceGeneration() && annotation.block_id === `translation-${sourceBlockId}`,
        });
      }
      const sourceIds = new Set([...doc.querySelectorAll('.my-scholar-translation[data-for]')].map((node) => node.dataset.translationFor || node.dataset.for).filter(Boolean));
      const matches = [...sourceIds].map((id) => resolveTranslationGroupAnnotation(annotation, id, doc)).filter(Boolean);
      return matches.length === 1 ? matches[0] : null;
    }
    const continuation = readerContinuations.get(doc)?.get(String(annotation.block_id));
    if (continuation && annotation.surface !== 'translation' && generation === activeChatSourceGeneration() && (!annotation.page || String(annotation.page) === continuation.page)) {
      const start = continuation.start + Number(annotation.start);
      const end = continuation.start + Number(annotation.end);
      if (start >= continuation.start && end <= continuation.end && canonicalBlockText(continuation.root, doc).slice(start, end) === annotation.quote) {
        return { root: continuation.root, range: rangeAtOffsets(continuation.root, start, end, doc) };
      }
    }
    // Reflow may renumber blocks. Only an unambiguous quote on the original
    // page may relocate an existing annotation; offsets belong to its old text.
    const candidates = [];
    const quote = String(annotation.quote);
    const sources = [...doc.querySelectorAll('[data-block-id]')].map((root) => ({
      root, page: root.dataset.page, start: 0,
      matchStartEnd: readerContinuations.get(doc)?.get(root.dataset.blockId)?.end,
    }));
    for (const [id, source] of readerContinuations.get(doc) || []) {
      if (id !== source.root.dataset.blockId) sources.push(source);
    }
    for (const source of sources) {
      const block = source.root;
      const translation = block.closest?.('.my-scholar-translation');
      if ((annotation.surface === 'translation') !== Boolean(translation)) continue;
      if (annotation.page != null && String(source.page || translation?.dataset.page || '') !== String(annotation.page)) continue;
      const text = canonicalBlockText(block, doc).slice(source.start, source.end);
      let cursor = text.indexOf(quote);
      while (cursor >= 0) {
        const prefix = String(annotation.quote_prefix || '');
        const suffix = String(annotation.quote_suffix || '');
        if ((source.matchStartEnd == null || cursor < source.matchStartEnd)
          && (!prefix || text.slice(Math.max(0, cursor - prefix.length), cursor) === prefix)
          && (!suffix || text.slice(cursor + quote.length, cursor + quote.length + suffix.length) === suffix)) {
          candidates.push({ root: block, start: source.start + cursor, end: source.start + cursor + quote.length });
        }
        cursor = text.indexOf(quote, cursor + 1);
      }
    }
    if (candidates.length !== 1) return null;
    const found = candidates[0];
    return { root: found.root, range: rangeAtOffsets(found.root, found.start, found.end, doc) };
  }

  function prepareMathAnnotationRange(range, doc) {
    const mathFor = (node) => (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement)?.closest('math');
    const startMath = mathFor(range.startContainer);
    const endMath = mathFor(range.endContainer);
    if (!startMath && !endMath) return { range, math: null };
    const boundary = (node, offset, container, end) => {
      if (node.nodeType === Node.TEXT_NODE && offset === (end ? 0 : node.nodeValue.length)) {
        const nodes = textNodes(container, doc);
        node = nodes[nodes.indexOf(node) + (end ? -1 : 1)];
        if (!node) return null;
        offset = end ? node.nodeValue.length : 0;
      }
      if (node.nodeType !== Node.TEXT_NODE || offset !== (end ? node.nodeValue.length : 0)) return null;
      while (node.parentNode !== container) {
        if (!node.parentNode || (end ? node.nextSibling : node.previousSibling)) return null;
        node = node.parentNode;
      }
      return node;
    };
    const prepared = range.cloneRange();
    if (startMath && startMath === endMath) {
      let container = range.commonAncestorContainer;
      if (container.nodeType !== Node.ELEMENT_NODE) container = container.parentElement;
      while (container !== startMath && !['math', 'mrow'].includes(container.localName)) container = container.parentElement;
      const first = boundary(range.startContainer, range.startOffset, container, false);
      const last = boundary(range.endContainer, range.endOffset, container, true);
      if (!first || !last) return null;
      prepared.setStartBefore(first);
      prepared.setEndAfter(last);
      return { range: prepared, math: startMath };
    }
    // A text mark may contain a complete formula, but must not split its tree.
    if (startMath) {
      const first = boundary(range.startContainer, range.startOffset, startMath, false);
      if (!first || first.previousSibling) return null;
      prepared.setStartBefore(startMath);
    }
    if (endMath) {
      const last = boundary(range.endContainer, range.endOffset, endMath, true);
      if (!last || last.nextSibling) return null;
      prepared.setEndAfter(endMath);
    }
    return { range: prepared, math: null };
  }

  function applyMark(annotation, suppliedAnchor = null) {
    const doc = frameDocument();
    if (!annotation.quote || !annotation.id) return false;
    if (!suppliedAnchor && doc?.querySelector(`[data-annotation-id="${cssEscape(annotation.id)}"]`)) return true;
    const anchor = suppliedAnchor || resolveAnnotationAnchor(annotation, doc);
    if (anchor?.ranges) {
      if (!anchor.ranges.every(({ range }) => prepareMathAnnotationRange(range, doc))) return false;
      let applied = true;
      for (const entry of anchor.ranges) applied = applyMark(annotation, entry) && applied;
      return applied;
    }
    const root = anchor?.root;
    if (!root || !anchor.range || anchor.range.collapsed) return false;
    const sentenceRoots = [...root.querySelectorAll('.reader-source-sentence')];
    if (sentenceRoots.length && annotation.surface !== 'translation') {
      const start = textOffset(root, anchor.range.startContainer, anchor.range.startOffset, doc);
      const end = textOffset(root, anchor.range.endContainer, anchor.range.endOffset, doc);
      let applied = false;
      for (const sentence of sentenceRoots) {
        const offset = textOffset(root, sentence, 0, doc);
        const length = canonicalBlockText(sentence, doc).length;
        const from = Math.max(0, start - offset);
        const to = Math.min(length, end - offset);
        if (to > from) applied = applyMark(annotation, { root: sentence, range: rangeAtOffsets(sentence, from, to, doc) }) || applied;
      }
      return applied;
    }
    const prepared = prepareMathAnnotationRange(anchor.range, doc);
    if (!prepared) return false;
    const { range, math } = prepared;
    const mark = math ? doc.createElementNS('http://www.w3.org/1998/Math/MathML', 'mrow') : doc.createElement('mark');
    mark.dataset.annotationId = annotation.id;
    if (annotation.kind === 'underline') {
      mark.className = 'my-scholar-underline';
    } else {
      const category = normalizeHighlightCategory(annotation.category);
      mark.className = `my-scholar-highlight my-scholar-highlight-${category}`;
      mark.dataset.highlightCategory = category;
      if (isAIAnnotation(annotation)) {
        mark.classList.add('my-scholar-ai-suggestion', `my-scholar-ai-suggestion-${category}`);
        mark.dataset.annotationSource = 'ai';
        mark.dataset.suggestionKey = annotation.suggestion_key || '';
        mark.tabIndex = 0;
        mark.setAttribute('role', 'button');
        mark.setAttribute('aria-haspopup', 'dialog');
        mark.setAttribute('aria-expanded', 'false');
        mark.setAttribute('aria-label', 'AI 阅读建议，点击可添加个人笔记、转为个人高亮或忽略');
        mark.title = 'AI 阅读建议 · 点击可采纳或忽略';
      } else {
        mark.dataset.annotationSource = 'manual';
      }
    }
    applyAnnotationColor(mark, annotation);
    try {
      const fragment = range.extractContents();
      mark.appendChild(fragment);
      range.insertNode(mark);
      if (!isAIAnnotation(annotation)) {
        const trigger = doc.createElement('button');
        trigger.type = 'button';
        trigger.className = 'annotation-note-trigger';
        trigger.dataset.annotationId = annotation.id;
        trigger.title = `${annotation.label ? `${annotation.label} · ` : ''}${annotation.note ? '查看句内笔记' : '添加或查看句内笔记'}`;
        trigger.setAttribute('aria-label', trigger.title);
        trigger.textContent = annotation.note ? '✎' : '＋';
        trigger.addEventListener('pointerenter', (event) => {
          if (event.pointerType !== 'mouse' || event.buttons) return;
          scheduleNoteHoverOpen(trigger);
        });
        trigger.addEventListener('pointerleave', (event) => {
          if (event.pointerType !== 'mouse') return;
          cancelNoteHoverOpen();
          scheduleNoteHoverClose();
        });
        applyAnnotationTheme(trigger, annotation);
        (math || mark).insertAdjacentElement('afterend', trigger);
      }
      root.normalize();
      return true;
    } catch (_) {
      return false;
    }
  }

  const NOTE_HOVER_OPEN_DELAY = 120;
  const NOTE_HOVER_CLOSE_DELAY = 260;
  const notePopoverHover = { openTimer: null, closeTimer: null, pendingAnnotationId: '', pendingDoc: null, pinned: false, anchor: null };

  function cancelNoteHoverOpen() {
    window.clearTimeout(notePopoverHover.openTimer);
    notePopoverHover.openTimer = null;
    notePopoverHover.pendingAnnotationId = '';
    notePopoverHover.pendingDoc = null;
  }
  function cancelNoteHoverClose() {
    window.clearTimeout(notePopoverHover.closeTimer);
    notePopoverHover.closeTimer = null;
  }
  function scheduleNoteHoverOpen(trigger) {
    if (notePopoverHover.pinned) return;
    const doc = frameDocument();
    const mount = readerMount;
    if (!doc || trigger.ownerDocument !== doc || !trigger.isConnected || doc.getSelection()?.toString().trim()) return;
    const annotation = state.annotations.find((item) => item.id === trigger.dataset.annotationId);
    if (!annotation || isAIAnnotation(annotation)) return;
    cancelNoteHoverClose();
    const popover = doc.querySelector('.annotation-note-popover');
    if (popover?.dataset.annotationId === annotation.id && !popover.classList.contains('is-closing')) return;
    if (notePopoverHover.pendingAnnotationId === annotation.id && notePopoverHover.pendingDoc === doc) return;
    cancelNoteHoverOpen();
    notePopoverHover.pendingAnnotationId = annotation.id;
    notePopoverHover.pendingDoc = doc;
    notePopoverHover.openTimer = window.setTimeout(() => {
      cancelNoteHoverOpen();
      if (!readerMountMatches(mount, doc) || !trigger.isConnected || trigger.ownerDocument !== doc || notePopoverHover.pinned || doc.getSelection()?.toString().trim()) return;
      showInlineAnnotation(annotation, trigger, { pinned: false });
    }, NOTE_HOVER_OPEN_DELAY);
  }
  function scheduleNoteHoverClose() {
    if (notePopoverHover.pinned || notePopoverHover.closeTimer) return;
    const doc = frameDocument();
    const mount = readerMount;
    const popover = doc?.querySelector('.annotation-note-popover');
    if (!popover) return;
    notePopoverHover.closeTimer = window.setTimeout(() => {
      notePopoverHover.closeTimer = null;
      if (!notePopoverHover.pinned && readerMountMatches(mount, doc) && popover.isConnected) closeInlineAnnotation(doc);
    }, NOTE_HOVER_CLOSE_DELAY);
  }

  function closeInlineAnnotation(doc = frameDocument(), { immediate = false } = {}) {
    cancelNoteHoverOpen();
    cancelNoteHoverClose();
    notePopoverHover.pinned = false;
    notePopoverHover.anchor = null;
    const popover = doc?.querySelector('.annotation-note-popover');
    if (!popover) return;
    const trigger = annotationAnchor(doc, popover.dataset.annotationId);
    if (trigger?.classList.contains('my-scholar-ai-suggestion')) trigger.setAttribute('aria-expanded', 'false');
    const remove = () => popover.remove();
    popover.classList.add('is-closing');
    popover.inert = true;
    if (immediate || reducedMotionQuery.matches) remove();
    else doc.defaultView.setTimeout(remove, 160);
  }

  function annotationAnchor(doc, annotationId) {
    if (!doc || !annotationId) return null;
    const selector = `[data-annotation-id="${cssEscape(annotationId)}"]`;
    return doc.querySelector(`.annotation-note-trigger${selector}`) || doc.querySelector(`:is(mark, mrow)${selector}`);
  }

  function positionInlineAnnotation(doc, popover, trigger) {
    if (!doc || !popover || !trigger) return;
    const target = readerVisibleTarget(trigger, doc);
    if (!target) return;
    const markPreview = !notePopoverHover.pinned && trigger.matches(':is(mark, mrow)[data-annotation-id]');
    let rect = target.getBoundingClientRect();
    if (markPreview) {
      const selector = `:is(mark, mrow)[data-annotation-id="${cssEscape(trigger.dataset.annotationId)}"]`;
      const lines = [...doc.querySelectorAll(selector)].flatMap((mark) => [...mark.getClientRects()]).filter((line) => line.width > 0 && line.height > 0);
      if (!lines.length) { popover.remove(); return; }
      rect = { left: Math.min(...lines.map((line) => line.left)), top: Math.min(...lines.map((line) => line.top)), bottom: Math.max(...lines.map((line) => line.bottom)) };
      popover.style.boxSizing = 'border-box';
    }
    const viewportWidth = doc.documentElement.clientWidth;
    const viewportHeight = doc.documentElement.clientHeight;
    const scale = state.typography.fontSize / 100;
    const maximumWidth = Math.max(180, viewportWidth - 24);
    const width = Math.min(maximumWidth, Math.max(Math.min(220 * scale, maximumWidth), 330 * scale));
    const maximumHeight = Math.max(180, viewportHeight - 24);
    const scrollX = doc.defaultView?.scrollX || 0;
    const scrollY = doc.defaultView?.scrollY || 0;
    popover.style.position = 'absolute';
    popover.style.width = `${Math.round(width)}px`;
    popover.style.maxHeight = `${Math.round(maximumHeight)}px`;
    popover.style.overflowY = 'auto';
    popover.style.left = `${Math.max(scrollX + 12, Math.min(scrollX + doc.documentElement.clientWidth - width - 12, scrollX + rect.left))}px`;
    const height = Math.min(popover.offsetHeight || popover.scrollHeight || maximumHeight, maximumHeight);
    if (markPreview) {
      const belowTop = Math.ceil(rect.bottom + 8);
      const aboveBottom = Math.floor(rect.top - 8);
      const belowSpace = Math.max(0, viewportHeight - 12 - belowTop);
      const aboveSpace = Math.max(0, aboveBottom - 12);
      if (Math.max(belowSpace, aboveSpace) < Math.min(80, height)) { popover.remove(); return; }
      const placeBelow = height <= belowSpace || (height > aboveSpace && belowSpace >= aboveSpace);
      popover.style.maxHeight = `${placeBelow ? belowSpace : aboveSpace}px`;
      const top = placeBelow ? belowTop : Math.floor(aboveBottom - popover.offsetHeight);
      popover.style.top = `${scrollY + top}px`;
      return;
    }
    const below = rect.bottom + 8;
    const above = rect.top - height - 8;
    const viewportTop = below + height <= viewportHeight - 12 ? below : (above >= 12 ? above : 12);
    popover.style.top = `${scrollY + viewportTop}px`;
  }

  function annotationLocation(annotation) {
    const doc = frameDocument();
    const anchor = resolveAnnotationAnchor(annotation, doc);
    if (!anchor) return {};
    const { root, range } = anchor;
    const translation = root.closest?.('.my-scholar-translation') || (root.classList?.contains('my-scholar-translation') ? root : null);
    return {
      block_id: root.dataset.blockId,
      page: root.dataset.page || translation?.dataset.page || annotation.page || null,
      start: range ? textOffset(root, range.startContainer, range.startOffset, doc) : null,
      end: range ? textOffset(root, range.endContainer, range.endOffset, doc) : null,
      surface: translation ? 'translation' : 'paper',
      source_block_id: translation?.dataset.translationFor || null,
    };
  }

  async function adoptAISuggestion(annotation, { withNote = false } = {}) {
    if (!state.activeJob || !annotation || isIgnoredAISuggestion(annotation)) return null;
    const jobId = state.activeJob.job_id;
    const mount = readerMount;
    if (!readerMountMatches(mount)) return;
    let manual = manualAnnotationForSuggestion(annotation);
    try {
      if (!manual) {
        const location = annotationLocation(annotation);
        const payload = await api(`/api/jobs/${jobId}/annotations`, jsonOptions({
          kind: 'highlight',
          quote: annotation.quote,
          block_id: annotation.block_id,
          note: '',
          category: normalizeHighlightCategory(annotation.category),
          color: state.highlightColor,
          source: 'manual',
          ...location,
        }));
        if (!annotationOperations.applyResult(jobId, mount, payload)) return null;
        manual = state.annotations.find((item) => item.id === payload.annotation?.id) || manualAnnotationForSuggestion(annotation);
      }
      renderAnnotations();
      renderFrameAnnotations();
      const doc = frameDocument();
      const trigger = doc?.querySelector(`.annotation-note-trigger[data-annotation-id="${cssEscape(manual?.id || '')}"]`);
      if (manual && trigger) {
        showInlineAnnotation(manual, trigger);
        if (withNote) beginAnnotationEdit(manual, trigger, doc.querySelector('.annotation-note-popover'));
        else doc.querySelector('.annotation-note-popover [data-action="edit"]')?.focus();
      }
      showToast(withNote ? '已创建个人高亮，可以直接写笔记。' : '已转为我的高亮。');
      return manual;
    } catch (error) {
      if (!readerMountMatches(mount) || state.activeJob?.job_id !== jobId) return;
      showToast(error.message, true);
      return null;
    }
  }

  async function setAISuggestionState(annotation, suggestionState) {
    if (!state.activeJob || !isAIAnnotation(annotation)) return;
    const jobId = state.activeJob.job_id;
    const mount = readerMount;
    if (!readerMountMatches(mount)) return;
    try {
      const payload = await api(`/api/jobs/${jobId}/annotations/${annotation.id}`, jsonOptions({ suggestion_state: suggestionState }, 'PATCH'));
      if (!annotationOperations.applyResult(jobId, mount, payload)) return false;
      renderAnnotations();
      renderFrameAnnotations();
      showToast(suggestionState === 'ignored' ? '已忽略这条 AI 建议，可在阅读重点中恢复。' : 'AI 建议已恢复。');
      return true;
    } catch (error) {
      if (!readerMountMatches(mount) || state.activeJob?.job_id !== jobId) return;
      showToast(error.message, true);
      return false;
    }
  }

  function focusAfterIgnoredAISuggestion(annotation) {
    const restore = document.querySelector(`.highlight-card[data-ai-annotation-id="${cssEscape(annotation.id)}"] [data-highlight-action="restore"]`);
    if ($('#highlights-panel')?.classList.contains('active-panel') && restore && restore.offsetParent !== null) {
      restore.focus();
      return;
    }
    const doc = frameDocument();
    const block = readerBlockById(annotation.block_id, doc);
    const marks = [...(doc?.querySelectorAll('.my-scholar-ai-suggestion[data-annotation-id]') || [])].filter((mark) => mark.offsetParent !== null);
    const following = block && doc?.defaultView?.Node
      ? marks.find((mark) => block.compareDocumentPosition(mark) & doc.defaultView.Node.DOCUMENT_POSITION_FOLLOWING)
      : null;
    const target = following || marks[0];
    if (target) {
      target.focus({ preventScroll: true });
      return;
    }
    if (!block) return;
    if (!block.hasAttribute('tabindex')) {
      block.tabIndex = -1;
      block.dataset.aiFocusAnchor = 'true';
      block.addEventListener('blur', () => {
        if (block.dataset.aiFocusAnchor === 'true') {
          block.removeAttribute('tabindex');
          delete block.dataset.aiFocusAnchor;
        }
      }, { once: true });
    }
    block.focus({ preventScroll: true });
  }

  function showAISuggestion(annotation, trigger) {
    const doc = frameDocument();
    if (!doc || !trigger || isIgnoredAISuggestion(annotation)) return;
    closeInlineAnnotation(doc, { immediate: true });
    notePopoverHover.pinned = true;
    notePopoverHover.anchor = trigger;
    const category = normalizeHighlightCategory(annotation.category);
    const color = highlightCategoryColorValues[category] || highlightCategoryColorValues.method;
    const currentSuggestion = state.aiHighlights.find((suggestion) => sameAnnotationTarget(annotation, suggestion));
    const reason = currentSuggestion?.reason ?? annotation.note ?? '';
    const popover = doc.createElement('div');
    popover.className = 'annotation-note-popover ai-suggestion-popover';
    popover.id = `ai-suggestion-${annotation.id}`;
    popover.dataset.annotationId = annotation.id;
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-label', 'AI 阅读建议');
    popover.style.setProperty('--ai-suggestion-color', color);
    popover.style.setProperty('--annotation-color', color);
    popover.innerHTML = `<div class="annotation-note-popover-head"><strong>✦ AI 阅读建议</strong><span>${highlightCategoryLabels[category]}</span></div><div class="ai-suggestion-label">AI 生成内容 · 仅供参考</div><div class="annotation-note-popover-quote">${escapeHTML(annotation.quote)}</div>${reason ? `<div class="ai-suggestion-reason"><strong>建议理由：</strong>${escapeHTML(reason)}</div>` : ''}<div class="annotation-note-popover-actions"><button type="button" data-action="ai-add-note">添加个人笔记</button><button type="button" data-action="ai-adopt">转为我的高亮</button><button type="button" data-action="ai-ignore">忽略</button><button type="button" data-action="close">关闭</button></div>`;
    popover.addEventListener('click', (event) => event.stopPropagation());
    popover.addEventListener('mouseup', (event) => event.stopPropagation());
    doc.body.appendChild(popover);
    trigger.setAttribute('aria-controls', popover.id);
    trigger.setAttribute('aria-expanded', 'true');
    positionInlineAnnotation(doc, popover, trigger);
    popover.querySelector('[data-action="ai-add-note"]').addEventListener('click', () => adoptAISuggestion(annotation, { withNote: true }));
    popover.querySelector('[data-action="ai-adopt"]').addEventListener('click', () => adoptAISuggestion(annotation));
    popover.querySelector('[data-action="ai-ignore"]').addEventListener('click', async () => {
      if (await setAISuggestionState(annotation, 'ignored')) {
        focusAfterIgnoredAISuggestion(annotation);
      }
    });
    const closeAndRestoreFocus = () => {
      closeInlineAnnotation(doc);
      if (trigger.isConnected) trigger.focus();
    };
    popover.querySelector('[data-action="close"]').addEventListener('click', closeAndRestoreFocus);
    popover.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      closeAndRestoreFocus();
    });
    popover.querySelector('[data-action="ai-add-note"]')?.focus();
  }

  function showInlineAnnotation(annotation, trigger, { pinned = true } = {}) {
    const doc = frameDocument(); if (!doc || !trigger) return;
    closeInlineAnnotation(doc, { immediate: true });
    notePopoverHover.pinned = pinned;
    notePopoverHover.anchor = trigger;
    const popover = doc.createElement('div');
    popover.className = 'annotation-note-popover';
    popover.dataset.annotationId = annotation.id;
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-label', annotation.label || (annotation.kind === 'underline' ? '划线笔记' : '重点笔记'));
    applyAnnotationTheme(popover, annotation);
    const conversionLabel = annotation.kind === 'underline' ? '转为高亮' : '转为划线';
    popover.addEventListener('pointerenter', cancelNoteHoverClose);
    popover.addEventListener('pointerleave', (event) => { if (event.pointerType === 'mouse') scheduleNoteHoverClose(); });
    popover.addEventListener('pointerdown', () => { notePopoverHover.pinned = true; cancelNoteHoverClose(); });
    popover.addEventListener('click', () => {
      if (!popover.isConnected || popover.classList.contains('is-closing')) return;
      notePopoverHover.pinned = true;
      cancelNoteHoverClose();
    });
    popover.innerHTML = `<div class="annotation-note-popover-head"><strong>${escapeHTML(annotation.label || (annotation.kind === 'underline' ? '划线笔记' : '重点笔记'))}</strong><span>第 ${escapeHTML(annotation.page || '—')} 页</span></div>${annotationPaletteHTML(annotation)}<div class="annotation-note-popover-quote">${escapeHTML(annotation.quote)}</div><div class="annotation-note-popover-body">${annotation.note ? renderMarkdown(annotation.note) : '<span class="annotation-note-empty">还没有笔记，点击“添加笔记”。</span>'}</div><div class="annotation-note-popover-actions"><button type="button" data-action="convert">${conversionLabel}</button><button type="button" data-action="edit">${annotation.note ? '编辑笔记' : '添加笔记'}</button><button type="button" data-action="sidebar">打开高亮笔记</button><button type="button" data-action="delete">删除</button><button type="button" data-action="close">关闭</button></div>`;
    popover.addEventListener('click', (event) => event.stopPropagation());
    popover.addEventListener('mouseup', (event) => event.stopPropagation());
    doc.body.appendChild(popover);
    positionInlineAnnotation(doc, popover, trigger);
    popover.querySelector('[data-action="close"]').addEventListener('click', () => closeInlineAnnotation(doc));
    popover.querySelector('[data-action="sidebar"]').addEventListener('click', () => { switchSidebar('annotations-panel'); closeInlineAnnotation(doc); });
    popover.querySelector('[data-action="convert"]').addEventListener('click', () => updateAnnotationKind(annotation, annotation.kind === 'underline' ? 'highlight' : 'underline', popover));
    popover.querySelector('[data-action="edit"]').addEventListener('click', () => beginAnnotationEdit(annotation, trigger, popover));
    popover.querySelector('[data-action="delete"]').addEventListener('click', () => deleteAnnotation(annotation));
    popover.querySelectorAll('[data-annotation-color]').forEach((button) => button.addEventListener('click', () => updateAnnotationColor(annotation, button.dataset.annotationColor, popover)));
  }

  async function updateAnnotationKind(annotation, kind, popover) {
    if (!state.activeJob || isAIAnnotation(annotation) || !['highlight', 'underline'].includes(kind)) return;
    const jobId = state.activeJob.job_id;
    const mount = readerMount;
    if (!readerMountMatches(mount)) return;
    const button = popover?.querySelector('[data-action="convert"]');
    if (button) button.disabled = true;
    try {
      const payload = await api(`/api/jobs/${jobId}/annotations/${annotation.id}`, jsonOptions({ kind }, 'PATCH'));
      if (!annotationOperations.applyResult(jobId, mount, payload)) return;
      const updated = state.annotations.find((item) => item.id === annotation.id) || payload.annotation;
      Object.assign(annotation, updated || { kind });
      renderFrameAnnotations();
      renderAnnotations();
      const trigger = annotationAnchor(frameDocument(), annotation.id);
      if (trigger) showInlineAnnotation(annotation, trigger);
      showToast(kind === 'underline' ? '已转为划线，颜色和笔记保持不变。' : '已转为高亮，颜色和笔记保持不变。');
    } catch (error) {
      if (!readerMountMatches(mount) || state.activeJob?.job_id !== jobId) return;
      showToast(error.message, true);
      if (button) button.disabled = false;
    }
  }

  async function updateAnnotationColor(annotation, color, popover) {
    if (!state.activeJob || isAIAnnotation(annotation)) return;
    const jobId = state.activeJob.job_id;
    const mount = readerMount;
    if (!readerMountMatches(mount)) return;
    const nextColor = normalizeAnnotationColor(color);
    const buttons = [...(popover?.querySelectorAll('[data-annotation-color]') || [])];
    buttons.forEach((button) => { button.disabled = true; });
    try {
      const payload = await api(`/api/jobs/${jobId}/annotations/${annotation.id}`, jsonOptions({ color: nextColor }, 'PATCH'));
      if (!annotationOperations.applyResult(jobId, mount, payload)) return;
      const updated = state.annotations.find((item) => item.id === annotation.id) || { ...annotation, color: nextColor };
      Object.assign(annotation, updated);
      frameDocument()?.querySelectorAll(`:is(mark, mrow)[data-annotation-id="${cssEscape(annotation.id)}"]`).forEach((mark) => applyAnnotationColor(mark, annotation));
      applyAnnotationTheme(popover, annotation);
      frameDocument()?.querySelectorAll(`.annotation-note-trigger[data-annotation-id="${cssEscape(annotation.id)}"]`).forEach((trigger) => applyAnnotationTheme(trigger, annotation));
      buttons.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.annotationColor === normalizeAnnotationColor(annotation.color))));
      rememberAnnotationColor(annotation.kind, nextColor);
      renderAnnotations();
    } catch (error) {
      if (!readerMountMatches(mount) || state.activeJob?.job_id !== jobId) return;
      setPanelStatus(error.message, true);
    } finally {
      if (readerMountMatches(mount)) buttons.forEach((button) => { button.disabled = false; });
    }
  }

  function annotationDrawRects(marks) {
    const rects = marks.flatMap((mark) => [...mark.getClientRects()])
      .filter((rect) => rect.width > 0 && rect.height > 0 && Number.isFinite(rect.left) && Number.isFinite(rect.top))
      .map((rect) => ({ left: rect.left, top: rect.top, width: rect.width, height: rect.height, bottom: rect.bottom }));
    rects.sort((a, b) => Math.abs(a.top - b.top) > 2 ? a.top - b.top : a.left - b.left);
    const lines = [];
    rects.forEach((rect) => {
      const previous = lines.at(-1);
      if (previous && Math.abs(previous.top - rect.top) <= 2 && Math.abs(previous.height - rect.height) <= 2 && rect.left <= previous.left + previous.width + 1) {
        previous.width = Math.max(previous.left + previous.width, rect.left + rect.width) - previous.left;
      } else lines.push(rect);
    });
    return lines;
  }

  function clearAnnotationDrawAnimation(doc = frameDocument()) {
    const drawing = doc && readerDocumentState(doc).annotationDraw;
    if (!drawing) return;
    readerDocumentState(doc).annotationDraw = null;
    drawing.animations.forEach((animation) => animation.cancel());
    drawing.marks.forEach((mark) => delete mark.dataset.annotationDrawing);
    drawing.layer.remove();
    drawing.observer?.disconnect();
    drawing.resizeObserver?.disconnect();
    doc.removeEventListener('scroll', drawing.cleanup, true);
    doc.defaultView?.removeEventListener('resize', drawing.cleanup);
    doc.defaultView?.removeEventListener('pagehide', drawing.cleanup);
    window.removeEventListener('resize', drawing.cleanup);
    reducedMotionQuery.removeEventListener?.('change', drawing.cleanup);
  }

  function playAnnotationDrawAnimation(annotation, doc = frameDocument()) {
    clearAnnotationDrawAnimation(doc);
    if (!doc || reducedMotionQuery.matches || !annotation?.id || isAIAnnotation(annotation)) return;
    readerDocumentState(doc).interlinear?.flush();
    const marks = [...doc.querySelectorAll(`:is(mark, mrow)[data-annotation-id="${cssEscape(annotation.id)}"]`)];
    const rects = annotationDrawRects(marks);
    if (!rects.length || !doc.defaultView?.Element?.prototype.animate) return;
    const appearance = doc.defaultView.getComputedStyle(marks[0]);
    const underline = annotation.kind === 'underline';
    const layer = doc.createElement('div');
    layer.className = 'annotation-draw-layer';
    layer.setAttribute('aria-hidden', 'true');
    const cleanup = () => {
      if (readerDocumentState(doc).annotationDraw === drawing) clearAnnotationDrawAnimation(doc);
    };
    const drawing = { layer, marks, animations: [], cleanup };
    readerDocumentState(doc).annotationDraw = drawing;
    const totalWidth = rects.reduce((sum, rect) => sum + rect.width, 0);
    let elapsed = 0;
    rects.forEach((rect) => {
      const stroke = doc.createElement('span');
      stroke.className = 'annotation-draw-stroke';
      Object.assign(stroke.style, {
        left: `${rect.left}px`, top: `${underline ? rect.bottom - 1 : rect.top}px`,
        width: `${rect.width}px`, height: `${underline ? 2 : rect.height}px`,
        backgroundColor: underline ? appearance.textDecorationColor : appearance.backgroundColor,
        boxShadow: underline ? 'none' : appearance.boxShadow,
      });
      layer.append(stroke);
      const duration = 400 * rect.width / totalWidth;
      drawing.animations.push(stroke.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration, delay: elapsed, easing: 'ease-out', fill: 'both' }));
      elapsed += duration;
    });
    marks.forEach((mark) => { mark.dataset.annotationDrawing = 'true'; });
    doc.body.append(layer);
    doc.addEventListener('scroll', cleanup, { passive: true, capture: true });
    doc.defaultView.addEventListener('resize', cleanup, { passive: true });
    doc.defaultView.addEventListener('pagehide', cleanup, { passive: true });
    window.addEventListener('resize', cleanup, { passive: true });
    reducedMotionQuery.addEventListener?.('change', cleanup);
    const content = doc.querySelector('.reader-content');
    if (doc.defaultView.MutationObserver && content) {
      drawing.observer = new doc.defaultView.MutationObserver(cleanup);
      drawing.observer.observe(content, { childList: true, characterData: true, subtree: true });
    }
    if (doc.defaultView.ResizeObserver && content) {
      const initialRects = JSON.stringify(rects);
      drawing.resizeObserver = new doc.defaultView.ResizeObserver(() => {
        if (JSON.stringify(annotationDrawRects(marks)) !== initialRects) cleanup();
      });
      drawing.resizeObserver.observe(content);
    }
    // The animation timeline can start after this task, so a wall-clock timer
    // can cancel the last stroke before it has finished drawing.
    Promise.all(drawing.animations.map((animation) => animation.finished)).then(cleanup, cleanup);
  }

  function renderFrameAnnotations() {
    const doc = frameDocument(); if (!doc?.querySelector('.reader-content')) return;
    const documentState = readerDocumentState(doc);
    const annotationsKey = JSON.stringify([state.annotations, state.aiHighlights, state.highlightColor]);
    if (documentState.annotationsKey === annotationsKey) {
      updateAnnotationAnchorStatus(documentState.unresolvedAnnotations);
      return;
    }
    clearAnnotationDrawAnimation(doc);
    closeInlineAnnotation(doc, { immediate: true });
    doc.querySelectorAll('.annotation-note-trigger, :is(mark, mrow)[data-annotation-id]').forEach((node) => {
      if (node.classList.contains('annotation-note-trigger')) node.remove();
      else removeMark(node.dataset.annotationId);
    });
    const visualAnnotations = new Map();
    const manualTargets = new Set(state.annotations
      .filter((annotation) => !isAIAnnotation(annotation))
      .map((annotation) => `${annotation.block_id || ''}\u0000${annotation.quote || ''}`));
    state.annotations.forEach((annotation) => {
      if (isAIAnnotation(annotation) && (!isCurrentAISuggestion(annotation) || isIgnoredAISuggestion(annotation))) return;
      const target = `${annotation.block_id || ''}\u0000${annotation.quote || ''}`;
      if (isAIAnnotation(annotation) && manualTargets.has(target)) return;
      const start = Number(annotation.start);
      const end = Number(annotation.end);
      const preciseAnchor = !isAIAnnotation(annotation) && Number.isFinite(start) && Number.isFinite(end) && end > start;
      const key = preciseAnchor
        ? `${target}\u0000${annotation.surface || ''}\u0000${annotation.source_block_id || ''}\u0000${annotation.page ?? ''}\u0000${start}\u0000${end}\u0000${annotation.kind || ''}\u0000${annotation.action_id || ''}`
        : `${isAIAnnotation(annotation) ? 'ai' : 'manual'}\u0000${target}\u0000${annotation.kind || ''}\u0000${annotation.action_id || ''}`;
      visualAnnotations.set(key, annotation);
    });
    const unresolvedIds = new Set();
    visualAnnotations.forEach((annotation) => {
      if (!applyMark(annotation) && !isAIAnnotation(annotation)) unresolvedIds.add(annotation.id);
    });
    documentState.annotationsKey = annotationsKey;
    documentState.unresolvedAnnotationIds = unresolvedIds;
    documentState.unresolvedAnnotations = unresolvedIds.size;
    updateAnnotationAnchorStatus(unresolvedIds.size);
    scheduleInterlinearTranslations(doc);
    if (readerSearchState.open && doc === frameDocument()) refreshReaderSearch();
  }

  function updateAnnotationAnchorStatus(unresolved) {
    const annotationStatus = $('#annotation-anchor-status');
    if (annotationStatus) {
      annotationStatus.hidden = unresolved === 0;
      annotationStatus.textContent = unresolved ? `${unresolved} 条标注在当前排版中无法唯一定位，原文与笔记均已保留。` : '';
    }
  }

  async function saveAnnotation(kind, { withNote = false, action = null } = {}) {
    if (!state.activeJob || !state.selection) return;
    const selectionTarget = state.selection;
    const selection = { ...selectionTarget };
    if (!selection.block_id || !Number.isFinite(selection.start) || !Number.isFinite(selection.end)) {
      clearSelectionPopover({ clearState: true });
      showToast('无法定位选区。请在同一正文段落内重新选择。', true);
      return;
    }
    const doc = frameDocument();
    const root = doc?.querySelector(`[data-block-id="${cssEscape(selection.block_id)}"]`);
    const group = selection.surface === 'translation' && selection.block_id === `translation-${selection.source_block_id}` ? translationAnnotationGroup(selection.source_block_id, doc) : null;
    const preflightRange = group ? translationGroupAnchor(group, selection.start, selection.end, doc) : root ? rangeAtOffsets(root, selection.start, selection.end, doc) : null;
    const preflightText = group ? group.text : root ? canonicalBlockText(root, doc) : '';
    if (!preflightRange || preflightText.slice(selection.start, selection.end) !== selection.quote) {
      clearSelectionPopover({ clearState: true });
      showToast('这个选区包含暂时无法稳定定位的内容，请重新选择后再试。', true);
      return;
    }
    const jobId = state.activeJob.job_id;
    const mount = readerMount;
    if (!readerMountMatches(mount)) return;
    const existingAnnotationIds = new Set(state.annotations.map((annotation) => annotation.id));
    let note = '';
    try {
      const payload = await api(`/api/jobs/${jobId}/annotations`, jsonOptions({ ...selection, kind, note, category: 'method', color: action?.color || annotationColorFor(kind), source: 'manual', ...(action ? { action_id: action.id, label: action.label } : {}) }));
      if (!annotationOperations.applyResult(jobId, mount, payload, { defaultEmpty: true })) return;
      const currentTarget = state.selection;
      renderFrameAnnotations();
      renderAnnotations();
      if (currentTarget === selectionTarget) clearSelectionPopover({ clearState: true, immediate: true });
      const saved = state.annotations.find((item) => item.id === payload.annotation?.id) || payload.annotation;
      if (saved && !annotationAnchor(frameDocument(), saved.id)) {
        showToast('标注已保存，但当前页面无法显示它；重新打开文献后可再次定位。', true);
        return;
      }
      if (saved && !existingAnnotationIds.has(saved.id)) playAnnotationDrawAnimation(saved, doc);
      if (withNote) {
        const annotation = saved;
        const trigger = annotation && frameDocument()?.querySelector(`.annotation-note-trigger[data-annotation-id="${cssEscape(annotation.id)}"]`);
        if (annotation && trigger) showInlineAnnotation(annotation, trigger);
        if (annotation && trigger) {
          const popover = frameDocument()?.querySelector('.annotation-note-popover');
          if (popover) beginAnnotationEdit(annotation, trigger, popover);
        }
      }
    } catch (error) {
      if (!readerMountMatches(mount) || state.activeJob?.job_id !== jobId) return;
      setPanelStatus(error.message, true);
    }
  }
  function applyAnnotationActionSync(sync) {
    if (!annotationOperations.applyStyleSync(sync)) return;
    renderAnnotations();
    renderFrameAnnotations();
  }

  const builtinAnnotationActions = { highlight: '高亮', highlight_note: '高亮笔记', underline: '划线', underline_note: '划线随笔', copy: '复制', chat: '加入 Chat' };
  function normalizeAnnotationActions(value) {
    return {
      show_shortcut_hints: value?.show_shortcut_hints !== false,
      hidden_builtin: Array.isArray(value?.hidden_builtin) ? value.hidden_builtin.filter((key) => key in builtinAnnotationActions) : [],
      custom: Array.isArray(value?.custom) ? value.custom.map((item) => ({ id: String(item.id || ''), label: String(item.label || '').slice(0, 40), kind: item.kind === 'underline' ? 'underline' : 'highlight', color: normalizeAnnotationColor(item.color), enabled: item.enabled !== false })).filter((item) => item.id && item.label) : [],
    };
  }
  const selectionNumberKeys = '1234567890';
  let selectionNumberSaveTarget = null;

  function selectionNumberActions() {
    return [
      ...Object.keys(builtinAnnotationActions).map((builtin) => ({ builtin })),
      ...state.annotationActions.custom.filter((action) => action.enabled && action.label).map((action) => ({ action })),
    ].slice(0, selectionNumberKeys.length);
  }

  function handleSelectionNumberShortcut(event) {
    if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229
      || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || !/^[0-9]$/u.test(event.key)
      || isEditableAppSurface(event.target) || $('dialog[open]') || !readerShortcutReady()) return false;
    const target = activeSelectionActionTarget();
    const entry = target && selectionNumberActions()[selectionNumberKeys.indexOf(event.key)];
    if (!entry) return false;
    event.preventDefault();
    if (entry.builtin === 'copy' || entry.builtin === 'chat') {
      $(`[data-builtin-action="${entry.builtin}"]`)?.click();
      return true;
    }
    if (selectionNumberSaveTarget === target) return true;
    selectionNumberSaveTarget = target;
    const kind = entry.action?.kind || (entry.builtin.startsWith('underline') ? 'underline' : 'highlight');
    void saveAnnotation(kind, entry.action ? { action: entry.action } : { withNote: entry.builtin.endsWith('_note') }).finally(() => {
      if (selectionNumberSaveTarget === target) selectionNumberSaveTarget = null;
    });
    return true;
  }

  function renderSelectionActions() {
    const showHints = state.annotationActions.show_shortcut_hints !== false;
    $('#selection-popover')?.classList.toggle('hide-shortcut-hints', !showHints);
    const shortcutSettings = $('#selection-shortcut-settings');
    if (shortcutSettings) shortcutSettings.hidden = !showHints;
    $$('[data-builtin-action]').forEach((button) => {
      const builtin = button.dataset.builtinAction;
      button.hidden = state.annotationActions.hidden_builtin.includes(builtin);
      const key = selectionNumberKeys[Object.keys(builtinAnnotationActions).indexOf(builtin)];
      button.dataset.selectionShortcut = key;
      button.setAttribute('aria-keyshortcuts', key);
      button.title = `${builtinAnnotationActions[builtin]}${showHints ? `（${key}）` : ''}`;
    });
    const vocabularyButton = $('#selection-add-vocabulary');
    if (vocabularyButton) {
      vocabularyButton.hidden = !pluginHost.selectionActions().some((action) => action.pluginId === 'guzi.vocabulary' && action.id === 'keep');
      const source = state.selection?.surface !== 'translation';
      vocabularyButton.disabled = !source || !window.MyScholarCore.validSelectionTerm(state.selection?.quote);
      vocabularyButton.title = !source ? '请在原文中选择单词或短语。' : '保存词条、原句及来源；支持不超过 120 字符且无换行的短语。';
    }
    const pluginActions = $('#selection-plugin-actions');
    if (pluginActions) {
      const actions = pluginHost.selectionActions().filter((action) => action.pluginId !== 'guzi.vocabulary' || action.id !== 'keep');
      pluginActions.hidden = !actions.length;
      pluginActions.innerHTML = actions.map((action) => `<button type="button" data-plugin-selection="${escapeHTML(action.pluginId)}" data-plugin-action="${escapeHTML(action.id)}"${!state.selection ? ' disabled' : ''}>${escapeHTML(action.title)}</button>`).join('');
    }
    const container = $('#selection-custom-actions');
    if (!container) return;
    const actions = state.annotationActions.custom.filter((item) => item.enabled && item.label);
    container.hidden = !actions.length;
    container.innerHTML = actions.map((item, index) => {
      const key = selectionNumberKeys[index + Object.keys(builtinAnnotationActions).length];
      const title = `${item.label}${showHints && key ? `（${key}）` : ''}`;
      return `<button type="button" data-semantic-action="${escapeHTML(item.id)}"${key ? ` data-selection-shortcut="${key}" aria-keyshortcuts="${key}"` : ''} title="${escapeHTML(title)}" style="--semantic-color:${normalizeAnnotationColor(item.color)}"><span class="semantic-action-swatch" aria-hidden="true"></span><span class="selection-action-label">${escapeHTML(item.label)}</span></button>`;
    }).join('');
  }
  function renderAnnotationActionSettings() {
    $('#setting-selection-shortcut-hints').checked = state.annotationActions.show_shortcut_hints !== false;
    $('#setting-annotation-builtins').innerHTML = Object.entries(builtinAnnotationActions).map(([key, label]) => `<label class="settings-toggle"><span>${label}</span><input type="checkbox" data-annotation-builtin="${key}"${state.annotationActions.hidden_builtin.includes(key) ? '' : ' checked'}></label>`).join('');
    $('#setting-annotation-custom').innerHTML = state.annotationActions.custom.map((item) => `
      <div class="annotation-action-row" data-annotation-action-id="${escapeHTML(item.id)}">
        <input class="annotation-action-name" type="text" data-action-field="label" maxlength="40" value="${escapeHTML(item.label)}" placeholder="标记名称，例如原理段落" aria-label="语义名称">
        <div class="annotation-action-style"><select data-action-field="kind" aria-label="标记样式"><option value="highlight"${item.kind === 'highlight' ? ' selected' : ''}>高亮</option><option value="underline"${item.kind === 'underline' ? ' selected' : ''}>划线</option></select></div>
        <input type="color" data-action-field="color" value="${normalizeAnnotationColor(item.color)}" aria-label="标记颜色" title="标记颜色">
        <label class="settings-toggle annotation-action-enabled"><span>显示</span><input type="checkbox" data-action-field="enabled"${item.enabled ? ' checked' : ''} aria-label="显示语义标记"></label>
        <button type="button" class="toolbar-icon-button annotation-action-remove" data-remove-annotation-action aria-label="删除语义标记" title="删除标记"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m-9 0 1 13h10l1-13M10 11v5M14 11v5"></path></svg></button>
      </div>`).join('');
  }
  $('#setting-selection-shortcut-hints')?.addEventListener('change', (event) => {
    state.annotationActions.show_shortcut_hints = event.target.checked;
    renderSelectionActions();
  });
  $('#selection-shortcut-settings')?.addEventListener('click', () => {
    switchView('settings-view');
    showSettingsSection('settings-shortcuts');
    window.requestAnimationFrame(() => $('#setting-selection-shortcut-hints')?.focus());
  });
  $('#add-annotation-action')?.addEventListener('click', () => {
    if (state.annotationActions.custom.length >= 32) { showToast('最多添加 32 个语义标记。', true); return; }
    state.annotationActions.custom.push({ id: `action-${crypto.randomUUID()}`, label: '新标记', kind: 'highlight', color: '#f59e0b', enabled: true });
    renderAnnotationActionSettings();
    renderSelectionActions();
    queueSettingsSave(true);
    $('#setting-annotation-custom .annotation-action-row:last-child [data-action-field="label"]')?.focus();
  });
  $('#setting-annotation-builtins')?.addEventListener('change', (event) => {
    const key = event.target.dataset.annotationBuiltin;
    if (!key) return;
    state.annotationActions.hidden_builtin = Object.keys(builtinAnnotationActions).filter((name) => !$(`[data-annotation-builtin="${name}"]`).checked);
    renderSelectionActions();
  });
  $('#setting-annotation-custom')?.addEventListener('input', (event) => {
    const row = event.target.closest('[data-annotation-action-id]');
    const action = state.annotationActions.custom.find((item) => item.id === row?.dataset.annotationActionId);
    const field = event.target.dataset.actionField;
    if (!action || !field) return;
    action[field] = field === 'enabled' ? event.target.checked : event.target.value;
    renderSelectionActions();
  });
  $('#setting-annotation-custom')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove-annotation-action]');
    if (!button) return;
    const id = button.closest('[data-annotation-action-id]').dataset.annotationActionId;
    state.annotationActions.custom = state.annotationActions.custom.filter((item) => item.id !== id);
    renderAnnotationActionSettings();
    renderSelectionActions();
    queueSettingsSave(true);
  });
  $('#selection-custom-actions')?.addEventListener('click', (event) => {
    const action = state.annotationActions.custom.find((item) => item.id === event.target.closest('[data-semantic-action]')?.dataset.semanticAction);
    if (action) void saveAnnotation(action.kind, { action });
  });
  $('#selection-copy')?.addEventListener('click', async () => {
    if (!state.selection?.quote) return;
    try { await navigator.clipboard.writeText(state.selection.quote); showToast('已复制选区。'); }
    catch (error) { showToast(`复制失败：${error.message}`, true); }
  });
  $('#selection-highlight').addEventListener('click', () => saveAnnotation('highlight'));
  $('#selection-highlight-note').addEventListener('click', () => saveAnnotation('highlight', { withNote: true }));
  $('#selection-underline').addEventListener('click', () => saveAnnotation('underline'));
  $('#selection-underline-note').addEventListener('click', () => saveAnnotation('underline', { withNote: true }));
  $('#selection-add-chat').addEventListener('click', () => {
    if (!state.selection) return;
    state.chatSelection = { kind: 'text', selection: { ...state.selection } };
    switchSidebar('chat-panel');
    renderSelectedContext();
    $('#chat-input').focus();
    clearSelectionPopover({ immediate: true });
  });

  function escapeAnnotationMarkdownText(value) {
    return String(value || '').replace(/\\/g, '\\\\').replace(/([*_`[\]])/g, '\\$1');
  }

  function escapeAnnotationMarkdownBlockStart(value) {
    return String(value || '')
      .replace(/^(\s*)(#{1,3})(?=\s)/gmu, '$1\\$2')
      .replace(/^(\s*)([-+>])(?=\s)/gmu, '$1\\$2')
      .replace(/^(\s*\d+)([.)])(?=\s)/gmu, '$1\\$2');
  }

  const zoteroNoteMarkerPattern = /^<!-- (zotero-(?:note|unanchored):[a-f0-9]{32}) -->$/;
  function zoteroNoteMarkerMarkdown(node) {
    if (node.nodeType !== Node.COMMENT_NODE) return '';
    const marker = `<!--${node.nodeValue}-->`;
    return zoteroNoteMarkerPattern.test(marker) ? marker : '';
  }

  // Colour names rather than hex: the renderer whitelist stays a finite enum,
  // and each token maps to a CSS variable that follows the light/dark theme.
  const NOTE_COLOR_TOKENS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'];
  const NOTE_COLOR_PATTERN = NOTE_COLOR_TOKENS.join('|');
  function noteColorToken(value, fallback = '') {
    const token = String(value || '').trim().toLowerCase();
    return NOTE_COLOR_TOKENS.includes(token) ? token : fallback;
  }
  function noteInlineTex(node) {
    if (node?.nodeType !== Node.ELEMENT_NODE) return '';
    return String(node.getAttribute('data-tex') || '').trim();
  }

  const noteAssetRefPattern = /^assets\/[a-f0-9]{64}\.(?:png|jpg|webp|gif)$/i;
  function noteAssetRefFromImage(node) {
    const stored = String(node?.dataset?.noteAsset || '');
    if (noteAssetRefPattern.test(stored)) return stored;
    const source = String(node?.getAttribute?.('src') || '');
    const match = source.match(/\/content\/notes\/(assets\/[a-f0-9]{64}\.(?:png|jpg|webp|gif))(?:[?#].*)?$/i);
    return match?.[1] || '';
  }

  function annotationInlineMarkdown(node) {
    if (node.nodeType === Node.TEXT_NODE) return escapeAnnotationMarkdownText(node.nodeValue);
    if (node.nodeType === Node.COMMENT_NODE) {
      const marker = zoteroNoteMarkerMarkdown(node);
      return marker ? `\n\n${marker}\n\n` : '';
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const tag = node.tagName.toLowerCase();
    const tex = noteInlineTex(node);
    if (tex) return node.classList.contains('math-display') ? `$$${tex}$$` : `$${tex}$`;
    const content = [...node.childNodes].map(annotationInlineMarkdown).join('');
    if (tag === 'br') return '\n';
    if (tag === 'strong' || tag === 'b') return content ? `**${content}**` : '';
    if (tag === 'em' || tag === 'i') return content ? `*${content}*` : '';
    if (tag === 'del' || tag === 's' || tag === 'strike') return content ? `~~${content}~~` : '';
    if (tag === 'mark') return content ? `<mark data-color="${noteColorToken(node.dataset.color, 'yellow')}">${content}</mark>` : '';
    if (tag === 'span' && noteColorToken(node.dataset.color)) {
      return content ? `<span data-color="${noteColorToken(node.dataset.color)}">${content}</span>` : '';
    }
    if (tag === 'code') return `\`${String(node.textContent || '').replace(/`/g, '\\`')}\``;
    if (tag === 'a') {
      const href = String(node.getAttribute('href') || '').trim();
      return /^https?:\/\//i.test(href) && content ? `[${content}](${href})` : content;
    }
    if (tag === 'img') {
      const source = String(node.getAttribute('src') || '');
      const assetRef = noteAssetRefFromImage(node);
      if (assetRef) return `![${escapeAnnotationMarkdownText(node.getAttribute('alt') || '')}](${assetRef})`;
      return /^data:image\/[a-z0-9.+-]+;base64,/i.test(source) ? `![${escapeAnnotationMarkdownText(node.getAttribute('alt') || '')}](${source})` : '';
    }
    return content;
  }

  const NOTE_BLOCK_TAGS = new Set([
    'p', 'div', 'ul', 'ol', 'li', 'pre', 'blockquote', 'hr', 'details',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article', 'figure', 'table',
  ]);

  function noteHasBlockChild(node) {
    return [...node.childNodes].some(
      (child) => child.nodeType === Node.ELEMENT_NODE && NOTE_BLOCK_TAGS.has(child.tagName.toLowerCase()),
    );
  }

  function annotationBlockMarkdown(node) {
    if (node.nodeType === Node.TEXT_NODE) return escapeAnnotationMarkdownBlockStart(escapeAnnotationMarkdownText(node.nodeValue).trim());
    if (node.nodeType === Node.COMMENT_NODE) return zoteroNoteMarkerMarkdown(node);
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const tag = node.tagName.toLowerCase();
    const tex = noteInlineTex(node);
    if (tex) return `$$${tex}$$`;
    const content = [...node.childNodes].map(annotationInlineMarkdown).join('').trim();
    if (['strong', 'b', 'em', 'i', 'del', 's', 'mark', 'span', 'code', 'a', 'img'].includes(tag)) return annotationInlineMarkdown(node).trim();
    if (/^h[1-3]$/.test(tag)) return `${'#'.repeat(Number(tag[1]))} ${content}`;
    if (tag === 'hr') return '---';
    if (tag === 'blockquote') return content.split('\n').map((line) => `> ${line}`).join('\n');
    if (tag === 'ul' || tag === 'ol') {
      const todo = tag === 'ul' && node.classList.contains('note-todo');
      return [...node.children].filter((item) => item.tagName === 'LI').map((item, index) => {
        const text = [...item.childNodes]
          .filter((child) => !(child.nodeType === Node.ELEMENT_NODE && child.tagName === 'INPUT'))
          .map(annotationInlineMarkdown).join('').trim();
        if (todo) return `- [${item.dataset.checked === 'true' ? 'x' : ' '}] ${text}`;
        return `${tag === 'ol' ? `${index + 1}.` : '-'} ${text}`;
      }).join('\n');
    }
    if (tag === 'details') {
      const summary = [...node.children].find((child) => child.tagName === 'SUMMARY');
      const title = summary ? [...summary.childNodes].map(annotationInlineMarkdown).join('').trim() : '';
      const body = [...node.childNodes]
        .filter((child) => child !== summary)
        .map(annotationBlockMarkdown).filter(Boolean).join('\n\n');
      return `<details><summary>${title}</summary>\n\n${body}\n\n</details>`;
    }
    if (tag === 'pre') {
      const code = [...node.children].find((child) => child.tagName === 'CODE');
      const language = String(code?.className || '').match(/language-([\w+#.-]+)/)?.[1] || '';
      return `\`\`\`${language}\n${String(node.textContent || '').replace(/\n+$/, '')}\n\`\`\``;
    }
    if (tag === 'br') return '';
    // execCommand nests the list it creates inside the paragraph it replaced
    // (`<p><ol>…</ol></p>`), so a container holding blocks has to recurse.
    // Flattening it through the inline path would drop the list entirely.
    if (noteHasBlockChild(node)) {
      return [...node.childNodes].map(annotationBlockMarkdown).filter(Boolean).join('\n\n');
    }
    return escapeAnnotationMarkdownBlockStart(content);
  }

  function annotationEditorMarkdown(editor) {
    return [...editor.childNodes]
      .map(annotationBlockMarkdown)
      .filter((value) => value !== '')
      .join('\n\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function insertPlainTextAtSelection(editor, value) {
    const doc = editor.ownerDocument;
    const selection = doc.getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    const anchor = selection.anchorNode?.nodeType === Node.ELEMENT_NODE ? selection.anchorNode : selection.anchorNode?.parentElement;
    if (anchor !== editor && !editor.contains(anchor)) return;
    range.deleteContents();
    const fragment = doc.createDocumentFragment();
    let lastNode = null;
    String(value || '').split('\n').forEach((line, index) => {
      if (index) { lastNode = doc.createElement('br'); fragment.appendChild(lastNode); }
      if (line) { lastNode = doc.createTextNode(line); fragment.appendChild(lastNode); }
    });
    if (!lastNode) lastNode = doc.createTextNode('');
    if (!lastNode.parentNode) fragment.appendChild(lastNode);
    range.insertNode(fragment);
    range.setStartAfter(lastNode);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function beginAnnotationEdit(annotation, trigger, popover) {
    const doc = frameDocument();
    const mount = readerMount;
    const jobId = state.activeJob?.job_id;
    if (!doc || !popover || !state.activeJob) return;
    const body = popover.querySelector('.annotation-note-popover-body');
    const actions = popover.querySelector('.annotation-note-popover-actions');
    if (!body || !actions) return;
    notePopoverHover.pinned = true;
    cancelNoteHoverClose();
    popover.classList.add('is-editing');
    const shell = doc.createElement('div');
    shell.className = 'annotation-note-editor-shell';
    const toolbar = doc.createElement('div');
    toolbar.className = 'annotation-note-formatbar';
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', '笔记格式');
    toolbar.innerHTML = `
      <button type="button" data-format="bold" title="加粗（${primaryShortcutLabel('B')}）" aria-label="加粗"><strong>B</strong></button>
      <button type="button" data-format="italic" title="斜体（${primaryShortcutLabel('I')}）" aria-label="斜体"><em>I</em></button>
      <button type="button" data-format="unordered-list" title="项目列表" aria-label="项目列表">• 列表</button>
      <button type="button" data-format="ordered-list" title="编号列表" aria-label="编号列表">1. 列表</button>
      <button type="button" data-format="blockquote" title="引用" aria-label="引用">引用</button>
      <button type="button" class="annotation-note-insert-image" title="插入图片" aria-label="插入图片">图片</button>
      <input class="annotation-note-image-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
    `;
    if (browserDemo) {
      const imageButton = toolbar.querySelector('.annotation-note-insert-image');
      imageButton.disabled = true;
      imageButton.title = '浏览器本地测试版不上传图片，可继续编辑文字笔记。';
    }
    const editor = doc.createElement('div');
    editor.className = 'annotation-note-editor';
    editor.contentEditable = 'true';
    editor.setAttribute('role', 'textbox');
    editor.setAttribute('aria-label', '重点笔记内容');
    editor.setAttribute('aria-multiline', 'true');
    editor.setAttribute('spellcheck', 'true');
    editor.dataset.placeholder = '记录你的想法…';
    editor.innerHTML = renderMarkdown(annotation.note || '');
    const updateEmptyState = () => editor.classList.toggle('is-empty', !editor.textContent.trim() && !editor.querySelector('img'));
    updateEmptyState();
    shell.append(toolbar, editor);
    body.replaceChildren(shell);
    editor.addEventListener('input', updateEmptyState);

    const selectionRange = () => {
      const selection = doc.getSelection();
      if (!selection?.rangeCount) return null;
      const range = selection.getRangeAt(0);
      const anchor = selection.anchorNode?.nodeType === Node.ELEMENT_NODE ? selection.anchorNode : selection.anchorNode?.parentElement;
      return anchor === editor || editor.contains(anchor) ? range.cloneRange() : null;
    };
    let savedRange = null;
    const restoreRange = (range) => {
      const selection = doc.getSelection();
      const nextRange = range || doc.createRange();
      if (!range) {
        nextRange.selectNodeContents(editor);
        nextRange.collapse(false);
      }
      selection.removeAllRanges();
      selection.addRange(nextRange);
      return nextRange;
    };
    const insertImage = async (file, range = savedRange) => {
      if (!file || !readerMountMatches(mount) || !editor.isConnected || !popover.contains(editor)) return;
      const imageButton = toolbar.querySelector('.annotation-note-insert-image');
      imageButton.disabled = true;
      imageButton.textContent = '上传中…';
      try {
        const asset = await uploadNoteAsset(file, jobId);
        if (!readerMountMatches(mount) || state.activeJob?.job_id !== jobId || !editor.isConnected || !popover.contains(editor)) return;
        const activeRange = restoreRange(range);
        activeRange.deleteContents();
        const image = doc.createElement('img');
        image.src = asset.url;
        image.alt = file.name || '笔记图片';
        image.dataset.noteAsset = asset.ref;
        const spacer = doc.createElement('br');
        activeRange.insertNode(spacer);
        activeRange.insertNode(image);
        const nextRange = doc.createRange();
        nextRange.setStartAfter(spacer);
        nextRange.collapse(true);
        const selection = doc.getSelection();
        selection.removeAllRanges();
        selection.addRange(nextRange);
        updateEmptyState();
        showToast('图片已插入笔记。');
      } catch (error) {
        if (readerMountMatches(mount)) showToast(error.message, true);
      } finally {
        if (readerMountMatches(mount) && editor.isConnected) {
          imageButton.disabled = false;
          imageButton.textContent = '图片';
          toolbar.querySelector('.annotation-note-image-input').value = '';
        }
      }
    };

    const formatCommands = {
      bold: ['bold'],
      italic: ['italic'],
      'unordered-list': ['insertUnorderedList'],
      'ordered-list': ['insertOrderedList'],
      blockquote: ['formatBlock', 'blockquote'],
    };
    toolbar.querySelectorAll('[data-format]').forEach((button) => {
      button.addEventListener('mousedown', (event) => { event.preventDefault(); savedRange = selectionRange() || savedRange; });
      button.addEventListener('click', () => {
        editor.focus();
        restoreRange(savedRange);
        const [command, value] = formatCommands[button.dataset.format] || [];
        if (command) doc.execCommand(command, false, value || null);
        savedRange = selectionRange();
        updateEmptyState();
      });
    });
    const imageButton = toolbar.querySelector('.annotation-note-insert-image');
    const imageInput = toolbar.querySelector('.annotation-note-image-input');
    imageButton.addEventListener('mousedown', (event) => { event.preventDefault(); savedRange = selectionRange() || savedRange; });
    imageButton.addEventListener('click', () => imageInput.click());
    imageInput.addEventListener('change', () => insertImage(imageInput.files?.[0], selectionRange() || savedRange));
    editor.addEventListener('paste', (event) => {
      const image = clipboardImageFile(event.clipboardData);
      if (image) {
        event.preventDefault();
        savedRange = selectionRange();
        insertImage(image, savedRange);
        return;
      }
      event.preventDefault();
      insertPlainTextAtSelection(editor, event.clipboardData?.getData('text/plain') || '');
      updateEmptyState();
    });
    actions.innerHTML = '<button type="button" data-action="save-note">保存笔记</button><button type="button" data-action="cancel-edit">取消</button><button type="button" data-action="delete">删除</button><button type="button" data-action="close">关闭</button>';
    const save = () => editAnnotationNote(annotation, annotationEditorMarkdown(editor), trigger);
    actions.querySelector('[data-action="save-note"]').addEventListener('click', save);
    actions.querySelector('[data-action="cancel-edit"]').addEventListener('click', () => showInlineAnnotation(annotation, trigger));
    actions.querySelector('[data-action="delete"]').addEventListener('click', () => deleteAnnotation(annotation));
    actions.querySelector('[data-action="close"]').addEventListener('click', () => closeInlineAnnotation(doc));
    editor.addEventListener('keydown', (event) => {
      const modifier = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (modifier && key === 'a') {
        event.preventDefault();
        const range = doc.createRange();
        range.selectNodeContents(editor);
        const selection = doc.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      } else if (modifier && (key === 'b' || key === 'i')) {
        event.preventDefault();
        doc.execCommand(key === 'b' ? 'bold' : 'italic', false, null);
      } else if (modifier && event.key === 'Enter') {
        event.preventDefault();
        save();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        showInlineAnnotation(annotation, trigger);
      }
    });
    editor.focus();
    savedRange = selectionRange();
  }

  async function editAnnotationNote(annotation, note, trigger) {
    if (!state.activeJob) return;
    const jobId = state.activeJob.job_id;
    const mount = readerMount;
    if (!readerMountMatches(mount)) return;
    try {
      const payload = await api(`/api/jobs/${jobId}/annotations/${annotation.id}`, jsonOptions({ note }, 'PATCH'));
      if (!annotationOperations.applyResult(jobId, mount, payload)) return;
      renderAnnotations();
      renderFrameAnnotations();
      const refreshed = state.annotations.find((item) => item.id === annotation.id) || annotation;
      const refreshedTrigger = frameDocument()?.querySelector(`.annotation-note-trigger[data-annotation-id="${cssEscape(annotation.id)}"]`);
      if (refreshedTrigger) showInlineAnnotation(refreshed, refreshedTrigger);
    } catch (error) {
      if (!readerMountMatches(mount) || state.activeJob?.job_id !== jobId) return;
      setPanelStatus(error.message, true);
    }
  }

  async function deleteAnnotation(annotation) {
    if (!state.activeJob || !annotation?.id) return;
    const jobId = state.activeJob.job_id;
    const mount = readerMount;
    if (!readerMountMatches(mount)) return;
    try {
      const payload = await api(`/api/jobs/${jobId}/annotations/${annotation.id}`, { method: 'DELETE' });
      if (!annotationOperations.applyResult(jobId, mount, payload, { deletedId: annotation.id })) return;
      closeInlineAnnotation();
      renderFrameAnnotations();
      renderAnnotations();
    } catch (error) {
      if (!readerMountMatches(mount) || state.activeJob?.job_id !== jobId) return;
      setPanelStatus(error.message, true);
    }
  }

  async function clearManualAnnotations() {
    if (!state.activeJob) return;
    const jobId = state.activeJob.job_id;
    const mount = readerMount;
    if (!readerMountMatches(mount)) return;
    const manualAnnotations = state.annotations.filter((item) => !isAIAnnotation(item));
    if (!manualAnnotations.length) return;
    const notedCount = manualAnnotations.filter(hasAnnotationNote).length;
    const confirmed = await requestConfirmation(
      `确定删除当前文献的 ${manualAnnotations.length} 条个人标注吗？其中 ${notedCount} 条包含笔记；正文中未列出的纯高亮和划线也会一并删除。AI 阅读重点不会受到影响。`,
      '清空全部个人标注',
    );
    if (!confirmed || !readerMountMatches(mount) || state.activeJob?.job_id !== jobId) return;
    const button = $('#clear-annotations-button');
    button.disabled = true;
    try {
      const payload = await api(`/api/jobs/${jobId}/annotations`, { method: 'DELETE' });
      if (!annotationOperations.applyResult(jobId, mount, payload, { defaultEmpty: true })) return;
      closeInlineAnnotation();
      renderAnnotations();
      renderFrameAnnotations();
      showToast(`已删除 ${payload.deleted ?? manualAnnotations.length} 条个人标注。`);
    } catch (error) {
      if (!readerMountMatches(mount) || state.activeJob?.job_id !== jobId) return;
      button.disabled = false;
      setPanelStatus(error.message, true);
    }
  }

  // Translation extraction, math placeholders, cache lookup and rendering.
  function translationErrorMessage(error) {
    const detail = String(error?.message || '未知错误').trim().replace(/^(?:翻译失败[：:]\s*)+/u, '');
    return `翻译失败：${detail || '未知错误'}`;
  }

  function hashText(value) {
    let hash = 2166136261;
    for (const char of String(value || '')) { hash ^= char.codePointAt(0); hash = Math.imul(hash, 16777619); }
    return (`00000000${(hash >>> 0).toString(16)}`).slice(-8);
  }

  function translationSourceIdentity({ text = '', formulas = [], markers = [], emphasis = [] }) {
    if (!formulas.length && !markers.length && !emphasis.length) return String(text);
    return JSON.stringify([
      String(text),
      formulas.map(({ token, tex, markup }) => [token, tex, markup || '']),
      markers.map(({ token, shape, tone }) => [token, shape, tone]),
      emphasis.map(({ index, style, tone }) => [index, style, tone || '']),
    ]);
  }

  function translationSourceHash(source) {
    return hashText(translationSourceIdentity(source));
  }

  function translationSourceMatches(record, source, allowUnhashed = false) {
    if (record.source_hash === translationSourceHash(source)) return true;
    const formulas = source.formulas || [];
    const stored = record.formulas || [];
    const legacyHash = hashText(source.text);
    if (record.source_hash && record.source_hash !== legacyHash && (formulas.length || source.markers?.length || source.emphasis?.length)) return false;
    const sourceMatches = record.source_hash === legacyHash
      || String(record.source_text || '') === source.text;
    if (!sourceMatches && !(allowUnhashed && !record.source_hash && !formulas.length && !stored.length)) return false;
    // Old hashes ignored formula contents. Only reuse their tokenized prose
    // when every formula can be checked against the current source.
    return stored.length === formulas.length && formulas.every((formula, index) => {
      const previous = stored[index];
      return previous.token === formula.token && previous.tex === formula.tex
        && (formula.tex !== '[公式原图]' || Boolean(previous.markup && previous.markup === formula.markup));
    });
  }

  function cachedTranslationForSource(blockId, source, targetLanguage = translationTargetLanguage(), jobId = state.activeJob?.job_id) {
    const cached = cachedTranslation(blockId, translationSourceHash(source), targetLanguage, jobId);
    if (cached) return cached;
    const legacy = cachedTranslation(blockId, hashText(source.text), targetLanguage, jobId);
    return legacy && translationSourceMatches(legacy, source) ? legacy : null;
  }

  function paragraphSource(block) {
    const saved = block?.translationSourceSnapshot;
    if (saved && saved.canonicalText === canonicalBlockText(block, block.ownerDocument)) return saved.source;
    // Extract from an inert document so copying inline images cannot reload their resources.
    const clone = block && document.createElement('template').content.ownerDocument.importNode(block, true);
    if (!clone) return { text: '', formulas: [], markers: [], emphasis: [] };
    const formulas = [];
    const markers = [];
    const emphasis = [];
    clone.querySelectorAll('.paragraph-translate-trigger, .annotation-note-trigger, .annotation-note-popover, .reader-sentence-translation, .translation-retained-status, .translation-source-label').forEach((node) => node.remove());
    clone.querySelectorAll(':is(mark, mrow)[data-annotation-id]').forEach((mark) => mark.replaceWith(...mark.childNodes));
    clone.querySelectorAll('.inline-legend-marker').forEach((marker) => {
      const spec = inlineLegendMarkerSpec(marker);
      if (!spec) { marker.remove(); return; }
      const token = `__MY_SCHOLAR_MARKER_${markers.length}__`;
      markers.push({ token, ...spec });
      marker.replaceWith(` ${token} `);
    });
    repairEmphasisFragments(clone);
    clone.querySelectorAll('.math-token').forEach((token) => token.replaceWith(token.dataset.token || token.textContent || ''));
    clone.querySelectorAll('.math-source-visual, sup, sub').forEach((source) => {
      if (!clone.contains(source)) return;
      const token = `__MY_SCHOLAR_MATH_${formulas.length}__`;
      formulas.push({ token, tex: source.classList.contains('math-source-visual') ? '[公式原图]' : source.textContent || '', markup: source.outerHTML });
      source.replaceWith(source.matches('sup, sub') ? token : ` ${token} `);
    });
    clone.querySelectorAll('math').forEach((math) => {
      const annotation = math.querySelector('annotation[encoding="application/x-tex"]');
      const token = `__MY_SCHOLAR_MATH_${formulas.length}__`;
      formulas.push({ token, tex: annotation?.textContent || math.getAttribute('alttext') || math.textContent || '', markup: math.outerHTML });
      math.replaceWith(` ${token} `);
    });
    // Reverse document order processes descendants before their parents, so
    // replacing an outer style cannot detach an unprocessed inner style.
    [...clone.querySelectorAll('.pdf-text-tone, strong')].reverse().forEach((node) => {
      const spec = node.matches('strong') ? { style: 'bold' } : pdfTextToneSpec(node);
      if (!spec) { node.replaceWith(...node.childNodes); return; }
      const index = emphasis.length;
      const start = `__MY_SCHOLAR_BOLD_START_${index}__`;
      const end = `__MY_SCHOLAR_BOLD_END_${index}__`;
      emphasis.push(spec.style === 'bold' ? { index, style: 'bold' } : { index, style: 'color', tone: spec.tone });
      node.replaceWith(`${start}${node.textContent || ''}${end}`);
    });
    return { text: String(clone.innerText || clone.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 12000), formulas, markers, emphasis };
  }

  function paragraphText(block) {
    const source = paragraphSource(block);
    let text = source.text;
    source.markers.forEach((marker) => {
      const glyph = marker.shape === 'circle' ? '—●' : '—■';
      text = text.split(marker.token).join(`[${marker.tone} ${glyph}]`);
    });
    return text.replace(/__MY_SCHOLAR_BOLD_(?:START|END)_\d+__/g, '').replace(/\s+/g, ' ').trim();
  }

  function paragraphTranslationSource(block) {
    const source = paragraphSource(block);
    if (!block || !source.text) return source;
    const doc = block.ownerDocument;
    const segments = [];
    let formulaIndex = 0;
    let markerIndex = 0;
    const usedFormulas = new Set();
    for (const bounds of readerBlockSentenceSegments(block, doc)) {
      const range = rangeAtOffsets(block, bounds.start, bounds.end, doc);
      if (!range) return source;
      const fragment = doc.createElement('span');
      fragment.append(range.cloneContents());
      const sentence = paragraphSource(fragment);
      const formulaMap = sentence.formulas.map((formula) => {
        const index = source.formulas.findIndex((candidate, position) => !usedFormulas.has(position) && candidate.tex === formula.tex && candidate.markup === formula.markup);
        if (index >= 0) usedFormulas.add(index);
        return index;
      });
      if (formulaMap.some((index) => index < 0)) return source;
      const markerStart = markerIndex;
      const text = sentence.text.replace(/__MY_SCHOLAR_MATH_(\d+)__/g, (_token, index) => `__MY_SCHOLAR_MATH_${formulaMap[Number(index)]}__`)
        .replace(/__MY_SCHOLAR_MARKER_(\d+)__/g, (_token, index) => `__MY_SCHOLAR_MARKER_${markerStart + Number(index)}__`)
        .replace(/__MY_SCHOLAR_BOLD_(START|END)_(\d+)__/g, (_token, side, index) => {
          const spec = sentence.emphasis[Number(index)];
          const mapped = source.emphasis.findIndex((item) => item.style === spec?.style && item.tone === spec?.tone);
          return mapped < 0 ? '' : `__MY_SCHOLAR_BOLD_${side}_${mapped}__`;
        });
      formulaIndex += sentence.formulas.length;
      markerIndex += sentence.markers.length;
      if (!text.trim()) continue;
      segments.push({ id: `s${bounds.start}-${bounds.end}`, text });
    }
    // Never submit a partial formula tree or a truncated source as an aligned paragraph.
    if (!segments.length || formulaIndex !== source.formulas.length || markerIndex !== source.markers.length || source.text.length >= 12000) return source;
    return { ...source, segments, alignment_version: 'sentence-v1' };
  }

  function isMetadataParagraph(block) {
    if (!block || !block.matches('p')) return false;
    if (block.dataset.translationExcluded === 'metadata' || block.classList.contains('paper-metadata')) return true;
    // Older ODL/layout exports did not carry the metadata marker. On the
    // first page, author/affiliation lines are the short paragraphs before
    // the Abstract heading and normally contain an affiliation or URL.
    const page = block.closest('.pdf-page');
    if (!page || page.dataset.page !== '1') return false;
    const abstract = [...page.querySelectorAll('h1, h2, h3, h4, h5, h6')].find(isAbstractHeading)
      || [...page.querySelectorAll('p')].find((candidate) => hasInlineSectionLabel(candidate, inlineAbstractLabelPattern));
    if (!abstract || !(block.compareDocumentPosition(abstract) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
    const text = paragraphText(block);
    const paragraphsBefore = [...page.querySelectorAll('p')].indexOf(block);
    return paragraphsBefore >= 0 && paragraphsBefore < 3 && (paragraphsBefore < 2 || /\b(?:university|laboratory|institute|department|school|corporation)\b|https?:\/\/|@/i.test(text));
  }

  function translationTarget(blockId, doc = frameDocument()) {
    if (!doc || !blockId) return null;
    const selector = cssEscape(blockId);
    return doc.querySelector(`h1[data-translate-block-id="${selector}"], h1.paper-title[data-block-id="${selector}"]`)
      || doc.querySelector(`figcaption[data-translate-block-id="${selector}"]`)
      || doc.querySelector(`[data-block-id="${selector}"]`);
  }

  function protectInlineMath(text) {
    const formulas = [];
    const protectedText = String(text || '').replace(/\$(?!\$)(.+?)(?<!\$)\$|\\\((.+?)\\\)/g, (match, dollar, paren) => {
      const tex = dollar || paren;
      const token = `__MY_SCHOLAR_MATH_${formulas.length}__`;
      formulas.push({ token, tex });
      return token;
    });
    return { text: protectedText, formulas };
  }

  const SPECIAL_MATH_TOKEN_RE = /\[(?:I|T)(?:\\?_)?(?:CLS|SEP)\]/g;
  function protectSpecialTokens(text) {
    const tokens = [];
    const protectedText = String(text || '').replace(SPECIAL_MATH_TOKEN_RE, (match) => {
      const token = `__MY_SCHOLAR_SPECIAL_TOKEN_${tokens.length}__`;
      tokens.push({ token, value: match.replace(/\\_/g, '_') });
      return token;
    });
    return { text: protectedText, tokens };
  }
  function restoreSpecialTokens(text, tokens = []) {
    let value = String(text || '');
    tokens.forEach(({ token, value: original }) => { value = value.split(token).join(original); });
    return value;
  }

  function restoreInlineMath(text, formulas = []) {
    let value = String(text || '');
    formulas.forEach(({ token }, index) => { value = value.split(token).join(`__MY_SCHOLAR_RENDER_MATH_${index}__`); });
    return value;
  }

  function restoreInlineMarkers(text, markers = []) {
    let value = String(text || '');
    markers.forEach(({ token }, index) => { value = value.split(token).join(`__MY_SCHOLAR_RENDER_MARKER_${index}__`); });
    return value;
  }

  function repairFormulaTokens(text, formulas = []) {
    let value = String(text || '');
    formulas.forEach((formula) => {
      if (!formula?.token || value.includes(formula.token)) return;
      // A gateway may echo the TeX instead of the protected token. Convert
      // that echo back to the canonical token before the MathML renderer runs.
      const tex = String(formula.tex || '').trim();
      if (!tex) return;
      const delimited = [`$${tex}$`, `\\(${tex}\\)`, `$$${tex}$$`, `\\[${tex}\\]`];
      const wrapped = delimited.find((candidate) => value.includes(candidate));
      if (wrapped) { value = value.split(wrapped).join(formula.token); return; }
      const flexible = tex.split(/\s+/).filter(Boolean).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*');
      if (!flexible) return;
      try {
        const wrappedPattern = new RegExp(`(?:\\$+\\s*|\\\\(?:\\(|\\[)\\s*)${flexible}(?:\\s*\\$+|\\s*\\\\(?:\\)|\\]))`, 'g');
        const replaced = value.replace(wrappedPattern, formula.token);
        value = replaced === value && value.includes(tex) ? value.split(tex).join(formula.token) : replaced;
      } catch (_) { /* exact replacement above remains the safe fallback */ }
    });
    return value;
  }

  function translationMathNode(formula, doc) {
    if (!formula || !doc) return null;
    if (formula.markup) {
      const holder = doc.createElement('span');
      holder.innerHTML = String(formula.markup);
      const math = holder.querySelector('math');
      if (math) {
        math.classList.add('translation-math');
        if (formula.tex) math.setAttribute('aria-label', formula.tex);
        return math;
      }
      const source = holder.querySelector('.math-source-visual');
      const image = source?.querySelector('img.math-source-inline');
      if (image && safePreviewAssetURL(image.src)) {
        const copy = previewStructuredClone(source);
        if (copy) return doc.importNode(copy, true);
      }
      const script = holder.querySelector('sup, sub');
      if (script) {
        const copy = doc.createElement(script.localName);
        copy.textContent = script.textContent;
        return copy;
      }
    }
    const fallback = doc.createElement('span');
    fallback.className = 'math-fallback math-inline translation-math-fallback';
    fallback.setAttribute('aria-label', formula.tex || '公式');
    const code = doc.createElement('code');
    code.textContent = formula.tex || '';
    fallback.append(code);
    return fallback;
  }

  function renderTranslationText(text, formulas = [], doc = frameDocument(), markers = [], emphasis = []) {
    if (!doc) return null;
    const fragment = doc.createDocumentFragment();
    const value = String(text || '');
    const emphasisByIndex = new Map();
    for (const item of emphasis || []) {
      const index = Number(item?.index);
      if (!Number.isInteger(index) || index < 0) continue;
      if (item?.style === 'bold') emphasisByIndex.set(index, { style: 'bold' });
      if (item?.style === 'color' && PDF_TEXT_TONES.has(item?.tone)) {
        emphasisByIndex.set(index, { style: 'color', tone: item.tone });
      }
    }
    const hasEmphasisMetadata = emphasisByIndex.size > 0;
    const validEmphasis = new Set();
    const starts = new Map();
    value.replace(/__MY_SCHOLAR_BOLD_(START|END)_(\d+)__/g, (token, boundary, rawIndex, offset) => {
      const index = Number(rawIndex);
      if (boundary === 'START' && !starts.has(index)) starts.set(index, offset + token.length);
      if (boundary === 'END' && starts.has(index) && starts.get(index) <= offset) validEmphasis.add(index);
      return token;
    });
    const pattern = /__MY_SCHOLAR_RENDER_(MATH|MARKER)_(\d+)__|__MY_SCHOLAR_BOLD_(START|END)_(\d+)__|\$(?!\$)(.+?)(?<!\$)\$|\\\((.+?)\\\)/g;
    let cursor = 0;
    let target = fragment;
    const emphasisStack = [];
    let match;
    while ((match = pattern.exec(value))) {
      if (match.index > cursor) target.append(doc.createTextNode(value.slice(cursor, match.index)));
      if (match[3]) {
        const index = Number(match[4]);
        const spec = emphasisByIndex.get(index) || (!hasEmphasisMetadata ? { style: 'bold' } : null);
        if (!validEmphasis.has(index) || !spec) {
          target.append(doc.createTextNode(match[0]));
        } else if (match[3] === 'START') {
          const node = spec.style === 'color' ? pdfTextToneNode(spec, doc) : doc.createElement('strong');
          if (!node) { target.append(doc.createTextNode(match[0])); cursor = pattern.lastIndex; continue; }
          if (spec.style === 'bold') node.dataset.emphasisSource = 'translated-source';
          target.append(node);
          emphasisStack.push({ index, parent: target });
          target = node;
        } else {
          const active = emphasisStack[emphasisStack.length - 1];
          if (active?.index === index) {
            emphasisStack.pop();
            target = active.parent;
          } else {
            target.append(doc.createTextNode(match[0]));
          }
        }
      } else if (match[1] === 'MARKER') {
        target.append(inlineLegendMarkerNode(markers[Number(match[2])], doc) || doc.createTextNode(match[0]));
      } else {
        const index = match[1] === 'MATH' ? Number(match[2]) : -1;
        const formula = index >= 0 ? formulas[index] : { tex: match[5] || match[6] || '' };
        const math = translationMathNode(formula, doc);
        target.append(math || doc.createTextNode(match[0]));
      }
      cursor = pattern.lastIndex;
    }
    if (cursor < value.length) target.append(doc.createTextNode(value.slice(cursor)));
    return fragment;
  }

  function translationTargetLanguage() { return String(healthAIService('translation')?.target_language || '中文'); }

  function cachedTranslation(blockId, sourceHash, targetLanguage = translationTargetLanguage(), jobId = state.activeJob?.job_id) {
    const profileId = translationProfileId();
    const readonly = state.health?.readonly === true;
    if (!readonly && !profileId) return null;
    const normalizedLanguage = (value) => ['zh', 'ZH', '中文', 'Chinese'].includes(String(value)) ? 'zh' : String(value).toLowerCase();
    return translationCacheFor(jobId).find((item) => item.block_id === (blockId || '') && item.source_hash === sourceHash && normalizedLanguage(item.target_language) === normalizedLanguage(targetLanguage) && (readonly || String(item.profile_id || '') === profileId));
  }

  async function streamApiRequest(url, body, onDelta, signal = null, onMetadata = null) {
    const response = await request(url, { ...jsonOptions({ ...body, stream: true }), closeBarrier: false, ...(signal ? { signal } : {}) });
    const contentType = response.headers.get('Content-Type') || '';
    if (!response.ok || !response.body || !contentType.includes('text/event-stream')) {
      const payload = await response.json().catch(() => ({}));
      await waitForCloseResume();
      if (!response.ok) throw new Error(payload.error || `请求失败（${response.status}）`);
      const context = payload.context || payload.result?.context;
      if (context && onMetadata) onMetadata(context);
      return { ...(payload.result || {}), ...(context ? { context } : {}) };
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let result = null;
    let receivedBytes = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        await waitForCloseResume();
        if (done) break;
        receivedBytes += value.byteLength;
        if (receivedBytes > aiStreamMaxBytes) throw new Error('模型流式响应超过安全上限。');
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > aiStreamMaxBufferChars) throw new Error('模型流式响应片段超过安全上限。');
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const data = buffer.slice(0, boundary).split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .join('');
          buffer = buffer.slice(boundary + 2);
          if (!data) continue;
          let event;
          try { event = JSON.parse(data); } catch (_) { continue; }
          if (event.error) throw new Error(event.error);
          if (typeof event.delta === 'string' && event.delta) onDelta(event.delta);
          if (onMetadata && (event.context || event.result?.context)) onMetadata(event.context || event.result.context);
          if (event.result) result = { ...event.result, ...(event.context ? { context: event.context } : {}) };
        }
      }
    } catch (error) {
      await reader.cancel(error).catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    if (!result) throw new Error('流式响应意外中断。');
    return result;
  }

  async function requestTranslation(text, blockId = null, suppliedFormulas = null, { jobId = state.activeJob?.job_id, onDelta = null, markers = [], emphasis = [], signal = null, refresh = false, segments = [] } = {}) {
    const originalText = String(text || '').trim();
    const profileId = translationProfileId();
    const mathPayload = Array.isArray(suppliedFormulas) ? { text: originalText, formulas: suppliedFormulas } : protectInlineMath(originalText);
    const source = { text: originalText, formulas: mathPayload.formulas, markers, emphasis };
    const sourceHash = translationSourceHash(source);
    const tokenPayload = protectSpecialTokens(mathPayload.text);
    const protectedPayload = { text: tokenPayload.text, formulas: mathPayload.formulas, tokens: tokenPayload.tokens };
    const targetLanguage = translationTargetLanguage();
    let specialIndex = 0;
    const protectedSegments = segments.map(({ id, text: sentence }) => ({ id, text: sentence.replace(SPECIAL_MATH_TOKEN_RE, () => protectedPayload.tokens[specialIndex++]?.token || '') }));
    const aligned = protectedSegments.length > 0;
    // A re-translation asks for a new answer, so the stored one is skipped
    // on both sides -- the server holds the same record.
    const cached = refresh ? null : aligned
      ? translationCacheFor(jobId).find((item) => item.block_id === (blockId || '') && item.profile_id === profileId && item.source_hash === sourceHash && item.target_language === targetLanguage && item.alignment_version === 'sentence-v1' && JSON.stringify(item.source_segments) === JSON.stringify(protectedSegments))
      : cachedTranslationForSource(blockId, source, targetLanguage, jobId);
    if (cached?.text) {
      const formulas = protectedPayload.formulas;
      const repaired = repairFormulaTokens(cached.text, formulas);
      return {
        ...cached,
        text: restoreSpecialTokens(restoreInlineMarkers(restoreInlineMath(repaired, formulas), markers), protectedPayload.tokens),
        segments: (cached.segments || []).map((item) => ({ ...item, text: restoreSpecialTokens(restoreInlineMarkers(restoreInlineMath(item.text, formulas), markers), protectedPayload.tokens) })),
        formulas,
        markers,
        emphasis,
        cached: true,
        sourceHash,
      };
    }
    if (!jobId) throw new Error('没有找到当前文献。');
    const requestBody = {
      text: protectedPayload.text,
      target_language: targetLanguage,
      block_id: blockId,
      source_hash: sourceHash,
      formulas: protectedPayload.formulas.map(({ token, tex }) => ({ token, tex })),
      ...(aligned ? { segments: protectedSegments, alignment_version: 'sentence-v1' } : {}),
      ...(refresh ? { refresh: true } : {}),
    };
    requestTranslation.pending ||= new Map();
    const requestKey = JSON.stringify([jobId, blockId || '', profileId, targetLanguage, translationSourceIdentity(source), protectedSegments, refresh]);
    let operation = requestTranslation.pending.get(requestKey);
    if (!operation) {
      operation = { listeners: new Set(), text: '' };
      const current = operation;
      current.promise = (async () => {
        if (typeof onDelta === 'function') {
          return streamApiRequest(`/api/jobs/${jobId}/translate`, requestBody, (delta) => {
            current.text += delta;
            const partial = repairFormulaTokens(current.text, protectedPayload.formulas);
            const rendered = restoreSpecialTokens(restoreInlineMarkers(restoreInlineMath(partial, protectedPayload.formulas), markers), protectedPayload.tokens);
            current.listeners.forEach((listener) => listener(rendered));
          });
        }
        return (await api(`/api/jobs/${jobId}/translate`, { ...jsonOptions(requestBody), closeBarrier: false })).result || {};
      })().finally(() => requestTranslation.pending.delete(requestKey));
      requestTranslation.pending.set(requestKey, current);
    }
    if (onDelta) operation.listeners.add(onDelta);
    let result;
    try {
      result = await waitForTranslationConsumer(operation.promise, signal);
    } finally {
      if (onDelta) operation.listeners.delete(onDelta);
    }
    if (profileId && translationProfileId() !== profileId) throw new Error('翻译模型已切换，请重试。');
    if (!result.text) throw new Error('模型返回为空。');
    const formulas = protectedPayload.formulas;
    const repaired = repairFormulaTokens(result.text, formulas);
    const record = { ...result, text: repaired, formulas, profile_id: result.profile_id || profileId, block_id: blockId || '', target_language: targetLanguage, source_hash: sourceHash };
    const cache = translationCacheFor(jobId);
    const index = cache.findIndex((item) => item.block_id === record.block_id && item.source_hash === sourceHash && item.target_language === targetLanguage && String(item.profile_id || '') === String(record.profile_id || '') && String(item.alignment_version || '') === String(record.alignment_version || ''));
    if (index >= 0) cache[index] = record; else cache.push(record);
    setTranslationCacheFor(jobId, cache);
    return {
      ...record,
      text: restoreSpecialTokens(restoreInlineMarkers(restoreInlineMath(repaired, formulas), markers), protectedPayload.tokens),
      segments: (record.segments || []).map((item) => ({ ...item, text: restoreSpecialTokens(restoreInlineMarkers(restoreInlineMath(item.text, formulas), markers), protectedPayload.tokens) })),
      formulas,
      markers,
      emphasis,
      cached: Boolean(result.cached),
      sourceHash,
    };
  }

  function waitForTranslationConsumer(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(new DOMException('翻译请求已取消。', 'AbortError'));
    return new Promise((resolve, reject) => {
      const abort = () => reject(new DOMException('翻译请求已取消。', 'AbortError'));
      signal.addEventListener('abort', abort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }

  function reconcileTranslationAnnotations(blockId, previousIds, { pending = false, error = false } = {}) {
    const doc = frameDocument();
    const documentState = readerDocumentState(doc);
    const unresolvedIds = documentState.unresolvedAnnotationIds || new Set();
    for (const annotation of state.annotations) {
      if (!previousIds.has(annotation.id) && annotation.block_id !== `translation-${blockId}` && !(annotation.surface === 'translation' && annotation.source_block_id === blockId)) continue;
      if (!pending && !error && applyMark(annotation)) unresolvedIds.delete(annotation.id);
      else if (!isAIAnnotation(annotation)) unresolvedIds.add(annotation.id);
    }
    documentState.unresolvedAnnotationIds = unresolvedIds;
    documentState.unresolvedAnnotations = unresolvedIds.size;
    updateAnnotationAnchorStatus(unresolvedIds.size);
  }

  function layoutInterlinearContainer(container) {
    const doc = container.ownerDocument;
    const view = doc.defaultView;
    container.querySelectorAll('.reader-interlinear-gap').forEach((node) => node.remove());
    container.querySelectorAll('.reader-translation-line, .reader-translation-run').forEach((node) => node.replaceWith(...node.childNodes));
    container.classList.remove('reader-interlinear-container');
    container.style.removeProperty('--reader-interlinear-line-height');
    container.style.removeProperty('--reader-interlinear-bottom');
    if (doc.documentElement.dataset.translationDisplay !== 'bilingual' || !container.clientWidth) return;
    const sources = [...container.querySelectorAll(':scope > .reader-source-sentence')];
    const translations = [...container.querySelectorAll(':scope > .reader-sentence-translation')];
    sources.forEach((source) => source.normalize());
    if (!sources.length || sources.length !== translations.length) return;
    const computed = view.getComputedStyle(container);
    const fontSize = parseFloat(computed.fontSize);
    const sourceLeading = Math.max(1.25, Number(computed.getPropertyValue('--reader-line-height')) * .78 || 1.34);
    const gap = Math.max(2, fontSize * .12);
    const atomicSelector = 'math, .katex, .math-source-visual, sup, sub, img';
    const measurement = doc.createRange();
    container.classList.add('reader-interlinear-container');
    container.style.setProperty('--reader-interlinear-line-height', `${fontSize * sourceLeading}px`);
    const origin = container.getBoundingClientRect();
    const rows = [];
    const parts = sources.map((source) => {
      const rects = [...source.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
      const sourceRows = rects.map((rect) => {
        let row = rows.find((candidate) => Math.abs(candidate.y - rect.top) < 2);
        if (!row) { row = { y: rect.top, top: rect.top, bottom: rect.bottom, parts: [] }; rows.push(row); }
        row.bottom = Math.max(row.bottom, rect.bottom);
        return row;
      });
      const units = [];
      const rowFor = (rect) => {
        const center = (rect.top + rect.bottom) / 2;
        const closest = rects.reduce((best, candidate, i) => Math.abs((candidate.top + candidate.bottom) / 2 - center) < best.distance
          ? { index: i, distance: Math.abs((candidate.top + candidate.bottom) / 2 - center) } : best, { index: 0, distance: Infinity });
        return sourceRows[closest.index];
      };
      const add = (rect, node, offset, anchor, anchorOffset = 0) => {
        const row = rowFor(rect);
        if (!row) return;
        row.top = Math.min(row.top, rect.top);
        row.bottom = Math.max(row.bottom, rect.bottom);
        if (!row.anchor) {
          let target = anchor;
          if (anchor.nodeType === Node.TEXT_NODE) {
            target = doc.createRange();
            target.setStart(anchor, anchorOffset);
            target.setEnd(anchor, anchorOffset + 1);
          }
          row.anchor = { target, top: target.getBoundingClientRect().top };
        }
        let part = units.at(-1);
        if (part?.row !== row) {
          part = { row, left: rect.left, right: rect.right };
          units.push(part);
          row.parts.push(part);
        }
        part.left = Math.min(part.left, rect.left);
        part.right = Math.max(part.right, rect.right);
        part.end ||= doc.createRange();
        part.end.setStart(node, offset);
        part.end.collapse(true);
      };
      const visit = (node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          const range = measurement;
          const at = (offset) => {
            range.setStart(node, offset); range.setEnd(node, offset + 1);
            return range.getBoundingClientRect();
          };
          for (let start = 0; start < node.length;) {
            const row = rowFor(at(start));
            let low = start + 1;
            let high = node.length;
            while (low < high) {
              const middle = Math.floor((low + high) / 2);
              if (rowFor(at(middle)) === row) low = middle + 1;
              else high = middle;
            }
            const value = node.data.slice(start, low);
            const visibleStart = start + value.search(/\S/u);
            const visibleEnd = low - value.length + value.trimEnd().length;
            if (visibleStart >= start && visibleEnd > visibleStart) {
              range.setStart(node, visibleStart); range.setEnd(node, visibleEnd);
              const rect = range.getBoundingClientRect();
              add(rect, node, visibleEnd, node, visibleStart);
            }
            start = low;
          }
        } else if (node.nodeType === Node.ELEMENT_NODE && !node.matches('.annotation-note-trigger, .paragraph-translate-trigger')) {
          if (node.matches(atomicSelector)) {
            const boxes = [node, ...node.querySelectorAll('img, math, .katex')].map((item) => item.getBoundingClientRect()).filter((rect) => rect.width && rect.height);
            if (boxes.length) {
              const rect = { left: Math.min(...boxes.map((box) => box.left)), right: Math.max(...boxes.map((box) => box.right)), top: Math.min(...boxes.map((box) => box.top)), bottom: Math.max(...boxes.map((box) => box.bottom)) };
              add(rect, node.parentNode, [...node.parentNode.childNodes].indexOf(node) + 1, node);
            }
          } else [...node.childNodes].forEach(visit);
        }
      };
      [...source.childNodes].forEach(visit);
      return units;
    });
    rows.sort((a, b) => a.y - b.y);

    const mergeInline = (root) => {
      for (const child of [...root.children]) {
        mergeInline(child);
        while (child.matches('mark,em,strong,b,i,u,a') && child.nextSibling?.nodeType === Node.ELEMENT_NODE
          && child.tagName === child.nextSibling.tagName && child.attributes.length === child.nextSibling.attributes.length
          && [...child.attributes].every((attribute) => child.nextSibling.getAttribute(attribute.name) === attribute.value)) {
          const next = child.nextSibling;
          child.append(...next.childNodes);
          next.remove();
          mergeInline(child);
        }
      }
      root.normalize();
    };
    const width = container.clientWidth;
    const streams = parts.map((units, index) => {
      if (!units[0]) return null;
      const body = translations[index].querySelector('.translation-text');
      mergeInline(body);
      const remaining = doc.createElement('span');
      remaining.append(...body.childNodes);
      return { index, body, remaining, first: units[0], start: rows.indexOf(units[0]?.row) };
    }).filter(Boolean);
    const lines = [];
    const pruneEmptyMarks = (root) => {
      root.querySelectorAll('mark').forEach((mark) => {
        if (!mark.textContent && !mark.querySelector(atomicSelector)) mark.remove();
      });
    };
    const takeLine = (stream, left, right, row) => {
      const line = doc.createElement('span');
      line.className = 'reader-translation-line';
      line.style.left = `${left}px`;
      line.style.right = 'auto';
      line.style.width = `${right - left}px`;
      const run = doc.createElement('span');
      run.className = 'reader-translation-run';
      run.append(...stream.remaining.childNodes);
      line.append(run);
      stream.body.append(line);
      const boxes = [...run.getClientRects()].filter((rect) => rect.width && rect.height);
      const firstBox = boxes[0];
      let boundary = null;
      const onFirstLine = (rect) => {
        const center = (rect.top + rect.bottom) / 2;
        return !boxes.some((box, index) => index && Math.abs((box.top + box.bottom) / 2 - center) < Math.abs((firstBox.top + firstBox.bottom) / 2 - center) - .5);
      };
      const visit = (node) => {
        if (boundary) return;
        if (node.nodeType === Node.TEXT_NODE && node.length) {
          const range = measurement;
          const at = (offset) => {
            range.setStart(node, offset); range.setEnd(node, offset + 1);
            return range.getBoundingClientRect();
          };
          let low = 0;
          let high = node.length;
          while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (onFirstLine(at(middle))) low = middle + 1;
            else high = middle;
          }
          if (low < node.length) boundary = { node, offset: low };
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.matches('.annotation-note-trigger,.annotation-note-popover')) return;
          if (node.matches(atomicSelector)) {
            if (!onFirstLine(node.getBoundingClientRect())) boundary = { node: node.parentNode, offset: [...node.parentNode.childNodes].indexOf(node) };
          } else [...node.childNodes].forEach(visit);
        }
      };
      if (firstBox) [...run.childNodes].forEach(visit);
      if (boundary) {
        const remainder = measurement;
        remainder.selectNodeContents(run);
        remainder.setStart(boundary.node, boundary.offset);
        stream.remaining.append(remainder.extractContents());
        pruneEmptyMarks(run);
        pruneEmptyMarks(stream.remaining);
      }
      const box = line.getBoundingClientRect();
      const contents = measurement;
      contents.selectNodeContents(run);
      const occupied = [...contents.getClientRects()].filter((rect) => rect.width && rect.height);
      const occupiedRight = Math.max(left, ...occupied.map((rect) => rect.right - origin.left - container.clientLeft));
      const height = Math.max(box.height, ...occupied.map((rect) => rect.bottom - box.top));
      row.lines.push({ line, height });
      lines.push(line);
      return stream.remaining.hasChildNodes() ? right : occupiedRight + gap;
    };
    for (let index = 0; index < rows.length || streams.some((stream) => stream.remaining.hasChildNodes()); index += 1) {
      const row = rows[index] || { lines: [], tail: true };
      row.lines ||= [];
      if (row.tail) rows.push(row);
      const starting = streams.filter((stream) => stream.start === index && stream.first);
      let cursor = 0;
      for (const stream of streams) {
        if (!stream.first || stream.start > index || !stream.remaining.hasChildNodes()) continue;
        const left = stream.start === index ? Math.max(0, stream.first.left - origin.left - container.clientLeft) : cursor;
        const next = starting.find((candidate) => candidate.index > stream.index && candidate.first.left >= origin.left + container.clientLeft + left - .5);
        const right = next ? next.first.left - origin.left - container.clientLeft - gap : width;
        if (right - left < 1) continue;
        cursor = takeLine(stream, left, right, row);
      }
      if (row.tail) continue;
      const depth = Math.max(0, ...row.lines.map((part) => part.height));
      if (!depth) continue;
      const spacer = doc.createElement('span');
      spacer.className = 'reader-interlinear-gap';
      spacer.setAttribute('aria-hidden', 'true');
      const sourceHeight = row.bottom - row.top;
      // Keep the upper leading; the translated row replaces the lower leading.
      const leading = Math.max(0, (fontSize * sourceLeading - sourceHeight) / 2);
      spacer.style.height = `${sourceHeight + leading + depth + gap * 2}px`;
      row.parts.at(-1).end.insertNode(spacer);
      row.spacer = spacer;
    }
    const finalOrigin = container.getBoundingClientRect();
    let tailTop = 0;
    for (const row of rows) {
      if (row.spacer) row.shift = row.anchor.target.getBoundingClientRect().top - row.anchor.top;
    }
    for (const row of rows) {
      const top = row.tail ? tailTop : row.bottom - finalOrigin.top + (row.shift || 0) + gap - container.clientTop;
      for (const part of row.lines) part.line.style.top = `${top}px`;
      tailTop = Math.max(tailTop, top + Math.max(0, ...row.lines.map((part) => part.height)) + gap);
    }
    const overflow = Math.max(0, ...lines.map((line) => line.getBoundingClientRect().bottom + gap - finalOrigin.bottom));
    container.style.setProperty('--reader-interlinear-bottom', `${overflow}px`);
  }

  function scheduleInterlinearTranslations(doc, block = null) {
    if (!doc?.defaultView) return;
    const documentState = readerDocumentState(doc);
    if (!documentState.translationUpdates?.size && !doc.querySelector('.reader-sentence-pairs')) return;
    let layout = documentState.interlinear;
    if (layout?.disposed) return;
    if (!layout) {
      layout = documentState.interlinear = { frame: 0, dirty: new Set(), widths: new WeakMap() };
      layout.schedule = () => scheduleInterlinearTranslations(doc);
      layout.observer = new doc.defaultView.ResizeObserver((entries) => {
        for (const entry of entries) {
          const previous = layout.widths.get(entry.target);
          layout.widths.set(entry.target, entry.contentRect.width);
          if (previous === undefined || previous === entry.contentRect.width) continue;
          scheduleInterlinearTranslations(doc, entry.target.closest('.reader-sentence-pairs'));
        }
      });
      layout.imageLoad = (event) => {
        if (!event.target.matches?.('img')) return;
        const root = event.target.closest('.reader-sentence-pairs');
        if (root) scheduleInterlinearTranslations(doc, root);
      };
      doc.addEventListener('load', layout.imageLoad, true);
      doc.addEventListener('error', layout.imageLoad, true);
      doc.fonts?.addEventListener('loadingdone', layout.schedule);
      doc.fonts?.ready.then(layout.schedule);
    }
    if (!block) layout.dirty = null;
    else layout.dirty?.add(block);
    if (layout.frame) return;
    layout.flush = () => {
      doc.defaultView.cancelAnimationFrame(layout.frame);
      layout.frame = 0;
      const updates = documentState.translationUpdates;
      documentState.translationUpdates = null;
      if (updates?.size && doc === frameDocument()) {
        for (const { blockId, previousIds } of updates.values()) reconcileTranslationAnnotations(blockId, previousIds);
        refreshReaderSearch();
      }
      const blocks = layout.dirty || doc.querySelectorAll('.reader-sentence-pairs');
      layout.dirty = new Set();
      for (const root of blocks) {
        if (!root.isConnected) continue;
        const containers = root.matches('ul, ol') ? root.querySelectorAll(':scope > li') : [root];
        for (const container of containers) {
          layoutInterlinearContainer(container);
          layout.observer.observe(container);
        }
      }
      if (readerTextSelectionStates.has(doc)) renderFrameTextSelection(doc, { reposition: true });
    };
    layout.frame = doc.defaultView.requestAnimationFrame(layout.flush);
  }

  function disposeInterlinearTranslations(doc) {
    const layout = doc && readerDocumentState(doc).interlinear;
    if (!layout) return;
    layout.disposed = true;
    layout.observer.disconnect();
    doc.defaultView?.cancelAnimationFrame(layout.frame);
    doc.removeEventListener('load', layout.imageLoad, true);
    doc.removeEventListener('error', layout.imageLoad, true);
    doc.fonts?.removeEventListener('loadingdone', layout.schedule);
  }

  function unwrapSentenceTranslations(block) {
    block?.querySelectorAll('.reader-interlinear-gap').forEach((node) => node.remove());
    block?.querySelectorAll('.reader-sentence-translation').forEach((node) => node.remove());
    block?.querySelectorAll('.reader-source-sentence').forEach((node) => node.replaceWith(...node.childNodes));
    block?.classList.remove('reader-sentence-pairs');
    for (const container of [block, ...block?.querySelectorAll('.reader-interlinear-container') || []]) {
      container?.classList.remove('reader-interlinear-container');
      container?.style.removeProperty('--reader-interlinear-line-height');
      container?.style.removeProperty('--reader-interlinear-bottom');
    }
  }

  function insertSentenceTranslations(block, segments, options) {
    const { doc, blockId, sourceHash, formulas, markers, emphasis, record } = options;
    const bounds = readerBlockSentenceSegments(block, doc);
    if (bounds.length !== segments.length || !bounds.every((item, index) => segments[index].id === `s${item.start}-${item.end}`)) return null;
    const containers = block.matches('ul, ol') ? [...block.querySelectorAll(':scope > li')] : [block];
    const groups = containers.map((container) => {
      const start = container === block ? 0 : textOffset(block, container, 0, doc);
      const end = container === block ? canonicalBlockText(block, doc).length : textOffset(block, container, container.childNodes.length, doc);
      return { container, start, items: bounds.map((item, index) => ({ item, index })).filter(({ item }) => item.start >= start && item.end <= end) };
    });
    const trigger = block.querySelector(':scope > .paragraph-translate-trigger');
    trigger?.remove();
    let first = null;
    for (const { container, start, items } of groups) {
      if (!items.length) continue;
      const pairs = doc.createDocumentFragment();
      const translations = doc.createDocumentFragment();
      let consumed = start;
      items.forEach(({ item, index }) => {
        const range = rangeAtOffsets(container, 0, item.end - consumed, doc);
        range.setStart(container, 0);
        let boundary = range.endContainer;
        if (boundary !== container && range.endOffset === (boundary.nodeType === Node.TEXT_NODE ? boundary.length : boundary.childNodes.length)) {
          while (boundary.parentNode !== container && boundary === boundary.parentNode.lastChild) boundary = boundary.parentNode;
          if (boundary.nextSibling?.matches?.('.annotation-note-trigger')) boundary = boundary.nextSibling;
          range.setEndAfter(boundary);
        }
        const original = doc.createElement('span');
        original.className = 'reader-source-sentence';
        original.append(range.extractContents());
        const translated = doc.createElement('span');
        translated.className = 'my-scholar-translation reader-sentence-translation';
        translated.dataset.for = blockId;
        translated.dataset.blockId = `translation-${blockId}--${segments[index].id}`;
        translated.dataset.translationFor = blockId;
        translated.dataset.sentenceId = segments[index].id;
        translated.dataset.surface = 'translation';
        translated.dataset.sourceHash = sourceHash;
        translated.dataset.profileId = record?.profile_id || '';
        translated.dataset.page = block.dataset.page || block.closest('.pdf-page')?.dataset.page || '';
        translated.translationResult = { text: segments[index].text, formulas, markers, emphasis };
        translated.title = `译文来源：${translationProviderLabel(record)}`;
        const body = doc.createElement('span');
        body.className = 'translation-text';
        body.append(renderTranslationText(segments[index].text, formulas, doc, markers, emphasis));
        translated.append(body);
        if (index === 0) {
          const label = doc.createElement('small');
          label.className = 'translation-source-label';
          label.textContent = translationProviderLabel(record);
          translated.append(label);
        }
        pairs.append(original);
        translations.append(translated);
        first ||= translated;
        consumed = item.end;
      });
      const lastSource = [...pairs.querySelectorAll('.reader-source-sentence')].at(-1);
      if (lastSource && container.firstChild) lastSource.append(...container.childNodes);
      container.replaceChildren(pairs, translations);
    }
    if (trigger) block.append(trigger);
    block.classList.add('reader-sentence-pairs');
    return first;
  }

  function insertTranslation(blockId, text, { pending = false, error = false, cached = false, sourceHash = '', role = '', formulas = [], markers = [], emphasis = [], doc = frameDocument(), batch = false, segments = [], record = null } = {}) {
    const block = translationTarget(blockId, doc);
    if (!block) return null;
    if (segments.length) block.translationSourceSnapshot = { canonicalText: canonicalBlockText(block, doc), source: paragraphSource(block) };
    const existing = doc.querySelector(`.my-scholar-translation[data-for="${cssEscape(blockId || '')}"]:not(.is-pending):not(.is-error)`);
    block.querySelectorAll('.translation-retained-status').forEach((node) => node.remove());
    if ((pending || error) && existing) {
      const status = doc.createElement('span');
      status.className = 'translation-retained-status';
      status.textContent = pending ? '正在重新翻译，原译文已保留…' : `${text} · 原译文已保留`;
      status.setAttribute('role', 'status');
      block.append(status);
      return existing;
    }
    const documentState = readerDocumentState(doc);
    documentState.translationAnnotationIds ||= new Map();
    const previousIds = new Set(documentState.translationAnnotationIds.get(blockId));
    doc.querySelectorAll(`.my-scholar-translation[data-for="${cssEscape(blockId || '')}"]`).forEach((node) => {
      node.querySelectorAll(':is(mark, mrow)[data-annotation-id]').forEach((mark) => previousIds.add(mark.dataset.annotationId));
      node.remove();
    });
    documentState.translationAnnotationIds.set(blockId, previousIds);
    const hadSentencePairs = block.classList.contains('reader-sentence-pairs');
    unwrapSentenceTranslations(block);
    if (!pending && !error && segments.length) {
      const aligned = insertSentenceTranslations(block, segments, { doc, blockId, sourceHash, formulas, markers, emphasis, record });
      if (aligned) {
        syncTranslationBlockVisibility(block, aligned);
        if (!batch && doc === frameDocument()) {
          documentState.translationUpdates ||= new Map();
          documentState.translationUpdates.set(block, { blockId, previousIds });
        } else delete documentState.annotationsKey;
        scheduleInterlinearTranslations(doc, block);
        return aligned;
      }
    }
    const node = doc.createElement('div');
    node.className = `my-scholar-translation${role ? ` ${role}-translation` : ''}${pending ? ' is-pending' : ''}${error ? ' is-error' : ''}${cached ? ' is-cached' : ''}`;
    node.dataset.for = blockId;
    node.dataset.blockId = `translation-${blockId}`;
    node.dataset.translationFor = blockId;
    node.dataset.surface = 'translation';
    if (!pending && !error) node.translationResult = { text, formulas, markers, emphasis };
    node.dataset.profileId = record?.profile_id || '';
    node.dataset.page = block.dataset.page || block.closest('.pdf-page')?.dataset.page || '';
    if (sourceHash) node.dataset.sourceHash = sourceHash;
    const body = doc.createElement('div');
    body.className = 'translation-text';
    const rendered = renderTranslationText(text, formulas, doc, markers, emphasis);
    if (rendered) body.append(rendered); else body.textContent = text;
    if (doc.defaultView?.parent?.MyScholarDemo?.enabled) {
      const label = doc.createElement('small');
      label.className = 'browser-demo-translation-label';
      label.textContent = 'AI 示例译文 · 非真实模型输出';
      label.style.cssText = 'display:block;font:11px/1.6 system-ui,sans-serif;color:var(--muted,#756b60);margin-bottom:3px';
      node.append(label);
    }
    node.append(body);
    if (!pending && !error && record) {
      const label = doc.createElement('small');
      label.className = 'translation-source-label';
      label.textContent = `本段译文 · ${translationProviderLabel(record)}`;
      node.append(label);
    }
    if (block.classList.contains('paper-abstract-body')) {
      node.classList.add('paper-abstract-translation');
      decorateInlineSectionLabel(body, inlineAbstractLabelPattern, 'paper-section-label paper-abstract-label');
    }
    if (block.classList.contains('paper-keywords')) {
      node.classList.add('paper-keywords-translation');
      decorateInlineSectionLabel(body, inlineKeywordsLabelPattern, 'paper-section-label paper-keywords-label');
    }
    block.insertAdjacentElement('afterend', node);
    syncTranslationBlockVisibility(block, node);
    if (!batch && doc === frameDocument()) {
      if (hadSentencePairs) {
        documentState.translationUpdates ||= new Map();
        documentState.translationUpdates.set(block, { blockId, previousIds });
        scheduleInterlinearTranslations(doc, block);
      } else reconcileTranslationAnnotations(blockId, previousIds, { pending, error });
      refreshReaderSearch();
    } else delete readerDocumentState(doc).annotationsKey;
    return node;
  }

  async function translateBlock(blockId, trigger = null, { silent = false, jobId = state.activeJob?.job_id, doc = frameDocument(), signal = null, refresh = false } = {}) {
    if (!jobId || !blockId || !doc) return false;
    const block = translationTarget(blockId, doc);
    const source = paragraphTranslationSource(block);
    const text = source.text;
    if (!text) return false;
    const profileId = translationProfileId();
    const mount = readerMounts.get(jobId);
    const ownsDocument = () => readerMountIsCurrent(mount) && mount.frame.contentDocument === doc;
    if (trigger) { trigger.disabled = true; trigger.textContent = '…'; }
    const isTitle = block?.matches('h1.paper-title, h1[data-translate-block-id]');
    insertTranslation(blockId, '正在翻译…', { pending: true, role: isTitle ? 'title' : '', doc });
    const removePendingTranslation = () => {
      block.querySelectorAll('.translation-retained-status').forEach((node) => node.remove());
      doc.querySelectorAll(`.my-scholar-translation[data-for="${cssEscape(blockId || '')}"]`).forEach((node) => {
        if (node.classList.contains('is-pending')) node.remove();
      });
      syncTranslationBlockVisibility(block, doc.querySelector(`.my-scholar-translation[data-for="${cssEscape(blockId)}"]`));
    };
    try {
      const translated = await requestTranslation(text, blockId, source.formulas, { jobId, markers: source.markers, emphasis: source.emphasis, segments: source.segments, signal, refresh });
      // A user can switch tabs while the gateway request is in flight. Never
      // insert an old document's response into the newly active iframe.
      if (!ownsDocument() || (profileId && translationProfileId() !== profileId)) {
        removePendingTranslation();
        return false;
      }
      insertTranslation(blockId, translated.text, {
        cached: translated.cached,
        sourceHash: translated.sourceHash,
        role: isTitle ? 'title' : '',
        formulas: translated.formulas,
        markers: translated.markers,
        emphasis: translated.emphasis,
        segments: translated.segments,
        record: translated,
        doc,
      });
      rememberDisplayedTranslation(jobId, translated);
      if (!silent && readerMountMatches(mount, doc)) setPanelStatus(translated.cached ? '已使用本地翻译缓存。' : translated.segments?.length ? '已按句显示对应译文。' : '本段翻译已插入原文下方。');
      return true;
    } catch (error) {
      if (error?.name === 'AbortError' || signal?.aborted) {
        removePendingTranslation();
        return false;
      }
      if (ownsDocument() && (!profileId || translationProfileId() === profileId)) {
        insertTranslation(blockId, translationErrorMessage(error), { error: true, role: isTitle ? 'title' : '', doc });
        if (!silent && readerMountMatches(mount, doc)) setPanelStatus(error.message, true);
      } else removePendingTranslation();
      return false;
    } finally {
      if (trigger) { trigger.disabled = false; trigger.textContent = '译'; }
    }
  }

  function installParagraphTranslationControls() {
    const doc = frameDocument(); if (!doc) return;
    doc.querySelectorAll('p[data-block-id], ul[data-block-id], ol[data-block-id]').forEach((block) => {
      if (isMetadataParagraph(block)) return;
      if (block.querySelector(':scope > .paragraph-translate-trigger')) return;
      const trigger = doc.createElement('button');
      trigger.type = 'button';
      trigger.className = 'paragraph-translate-trigger';
      trigger.dataset.translateBlockId = block.dataset.blockId || block.dataset.translateBlockId || '';
      trigger.title = '翻译本段';
      trigger.setAttribute('aria-label', '翻译本段');
      trigger.textContent = '译';
      trigger.addEventListener('click', (event) => {
        if (doc !== frameDocument()) return;
        event.preventDefault();
        event.stopPropagation();
        // Pressing 译 on a paragraph that already shows a translation is a
        // request for a different one; returning the stored answer would leave
        // the reader with no way to redo a translation they judge wrong.
        const blockId = trigger.dataset.translateBlockId;
        const existing = doc.querySelector(`.my-scholar-translation[data-for="${cssEscape(blockId || '')}"]`);
        const refresh = Boolean(existing) && !existing.classList.contains('is-pending');
        translateBlock(blockId, trigger, { refresh });
      });
      block.appendChild(trigger);
    });
  }

  async function ensureTitleTranslation() {
    const doc = frameDocument();
    const mount = readerMount;
    if (!readerMountMatches(mount, doc)) return;
    await mount.layoutReady;
    if (!readerMountMatches(mount, doc)) return;
    const title = doc?.querySelector('h1.paper-title[data-block-id], h1[data-translate-block-id]');
    if (!title || !translatableParagraph(title) || !aiServiceEnabled('translation')) return;
    const blockId = title.dataset.blockId || title.dataset.translateBlockId;
    if (doc.querySelector(`.my-scholar-translation[data-for="${cssEscape(blockId)}"]`)) return;
    await translateBlock(blockId, null, { silent: true });
  }

  function translatableParagraph(block) {
    if (!block || !(block.dataset.blockId || block.dataset.translateBlockId)) return false;
    if (isMetadataParagraph(block)) return false;
    const text = paragraphText(block);
    const isCaption = block.matches('figcaption[data-translate-block-id]');
    const isTitle = block.matches('h1.paper-title, h1[data-translate-block-id]');
    if (isTitle ? text.length < 3 : (isCaption ? text.length < 8 : text.length < 32)) return false;
    if (block.closest('.references')) return false;
    return true;
  }


  const translationStatusLabels = { queued: '排队等待翻译', running: '正在翻译全文', stopping: '正在停止翻译', complete: '全文翻译完成' };
  function translationRunPercent(run) {
    const total = Math.max(0, Number(run?.total) || 0);
    const done = Math.max(0, Math.min(total, Number(run?.done) || 0));
    return total ? Math.round((done / total) * 100) : 0;
  }
  // The static panel in the tray always describes the active document's run;
  // every other document's run is drawn as a card from the same run object.
  function paintTranslationPanel(run, { visible = Boolean(run?.running) } = {}) {
    const panel = $('#translation-progress');
    if (!panel) return;
    const total = Math.max(0, Number(run?.total) || 0);
    const done = Math.max(0, Math.min(total, Number(run?.done) || 0));
    const percent = translationRunPercent(run);
    const complete = total > 0 && done >= total;
    const queued = run?.phase === 'queued';
    panel.hidden = !visible;
    panel.dataset.state = queued ? 'queued' : complete ? 'complete' : 'running';
    $('#translation-progress-label').textContent = run?.running && run?.stop ? translationStatusLabels.stopping : queued ? translationStatusLabels.queued : complete ? translationStatusLabels.complete : translationStatusLabels.running;
    $('#translation-progress-count').textContent = total ? `第 ${complete ? total : Math.min(total, done + 1)} / ${total} 段` : '';
    $('#translation-progress-value').textContent = `${percent}%`;
    const detailNode = $('#translation-progress-detail');
    if (detailNode) {
      const text = complete ? '' : String(run?.detail || '');
      detailNode.hidden = !text;
      detailNode.textContent = text;
    }
    const bar = $('#translation-progress-bar');
    if (bar) bar.style.width = `${percent}%`;
    const track = panel.querySelector('[role="progressbar"]');
    if (track) {
      track.setAttribute('aria-valuenow', String(percent));
      track.setAttribute('aria-label', `全文翻译进度：${percent}%（${done}/${total}）`);
    }
    const stopButton = $('#stop-translation-button');
    if (stopButton) stopButton.disabled = !run?.running || Boolean(run?.stop);
  }
  function updateTranslationProgress(run, options = {}) {
    if (run && state.activeJob?.job_id === run.jobId) paintTranslationPanel(run, options);
    refreshBackgroundTasks();
  }
  function hasUsableTranslation(block, doc = frameDocument(), jobId = state.activeJob?.job_id) {
    const blockId = block?.dataset.blockId || block?.dataset.translateBlockId || '';
    if (!blockId) return false;
    const source = paragraphSource(block);
    const sourceHash = translationSourceHash(source);
    const rendered = doc?.querySelector(`.my-scholar-translation[data-for="${cssEscape(blockId)}"]`);
    if (rendered && !rendered.classList.contains('is-pending') && !rendered.classList.contains('is-error')) {
      if (rendered.dataset.sourceHash === sourceHash) return true;
      if (!source.formulas.length && !source.markers.length && !source.emphasis.length && !rendered.dataset.sourceHash) return true;
      return false;
    }
    return Boolean(cachedTranslationForSource(blockId, source, translationTargetLanguage(), jobId)?.text);
  }

  const FULL_TRANSLATION_CONCURRENCY = 3;


  // Documents translating at once. The rest wait in the tray, so several
  // full-document runs do not multiply the request rate against the gateway.
  const FULL_TRANSLATION_MAX_DOCUMENTS = 2;
  const translationSlotWaiters = [];
  function translatingDocumentCount() {
    let count = 0;
    state.translationRuns.forEach((run) => { if (run.running && run.phase === 'running') count += 1; });
    return count;
  }
  function acquireTranslationSlot(run) {
    run.slotAcquired = false;
    if (translatingDocumentCount() < FULL_TRANSLATION_MAX_DOCUMENTS) {
      run.slotAcquired = true;
      run.phase = 'running';
      return Promise.resolve();
    }
    run.phase = 'queued';
    updateTranslationProgress(run);
    return new Promise((resolve) => {
      run.wake = () => {
        run.wake = null;
        if (!run.stop) { run.slotAcquired = true; run.phase = 'running'; }
        resolve();
      };
      translationSlotWaiters.push(run);
    });
  }
  function releaseTranslationSlot() {
    while (translationSlotWaiters.length) {
      const next = translationSlotWaiters.shift();
      if (!next.wake) continue;
      next.wake();
      if (!next.stop) return;
    }
  }

  // One paragraph of a run. The run works from its own snapshot of the source,
  // so the request goes out whether or not the document is still mounted; the
  // result stays with its document, including a matching reader reopened later.
  async function translateSnapshot(snapshot, run, { refresh = false } = {}) {
    const { blockId, isTitle, source } = snapshot;
    if (!blockId || !source?.text) return false;
    const role = isTitle ? 'title' : '';
    const mountedDoc = () => {
      const { mount, document: originalDocument } = run;
      if (readerMountIsCurrent(mount) && mount.frame.contentDocument === originalDocument) return originalDocument;
      const reopenedMount = readerMounts.get(run.jobId);
      if (!reopenedMount?.loaded || reopenedMount.generation !== run.generation) return null;
      const doc = reopenedMount.frame.contentDocument;
      const block = translationTarget(blockId, doc);
      return block && translationSourceHash(paragraphSource(block)) === translationSourceHash(source) ? doc : null;
    };
    const profileId = translationProfileId();
    {
      const doc = mountedDoc();
      if (doc) insertTranslation(blockId, '正在翻译…', { pending: true, role, doc });
    }
    const removePendingTranslation = () => {
      const current = mountedDoc();
      if (!current) return;
      translationTarget(blockId, current)?.querySelectorAll('.translation-retained-status').forEach((node) => node.remove());
      current.querySelectorAll(`.my-scholar-translation[data-for="${cssEscape(blockId)}"]`).forEach((node) => {
        if (node.classList.contains('is-pending')) node.remove();
      });
      syncTranslationBlockVisibility(translationTarget(blockId, current), current.querySelector(`.my-scholar-translation[data-for="${cssEscape(blockId)}"]`));
    };
    try {
      const translated = await requestTranslation(source.text, blockId, source.formulas, { jobId: run.jobId, markers: source.markers, emphasis: source.emphasis, segments: source.segments, signal: run.abortController.signal, refresh });
      if (profileId && translationProfileId() !== profileId) {
        removePendingTranslation();
        return false;
      }
      const doc = mountedDoc();
      if (doc) insertTranslation(blockId, translated.text, { cached: translated.cached, sourceHash: translated.sourceHash, role, formulas: translated.formulas, markers: translated.markers, emphasis: translated.emphasis, segments: translated.segments, record: translated, doc });
      rememberDisplayedTranslation(run.jobId, translated);
      return true;
    } catch (error) {
      if (error?.name === 'AbortError' || run.abortController.signal.aborted) {
        removePendingTranslation();
        return false;
      }
      const doc = mountedDoc();
      if (doc) insertTranslation(blockId, translationErrorMessage(error), { error: true, role, doc });
      return false;
    }
  }

  // Reference headings end the body even when appendices follow them.
  const translationScopeStorageKey = 'my-scholar-translation-scope-v1';
  const REFERENCES_HEADING = /^(?:(?:\d+(?:\.\d+)*|[IVXLCDM]+|[A-Z])(?:[.)]\s*|\s+)|\[\d+\]\s*)?references?\s*[:.]?$/iu;
  function translationScope() { return persistentStateGet(translationScopeStorageKey) === 'body' ? 'body' : 'all'; }
  function setTranslationScope(scope) {
    persistentStateSet(translationScopeStorageKey, scope === 'body' ? 'body' : 'all');
    syncTranslationScopeControls();
  }
  function referencesBoundary(doc) {
    return [...(doc?.querySelectorAll('h1, h2, h3, h4, h5, h6') || [])].find((heading) => !heading.matches('h1.paper-title') && REFERENCES_HEADING.test(String(heading.textContent || '').replace(/\s+/g, ' ').trim())) || null;
  }
  function translatableBlocks(doc, scope = translationScope()) {
    const blocks = [...(doc?.querySelectorAll('h1.paper-title[data-block-id], p[data-block-id], ul[data-block-id], ol[data-block-id], figcaption[data-translate-block-id]') || [])].filter(translatableParagraph);
    if (scope !== 'body') return blocks;
    const boundary = referencesBoundary(doc);
    if (!boundary) return blocks;
    return blocks.filter((block) => Boolean(boundary.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_PRECEDING));
  }
  function syncTranslationScopeControls() {
    const scope = translationScope();
    const label = $('#full-translate-label');
    if (label) label.textContent = scope === 'body' ? '正文翻译' : '全文翻译';
    const button = $('#full-translate-button');
    if (button) setReaderShortcutHint(button, 'full_translation', `${scope === 'body' ? '翻译正文（首个 Reference / References 标题之前）' : '翻译全文（含参考文献后的附录）'}；再次点击可重新翻译已有译文的段落`);
    $$('#translation-scope-menu [data-translation-scope]').forEach((item) => item.setAttribute('aria-checked', String(item.dataset.translationScope === scope)));
    syncTranslationVisibilityButton();
  }
  function closeTranslationScopeMenu() {
    const menu = $('#translation-scope-menu');
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    ['left', 'top', 'width', 'max-height'].forEach((property) => menu.style.removeProperty(property));
    delete menu.dataset.placement;
    $('#full-translate-scope-button')?.setAttribute('aria-expanded', 'false');
  }
  function toggleTranslationScopeMenu(button) {
    const menu = $('#translation-scope-menu');
    if (!menu || !button) return;
    if (!menu.hidden) {
      closeTranslationScopeMenu();
      return;
    }
    const doc = frameDocument();
    const boundary = referencesBoundary(doc);
    const all = translatableBlocks(doc, 'all').length;
    const body = boundary ? translatableBlocks(doc, 'body').length : all;
    $('#translation-scope-body-count').textContent = boundary ? `参考文献标题之前 · ${body} 段` : '未检测到 Reference / References 标题，与全文相同';
    $('#translation-scope-all-count').textContent = boundary ? `含参考文献后的附录 · ${all} 段` : `${all} 段`;
    syncTranslationScopeControls();
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    positionViewportMenu(menu, button.getBoundingClientRect(), {});
    window.requestAnimationFrame(() => menu.querySelector('[aria-checked="true"]')?.focus({ preventScroll: true }));
  }

  function fullTranslationSnapshot(doc, scope, refresh, preparation) {
    if (!preparation.candidates) {
      const boundary = scope === 'body' ? referencesBoundary(doc) : null;
      preparation.candidates = [...doc.querySelectorAll('h1.paper-title[data-block-id], p[data-block-id], ul[data-block-id], ol[data-block-id], figcaption[data-translate-block-id]')]
        .filter((block) => !boundary || Boolean(boundary.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_PRECEDING))
        .map((block) => block.dataset.blockId || block.dataset.translateBlockId);
    }
    const deadline = performance.now() + 8;
    let processed = 0;
    while (preparation.index < preparation.candidates.length && processed < 8) {
      const blockId = preparation.candidates[preparation.index++];
      const block = translationTarget(blockId, doc);
      if (translatableParagraph(block)) {
        preparation.total += 1;
        if (refresh || !hasUsableTranslation(block, doc, preparation.jobId)) preparation.snapshots.push({
          blockId,
          isTitle: block.matches('h1.paper-title, h1[data-translate-block-id]'),
          source: paragraphTranslationSource(block),
        });
      }
      processed += 1;
      if (performance.now() >= deadline) break;
    }
    return preparation.index >= preparation.candidates.length;
  }

  async function runFullTranslation({ refresh = false, scope = translationScope() } = {}) {
    const jobId = state.activeJob?.job_id;
    if (!jobId) return;
    const existingRun = state.translationRuns.get(jobId);
    if (existingRun?.running) return;
    if (!aiServiceEnabled('translation')) {
      const message = '全文翻译服务当前不可用。';
      showToast(message, true);
      setPanelStatus(message, true);
      return;
    }
    if (!frameDocument()) return;
    const run = { jobId, generation: readerMount.generation, mount: readerMount, document: frameDocument(), title: documentTitleFor(jobId), running: true, stop: false, phase: 'pending', wake: null, done: 0, total: 0, failed: 0, detail: '', abortController: new AbortController() };
    state.translationRuns.set(jobId, run);
    syncTranslationControls();
    // Only IDs and extracted sources cross a yield; closing the reader releases its DOM.
    const preparation = { jobId, candidates: null, index: 0, total: 0, snapshots: [] };
    let nextIndex = 0;
    try {
      let prepared = false;
      while (!prepared) {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
        if (run.stop || run.abortController.signal.aborted) return;
        if (!readerMountIsCurrent(run.mount) || run.mount.generation !== run.generation || run.mount.frame.contentDocument !== run.document) {
          cancelTranslationRun(run);
          return;
        }
        prepared = fullTranslationSnapshot(run.document, scope, refresh, preparation);
      }
      const { total, snapshots } = preparation;
      run.total = total;
      run.done = total - snapshots.length;
      await acquireTranslationSlot(run);
      updateTranslationProgress(run);
      const worker = async () => {
        while (!run.stop && !run.abortController.signal.aborted) {
          const snapshot = snapshots[nextIndex++];
          if (!snapshot) return;
          const preview = snapshot.source.text.slice(0, 72);
          run.detail = preview ? `正在翻译：${preview}` : '';
          updateTranslationProgress(run);
          const translated = await translateSnapshot(snapshot, run, { refresh });
          if (!translated && !run.abortController.signal.aborted) run.failed += 1;
          run.done += 1;
          updateTranslationProgress(run);
        }
      };
      await Promise.all(Array.from({ length: Math.min(FULL_TRANSLATION_CONCURRENCY, snapshots.length) }, worker));
      run.detail = '';
      const prefix = state.activeJob?.job_id === jobId ? '' : `《${run.title}》`;
      const scopeLabel = scope === 'body' ? '正文' : '全文';
      if (run.stop) {
        showToast(`${prefix}${scopeLabel}翻译已停止，已完成的段落保留在本机。`);
      } else if (run.failed) {
        showToast(`${prefix}${scopeLabel}翻译完成，但有 ${run.failed} 段失败；失败段落可稍后单独重试。`, true);
      } else {
        showToast(total ? (snapshots.length ? `${prefix}${scopeLabel}翻译完成，译文已插入原文下方。` : `${scopeLabel}译文已存在，已直接复用本机缓存。再次点击可重新翻译${scopeLabel}。`) : '没有找到可翻译的正文段落。');
      }
    } catch (error) {
      showToast(`全文${translationErrorMessage(error)}`, true);
      if (state.activeJob?.job_id === jobId) setPanelStatus(error.message, true);
    } finally {
      run.running = false;
      run.mount = null;
      run.document = null;
      if (run.slotAcquired) {
        run.slotAcquired = false;
        releaseTranslationSlot();
      }
      // A finished run leaves the reading surface unobstructed but keeps its
      // final figures, so the panel still reports them when asked.
      if (state.translationRuns.get(jobId) === run) updateTranslationProgress(run, { visible: false });
      releaseClosedDocumentCaches(jobId);
      syncTranslationControls();
    }
  }

  function cancelTranslationRun(run) {
    if (!run) return;
    run.stop = true;
    run.abortController?.abort();
    if (run.wake) {
      const index = translationSlotWaiters.indexOf(run);
      if (index >= 0) translationSlotWaiters.splice(index, 1);
      run.wake();
    }
    updateTranslationProgress(run);
  }

  function stopFullTranslation(jobId = state.activeJob?.job_id) {
    const run = jobId ? state.translationRuns.get(jobId) : null;
    if (run?.running) cancelTranslationRun(run);
  }

  $('#view-translation-button')?.addEventListener('click', () => { if (state.activeJob) void openReader(state.activeJob); });

  function syncTranslationControls() {
    const jobId = state.activeJob?.job_id;
    const run = jobId ? state.translationRuns.get(jobId) : null;
    state.translationRun = run || null;
    const running = Boolean(run?.running);
    const fullButton = $('#full-translate-button');
    if (fullButton) fullButton.disabled = running;
    // The panel follows whichever document is on screen: a run that carried on
    // in the background shows up again the moment its document comes back.
    paintTranslationPanel(run, { visible: running });
    refreshBackgroundTasks();
  }
  $('#selection-popover')?.addEventListener('click', (event) => {
    if (!event.target.closest('[data-selection-translation-retry]') || !state.selection) return;
    beginSelectionTranslation({ ...state.selection }, { immediate: true });
  });

  async function invokeSelectionPlugin(pluginId, actionId, button) {
    const selection = state.selection;
    if (!selection) return;
    if (pluginId === 'guzi.vocabulary' && (selection.surface === 'translation' || !window.MyScholarCore.validSelectionTerm(selection.quote))) return;
    const record = selectionTranslationRecord?.key === selectionRequestKey(selection) ? selectionTranslationRecord : null;
    const snapshot = {
      term: selection.quote.trim(),
      source: {
        job_id: state.activeJob?.job_id, quote: selection.sentence || selection.quote, selected_text: selection.quote,
        block_id: selection.block_id, source_block_id: selection.source_block_id, surface: selection.surface === 'translation' ? 'translation' : 'source',
        page: selection.page ? Number(selection.page) : null,
        start: selection.start, end: selection.end,
        quote_prefix: selection.quote_prefix, quote_suffix: selection.quote_suffix,
        render_generation: String(selection.render_generation || 'base'),
      },
    };
    if (record) record.keepForVocabulary = true;
    button.disabled = true;
    try {
      await pluginHost.dispatchAction(pluginId, actionId, { snapshot, selection: { ...selection }, meaning: record?.text || '' }, record?.promise || null);
    } catch (error) { showToast(`插件动作失败：${error.message}`, true); }
    finally { renderSelectionActions(); }
  }
  $('#selection-add-vocabulary')?.addEventListener('click', (event) => void invokeSelectionPlugin('guzi.vocabulary', 'keep', event.currentTarget));
  $('#selection-plugin-actions')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-plugin-selection]');
    if (button && !button.disabled) void invokeSelectionPlugin(button.dataset.pluginSelection, button.dataset.pluginAction, button);
  });

  async function openPluginSource(source, { settleImages = false } = {}) {
    const job = state.jobs.find((item) => item.job_id === source?.job_id);
    if (!job || job.status !== 'completed' || state.library?.items?.[source.job_id]?.deleted_at) {
      throw new Error('来源文献已删除、在回收站中或尚不可用，请在插件中查看保留的来源快照。');
    }
    const expected = String(source.selected_text || '');
    if (!source.block_id && !expected) {
      openReader(job);
      return;
    }
    const generation = String(source.render_generation || 'base');
    if (generation !== activeChatSourceGeneration(job)) throw new Error('来源属于另一版正文或 AI 重排结果，无法安全跳转。请在插件中查看保留的来源快照。');
    openReader(job);
    const mount = readerMount;
    const deadline = Date.now() + 10000;
    while (readerMount === mount && !mount.ready && Date.now() < deadline) await new Promise((resolve) => window.setTimeout(resolve, 40));
    if (readerMount !== mount || state.activeJob?.job_id !== job.job_id) return;
    if (!mount.ready) throw new Error('来源正文尚未载入，请稍后重试。');
    if (generation !== activeChatSourceGeneration()) throw new Error('正文版本已变化，无法安全跳转。');
    const doc = frameDocument();
    const block = doc?.querySelector(`[data-block-id="${cssEscape(source.block_id || '')}"]`);
    const page = block?.dataset.page || block?.closest('[data-page]')?.dataset.page;
    if (!block || block.closest('.my-scholar-translation') || (source.page && String(source.page) !== String(page))) {
      showToast('未找到可确认的原文位置，正文可能已重排或更改。请在插件中查看保留的来源快照。', true);
      return;
    }
    if (settleImages) {
      // Earlier lazy images have no reserved height and can displace the demo's initial jump.
      const images = [...doc.images].filter((image) => block.contains(image) || block.compareDocumentPosition(image) & Node.DOCUMENT_POSITION_PRECEDING);
      images.forEach((image) => { image.loading = 'eager'; });
      await Promise.allSettled(images.map((image) => image.decode()));
      await readerFrames(doc, 2);
      if (readerMount !== mount) return;
    }
    if (!expected) {
      block.scrollIntoView({ block: 'center', behavior: reducedMotionQuery.matches ? 'auto' : 'smooth' });
      return;
    }
    const text = canonicalBlockText(block, doc);
    const start = Number(source.start);
    const end = Number(source.end);
    const prefixMatches = !source.quote_prefix || text.slice(Math.max(0, start - source.quote_prefix.length), start) === source.quote_prefix;
    const suffixMatches = !source.quote_suffix || text.slice(end, end + source.quote_suffix.length) === source.quote_suffix;
    if (!block || block.closest('.my-scholar-translation') || !expected || !Number.isInteger(start) || !Number.isInteger(end) || end <= start || text.slice(start, end) !== expected || !prefixMatches || !suffixMatches || (source.page && String(source.page) !== String(page))) {
      showToast('未找到可确认的原文位置，正文可能已重排或更改。请在插件中查看保留的来源快照。', true);
      return;
    }
    const range = rangeAtOffsets(block, start, end, doc);
    if (!range) { showToast('这个来源位置已失效，无法安全跳转。', true); return; }
    const selection = doc.getSelection();
    selection.removeAllRanges(); selection.addRange(range);
    block.scrollIntoView({ block: 'center', behavior: reducedMotionQuery.matches ? 'auto' : 'smooth' });
  }

  let toastTimer;
  function hideToast() {
    const node = $('#toast');
    if (!node || node.hidden || node.classList.contains('is-closing')) return;
    node.classList.add('is-closing');
    const finish = () => { node.hidden = true; node.classList.remove('is-closing'); };
    if (reducedMotionQuery.matches) finish();
    else toastTimer = window.setTimeout(finish, 160);
  }
  function showToast(message, error = false) {
    const node = $('#toast');
    if (!node) return;
    window.clearTimeout(toastTimer);
    node.classList.remove('is-closing');
    node.textContent = message || '';
    if (!message) { node.hidden = true; return; }
    node.hidden = false;
    node.classList.toggle('error', error);
    toastTimer = window.setTimeout(hideToast, 3600);
  }

  // Reading assistant panels, AI highlights and document-scoped chat.
  function setPanelStatus(message, error = false) { const node = $('#chat-status'); node.textContent = message || ''; node.hidden = !message; node.classList.toggle('error', error); }
  function switchSidebar(panelId, { open = true } = {}) {
    if (state.health?.readonly === true && !['outline-panel', 'quick-preview-panel'].includes(panelId)) panelId = 'outline-panel';
    const target = document.getElementById(panelId);
    if (!target?.classList.contains('sidebar-panel')) return;
    if (panelId !== 'chat-panel') closeChatSessionMenu();
    const current = $('.sidebar-panel.active-panel:not([hidden])');
    $$('.sidebar-tab').forEach((tab) => {
      const active = tab.dataset.panel === panelId;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    $$('.sidebar-panel').forEach((panel) => {
      if (panel === target || panel === current) return;
      panel.hidden = true;
      panel.classList.remove('active-panel', 'is-closing');
      panel.removeAttribute('aria-hidden');
    });
    openTransient(target);
    target.classList.add('active-panel');
    target.removeAttribute('aria-hidden');
    if (current && current !== target) {
      current.classList.remove('active-panel');
      current.setAttribute('aria-hidden', 'true');
      closeTransient(current, { onFinish: () => current.removeAttribute('aria-hidden') });
    }
    if (open) setAssistantOpen(true);
  }
  $$('.sidebar-tab').forEach((tab, index, tabs) => {
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', tab.dataset.panel);
    tab.setAttribute('aria-selected', String(tab.classList.contains('active')));
    tab.tabIndex = tab.classList.contains('active') ? 0 : -1;
    tab.addEventListener('click', () => switchSidebar(tab.dataset.panel));
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const step = event.key === 'ArrowRight' ? 1 : -1;
      const available = state.health?.readonly === true ? tabs.filter((item) => ['outline-panel', 'quick-preview-panel'].includes(item.dataset.panel) && !item.hidden) : tabs;
      const next = available[(available.indexOf(tab) + step + available.length) % available.length];
      switchSidebar(next.dataset.panel);
      next.focus();
    });
  });
  $$('.highlight-filter').forEach((button) => button.addEventListener('click', () => {
    state.highlightFilter = button.dataset.highlightFilter || 'all';
    $$('.highlight-filter').forEach((item) => item.classList.toggle('active', item === button));
    renderHighlightCards();
  }));

  const highlightCategoryLabels = { research_goal: '研究目标', method: '研究方法', conclusion: '主要结论', innovation: '创新点' };
  function normalizeHighlightCategory(value) { return Object.prototype.hasOwnProperty.call(highlightCategoryLabels, value) ? value : 'method'; }

  function renderHighlightCards() {
    const highlightList = $('#highlights-list');
    if (!highlightList) return;
    const highlights = state.aiHighlights;
    const visible = state.highlightFilter === 'all' ? highlights : highlights.filter((item) => normalizeHighlightCategory(item.category) === state.highlightFilter);
    if (!visible.length) {
      highlightList.innerHTML = '<div class="chat-empty">AI 还没有识别到这一类重点。</div>';
      return;
    }
    const groups = visible.reduce((map, item) => {
      const category = normalizeHighlightCategory(item.category);
      (map[category] ||= []).push(item);
      return map;
    }, {});
    highlightList.innerHTML = Object.entries(groups).map(([category, items]) => `<section class="highlight-group highlight-group-${category}"><h3>${highlightCategoryLabels[category]}</h3>${items.slice().reverse().map((item) => {
      const aiAnnotation = aiAnnotationForSuggestion(item);
      const manualAnnotation = manualAnnotationForSuggestion(item);
      const cardState = manualAnnotation ? 'accepted' : isIgnoredAISuggestion(aiAnnotation) ? 'ignored' : 'suggested';
      const statusLabel = manualAnnotation ? (manualAnnotation.note ? '✎ 我的笔记' : '✓ 我的高亮') : cardState === 'ignored' ? '已忽略' : '✦ AI 建议';
      const actions = cardState === 'suggested'
        ? '<button type="button" data-highlight-action="note">添加笔记</button><button type="button" data-highlight-action="adopt">转为高亮</button><button type="button" data-highlight-action="ignore">忽略</button>'
        : cardState === 'ignored'
          ? '<button type="button" data-highlight-action="restore">恢复</button>'
          : `<button type="button" data-highlight-action="open-personal">${manualAnnotation.note ? '查看笔记' : '查看标注'}</button>`;
      return `<article class="highlight-card is-${cardState}" data-highlight-state="${cardState}" data-ai-annotation-id="${escapeHTML(aiAnnotation?.id || '')}" data-manual-annotation-id="${escapeHTML(manualAnnotation?.id || '')}"><button class="highlight-card-main" type="button" data-highlight-main data-highlight-block="${escapeHTML(item.block_id)}"><span class="highlight-card-quote">${escapeHTML(item.quote)}</span>${item.reason ? `<span class="highlight-card-reason">${escapeHTML(item.reason)}</span>` : ''}</button><div class="highlight-card-footer"><span class="highlight-card-state">${statusLabel}</span><span class="highlight-card-actions">${actions}</span></div></article>`;
    }).join('')}</section>`).join('');
    highlightList.querySelectorAll('[data-highlight-main]').forEach((button) => button.addEventListener('click', () => {
      const card = button.closest('.highlight-card');
      const target = readerBlockById(button.dataset.highlightBlock);
      readerVisibleTarget(target)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      window.setTimeout(() => {
        const manual = state.annotations.find((item) => item.id === card.dataset.manualAnnotationId);
        const aiAnnotation = state.annotations.find((item) => item.id === card.dataset.aiAnnotationId);
        const doc = frameDocument();
        if (manual) {
          const trigger = annotationAnchor(doc, manual.id);
          if (trigger) showInlineAnnotation(manual, trigger);
        } else if (aiAnnotation && !isIgnoredAISuggestion(aiAnnotation)) {
          const mark = annotationAnchor(doc, aiAnnotation.id);
          if (mark) showAISuggestion(aiAnnotation, mark);
        }
      }, 180);
    }));
    highlightList.querySelectorAll('[data-highlight-action]').forEach((button) => button.addEventListener('click', async () => {
      const card = button.closest('.highlight-card');
      const aiAnnotation = state.annotations.find((item) => item.id === card.dataset.aiAnnotationId);
      const manual = state.annotations.find((item) => item.id === card.dataset.manualAnnotationId);
      const action = button.dataset.highlightAction;
      if (['note', 'adopt', 'open-personal'].includes(action)) {
        const blockId = card.querySelector('[data-highlight-main]')?.dataset.highlightBlock || '';
        readerVisibleTarget(readerBlockById(blockId))?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await new Promise((resolve) => window.setTimeout(resolve, 180));
      }
      if (action === 'note' && aiAnnotation) adoptAISuggestion(aiAnnotation, { withNote: true });
      else if (action === 'adopt' && aiAnnotation) adoptAISuggestion(aiAnnotation);
      else if (action === 'ignore' && aiAnnotation) {
        if (await setAISuggestionState(aiAnnotation, 'ignored')) {
          document.querySelector(`.highlight-card[data-ai-annotation-id="${cssEscape(aiAnnotation.id)}"] [data-highlight-action="restore"]`)?.focus();
        }
      } else if (action === 'restore' && aiAnnotation) {
        if (await setAISuggestionState(aiAnnotation, 'suggested')) {
          document.querySelector(`.highlight-card[data-ai-annotation-id="${cssEscape(aiAnnotation.id)}"] [data-highlight-action="note"]`)?.focus();
        }
      }
      else if (action === 'open-personal' && manual) {
        const doc = frameDocument();
        const trigger = annotationAnchor(doc, manual.id);
        if (trigger) showInlineAnnotation(manual, trigger);
      }
    }));
  }

  function renderAnnotations() {
    const manualAnnotations = state.annotations.filter((item) => !isAIAnnotation(item));
    const notedAnnotations = manualAnnotations.filter(hasAnnotationNote);
    $('#annotation-count').textContent = `${notedAnnotations.length} 条笔记`;
    $('#clear-annotations-button').disabled = !manualAnnotations.length;
    if (!notedAnnotations.length) { $('#annotations-list').innerHTML = '<div class="chat-empty">还没有添加笔记。正文中的高亮和划线仍会保留。</div>'; }
    else $('#annotations-list').innerHTML = notedAnnotations.slice().reverse().map((item) => `<div class="annotation-item ${item.kind === 'underline' ? 'underline' : ''}" data-annotation-id="${escapeHTML(item.id)}" style="--annotation-color:${normalizeAnnotationColor(item.color)}"><div class="annotation-quote">${escapeHTML(item.quote)}</div><div class="annotation-note">${renderMarkdown(item.note)}</div><div class="annotation-meta"><span>${item.label ? `${escapeHTML(item.label)} · ` : ''}第 ${escapeHTML(item.page || '—')} 页</span><button type="button" class="delete-annotation">删除</button></div></div>`).join('');
    renderHighlightCards();
    if (!notedAnnotations.length) return;
    $$('.annotation-item').forEach((node) => {
      const item = state.annotations.find((annotation) => annotation.id === node.dataset.annotationId);
      node.querySelector('.annotation-quote').addEventListener('click', () => {
        const target = resolveAnnotationAnchor(item)?.root;
        readerVisibleTarget(target)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const trigger = frameDocument()?.querySelector(`.annotation-note-trigger[data-annotation-id="${cssEscape(item?.id || '')}"]`);
        if (trigger && item) showInlineAnnotation(item, trigger);
      });
      node.querySelector('.delete-annotation').addEventListener('click', () => deleteAnnotation(item));
    });
  }
  $('#clear-annotations-button').addEventListener('click', clearManualAnnotations);

  function legacyChatStorageKey(jobId = state.activeJob?.job_id) { return `my-scholar-chat:${jobId || 'none'}`; }
  function chatStorageKey(jobId = state.activeJob?.job_id) { return `my-scholar-chat-v2:${jobId || 'none'}`; }

  const chatMaxMessageChars = 120000;
  const chatMaxMessagesPerSession = 40;
  const chatMaxSessions = 50;
  const chatPersistMaxBytes = 4 * 1024 * 1024;
  const chatPersistReserveBytes = 128 * 1024;
  const chatMarkdownMaxDepth = 16;
  const aiStreamMaxBytes = 8 * 1024 * 1024;
  const aiStreamMaxBufferChars = 1024 * 1024;
  const chatPersistTimers = new Map();
  const chatTextEncoder = new TextEncoder();

  function chatRecordId(prefix = 'message') {
    const suffix = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    return `${prefix}-${suffix}`;
  }

  function normalizeChatSourceGeneration(value) {
    const generation = String(value || '');
    return generation === 'base' || /^[1-9][0-9]{0,8}$/.test(generation) ? generation : '';
  }

  function activeChatSourceGeneration(job = state.activeJob) {
    return normalizeChatSourceGeneration(job?.active_render) || 'base';
  }

  function normalizedChatMessage(message) {
    if (!message || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string') return null;
    const sourceGeneration = message.role === 'assistant' ? normalizeChatSourceGeneration(message.sourceGeneration) : '';
    return {
      id: typeof message.id === 'string' && message.id ? message.id.slice(0, 160) : chatRecordId('message'),
      role: message.role,
      content: message.content.slice(0, chatMaxMessageChars),
      ...(typeof message.quote === 'string' && message.quote ? { quote: message.quote.slice(0, 10000) } : {}),
      ...(sourceGeneration ? { sourceGeneration } : {}),
      ...(message.streaming ? { streaming: true } : {}),
    };
  }

  function chatSessionTitle(messages, fallback = '新会话') {
    const firstQuestion = messages.find((message) => message.role === 'user')?.content || '';
    const title = firstQuestion.replace(/\s+/g, ' ').trim();
    return title ? title.slice(0, 36) : fallback;
  }

  function normalizeChatPinnedAt(value) {
    const timestamp = Date.parse(String(value || ''));
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '';
  }

  function newChatThread(messages = [], title = '') {
    const now = new Date().toISOString();
    const normalized = messages.slice(-chatMaxMessagesPerSession).map(normalizedChatMessage).filter(Boolean);
    return {
      id: chatRecordId('session'),
      title: title || chatSessionTitle(normalized),
      titleMode: 'auto',
      options: {},
      createdAt: now,
      updatedAt: now,
      messages: normalized,
    };
  }

  function normalizeChatOptions(value) {
    const options = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return options;
    if (typeof value.reasoning_effort === 'string' && value.reasoning_effort.trim()) options.reasoning_effort = value.reasoning_effort.trim().slice(0, 80);
    for (const key of ['thinking_budget', 'context_window']) {
      if (Number.isSafeInteger(value[key]) && value[key] >= 0) options[key] = value[key];
    }
    return options;
  }

  function normalizeChatContext(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const context = {};
    for (const key of ['window', 'estimated_input_tokens', 'output_tokens']) {
      if (Number.isSafeInteger(value[key]) && value[key] >= 0) context[key] = value[key];
    }
    if (typeof value.truncated === 'boolean') context.truncated = value.truncated;
    if (typeof value.source === 'string') context.source = value.source.slice(0, 120);
    return Object.keys(context).length ? context : null;
  }

  function aiProfileIdentity(profile = {}) {
    return JSON.stringify([profile.base_url || '', profile.api_format || 'auto']);
  }

  function aiCapabilities(service, profile = state.aiProfiles[service] || {}) {
    const saved = state.aiProfiles[service] || {};
    const cached = state.aiModelCapabilities[service];
    if (cached?.identity === aiProfileIdentity(profile) && cached.models?.[profile.model]) return cached.models[profile.model];
    if (profile.model === saved.model && aiProfileIdentity(profile) === aiProfileIdentity(saved)) return saved.capabilities || {};
    return {};
  }

  function aiReasoningChoices(capabilities = {}) {
    const values = Array.isArray(capabilities.reasoning_efforts) ? [...new Set(capabilities.reasoning_efforts.map(String))] : null;
    if (capabilities.thinking_supported === true && capabilities.thinking_required === false) {
      if (values && !values.includes('none')) values.unshift('none');
    }
    return values?.filter((value) => value !== 'auto' && (value !== 'none' || capabilities.thinking_required !== true));
  }

  function aiOptionWarning(options, capabilities = {}) {
    const effort = options.reasoning_effort;
    const choices = aiReasoningChoices(capabilities);
    if (effort && effort !== 'auto') {
      if (effort === 'none' && capabilities.thinking_required === true) return '当前模型要求开启思考；请更改推理强度。';
      const canDisable = effort === 'none' && capabilities.thinking_supported === true && capabilities.thinking_required === false;
      if (!canDisable && choices && !choices.includes(effort)) return `当前模型不支持推理档位“${effort}”；请重新选择或使用自动。`;
      if (!canDisable && capabilities.thinking_supported === false) return '当前模型不支持思考选项；请使用自动或跟随设置。';
    }
    const budget = options.thinking_budget;
    if (budget > 0) {
      if (capabilities.thinking_supported === false || capabilities.thinking_budget_supported === false) return '当前模型不支持思考预算；请使用自动或跟随设置。';
      if (effort === 'none') return '关闭思考时不能同时设置思考预算；请将预算改为自动。';
      if (capabilities.thinking_budget_min > budget) return `思考预算至少为 ${capabilities.thinking_budget_min} tokens。`;
      if (capabilities.thinking_budget_max > 0 && budget > capabilities.thinking_budget_max) return `思考预算最多为 ${capabilities.thinking_budget_max} tokens。`;
    }
    const context = options.context_window || capabilities.context_window || 0;
    if (context && budget >= context) return '思考预算必须小于上下文窗口。';
    return '';
  }

  function capabilityDescription(capabilities = {}) {
    const parts = [];
    if (capabilities.context_window > 0) parts.push(`上下文 ${Number(capabilities.context_window).toLocaleString()} tokens`);
    if (capabilities.thinking_supported !== undefined && capabilities.thinking_supported !== null) {
      parts.push(capabilities.thinking_required ? '必须开启思考' : capabilities.thinking_supported ? '支持思考' : '不支持思考');
    }
    if (capabilities.max_input_tokens > 0) parts.push(`最大输入 ${Number(capabilities.max_input_tokens).toLocaleString()}`);
    if (capabilities.max_output_tokens > 0) parts.push(`最大输出 ${Number(capabilities.max_output_tokens).toLocaleString()}`);
    if (typeof capabilities.thinking_supported !== 'boolean' && !Array.isArray(capabilities.reasoning_efforts)) parts.push('能力未知，可手动覆盖；请以服务商文档为准');
    if (!parts.length) parts.push('能力未知，可手动覆盖；请以服务商文档为准');
    if (capabilities.source && capabilities.source !== 'unknown') parts.push(`来源：${capabilities.source}`);
    return parts.join(' · ');
  }

  const aiReasoningLabels = { auto: '自动（服务默认）', none: '关闭思考', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高' };
  function renderReasoningControl(prefix, value, capabilities, { inherit = false } = {}) {
    const select = $(`#${prefix}-reasoning-effort`);
    if (!select) return;
    const choices = aiReasoningChoices(capabilities);
    const unknown = choices === null || choices === undefined;
    const values = ['auto', ...(choices || [])];
    if (capabilities.thinking_supported === true && capabilities.thinking_required === false && !values.includes('none')) values.push('none');
    const canCustomize = unknown && capabilities.thinking_supported !== false;
    const selected = value === undefined && inherit ? 'inherit' : value || 'auto';
    const custom = canCustomize && !values.includes(selected) && selected !== 'inherit';
    select.innerHTML = `${inherit ? '<option value="inherit">跟随设置</option>' : ''}${values.map((item) => `<option value="${escapeHTML(item)}">${escapeHTML(aiReasoningLabels[item] || item)}</option>`).join('')}${canCustomize ? '<option value="custom">自定义…</option>' : ''}${!custom && selected !== 'inherit' && !values.includes(selected) ? `<option value="${escapeHTML(selected)}">${escapeHTML(selected)}（当前模型不支持）</option>` : ''}`;
    select.value = custom ? 'custom' : selected;
    const input = $(`#${prefix}-reasoning-custom`);
    if (input && custom) input.value = selected;
    const customField = $(`#${prefix}-reasoning-custom-field`);
    if (customField) customField.hidden = !custom;
    const field = $(`#${prefix}-reasoning-field`);
    if (field) field.hidden = capabilities.thinking_supported === false && (selected === 'auto' || selected === 'inherit') && (!choices || !choices.length);
    const budgetField = $(`#${prefix}-thinking-field`);
    if (budgetField) budgetField.hidden = capabilities.thinking_supported === false || capabilities.thinking_budget_supported === false;
  }

  function reasoningFromControl(prefix) {
    const selected = $(`#${prefix}-reasoning-effort`)?.value;
    return selected === 'custom' ? $(`#${prefix}-reasoning-custom`)?.value.trim() || 'auto' : selected || 'auto';
  }

  function renderAIInferenceControls(service) {
    const profile = aiSettingsFromControls()[service];
    const capabilities = aiCapabilities(service, profile);
    const enabled = service !== 'translation' || profile.provider === 'openai-compatible' && profile.mode === 'chat';
    const panel = $(`#setting-${service}-inference`);
    if (panel) panel.hidden = !enabled;
    const effort = reasoningFromControl(`setting-${service}`);
    renderReasoningControl(`setting-${service}`, effort, capabilities);
    $(`#setting-${service}-thinking-field`).hidden = (capabilities.thinking_supported === false || capabilities.thinking_budget_supported === false) && !(profile.thinking_budget > 0);
    $(`#setting-${service}-capability-status`).textContent = capabilityDescription(capabilities);
    const warning = enabled ? aiOptionWarning(profile, capabilities) : '';
    const warningNode = $(`#setting-${service}-options-warning`);
    warningNode.textContent = warning;
    warningNode.hidden = !warning;
  }

  function validateAISettingsControls() {
    for (const service of ['translation', 'chat']) {
      const profile = aiSettingsFromControls()[service];
      if (service === 'translation' && (profile.provider !== 'openai-compatible' || profile.mode !== 'chat')) continue;
      for (const name of ['thinking-budget', 'context-window']) {
        const input = $(`#setting-${service}-${name}`);
        if (input) {
          input.setCustomValidity(Number.isSafeInteger(Number(input.value || 0)) ? '' : '请输入有效的整数 token 数。');
          if (!input.checkValidity()) {
            showSettingsSection('settings-ai');
            input.closest('details')?.setAttribute('open', '');
            input.reportValidity();
            return false;
          }
        }
      }
      renderAIInferenceControls(service);
      if (aiOptionWarning(profile, aiCapabilities(service, profile))) {
        showSettingsSection('settings-ai');
        $(`#setting-${service}-advanced`)?.setAttribute('open', '');
        $(`#setting-${service}-options-warning`)?.scrollIntoView({ block: 'nearest' });
        return false;
      }
    }
    return true;
  }

  function chatEffectiveOptions(thread, profile = state.aiProfiles.chat || {}) {
    return { ...normalizeChatOptions(profile), ...normalizeChatOptions(thread?.options) };
  }

  function renderChatContext(thread) {
    const node = $('#chat-context-status');
    if (!node) return;
    const context = thread?.context;
    if (!context) { node.hidden = true; return; }
    const parts = [];
    if (context.window) parts.push(`上下文 ${context.window.toLocaleString()} tokens`);
    if (context.estimated_input_tokens !== undefined) parts.push(`预计输入 ${context.estimated_input_tokens.toLocaleString()}`);
    if (context.output_tokens !== undefined) parts.push(`输出预留 ${context.output_tokens.toLocaleString()}`);
    if (context.truncated) parts.push('已裁剪较早会话或正文以适应预算');
    node.textContent = parts.join(' · ');
    node.title = context.source ? `预算来源：${context.source}` : '';
    node.hidden = !parts.length;
  }

  function renderChatOptions({ force = false } = {}) {
    if (!state.activeJob) return;
    const thread = activeChatThread();
    const profile = state.aiProfiles.chat || {};
    const capabilities = aiCapabilities('chat', profile);
    const options = normalizeChatOptions(thread.options);
    const panel = $('#chat-session-options');
    if (!panel) return;
    const renderKey = JSON.stringify([thread.id, options, profile]);
    if (force || panel.dataset.renderKey !== renderKey) {
      panel.dataset.renderKey = renderKey;
      renderReasoningControl('chat', options.reasoning_effort, capabilities, { inherit: true });
      const inheritedEffort = profile.reasoning_effort || 'auto';
      $('#chat-reasoning-effort option[value="inherit"]').textContent = `跟随设置（${aiReasoningLabels[inheritedEffort] || inheritedEffort}）`;
      const effective = chatEffectiveOptions(thread);
      if (effective.reasoning_effort && effective.reasoning_effort !== 'auto' && aiOptionWarning(effective, capabilities)) $('#chat-reasoning-field').hidden = false;
      $('#chat-thinking-field').hidden = (capabilities.thinking_supported === false || capabilities.thinking_budget_supported === false) && !(effective.thinking_budget > 0);
      for (const [name, key] of [['thinking', 'thinking_budget'], ['context', 'context_window']]) {
        const value = options[key];
        $(`#chat-${name}-mode`).value = value === undefined ? 'inherit' : value === 0 ? 'auto' : 'custom';
        const inheritedValue = profile[key] || 0;
        $(`#chat-${name}-mode option[value="inherit"]`).textContent = `跟随设置（${inheritedValue ? `${inheritedValue.toLocaleString()} tokens` : '自动'}）`;
        const input = $(`#chat-${key.replaceAll('_', '-')}`);
        input.value = value > 0 ? value : '';
        input.hidden = !(value > 0);
      }
      $('#chat-capability-status').textContent = capabilityDescription(capabilities);
      const warning = aiOptionWarning(chatEffectiveOptions(thread), capabilities);
      $('#chat-options-warning').textContent = warning;
      $('#chat-options-warning').hidden = !warning;
      const summary = [];
      if (options.reasoning_effort !== undefined) summary.push(aiReasoningLabels[options.reasoning_effort] || options.reasoning_effort);
      if (options.thinking_budget !== undefined) summary.push(options.thinking_budget ? `思考 ${options.thinking_budget}` : '思考自动');
      if (options.context_window !== undefined) summary.push(options.context_window ? `上下文 ${options.context_window}` : '上下文自动');
      $('#chat-options-summary').textContent = summary.join(' · ') || '跟随设置';
    }
    renderChatContext(thread);
  }

  function updateChatOptions() {
    if (!state.activeJob) return;
    const thread = activeChatThread();
    const options = {};
    const effort = reasoningFromControl('chat');
    if (effort !== 'inherit') options.reasoning_effort = effort;
    for (const [name, key] of [['thinking', 'thinking_budget'], ['context', 'context_window']]) {
      const mode = $(`#chat-${name}-mode`).value;
      const input = $(`#chat-${key.replaceAll('_', '-')}`);
      input.hidden = mode !== 'custom';
      if (mode === 'auto') options[key] = 0;
      if (mode === 'custom') {
        if (!input.value) { input.focus(); return; }
        input.setCustomValidity(Number.isSafeInteger(Number(input.value)) ? '' : '请输入有效的整数 token 数。');
        if (!input.checkValidity()) { input.reportValidity(); return; }
        options[key] = Number(input.value);
      }
    }
    thread.options = normalizeChatOptions(options);
    touchChatThread(thread);
    persistChatSession(state.activeJob.job_id);
    renderChatOptions({ force: true });
  }

  function normalizeChatEnvelope(value, legacyMessages = []) {
    const sessions = value?.version === 2 && Array.isArray(value.sessions)
      ? value.sessions.slice(0, chatMaxSessions).map((session) => {
        if (!session || typeof session !== 'object' || !Array.isArray(session.messages)) return null;
        const messages = session.messages.slice(-chatMaxMessagesPerSession).map(normalizedChatMessage).filter(Boolean);
        return {
          id: typeof session.id === 'string' && session.id ? session.id.slice(0, 160) : chatRecordId('session'),
          title: typeof session.title === 'string' && session.title.trim() ? session.title.trim().slice(0, 80) : chatSessionTitle(messages),
          titleMode: session.titleMode === 'manual' ? 'manual' : 'auto',
          options: normalizeChatOptions(session.options),
          ...(normalizeChatContext(session.context) ? { context: normalizeChatContext(session.context) } : {}),
          ...(normalizeChatPinnedAt(session.pinnedAt) ? { pinnedAt: normalizeChatPinnedAt(session.pinnedAt) } : {}),
          createdAt: typeof session.createdAt === 'string' ? session.createdAt.slice(0, 64) : new Date().toISOString(),
          updatedAt: typeof session.updatedAt === 'string' ? session.updatedAt.slice(0, 64) : new Date().toISOString(),
          messages,
        };
      }).filter(Boolean)
      : [];
    if (!sessions.length) sessions.push(newChatThread(legacyMessages, legacyMessages.length ? '历史会话' : '新会话'));
    const requested = typeof value?.activeSessionId === 'string' ? value.activeSessionId : '';
    const activeSessionId = sessions.some((session) => session.id === requested) ? requested : sessions[0].id;
    return { version: 2, activeSessionId, sessions };
  }

  function recoverInterruptedChat(envelope) {
    let recovered = false;
    envelope.sessions.forEach((session) => session.messages.forEach((message) => {
      if (!message.streaming) return;
      delete message.streaming;
      message.content = message.content
        ? `${message.content}\n\n（上次回答在应用关闭时中断。）`
        : '上次回答在应用关闭时中断，请重新提问。';
      session.updatedAt = new Date().toISOString();
      recovered = true;
    }));
    return recovered;
  }

  function chatEnvelope(jobId) {
    if (!jobId) return normalizeChatEnvelope(null);
    const existing = state.chatSessions.get(jobId);
    if (existing) return existing;
    let value = null;
    let legacyMessages = [];
    try { value = JSON.parse(persistentStateGet(chatStorageKey(jobId)) || 'null'); } catch (_) { /* Fall through to the legacy key. */ }
    if (!value || value.version !== 2) {
      try {
        const stored = JSON.parse(persistentStateGet(legacyChatStorageKey(jobId)) || '[]');
        if (Array.isArray(stored)) legacyMessages = stored;
      } catch (_) { /* Ignore one malformed local draft instead of breaking the reader. */ }
    }
    const envelope = normalizeChatEnvelope(value, legacyMessages);
    state.chatSessions.set(jobId, envelope);
    if (recoverInterruptedChat(envelope)) persistChatSession(jobId);
    return envelope;
  }

  function activeChatThread(jobId = state.activeJob?.job_id) {
    const envelope = chatEnvelope(jobId);
    return envelope.sessions.find((session) => session.id === envelope.activeSessionId) || envelope.sessions[0];
  }

  function touchChatThread(thread) {
    if (!thread) return;
    thread.updatedAt = new Date().toISOString();
    if (thread.titleMode !== 'manual') thread.title = chatSessionTitle(thread.messages, thread.title || '新会话');
  }

  function trimChatThread(thread) {
    if (!thread || thread.messages.length <= chatMaxMessagesPerSession) return;
    thread.messages.splice(0, thread.messages.length - chatMaxMessagesPerSession);
  }

  function serializableChatEnvelope(envelope) {
    const indexed = envelope.sessions.slice(0, chatMaxSessions).map((session, index) => ({ session, index }));
    indexed.sort((left, right) => {
      const leftActive = left.session.id === envelope.activeSessionId ? 0 : 1;
      const rightActive = right.session.id === envelope.activeSessionId ? 0 : 1;
      return leftActive - rightActive || left.index - right.index;
    });
    let usedBytes = chatPersistReserveBytes;
    const selected = indexed.map(({ session, index }) => {
      const messages = [];
      for (const message of session.messages.slice(-chatMaxMessagesPerSession).reverse()) {
        const normalized = normalizedChatMessage(message);
        if (!normalized) continue;
        const messageBytes = chatTextEncoder.encode(JSON.stringify(normalized)).byteLength + 1;
        if (usedBytes + messageBytes > chatPersistMaxBytes) continue;
        usedBytes += messageBytes;
        messages.unshift(normalized);
      }
      return {
        index,
        value: {
          id: String(session.id || chatRecordId('session')).slice(0, 160),
          title: String(session.title || chatSessionTitle(messages)).slice(0, 80),
          titleMode: session.titleMode === 'manual' ? 'manual' : 'auto',
          options: normalizeChatOptions(session.options),
          ...(normalizeChatContext(session.context) ? { context: normalizeChatContext(session.context) } : {}),
          ...(normalizeChatPinnedAt(session.pinnedAt) ? { pinnedAt: normalizeChatPinnedAt(session.pinnedAt) } : {}),
          createdAt: String(session.createdAt || new Date().toISOString()).slice(0, 64),
          updatedAt: String(session.updatedAt || new Date().toISOString()).slice(0, 64),
          messages,
        },
      };
    }).sort((left, right) => left.index - right.index).map((item) => item.value);
    return { version: 2, activeSessionId: envelope.activeSessionId, sessions: selected };
  }

  function persistChatSession(jobId) {
    if (!jobId) return;
    const timer = chatPersistTimers.get(jobId);
    if (timer) window.clearTimeout(timer);
    chatPersistTimers.delete(jobId);
    const envelope = state.chatSessions.get(jobId);
    if (!envelope) return;
    const serializable = serializableChatEnvelope(envelope);
    const payload = JSON.stringify(serializable);
    if (chatTextEncoder.encode(payload).byteLength > chatPersistMaxBytes) {
      throw new Error('会话记录超过本地安全上限。');
    }
    if (!envelope.sessions.some((session) => session.messages.some((message) => message.streaming))) {
      const storedById = new Map(serializable.sessions.map((session) => [session.id, session]));
      envelope.sessions.forEach((session) => {
        const stored = storedById.get(session.id);
        if (stored) session.messages.splice(0, session.messages.length, ...stored.messages);
      });
    }
    persistentStateSet(chatStorageKey(jobId), payload);
  }

  function scheduleChatSessionPersist(jobId) {
    if (request.closeGate) return;
    if (!jobId || chatPersistTimers.has(jobId)) return;
    chatPersistTimers.set(jobId, window.setTimeout(() => persistChatSession(jobId), 180));
  }

  function chatSession(jobId) {
    return jobId ? activeChatThread(jobId).messages : [];
  }

  function flushPendingChatSessions() {
    for (const jobId of state.chatSessions.keys()) persistChatSession(jobId);
    return true;
  }

  function setChatHistoryOpen(open, { focus = true } = {}) {
    const conversation = $('#chat-conversation-view');
    const history = $('#chat-history-view');
    const switcher = $('#open-chat-history');
    if (!conversation || !history) return;
    const next = Boolean(open);
    conversation.hidden = next;
    conversation.setAttribute('aria-hidden', String(next));
    history.hidden = !next;
    history.setAttribute('aria-hidden', String(!next));
    switcher?.setAttribute('aria-expanded', String(next));
    if (!next) closeChatSessionMenu();
    if (next) renderChatSessionControls();
    if (!focus) return;
    window.requestAnimationFrame(() => {
      const target = next
        ? history.querySelector('[data-chat-session-id][aria-current="true"], [data-chat-session-id]')
        : $('#chat-input');
      target?.focus({ preventScroll: true });
    });
  }

  function chatSessionTime(value) {
    const timestamp = Date.parse(String(value || ''));
    if (!Number.isFinite(timestamp)) return '';
    return new Intl.DateTimeFormat('zh-CN', {
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(timestamp));
  }

  function sortedChatThreads(envelope) {
    return [...envelope.sessions].sort((left, right) => {
      const leftPinned = Date.parse(left.pinnedAt || '');
      const rightPinned = Date.parse(right.pinnedAt || '');
      const leftIsPinned = Number.isFinite(leftPinned);
      const rightIsPinned = Number.isFinite(rightPinned);
      if (leftIsPinned !== rightIsPinned) return leftIsPinned ? -1 : 1;
      if (leftIsPinned && leftPinned !== rightPinned) return rightPinned - leftPinned;
      return (Date.parse(right.updatedAt || '') || 0) - (Date.parse(left.updatedAt || '') || 0);
    });
  }

  function renderChatSessionControls(jobId = state.activeJob?.job_id) {
    const createButton = $('#new-chat-session');
    const historyButton = $('#open-chat-history');
    const historyList = $('#chat-history-list');
    const currentTitle = $('#chat-current-session-title');
    const historyCount = $('#chat-history-count');
    if (!createButton || !historyButton || !historyList) return;
    if (!jobId) {
      historyList.replaceChildren();
      createButton.disabled = true;
      historyButton.disabled = true;
      delete historyButton.dataset.chatSessionId;
      historyButton.setAttribute('aria-label', '文章助手会话');
      if (currentTitle) currentTitle.textContent = '文章助手';
      if (historyCount) historyCount.textContent = '请先打开一篇文章';
      return;
    }
    const envelope = chatEnvelope(jobId);
    const active = envelope.sessions.find((session) => session.id === envelope.activeSessionId) || envelope.sessions[0];
    const sessions = sortedChatThreads(envelope);
    historyList.replaceChildren(...sessions.map((session) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chat-history-item';
      button.dataset.chatSessionId = session.id;
      button.setAttribute('role', 'listitem');
      button.setAttribute('aria-current', String(session.id === envelope.activeSessionId));
      button.setAttribute('aria-haspopup', 'menu');
      const title = document.createElement('span');
      title.className = 'chat-history-item-title';
      title.textContent = session.title || '新会话';
      if (session.pinnedAt) {
        const pin = document.createElement('span');
        pin.className = 'chat-history-item-pin';
        pin.textContent = '置顶';
        title.prepend(pin);
      }
      const meta = document.createElement('span');
      meta.className = 'chat-history-item-meta';
      meta.textContent = `${session.messages.length} 条消息${chatSessionTime(session.updatedAt) ? ` · ${chatSessionTime(session.updatedAt)}` : ''}`;
      button.append(title, meta);
      return button;
    }));
    historyButton.dataset.chatSessionId = active?.id || '';
    historyButton.setAttribute('aria-label', `${active?.title || '文章助手'}；单击切换历史会话，右键管理当前会话`);
    if (currentTitle) currentTitle.textContent = active?.title || '文章助手';
    if (historyCount) historyCount.textContent = `${envelope.sessions.length} 个会话 · 每篇文章最多保留 50 个`;
    createButton.disabled = envelope.sessions.length >= chatMaxSessions;
    historyButton.disabled = false;
  }

  function activateChatThread(jobId, sessionId) {
    if (!jobId) return false;
    const envelope = chatEnvelope(jobId);
    const thread = envelope.sessions.find((session) => session.id === sessionId);
    if (!thread) return false;
    envelope.activeSessionId = thread.id;
    if (state.activeJob?.job_id === jobId) {
      state.chat = thread.messages;
      renderChatSessionControls(jobId);
      renderChat();
      setPanelStatus('');
      setChatHistoryOpen(false);
    }
    persistChatSession(jobId);
    return true;
  }

  function createChatThread(jobId = state.activeJob?.job_id) {
    if (!jobId) return null;
    const envelope = chatEnvelope(jobId);
    if (envelope.sessions.length >= 50) {
      showToast('每篇文章最多保留 50 个会话，请继续使用已有会话。', true);
      return null;
    }
    const thread = newChatThread();
    envelope.sessions.unshift(thread);
    envelope.activeSessionId = thread.id;
    state.chat = thread.messages;
    persistChatSession(jobId);
    renderChatSessionControls(jobId);
    renderChat();
    setChatHistoryOpen(false);
    return thread;
  }

  let chatSessionMenuId = '';
  let chatSessionMenuTrigger = null;
  let chatRenameSessionId = '';

  function closeChatSessionMenu({ restoreFocus = false } = {}) {
    const menu = $('#chat-session-menu');
    if (!menu || menu.hidden) return false;
    menu.hidden = true;
    menu.style.removeProperty('left');
    menu.style.removeProperty('top');
    menu.style.removeProperty('width');
    menu.style.removeProperty('max-height');
    delete menu.dataset.placement;
    const trigger = chatSessionMenuTrigger;
    chatSessionMenuId = '';
    chatSessionMenuTrigger = null;
    if (restoreFocus && trigger?.isConnected) trigger.focus({ preventScroll: true });
    return true;
  }

  function openChatSessionMenu(button, { clientX = null, clientY = null, focusFirst = false } = {}) {
    const jobId = state.activeJob?.job_id;
    const sessionId = button?.dataset.chatSessionId || '';
    const thread = jobId ? chatEnvelope(jobId).sessions.find((session) => session.id === sessionId) : null;
    const menu = $('#chat-session-menu');
    if (!thread || !menu) return;
    closeChatSessionMenu();
    chatSessionMenuId = sessionId;
    chatSessionMenuTrigger = button;
    const pin = menu.querySelector('[data-chat-session-action="pin"]');
    const remove = menu.querySelector('[data-chat-session-action="delete"]');
    if (pin) pin.textContent = thread.pinnedAt ? '取消置顶' : '置顶';
    if (remove) {
      remove.disabled = thread.messages.some((message) => message.streaming);
      remove.title = remove.disabled ? '回答生成期间不能删除此会话' : '';
    }
    menu.hidden = false;
    positionViewportMenu(menu, button.getBoundingClientRect(), { clientX, clientY });
    if (focusFirst) window.requestAnimationFrame(() => menu.querySelector('button:not([disabled])')?.focus({ preventScroll: true }));
  }

  function focusChatHistorySession(sessionId) {
    window.requestAnimationFrame(() => {
      document.querySelector(`#chat-history-list [data-chat-session-id="${cssEscape(sessionId)}"]`)?.focus({ preventScroll: true });
    });
  }

  function toggleChatThreadPinned(jobId, sessionId) {
    const envelope = chatEnvelope(jobId);
    const thread = envelope.sessions.find((session) => session.id === sessionId);
    if (!thread) return;
    if (thread.pinnedAt) delete thread.pinnedAt;
    else thread.pinnedAt = new Date().toISOString();
    persistChatSession(jobId);
    renderChatSessionControls(jobId);
    focusChatHistorySession(sessionId);
  }

  function deleteChatThread(jobId, sessionId) {
    const envelope = chatEnvelope(jobId);
    const thread = envelope.sessions.find((session) => session.id === sessionId);
    if (!thread) return false;
    if (thread.messages.some((message) => message.streaming)) {
      showToast('回答生成期间不能删除此会话。', true);
      return false;
    }
    const ordered = sortedChatThreads(envelope);
    const deletedIndex = ordered.findIndex((session) => session.id === sessionId);
    envelope.sessions = envelope.sessions.filter((session) => session.id !== sessionId);
    if (!envelope.sessions.length) envelope.sessions.push(newChatThread());
    if (envelope.activeSessionId === sessionId) {
      const replacement = ordered.slice(deletedIndex + 1).find((session) => session.id !== sessionId && envelope.sessions.includes(session))
        || [...ordered.slice(0, deletedIndex)].reverse().find((session) => envelope.sessions.includes(session))
        || envelope.sessions[0];
      envelope.activeSessionId = replacement.id;
    }
    if (state.activeJob?.job_id === jobId) state.chat = activeChatThread(jobId).messages;
    persistChatSession(jobId);
    renderChatSessionControls(jobId);
    renderChat();
    focusChatHistorySession(envelope.activeSessionId);
    return true;
  }

  function openChatRenameDialog(jobId, sessionId) {
    const thread = chatEnvelope(jobId).sessions.find((session) => session.id === sessionId);
    const dialog = $('#chat-session-rename-dialog');
    const input = $('#chat-session-title-input');
    if (!thread || !dialog || !input) return;
    chatRenameSessionId = sessionId;
    input.value = thread.title || '新会话';
    input.setCustomValidity('');
    if (!dialog.open) dialog.showModal();
    window.requestAnimationFrame(() => { input.focus({ preventScroll: true }); input.select(); });
  }

  $('#open-chat-history')?.addEventListener('click', () => setChatHistoryOpen($('#chat-history-view')?.hidden !== false));
  $('#open-chat-history')?.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    openChatSessionMenu(event.currentTarget, { clientX: event.clientX, clientY: event.clientY, focusFirst: true });
  });
  $('#open-chat-history')?.addEventListener('keydown', (event) => {
    if (!(event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) return;
    event.preventDefault();
    openChatSessionMenu(event.currentTarget, { focusFirst: true });
  });
  $('#chat-history-list')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-chat-session-id]');
    if (button) activateChatThread(state.activeJob?.job_id, button.dataset.chatSessionId);
  });
  $('#chat-history-list')?.addEventListener('contextmenu', (event) => {
    const button = event.target.closest('[data-chat-session-id]');
    if (!button) return;
    event.preventDefault();
    button.focus({ preventScroll: true });
    openChatSessionMenu(button, { clientX: event.clientX, clientY: event.clientY, focusFirst: true });
  });
  $('#chat-history-list')?.addEventListener('keydown', (event) => {
    const button = event.target.closest('[data-chat-session-id]');
    if (!button || !(event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) return;
    event.preventDefault();
    openChatSessionMenu(button, { focusFirst: true });
  });
  $('#chat-session-menu')?.addEventListener('keydown', (event) => {
    const menu = event.currentTarget;
    const items = [...menu.querySelectorAll('button:not([disabled])')];
    const index = items.indexOf(event.target);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeChatSessionMenu({ restoreFocus: true });
    } else if (event.key === 'Tab') closeChatSessionMenu();
  });
  $('#chat-session-menu')?.addEventListener('click', (event) => {
    const action = event.target.closest('[data-chat-session-action]')?.dataset.chatSessionAction;
    const jobId = state.activeJob?.job_id;
    const sessionId = chatSessionMenuId;
    if (!action || !jobId || !sessionId) return;
    const thread = chatEnvelope(jobId).sessions.find((session) => session.id === sessionId);
    if (!thread) { closeChatSessionMenu(); return; }
    closeChatSessionMenu();
    if (action === 'pin') toggleChatThreadPinned(jobId, sessionId);
    else if (action === 'rename') openChatRenameDialog(jobId, sessionId);
    else if (action === 'delete') {
      if (thread.messages.some((message) => message.streaming)) {
        showToast('回答生成期间不能删除此会话。', true);
        return;
      }
      if (window.confirm(`删除会话“${thread.title || '新会话'}”？此操作无法撤销。`)) deleteChatThread(jobId, sessionId);
      else focusChatHistorySession(sessionId);
    }
  });
  $('#chat-session-rename-dialog form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const jobId = state.activeJob?.job_id;
    const input = $('#chat-session-title-input');
    const title = input?.value.replace(/\s+/g, ' ').trim() || '';
    if (!title) {
      input?.setCustomValidity('会话名称不能为空。');
      input?.reportValidity();
      return;
    }
    const renamedSessionId = chatRenameSessionId;
    const thread = jobId ? chatEnvelope(jobId).sessions.find((session) => session.id === renamedSessionId) : null;
    if (thread) {
      thread.title = title.slice(0, 80);
      thread.titleMode = 'manual';
      persistChatSession(jobId);
      renderChatSessionControls(jobId);
    }
    $('#chat-session-rename-dialog')?.close();
    focusChatHistorySession(renamedSessionId);
  });
  $('[data-chat-session-rename-cancel]')?.addEventListener('click', () => $('#chat-session-rename-dialog')?.close());
  $('#chat-session-rename-dialog')?.addEventListener('close', () => { chatRenameSessionId = ''; });
  $('#new-chat-session')?.addEventListener('click', () => createChatThread());
  document.addEventListener('click', (event) => {
    if (!event.target.closest?.('#chat-session-menu')) closeChatSessionMenu();
  });
  document.addEventListener('scroll', (event) => {
    const groupingMenu = $('#grouping-field-menu');
    if (state.groupingMenuOpen && event.target !== groupingMenu) setGroupingMenuOpen(false);
    const chatMenu = $('#chat-session-menu');
    if (chatMenu?.hidden === false && event.target !== chatMenu) closeChatSessionMenu();
  }, true);
  window.addEventListener('resize', () => {
    closeChatSessionMenu();
    if (state.groupingMenuOpen) setGroupingMenuOpen(false);
  }, { passive: true });

  const chatMathCache = new Map();
  const chatMathPending = new Set();
  let chatMathTimer = null;
  let chatMathRevision = 0;

  function chatMathNode(tex, display, doc) {
    const key = `${display ? 'D' : 'I'}:${tex}`;
    const markup = chatMathCache.get(key);
    if (markup !== undefined) { chatMathCache.delete(key); chatMathCache.set(key, markup); }
    if (markup === undefined) {
      chatMathPending.add(key);
      while (chatMathPending.size > 256) chatMathPending.delete(chatMathPending.values().next().value);
    }
    return translationMathNode({ tex, ...(markup ? { markup } : {}) }, doc) || doc.createTextNode(tex);
  }

  function scheduleChatMathHydration() {
    if (!chatMathPending.size || chatMathTimer) return;
    // While a reply is still streaming the TeX keeps changing; hydrate once
    // after the final render instead of converting partial formulas.
    if (state.chat.some((message) => message.streaming)) return;
    chatMathTimer = window.setTimeout(async () => {
      chatMathTimer = null;
      const batch = [...chatMathPending].slice(0, 64);
      batch.forEach((key) => chatMathPending.delete(key));
      const formulas = batch.map((key) => ({ display: key.startsWith('D:'), tex: key.slice(2) }));
      let results = [];
      try {
        results = (await api('/api/mathml', jsonOptions({ formulas }))).results || [];
      } catch (_) { /* cache misses below as failed so they do not retry-loop */ }
      let upgraded = false;
      batch.forEach((key, index) => {
        const markup = typeof results[index] === 'string' ? results[index] : '';
        chatMathCache.set(key, markup);
        while (chatMathCache.size > 256) chatMathCache.delete(chatMathCache.keys().next().value);
        if (markup) upgraded = true;
      });
      if (upgraded) {
        chatMathRevision += 1;
        renderChat();
      }
    }, 200);
  }

  function chatCodeMath(text) {
    const value = text.trim();
    const wrapped = value.match(/^\$\$(.+)\$\$$|^\$(.+)\$$|^\\\((.+)\\\)$|^\\\[(.+)\\\]$/);
    if (wrapped) return { tex: (wrapped[1] || wrapped[2] || wrapped[3] || wrapped[4]).trim(), display: !!(wrapped[1] || wrapped[4]) };
    // Accept mathematical subscripts without reinterpreting ordinary snake_case identifiers.
    if (/^\\[a-zA-Z]/.test(value) || /^[A-Za-z\u0391-\u03c9](?:[_^](?:[A-Za-z0-9]|\{[^{}\n]+\})){1,2}$/.test(value)) {
      return { tex: value, display: false };
    }
    return null;
  }

  function chatMarkdownInline(text, doc = document, depth = 0) {
    // Everything is built with createElement/textContent — model output never
    // reaches innerHTML, so malformed or hostile markup stays inert text.
    const pattern = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\*([^\s*][^*\n]*?)\*|~~([^~\n]+)~~|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|\$\$([^$\n]+?)\$\$|\$([^\s$][^$\n]*?)\$|\\\((.+?)\\\)|\\\[(.+?)\\\]|\[p([1-9][0-9]{0,4})\/((?:block-[A-Za-z0-9][A-Za-z0-9._-]{0,143}|b-[a-f0-9]{24}))\]/g;
    const fragment = doc.createDocumentFragment();
    const value = String(text || '').slice(0, chatMaxMessageChars);
    if (depth >= chatMarkdownMaxDepth) {
      fragment.append(doc.createTextNode(value));
      return fragment;
    }
    let cursor = 0;
    let match;
    while ((match = pattern.exec(value))) {
      if (match.index > cursor) fragment.append(doc.createTextNode(value.slice(cursor, match.index)));
      const [, codeText, boldText, emText, strikeText, linkText, linkHref, displayTex, dollarTex, parenTex, bracketTex, blockPage, blockId] = match;
      if (codeText !== undefined) {
        const formula = chatCodeMath(codeText);
        if (formula) {
          fragment.append(chatMathNode(formula.tex, formula.display, doc));
        } else {
          const code = doc.createElement('code');
          code.textContent = codeText;
          fragment.append(code);
        }
      } else if (boldText !== undefined) {
        const strong = doc.createElement('strong');
        strong.append(chatMarkdownInline(boldText, doc, depth + 1));
        fragment.append(strong);
      } else if (emText !== undefined) {
        const em = doc.createElement('em');
        em.append(chatMarkdownInline(emText, doc, depth + 1));
        fragment.append(em);
      } else if (strikeText !== undefined) {
        const del = doc.createElement('del');
        del.textContent = strikeText;
        fragment.append(del);
      } else if (linkText !== undefined) {
        const anchor = doc.createElement('a');
        anchor.href = linkHref;
        anchor.textContent = linkText;
        anchor.target = '_blank';
        anchor.rel = 'noreferrer noopener';
        fragment.append(anchor);
      } else if (blockPage !== undefined && blockId !== undefined) {
        const reference = doc.createElement('button');
        reference.type = 'button';
        reference.className = 'chat-block-reference';
        reference.dataset.chatBlockPage = blockPage;
        reference.dataset.chatBlockId = blockId;
        reference.textContent = `[p${blockPage}/${blockId}]`;
        reference.setAttribute('aria-label', `跳转到原文第 ${blockPage} 页`);
        fragment.append(reference);
      } else {
        fragment.append(chatMathNode((displayTex || dollarTex || parenTex || bracketTex || '').trim(), displayTex !== undefined || bracketTex !== undefined, doc));
      }
      cursor = pattern.lastIndex;
    }
    if (cursor < value.length) fragment.append(doc.createTextNode(value.slice(cursor)));
    return fragment;
  }

  function renderChatMarkdown(text, doc = document, container = null, depth = 0) {
    const root = container || doc.createElement('div');
    if (!container) root.className = 'chat-markdown';
    const normalizedText = String(text || '').slice(0, chatMaxMessageChars).replace(/\r\n?/g, '\n');
    if (depth >= chatMarkdownMaxDepth) {
      root.textContent = normalizedText;
      return root;
    }
    const lines = normalizedText.split('\n');
    let index = 0;
    const paragraph = [];
    const flushParagraph = () => {
      if (!paragraph.length) return;
      const node = doc.createElement('p');
      paragraph.forEach((line, i) => {
        if (i) node.append(doc.createElement('br'));
        node.append(chatMarkdownInline(line, doc, depth));
      });
      root.append(node);
      paragraph.length = 0;
    };
    while (index < lines.length) {
      const line = lines[index];
      const fence = line.match(/^\s*```(\w*)\s*$/);
      if (fence) {
        flushParagraph();
        const code = [];
        index += 1;
        while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) { code.push(lines[index]); index += 1; }
        index += 1;
        const pre = doc.createElement('pre');
        const codeNode = doc.createElement('code');
        if (fence[1]) codeNode.dataset.lang = fence[1];
        codeNode.textContent = code.join('\n');
        pre.append(codeNode);
        root.append(pre);
        continue;
      }
      if (!line.trim()) { flushParagraph(); index += 1; continue; }
      const mathOpen = line.match(/^\s*(\\\[|\$\$)\s*(.*)$/);
      if (mathOpen) {
        flushParagraph();
        const closeRe = mathOpen[1] === '$$' ? /\$\$\s*$/ : /\\\]\s*$/;
        let tex;
        if (mathOpen[2] && closeRe.test(mathOpen[2])) {
          tex = mathOpen[2].replace(closeRe, '').trim();
          index += 1;
        } else {
          const parts = mathOpen[2] ? [mathOpen[2]] : [];
          index += 1;
          while (index < lines.length && !closeRe.test(lines[index])) { parts.push(lines[index]); index += 1; }
          if (index < lines.length) { parts.push(lines[index].replace(closeRe, '')); index += 1; }
          tex = parts.join('\n').trim();
        }
        const block = doc.createElement('div');
        block.className = 'chat-math-block';
        block.append(chatMathNode(tex, true, doc));
        root.append(block);
        continue;
      }
      const heading = line.match(/^\s*(#{1,6})\s+(.*)$/);
      if (heading) {
        flushParagraph();
        const node = doc.createElement(`h${heading[1].length}`);
        node.append(chatMarkdownInline(heading[2], doc, depth));
        root.append(node);
        index += 1;
        continue;
      }
      if (/^\s*(?:-{3,}|\*{3,})\s*$/.test(line)) { flushParagraph(); root.append(doc.createElement('hr')); index += 1; continue; }
      if (/^\s*>/.test(line)) {
        flushParagraph();
        const quoted = [];
        while (index < lines.length && /^\s*>/.test(lines[index])) { quoted.push(lines[index].replace(/^\s*>\s?/, '')); index += 1; }
        root.append(renderChatMarkdown(quoted.join('\n'), doc, doc.createElement('blockquote'), depth + 1));
        continue;
      }
      const tableSeparator = index + 1 < lines.length ? lines[index + 1] : '';
      if (line.includes('|') && /^[\s|:-]+$/.test(tableSeparator) && tableSeparator.includes('-') && tableSeparator.includes('|')) {
        flushParagraph();
        const splitRow = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
        const table = doc.createElement('table');
        const thead = doc.createElement('thead');
        const headRow = doc.createElement('tr');
        splitRow(line).forEach((cell) => { const th = doc.createElement('th'); th.append(chatMarkdownInline(cell, doc, depth)); headRow.append(th); });
        thead.append(headRow);
        table.append(thead);
        const tbody = doc.createElement('tbody');
        index += 2;
        while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
          const row = doc.createElement('tr');
          splitRow(lines[index]).forEach((cell) => { const td = doc.createElement('td'); td.append(chatMarkdownInline(cell, doc, depth)); row.append(td); });
          tbody.append(row);
          index += 1;
        }
        table.append(tbody);
        root.append(table);
        continue;
      }
      const listItem = /^(\s*)([-*+]|\d+[.)])\s+/.test(line);
      if (listItem) {
        flushParagraph();
        const stack = [];
        while (index < lines.length) {
          const item = lines[index].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
          if (!item) break;
          const indent = item[1].length;
          const ordered = /\d/.test(item[2]);
          while (stack.length && indent < stack[stack.length - 1].indent) stack.pop();
          let top = stack[stack.length - 1];
          if (!top || indent > top.indent || (top.list.tagName === 'OL') !== ordered) {
            if (top && indent <= top.indent) { stack.pop(); top = stack[stack.length - 1]; }
            const list = doc.createElement(ordered ? 'ol' : 'ul');
            if (top) (top.list.lastElementChild || top.list).append(list); else root.append(list);
            top = { list, indent };
            stack.push(top);
          }
          const li = doc.createElement('li');
          li.append(chatMarkdownInline(item[3], doc, depth));
          top.list.append(li);
          index += 1;
        }
        continue;
      }
      paragraph.push(line.trim());
      index += 1;
    }
    flushParagraph();
    return root;
  }

  let chatReferenceHighlight = null;
  let chatReferenceHighlightTimer = null;

  function clearChatReferenceHighlight() {
    window.clearTimeout(chatReferenceHighlightTimer);
    chatReferenceHighlightTimer = null;
    if (chatReferenceHighlight?.owned && chatReferenceHighlight.target?.isConnected) {
      chatReferenceHighlight.target.classList.remove('block-selected');
    }
    chatReferenceHighlight = null;
  }

  function canonicalChatReferencePage(value) {
    const page = String(value || '');
    return /^[1-9][0-9]{0,4}$/.test(page) ? page : '';
  }

  function chatReferenceTarget(page, blockId) {
    const doc = frameDocument();
    const canonicalPage = canonicalChatReferencePage(page);
    const requestedId = String(blockId || '');
    if (!doc || !state.activeJob || !canonicalPage || !/^(?:block-[A-Za-z0-9][A-Za-z0-9._-]{0,143}|b-[a-f0-9]{24})$/.test(requestedId)) return null;
    const candidates = [...doc.querySelectorAll('[data-block-id],[data-translate-block-id]')].filter((candidate) => {
      const candidatePage = canonicalChatReferencePage(candidate.dataset.page || candidate.closest('[data-page]')?.dataset.page || '');
      return candidatePage === canonicalPage;
    });
    const idsFor = (candidate) => [candidate.dataset.blockId, candidate.dataset.translateBlockId].filter(Boolean);
    const exact = candidates.find((candidate) => idsFor(candidate).includes(requestedId));
    if (exact) return exact;
    const continuation = readerContinuations.get(doc)?.get(requestedId);
    if (continuation?.page === canonicalPage) return continuation.root;

    const pageAndIndex = requestedId.match(/^block-([1-9][0-9]{0,4})-(0|[1-9][0-9]{0,8})$/);
    const indexOnly = requestedId.match(/^block-(0|[1-9][0-9]{0,8})$/);
    const numericIndex = pageAndIndex && pageAndIndex[1] === canonicalPage ? pageAndIndex[2] : indexOnly?.[1] || '';
    if (!numericIndex) return null;
    const canonicalPrefix = `block-${canonicalPage}-${numericIndex}-`;
    const matches = candidates.filter((candidate) => idsFor(candidate).some((candidateId) => (
      candidateId.startsWith(canonicalPrefix)
      && /^block-[1-9][0-9]{0,4}-(?:0|[1-9][0-9]{0,8})-[A-Za-z][A-Za-z0-9._-]{0,80}$/.test(candidateId)
    )));
    return matches.length === 1 ? matches[0] : null;
  }

  function openChatBlockReference(button) {
    const page = String(button.dataset.chatBlockPage || '');
    const blockId = String(button.dataset.chatBlockId || '');
    const target = readerVisibleTarget(chatReferenceTarget(page, blockId));
    const sourceGeneration = normalizeChatSourceGeneration(button.closest('.chat-bubble')?.dataset.chatSourceGeneration);
    if (!target?.isConnected) {
      if (sourceGeneration && sourceGeneration !== activeChatSourceGeneration()) {
        showToast('这条引用来自另一版 AI 重排结果，且未能在当前正文中安全定位。', true);
      } else if (!sourceGeneration) {
        showToast('这条历史回答缺少正文版本信息，且未能在当前正文中安全定位。', true);
      } else {
        showToast('未找到这条引用对应的原文位置。', true);
      }
      return;
    }
    clearChatReferenceHighlight();
    const owned = !target.classList.contains('block-selected');
    if (owned) target.classList.add('block-selected');
    chatReferenceHighlight = { target, owned };
    target.scrollIntoView({ behavior: reducedMotionQuery.matches ? 'auto' : 'smooth', block: 'center' });
    chatReferenceHighlightTimer = window.setTimeout(clearChatReferenceHighlight, 2000);
  }

  function chatSelectionTouches(node = $('#chat-messages')) {
    const selection = document.getSelection();
    if (!node || !selection || selection.isCollapsed || !selection.rangeCount) return false;
    for (let index = 0; index < selection.rangeCount; index += 1) {
      try {
        if (selection.getRangeAt(index).intersectsNode(node)) return true;
      } catch (_) { /* A detached selection is not part of the mounted chat. */ }
    }
    return false;
  }

  function chatSelectedTextForBubble(bubble) {
    const selection = document.getSelection();
    const content = bubble?.querySelector('.chat-message-body');
    if (!selection || selection.isCollapsed || !selection.rangeCount || !content) return '';
    const parts = [];
    for (let index = 0; index < selection.rangeCount; index += 1) {
      const range = selection.getRangeAt(index);
      try {
        if (!range.intersectsNode(content)) continue;
        const bounds = document.createRange();
        bounds.selectNodeContents(content);
        const clipped = bounds.cloneRange();
        if (bounds.comparePoint(range.startContainer, range.startOffset) === 0) clipped.setStart(range.startContainer, range.startOffset);
        if (bounds.comparePoint(range.endContainer, range.endOffset) === 0) clipped.setEnd(range.endContainer, range.endOffset);
        const text = clipped.toString();
        if (text) parts.push(text);
      } catch (_) { /* Ignore a range invalidated between pointerdown and click. */ }
    }
    return parts.join('\n');
  }

  async function copyChatMessage(message, button, selectedText = '') {
    const text = selectedText || message.content;
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.append(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    button.textContent = '已复制';
    window.setTimeout(() => { button.textContent = '复制'; }, 1500);
  }

  let chatPointerLockedBubble = null;
  let chatRenderPending = false;

  function updateChatBubble(bubble, message, { force = false } = {}) {
    const isUser = message.role === 'user';
    const sourceGeneration = isUser ? '' : normalizeChatSourceGeneration(message.sourceGeneration);
    const revision = `${message.streaming ? '1' : '0'}:${isUser ? '' : chatMathRevision}:${sourceGeneration}:${message.quote || ''}:${message.content}`;
    if (!force && bubble.dataset.chatRevision === revision) return;
    if (!force && (bubble === chatPointerLockedBubble || chatSelectionTouches(bubble))) {
      chatRenderPending = true;
      return;
    }
    bubble.className = `chat-bubble ${isUser ? 'user' : 'assistant'}${message.streaming ? ' is-streaming' : ''}`;
    if (sourceGeneration) bubble.dataset.chatSourceGeneration = sourceGeneration;
    else delete bubble.dataset.chatSourceGeneration;
    bubble.dataset.chatRevision = revision;
    const label = document.createElement('small');
    label.textContent = isUser ? '你' : browserDemo ? '文章助手 · AI 示例' : '文章助手';
    const body = document.createElement('div');
    body.className = 'chat-message-body';
    if (isUser) {
      if (message.quote) {
        const quoteNode = document.createElement('div');
        quoteNode.className = 'chat-quote';
        quoteNode.textContent = message.quote;
        quoteNode.title = message.quote;
        body.append(quoteNode);
      }
      body.append(document.createTextNode(message.content));
    } else if (message.streaming && !message.content) {
      const thinking = document.createElement('div');
      thinking.className = 'chat-thinking';
      thinking.innerHTML = '<span class="chat-thinking-dot"></span><span class="chat-thinking-dot"></span><span class="chat-thinking-dot"></span><span class="chat-thinking-label">正在阅读全文并思考…</span>';
      body.append(thinking);
    } else {
      body.append(renderChatMarkdown(message.content));
    }
    bubble.replaceChildren(label, body);
    if (!isUser && !message.streaming && message.content) {
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'chat-copy';
      copy.title = '复制所选内容；没有选区时复制完整回答';
      copy.textContent = '复制';
      let capturedSelection = '';
      copy.addEventListener('pointerdown', () => { capturedSelection = chatSelectedTextForBubble(bubble); });
      copy.addEventListener('click', () => {
        const selectedText = capturedSelection || chatSelectedTextForBubble(bubble);
        capturedSelection = '';
        copyChatMessage(message, copy, selectedText);
      });
      bubble.append(copy);
    }
  }

  function renderChat({ force = false } = {}) {
    const container = $('#chat-messages');
    const messages = state.chat;
    renderChatSessionControls();
    renderChatOptions();
    if (!messages.length) {
      chatMathPending.clear();
      if (!container.querySelector(':scope > .chat-empty')) container.innerHTML = '<div class="chat-empty">可以问我：这篇文章的贡献是什么？表格中的指标如何比较？</div>';
      return;
    }
    const hadSelection = chatSelectionTouches(container);
    const stickToBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 36;
    container.querySelector(':scope > .chat-empty')?.remove();
    const expectedIds = new Set(messages.map((message) => message.id));
    container.querySelectorAll(':scope > .chat-bubble[data-chat-message-id]').forEach((bubble) => {
      if (!expectedIds.has(bubble.dataset.chatMessageId)) bubble.remove();
    });
    messages.forEach((message, index) => {
      if (!message.id) message.id = chatRecordId('message');
      let bubble = container.querySelector(`:scope > .chat-bubble[data-chat-message-id="${cssEscape(message.id)}"]`);
      if (!bubble) {
        bubble = document.createElement('div');
        bubble.dataset.chatMessageId = message.id;
      }
      updateChatBubble(bubble, message, { force });
      const expectedNode = container.children[index];
      if (expectedNode !== bubble) container.insertBefore(bubble, expectedNode || null);
    });
    if (!hadSelection && stickToBottom) container.scrollTop = container.scrollHeight;
    scheduleChatMathHydration();
  }

  function releaseChatPointerLock() {
    const locked = chatPointerLockedBubble;
    chatPointerLockedBubble = null;
    if (!locked || chatSelectionTouches(locked) || !chatRenderPending) return;
    window.requestAnimationFrame(() => {
      if (chatPointerLockedBubble || chatSelectionTouches()) return;
      chatRenderPending = false;
      renderChat();
    });
  }
  $('#chat-messages')?.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const body = event.target.closest?.('.chat-message-body');
    if (body) chatPointerLockedBubble = body.closest('.chat-bubble');
  });
  $('#chat-messages')?.addEventListener('click', (event) => {
    const reference = event.target.closest?.('.chat-block-reference');
    if (reference) openChatBlockReference(reference);
  });
  document.addEventListener('pointerup', releaseChatPointerLock);
  document.addEventListener('pointercancel', releaseChatPointerLock);
  window.addEventListener('blur', releaseChatPointerLock);
  document.addEventListener('selectionchange', () => {
    if (chatPointerLockedBubble || chatSelectionTouches()) return;
    window.requestAnimationFrame(() => {
      chatRenderPending = false;
      renderChat();
    });
  });
  $('#chat-input')?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
    const input = event.currentTarget;
    if (primaryModifierPressed(event)) {
      event.preventDefault();
      event.stopPropagation();
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? start;
      input.setRangeText('\n', start, end, 'end');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    if (event.shiftKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    $('#chat-form').requestSubmit();
  });
  $('#chat-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!state.activeJob) return;
    if (!aiServiceEnabled('chat')) {
      setPanelStatus('文章助手当前不可用。', true);
      return;
    }
    const input = $('#chat-input');
    const content = input.value.trim();
    if (!content) return;
    if (state.chat.some((message) => message.streaming)) {
      setPanelStatus('请等待当前回答完成后再继续提问。', true);
      return;
    }
    const selectedImage = state.chatSelection?.kind === 'image' ? {
      path: state.chatSelection.image.path,
      caption: state.chatSelection.image.caption || '',
      block_id: state.chatSelection.image.block_id || '',
      page: state.chatSelection.image.page || '',
    } : null;
    const attachedText = state.chatSelection?.kind === 'text' ? state.chatSelection.selection?.quote : '';
    const selectedText = selectedImage ? '' : (attachedText || state.selection?.quote || '').replace(/\s+/g, ' ').trim();
    // Capture the thread and its document. A slow gateway response must land
    // in the thread the question was asked in, never the newly opened tab's.
    const jobId = state.activeJob.job_id;
    const envelope = chatEnvelope(jobId);
    const thread = activeChatThread(jobId);
    const sessionId = thread.id;
    for (const id of ['chat-thinking-budget', 'chat-context-window']) {
      const optionInput = $(`#${id}`);
      if (!optionInput.hidden && (!optionInput.value || !optionInput.checkValidity())) { optionInput.reportValidity(); optionInput.focus(); return; }
    }
    if ($('#chat-reasoning-effort').value === 'custom' && !$('#chat-reasoning-custom').value.trim()) {
      setPanelStatus('请输入服务商支持的推理档位，或改为自动。', true);
      $('#chat-reasoning-custom').focus();
      return;
    }
    const optionWarning = aiOptionWarning(chatEffectiveOptions(thread), aiCapabilities('chat'));
    if (optionWarning) {
      setPanelStatus(optionWarning, true);
      $('#chat-session-options').open = true;
      return;
    }
    const requestOptions = normalizeChatOptions(thread.options);
    const chat = thread.messages;
    state.chat = chat;
    chat.push(normalizedChatMessage({ role: 'user', content, ...(selectedText ? { quote: selectedText } : {}) }));
    trimChatThread(thread);
    touchChatThread(thread);
    input.value = '';
    if (selectedText || selectedImage) {
      state.chatSelection = null;
      frameDocument()?.getSelection()?.removeAllRanges();
      clearSelectionPopover({ clearState: true });
      renderSelectedContext();
    }
    // Snapshot before pushing the placeholder so the pending assistant
    // bubble is never sent back to the gateway as part of the history.
    const outgoing = chat.slice();
    const reply = normalizedChatMessage({ role: 'assistant', content: '', streaming: true, sourceGeneration: activeChatSourceGeneration(state.activeJob) });
    chat.push(reply);
    trimChatThread(thread);
    touchChatThread(thread);
    persistChatSession(jobId);
    renderChat();
    try {
      const result = await streamApiRequest(`/api/jobs/${jobId}/chat`, {
        messages: outgoing,
        options: requestOptions,
        selected_text: selectedText,
        ...(selectedImage ? { selected_image: selectedImage } : {}),
      }, (delta) => {
        if (reply.content.length + delta.length > chatMaxMessageChars) {
          throw new Error('模型回答超过安全上限。');
        }
        reply.content += delta;
        touchChatThread(thread);
        scheduleChatSessionPersist(jobId);
        if (state.activeJob?.job_id === jobId && envelope.activeSessionId === sessionId) renderChat();
      }, null, (context) => {
        thread.context = normalizeChatContext(context);
        scheduleChatSessionPersist(jobId);
        if (state.activeJob?.job_id === jobId && envelope.activeSessionId === sessionId) renderChatContext(thread);
      });
      if (result.context) thread.context = normalizeChatContext(result.context);
      const completedText = String(result.text || '模型没有返回内容。');
      if (completedText.length > chatMaxMessageChars) throw new Error('模型回答超过安全上限。');
      reply.content = completedText;
      if (state.activeJob?.job_id === jobId && envelope.activeSessionId === sessionId) setPanelStatus('');
    } catch (error) {
      const interrupted = `\n\n（请求中断：${error.message}）`;
      reply.content = reply.content
        ? `${reply.content.slice(0, Math.max(0, chatMaxMessageChars - interrupted.length))}${interrupted}`
        : `请求失败：${error.message}`.slice(0, chatMaxMessageChars);
      if (state.activeJob?.job_id === jobId && envelope.activeSessionId === sessionId) setPanelStatus(error.message, true);
    }
    delete reply.streaming;
    trimChatThread(thread);
    touchChatThread(thread);
    persistChatSession(jobId);
    if (state.activeJob?.job_id === jobId && envelope.activeSessionId === sessionId) renderChat();
    releaseClosedDocumentCaches(jobId);
  });

  function isActiveReaderJob(jobId) {
    return Boolean(jobId && state.activeJob?.job_id === jobId && $('#reader-view')?.classList.contains('active-view'));
  }

  async function autoHighlights() {
    const mount = readerMount;
    if (!readerMountMatches(mount)) return;
    if (!state.activeJob) return;
    if (!aiServiceEnabled('chat')) {
      setPanelStatus('阅读重点服务当前不可用。', true);
      return;
    }
    const jobId = state.activeJob.job_id;
    const button = $('#auto-highlight-button');
    const requestToken = {};
    button.highlightRequestToken = requestToken;
    button.dataset.runningJobId = jobId;
    button.disabled = true; button.textContent = '生成中…';
    try {
      const payload = await api(`/api/jobs/${jobId}/auto-highlights`, jsonOptions({}));
      if (!readerMountMatches(mount) || !isActiveReaderJob(jobId)) return;
      await applyHighlightSuggestions(payload.result || {}, jobId);
      if (!readerMountMatches(mount) || !isActiveReaderJob(jobId)) return;
      switchSidebar('highlights-panel');
      setPanelStatus(payload.result?.status === 'local-fallback' ? '模型暂不可用，已显示本地规则候选。' : 'AI 阅读重点已更新。');
    } catch (error) {
      if (readerMountMatches(mount) && isActiveReaderJob(jobId)) setPanelStatus(error.message, true);
    }
    finally {
      if (readerMountMatches(mount) && button.highlightRequestToken === requestToken) {
        delete button.highlightRequestToken;
        delete button.dataset.runningJobId;
        button.disabled = false;
        button.textContent = '✦ 重点高亮';
      }
    }
  }
  $('#auto-highlight-button').addEventListener('click', autoHighlights);

  async function applyHighlightSuggestions(result, jobId = state.activeJob?.job_id) {
    const mount = readerMount;
    if (!readerMountMatches(mount) || !isActiveReaderJob(jobId)) return 0;
    const suggestions = Array.isArray(result.highlights) ? result.highlights : [];
    state.aiHighlights = suggestions.map((suggestion) => ({
      block_id: String(suggestion.block_id || ''),
      quote: String(suggestion.quote || ''),
      reason: String(suggestion.reason || ''),
      category: normalizeHighlightCategory(suggestion.category),
    })).filter((suggestion) => suggestion.block_id && suggestion.quote);
    for (const annotation of state.annotations.filter(isIgnoredAISuggestion)) {
      if (state.aiHighlights.some((suggestion) => sameAnnotationTarget(annotation, suggestion))) continue;
      state.aiHighlights.push({
        block_id: String(annotation.block_id || ''),
        quote: String(annotation.quote || ''),
        reason: String(annotation.note || ''),
        category: normalizeHighlightCategory(annotation.category),
      });
    }
    let added = 0;
    for (const suggestion of state.aiHighlights) {
      if (!readerMountMatches(mount) || !isActiveReaderJob(jobId)) break;
      const category = normalizeHighlightCategory(suggestion.category);
      const existing = state.annotations.find((item) => item.block_id === suggestion.block_id && item.quote === suggestion.quote && item.kind === 'highlight' && isAIAnnotation(item));
      if (existing) {
        if (existing.category !== category) existing.category = category;
        if (existing.note !== suggestion.reason) existing.note = suggestion.reason;
        continue;
      }
      const saved = await api(`/api/jobs/${jobId}/annotations`, jsonOptions({ kind: 'highlight', quote: suggestion.quote, block_id: suggestion.block_id, note: suggestion.reason || '', category, color: 'orange', source: 'ai' }));
      if (!annotationOperations.applyResult(jobId, mount, saved, { allowStateUpdate: isActiveReaderJob(jobId) })) break;
      added += 1;
    }
    if (!readerMountMatches(mount) || !isActiveReaderJob(jobId)) return added;
    mount.aiHighlights = state.aiHighlights;
    renderAnnotations();
    renderFrameAnnotations();
    return added;
  }

  async function loadAutoHighlights(jobId) {
    const mount = readerMount;
    if (!readerMountMatches(mount)) return;
    if (!aiServiceEnabled('chat')) {
      const status = $('#highlight-ai-status');
      if (status) status.textContent = 'AI 重点暂不可用';
      return;
    }
    try {
      let payload = await api(`/api/jobs/${jobId}/auto-highlights`);
      if (!readerMountMatches(mount) || !isActiveReaderJob(jobId)) return;
      if (payload.result?.status === 'not-run') payload = await api(`/api/jobs/${jobId}/auto-highlights`, jsonOptions({}));
      if (!readerMountMatches(mount) || !isActiveReaderJob(jobId)) return;
      await applyHighlightSuggestions(payload.result || {}, jobId);
      if (!readerMountMatches(mount) || !isActiveReaderJob(jobId)) return;
      renderFrameAnnotations();
      const status = $('#highlight-ai-status');
      if (status) status.textContent = payload.result?.status === 'local-fallback' ? '本地规则建议 · 点击可采纳或忽略' : 'AI 建议，仅供参考 · 点击可采纳或忽略';
    } catch (error) {
      if (!readerMountMatches(mount) || !isActiveReaderJob(jobId)) return;
      const status = $('#highlight-ai-status');
      if (status) status.textContent = 'AI 重点暂不可用';
    }
  }

  async function loadReaderData(jobId, { notesReady = Promise.resolve(), notesSession = null, mount = readerMount } = {}) {
    const current = () => readerMountMatches(mount);
    if (!mount.layoutStarted) {
      mount.layoutStarted = true;
      const mediaReady = loadMediaLayout(jobId, mount).catch((error) => {
        if (!readerMountIsCurrent(mount)) return;
        state.mediaLayouts.set(jobId, emptyMediaLayout());
        if (!current()) return;
        prepareReaderMedia(frameDocument(), jobId);
        showToast(`媒体宽度加载失败：${error?.message || '未知错误'}`, true);
      });
      const translationsReady = loadTranslationCache(jobId, mount).then(() => {
        if (!current() || mount.wiredDocument !== frameDocument()) return;
        renderCachedTranslations({ reconcile: false });
        renderAnnotations(); renderFrameAnnotations();
      });
      mount.layoutReady = Promise.allSettled([translationsReady, mediaReady]);
    }
    const annotationRequest = (mount.annotationRequest || 0) + 1;
    mount.annotationRequest = annotationRequest;
    const previousAnnotations = mount.annotations;
    const annotationsReady = api(`/api/jobs/${jobId}/annotations`).then((payload) => {
      if (!readerMountIsCurrent(mount) || mount.annotationRequest !== annotationRequest || mount.annotations !== previousAnnotations) return;
      const annotations = payload.annotations || [];
      if (JSON.stringify(mount.annotations) === JSON.stringify(annotations)) return;
      mount.annotations = annotations;
      if (!current()) return;
      state.annotations = mount.annotations;
      renderAnnotations();
      if (mount.wiredDocument === frameDocument()) renderFrameAnnotations();
    }).catch((error) => {
      if (!current() || mount.annotationRequest !== annotationRequest) return;
      const message = `高亮笔记加载失败：${error?.message || '未知错误'}`;
      setPanelStatus(message, true);
      showToast(message, true);
    });
    // The shared notes editor keeps its own session and draft protection.
    const notesPromise = Promise.resolve(notesReady).catch(() => {}).then(() => api(`/api/jobs/${jobId}/notes`)).then((payload) => {
      if (readerMountIsCurrent(mount)) loadArticleNotes(jobId, payload.markdown || '', notesSession, payload.revision);
    }).catch((error) => {
      if (readerMountIsCurrent(mount)) handleArticleNotesLoadError(jobId, error, notesSession);
    });
    await Promise.all([notesPromise, annotationsReady, mount.layoutReady, mount.documentReady]);
    if (!current()) return;
    state.chat = chatSession(jobId); renderChat();
    if (!mount.highlightsLoaded && !mount.highlightsPending) {
      mount.highlightsPending = true;
      scheduleReaderIdle(async () => {
        try {
          if (!current() || mount.highlightsLoaded) return;
          await loadAutoHighlights(jobId).catch(() => {});
          if (current()) { mount.highlightsLoaded = true; mount.aiHighlights = state.aiHighlights; }
        } finally { mount.highlightsPending = false; }
      });
    }
  }

  function openReader(job, { addTab = true } = {}) {
    if (!job?.links?.html) return;
    captureCurrentReadingLocation();
    if (readerMount) {
      readerMount.annotations = state.annotations;
      readerMount.aiHighlights = state.aiHighlights;
    }
    closeChatSessionMenu();
    closeQuickPreview();
    closeImageContextMenu();
    closeImageLightbox({ restoreFocus: false });
    const previousJobId = state.activeJob?.job_id;
    const notesReady = flushPendingArticleNotes(previousJobId);
    const nextCache = state.translationCaches.get(job.job_id) || [];
    state.translationCaches.set(job.job_id, nextCache);
    state.activeJob = job;
    activeJobId = job.job_id;
    const isNewDocument = addTab && !state.openDocuments.some((item) => item.job_id === job.job_id);
    if (isNewDocument) state.openDocuments.push(job);
    persistOpenDocuments();
    // The reader header is intentionally compact: the document name belongs
    // in the browser-like tab, while the left control remains just 阅读助手.
    const libraryEntry = libraryItemEntries().find((entry) => entry.jobId === job.job_id);
    if ($('#reader-title')) $('#reader-title').textContent = libraryEntry ? itemTitle(libraryEntry) : String(job.source_filename || '').replace(/\.pdf$/i, '');
    const counts = job.manifest?.counts || {};
    if ($('#reader-meta')) $('#reader-meta').textContent = `${counts.pages || '—'} 页 · ${counts.tables || 0} 表 · ${counts.images || counts.major_figures || 0} 图 · ${counts.formulas || counts.display_formulas || 0} 公式`;
    state.translationCache = nextCache;
    state.translationRun = state.translationRuns.get(job.job_id) || null;
    const highlightButton = $('#auto-highlight-button');
    if (highlightButton) {
      delete highlightButton.dataset.runningJobId;
      highlightButton.disabled = false;
      highlightButton.textContent = '✦ 重点高亮';
    }
    const completedReflowURL = job.reflow?.status === 'completed' ? safeReflowDocumentURL(job.reflow.document_url, job.job_id, job.reflow.generation) : '';
    const mount = beginReaderMount(job.job_id, completedReflowURL || job.links.html);
    state.annotations = mount.annotations;
    state.aiHighlights = mount.aiHighlights;
    state.chat = chatSession(job.job_id);
    setChatHistoryOpen(false, { focus: false });
    const notesSession = prepareArticleNotes(job.job_id);
    renderAnnotations();
    renderChat();
    state.selection = null;
    state.chatSelection = null;
    renderSelectedContext();
    switchView('reader-view', { enteringDocumentId: isNewDocument ? job.job_id : null });
    syncTranslationControls();
    syncReflowControls();
    syncTranslationScopeControls();
    markReadingStarted(job.job_id);
    loadReaderData(job.job_id, { notesReady, notesSession, mount }).catch((error) => {
      if (readerMountMatches(mount)) setPanelStatus(error.message, true);
    });
    if (mount.loaded) void prepareMountedReader(mount);
    if (mount.ready && !reducedMotionQuery.matches) {
      mount.transition = mount.frame.animate([{ opacity: 0.88 }, { opacity: 1 }], { duration: 100, easing: 'ease-out' });
    }
  }

  // Local Markdown notes use one editable, rendered surface.
  function noteAssetURL(ref, jobId = state.activeJob?.job_id) {
    if (!jobId || !noteAssetRefPattern.test(String(ref || ''))) return '';
    return `/api/jobs/${jobId}/content/notes/${ref}`;
  }

  async function uploadNoteAsset(file, jobId = state.activeJob?.job_id) {
    if (browserDemo) throw new Error('浏览器本地测试版不支持上传图片，可继续编辑文字笔记。');
    if (!jobId) throw new Error('请先打开一篇文献。');
    if (!file?.type?.startsWith('image/')) throw new Error('请选择 PNG、JPEG、WebP 或 GIF 图片。');
    const form = new FormData();
    form.append('file', file, file.name || 'note-image');
    const payload = await api(`/api/jobs/${jobId}/note-assets`, { method: 'POST', body: form });
    if (!payload.asset?.ref || !payload.asset?.url) throw new Error('图片上传结果无效。');
    return payload.asset;
  }

  function noteEditorElement() { return $('#notes-editor'); }

  // The formatting commands rewrite the DOM directly, which the browser's own
  // undo stack does not record — it would silently skip past them and revert
  // earlier typing instead. So this editor owns its whole history.
  const NOTE_HISTORY_LIMIT = 160;
  const NOTE_HISTORY_COALESCE_MS = 400;
  const noteHistory = { entries: [], index: -1, timer: null, applying: false };

  function noteCaretOffsets() {
    const editor = noteEditorElement();
    const selection = window.getSelection();
    if (!editor || !selection?.rangeCount) return null;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) return null;
    const prefix = range.cloneRange();
    prefix.selectNodeContents(editor);
    prefix.setEnd(range.startContainer, range.startOffset);
    const start = prefix.toString().length;
    return { start, end: start + range.toString().length };
  }

  function restoreNoteCaret(offsets) {
    const editor = noteEditorElement();
    if (!editor || !offsets) return;
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, null);
    let seen = 0;
    let start = null;
    let end = null;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const length = node.nodeValue.length;
      if (!start && seen + length >= offsets.start) start = { node, offset: offsets.start - seen };
      if (!end && seen + length >= offsets.end) end = { node, offset: offsets.end - seen };
      seen += length;
      if (start && end) break;
    }
    if (!start) return;
    const range = document.createRange();
    try {
      range.setStart(start.node, Math.min(start.offset, start.node.nodeValue.length));
      const tail = end || start;
      range.setEnd(tail.node, Math.min(tail.offset, tail.node.nodeValue.length));
    } catch (_error) {
      return;
    }
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function resetNoteHistory() {
    const editor = noteEditorElement();
    window.clearTimeout(noteHistory.timer);
    noteHistory.timer = null;
    noteHistory.applying = false;
    noteHistory.entries = editor ? [{ html: editor.innerHTML, caret: null }] : [];
    noteHistory.index = editor ? 0 : -1;
  }

  function commitNoteHistory({ immediate = false } = {}) {
    const editor = noteEditorElement();
    if (!editor || noteHistory.applying) return;
    const record = () => {
      noteHistory.timer = null;
      const html = editor.innerHTML;
      if (noteHistory.entries[noteHistory.index]?.html === html) return;
      noteHistory.entries = noteHistory.entries.slice(0, noteHistory.index + 1);
      noteHistory.entries.push({ html, caret: noteCaretOffsets() });
      if (noteHistory.entries.length > NOTE_HISTORY_LIMIT) noteHistory.entries.shift();
      noteHistory.index = noteHistory.entries.length - 1;
    };
    window.clearTimeout(noteHistory.timer);
    if (immediate) record();
    else noteHistory.timer = window.setTimeout(record, NOTE_HISTORY_COALESCE_MS);
  }

  function stepNoteHistory(delta) {
    const editor = noteEditorElement();
    const next = noteHistory.index + delta;
    if (!editor || next < 0 || next >= noteHistory.entries.length) return false;
    window.clearTimeout(noteHistory.timer);
    noteHistory.timer = null;
    noteHistory.applying = true;
    try {
      noteHistory.index = next;
      const entry = noteHistory.entries[next];
      editor.innerHTML = entry.html;
      hydrateFrameMath(document);
      editor.focus();
      restoreNoteCaret(entry.caret);
      updateArticleNotesEmptyState(editor);
    } finally {
      noteHistory.applying = false;
    }
    hideNoteFormatBar();
    closeNoteSlashMenu();
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  function noteSelectionRange() {
    const editor = noteEditorElement();
    const selection = window.getSelection();
    if (!editor || !selection?.rangeCount) return null;
    const range = selection.getRangeAt(0);
    if (range.collapsed || !editor.contains(range.commonAncestorContainer)) return null;
    return range;
  }

  // Every inline command works on the text runs a range touches. Wrapping runs
  // one at a time keeps a selection that spans two paragraphs from producing
  // block elements nested inside an inline tag.
  function noteRangeSlices(range) {
    const editor = noteEditorElement();
    if (!editor || !range) return [];
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, null);
    const slices = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.nodeValue || node.parentElement?.closest('.note-math')) continue;
      if (!range.intersectsNode(node)) continue;
      const start = node === range.startContainer ? range.startOffset : 0;
      const end = node === range.endContainer ? range.endOffset : node.nodeValue.length;
      if (end > start) slices.push({ node, start, end });
    }
    return slices;
  }

  function unwrapNoteElement(element) {
    const parent = element?.parentNode;
    if (!parent) return;
    while (element.firstChild) parent.insertBefore(element.firstChild, element);
    parent.removeChild(element);
  }

  function noteSliceWrapper(slice, selector) {
    return slice.node.parentElement?.closest(selector) || null;
  }

  function wrapNoteSlices(slices, createWrapper) {
    const wrappers = [];
    slices.forEach(({ node, start, end }) => {
      if (!node.parentNode) return;
      const slice = document.createRange();
      slice.setStart(node, start);
      slice.setEnd(node, end);
      const wrapper = createWrapper();
      try {
        wrapper.appendChild(slice.extractContents());
        slice.insertNode(wrapper);
        wrappers.push(wrapper);
      } catch (_error) {
        // A run that moved out of the tree mid-pass simply keeps its old format.
      }
    });
    return wrappers;
  }

  function selectNoteWrappers(wrappers) {
    if (!wrappers.length) return;
    const range = document.createRange();
    range.setStartBefore(wrappers[0]);
    range.setEndAfter(wrappers[wrappers.length - 1]);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function toggleNoteWrapper(range, selector, createWrapper, matches) {
    const slices = noteRangeSlices(range);
    if (!slices.length) return;
    const wrappers = slices.map((slice) => noteSliceWrapper(slice, selector));
    if (wrappers.every((wrapper) => wrapper && matches(wrapper))) {
      // Deliberately no normalize(): the precomputed runs must stay valid.
      [...new Set(wrappers)].forEach(unwrapNoteElement);
      return;
    }
    [...new Set(wrappers.filter(Boolean))].forEach(unwrapNoteElement);
    selectNoteWrappers(wrapNoteSlices(slices, createWrapper));
  }

  function applyNoteInlineFormat(kind, value = '') {
    const editor = noteEditorElement();
    const range = noteSelectionRange();
    if (!editor || !range) return;
    if (kind === 'bold' || kind === 'italic' || kind === 'strike') {
      document.execCommand(kind === 'bold' ? 'bold' : kind === 'italic' ? 'italic' : 'strikeThrough', false, null);
    } else if (kind === 'code') {
      toggleNoteWrapper(range, 'code', () => document.createElement('code'), () => true);
    } else if (kind === 'mark') {
      const token = noteColorToken(value, 'yellow');
      toggleNoteWrapper(range, 'mark', () => {
        const mark = document.createElement('mark');
        mark.className = `note-mark note-mark-${token}`;
        mark.dataset.color = token;
        return mark;
      }, (wrapper) => wrapper.dataset.color === token);
    } else if (kind === 'color') {
      const token = noteColorToken(value, 'red');
      toggleNoteWrapper(range, 'span.note-color', () => {
        const span = document.createElement('span');
        span.className = `note-color note-color-${token}`;
        span.dataset.color = token;
        return span;
      }, (wrapper) => wrapper.dataset.color === token);
    } else if (kind === 'math') {
      const tex = range.toString().trim();
      if (!tex) return;
      const node = document.createElement('span');
      node.className = 'note-math';
      node.dataset.tex = tex;
      node.contentEditable = 'false';
      range.deleteContents();
      range.insertNode(node);
      hydrateFrameMath(document);
      selectNoteWrappers([node]);
    } else if (kind === 'link') {
      const href = window.prompt('链接地址', 'https://');
      if (!href || !/^https?:\/\//i.test(href)) return;
      toggleNoteWrapper(range, 'a', () => {
        const anchor = document.createElement('a');
        anchor.href = href;
        anchor.target = '_blank';
        anchor.rel = 'noopener';
        return anchor;
      }, () => false);
    } else if (kind === 'clear') {
      ['mark', 'span.note-color', 'code', 'a', 'del', 's', 'strike', 'strong', 'b', 'em', 'i'].forEach((selector) => {
        const current = noteSelectionRange();
        if (!current) return;
        [...new Set(noteRangeSlices(current).map((slice) => noteSliceWrapper(slice, selector)).filter(Boolean))]
          .forEach(unwrapNoteElement);
      });
    }
    editor.focus();
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    commitNoteHistory({ immediate: true });
    positionNoteFormatBar();
  }

  const NOTE_COLOR_LABELS = { red: '红色', orange: '橙色', yellow: '黄色', green: '绿色', blue: '蓝色', purple: '紫色', gray: '灰色' };

  const NOTE_SLASH_ITEMS = [
    { id: 'h1', icon: 'H1', label: '一级标题', keywords: 'h1 heading title 标题' },
    { id: 'h2', icon: 'H2', label: '二级标题', keywords: 'h2 heading 标题' },
    { id: 'h3', icon: 'H3', label: '三级标题', keywords: 'h3 heading 标题' },
    { id: 'todo', icon: '☑', label: '待办事项', keywords: 'todo task check 待办 清单' },
    { id: 'ul', icon: '•', label: '项目列表', keywords: 'ul bullet list 列表' },
    { id: 'ol', icon: '1.', label: '编号列表', keywords: 'ol number list 编号 列表' },
    { id: 'quote', icon: '❝', label: '引用', keywords: 'quote blockquote 引用' },
    { id: 'code', icon: '{ }', label: '代码块', keywords: 'code pre 代码' },
    { id: 'math', icon: '∑', label: '公式块', keywords: 'math formula latex tex 公式' },
    { id: 'details', icon: '▸', label: '折叠块', keywords: 'toggle details fold 折叠' },
    { id: 'divider', icon: '—', label: '分隔线', keywords: 'divider hr rule 分隔' },
    { id: 'image', icon: '🖼', label: '图片', keywords: 'image picture 图片' },
  ];

  const noteSlash = { open: false, query: '', index: 0 };

  function placeCaretInNote(node, atStart = true) {
    const range = document.createRange();
    range.selectNodeContents(node);
    range.collapse(atStart);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function noteCurrentBlock() {
    const editor = noteEditorElement();
    const selection = window.getSelection();
    if (!editor || !selection?.rangeCount) return null;
    let node = selection.getRangeAt(0).startContainer;
    if (node === editor) return null;
    while (node && node.parentNode && node.parentNode !== editor) node = node.parentNode;
    return node?.parentNode === editor ? node : null;
  }

  function noteSlashContext() {
    const editor = noteEditorElement();
    const selection = window.getSelection();
    if (!editor || !selection?.rangeCount) return null;
    const range = selection.getRangeAt(0);
    if (!range.collapsed) return null;
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE || !editor.contains(node)) return null;
    const before = node.nodeValue.slice(0, range.startOffset);
    const match = before.match(/(?:^|\s)\/([^\s/]*)$/);
    if (!match) return null;
    return { node, query: match[1], start: range.startOffset - match[1].length - 1, end: range.startOffset };
  }

  function noteSlashMatches() {
    const query = noteSlash.query.trim().toLowerCase();
    if (!query) return NOTE_SLASH_ITEMS;
    return NOTE_SLASH_ITEMS.filter((item) => `${item.id} ${item.label} ${item.keywords}`.toLowerCase().includes(query));
  }

  function closeNoteSlashMenu() {
    const menu = $('#note-slash-menu');
    noteSlash.open = false;
    noteSlash.query = '';
    noteSlash.index = 0;
    if (menu) menu.hidden = true;
  }

  function renderNoteSlashMenu() {
    const menu = $('#note-slash-menu');
    if (!menu) return;
    const matches = noteSlashMatches();
    if (!matches.length) {
      menu.innerHTML = '<div class="note-slash-empty">没有匹配的块</div>';
      return;
    }
    noteSlash.index = Math.max(0, Math.min(noteSlash.index, matches.length - 1));
    menu.innerHTML = matches.map((item, index) => `<button type="button" role="option" class="note-slash-item" data-note-slash="${item.id}" aria-selected="${index === noteSlash.index ? 'true' : 'false'}"><span>${item.icon}</span><span>${item.label}</span></button>`).join('');
    menu.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }

  function openNoteSlashMenu() {
    const menu = $('#note-slash-menu');
    const selection = window.getSelection();
    if (!menu || !selection?.rangeCount) return;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    noteSlash.open = true;
    menu.hidden = false;
    renderNoteSlashMenu();
    const left = Math.min(Math.max(rect.left, 8), window.innerWidth - menu.offsetWidth - 8);
    const below = rect.bottom + 6;
    const top = below + menu.offsetHeight > window.innerHeight - 8 ? Math.max(8, rect.top - menu.offsetHeight - 6) : below;
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
  }

  function applyNoteSlashCommand(id) {
    const editor = noteEditorElement();
    const context = noteSlashContext();
    if (!editor) return;
    if (context) {
      const range = document.createRange();
      range.setStart(context.node, context.start);
      range.setEnd(context.node, context.end);
      range.deleteContents();
      placeCaretInNote(context.node, false);
      const collapsed = document.createRange();
      collapsed.setStart(context.node, context.start);
      collapsed.collapse(true);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(collapsed);
    }
    closeNoteSlashMenu();
    const block = noteCurrentBlock();
    const create = (html) => {
      const holder = document.createElement('div');
      holder.innerHTML = html;
      return holder.firstElementChild;
    };
    const swap = (element, caretTarget = null) => {
      if (block) block.replaceWith(element); else editor.appendChild(element);
      placeCaretInNote(caretTarget || element, true);
    };
    const text = block ? block.textContent.trim() : '';
    if (/^h[123]$/.test(id)) {
      swap(create(`<${id}>${escapeHTML(text)}</${id}>`));
    } else if (id === 'todo') {
      const list = create('<ul class="note-todo"><li data-checked="false"><input type="checkbox" contenteditable="false"></li></ul>');
      const item = list.querySelector('li');
      item.appendChild(document.createTextNode(text));
      swap(list, item);
    } else if (id === 'ul' || id === 'ol') {
      const list = create(`<${id}><li>${escapeHTML(text)}</li></${id}>`);
      swap(list, list.querySelector('li'));
    } else if (id === 'quote') {
      swap(create(`<blockquote>${escapeHTML(text)}</blockquote>`));
    } else if (id === 'code') {
      const pre = create('<pre><code></code></pre>');
      pre.querySelector('code').textContent = text;
      swap(pre, pre.querySelector('code'));
      editor.insertBefore(create('<p><br></p>'), pre.nextSibling);
    } else if (id === 'math') {
      const tex = window.prompt('输入 LaTeX 公式', text || '\\frac{a}{b}');
      if (!tex) return;
      const node = create('<div class="note-math math-display" contenteditable="false"></div>');
      node.dataset.tex = tex;
      const trailer = create('<p><br></p>');
      if (block) block.replaceWith(node); else editor.appendChild(node);
      node.after(trailer);
      hydrateFrameMath(document);
      placeCaretInNote(trailer, true);
    } else if (id === 'details') {
      const details = create('<details open><summary>折叠标题</summary><p><br></p></details>');
      swap(details, details.querySelector('summary'));
    } else if (id === 'divider') {
      const rule = create('<hr>');
      const trailer = create('<p><br></p>');
      if (block) block.replaceWith(rule); else editor.appendChild(rule);
      rule.after(trailer);
      placeCaretInNote(trailer, true);
    } else if (id === 'image') {
      $('#insert-image-button')?.click();
      return;
    }
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    commitNoteHistory({ immediate: true });
  }

  function closeNoteFormatPalette() {
    const palette = $('#note-format-palette');
    if (palette) palette.hidden = true;
    $$('#note-format-bar [data-note-menu]').forEach((button) => button.setAttribute('aria-expanded', 'false'));
  }

  function hideNoteFormatBar() {
    const bar = $('#note-format-bar');
    if (!bar || bar.hidden) return;
    closeNoteFormatPalette();
    bar.hidden = true;
  }

  function positionNoteFormatBar() {
    const bar = $('#note-format-bar');
    const editor = noteEditorElement();
    const range = noteSelectionRange();
    if (!bar || !editor || !range) { hideNoteFormatBar(); return; }
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) { hideNoteFormatBar(); return; }
    const bounds = editor.getBoundingClientRect();
    bar.hidden = false;
    const width = bar.offsetWidth;
    const height = bar.offsetHeight;
    const left = Math.min(
      Math.max(rect.left + rect.width / 2 - width / 2, 8),
      window.innerWidth - width - 8,
    );
    const above = rect.top - height - 8;
    const top = above > bounds.top - height ? above : rect.bottom + 8;
    bar.style.left = `${Math.round(left)}px`;
    bar.style.top = `${Math.round(Math.max(8, top))}px`;
  }

  function openNoteFormatPalette(kind, anchor) {
    const palette = $('#note-format-palette');
    if (!palette) return;
    const active = anchor.getAttribute('aria-expanded') === 'true';
    closeNoteFormatPalette();
    if (active) return;
    palette.dataset.kind = kind;
    palette.innerHTML = NOTE_COLOR_TOKENS.map((token) => `<button type="button" role="menuitem" class="note-format-swatch note-format-swatch-${kind}" data-note-color="${token}" style="--swatch-color:var(--note-${kind === 'mark' ? 'mark-' : ''}${token})" title="${NOTE_COLOR_LABELS[token]}" aria-label="${NOTE_COLOR_LABELS[token]}"></button>`).join('')
      + '<button type="button" role="menuitem" class="note-format-swatch note-format-swatch-none" data-note-color="none" title="清除" aria-label="清除">⌫</button>';
    palette.hidden = false;
    anchor.setAttribute('aria-expanded', 'true');
  }

  function renderMarkdown(markdown, jobId = state.activeJob?.job_id) {
    const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
    const inline = (value) => {
      const escaped = [];
      const protectedValue = String(value || '').replace(/\\([\\*_`[\]#>+\-.!()])/g, (_match, character) => {
        escaped.push(character);
        return `\uE000${escaped.length - 1}\uE001`;
      });
      let safe = escapeHTML(protectedValue);
      // TeX is full of _ and *, so park formulas before the emphasis passes run.
      const formulas = [];
      safe = safe.replace(/\$([^$\n]+?)\$/g, (_match, tex) => {
        formulas.push(tex);
        return `\uE002${formulas.length - 1}\uE003`;
      });
      safe = safe.replace(/!\[([^\]]*)\]\((data:image\/[a-zA-Z0-9.+-]+;base64,[^)]+)\)/g, '<img alt="$1" src="$2">');
      safe = safe.replace(/!\[([^\]]*)\]\((assets\/[a-f0-9]{64}\.(?:png|jpg|webp|gif))\)/gi, (_match, alt, ref) => {
        const source = noteAssetURL(ref, jobId);
        return source ? `<img alt="${alt}" src="${source}" data-note-asset="${ref}">` : '';
      });
      safe = safe.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
      safe = safe.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/__(.+?)__/g, '<strong>$1</strong>');
      safe = safe.replace(/\*(.+?)\*/g, '<em>$1</em>').replace(/_(.+?)_/g, '<em>$1</em>');
      safe = safe.replace(/~~(.+?)~~/g, '<del>$1</del>');
      safe = safe.replace(/`([^`]+)`/g, '<code>$1</code>');
      // The only markup allowed straight from the note source: an exact escaped
      // tag pair whose colour is one of the enumerated tokens. Everything else
      // stays escaped, so this stays a whitelist rather than an innerHTML hole.
      safe = safe
        .replace(
          new RegExp(`&lt;mark data-color=&quot;(${NOTE_COLOR_PATTERN})&quot;&gt;([\\s\\S]*?)&lt;/mark&gt;`, 'g'),
          (_match, token, inner) => `<mark class="note-mark note-mark-${token}" data-color="${token}">${inner}</mark>`,
        )
        .replace(
          new RegExp(`&lt;span data-color=&quot;(${NOTE_COLOR_PATTERN})&quot;&gt;([\\s\\S]*?)&lt;/span&gt;`, 'g'),
          (_match, token, inner) => `<span class="note-color note-color-${token}" data-color="${token}">${inner}</span>`,
        );
      safe = safe.replace(/\uE002(\d+)\uE003/g, (_match, index) => `<span class="note-math" data-tex="${formulas[Number(index)] || ''}" contenteditable="false"></span>`);
      return safe.replace(/\uE000(\d+)\uE001/g, (_match, index) => escapeHTML(escaped[Number(index)] || ''));
    };
    const html = [];
    let paragraph = [];
    let list = null;
    let fence = null;
    let mathBlock = null;
    let detailsBodyStart = -1;
    const flushParagraph = () => {
      if (!paragraph.length) return;
      html.push(`<p>${paragraph.map(inline).join('<br>')}</p>`);
      paragraph = [];
    };
    const flushList = () => {
      if (!list) return;
      const items = list.items.map((item) => (list.todo
        ? `<li data-checked="${item.checked ? 'true' : 'false'}"><input type="checkbox" contenteditable="false"${item.checked ? ' checked' : ''}>${inline(item.text)}</li>`
        : `<li>${inline(item.text)}</li>`)).join('');
      html.push(`<${list.type}${list.todo ? ' class="note-todo"' : ''}>${items}</${list.type}>`);
      list = null;
    };
    const flushFence = () => {
      if (!fence) return;
      const language = fence.language ? ` class="language-${fence.language}"` : '';
      html.push(`<pre><code${language}>${escapeHTML(fence.lines.join('\n'))}</code></pre>`);
      fence = null;
    };
    const flushMathBlock = () => {
      if (!mathBlock) return;
      html.push(`<div class="note-math math-display" data-tex="${escapeHTML(mathBlock.join('\n').trim())}" contenteditable="false"></div>`);
      mathBlock = null;
    };
    for (const line of lines) {
      if (fence) {
        if (/^```\s*$/.test(line)) flushFence();
        else fence.lines.push(line);
        continue;
      }
      if (mathBlock) {
        if (/^\s*\$\$\s*$/.test(line)) flushMathBlock();
        else mathBlock.push(line);
        continue;
      }
      if (zoteroNoteMarkerPattern.test(line)) {
        flushParagraph(); flushList();
        html.push(line);
        continue;
      }
      const fenceOpen = line.match(/^```([\w+#.-]*)\s*$/);
      if (fenceOpen) { flushParagraph(); flushList(); fence = { language: fenceOpen[1] || '', lines: [] }; continue; }
      const mathInline = line.match(/^\s*\$\$(.+)\$\$\s*$/);
      if (mathInline) { flushParagraph(); flushList(); html.push(`<div class="note-math math-display" data-tex="${escapeHTML(mathInline[1].trim())}" contenteditable="false"></div>`); continue; }
      if (/^\s*\$\$\s*$/.test(line)) { flushParagraph(); flushList(); mathBlock = []; continue; }
      const detailsOpen = line.match(/^<details><summary>(.*)<\/summary>\s*$/);
      if (detailsOpen) {
        flushParagraph(); flushList();
        html.push(`<details open><summary>${inline(detailsOpen[1])}</summary>`);
        detailsBodyStart = html.length;
        continue;
      }
      if (/^<\/details>\s*$/.test(line)) {
        flushParagraph(); flushList();
        // A toggle with no body would leave nowhere to place the caret.
        if (detailsBodyStart === html.length) html.push('<p><br></p>');
        detailsBodyStart = -1;
        html.push('</details>');
        continue;
      }
      if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushParagraph(); flushList(); html.push('<hr>'); continue; }
      const heading = line.match(/^(#{1,3})\s+(.+)$/);
      const todo = line.match(/^\s*[-*+]\s+\[([ xX])\]\s*(.*)$/);
      const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
      const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (!line.trim()) { flushParagraph(); flushList(); continue; }
      if (heading) { flushParagraph(); flushList(); html.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`); continue; }
      if (todo) {
        flushParagraph();
        if (!list || list.type !== 'ul' || !list.todo) { flushList(); list = { type: 'ul', todo: true, items: [] }; }
        list.items.push({ text: todo[2], checked: todo[1].toLowerCase() === 'x' });
        continue;
      }
      if (bullet || ordered) {
        flushParagraph();
        const type = bullet ? 'ul' : 'ol';
        if (!list || list.type !== type || list.todo) { flushList(); list = { type, todo: false, items: [] }; }
        list.items.push({ text: (bullet || ordered)[1] });
        continue;
      }
      if (/^>\s?/.test(line)) { flushParagraph(); flushList(); html.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`); continue; }
      paragraph.push(line);
    }
    flushParagraph(); flushList(); flushFence(); flushMathBlock();
    return html.join('');
  }

  function restoreArticleNoteDrafts() {
    try {
      const stored = JSON.parse(persistentStateGet(articleNoteDraftStorageKey) || '{}');
      Object.entries(stored && typeof stored === 'object' ? stored : {}).forEach(([jobId, draft]) => {
        if (!jobId || typeof draft?.markdown !== 'string') return;
        articleNoteDrafts.set(jobId, { jobId, markdown: draft.markdown, revision: Number(draft.revision || 0), baseRevision: draft.baseRevision });
      });
    } catch (_error) {}
  }

  function persistArticleNoteDrafts() {
    try {
      if (!articleNoteDrafts.size) {
        persistentStateRemove(articleNoteDraftStorageKey);
        return;
      }
      const payload = Object.fromEntries([...articleNoteDrafts.entries()].map(([jobId, draft]) => [jobId, {
        markdown: draft.markdown,
        revision: Number(draft.revision || 0),
        baseRevision: draft.baseRevision,
      }]));
      persistentStateSet(articleNoteDraftStorageKey, JSON.stringify(payload));
    } catch (_error) {}
  }

  function retainArticleNoteDraft(snapshot) {
    if (!snapshot?.jobId || typeof snapshot.markdown !== 'string') return;
    articleNoteDrafts.set(String(snapshot.jobId), { ...snapshot, jobId: String(snapshot.jobId) });
    persistArticleNoteDrafts();
  }

  function discardArticleNoteDraft(jobId) {
    if (!articleNoteDrafts.delete(String(jobId || ''))) return;
    persistArticleNoteDrafts();
  }

  function isArticleNoteSession(jobId, session = null) {
    const editor = $('#notes-editor');
    return Boolean(editor
      && editor.dataset.jobId === String(jobId || '')
      && (!session || editor.dataset.session === String(session))
      && isActiveReaderJob(jobId));
  }

  restoreArticleNoteDrafts();

  function updateArticleNotesEmptyState(editor = $('#notes-editor')) {
    if (!editor) return;
    editor.classList.toggle('is-empty', !editor.textContent.trim() && !editor.querySelector('img'));
  }

  function bumpArticleNotesRevision(editor = $('#notes-editor')) {
    if (!editor) return 0;
    notesEditorRevision += 1;
    editor.dataset.revision = String(notesEditorRevision);
    return notesEditorRevision;
  }

  function setArticleNotesControlsDisabled(disabled) {
    $$('#notes-panel .notes-tools button').forEach((button) => { button.disabled = Boolean(disabled); });
  }

  function prepareArticleNotes(jobId) {
    const editor = $('#notes-editor');
    if (!editor) return null;
    articleNoteImageRange = null;
    notesEditorSession += 1;
    editor.dataset.jobId = String(jobId || '');
    editor.dataset.session = String(notesEditorSession);
    editor.replaceChildren();
    editor.contentEditable = 'false';
    editor.setAttribute('aria-busy', 'true');
    setArticleNotesControlsDisabled(true);
    bumpArticleNotesRevision(editor);
    updateArticleNotesEmptyState(editor);
    window.clearTimeout(notesStatusTimer);
    $('#notes-saved').textContent = '';
    $('#notes-saved').classList.remove('error');
    const imageButton = $('#insert-image-button');
    if (imageButton) imageButton.textContent = '图片';
    if ($('#note-image-input')) $('#note-image-input').value = '';
    return editor.dataset.session;
  }

  function loadArticleNotes(jobId, markdown, session = null, serverRevision = null) {
    const editor = $('#notes-editor');
    if (!isArticleNoteSession(jobId, session)) return;
    articleNoteServerRevisions.set(String(jobId), serverRevision);
    let draft = articleNoteDrafts.get(String(jobId));
    if (draft?.markdown === String(markdown || '')) {
      discardArticleNoteDraft(jobId);
      draft = null;
    }
    editor.innerHTML = renderMarkdown(draft?.markdown ?? markdown, jobId);
    hydrateFrameMath(document);
    resetNoteHistory();
    editor.contentEditable = 'true';
    editor.setAttribute('aria-busy', 'false');
    setArticleNotesControlsDisabled(false);
    const revision = bumpArticleNotesRevision(editor);
    if (draft) {
      retainArticleNoteDraft({ ...draft, revision });
      if (serverRevision && draft.baseRevision !== serverRevision) articleNoteConflicts.set(String(jobId), { markdown, revision: serverRevision });
    }
    updateArticleNotesEmptyState(editor);
    renderArticleNoteConflict(jobId);
    setArticleNotesStatus(articleNoteConflicts.has(String(jobId)) ? '外部笔记已更新，请合并后保存。草稿已保留。' : draft ? '未保存草稿' : '');
  }

  function handleArticleNotesLoadError(jobId, error, session = null) {
    const editor = $('#notes-editor');
    if (!isArticleNoteSession(jobId, session)) return;
    const draft = articleNoteDrafts.get(String(jobId));
    if (draft) {
      editor.innerHTML = renderMarkdown(draft.markdown, jobId);
      editor.contentEditable = 'true';
      editor.setAttribute('aria-busy', 'false');
      setArticleNotesControlsDisabled(false);
      const revision = bumpArticleNotesRevision(editor);
      const retained = { ...draft, revision };
      retainArticleNoteDraft(retained);
      updateArticleNotesEmptyState(editor);
      setArticleNotesStatus('笔记同步失败，草稿已保留', retained, 0, true);
      return;
    }
    editor.contentEditable = 'false';
    editor.setAttribute('aria-busy', 'false');
    setArticleNotesControlsDisabled(true);
    setArticleNotesStatus(`笔记加载失败：${error?.message || '请重新打开文献'}`, { jobId: String(jobId), revision: Number(editor.dataset.revision || 0) }, 0, true);
  }

  function articleNotesSnapshot() {
    const editor = $('#notes-editor');
    const jobId = String(editor?.dataset.jobId || '');
    if (!editor || !jobId || editor.contentEditable !== 'true') return null;
    return {
      jobId,
      markdown: annotationEditorMarkdown(editor),
      revision: Number(editor.dataset.revision || 0),
      baseRevision: articleNoteServerRevisions.get(jobId),
    };
  }

  function setArticleNotesStatus(message, snapshot = null, clearAfter = 0, error = false) {
    const editor = $('#notes-editor');
    if (snapshot && (editor?.dataset.jobId !== snapshot.jobId || Number(editor.dataset.revision || 0) !== snapshot.revision)) return;
    const status = $('#notes-saved');
    if (!status) return;
    window.clearTimeout(notesStatusTimer);
    status.textContent = message || '';
    status.classList.toggle('error', Boolean(message && error));
    if (message && clearAfter) {
      notesStatusTimer = window.setTimeout(() => {
        if (!snapshot || (editor?.dataset.jobId === snapshot.jobId && Number(editor.dataset.revision || 0) === snapshot.revision)) {
          status.textContent = '';
          status.classList.remove('error');
        }
      }, clearAfter);
    }
  }

  function queueArticleNotesSave(snapshot, { announce = true, draftOnly = false } = {}) {
    if (!snapshot?.jobId) return Promise.resolve(false);
    if (announce) setArticleNotesStatus('正在保存…', snapshot);
    const run = async () => {
      try {
        const currentDraft = articleNoteDrafts.get(snapshot.jobId);
        if (draftOnly && !currentDraft) return true;
        if (currentDraft && (draftOnly || currentDraft.revision > snapshot.revision)) snapshot = { ...currentDraft };
        if (articleNoteConflicts.has(snapshot.jobId)) throw new Error('外部笔记已更新，请先合并。当前草稿已保留。');
        const expectedRevision = articleNoteServerRevisions.get(snapshot.jobId) ?? snapshot.baseRevision;
        if (!expectedRevision) throw new Error('笔记版本尚未确认，请重新打开文献后合并草稿。');
        const saved = await api(`/api/jobs/${snapshot.jobId}/notes`, { ...jsonOptions({ markdown: snapshot.markdown, expected_revision: expectedRevision }, 'PUT'), closeSave: true });
        articleNoteServerRevisions.set(snapshot.jobId, saved.revision);
        const newer = articleNoteDrafts.get(snapshot.jobId);
        if (newer) { newer.baseRevision = saved.revision; persistArticleNoteDrafts(); }
        const draft = articleNoteDrafts.get(snapshot.jobId);
        if (draft?.revision === snapshot.revision && draft.markdown === snapshot.markdown) discardArticleNoteDraft(snapshot.jobId);
        setArticleNotesStatus('已保存', snapshot, 1800);
        return true;
      } catch (error) {
        if (error.status === 409) {
          articleNoteConflicts.set(snapshot.jobId, { markdown: '', revision: null });
          try {
            const latest = await api(`/api/jobs/${snapshot.jobId}/notes`, { closeSave: true });
            articleNoteConflicts.set(snapshot.jobId, latest);
          } catch (_error) {}
          renderArticleNoteConflict(snapshot.jobId);
          error.message = '外部笔记已更新，请合并后保存。当前草稿已保留。';
        }
        const draft = articleNoteDrafts.get(snapshot.jobId);
        if (!draft || draft.revision <= snapshot.revision) retainArticleNoteDraft(snapshot);
        setArticleNotesStatus(error.message, snapshot, 0, true);
        return false;
      }
    };
    notesSaveQueue = notesSaveQueue.catch(() => {}).then(run);
    return notesSaveQueue;
  }

  function renderArticleNoteConflict(jobId) {
    if ($('#notes-editor')?.dataset.jobId !== String(jobId)) return;
    const conflict = articleNoteConflicts.get(String(jobId));
    const panel = $('#notes-conflict');
    panel.hidden = !conflict;
    if (conflict) $('#notes-external-version').value = conflict.markdown || '外部版本暂不可读取，请重新打开文献。';
  }
  $('#notes-conflict-merge')?.addEventListener('click', async () => {
    const snapshot = articleNotesSnapshot();
    if (!snapshot || !articleNoteConflicts.has(snapshot.jobId)) return;
    const conflict = articleNoteConflicts.get(snapshot.jobId);
    if (!conflict.revision) { showToast('请重新打开文献以读取最新笔记。', true); return; }
    if (!await requestConfirmation('确认已将外部版本中的所需内容合并到当前笔记？将保存当前编辑内容。', '保存合并结果？')) return;
    articleNoteServerRevisions.set(snapshot.jobId, conflict.revision);
    articleNoteConflicts.delete(snapshot.jobId);
    renderArticleNoteConflict(snapshot.jobId);
    await saveNotes();
  });
  $('#notes-conflict-reload')?.addEventListener('click', async () => {
    const snapshot = articleNotesSnapshot();
    if (!snapshot || !await requestConfirmation('当前本地草稿将被外部版本替换。', '使用外部笔记？')) return;
    try {
      const latest = await api(`/api/jobs/${snapshot.jobId}/notes`);
      if ($('#notes-editor')?.dataset.jobId !== snapshot.jobId) return;
      window.clearTimeout(notesTimer); pendingNotesSnapshot = null;
      discardArticleNoteDraft(snapshot.jobId); articleNoteConflicts.delete(snapshot.jobId);
      loadArticleNotes(snapshot.jobId, latest.markdown, null, latest.revision);
    } catch (error) { showToast(error.message, true); }
  });

  async function flushPendingArticleNotes(jobId = null, { isCurrent = () => true } = {}) {
    const snapshot = pendingNotesSnapshot;
    if (snapshot && (!jobId || snapshot.jobId === String(jobId))) {
      window.clearTimeout(notesTimer);
      notesTimer = null;
      pendingNotesSnapshot = null;
      queueArticleNotesSave(snapshot, { announce: false, draftOnly: true });
    }
    await notesSaveQueue;
    if (!isCurrent()) return false;
    const drafts = [...articleNoteDrafts.values()].filter((draft) => !jobId || draft.jobId === String(jobId));
    let saved = true;
    for (const draft of drafts) {
      if (!isCurrent()) return false;
      if (articleNoteConflicts.has(draft.jobId)) { saved = false; continue; }
      if (!await queueArticleNotesSave(draft, { announce: false, draftOnly: true })) saved = false;
    }
    return saved && ![...articleNoteDrafts.keys()].some((id) => !jobId || id === String(jobId))
      && ![...articleNoteConflicts.keys()].some((id) => !jobId || id === String(jobId));
  }

  function saveNotes({ announce = true } = {}) {
    const snapshot = articleNotesSnapshot();
    if (!snapshot) return Promise.resolve(false);
    if (pendingNotesSnapshot?.jobId === snapshot.jobId) {
      window.clearTimeout(notesTimer);
      notesTimer = null;
      pendingNotesSnapshot = null;
    }
    return queueArticleNotesSave(snapshot, { announce });
  }

  function articleNotesSelectionRange() {
    const editor = $('#notes-editor');
    const selection = window.getSelection();
    if (!editor || !selection?.rangeCount) return null;
    const range = selection.getRangeAt(0);
    const anchor = selection.anchorNode?.nodeType === Node.ELEMENT_NODE ? selection.anchorNode : selection.anchorNode?.parentElement;
    return anchor === editor || editor.contains(anchor) ? range.cloneRange() : null;
  }

  function restoreArticleNotesRange(range = null) {
    const editor = $('#notes-editor');
    if (!editor) return null;
    editor.focus();
    const selection = window.getSelection();
    let nextRange = range;
    if (!nextRange || !document.contains(nextRange.startContainer) || !editor.contains(nextRange.startContainer)) {
      nextRange = document.createRange();
      nextRange.selectNodeContents(editor);
      nextRange.collapse(false);
    }
    selection.removeAllRanges();
    selection.addRange(nextRange);
    return nextRange;
  }

  async function insertArticleNoteImage(file, range = articleNoteImageRange) {
    const editor = $('#notes-editor');
    const jobId = String(editor?.dataset.jobId || '');
    const session = String(editor?.dataset.session || '');
    if (!editor || !jobId || editor.contentEditable !== 'true') throw new Error('请等待当前文献笔记加载完成。');
    const asset = await uploadNoteAsset(file, jobId);
    if (editor.dataset.jobId !== jobId || editor.dataset.session !== session || editor.contentEditable !== 'true' || !isActiveReaderJob(jobId)) throw new Error('文献已经切换，图片未插入当前笔记。');
    const activeRange = restoreArticleNotesRange(range);
    activeRange.deleteContents();
    const fragment = document.createDocumentFragment();
    const leadingBreak = document.createElement('br');
    const image = document.createElement('img');
    const trailingBreak = document.createElement('br');
    image.src = asset.url;
    image.alt = file.name || '笔记图片';
    image.dataset.noteAsset = asset.ref;
    fragment.append(leadingBreak, image, trailingBreak);
    activeRange.insertNode(fragment);
    const nextRange = document.createRange();
    nextRange.setStartAfter(trailingBreak);
    nextRange.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(nextRange);
    articleNoteImageRange = nextRange.cloneRange();
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    commitNoteHistory({ immediate: true });
    await saveNotes();
  }

  const articleNoteFormatCommands = {
    bold: ['bold'],
    italic: ['italic'],
    'unordered-list': ['insertUnorderedList'],
    'ordered-list': ['insertOrderedList'],
    blockquote: ['formatBlock', 'blockquote'],
  };
  $$('#notes-panel [data-format]').forEach((button) => {
    button.addEventListener('mousedown', (event) => {
      event.preventDefault();
      articleNoteImageRange = articleNotesSelectionRange() || articleNoteImageRange;
    });
    button.addEventListener('click', () => {
      const editor = $('#notes-editor');
      if (!editor || editor.contentEditable !== 'true') return;
      restoreArticleNotesRange(articleNotesSelectionRange() || articleNoteImageRange);
      const [command, value] = articleNoteFormatCommands[button.dataset.format] || [];
      if (command) document.execCommand(command, false, value || null);
      articleNoteImageRange = articleNotesSelectionRange();
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    commitNoteHistory({ immediate: true });
    });
  });

  $('#save-notes-button').addEventListener('click', () => saveNotes());
  $('#notes-editor').addEventListener('input', (event) => {
    if (request.closeGate) return;
    const editor = event.currentTarget;
    if (editor.contentEditable !== 'true') return;
    bumpArticleNotesRevision(editor);
    updateArticleNotesEmptyState(editor);
    const snapshot = articleNotesSnapshot();
    pendingNotesSnapshot = snapshot;
    if (snapshot) retainArticleNoteDraft(snapshot);
    window.clearTimeout(notesTimer);
    notesTimer = window.setTimeout(() => {
      const pending = pendingNotesSnapshot;
      pendingNotesSnapshot = null;
      notesTimer = null;
      if (pending) queueArticleNotesSave(pending);
    }, 1200);
  });
  // The bar follows the selection rather than the caret, so it is driven by
  // selectionchange and repositioned whenever the panel moves under it.
  document.addEventListener('selectionchange', () => {
    if (document.activeElement?.closest('#note-format-bar')) return;
    positionNoteFormatBar();
  });
  // Electron's Edit menu and the trackpad gesture reach the editor as
  // beforeinput rather than a key event, so route those through the same stack.
  $('#notes-editor').addEventListener('beforeinput', (event) => {
    if (event.inputType !== 'historyUndo' && event.inputType !== 'historyRedo') return;
    event.preventDefault();
    stepNoteHistory(event.inputType === 'historyUndo' ? -1 : 1);
  });
  $('#notes-editor').addEventListener('input', () => {
    commitNoteHistory();
    const context = noteSlashContext();
    if (!context) { closeNoteSlashMenu(); return; }
    noteSlash.query = context.query;
    if (noteSlash.open) renderNoteSlashMenu(); else openNoteSlashMenu();
  });
  $('#note-slash-menu').addEventListener('pointerdown', (event) => event.preventDefault());
  $('#note-slash-menu').addEventListener('click', (event) => {
    const item = event.target.closest('[data-note-slash]');
    if (item) applyNoteSlashCommand(item.dataset.noteSlash);
  });
  $('#note-format-bar').addEventListener('pointerdown', (event) => event.preventDefault());
  $('#note-format-bar').addEventListener('click', (event) => {
    const swatch = event.target.closest('[data-note-color]');
    if (swatch) {
      const kind = $('#note-format-palette').dataset.kind === 'mark' ? 'mark' : 'color';
      const value = swatch.dataset.noteColor;
      closeNoteFormatPalette();
      if (value === 'none') {
        const range = noteSelectionRange();
        if (range) {
          [...new Set(noteRangeSlices(range)
            .map((slice) => noteSliceWrapper(slice, kind === 'mark' ? 'mark' : 'span.note-color'))
            .filter(Boolean))].forEach(unwrapNoteElement);
          noteEditorElement()?.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return;
      }
      applyNoteInlineFormat(kind, value);
      return;
    }
    const menu = event.target.closest('[data-note-menu]');
    if (menu) { openNoteFormatPalette(menu.dataset.noteMenu, menu); return; }
    const action = event.target.closest('[data-note-format]');
    if (action) { closeNoteFormatPalette(); applyNoteInlineFormat(action.dataset.noteFormat); }
  });
  $('#notes-panel')?.addEventListener('scroll', () => positionNoteFormatBar(), { passive: true, capture: true });
  document.addEventListener('pointerdown', (event) => {
    if (event.target.closest('#note-format-bar') || event.target.closest('#notes-editor')) return;
    hideNoteFormatBar();
  }, { capture: true });
  const rememberArticleNoteSelection = () => {
    const range = articleNotesSelectionRange();
    if (range) articleNoteImageRange = range;
  };
  $('#notes-editor').addEventListener('click', (event) => {
    const box = event.target.closest('ul.note-todo input[type="checkbox"]');
    if (!box) return;
    const item = box.closest('li');
    if (!item) return;
    const checked = !(item.dataset.checked === 'true');
    item.dataset.checked = checked ? 'true' : 'false';
    box.checked = checked;
    event.currentTarget.dispatchEvent(new Event('input', { bubbles: true }));
  });
  $('#notes-editor').addEventListener('mouseup', rememberArticleNoteSelection);
  $('#notes-editor').addEventListener('keyup', rememberArticleNoteSelection);
  $('#notes-editor').addEventListener('keydown', (event) => {
    const modifier = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (modifier && key === 'z') {
      event.preventDefault();
      stepNoteHistory(event.shiftKey ? 1 : -1);
      return;
    }
    if (modifier && key === 'y') {
      event.preventDefault();
      stepNoteHistory(1);
      return;
    }
    if (noteSlash.open) {
      const matches = noteSlashMatches();
      if (event.key === 'Escape') { event.preventDefault(); closeNoteSlashMenu(); return; }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (!matches.length) return;
        const step = event.key === 'ArrowDown' ? 1 : -1;
        noteSlash.index = (noteSlash.index + step + matches.length) % matches.length;
        renderNoteSlashMenu();
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        if (!matches.length) { closeNoteSlashMenu(); return; }
        event.preventDefault();
        applyNoteSlashCommand(matches[noteSlash.index].id);
        return;
      }
    }
    if (event.key === 'Escape') { hideNoteFormatBar(); return; }
    if (modifier && key === 'a') {
      event.preventDefault();
      const range = document.createRange();
      range.selectNodeContents(event.currentTarget);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      articleNoteImageRange = range.cloneRange();
    } else if (modifier && (key === 'b' || key === 'i')) {
      event.preventDefault();
      document.execCommand(key === 'b' ? 'bold' : 'italic', false, null);
      event.currentTarget.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (modifier && event.key === 'Enter') {
      event.preventDefault();
      saveNotes();
    }
  });
  $('#notes-editor').addEventListener('paste', (event) => {
    const file = clipboardImageFile(event.clipboardData);
    if (file) {
      event.preventDefault();
      const jobId = String(event.currentTarget.dataset.jobId || '');
      const session = String(event.currentTarget.dataset.session || '');
      articleNoteImageRange = articleNotesSelectionRange();
      setArticleNotesStatus('正在粘贴图片…');
      insertArticleNoteImage(file, articleNoteImageRange).then(() => showToast('剪贴板图片已插入文章笔记。')).catch((error) => {
        if (isArticleNoteSession(jobId, session)) setArticleNotesStatus('');
        showToast(error.message, true);
      });
      return;
    }
    event.preventDefault();
    insertPlainTextAtSelection(event.currentTarget, event.clipboardData?.getData('text/plain') || '');
    event.currentTarget.dispatchEvent(new Event('input', { bubbles: true }));
  });
  $('#insert-image-button').addEventListener('mousedown', (event) => {
    event.preventDefault();
    articleNoteImageRange = articleNotesSelectionRange() || articleNoteImageRange;
  });
  $('#insert-image-button').addEventListener('click', () => $('#note-image-input').click());
  $('#note-image-input').addEventListener('change', async () => {
    const input = $('#note-image-input');
    const file = input.files?.[0];
    if (!file) return;
    const editor = $('#notes-editor');
    const jobId = String(editor?.dataset.jobId || '');
    const session = String(editor?.dataset.session || '');
    const button = $('#insert-image-button');
    button.disabled = true;
    button.textContent = '上传中…';
    try {
      await insertArticleNoteImage(file, articleNoteImageRange);
      showToast('图片已插入文章笔记。');
    } catch (error) {
      showToast(error.message, true);
    } finally {
      if (isArticleNoteSession(jobId, session)) {
        input.value = '';
        articleNoteImageRange = null;
        button.disabled = $('#notes-editor')?.contentEditable !== 'true';
        button.textContent = '图片';
      }
    }
  });
  window.addEventListener('pagehide', () => {
    if (request.closeGate || demoResetting || browserDemo?.invalidated) return;
    captureCurrentReadingLocation();
    window.clearTimeout(notesTimer);
    articleNoteDrafts.forEach((draft, jobId) => {
      if (articleNoteConflicts.has(jobId) || !(articleNoteServerRevisions.get(jobId) || draft.baseRevision)) return;
      request(`/api/jobs/${jobId}/notes`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ markdown: draft.markdown, expected_revision: articleNoteServerRevisions.get(jobId) || draft.baseRevision }),
        keepalive: true,
      }).catch(() => {});
    });
    flushSettingsOnExit();
  });

  // User-facing AI, metadata, shortcut, color and typography settings.
  let libraryMigrationBusy = false;
  let libraryLocationCanChange = false;
  let aiStatusHistoryRecords = [];
  let aiStatusHistoryPage = 0;
  const aiStatusHistoryPageSize = 3;
  const aiModelLists = { translation: [], chat: [] };
  const aiServiceNames = Object.freeze({ translation: '翻译服务', chat: '文章助手' });

  function setLibraryLocationStatus(message = '', { error = false, migrating = false } = {}) {
    const row = $('.settings-library-location');
    const status = $('#library-location-status');
    if (status) status.textContent = message;
    row?.classList.toggle('is-error', error);
    row?.classList.toggle('is-migrating', migrating);
  }

  function renderLibraryLocation(location = {}) {
    const path = $('#library-location-path');
    const button = $('#choose-library-location');
    const currentPath = String(location.currentPath || '').trim();
    if (path) {
      path.textContent = currentPath || '当前位置不可用';
      path.title = currentPath || '当前位置不可用';
    }
    libraryLocationCanChange = location.canChange !== false && location.readOnly !== true;
    if (button) button.disabled = libraryMigrationBusy || !libraryLocationCanChange;
    const sourceLabel = location.source === 'environment'
      ? '由 MY_SCHOLAR_LIBRARY_DIR 固定，需在启动环境中修改。'
      : location.source === 'saved' ? '正在使用自定义文献库位置。' : '正在使用默认文献库位置。';
    setLibraryLocationStatus(sourceLabel);
  }

  async function loadLibraryLocation() {
    const desktop = window.myScholarDesktop;
    if (typeof desktop?.getLibraryLocation !== 'function') {
      const path = $('#library-location-path');
      if (path) { path.textContent = '当前浏览器服务所使用的文献库'; path.title = path.textContent; }
      const button = $('#choose-library-location');
      if (button) button.disabled = true;
      setLibraryLocationStatus('请在谷子学术桌面客户端中选择文件夹。');
      return;
    }
    try {
      renderLibraryLocation(await desktop.getLibraryLocation());
    } catch (error) {
      setLibraryLocationStatus(error.message || '无法读取文献库位置。', { error: true });
    }
  }

  window.myScholarDesktop?.onLibraryMigrationProgress?.((progress = {}) => {
    setLibraryLocationStatus(String(progress.message || '正在迁移文献库…'), { migrating: true });
  });

  $('#choose-library-location')?.addEventListener('click', async () => {
    const desktop = window.myScholarDesktop;
    if (libraryMigrationBusy || typeof desktop?.chooseLibraryLocation !== 'function') return;
    const button = $('#choose-library-location');
    libraryMigrationBusy = true;
    button.disabled = true;
    button.textContent = '正在准备…';
    setLibraryLocationStatus('正在确认待保存内容…', { migrating: true });
    try {
      const notesSaved = await flushPendingArticleNotes();
      if (notesSaved === false) throw new Error('文章笔记尚未保存，请先解决保存错误后再迁移文献库。');
      setLibraryLocationStatus('请选择一个空文件夹。', { migrating: true });
      const result = await desktop.chooseLibraryLocation();
      if (result?.cancelled) {
        await loadLibraryLocation();
        return;
      }
      if (!result?.ok) throw new Error(result?.error || '文献库迁移未完成。');
      renderLibraryLocation({ currentPath: result.currentPath, source: 'saved', canChange: true, readOnly: false });
      const files = Number(result.copied?.files) || 0;
      const bytes = Number(result.copied?.bytes) || 0;
      setLibraryLocationStatus(`已复制并校验 ${files} 个文件 · ${formatBytes(bytes)}。旧位置已作为原始备份保留。`);
      showToast('文献库位置已切换。');
    } catch (error) {
      setLibraryLocationStatus(error.message || '文献库迁移失败，仍在使用原位置。', { error: true });
      showToast(error.message || '文献库迁移失败，仍在使用原位置。', true);
    } finally {
      libraryMigrationBusy = false;
      button.textContent = '选择文件夹';
      button.disabled = !libraryLocationCanChange;
    }
  });

  function updateStatusClass(stateName) {
    const card = $('#update-status-card');
    if (!card) return;
    card.classList.remove('is-idle', 'is-checking', 'is-current', 'is-available', 'is-error', 'is-ready', 'is-downloading', 'is-saving', 'is-installing', 'is-disabled', 'is-ahead');
    card.classList.add(`is-${stateName}`);
  }

  function formatUpdateTime(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  }

  let localTestBuild = false;
  function renderAppInfo(context = {}) {
    const info = context.app || {};
    localTestBuild = Boolean(info.localTestBuild);
    if ($('#app-current-version')) $('#app-current-version').textContent = info.version ? `v${info.version}` : '未知';
    const platform = info.platform || appPlatform;
    const platformName = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[platform] || platform;
    const arch = platform === 'darwin' && info.arch === 'arm64' ? 'Apple Silicon' : info.arch || '未知架构';
    if ($('#app-platform-arch')) $('#app-platform-arch').textContent = `${platformName} · ${arch}`;
    if ($('#app-update-channel')) $('#app-update-channel').textContent = localTestBuild ? '本地测试版' : info.channel === 'beta' ? '测试版' : info.channel === 'internal' ? '内部构建' : info.channel === 'stable' ? '稳定版' : String(info.channel || '未配置');
    if (localTestBuild) {
      $('#check-updates')?.setAttribute('disabled', '');
      if ($('#update-status-title')) $('#update-status-title').textContent = '本地测试版';
      if ($('#update-status-detail')) $('#update-status-detail').textContent = '此版本仅用于本机验证，请使用单独提供的测试包更新。';
    }
  }

  async function loadAppInfo() {
    const desktop = window.myScholarDesktop;
    if (typeof desktop?.getStartupContext !== 'function') {
      if ($('#app-current-version')) $('#app-current-version').textContent = '仅桌面客户端提供';
      $('#check-updates')?.setAttribute('disabled', '');
      return null;
    }
    try {
      const context = await desktop.getStartupContext();
      if (!context?.ok) throw new Error(context?.error || '无法读取应用版本。');
      onboarding.setStartupContext(context);
      renderAppInfo(context);
      if (typeof desktop.getUpdateState === 'function') renderUpdateResult(await desktop.getUpdateState());
      onboarding.renderOnboardingStorage(context.storage);
      return context;
    } catch (error) {
      if ($('#app-current-version')) $('#app-current-version').textContent = '读取失败';
      return null;
    }
  }

  function renderUpdateResult(result) {
    const status = result.status || 'error';
    updateStatusClass(result.error && status !== 'disabled' ? 'error' : status);
    const titles = {
      idle: '尚未检查更新', checking: '正在检查新版本', current: '当前已是最新版本', ahead: '当前版本高于更新通道版本',
      available: `发现新版本 v${result.version}`, downloading: '正在下载更新', ready: `v${result.version} 已准备就绪`,
      saving: '正在确认改动已保存', installing: '正在安装更新', disabled: '应用内更新未启用', error: '暂时无法更新',
    };
    const details = {
      idle: '正式版启动时检查新版本并提醒查看发布页，也可以在这里手动检查。', checking: '正在连接 GitHub 更新服务。', current: '可以继续使用当前版本。',
      ahead: '当前更新通道没有更高的版本。', available: '下载完成后可确认保存、安装并重新启动。',
      downloading: '你可以继续阅读；下载完成后由你决定何时安装。', ready: '安装前会保存笔记、设置和阅读记录。普通退出不会安装。',
      saving: '保存失败或取消时会停止安装。', installing: '应用即将退出，完成后会自动重新启动。',
    };
    $('#update-status-title').textContent = titles[status] || titles.error;
    $('#update-status-detail').textContent = result.error || details[status] || '请稍后重试。';
    $('#update-checked-time').textContent = result.checkedAt ? `检查于 ${formatUpdateTime(result.checkedAt)}` : '';
    const check = $('#check-updates'); check.disabled = !result.canCheck; check.textContent = status === 'checking' ? '正在检查…' : '检查更新';
    const download = $('#download-update'); download.hidden = !result.canDownload; download.disabled = !result.canDownload;
    download.textContent = result.error ? '重新下载' : '下载更新';
    const install = $('#install-update'); install.hidden = !result.canInstall; install.disabled = !result.canInstall;
    $('#update-download-progress').hidden = status !== 'downloading';
    const percent = Math.min(100, Math.max(0, Number(result.progress?.percent) || 0));
    $('#update-progress-bar').value = percent;
    $('#update-progress-text').textContent = `${percent.toFixed(0)}%`;
    const release = $('#update-release-details');
    release.hidden = !result.version || ['idle', 'disabled', 'current', 'ahead'].includes(status);
    $('#update-release-version').textContent = result.version ? `谷子学术 v${result.version}` : '';
    $('#update-release-date').textContent = result.publishedAt ? `发布于 ${formatUpdateTime(result.publishedAt)}` : '';
    $('#update-release-notes').textContent = result.notes || '此版本没有附加更新说明。';
  }

  async function runUpdateAction(method) {
    const desktop = window.myScholarDesktop;
    if (typeof desktop?.[method] !== 'function') return;
    try {
      const result = await desktop[method]();
      renderUpdateResult(result);
      if (result.ok === false) showToast(result.error || '更新操作失败，请重试。', true);
    } catch (error) {
      const state = await desktop.getUpdateState().catch(() => ({ status: 'error', canCheck: true }));
      renderUpdateResult({ ...state, error: error.message });
    }
  }
  $('#check-updates')?.addEventListener('click', () => runUpdateAction('checkForUpdates'));
  $('#download-update')?.addEventListener('click', () => runUpdateAction('downloadUpdate'));
  $('#install-update')?.addEventListener('click', () => runUpdateAction('installUpdate'));
  window.myScholarDesktop?.onUpdateState?.(renderUpdateResult);

  function readAIStatusHistory() {
    return aiStatusHistoryRecords;
  }

  function aiConnectionSucceeded(result = {}) {
    return result.ok === true || result.success === true || result.status === 'ok';
  }

  function aiStatusState(results = {}) {
    const successful = Object.keys(aiServiceNames).filter((service) => aiConnectionSucceeded(results?.[service])).length;
    if (successful === Object.keys(aiServiceNames).length) return 'operational';
    if (successful > 0) return 'partial';
    return 'outage';
  }

  function formatAIStatusTime(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '时间未知';
    return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date);
  }

  function sanitizeAIStatusRecord(results = {}, checkedAt = new Date().toISOString()) {
    const services = {};
    Object.keys(aiServiceNames).forEach((service) => {
      const result = results?.[service] || {};
      const elapsed = Number(result.elapsed_ms);
      services[service] = {
        ok: aiConnectionSucceeded(result),
        ...(Number.isFinite(elapsed) ? { elapsed_ms: Math.max(0, Math.round(elapsed)) } : {}),
        ...(!aiConnectionSucceeded(result) ? { error: String(result.error || result.message || '连接失败').slice(0, 180) } : {}),
      };
    });
    const checkedDate = new Date(checkedAt);
    return { checkedAt: Number.isFinite(checkedDate.getTime()) ? checkedDate.toISOString() : new Date().toISOString(), results: services };
  }

  function renderAIStatusRecord(record) {
    const results = record?.results || {};
    const stateName = aiStatusState(results);
    const successful = Object.keys(aiServiceNames).filter((service) => aiConnectionSucceeded(results[service])).length;
    const overview = $('#ai-status-overview');
    overview?.classList.remove('is-unknown', 'is-operational', 'is-partial', 'is-outage');
    overview?.classList.add(`is-${stateName}`);
    const titles = { operational: 'AI 服务运行正常', partial: '部分 AI 服务异常', outage: 'AI 服务暂不可用' };
    const title = $('#ai-status-overview-title');
    const detail = $('#ai-status-overview-detail');
    const time = $('#ai-status-overview-time');
    if (title) title.textContent = titles[stateName];
    if (detail) detail.textContent = `${successful}/${Object.keys(aiServiceNames).length} 项服务通过了最近一次真实连接检测。`;
    if (time) {
      time.textContent = `检测于 ${formatAIStatusTime(record.checkedAt)}`;
      time.dateTime = String(record.checkedAt || '');
    }
    Object.keys(aiServiceNames).forEach((service) => {
      const result = results[service] || {};
      const success = aiConnectionSucceeded(result);
      const status = $(`#setting-${service}-status`);
      if (status) {
        status.textContent = success ? '运行正常' : '连接异常';
        status.classList.remove('is-loading', 'is-unknown', 'is-ready', 'is-unavailable');
        status.classList.add(success ? 'is-ready' : 'is-unavailable');
      }
      const elapsed = Number(result.elapsed_ms);
      const latency = $(`#setting-${service}-latency`);
      if (latency) latency.textContent = Number.isFinite(elapsed) ? `${Math.round(elapsed)} ms` : '—';
      const note = $(`#setting-${service}-result`);
      if (note) {
        note.textContent = success ? '最近一次连接检测成功。' : String(result.error || '连接失败');
        note.classList.toggle('is-success', success);
        note.classList.toggle('is-error', !success);
        note.hidden = false;
      }
    });
  }

  function renderAIStatusHistory() {
    const history = readAIStatusHistory();
    const list = $('#ai-status-history-list');
    const pageCount = Math.max(1, Math.ceil(history.length / aiStatusHistoryPageSize));
    aiStatusHistoryPage = Math.max(0, Math.min(aiStatusHistoryPage, pageCount - 1));
    const pageStart = aiStatusHistoryPage * aiStatusHistoryPageSize;
    const visibleHistory = history.slice(pageStart, pageStart + aiStatusHistoryPageSize);
    if (list) {
      list.innerHTML = visibleHistory.length
        ? visibleHistory.map((record) => {
          const stateName = aiStatusState(record.results);
          const label = stateName === 'operational' ? '全部服务正常' : stateName === 'partial' ? '部分服务异常' : '全部服务异常';
          return `<li class="is-${stateName}"><span>${label}</span><time datetime="${escapeHTML(record.checkedAt || '')}">${escapeHTML(formatAIStatusTime(record.checkedAt))}</time></li>`;
        }).join('')
        : '<li class="ai-status-history-empty">还没有检测记录。</li>';
    }
    const count = $('#ai-status-history-count');
    if (count) count.textContent = history.length ? `共 ${history.length} 条记录` : '仅保存在当前设备';
    const pagination = $('#ai-status-history-pagination');
    const previous = $('#ai-status-history-prev');
    const next = $('#ai-status-history-next');
    const pageLabel = $('#ai-status-history-page');
    if (pagination) pagination.hidden = history.length <= aiStatusHistoryPageSize;
    if (previous) previous.disabled = aiStatusHistoryPage <= 0;
    if (next) next.disabled = aiStatusHistoryPage >= pageCount - 1;
    if (pageLabel) pageLabel.textContent = `${aiStatusHistoryPage + 1} / ${pageCount}`;
    if (history[0]) {
      renderAIStatusRecord(history[0]);
      return;
    }
    const overview = $('#ai-status-overview');
    overview?.classList.remove('is-operational', 'is-partial', 'is-outage');
    overview?.classList.add('is-unknown');
    Object.keys(aiServiceNames).forEach((service) => {
      const status = $(`#setting-${service}-status`);
      if (status) { status.textContent = '尚未检测'; status.className = 'ai-service-status is-unknown'; }
    });
  }

  function rememberAIStatus(results, savedRecord = null) {
    const record = sanitizeAIStatusRecord(results, savedRecord?.checkedAt);
    aiStatusHistoryRecords = [record, ...readAIStatusHistory()];
    aiStatusHistoryPage = 0;
    renderAIStatusHistory();
    return record;
  }

  function renderAIServiceCards(services = {}) {
    for (const service of Object.keys(aiServiceNames)) {
      const config = services?.[service] || {};
      const flags = config.configured && typeof config.configured === 'object' ? Object.values(config.configured) : [];
      const fullyConfigured = flags.length ? flags.every(Boolean) : config.enabled === true;
      const configuration = $(`#setting-${service}-configuration`);
      if (configuration) {
        configuration.textContent = config.enabled === true ? '已启用' : fullyConfigured ? '已配置 · 当前未启用' : '配置不完整';
        configuration.title = String(config.note || '');
      }
    }
    renderAIStatusHistory();
  }

  function syncTranslationProviderControls() {
    const provider = $('#setting-translation-provider')?.value || 'openai-compatible';
    $$('[data-translation-provider-fields]').forEach((field) => { field.hidden = !field.dataset.translationProviderFields.split(' ').includes(provider); });
    const reuseChat = $('[data-ai-reuse-source="chat"][data-ai-reuse-target="translation"]');
    if (reuseChat) reuseChat.hidden = provider !== 'openai-compatible';
  }

  function renderAISettings(settings = {}) {
    Object.keys(aiServiceNames).forEach((service) => {
      const config = settings?.[service] || {};
      state.aiProfiles[service] = { base_url: config.base_url || '', model: config.model || '', api_format: config.api_format || 'auto', ...normalizeChatOptions(config), capabilities: config.capabilities || {} };
      if (service === 'translation') {
        $('#setting-translation-provider').value = config.provider || 'openai-compatible';
        $('#setting-translation-deepl-tier').value = config.deepl_tier === 'pro' ? 'pro' : 'free';
        $('#setting-translation-source-language').value = config.source_language || 'auto';
        $('#setting-translation-target-language').value = config.target_language || 'zh';
        for (const name of ['access_key_id', 'secret_access_key']) {
          const input = $(`#setting-translation-${name.replaceAll('_', '-')}`);
          const button = $(`[data-translation-clear-secret="${name}"]`);
          input.value = '';
          input.placeholder = config[`${name}_configured`] ? '已配置；留空保持不变' : '输入服务密钥';
          button.dataset.clearRequested = 'false';
          button.disabled = !config[`${name}_configured`];
        }
      }
      const baseURL = $(`#setting-${service}-base-url`);
      const model = $(`#setting-${service}-model`);
      const mode = service === 'translation' ? $('#setting-translation-mode') : null;
      const apiKey = $(`#setting-${service}-api-key`);
      const clearKey = $(`#setting-${service}-clear-key`);
      if (baseURL) baseURL.value = String(config.base_url || '');
      if (model) model.value = String(config.model || '');
      if (mode) mode.value = config.mode === 'chat' ? 'chat' : 'qwen-mt';
      $(`#setting-${service}-api-format`).value = config.api_format || 'auto';
      renderReasoningControl(`setting-${service}`, config.reasoning_effort || 'auto', config.capabilities || {});
      $(`#setting-${service}-thinking-budget`).value = config.thinking_budget || 0;
      $(`#setting-${service}-context-window`).value = config.context_window || 0;
      if (apiKey) {
        apiKey.value = '';
        apiKey.placeholder = config.api_key_configured ? '已配置；留空保持不变' : '输入服务密钥（可选）';
      }
      if (clearKey) {
        clearKey.dataset.clearRequested = 'false';
        clearKey.disabled = !config.api_key_configured;
        clearKey.title = config.api_key_configured ? clearKey.getAttribute('aria-label') || '清除已保存的 API Key' : '当前没有已保存的 API Key';
      }
      aiModelLists[service] = [];
      const picker = $(`#setting-${service}-model-picker`);
      const modelList = $(`#setting-${service}-model-list`);
      const modelFilter = $(`#setting-${service}-model-filter`);
      const modelStatus = $(`#setting-${service}-model-status`);
      if (picker) picker.hidden = true;
      if (modelList) modelList.innerHTML = '';
      if (modelFilter) modelFilter.value = '';
      if (modelStatus) modelStatus.textContent = '';
    });
    syncTranslationProviderControls();
    for (const service of Object.keys(aiServiceNames)) renderAIInferenceControls(service);
    renderChatOptions({ force: true });
  }

  function aiSettingsFromControls() {
    return Object.fromEntries(Object.keys(aiServiceNames).map((service) => [service, {
      base_url: $(`#setting-${service}-base-url`)?.value.trim() || '',
      api_format: $(`#setting-${service}-api-format`)?.value || 'auto',
      reasoning_effort: reasoningFromControl(`setting-${service}`),
      thinking_budget: Number($(`#setting-${service}-thinking-budget`)?.value || 0),
      context_window: Number($(`#setting-${service}-context-window`)?.value || 0),
      model: $(`#setting-${service}-model`)?.value.trim() || '',
      api_key: $(`#setting-${service}-api-key`)?.value || '',
      clear_api_key: $(`#setting-${service}-clear-key`)?.dataset.clearRequested === 'true',
      ...(service === 'translation' ? {
        mode: $('#setting-translation-mode')?.value === 'chat' ? 'chat' : 'qwen-mt',
        provider: $('#setting-translation-provider')?.value || 'openai-compatible',
        deepl_tier: $('#setting-translation-deepl-tier')?.value || 'free',
        source_language: $('#setting-translation-source-language')?.value.trim() || 'auto',
        target_language: $('#setting-translation-target-language')?.value.trim() || 'zh',
        access_key_id: $('#setting-translation-access-key-id')?.value || '',
        secret_access_key: $('#setting-translation-secret-access-key')?.value || '',
        clear_access_key_id: $('[data-translation-clear-secret="access_key_id"]')?.dataset.clearRequested === 'true',
        clear_secret_access_key: $('[data-translation-clear-secret="secret_access_key"]')?.dataset.clearRequested === 'true',
      } : {}),
    }]));
  }

  function clearSavedAIKey(service, button) {
    if (!button || button.disabled) return;
    const apiKey = $(`#setting-${service}-api-key`);
    if (apiKey) apiKey.value = '';
    button.dataset.clearRequested = 'true';
    button.disabled = true;
    queueSettingsSave(true);
  }

  function renderAIModelList(service) {
    const select = $(`#setting-${service}-model-list`);
    const filter = $(`#setting-${service}-model-filter`);
    if (!select) return;
    const query = String(filter?.value || '').trim().toLowerCase();
    const models = (aiModelLists[service] || []).filter((model) => !query || model.toLowerCase().includes(query));
    select.innerHTML = models.length
      ? models.map((model) => `<option value="${escapeHTML(model)}">${escapeHTML(model)}</option>`).join('')
      : '<option value="" disabled>没有匹配的模型</option>';
  }

  async function queryAIModels(service) {
    const button = $(`[data-ai-models="${service}"]`);
    const picker = $(`#setting-${service}-model-picker`);
    const status = $(`#setting-${service}-model-status`);
    if (!button) return;
    button.disabled = true;
    button.textContent = '查询中…';
    if (status) status.textContent = '正在读取服务商模型列表…';
    try {
      const profile = aiSettingsFromControls()[service];
      const payload = await api('/api/ai/models', jsonOptions({ service, profile }));
      const models = Array.isArray(payload.models) ? payload.models.map((model) => String(model)).filter(Boolean) : [];
      if (!models.length) throw new Error('服务没有返回可用模型。');
      aiModelLists[service] = models;
      state.aiModelCapabilities[service] = { identity: aiProfileIdentity(profile), models: payload.model_capabilities || {} };
      renderAIInferenceControls(service);
      const filter = $(`#setting-${service}-model-filter`);
      if (filter) filter.value = '';
      renderAIModelList(service);
      if (picker) picker.hidden = false;
      if (status) status.textContent = `已找到 ${models.length} 个模型，选择后会填入模型字段。`;
      showToast(`已找到 ${models.length} 个${aiServiceNames[service]}模型。`);
    } catch (error) {
      if (status) status.textContent = error.message || '模型列表查询失败。';
      if (picker) picker.hidden = false;
      showToast(error.message || '模型列表查询失败。', true);
    } finally {
      button.disabled = false;
      button.textContent = '查询模型';
    }
  }

  async function reuseAIProfile(source, target, button) {
    if (!button) return;
    const originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = '复用中…';
    try {
      if (!await flushPendingSettings()) throw new Error('请先解决未保存的设置。');
      const payload = await api('/api/settings/ai/reuse', jsonOptions({ source, target }));
      renderAISettings(payload.settings?.ai || {});
      await checkHealth();
      renderAIServiceCards(state.health?.ai?.services || {});
      showToast(`已将${aiServiceNames[source]}配置复用到${aiServiceNames[target]}。`);
    } catch (error) {
      showToast(error.message || 'AI 配置复用失败。', true);
    } finally {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  }


  function aiTestResults(payload) {
    const results = payload?.results || payload?.result?.services || payload?.result || {};
    return typeof results === 'object' && results ? results : {};
  }

  function normalizeAppearance(value, fallback = appearanceDefaults) {
    const source = value && typeof value === 'object' ? value : {};
    const base = fallback && typeof fallback === 'object' ? fallback : appearanceDefaults;
    return Object.fromEntries(Object.keys(appearanceDefaults).map((key) => {
      const fallbackValue = appearanceOptions[key].has(base[key]) ? base[key] : appearanceDefaults[key];
      return [key, appearanceOptions[key].has(source[key]) ? source[key] : fallbackValue];
    }));
  }

  const readerDarkSurface = Object.freeze({ '--paper': '#1e2124', '--ink': '#dcdcde', '--line': '#55462f', '--soft': '#32281a' });

  function appearanceVariables(appearance) {
    const normalized = normalizeAppearance(appearance);
    const palette = accentTokens[colorSchemeQuery.matches ? 'dark' : 'light'][normalized.accent];
    return {
      '--app-font': appFontStacks[normalized.app_font],
      '--reader-font': appFontStacks[normalized.app_font],
      '--reader-content-font-family': readerFontStacks[normalized.reader_font],
      '--accent': palette.accent,
      '--accent-dark': palette.dark,
      '--accent-soft': palette.soft,
      '--accent-fill': palette.fill,
      '--accent-fill-hover': palette.hover,
      '--on-accent': palette.on,
    };
  }

  function setAppearanceVariables(root, appearance, { readerDocument = false, important = false } = {}) {
    if (!root) return;
    const normalized = normalizeAppearance(appearance);
    const variables = appearanceVariables(normalized);
    if (readerDocument) {
      variables['--ui-font'] = appFontStacks[normalized.app_font];
      variables['--paper-font'] = readerFontStacks[normalized.reader_font];
      // Documents parsed before the dark surface was lifted still carry the old
      // near-black palette in their own stylesheet, so push the current surface
      // onto the reader document instead of asking the library to re-parse.
      if (colorSchemeQuery.matches) Object.assign(variables, readerDarkSurface);
      else Object.keys(readerDarkSurface).forEach((name) => root.style.removeProperty(name));
    }
    Object.entries(variables).forEach(([name, value]) => root.style.setProperty(name, value, important ? 'important' : ''));
  }

  function applyAppearance(appearance = state.appearance) {
    state.appearance = normalizeAppearance(appearance, state.appearance);
    setAppearanceVariables(document.documentElement, state.appearance);
    setAppearanceVariables(frameDocument()?.documentElement, state.appearance, { readerDocument: true, important: true });
    applyTypography();
    state.graphController?.setFontFamily?.(readerFontStacks[state.appearance.reader_font] || readerFontStacks.academic);
  }

  function clearAppearancePreview() {
    const preview = $('#settings-appearance-preview');
    if (!preview) return;
    ['--preview-app-font', '--preview-reader-font', ...Object.keys(appearanceVariables(appearanceDefaults))].forEach((name) => preview.style.removeProperty(name));
  }

  function applyAppearancePreview(appearance = state.pendingAppearance) {
    const preview = $('#settings-appearance-preview');
    if (!preview) return;
    const normalized = normalizeAppearance(appearance, state.appearance);
    setAppearanceVariables(preview, normalized);
    preview.style.setProperty('--preview-app-font', appFontStacks[normalized.app_font]);
    preview.style.setProperty('--preview-reader-font', readerFontStacks[normalized.reader_font]);
  }

  function renderAppearanceControls(appearance = state.pendingAppearance) {
    const normalized = normalizeAppearance(appearance, state.appearance);
    const appFont = $('#setting-app-font');
    const readerFont = $('#setting-reader-font');
    if (appFont) appFont.value = normalized.app_font;
    if (readerFont) readerFont.value = normalized.reader_font;
    $$('input[name="setting-accent"]').forEach((input) => { input.checked = input.value === normalized.accent; });
  }

  function appearanceFromControls() {
    return normalizeAppearance({
      app_font: $('#setting-app-font')?.value,
      reader_font: $('#setting-reader-font')?.value,
      accent: $('input[name="setting-accent"]:checked')?.value,
    }, state.pendingAppearance || state.appearance);
  }

  function previewAppearanceFromControls() {
    state.pendingAppearance = appearanceFromControls();
    applyAppearancePreview(state.pendingAppearance);
  }

  const shortcutInputMap = Object.freeze({
    'shortcut-library': 'open_library',
    'shortcut-settings': 'open_settings',
    'shortcut-highlight': 'highlight',
    'shortcut-underline': 'underline',
    'shortcut-highlight-note': 'highlight_note',
    'shortcut-underline-note': 'underline_note',
    'shortcut-full-translation': 'full_translation',
    'shortcut-reflow': 'reflow',
  });
  const shortcutModifierTokens = new Set(['cmd', 'command', 'meta', 'windows', 'win', 'ctrl', 'control', 'option', 'alt', 'shift']);
  const shortcutKeyAliases = Object.freeze({
    comma: ',', space: 'Space', enter: 'Enter', return: 'Enter', escape: 'Escape', esc: 'Escape',
    backspace: 'Backspace', delete: 'Delete', tab: 'Tab', home: 'Home', end: 'End',
    arrowleft: 'ArrowLeft', left: 'ArrowLeft', arrowright: 'ArrowRight', right: 'ArrowRight',
    arrowup: 'ArrowUp', up: 'ArrowUp', arrowdown: 'ArrowDown', down: 'ArrowDown',
  });

  function canonicalShortcutKey(value) {
    const original = String(value || '');
    if (original === ' ') return 'Space';
    const raw = original.trim();
    if (!raw) return '';
    const alias = shortcutKeyAliases[raw.toLowerCase()];
    if (alias) return alias;
    if (/^f(?:[1-9]|1[0-9]|2[0-4])$/iu.test(raw)) return raw.toUpperCase();
    if (raw.length === 1) return /[a-z]/iu.test(raw) ? raw.toUpperCase() : raw;
    return raw.length <= 16 ? `${raw[0].toUpperCase()}${raw.slice(1)}` : '';
  }

  function normalizeShortcut(value) {
    const parts = String(value || '').split('+').map((part) => part.trim()).filter(Boolean);
    if (parts.length < 2) return '';
    const keyPart = parts.at(-1);
    const modifiers = new Set(parts.slice(0, -1).map((part) => part.toLowerCase()));
    if ([...modifiers].some((part) => !shortcutModifierTokens.has(part))) return '';
    const command = modifiers.has('cmd') || modifiers.has('command') || modifiers.has('meta') || modifiers.has('windows') || modifiers.has('win');
    const control = modifiers.has('ctrl') || modifiers.has('control');
    if (!command && !control) return '';
    const key = canonicalShortcutKey(keyPart);
    if (!key || shortcutModifierTokens.has(key.toLowerCase())) return '';
    return [command && shortcutMetaModifier, control && 'Ctrl', (modifiers.has('option') || modifiers.has('alt')) && shortcutAltModifier, modifiers.has('shift') && 'Shift', key].filter(Boolean).join('+');
  }

  function normalizedShortcutSettings(shortcuts = {}) {
    return Object.fromEntries(Object.entries(shortcutDefaults).map(([key, fallback]) => {
      const legacyDefault = fallback.replace(/^Ctrl\+/u, 'Cmd+').replace('+Alt+', '+Option+');
      const value = appPlatform === 'win32' && shortcuts[key] === legacyDefault ? fallback : shortcuts[key];
      return [key, normalizeShortcut(value) || fallback];
    }));
  }

  function capturedShortcut(event) {
    if (event.isComposing || event.keyCode === 229 || event.repeat) return '';
    if (!event.metaKey && !event.ctrlKey) return '';
    const key = canonicalShortcutKey(event.key);
    if (!key || shortcutModifierTokens.has(key.toLowerCase())) return '';
    return [event.metaKey && shortcutMetaModifier, event.ctrlKey && 'Ctrl', event.altKey && shortcutAltModifier, event.shiftKey && 'Shift', key].filter(Boolean).join('+');
  }

  const reservedShortcuts = new Set([
    'Cmd+A', 'Ctrl+A', 'Cmd+F', 'Ctrl+F',
    ...['I', 'Shift+F', 'Backspace', 'Delete', 'W'].map((key) => `${shortcutPrimaryModifier}+${key}`),
  ]);

  function shortcutInputs() {
    return Object.entries(shortcutInputMap).map(([id, setting]) => ({ input: document.getElementById(id), setting })).filter(({ input }) => input);
  }

  function validateShortcutInputs({ announce = false } = {}) {
    const records = shortcutInputs().map(({ input, setting }) => ({ input, setting, value: normalizeShortcut(input.value) }));
    const counts = new Map();
    records.forEach(({ value }) => { if (value) counts.set(value, (counts.get(value) || 0) + 1); });
    let firstMessage = '';
    records.forEach((record) => {
      const reserved = [...reservedShortcuts].some((shortcut) => normalizeShortcut(shortcut) === record.value);
      const invalid = !record.value || counts.get(record.value) > 1 || reserved;
      record.input.classList.toggle('is-invalid', invalid);
      record.input.setAttribute('aria-invalid', String(invalid));
      if (!record.value && !firstMessage) firstMessage = `快捷键需要包含 ${shortcutModifierDescription}，再加一个按键。`;
      else if (counts.get(record.value) > 1 && !firstMessage) firstMessage = `“${record.value}”已被其他操作使用。`;
      else if (reserved && !firstMessage) firstMessage = `“${record.value}”是搜索、文献库或标签页的保留快捷键。`;
    });
    const status = $('#shortcut-status');
    if (status && (announce || firstMessage)) {
      status.textContent = firstMessage || '快捷键有效，将自动保存。';
      status.classList.toggle('is-error', Boolean(firstMessage));
    }
    return {
      valid: !firstMessage,
      shortcuts: Object.fromEntries(records.map(({ setting, value }) => [setting, value])),
    };
  }

  shortcutInputs().forEach(({ input, setting }) => {
    input.value = state.shortcuts[setting];
    input.addEventListener('focus', () => {
      input.dataset.previousShortcut = normalizeShortcut(input.value) || input.value;
      input.classList.add('is-capturing');
      input.select();
      const status = $('#shortcut-status');
      if (status) { status.textContent = '请按下新的组合键；按 Escape 保留原设置。'; status.classList.remove('is-error'); }
    });
    input.addEventListener('blur', () => {
      input.classList.remove('is-capturing');
      validateShortcutInputs({ announce: true });
    });
    input.addEventListener('paste', (event) => event.preventDefault());
    input.addEventListener('keydown', (event) => {
      if (event.isComposing || event.keyCode === 229 || event.repeat) return;
      if (event.key === 'Tab') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === 'Escape') {
        input.value = input.dataset.previousShortcut || input.value;
        validateShortcutInputs({ announce: true });
        input.blur();
        return;
      }
      const shortcut = capturedShortcut(event);
      const status = $('#shortcut-status');
      if (!shortcut) {
        if (status && !shortcutModifierTokens.has(String(event.key || '').toLowerCase())) {
          status.textContent = `请同时按住 ${shortcutModifierDescription}。`;
          status.classList.add('is-error');
        }
        return;
      }
      input.value = shortcut;
      const validation = validateShortcutInputs({ announce: true });
      if (validation.valid) queueSettingsSave(true);
      input.select();
    });
  });

  const parsingInstallStates = new Set(['preparing', 'checking', 'downloading', 'verifying', 'publishing', 'installing', 'importing', 'cancelling']);
  let currentLocalMinerUProvider = null;
  let currentRemoteParserProvider = null;
  let currentLocalMinerUCandidates = [];
  let currentLocalMinerUDiscoveryState = 'idle';
  let parsingProvidersRequest = 0;
  let parsingProvidersLoadPromise = null;
  let parsingProvidersLoadedAt = 0;
  let remoteParserConnectionPromise = null;
  let parsingInstallPromise = null;

  function parsingProviderRecords(payload = {}) {
    if (Array.isArray(payload.providers)) return payload.providers;
    if (payload.providers && typeof payload.providers === 'object') {
      return Object.entries(payload.providers).map(([id, provider]) => (
        provider && typeof provider === 'object' ? { id, ...provider } : { id, status: provider }
      ));
    }
    if (payload.provider && typeof payload.provider === 'object') return [payload.provider];
    return payload && typeof payload === 'object' && (payload.id || payload.status || payload.capability)
      ? [payload]
      : [];
  }

  function localMinerUFromPayload(payload = {}) {
    const providers = parsingProviderRecords(payload);
    return providers.find((provider) => {
      const id = String(provider.id || provider.provider_id || provider.name || '').toLowerCase();
      return id === 'local-mineru' || id === 'mineru' || id.includes('mineru');
    }) || providers.find((provider) => String(provider.type || provider.kind || '').toLowerCase() === 'local') || null;
  }

  function parsingInstallation(provider = {}) {
    const component = provider.component && typeof provider.component === 'object' ? provider.component : {};
    return provider.install && typeof provider.install === 'object'
      ? provider.install
      : provider.installation && typeof provider.installation === 'object'
        ? provider.installation
        : component.install && typeof component.install === 'object' ? component.install : provider;
  }

  function parsingProviderStatus(provider = {}) {
    const capability = provider.capability;
    const component = provider.component && typeof provider.component === 'object' ? provider.component : {};
    const raw = capability && typeof capability === 'object'
      ? capability.status || capability.code || capability.reason
      : capability;
    let status = String(raw || provider.status || provider.state || component.status || '').trim().toLowerCase().replaceAll('-', '_');
    if (!status && (capability?.ready === true || capability?.available === true || provider.ready === true)) status = 'ready';
    if (!status && component.installed === true) status = 'ready';
    if (!status && provider.enabled === false) status = 'disabled';
    const aliases = {
      available: 'ready', healthy: 'ready', ok: 'ready', installed: 'ready',
      missing: 'not_installed', unsupported: 'unsupported_platform', checksum_failed: 'checksum_mismatch',
    };
    return aliases[status] || status || 'unknown';
  }

  function parsingInstallStatus(provider = {}) {
    const installation = parsingInstallation(provider);
    return String(installation.status || installation.state || '').trim().toLowerCase().replaceAll('-', '_');
  }

  function parsingRequirements(provider = {}) {
    const capability = provider.capability && typeof provider.capability === 'object' ? provider.capability : {};
    return provider.requirements || capability.requirements || provider.component?.requirements || {};
  }

  function parsingDetails(provider = {}) {
    const capability = provider.capability && typeof provider.capability === 'object' ? provider.capability : {};
    return provider.details || capability.details || parsingInstallation(provider).details || {};
  }

  function parsingErrorCode(provider = {}) {
    const installation = parsingInstallation(provider);
    return String(installation.code || installation.error_code || installation.reason_code || provider.reason_code || parsingProviderStatus(provider) || 'unknown').replaceAll('-', '_');
  }

  function requirementText(provider = {}) {
    const requirements = parsingRequirements(provider);
    const minimumOS = requirements.min_macos || requirements.minimum_macos || requirements.min_os_version || requirements.min_os || '14';
    const memory = Number(requirements.min_memory_bytes || requirements.minimum_memory_bytes || 16 * 1024 ** 3);
    const disk = Number(requirements.required_disk_bytes || requirements.min_free_disk_bytes || requirements.min_disk_bytes || 0);
    return [`macOS ${minimumOS}+`, `${formatBytes(memory)} 内存`, disk > 0 ? `${formatBytes(disk)} 可用空间` : '约 20 GB 可用空间'].join(' · ');
  }

  function actionableParsingMessage(code, details = {}, fallback = '') {
    const messages = {
      not_installed: 'AI 重排需要本地版面引擎。确认系统要求后可一键安装。',
      artifact_unavailable: '未发现可复用的本地版面引擎。你可以扫描本机、选择已有环境，或查看 MinerU 官方安装方式。',
      unsupported_platform: '本地版面引擎首期仅支持 macOS Apple Silicon。',
      unsupported_arch: '本地版面引擎首期仅支持 Apple Silicon Mac。',
      unsupported_os: `系统版本不兼容，需要 macOS ${details.min_macos || details.minimum_macos || '14'} 或更高版本。`,
      incompatible_os: `系统版本不兼容，需要 macOS ${details.required || details.min_os_version || '14'} 或更高版本。`,
      insufficient_memory: `可用内存不足，需要至少 ${formatBytes(details.required_bytes || details.min_memory_bytes || 16 * 1024 ** 3)} 内存。`,
      insufficient_disk: `磁盘空间不足，需要至少 ${formatBytes(details.required_bytes || details.required_disk_bytes || 20 * 1024 ** 3)} 可用空间。`,
      network_error: '下载失败，请检查网络连接后重试。已下载的临时文件不会作为可用组件执行。',
      download_failed: '下载失败，请检查网络连接后重试。已下载的临时文件不会作为可用组件执行。',
      size_mismatch: '组件下载不完整，临时文件已清理，请重新下载。',
      checksum_mismatch: '组件校验失败，未安装任何未校验内容。请重新下载。',
      corrupt: '本地组件不完整或已损坏，请删除后重新安装。',
      component_unhealthy: '本地组件未通过运行检查，请删除后重新安装。',
      signature_verification_failed: '本地组件签名未通过校验，无法安全使用。请重新选择并验证受信任的组件。',
      install_conflict: '组件目录存在未通过校验的内容，请先删除组件再重新安装。',
      remove_failed: '组件卸载失败，受管组件仍保留在原位置，请稍后重试。',
      remove_cleanup_failed: '组件已停止使用，但旧版本临时文件清理失败；谷子学术会在下次检测时重试。',
      cancelled: '安装已取消，临时文件将被清理。',
      disabled: '本地版面引擎已停用，AI 重排当前不可用。',
      not_configured: '解析服务尚未配置。',
      invalid_external_component: '所选 MinerU 环境未通过验证，请确认目录中包含可执行的 bin/mineru 及完整 Python 环境。',
    };
    return messages[code] || fallback || '版面引擎暂不可用，请稍后重试。';
  }

  function renderLocalMinerUProvider(provider = {}, explicitError = null) {
    currentLocalMinerUProvider = provider;
    const card = $('#local-mineru-provider');
    if (!card) return provider;
    const component = provider.component && typeof provider.component === 'object' ? provider.component : {};
    const installation = parsingInstallation(provider);
    const installStatus = parsingInstallStatus(provider);
    const status = explicitError ? 'failed' : (parsingInstallStates.has(installStatus) ? installStatus : parsingProviderStatus(provider));
    const busy = parsingInstallStates.has(status);
    const installed = component.installed === true || provider.installed === true || ['ready', 'update_available', 'corrupt'].includes(parsingProviderStatus(provider));
    const hasUpdate = provider.update_available === true || component.update_available === true || parsingProviderStatus(provider) === 'update_available';
    const statusLabels = {
      ready: '可以使用', update_available: '可更新', not_installed: '未安装', artifact_unavailable: '暂无安装包',
      unsupported_platform: '不兼容', unsupported_arch: '不兼容', unsupported_os: '不兼容', insufficient_memory: '资源不足',
      insufficient_disk: '空间不足', corrupt: '需要修复', signature_verification_failed: '签名无效', failed: '安装失败', cancelled: '已取消', disabled: '已停用',
      preparing: '准备中', checking: '检测中', downloading: '下载中', verifying: '校验中', publishing: '安装中',
      installing: '安装中', importing: '验证中', cancelling: '正在取消', unknown: '状态未知',
    };
    const label = statusLabels[status] || '暂不可用';
    const statusNode = $('#local-mineru-status');
    if (statusNode) {
      statusNode.textContent = label;
      statusNode.className = `ai-service-status ${status === 'ready' ? 'is-ready' : busy ? 'is-loading' : ['not_installed', 'unknown', 'cancelled'].includes(status) ? 'is-unknown' : 'is-unavailable'}`;
    }
    card.classList.remove('is-loading', 'is-ready', 'is-installing', 'is-error', 'is-disabled', 'is-idle');
    card.classList.add(status === 'ready' ? 'is-ready' : busy ? 'is-installing' : ['failed', 'corrupt', 'checksum_mismatch', 'signature_verification_failed', 'invalid_local_component'].includes(status) ? 'is-error' : status === 'disabled' ? 'is-disabled' : 'is-idle');

    const declaredVersion = String(provider.version || '');
    const installedVersion = component.version || provider.installed_version || (installed ? declaredVersion : '');
    const targetVersion = provider.latest_version || provider.target_version || provider.artifact?.version || (!installed ? declaredVersion : '');
    $('#local-mineru-version').textContent = installedVersion
      ? `${provider.external ? installedVersion : `v${installedVersion}`}${hasUpdate && targetVersion ? ` → v${targetVersion}` : ''}`
      : targetVersion && targetVersion !== 'unpublished' ? `待安装 v${targetVersion}` : targetVersion === 'unpublished' ? '尚未发布' : '未安装';
    const diskBytes = Number(component.disk_bytes || component.size_bytes || provider.installed_bytes || provider.disk_bytes || provider.disk_usage_bytes || 0);
    const downloadBytes = Number(provider.artifact?.size_bytes || provider.download_bytes || provider.size_bytes || 0);
    $('#local-mineru-disk').textContent = diskBytes > 0 ? formatBytes(diskBytes) : downloadBytes > 0 ? `预计 ${formatBytes(downloadBytes)}` : '—';
    $('#local-mineru-requirements').textContent = requirementText(provider);

    const progress = $('#local-mineru-install-progress');
    const rawProgress = Number(installation.progress ?? provider.progress ?? provider.install_progress ?? 0);
    const percent = Math.round(Math.max(0, Math.min(100, Number.isFinite(rawProgress) ? (rawProgress <= 1 ? rawProgress * 100 : rawProgress) : 0)));
    progress.hidden = !busy;
    $('#local-mineru-install-stage').textContent = String(installation.stage || installation.message || statusLabels[status] || '正在安装').slice(0, 160);
    $('#local-mineru-install-value').textContent = `${percent}%`;
    $('#local-mineru-install-bar').style.width = `${percent}%`;
    progress.querySelector('[role="progressbar"]')?.setAttribute('aria-valuenow', String(percent));

    const fallback = String(explicitError?.message || installation.error || provider.message || provider.capability?.message || '').slice(0, 300);
    const detailCode = explicitError?.code || parsingErrorCode(provider);
    const cleanupWarning = provider.cleanup_pending
      ? ` 旧版本临时文件仍占用 ${formatBytes(provider.cleanup_pending_bytes || 0)}，谷子学术将在后续检测时重试清理。`
      : '';
    $('#local-mineru-detail').textContent = status === 'ready'
      ? `${provider.external ? provider.source === 'development-toolchain' ? '已复用开发环境 MinerU' : '已复用外部 MinerU' : `本地版面引擎${installedVersion ? ` v${installedVersion}` : ''}`}，已通过能力检测，可用于 AI 重排。${cleanupWarning}`
      : busy ? String(installation.stage || installation.message || '正在准备组件，请保持应用打开。')
        : actionableParsingMessage(detailCode, explicitError?.details || parsingDetails(provider), fallback);

    const installButton = $('#install-local-mineru');
    const cancelButton = $('#cancel-local-mineru-install');
    const removeButton = $('#remove-local-mineru');
    const scanButton = $('#scan-local-mineru');
    const importButton = $('#import-local-mineru');
    const installGuide = $('#local-mineru-install-guide');
    const retryable = ['failed', 'cancelled'].includes(status);
    const blocked = new Set(['artifact_unavailable', 'unsupported_platform', 'unsupported_arch', 'unsupported_os', 'incompatible_os', 'insufficient_memory', 'insufficient_disk', 'disabled']);
    const installable = provider.installable !== false && (provider.can_install !== false || retryable) && !blocked.has(parsingProviderStatus(provider)) && !blocked.has(parsingErrorCode(provider));
    installButton.hidden = busy || (!installable && !hasUpdate) || (status === 'ready' && !hasUpdate);
    installButton.disabled = busy;
    installButton.textContent = hasUpdate ? '更新版面引擎' : ['failed', 'cancelled', 'corrupt'].includes(status) ? '重新安装' : '一键安装版面引擎';
    cancelButton.hidden = !busy || status === 'importing';
    cancelButton.disabled = status === 'cancelling';
    removeButton.hidden = busy || !installed || (provider.external && provider.source === 'development-toolchain');
    removeButton.disabled = busy;
    removeButton.textContent = provider.external ? '停止复用' : '删除组件';
    scanButton.hidden = false;
    scanButton.disabled = busy;
    importButton.hidden = busy || status === 'ready' || !isDesktopApp || provider.can_import === false;
    importButton.disabled = busy;
    const installHelpURL = String(provider.install_help_url || provider.catalog?.install_help_url || '').trim();
    if (installGuide) {
      installGuide.href = installHelpURL.startsWith('https://')
        ? installHelpURL
        : 'https://github.com/opendatalab/MinerU/blob/mineru-3.4.5-released/docs/zh/quick_start/index.md';
      installGuide.hidden = currentLocalMinerUDiscoveryState !== 'empty' || busy || !installButton.hidden;
    }
    return provider;
  }

  function renderRemoteParserProvider(provider = {}) {
    currentRemoteParserProvider = provider;
    const enabled = provider.configured === true;
    const card = $('#remote-parsing-provider');
    if (card) card.className = `parsing-provider-card ${provider.ready ? 'is-ready' : enabled ? 'is-error' : 'is-disabled'}`;
    const status = $('#remote-parsing-status');
    if (status) {
      status.textContent = provider.ready ? '已连接' : enabled ? '连接不可用' : '未配置';
      status.className = `ai-service-status ${provider.ready ? 'is-ready' : 'is-unavailable'}`;
    }
    const detail = $('#remote-parsing-detail');
    if (detail) detail.textContent = provider.message || '在当前设备的私有配置中填写远端连接信息后即可启用。';
    const version = $('#remote-parsing-version');
    if (version) version.textContent = [typeof provider.engine === 'string' ? provider.engine : provider.engine?.name, provider.version].filter(Boolean).join(' · ') || '—';
    $('#connect-remote-parser')?.toggleAttribute('disabled', !enabled);
    $('#disconnect-remote-parser')?.toggleAttribute('disabled', !enabled || !provider.ready);
    $('#local-mineru-provider')?.toggleAttribute('hidden', enabled);
    const backend = $('#setting-parsing-backend')?.closest('label');
    if (backend) backend.hidden = enabled;
    if (enabled) $('#setting-parsing-server-field')?.setAttribute('hidden', '');
  }

  async function fetchParsingProviders({ render = true } = {}) {
    const request = parsingProvidersRequest;
    const payload = await api('/api/parsing/providers');
    const remote = parsingProviderRecords(payload).find((provider) => provider.id === 'remote-guzi') || {};
    const provider = remote.configured === true ? remote : localMinerUFromPayload(payload) || { id: 'local-mineru', status: 'artifact_unavailable' };
    if (render && request === parsingProvidersRequest) {
      renderRemoteParserProvider(remote);
      if (provider.id !== 'remote-guzi') renderLocalMinerUProvider(provider);
    }
    return provider;
  }

  async function changeRemoteParserConnection(action) {
    if (remoteParserConnectionPromise) return remoteParserConnectionPromise;
    const request = ++parsingProvidersRequest;
    parsingProvidersLoadedAt = 0;
    const operation = (async () => {
      try {
        const payload = await api(`/api/parsing/providers/remote-guzi/${action}`, { method: 'POST' });
        if (request === parsingProvidersRequest) {
          renderRemoteParserProvider(payload.provider || {});
          parsingProvidersLoadedAt = Date.now();
        }
      } catch (error) { showToast(error.message, true); }
    })();
    remoteParserConnectionPromise = operation;
    try { return await operation; }
    finally { remoteParserConnectionPromise = null; }
  }
  $('#connect-remote-parser')?.addEventListener('click', () => { void changeRemoteParserConnection('connect'); });
  $('#disconnect-remote-parser')?.addEventListener('click', () => { void changeRemoteParserConnection('disconnect'); });

  async function monitorParsingInstall() {
    let failures = 0;
    while (true) {
      await new Promise((resolve) => window.setTimeout(resolve, 700));
      try {
        const provider = await fetchParsingProviders();
        failures = 0;
        if (!parsingInstallStates.has(parsingInstallStatus(provider))) return provider;
      } catch (error) {
        failures += 1;
        if (failures >= 3) {
          renderLocalMinerUProvider(currentLocalMinerUProvider || { status: 'failed' }, error);
          throw error;
        }
      }
    }
  }

  async function loadParsingProviders({ refresh = false } = {}) {
    if (remoteParserConnectionPromise) await remoteParserConnectionPromise;
    if (!refresh && Date.now() - parsingProvidersLoadedAt < 30000) return currentRemoteParserProvider?.configured ? currentRemoteParserProvider : currentLocalMinerUProvider;
    if (!refresh && parsingProvidersLoadPromise) return parsingProvidersLoadPromise;
    const operation = readParsingProviders();
    parsingProvidersLoadPromise = operation;
    try { return await operation; }
    finally { if (parsingProvidersLoadPromise === operation) parsingProvidersLoadPromise = null; }
  }

  async function readParsingProviders() {
    const request = ++parsingProvidersRequest;
    try {
      const provider = await fetchParsingProviders();
      if (request !== parsingProvidersRequest) return provider;
      parsingProvidersLoadedAt = Date.now();
      if (parsingInstallStates.has(parsingInstallStatus(provider)) && !parsingInstallPromise) {
        parsingInstallPromise = monitorParsingInstall().finally(() => { parsingInstallPromise = null; });
        void parsingInstallPromise.catch(() => {});
      }
      return provider;
    } catch (error) {
      if (request === parsingProvidersRequest) renderLocalMinerUProvider(currentLocalMinerUProvider || { status: 'failed' }, error);
      return null;
    }
  }

  function parsingInstallPrompt(provider = {}) {
    const artifactBytes = Number(provider.artifact?.size_bytes || provider.download_bytes || provider.size_bytes || 0);
    const requirements = requirementText(provider);
    return `版面引擎仅用于高级 AI 重排，文献不会上传。${artifactBytes > 0 ? `需要下载约 ${formatBytes(artifactBytes)}。` : ''}系统要求：${requirements}。确认后开始下载吗？`;
  }

  async function installLocalMinerU(provider = currentLocalMinerUProvider, { skipConfirmation = false } = {}) {
    if (parsingInstallPromise) return parsingInstallPromise;
    const selected = provider || await fetchParsingProviders();
    if (!skipConfirmation && !await requestConfirmation(parsingInstallPrompt(selected), '安装本地版面引擎？')) return null;
    renderLocalMinerUDiscovery();
    const optimistic = { ...selected, install: { ...parsingInstallation(selected), status: 'preparing', progress: 0, stage: '正在检查系统与磁盘空间' } };
    renderLocalMinerUProvider(optimistic);
    const operation = (async () => {
      try {
        const accepted = await api('/api/parsing/providers/local-mineru/install', { method: 'POST' });
        const acceptedProvider = localMinerUFromPayload(accepted);
        if (acceptedProvider) renderLocalMinerUProvider(acceptedProvider);
        const completed = acceptedProvider && !parsingInstallStates.has(parsingInstallStatus(acceptedProvider))
          ? acceptedProvider
          : await monitorParsingInstall();
        if (parsingProviderStatus(completed) === 'ready') showToast('版面引擎安装完成。');
        return completed;
      } catch (error) {
        const failed = {
          ...(currentLocalMinerUProvider || selected),
          state: 'failed', reason_code: error.code || 'install_failed', ready: false,
          error: error.message, details: error.details || {},
        };
        renderLocalMinerUProvider(failed, error);
        return failed;
      }
    })();
    parsingInstallPromise = operation.finally(() => { parsingInstallPromise = null; });
    return parsingInstallPromise;
  }

  async function cancelLocalMinerUInstall() {
    const provider = currentLocalMinerUProvider || {};
    renderLocalMinerUProvider({ ...provider, install: { ...parsingInstallation(provider), status: 'cancelling', stage: '正在取消下载并清理临时文件' } });
    try {
      const payload = await api('/api/parsing/providers/local-mineru/install/cancel', { method: 'POST' });
      if (parsingInstallPromise) await parsingInstallPromise;
      else renderLocalMinerUProvider(localMinerUFromPayload(payload) || await fetchParsingProviders({ render: false }));
    } catch (error) {
      renderLocalMinerUProvider(currentLocalMinerUProvider || provider, error);
    }
  }

  function parsingDiscoveryCandidates(payload = {}) {
    const records = payload.candidates || payload.discovery?.candidates || payload.discovered || [];
    return Array.isArray(records) ? records.filter((candidate) => candidate && typeof candidate === 'object') : [];
  }

  function parsingDiscoveryCandidatePath(candidate = {}) {
    return String(candidate.executable || candidate.runtime_root || candidate.path || candidate.root || '').trim();
  }

  function parsingDiscoveryCandidateLabel(candidate = {}) {
    const sourceLabels = {
      path: '系统 PATH', homebrew: 'Homebrew', conda: 'Conda', virtualenv: 'Python 虚拟环境',
      'development-toolchain': '开发工具链', 'user-selected': '用户目录', external: '外部环境',
    };
    const version = String(candidate.version || '').trim();
    const source = String(candidate.source || '').trim().toLowerCase();
    return [version, sourceLabels[source] || candidate.source || '本机环境'].filter(Boolean).join(' · ');
  }

  function renderLocalMinerUDiscovery({ state = 'idle', candidates = [], message = '' } = {}) {
    const container = $('#local-mineru-discovery');
    if (!container) return;
    currentLocalMinerUDiscoveryState = state;
    currentLocalMinerUCandidates = [...candidates];
    container.replaceChildren();
    container.hidden = state === 'idle';
    const installGuide = $('#local-mineru-install-guide');
    if (installGuide) installGuide.hidden = state !== 'empty' || !$('#install-local-mineru')?.hidden;
    if (state === 'idle') return;

    const addRecord = (title, detail, buttonText = '', candidateIndex = -1) => {
      const record = document.createElement('div');
      record.className = 'metadata-candidate';
      record.setAttribute('role', 'listitem');
      const heading = document.createElement('strong');
      heading.textContent = title;
      const description = document.createElement('span');
      description.textContent = detail ? ` · ${detail}` : '';
      record.append(heading, description);
      if (buttonText) {
        const button = document.createElement('button');
        button.className = 'secondary-button compact-button';
        button.type = 'button';
        button.dataset.reuseMineruCandidate = String(candidateIndex);
        button.textContent = buttonText;
        record.append(button);
      }
      container.append(record);
    };

    if (state === 'scanning') {
      addRecord('正在扫描本机', message || '正在验证可执行文件和 Python 环境');
      return;
    }
    if (state === 'empty') {
      addRecord('未扫描到可复用的 MinerU', message || ($('#install-local-mineru')?.hidden
        ? '可手动选择已有环境，或查看 MinerU 官方安装方式'
        : '可手动选择已有环境，或让谷子学术一键安装版面引擎'));
      return;
    }
    if (state === 'reused') {
      const candidate = candidates[0] || {};
      addRecord('已自动复用本机版面引擎', [parsingDiscoveryCandidateLabel(candidate), parsingDiscoveryCandidatePath(candidate)].filter(Boolean).join(' · '));
      return;
    }
    candidates.forEach((candidate, index) => {
      addRecord(
        parsingDiscoveryCandidatePath(candidate) || `MinerU 候选 ${index + 1}`,
        parsingDiscoveryCandidateLabel(candidate),
        '复用此环境',
        index,
      );
    });
  }

  async function reuseLocalMinerUPath(path, { candidate = null, automatic = false } = {}) {
    if (!path) throw new Error('版面引擎路径为空，无法验证。');
    const provider = currentLocalMinerUProvider || {};
    renderLocalMinerUProvider({ ...provider, state: 'importing', reason_code: 'importing', install: { status: 'importing', stage: '正在验证已有版面引擎', progress: 0 } });
    try {
      const accepted = await api('/api/parsing/providers/local-mineru/select', jsonOptions({ path }));
      const completed = localMinerUFromPayload(accepted);
      if (completed) renderLocalMinerUProvider(completed);
      if (parsingProviderStatus(completed) === 'ready') {
        if (candidate) renderLocalMinerUDiscovery({ state: 'reused', candidates: [candidate] });
        else renderLocalMinerUDiscovery();
        showToast(automatic ? '已扫描并自动复用本机版面引擎。' : '已有版面引擎已复用并通过验证。');
      } else {
        renderLocalMinerUProvider(completed || provider);
      }
      return completed;
    } catch (error) {
      renderLocalMinerUProvider(currentLocalMinerUProvider || provider, error);
      throw error;
    }
  }

  async function scanLocalMinerU() {
    const button = $('#scan-local-mineru');
    if (button) button.disabled = true;
    renderLocalMinerUDiscovery({ state: 'scanning' });
    try {
      const payload = await api('/api/parsing/providers/local-mineru/discover', { method: 'POST' });
      const candidates = parsingDiscoveryCandidates(payload);
      let provider = localMinerUFromPayload(payload);
      if (provider) renderLocalMinerUProvider(provider);
      if (!candidates.length) {
        renderLocalMinerUDiscovery({ state: 'empty' });
        showToast($('#install-local-mineru')?.hidden
          ? '未扫描到可复用的本地版面引擎，可手动选择已有环境或查看官方安装方式。'
          : '未扫描到可复用的本地版面引擎，可手动选择已有环境或使用一键安装。', true);
        return;
      }
      if (candidates.length === 1) {
        if (parsingProviderStatus(provider || {}) !== 'ready') {
          provider = await reuseLocalMinerUPath(parsingDiscoveryCandidatePath(candidates[0]), { candidate: candidates[0], automatic: true });
        } else {
          renderLocalMinerUDiscovery({ state: 'reused', candidates });
          showToast('已扫描并自动复用本机版面引擎。');
        }
        if (parsingProviderStatus(provider || {}) !== 'ready') renderLocalMinerUDiscovery({ state: 'candidates', candidates });
        return;
      }
      renderLocalMinerUDiscovery({ state: 'candidates', candidates });
      showToast(`扫描到 ${candidates.length} 个可复用环境，请选择一个。`);
    } catch (error) {
      renderLocalMinerUProvider(currentLocalMinerUProvider || {}, error);
      renderLocalMinerUDiscovery({ state: 'empty', message: error.message || '扫描失败，可手动选择已有环境或使用一键安装' });
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function importLocalMinerU() {
    const desktop = window.myScholarDesktop;
    if (typeof desktop?.chooseMineruComponent !== 'function') {
      showToast('请在谷子学术桌面客户端中选择已有版面引擎。', true);
      return;
    }
    let selection;
    try {
      selection = await desktop.chooseMineruComponent();
    } catch (error) {
      showToast(error.message || '无法打开版面引擎目录选择器。', true);
      return;
    }
    if (!selection?.ok || selection.cancelled || !selection.path) return;
    try {
      await reuseLocalMinerUPath(selection.path);
    } catch (error) {
      showToast(error.message || '所选版面引擎未通过验证。', true);
    }
  }

  async function removeLocalMinerU() {
    const external = currentLocalMinerUProvider?.external === true;
    const message = external
      ? '停止复用当前外部 MinerU？谷子学术只会删除保存的路径，不会删除你的 Python 环境、模型或文献。'
      : '删除谷子学术管理的本地版面引擎及模型？已有文献和基础阅读功能不会受影响。';
    if (!await requestConfirmation(message, external ? '停止复用外部 MinerU？' : '删除本地版面引擎？')) return;
    const button = $('#remove-local-mineru');
    button.disabled = true;
    try {
      const payload = await api('/api/parsing/providers/local-mineru/component', { method: 'DELETE' });
      renderLocalMinerUProvider(localMinerUFromPayload(payload) || await fetchParsingProviders({ render: false }));
      renderLocalMinerUDiscovery();
      showToast(external ? '已停止复用外部 MinerU，原环境未删除。' : '本地版面引擎已删除。');
    } catch (error) {
      renderLocalMinerUProvider(currentLocalMinerUProvider || {}, error);
    } finally {
      button.disabled = false;
    }
  }

  $('#scan-local-mineru')?.addEventListener('click', () => { void scanLocalMinerU(); });
  $('#import-local-mineru')?.addEventListener('click', () => { void importLocalMinerU(); });
  $('#local-mineru-discovery')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-reuse-mineru-candidate]');
    if (!button) return;
    const index = Number(button.dataset.reuseMineruCandidate);
    const candidate = currentLocalMinerUCandidates[index];
    const path = parsingDiscoveryCandidatePath(candidate);
    if (!candidate || !path) {
      showToast('该候选环境缺少可验证的路径。', true);
      return;
    }
    currentLocalMinerUCandidates.forEach((_item, candidateIndex) => {
      const candidateButton = $(`[data-reuse-mineru-candidate="${candidateIndex}"]`);
      if (candidateButton) candidateButton.disabled = true;
    });
    void reuseLocalMinerUPath(path, { candidate }).catch((error) => {
      renderLocalMinerUDiscovery({ state: 'candidates', candidates: currentLocalMinerUCandidates });
      showToast(error.message || '所选版面引擎未通过验证。', true);
    });
  });
  $('#install-local-mineru')?.addEventListener('click', () => { void installLocalMinerU(); });
  $('#cancel-local-mineru-install')?.addEventListener('click', () => { void cancelLocalMinerUInstall(); });
  $('#remove-local-mineru')?.addEventListener('click', () => { void removeLocalMinerU(); });

  async function loadSettings({ refresh = false } = {}) {
    if (!refresh && settingsLoadInFlight) return settingsLoadInFlight;
    if (!refresh && Date.now() - settingsLoadedAt < 30000) return flushPendingSettings();
    const operation = readSettings().then((loaded) => {
      if (loaded) settingsLoadedAt = Date.now();
      return loaded;
    });
    settingsLoadInFlight = operation;
    try { return await operation; }
    finally { if (settingsLoadInFlight === operation) settingsLoadInFlight = null; }
  }

  async function readSettings() {
    loadLibraryLocation();
    loadAppInfo();
    const generation = ++settingsLoadGeneration;
    try {
      if (!await flushPendingSettings()) return false;
      const revision = settingsSaveRevision;
      const settings = await api('/api/settings');
      if (generation !== settingsLoadGeneration || revision !== settingsSaveRevision || settingsSavedRevision < settingsSaveRevision) return false;
      const renderKey = JSON.stringify(settings);
      if (settingsRenderedKey === renderKey) return true;
      aiStatusHistoryRecords = Array.isArray(settings.ai_status_history)
        ? settings.ai_status_history.map((record) => sanitizeAIStatusRecord(record?.results, record?.checkedAt))
        : [];
      aiStatusHistoryPage = 0;
      renderAISettings(settings.ai || {});
      state.annotationActions = normalizeAnnotationActions(settings.annotation_actions);
      renderAnnotationActionSettings();
      renderSelectionActions();
      renderAIServiceCards(state.health?.ai?.services || settings.ai_services || {});
      const metadata = settings.metadata || {};
      state.metadataAutoRetrieve = metadata.auto_retrieve !== false;
      if (!state.metadataAutoRetrieve) cancelImportMetadataFollowup();
      if ($('#setting-metadata-auto')) $('#setting-metadata-auto').checked = metadata.auto_retrieve !== false;
      if ($('#setting-metadata-online')) $('#setting-metadata-online').checked = metadata.online_lookup !== false;
      if ($('#setting-metadata-email')) $('#setting-metadata-email').value = metadata.contact_email || '';
      const parsingBackend = settings.parsing?.backend || 'pipeline';
      if ($('#setting-parsing-backend')) $('#setting-parsing-backend').value = parsingBackend;
      if ($('#setting-parsing-server-url')) $('#setting-parsing-server-url').value = settings.parsing?.server_url || '';
      syncParsingServerField();
      const shortcuts = settings.shortcuts || {};
      const normalizedShortcuts = normalizedShortcutSettings(shortcuts);
      state.shortcuts = { ...state.shortcuts, ...normalizedShortcuts };
      shortcutInputs().forEach(({ input, setting }) => { input.value = state.shortcuts[setting]; });
      syncReaderShortcutHints();
      state.highlightColor = normalizeHexColor(settings.highlight_color, state.highlightColor);
      state.annotationColors = {
        highlight: normalizeAnnotationColor(settings.annotation_colors?.highlight),
        underline: normalizeAnnotationColor(settings.annotation_colors?.underline),
      };
      state.appearance = normalizeAppearance(settings.appearance, appearanceDefaults);
      state.pendingAppearance = { ...state.appearance };
      renderAppearanceControls();
      clearAppearancePreview();
      applyAppearance();
      applyHighlightColor();
      validateShortcutInputs();
      settingsSavedRevision = Math.max(settingsSavedRevision, revision);
      setSettingsSaveStatus('已保存', 'saved');
      settingsRenderedKey = renderKey;
      return true;
    } catch (error) {
      showToast(`设置读取失败：${error.message}`, true);
      return false;
    }
  }

  function syncParsingServerField() {
    const field = $('#setting-parsing-server-field');
    const select = $('#setting-parsing-backend');
    if (!field || !select) return;
    field.hidden = !String(select.value || '').endsWith('-http-client');
  }

  function settingsPayload() {
    const shortcutValidation = validateShortcutInputs();
    if (browserDemo) return {
      annotation_actions: state.annotationActions,
      shortcuts: shortcutValidation.shortcuts,
      appearance: appearanceFromControls(),
    };
    return {
      ai: aiSettingsFromControls(),
      annotation_actions: state.annotationActions,
      shortcuts: shortcutValidation.shortcuts,
      appearance: appearanceFromControls(),
      metadata: {
        auto_retrieve: Boolean($('#setting-metadata-auto')?.checked),
        online_lookup: Boolean($('#setting-metadata-online')?.checked),
        contact_email: $('#setting-metadata-email')?.value.trim() || '',
      },
      parsing: {
        backend: $('#setting-parsing-backend')?.value || 'pipeline',
        server_url: $('#setting-parsing-server-url')?.value.trim() || '',
      },
    };
  }

  // Settings apply immediately (macOS-style), but writes stay serialized so a
  // slower response can never overwrite a newer edit.
  let settingsSaveTimer = null;
  let settingsSaveRevision = 0;
  let settingsSavedRevision = 0;
  let settingsSaveInFlight = null;
  let settingsSaveRequested = false;
  let settingsExitFlushedRevision = -1;
  let settingsLoadGeneration = 0;
  let settingsLoadInFlight = null;
  let settingsLoadedAt = 0;
  let settingsRenderedKey = null;
  function setSettingsSaveStatus(message, stateName = 'saved') {
    const status = $('#settings-save-status');
    if (!status) return;
    status.textContent = message;
    status.dataset.state = stateName;
  }
  async function persistSettings() {
    if (browserDemo?.invalidated) return false;
    const invalidAction = state.annotationActions.custom.find((item) => !item.label.trim());
    if (invalidAction) {
      setSettingsSaveStatus('语义标记名称不能为空', 'error');
      return false;
    }
    window.clearTimeout(settingsSaveTimer);
    settingsSaveTimer = null;
    const shortcutValidation = validateShortcutInputs();
    if (!shortcutValidation.valid) {
      setSettingsSaveStatus('快捷键设置有误', 'error');
      return false;
    }
    if (settingsSaveInFlight) {
      settingsSaveRequested = true;
      return settingsSaveInFlight;
    }
    const revision = settingsSaveRevision;
    if (!browserDemo && !validateAISettingsControls()) { setSettingsSaveStatus('请检查 AI 选项', 'error'); return false; }
    const submitted = settingsPayload();
    settingsSaveRequested = false;
    setSettingsSaveStatus('正在保存…', 'saving');
    const operation = (async () => {
      try {
        const response = await api('/api/settings', { ...jsonOptions(submitted), closeSave: true });
        applyAnnotationActionSync(response?.settings?.annotation_style_sync);
        settingsSavedRevision = Math.max(settingsSavedRevision, revision);
        if (revision === settingsSaveRevision) {
          settingsLoadedAt = Date.now();
          state.appearance = normalizeAppearance(response?.settings?.appearance || submitted.appearance, submitted.appearance);
          state.shortcuts = { ...state.shortcuts, ...(response?.settings?.shortcuts || submitted.shortcuts) };
          syncReaderShortcutHints();
          if (!browserDemo) state.metadataAutoRetrieve = (response?.settings?.metadata || submitted.metadata).auto_retrieve !== false;
          renderAISettings(response?.settings?.ai || submitted.ai);
          state.annotationActions = normalizeAnnotationActions(response?.settings?.annotation_actions || submitted.annotation_actions);
          renderSelectionActions();
          if (!state.metadataAutoRetrieve) cancelImportMetadataFollowup();
          state.pendingAppearance = { ...state.appearance };
          applyAppearance();
          setSettingsSaveStatus('已保存', 'saved');
        } else {
          setSettingsSaveStatus('正在等待保存…', 'pending');
        }
        if (!request.closeGate) void checkHealth();
        return true;
      } catch (error) {
        if (revision === settingsSaveRevision) setSettingsSaveStatus('保存失败', 'error');
        showToast(`设置保存失败：${error.message}`, true);
        return false;
      }
    })();
    settingsSaveInFlight = operation;
    try {
      return await operation;
    } finally {
      settingsSaveInFlight = null;
      if (settingsSaveRequested && !request.closeGate) {
        settingsSaveRequested = false;
        void persistSettings();
      }
    }
  }
  async function flushPendingSettings({ isCurrent = () => true } = {}) {
    while (settingsSavedRevision < settingsSaveRevision) {
      if (!isCurrent()) return false;
      const targetRevision = settingsSaveRevision;
      if (!await persistSettings()) return false;
      if (settingsSavedRevision < targetRevision && !settingsSaveInFlight && !settingsSaveRequested) return false;
    }
    return true;
  }
  function queueSettingsSave(immediate = false) {
    if (request.closeGate) return;
    settingsRenderedKey = null;
    settingsSaveRevision += 1;
    settingsExitFlushedRevision = -1;
    setSettingsSaveStatus(immediate ? '正在保存…' : '正在等待保存…', immediate ? 'saving' : 'pending');
    window.clearTimeout(settingsSaveTimer);
    settingsSaveTimer = null;
    if (settingsSaveInFlight) {
      settingsSaveRequested = true;
      return;
    }
    settingsSaveTimer = window.setTimeout(() => { settingsSaveTimer = null; void persistSettings(); }, immediate ? 0 : 600);
  }
  function flushSettingsOnExit() {
    if (request.closeGate) return;
    if (settingsExitFlushedRevision === settingsSaveRevision || settingsSavedRevision >= settingsSaveRevision) return;
    const validation = validateShortcutInputs();
    if (demoResetting || browserDemo?.invalidated || !validation.valid || (!browserDemo && !validateAISettingsControls())) return;
    window.clearTimeout(settingsSaveTimer);
    settingsSaveTimer = null;
    settingsExitFlushedRevision = settingsSaveRevision;
    request('/api/settings', { ...jsonOptions(settingsPayload()), keepalive: true }).catch(() => {});
  }
  $('#settings-form').addEventListener('submit', (event) => event.preventDefault());
  $('#settings-form').addEventListener('change', (event) => {
    if (browserDemo?.invalidated) return;
    if (event.target.closest('.shortcut-grid, #settings-mcp')) return;
    if (event.target.id.endsWith('-reasoning-effort') && event.target.value === 'custom') return;
    if (event.target.id === 'setting-parsing-backend') syncParsingServerField();
    queueSettingsSave(true);
  });
  $('#settings-form').addEventListener('input', (event) => {
    if (browserDemo?.invalidated) return;
    if (event.target.closest('.shortcut-grid, #settings-mcp')) return;
    if (event.target.matches('input[type="text"], input[type="email"], input[type="url"], input[type="password"], input[type="number"]')) queueSettingsSave(false);
  });
  document.addEventListener('visibilitychange', () => {
    if (browserDemo?.invalidated) return;
    if (document.visibilityState !== 'hidden' || settingsSavedRevision >= settingsSaveRevision) return;
    if (settingsSaveInFlight) settingsSaveRequested = true;
    else void persistSettings();
  });
  window.addEventListener('beforeunload', () => {
    if (browserDemo?.invalidated) return;
    captureCurrentReadingLocation();
    flushSettingsOnExit();
  });
  function freezeForClose() {
    if (request.closeGate) return request.closeGate;
    let wake;
    const surfaces = [...new Set([document, frameDocument()].filter(Boolean))].map((doc) => ({ doc, inert: doc.body?.inert }));
    const gate = { allowSave: true, surfaces, pendingWrites: [...request.inFlightWrites], annotationWrites: annotationOperations.capturePendingWrites(), changed: new Promise((resolve) => { wake = resolve; }) };
    gate.wake = () => {
      wake();
      gate.changed = new Promise((resolve) => { wake = resolve; });
    };
    gate.blockInput = (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    request.closeGate = gate;
    for (const { doc } of gate.surfaces) {
      if (doc.body) doc.body.inert = true;
      for (const type of ['beforeinput', 'input', 'change', 'click', 'submit', 'keydown', 'paste', 'drop']) doc.defaultView.addEventListener(type, gate.blockInput, true);
    }
    window.clearTimeout(notesTimer);
    notesTimer = null;
    window.clearTimeout(settingsSaveTimer);
    settingsSaveTimer = null;
    pausePersistentStateWrites();
    return gate;
  }
  window.__myScholarResumeAfterClose = () => {
    const gate = request.closeGate;
    if (!gate) return true;
    request.closeGate = null;
    for (const { doc, inert } of gate.surfaces) {
      if (doc.body) doc.body.inert = inert;
      for (const type of ['beforeinput', 'input', 'change', 'click', 'submit', 'keydown', 'paste', 'drop']) doc.defaultView.removeEventListener(type, gate.blockInput, true);
    }
    resumePersistentStateWrites();
    gate.wake();
    if (pendingNotesSnapshot) notesTimer = window.setTimeout(() => { void flushPendingArticleNotes(); }, 1200);
    if (settingsSavedRevision < settingsSaveRevision) settingsSaveTimer = window.setTimeout(() => { void persistSettings(); }, 600);
    return true;
  };
  window.__myScholarFlushBeforeClose = async ({ intent = 'close', discard = false } = {}) => {
    if (browserDemo?.invalidated) return false;
    if (!['close', 'quit', 'install-update'].includes(intent)) return false;
    const gate = freezeForClose();
    if (gate.operation) return gate.operation;
    gate.allowSave = !discard;
    gate.wake();
    gate.operation = (async () => {
      let saved = true;
      const isCurrent = () => request.closeGate === gate;
      try {
        captureCurrentReadingLocation({ forClose: true });
        const pendingWrites = await Promise.allSettled(gate.pendingWrites);
        if (!isCurrent()) return false;
        if (!discard && pendingWrites.some((result) => result.status !== 'fulfilled' || result.value?.ok !== true)) saved = false;
        if (!discard) {
          const annotationWritesSaved = await annotationOperations.waitForPendingWrites(gate.annotationWrites);
          if (!isCurrent()) return false;
          if (!annotationWritesSaved) saved = false;
          if (await flushPendingArticleNotes(null, { isCurrent }) !== true) saved = false;
          if (!isCurrent()) return false;
          if (await flushPendingSettings({ isCurrent }) !== true || settingsSavedRevision < settingsSaveRevision) saved = false;
          if (!isCurrent()) return false;
        }
        if (flushPendingChatSessions() !== true) saved = false;
      } catch (_error) { saved = false; }
      try { if (await flushPersistentStateWrites() !== true) saved = false; }
      catch (_error) { saved = false; }
      if (!isCurrent()) return false;
      gate.allowSave = false;
      return saved;
    })();
    try { return await gate.operation; }
    finally { gate.operation = null; }
  };

  $('#setting-app-font')?.addEventListener('change', previewAppearanceFromControls);
  $('#setting-reader-font')?.addEventListener('change', previewAppearanceFromControls);
  $$('input[name="setting-accent"]').forEach((input) => input.addEventListener('change', previewAppearanceFromControls));

  $$('[data-ai-models]').forEach((button) => {
    button.addEventListener('click', () => queryAIModels(button.dataset.aiModels));
  });
  $$('[data-ai-reuse-source]').forEach((button) => {
    button.addEventListener('click', () => reuseAIProfile(button.dataset.aiReuseSource, button.dataset.aiReuseTarget, button));
  });
  $$('[data-ai-clear-key]').forEach((button) => {
    button.addEventListener('click', () => clearSavedAIKey(button.dataset.aiClearKey, button));
  });
  $$('[id$="-model-filter"]').forEach((input) => {
    const service = input.id.replace(/^setting-(translation|chat)-model-filter$/u, '$1');
    input.addEventListener('input', () => renderAIModelList(service));
  });
  $$('[id$="-model-list"]').forEach((select) => {
    const service = select.id.replace(/^setting-(translation|chat)-model-list$/u, '$1');
    select.addEventListener('change', () => {
      if (!select.value) return;
      const model = $(`#setting-${service}-model`);
      if (model) {
        model.value = select.value;
        renderAIInferenceControls(service);
      }
    });
  });
  for (const service of ['translation', 'chat']) {
    const prefix = `setting-${service}`;
    for (const field of ['model', 'base-url', 'api-format', 'mode', 'provider', 'thinking-budget', 'context-window']) {
      $(`#${prefix}-${field}`)?.addEventListener('change', () => renderAIInferenceControls(service));
    }
    $(`#${prefix}-reasoning-effort`)?.addEventListener('change', (event) => {
      const custom = event.target.value === 'custom';
      $(`#${prefix}-reasoning-custom-field`).hidden = !custom;
      if (custom) $(`#${prefix}-reasoning-custom`).focus();
      else renderAIInferenceControls(service);
    });
    $(`#${prefix}-reasoning-custom`)?.addEventListener('change', () => renderAIInferenceControls(service));
  }
  $('#chat-reasoning-effort')?.addEventListener('change', (event) => {
    const custom = event.target.value === 'custom';
    $('#chat-reasoning-custom-field').hidden = !custom;
    if (custom) $('#chat-reasoning-custom').focus();
    else updateChatOptions();
  });
  for (const id of ['chat-reasoning-custom', 'chat-thinking-mode', 'chat-thinking-budget', 'chat-context-mode', 'chat-context-window']) {
    $(`#${id}`)?.addEventListener('change', updateChatOptions);
  }
  $('#ai-status-history-prev')?.addEventListener('click', () => {
    aiStatusHistoryPage = Math.max(0, aiStatusHistoryPage - 1);
    renderAIStatusHistory();
  });
  $('#ai-status-history-next')?.addEventListener('click', () => {
    const pageCount = Math.max(1, Math.ceil(readAIStatusHistory().length / aiStatusHistoryPageSize));
    aiStatusHistoryPage = Math.min(pageCount - 1, aiStatusHistoryPage + 1);
    renderAIStatusHistory();
  });

  $('#setting-translation-provider')?.addEventListener('change', () => {
    $('#setting-translation-api-key').value = '';
    $('#setting-translation-api-key').placeholder = '为当前提供商输入密钥';
    $('#setting-translation-clear-key').disabled = true;
    syncTranslationProviderControls();
  });
  $$('[data-translation-clear-secret]').forEach((button) => button.addEventListener('click', () => {
    const name = button.dataset.translationClearSecret;
    $(`#setting-translation-${name.replaceAll('_', '-')}`).value = '';
    button.dataset.clearRequested = 'true';
    button.disabled = true;
    queueSettingsSave(true);
  }));
  $('#test-translation-button')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const result = $('#translation-provider-test-result');
    button.disabled = true;
    result.textContent = '正在检测…';
    try {
      if (!await flushPendingSettings()) throw new Error('请先解决未保存的设置。');
      const payload = await api('/api/translation/test', jsonOptions({}));
      const test = payload.result || {};
      result.textContent = test.ok ? `连接成功 · ${Math.round(Number(test.elapsed_ms) || 0)} ms` : `检测失败：${test.error || '服务无响应'}`;
    } catch (error) { result.textContent = `检测失败：${error.message}`; }
    finally { button.disabled = false; }
  });

  $('#test-ai-button').addEventListener('click', async () => {
    const button = $('#test-ai-button');
    button.disabled = true;
    button.textContent = '正在检测…';
    const overview = $('#ai-status-overview');
    overview?.classList.remove('is-operational', 'is-partial', 'is-outage');
    overview?.classList.add('is-unknown');
    $('#ai-status-overview-title').textContent = '正在检测服务';
    $('#ai-status-overview-detail').textContent = '正在分别连接翻译服务与文章助手…';
    $('#ai-status-overview-time').textContent = '请稍候';
    Object.keys(aiServiceNames).forEach((service) => {
      const status = $(`#setting-${service}-status`);
      if (status) { status.textContent = '检测中'; status.className = 'ai-service-status is-loading'; }
    });
    try {
      const payload = await api('/api/ai/test', { method: 'POST' });
      const results = aiTestResults(payload);
      const translationOK = aiConnectionSucceeded(results.translation);
      const chatOK = aiConnectionSucceeded(results.chat);
      rememberAIStatus(results, payload.record);
      showToast(translationOK && chatOK ? '两项服务连接正常。' : '连接测试完成，部分服务暂不可用。', !(translationOK && chatOK));
      await checkHealth();
      renderAIServiceCards(state.health?.ai?.services || {});
    } catch (error) {
      rememberAIStatus(Object.fromEntries(Object.keys(aiServiceNames).map((service) => [service, { ok: false, error: error.message || '连接失败' }])));
      showToast(error.message, true);
    } finally {
      button.disabled = false;
      button.textContent = '立即检测';
    }
  });

  $('#full-translate-button').addEventListener('click', () => {
    runFullTranslation({ refresh: true });
  });
  $('#full-translate-scope-button')?.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleTranslationScopeMenu(event.currentTarget);
  });
  $$('#translation-scope-menu [data-translation-scope]').forEach((item) => item.addEventListener('click', () => {
    const scope = item.dataset.translationScope === 'body' ? 'body' : 'all';
    closeTranslationScopeMenu();
    setTranslationScope(scope);
    runFullTranslation({ refresh: true, scope });
  }));
  $$('#translation-scope-menu [data-translation-display]').forEach((item) => item.addEventListener('click', () => {
    setTranslationPreferences({ displayMode: item.dataset.translationDisplay });
    closeTranslationScopeMenu();
    $('#full-translate-scope-button')?.focus({ preventScroll: true });
  }));
  document.addEventListener('pointerdown', (event) => {
    const menu = $('#translation-scope-menu');
    if (!menu || menu.hidden || menu.contains(event.target) || event.target.closest?.('#full-translate-scope-button')) return;
    closeTranslationScopeMenu();
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeTranslationScopeMenu(); });
  $('#stop-translation-button').addEventListener('click', stopFullTranslation);
  $('#open-source-button')?.addEventListener('click', () => {
    const job = state.activeJob;
    if (!job) { showToast('请先打开一篇文献。', true); return; }
    if (window.myScholarDesktop?.openSourcePdf) {
      Promise.resolve(window.myScholarDesktop.openSourcePdf(job.job_id))
        .then((result) => {
          if (result && result.ok === false) throw new Error(result.error || '无法打开原始文件。');
        })
        .catch((error) => showToast(error.message || '无法打开原始文件。', true));
      return;
    }
    const source = job.links?.source;
    if (source) window.open(source, '_blank', 'noopener');
    else showToast('原始文件不可用。', true);
  });


  // One reflow per document; the server queues them, so several documents can
  // be pending at once and each keeps its own poll loop until it settles.
  const reflowRuns = new Map();
  let reflowPreflightInFlight = false;
  const reflowStatusLabels = { queued: 'AI 重排排队中', running: '正在进行 AI 重排', cancelling: '正在取消 AI 重排', cancelled: 'AI 重排已取消', completed: 'AI 重排已完成', failed: 'AI 重排失败' };
  const ACTIVE_REFLOW_STATUSES = new Set(['queued', 'running', 'cancelling']);
  function readerDocumentURL(source) {
    const url = new URL(String(source || ''), window.location.href);
    url.searchParams.set('reader', '1');
    return url.href;
  }

  function safeReflowDocumentURL(source, jobId, generation) {
    try {
      const url = new URL(String(source || ''), window.location.href);
      const safeJobId = String(jobId || '');
      const safeGeneration = String(generation || '');
      if (!/^[a-f0-9]{12,40}$/.test(safeJobId) || !/^[1-9][0-9]{0,8}$/.test(safeGeneration)) return '';
      const expectedPath = `/api/jobs/${safeJobId}/renders/${safeGeneration}/document.html`;
      return url.origin === window.location.origin && url.pathname === expectedPath ? url.href : '';
    } catch (_) {
      return '';
    }
  }


  function updateReflowButton(running, progress = 0, runningLabel = '') {
    const button = $('#reflow-button');
    const label = $('#reflow-button-label');
    if (button) {
      button.disabled = running;
      button.classList.toggle('active', running);
      button.setAttribute('aria-busy', String(running));
    }
    if (label) label.textContent = running ? runningLabel || `重排中 ${progress}%` : 'AI 重排';
  }

  function reflowPercent(reflow = {}) {
    const raw = Number(reflow.progress);
    const percent = Math.round(Math.max(0, Math.min(100, Number.isFinite(raw) ? (raw <= 1 ? raw * 100 : raw) : 0)));
    const status = String(reflow.status || 'queued');
    return status === 'completed' ? 100 : ['failed', 'cancelled', 'cancelling'].includes(status) ? Math.min(99, percent) : percent;
  }
  function reflowRunFor(jobId) { return jobId ? reflowRuns.get(jobId) || null : null; }
  function activeReflowRun() { return reflowRunFor(state.activeJob?.job_id); }
  function reflowRunIsActive(run) { return Boolean(run && ACTIVE_REFLOW_STATUSES.has(String(run.reflow?.status || ''))); }
  function ensureReflowRun(jobId, { fresh = false } = {}) {
    const existing = reflowRuns.get(jobId);
    if (existing && !fresh) return existing;
    if (existing) {
      window.clearTimeout(existing.timer);
      window.clearTimeout(existing.hideTimer);
    }
    const run = { jobId, timer: null, hideTimer: null, title: documentTitleFor(jobId), reflow: { status: 'queued', progress: 0, stage: '', error: null } };
    reflowRuns.set(jobId, run);
    return run;
  }
  function dropReflowRun(jobId) {
    const run = reflowRuns.get(jobId);
    if (!run) return;
    window.clearTimeout(run.timer);
    window.clearTimeout(run.hideTimer);
    reflowRuns.delete(jobId);
    if (state.activeJob?.job_id === jobId) paintReflowPanel();
    refreshBackgroundTasks();
  }
  function dismissReflowRun(jobId) {
    if (!reflowRunIsActive(reflowRunFor(jobId))) dropReflowRun(jobId);
  }

  // The static panel in the tray describes the active document's reflow; the
  // button in the reader toolbar follows it.
  function paintReflowPanel() {
    const panel = $('#reflow-progress');
    if (!panel) return;
    const run = activeReflowRun();
    const cancelButton = $('#cancel-reflow-button');
    if (!run) {
      panel.hidden = true;
      updateReflowButton(false);
      if (cancelButton) cancelButton.hidden = true;
      return;
    }
    const reflow = run.reflow || {};
    const status = String(reflow.status || 'queued');
    const displayedPercent = reflowPercent(reflow);
    panel.hidden = false;
    panel.dataset.state = status;
    $('#reflow-progress-label').textContent = reflowStatusLabels[status] || reflowStatusLabels.running;
    $('#reflow-progress-stage').textContent = String(reflow.error || reflow.stage || '').slice(0, 240);
    $('#reflow-progress-value').textContent = `${displayedPercent}%`;
    $('#reflow-progress-bar').style.width = `${displayedPercent}%`;
    $('#reflow-progress-track')?.setAttribute('aria-valuenow', String(displayedPercent));
    const active = ACTIVE_REFLOW_STATUSES.has(status);
    updateReflowButton(active, displayedPercent, status === 'cancelling' ? '正在取消重排…' : '');
    if (cancelButton) {
      cancelButton.hidden = !active;
      cancelButton.disabled = status === 'cancelling';
    }
  }
  function renderReflowStatus(jobId, reflow = {}) {
    const run = ensureReflowRun(jobId);
    run.reflow = { ...run.reflow, ...reflow };
    if (state.activeJob?.job_id === jobId) paintReflowPanel();
    refreshBackgroundTasks();
    return reflowPercent(run.reflow);
  }
  function syncReflowControls() {
    paintReflowPanel();
    refreshBackgroundTasks();
  }

  function renderReflowPreflightFailure(message) {
    const run = activeReflowRun();
    if (run && !reflowRunIsActive(run)) dropReflowRun(run.jobId);
    updateReflowButton(false);
    if (message) showToast(String(message), true);
  }
  function mergeReflowJob(job, documentURL = '') {
    const merge = (current) => current?.job_id === job.job_id
      ? { ...current, ...job, links: { ...(current.links || {}), ...(job.links || {}), ...(documentURL ? { html: documentURL } : {}) } }
      : current;
    state.jobs = state.jobs.map(merge);
    state.openDocuments = state.openDocuments.map(merge);
    if (state.activeJob?.job_id === job.job_id) state.activeJob = merge(state.activeJob);
    renderDocumentTabs();
  }


  function finishReflow(job, run) {
    if (!job?.reflow || reflowRuns.get(run.jobId) !== run) return true;
    const { reflow } = job;
    renderReflowStatus(run.jobId, reflow);
    if (!['completed', 'failed', 'cancelled'].includes(reflow.status)) return false;
    const isActive = state.activeJob?.job_id === job.job_id;
    const prefix = isActive ? '' : `《${run.title}》`;
    if (['failed', 'cancelled'].includes(reflow.status)) {
      mergeReflowJob(job);
      if (prefix) showToast(`${prefix}${reflowStatusLabels[reflow.status]}${reflow.error ? `：${String(reflow.error).slice(0, 120)}` : ''}`, reflow.status === 'failed');
      return true;
    }
    const documentURL = safeReflowDocumentURL(reflow.document_url, job.job_id, reflow.generation);
    if (!documentURL) {
      renderReflowStatus(run.jobId, { status: 'failed', progress: reflow.progress, error: '重排结果地址无效，已保留当前版本。' });
      return true;
    }
    if (isActive) captureCurrentReadingLocation();
    mergeReflowJob(job, documentURL);
    if (isActive) {
      openReader(state.activeJob, { addTab: false });
    } else {
      disposeReaderMount(job.job_id);
      showToast(`${prefix}AI 重排已完成，下次打开即为新版。`);
    }
    run.hideTimer = window.setTimeout(() => dismissReflowRun(run.jobId), 2200);
    return true;
  }

  async function pollReflow(run) {
    if (reflowRuns.get(run.jobId) !== run) return;
    try {
      const job = await api(`/api/jobs/${run.jobId}`);
      if (reflowRuns.get(run.jobId) !== run) return;
      if (finishReflow(job, run)) return;
    } catch (_) {
      if (reflowRuns.get(run.jobId) !== run) return;
      renderReflowStatus(run.jobId, { status: 'running', stage: '连接暂时中断，正在重试' });
    }
    run.timer = window.setTimeout(() => pollReflow(run), 900);
  }
  async function ensureReflowCapability() {
    try {
      const provider = await fetchParsingProviders();
      const status = parsingProviderStatus(provider);
      if (status === 'ready') return true;
      if (provider.id === 'remote-guzi') {
        renderReflowPreflightFailure(provider.message || '远端解析服务暂不可用，请检查设置中的连接状态。');
        return false;
      }
      if (parsingInstallStates.has(parsingInstallStatus(provider))) {
        if (!parsingInstallPromise) parsingInstallPromise = monitorParsingInstall().finally(() => { parsingInstallPromise = null; });
        const completed = await parsingInstallPromise;
        if (parsingProviderStatus(completed) === 'ready') return true;
        renderReflowPreflightFailure(actionableParsingMessage(parsingErrorCode(completed), parsingDetails(completed), completed?.message));
        return false;
      }
      if (['not_installed', 'cancelled', 'failed'].includes(status)) {
        const installed = await installLocalMinerU(provider);
        if (!installed) return false;
        if (parsingProviderStatus(installed) === 'ready') return true;
        renderReflowPreflightFailure(actionableParsingMessage(parsingErrorCode(installed), parsingDetails(installed), installed?.message));
        return false;
      }
      renderReflowPreflightFailure(actionableParsingMessage(status, parsingDetails(provider), provider.message || provider.capability?.message));
      return false;
    } catch (error) {
      renderReflowPreflightFailure(actionableParsingMessage(error.code, error.details, error.message));
      return false;
    }
  }


  async function cancelReflow(jobId = state.activeJob?.job_id) {
    const run = reflowRunFor(jobId);
    if (!run || !reflowRunIsActive(run)) return;
    const progress = run.reflow?.progress;
    window.clearTimeout(run.timer);
    run.timer = null;
    renderReflowStatus(jobId, { status: 'cancelling', stage: '正在停止版面解析进程', progress });
    try {
      const payload = await api(`/api/jobs/${jobId}/reflow`, { method: 'DELETE' });
      if (reflowRuns.get(jobId) !== run) return;
      const updated = payload.job || payload;
      mergeReflowJob(updated);
      if (!finishReflow(updated, run)) run.timer = window.setTimeout(() => pollReflow(run), 300);
    } catch (error) {
      if (reflowRuns.get(jobId) !== run) return;
      renderReflowStatus(jobId, { status: 'running', stage: `取消失败：${error.message}，任务仍在继续`, progress });
      run.timer = window.setTimeout(() => pollReflow(run), 900);
    }
  }

  async function startReflow() {
    if (browserDemo) { showToast('浏览器本地测试版不运行解析引擎，内置样例可直接阅读。'); return; }
    const job = state.activeJob;
    if (!job || reflowRunIsActive(reflowRunFor(job.job_id)) || reflowPreflightInFlight) return;
    reflowPreflightInFlight = true;
    const button = $('#reflow-button');
    const label = $('#reflow-button-label');
    if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); }
    if (label) label.textContent = '检查版面引擎…';
    const ready = await ensureReflowCapability();
    reflowPreflightInFlight = false;
    if (!reflowRunIsActive(activeReflowRun())) updateReflowButton(false);
    if (!ready || state.activeJob?.job_id !== job.job_id) return;
    const confirmed = await requestConfirmation(`${currentRemoteParserProvider?.configured ? 'PDF 将上传至你配置的远端融合解析服务。' : ''}AI 重排会在后台重新分析当前文章。完成前会继续显示当前版本；只有成功后才切换到新版。`, '开始 AI 重排？');
    if (!confirmed || state.activeJob?.job_id !== job.job_id) return;
    const run = ensureReflowRun(job.job_id, { fresh: true });
    renderReflowStatus(job.job_id, { status: 'queued', stage: '正在提交重排任务', progress: 0, error: null });
    try {
      const updated = await api(`/api/jobs/${job.job_id}/reflow`, { method: 'POST' });
      if (reflowRuns.get(job.job_id) !== run) return;
      mergeReflowJob(updated);
      if (!finishReflow(updated, run)) run.timer = window.setTimeout(() => pollReflow(run), 500);
    } catch (error) {
      if (reflowRuns.get(job.job_id) !== run) return;
      renderReflowStatus(job.job_id, { status: 'failed', error: error.message, progress: 0 });
    }
  }

  // A reflow submitted in an earlier session, or before a reload, is still
  // running on the server; pick its polling back up from the job list.
  function resumeRunningReflows() {
    state.jobs.forEach((job) => {
      const reflow = job?.reflow;
      if (!ACTIVE_REFLOW_STATUSES.has(String(reflow?.status || '')) || reflowRuns.has(job.job_id)) return;
      const run = ensureReflowRun(job.job_id, { fresh: true });
      renderReflowStatus(job.job_id, reflow);
      run.timer = window.setTimeout(() => pollReflow(run), 500);
    });
  }

  $('#reflow-button').addEventListener('click', startReflow);
  $('#cancel-reflow-button')?.addEventListener('click', () => { void cancelReflow(); });

  // Background task tray: the active document's panels above are static; the
  // cards for every other document are rendered from the run maps here.
  function documentTitleFor(jobId) {
    const entry = libraryEntry(jobId);
    if (entry) return itemTitle(entry);
    const job = state.openDocuments.find((item) => item.job_id === jobId) || state.jobs.find((item) => item.job_id === jobId);
    return String(job?.source_filename || '未命名文献').replace(/\.pdf$/i, '');
  }
  function busyDocumentIds() {
    const ids = new Set();
    state.translationRuns.forEach((run, jobId) => { if (run.running) ids.add(jobId); });
    reflowRuns.forEach((run, jobId) => { if (reflowRunIsActive(run)) ids.add(jobId); });
    return ids;
  }
  const backgroundTasksView = window.MyScholarBackgroundTasks?.create({
    container: $('#background-tasks'),
    onOpen: (jobId) => {
      const job = state.openDocuments.find((item) => item.job_id === jobId) || state.jobs.find((item) => item.job_id === jobId);
      if (job) openReader(job);
    },
    onCancel: (card) => {
      if (card.kind === 'translation') stopFullTranslation(card.jobId);
      else void cancelReflow(card.jobId);
    },
    onDismiss: (card) => { if (card.kind === 'reflow') dismissReflowRun(card.jobId); },
  }) || null;
  function refreshBackgroundTasks() {
    const activeId = state.activeJob?.job_id || '';
    const cards = [];
    state.translationRuns.forEach((run, jobId) => {
      if (jobId === activeId || !run.running) return;
      const queued = run.phase === 'queued';
      cards.push({
        id: `translation:${jobId}`, kind: 'translation', jobId, title: run.title,
        status: run.stop ? 'cancelling' : queued ? 'queued' : 'running',
        progress: translationRunPercent(run),
        label: run.stop ? translationStatusLabels.stopping : queued ? translationStatusLabels.queued : translationStatusLabels.running,
        detail: run.total ? `第 ${Math.min(run.total, run.done + 1)} / ${run.total} 段` : '',
        cancellable: !run.stop, dismissible: false,
      });
    });
    reflowRuns.forEach((run, jobId) => {
      if (jobId === activeId) return;
      const status = String(run.reflow?.status || 'queued');
      const active = ACTIVE_REFLOW_STATUSES.has(status);
      cards.push({
        id: `reflow:${jobId}`, kind: 'reflow', jobId, title: run.title, status,
        progress: reflowPercent(run.reflow),
        label: reflowStatusLabels[status] || reflowStatusLabels.running,
        detail: String(run.reflow?.error || run.reflow?.stage || '').slice(0, 160),
        cancellable: active && status !== 'cancelling', dismissible: !active,
      });
    });
    backgroundTasksView?.render(cards);
    const busy = busyDocumentIds();
    $$('#document-tabs .document-tab').forEach((tab) => tab.classList.toggle('is-busy', busy.has(tab.dataset.jobId)));
  }
  function normalizeTypographyValue(key, value) {
    const limits = typographyLimits[key];
    const numeric = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
    if (!limits || !Number.isFinite(numeric)) return typographyDefaults[key];
    return Math.round(Math.min(limits.max, Math.max(limits.min, numeric)));
  }
  function normalizeTypography(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return {
      fontSize: normalizeTypographyValue('fontSize', source.fontSize),
      lineHeight: normalizeTypographyValue('lineHeight', source.lineHeight),
      pageMargin: normalizeTypographyValue('pageMargin', source.pageMargin),
    };
  }
  function applyTypography() {
    state.typography = normalizeTypography(state.typography);
    const doc = frameDocument();
    const root = doc?.documentElement;
    const fontScale = state.typography.fontSize / 100;
    const lineHeight = state.typography.lineHeight / 100;
    if (root) {
      let style = doc.getElementById('my-scholar-reader-preferences');
      if (!style && doc.head) {
        style = doc.createElement('style');
        style.id = 'my-scholar-reader-preferences';
        style.textContent = '.reader-content .pdf-page{padding-left:var(--reader-page-margin)!important;padding-right:var(--reader-page-margin)!important}@media(max-width:760px){.reader-content .pdf-page{padding-left:min(16px,var(--reader-page-margin))!important;padding-right:min(16px,var(--reader-page-margin))!important}}';
        doc.head.append(style);
      }
      const marginScale = state.typography.pageMargin / 100;
      root.style.setProperty('--reader-font-scale', String(fontScale));
      root.style.setProperty('--reader-line-height', String(lineHeight));
      root.style.setProperty('--reader-page-margin', `clamp(${(30 * marginScale).toFixed(1)}px, ${(5 * marginScale).toFixed(2)}vw, ${(74 * marginScale).toFixed(1)}px)`);
    }
    const readerContent = doc?.querySelector('.reader-content');
    const computedReaderStyle = readerContent ? doc.defaultView?.getComputedStyle(readerContent) : null;
    const computedReaderSize = Number.parseFloat(computedReaderStyle?.fontSize || '');
    const contentFontSize = Number.isFinite(computedReaderSize) ? computedReaderSize : 17 * fontScale;
    const contentFontFamily = computedReaderStyle?.fontFamily || readerFontStacks[state.appearance.reader_font] || readerFontStacks.academic;
    const typographyRoots = [document.documentElement, root].filter(Boolean);
    typographyRoots.forEach((typographyRoot) => {
      typographyRoot.style.setProperty('--reader-font-scale', String(fontScale));
      typographyRoot.style.setProperty('--reader-line-height', String(lineHeight));
      typographyRoot.style.setProperty('--reader-content-font-family', contentFontFamily);
      typographyRoot.style.setProperty('--reader-content-font-size', `${contentFontSize.toFixed(2)}px`);
      typographyRoot.style.setProperty('--reader-heading-font-size', `${(contentFontSize * 0.88).toFixed(2)}px`);
      typographyRoot.style.setProperty('--reader-support-font-size', `${(contentFontSize * 0.82).toFixed(2)}px`);
      typographyRoot.style.setProperty('--reader-caption-font-size', `${(contentFontSize * 0.70).toFixed(2)}px`);
    });
    const fontRange = $('#font-size-range');
    const lineRange = $('#line-height-range');
    const marginRange = $('#page-margin-range');
    const fontValue = $('#font-size-value');
    const lineValue = $('#line-height-value');
    const marginValue = $('#page-margin-value');
    if (fontRange) fontRange.value = String(state.typography.fontSize);
    if (lineRange) lineRange.value = String(state.typography.lineHeight);
    if (marginRange) marginRange.value = String(state.typography.pageMargin);
    if (fontValue) fontValue.value = String(state.typography.fontSize);
    if (lineValue) lineValue.value = String(state.typography.lineHeight);
    if (marginValue) marginValue.value = String(state.typography.pageMargin);
    persistentStateSet('my-scholar-typography', JSON.stringify(state.typography));
    scheduleInterlinearTranslations(doc);
  }
  function normalizeHexColor(value, fallback = '#f59e0b') {
    const candidate = String(value || '').trim();
    return /^#[0-9a-f]{6}$/i.test(candidate) ? candidate.toLowerCase() : fallback;
  }
  function applyHighlightColor() {
    state.highlightColor = normalizeHexColor(state.highlightColor);
    document.documentElement.style.setProperty('--user-highlight', state.highlightColor);
    frameDocument()?.documentElement?.style.setProperty('--user-highlight', state.highlightColor, 'important');
  }
  function loadTypography() {
    try {
      const saved = JSON.parse(persistentStateGet('my-scholar-typography') || '{}');
      state.typography = normalizeTypography(saved);
    } catch (_) { state.typography = { ...typographyDefaults }; }
    applyTypography();
  }
  let typographyPopoverOpen = false;
  function setTypographyPopover(open, { restoreFocus = false } = {}) {
    const popover = $('#typography-popover');
    const button = $('#typography-button');
    if (!popover || !button) return;
    typographyPopoverOpen = Boolean(open);
    if (typographyPopoverOpen) openTransient(popover);
    else closeTransient(popover, { onFinish: () => {
      if (restoreFocus && !typographyPopoverOpen) button.focus({ preventScroll: true });
    } });
    button.setAttribute('aria-expanded', String(typographyPopoverOpen));
    button.classList.toggle('active', typographyPopoverOpen);
    if (typographyPopoverOpen) {
      positionTypographyPopover();
      window.requestAnimationFrame(positionTypographyPopover);
    }
  }
  function positionTypographyPopover() {
    const popover = $('#typography-popover');
    const button = $('#typography-button');
    if (!popover || !button || popover.hidden) return;
    const rect = button.getBoundingClientRect();
    const width = popover.offsetWidth || 240;
    const height = popover.offsetHeight || 120;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width));
    const top = Math.max(8, Math.min(window.innerHeight - height - 8, rect.bottom + 8));
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
    popover.style.right = 'auto';
  }
  $('#typography-button')?.addEventListener('click', (event) => {
    event.stopPropagation();
    setTypographyPopover(!typographyPopoverOpen);
  });
  $('#typography-popover')?.addEventListener('click', (event) => event.stopPropagation());
  document.addEventListener('click', () => setTypographyPopover(false));
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !typographyPopoverOpen) return;
    event.preventDefault();
    setTypographyPopover(false, { restoreFocus: true });
  });
  function bindTypographyControl(rangeId, numberId, key) {
    const range = $(rangeId);
    const number = $(numberId);
    [range, number].forEach((control) => control?.addEventListener('input', (event) => {
      if (!Number.isFinite(event.target.valueAsNumber)) return;
      state.typography[key] = event.target.valueAsNumber;
      applyTypography();
    }));
    number?.addEventListener('change', (event) => {
      if (!Number.isFinite(event.target.valueAsNumber)) applyTypography();
    });
  }
  bindTypographyControl('#font-size-range', '#font-size-value', 'fontSize');
  bindTypographyControl('#line-height-range', '#line-height-value', 'lineHeight');
  bindTypographyControl('#page-margin-range', '#page-margin-value', 'pageMargin');
  $('#typography-reset')?.addEventListener('click', () => { state.typography = { ...typographyDefaults }; applyTypography(); });
  window.addEventListener('resize', positionTypographyPopover, { passive: true });
  colorSchemeQuery.addEventListener('change', () => {
    applyAppearance();
    if (state.libraryMode === 'graph') refreshLibraryGraph();
    if ($('#settings-view')?.classList.contains('active-view')) applyAppearancePreview(state.pendingAppearance);
  });
  applyHighlightColor();
  loadTypography();
  applyAppearance();
  $('#share-button').addEventListener('click', async () => {
    const url = state.activeJob?.links?.html ? new URL(state.activeJob.links.html, window.location.href).href : window.location.href;
    try { await navigator.clipboard.writeText(url); showToast('本地阅读链接已复制。'); }
    catch (_) { showToast(`复制失败，请手动复制：${url}`, true); }
  });
  $('#reader-info-button').addEventListener('click', () => {
    if (!state.activeJob) return;
    const counts = state.activeJob.manifest?.counts || {};
    showToast(`${state.activeJob.source_filename} · ${counts.pages || '—'} 页 · ${counts.tables || 0} 表 · ${counts.images || 0} 图`);
  });

  // Health probe, application shortcuts and initial data loading.
  async function checkHealth() {
    try {
      const previousProfileId = translationProfileId();
      const payload = await api('/api/health');
      state.health = payload;
      for (const service of ['translation', 'chat']) {
        const profile = payload.ai?.services?.[service];
        if (profile) state.aiProfiles[service] = { ...state.aiProfiles[service], model: profile.model || '', api_format: profile.api_format || 'auto', ...normalizeChatOptions(profile), capabilities: profile.capabilities || {} };
      }
      renderChatOptions({ force: true });
      const nextProfileId = translationProfileId();
      if (previousProfileId !== nextProfileId) {
        state.translationRuns.forEach((run) => { if (run?.running) cancelTranslationRun(run); });
        if (previousProfileId && state.activeJob && frameDocument()?.querySelector('.my-scholar-translation:not(.is-pending):not(.is-error)')) {
          const jobId = state.activeJob.job_id;
          void requestConfirmation('已有译文会保留。是否使用新引擎重新翻译当前论文？新结果成功后才会替换对应译文，其他论文不会自动重译。', '翻译引擎已切换', { accept: '重新翻译当前论文', cancel: '保留现有译文' }).then((retranslate) => {
            if (retranslate && state.activeJob?.job_id === jobId) void runFullTranslation({ refresh: true });
          });
        }
      }
      document.body.classList.toggle('readonly-mode', payload.readonly === true);
      if (payload.readonly === true) {
        document.title = '谷子学术 · 在线预览';
        if (!$('#readonly-preview-badge')) {
          const badge = document.createElement('span');
          badge.id = 'readonly-preview-badge';
          badge.className = 'readonly-preview-badge';
          badge.textContent = '在线预览 · 只读';
          $('.brand-mark')?.insertAdjacentElement('afterend', badge);
        }
        $('#library-subtitle').textContent = '公开样例 · 只读体验';
        $$('#grouping-button, .row-cell-button, .details-stars button, .details-status-select').forEach((control) => { control.disabled = true; });
        $('#notes-editor')?.setAttribute('contenteditable', 'false');
        if (!['outline-panel', 'quick-preview-panel'].includes(currentSidebarPanelId())) switchSidebar('outline-panel', { open: false });
      }
      if (state.activeJob && frameDocument()) ensureTitleTranslation();
    } catch (_) {
      state.health = null;
    }
  }
  function shortcutMatches(event, shortcut) {
    const parts = normalizeShortcut(shortcut).split('+').map((part) => part.trim().toLowerCase()).filter(Boolean);
    if (!parts.length) return false;
    const key = parts.at(-1);
    const wantsCommand = ['cmd', 'meta', 'windows'].some((modifier) => parts.includes(modifier));
    const wantsControl = parts.includes('ctrl');
    const wantsShift = parts.includes('shift');
    const wantsAlt = parts.includes('option') || parts.includes('alt');
    if (event.metaKey !== wantsCommand || event.ctrlKey !== wantsControl || event.shiftKey !== wantsShift || event.altKey !== wantsAlt) return false;
    return canonicalShortcutKey(event.key).toLowerCase() === key;
  }
  function selectionShortcut(action, withNote = false) {
    if (!state.selection) { showToast('请先在正文或译文中选择一段文字。', true); return; }
    saveAnnotation(action, { withNote });
  }
  function setReaderShortcutHint(button, setting, label) {
    const shortcut = normalizeShortcut(state.shortcuts[setting]);
    const hint = `${label}（${shortcut}）`;
    button.title = hint;
    button.setAttribute('aria-label', hint);
    button.setAttribute('aria-keyshortcuts', shortcut.replace(/Cmd|Windows/gu, 'Meta').replace(/Option/gu, 'Alt'));
  }
  function syncReaderShortcutHints() {
    syncTranslationScopeControls();
    const button = $('#reflow-button');
    if (button) setReaderShortcutHint(button, 'reflow', 'AI 重排');
  }
  function readerShortcutReady() {
    return Boolean($('#reader-view')?.classList.contains('active-view') && state.activeJob?.status === 'completed'
      && readerMount?.ready && readerMount.jobId === state.activeJob.job_id && frameDocument() && !state.health?.readonly);
  }
  function handleApplicationShortcut(event) {
    if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229
      || $('dialog[open]') || event.target?.ownerDocument?.querySelector('dialog[open]')
      || isEditableAppSurface(event.target) || event.target?.isContentEditable
      || event.target?.closest?.('[contenteditable]:not([contenteditable="false"]), [role="textbox"]')) return false;
    if (handleSelectionNumberShortcut(event)) return true;
    if (shortcutMatches(event, state.shortcuts.full_translation)) {
      if (!readerShortcutReady()) return false;
      event.preventDefault();
      if (!state.translationRuns.get(state.activeJob.job_id)?.running) void runFullTranslation({ refresh: true });
      return true;
    }
    if (shortcutMatches(event, state.shortcuts.reflow)) {
      if (!readerShortcutReady()) return false;
      event.preventDefault();
      if (!reflowPreflightInFlight && !reflowRunIsActive(activeReflowRun())) void startReflow();
      return true;
    }
    if (shortcutMatches(event, state.shortcuts.highlight)) { event.preventDefault(); selectionShortcut('highlight'); return true; }
    if (shortcutMatches(event, state.shortcuts.underline)) { event.preventDefault(); selectionShortcut('underline'); return true; }
    if (shortcutMatches(event, state.shortcuts.highlight_note)) { event.preventDefault(); selectionShortcut('highlight', true); return true; }
    if (shortcutMatches(event, state.shortcuts.underline_note)) { event.preventDefault(); selectionShortcut('underline', true); return true; }
    if (shortcutMatches(event, state.shortcuts.open_library)) { event.preventDefault(); switchView('library-view'); return true; }
    if (shortcutMatches(event, state.shortcuts.open_settings)) { event.preventDefault(); switchView('settings-view'); return true; }
    return false;
  }
  document.addEventListener('keydown', handleApplicationShortcut);
  syncReaderShortcutHints();

  // Mobile shell: the sidebar and the details panel are overlays that must be
  // dismissible, and the app should be installable to the home screen.
  $('#mobile-sidebar-toggle')?.addEventListener('click', () => setSidebarOpen(!document.body.classList.contains('sidebar-open'), { restoreFocus: true }));
  $('#library-scrim')?.addEventListener('click', () => setSidebarOpen(false, { restoreFocus: true }));
  $('.library-sidebar')?.addEventListener('click', (event) => {
    if (isMobileLayout() && event.target.closest('[data-library-folder], [data-sidebar-view], [data-library-mode], [data-group-filter]')) setSidebarOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (document.body.classList.contains('sidebar-open')) setSidebarOpen(false, { restoreFocus: true });
    else if (document.body.classList.contains('details-open')) setDetailsOpen(false, { restoreFocus: true });
  });
  mobileLayout.addEventListener('change', () => setSidebarOpen(false));
  sheetLayout.addEventListener('change', () => setDetailsOpen(state.selectedLibraryJobIds.size > 0));
  syncLibraryOverlayAccessibility();
  // Chromium browsers (Android, desktop Chrome/Edge) offer installation
  // through this event; Safari uses its own share-sheet flow instead.
  let installPrompt = null;
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
    const button = $('#install-app-button');
    if (button) button.hidden = false;
  });
  $('#install-app-button')?.addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    const choice = await installPrompt.userChoice.catch(() => null);
    installPrompt = null;
    $('#install-app-button').hidden = true;
    if (choice?.outcome === 'accepted') showToast('已添加到主屏幕。');
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    const button = $('#install-app-button');
    if (button) button.hidden = true;
  });

  const isDesktopShell = /Electron\//u.test(navigator.userAgent);
  void onboarding.initializeOnboarding();
  if ('serviceWorker' in navigator && !isDesktopShell && location.protocol !== 'file:') {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => { /* installability is optional */ });
    });
  }

  function showBrowserDemoInvalidation() {
    if (!browserDemo?.invalidated || demoResetting) return;
    document.body.classList.add('browser-demo-invalidated');
    document.querySelectorAll('.app-header, .app-shell').forEach((element) => { element.inert = true; });
    if (document.getElementById('browser-demo-invalidated-dialog')) return;
    const dialog = document.createElement('dialog');
    dialog.id = 'browser-demo-invalidated-dialog';
    dialog.className = 'browser-demo-invalidated-dialog';
    dialog.setAttribute('aria-labelledby', 'browser-demo-invalidated-title');
    const title = document.createElement('h2');
    title.id = 'browser-demo-invalidated-title';
    title.textContent = '测试数据已重置，请刷新后继续。';
    const message = document.createElement('p');
    message.textContent = '当前页面已停止保存。刷新后将重新载入浏览器测试数据。';
    const reload = document.createElement('button');
    reload.id = 'browser-demo-reload';
    reload.type = 'button';
    reload.className = 'primary-button compact-button';
    reload.textContent = '刷新页面';
    reload.addEventListener('click', () => location.reload());
    dialog.addEventListener('cancel', (event) => event.preventDefault());
    dialog.append(title, message, reload);
    document.body.append(dialog);
    dialog.showModal();
  }

  function initializeBrowserDemoUI() {
    if (!browserDemo) return;
    document.body.classList.add('browser-demo-mode');
    document.title = '谷子学术 · 浏览器本地测试版';
    const banner = document.createElement('div');
    banner.id = 'browser-demo-banner';
    banner.className = 'browser-demo-banner';
    banner.setAttribute('aria-label', '浏览器本地测试版状态');
    const label = document.createElement('span');
    label.textContent = '浏览器本地测试版 · 本机保存 · AI 为示例';
    const reset = document.createElement('button');
    reset.id = 'browser-demo-reset';
    reset.type = 'button';
    reset.className = 'tiny-button';
    reset.textContent = '重置测试数据';
    reset.addEventListener('click', async () => {
      if (!await requestConfirmation('将清除当前浏览器中本测试版的笔记、批注、文献库编辑、助手会话和界面偏好，并恢复内置样例。此操作不会清除桌面版文献库、其他网站或普通预览的数据。', '重置浏览器测试数据？')) return;
      reset.disabled = true;
      demoResetting = true;
      try { await browserDemo.reset(); location.reload(); }
      catch (error) { demoResetting = false; reset.disabled = false; showToast(`重置失败：${error.message}`, true); showBrowserDemoInvalidation(); }
    });
    banner.append(label, reset);
    document.body.prepend(banner);
    void browserDemo.readingSource().then((source) => {
      if (!source) return;
      const readSample = document.createElement('button');
      readSample.id = 'browser-demo-reading-sample';
      readSample.type = 'button';
      readSample.className = 'tiny-button';
      readSample.textContent = '体验逐行双语';
      readSample.addEventListener('click', async () => {
        readSample.disabled = true;
        try {
          const currentSource = await browserDemo.readingSource();
          if (!currentSource) {
            showToast('样例文献已移除，请先从回收站恢复，或重置测试数据。');
            return;
          }
          if (!state.jobs.length) await loadLibrary();
          setTranslationPreferences({ displayMode: 'bilingual' });
          await openPluginSource(currentSource, { settleImages: true });
        } catch (error) { showToast(`样例打开失败：${error.message}`, true); }
        finally { readSample.disabled = false; }
      });
      banner.insertBefore(readSample, reset);
    }).catch((error) => showToast(`样例入口加载失败：${error.message}`, true));
    const notice = document.createElement('p');
    notice.className = 'browser-demo-ai-notice';
    notice.textContent = 'AI 示例：可试用文章提问、翻译和阅读重点。回答与译文为内置演示内容，不会调用真实模型；笔记和批注仅保存在当前浏览器。';
    $('#chat-panel')?.prepend(notice);
    const highlightNotice = notice.cloneNode(false);
    highlightNotice.textContent = 'AI 示例阅读重点 · 非真实模型分析，可试用采纳、忽略和批注编辑。';
    $('#highlights-panel')?.prepend(highlightNotice);
    const reasons = {
      'settings-ai': 'AI 为内置示例，无需配置账号、服务地址或密钥。请回到文章助手试用提问、翻译与阅读重点。',
      'settings-parsing': '浏览器本地测试版不上传文献、不运行或安装解析引擎。请阅读内置样例；真实 PDF 导入和重新解析请使用桌面版。',
      'settings-mcp': '浏览器本地测试版不连接本机 Agent、不生成真实连接凭据，也不安装或开发插件。',
      'settings-metadata': '浏览器本地测试版使用独立的浏览器存储，不连接 Zotero、真实账号或在线书目服务。文献属性和文件夹仍可在文献库中编辑。',
      'settings-updates': '当前为浏览器本地测试版；桌面版下载与更新请查看项目发布页。',
    };
    Object.entries(reasons).forEach(([id, reason]) => {
      const section = $(`#${id}`);
      if (!section) return;
      section.classList.add('browser-demo-unavailable-section');
      section.querySelectorAll('input, select, textarea, button').forEach((control) => { control.disabled = true; if (control.type === 'password') control.value = ''; });
      const message = document.createElement('p');
      message.className = 'browser-demo-section-message';
      message.textContent = reason;
      section.prepend(message);
    });
    const unavailable = '#import-pdf-button, [data-open-zotero-import], #reflow-button, #insert-image-button, .annotation-note-insert-image, #metadata-retrieve-button, [data-view="market-view"], [data-plugin-nav]:not([data-plugin-nav="guzi.vocabulary"])';
    $$(unavailable).forEach((control) => {
      control.setAttribute('aria-disabled', 'true');
      control.title = '浏览器本地测试版仅支持内置样例和本地编辑，此功能请使用桌面版。';
    });
    document.addEventListener('click', (event) => {
      if (!event.target.closest?.(unavailable)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      showToast('浏览器本地测试版不支持上传、Zotero、重新解析、在线检索或插件安装；请使用桌面版。');
    }, true);
    if (!persistentStateGet('browser-demo-intro-seen')) {
      persistentStateSet('browser-demo-intro-seen', '1');
      showToast('浏览器本地测试版：编辑保存在本机，AI 回答和译文为示例，可随时重置。');
    }
  }

  const requestedSettingsSection = /^#settings-[a-z-]+$/u.test(location.hash) ? $(location.hash) : null;
  window.addEventListener('hashchange', () => {
    const target = /^#settings-[a-z-]+$/u.test(location.hash) ? $(location.hash) : null;
    if (target?.classList.contains('settings-section')) {
      activeSettingsSectionId = target.id;
      if ($('#settings-view')?.classList.contains('active-view')) showSettingsSection(target.id, { updateHash: false });
    }
  });
  void pluginHost.refresh().catch((error) => showToast(`插件载入失败：${error.message}`, true));
  window.addEventListener('focus', () => void pluginHost.refresh().catch(() => {}));
  initializeBrowserDemoUI();
  await checkHealth();
  loadLibrary();
  if (requestedSettingsSection?.classList.contains('settings-section')) {
    activeSettingsSectionId = requestedSettingsSection.id;
    switchView('settings-view');
  } else {
    loadSettings();
  }
})();
