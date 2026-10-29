(() => {
  'use strict';

  const enabled = document.querySelector('meta[name="my-scholar-demo"]')?.content === 'browser-local-v1';
  const nativeFetch = window.fetch.bind(window);
  const statePrefix = 'my-scholar-browser-demo-v1:';
  const databaseName = 'my-scholar-browser-demo-v1';
  const seedJobId = '8065bbad761a6255';
  const sampleRevision = 2;
  const samplePath = '/web/assets/demo/attention/reading-sample.json';
  const profileId = 'browser-demo';
  const now = () => new Date().toISOString();
  const clone = (value) => structuredClone(value);
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const owns = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const id = (prefix = '') => prefix + crypto.randomUUID().replaceAll('-', '');
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-My-Scholar-Demo': 'browser-local-v1' } });
  class DemoError extends Error {
    constructor(message, status = 400, code = 'invalid_request') { super(message); this.status = status; this.code = code; }
  }
  const fail = (message, status = 400, code) => { throw new DemoError(message, status, code); };
  const unsupported = () => fail('浏览器本地演示不支持此操作。上传、重新解析、Zotero、账号、插件开发与真实 AI 服务请使用桌面版。', 501, 'demo_unsupported');
  const checkedText = (value, label, maximum, trim = true) => {
    if (typeof value !== 'string' || value.length > maximum) fail(`${label}必须是不超过 ${maximum} 字的文本。`);
    return trim ? value.trim() : value;
  };
  const named = (value, label, maximum) => {
    const result = checkedText(value, label, maximum);
    if (!result) fail(`${label}不能为空。`);
    return result;
  };
  const list = (value) => Array.isArray(value) ? value : [];
  const unique = (value) => [...new Set(value)];
  const limitedList = (value, limit = 100) => list(value).map((entry) => String(entry).trim()).filter(Boolean).slice(0, limit);
  const color = (value) => /^(?:#[0-9a-f]{6}|yellow|orange|green|blue|purple|pink|red)$/i.test(String(value)) ? String(value) : '#f59e0b';
  const sha256 = async (value) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const profile = (service) => ({ enabled: true, configured: true, demo: true, model: 'Attention 公开样例（示例）', profile_id: profileId, base_url: '', api_format: 'auto', api_key_configured: false, provider: 'browser-demo', mode: 'chat', source_language: 'auto', target_language: '中文', streaming: true, capabilities: { vision: false }, service });
  const services = () => ({ translation: profile('translation'), chat: profile('chat') });
  const vocabularyManifest = { id: 'guzi.vocabulary', name: '生词本', description: '收藏论文原文中的单词与短语，保留原句、释义和来源并进行复习。', version: '1.0.0', sdkVersion: '1', entry: 'index.html', permissions: ['vocabulary.read', 'vocabulary.write', 'ai.translate', 'reader.open', 'storage'], contributes: { pages: [{ id: 'vocabulary', title: '生词本' }], selectionActions: [{ id: 'keep', title: '加入生词本' }] } };
  const vocabularyPlugin = () => ({ id: vocabularyManifest.id, manifest: clone(vocabularyManifest), version: vocabularyManifest.version, bundled: true, enabled: true, grants: [...vocabularyManifest.permissions], epoch: 'browser-demo-v1', url: '/web/plugins/vocabulary/index.html' });
  let database = null;
  let invalidated = false;

  function invalidate() {
    if (invalidated) return;
    invalidated = true;
    database?.close();
    database = null;
    window.dispatchEvent(new CustomEvent('my-scholar-demo-invalidated'));
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new DemoError('浏览器未提供 IndexedDB，无法保存本地演示数据。', 503, 'demo_storage_unavailable')); return; }
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('state');
      request.onerror = () => reject(new DemoError('无法打开本地演示数据库。请检查浏览器存储权限。', 503, 'demo_storage_unavailable'));
      request.onblocked = () => reject(new DemoError('本地演示数据库被其他标签页占用，请关闭其他演示标签页后重试。', 503, 'demo_storage_blocked'));
      request.onsuccess = () => {
        if (invalidated) {
          request.result.close();
          reject(new DemoError('演示存储已关闭，请刷新页面。', 503, 'demo_storage_closed'));
          return;
        }
        database = request.result;
        database.onversionchange = invalidate;
        resolve(database);
      };
    });
  }

  // A single read/write transaction serializes edits from every tab on this origin.
  function transaction(write, operation) {
    return new Promise((resolve, reject) => {
      if (!database || invalidated) { reject(new DemoError('演示存储已关闭，请刷新页面。', 503, 'demo_storage_closed')); return; }
      let result;
      let failure;
      let tx;
      try {
        tx = database.transaction('state', write ? 'readwrite' : 'readonly');
        const store = tx.objectStore('state');
        const request = store.get('main');
        request.onsuccess = () => {
          try {
            const state = request.result;
            result = operation(state);
            if (write && result?.state) store.put(result.state, 'main');
          } catch (error) { failure = error; tx.abort(); }
        };
        tx.oncomplete = () => resolve(result?.output);
        tx.onabort = tx.onerror = () => reject(failure || new DemoError('本地演示数据保存失败，修改未获确认。请检查存储空间或权限。', 503, 'demo_storage_failed'));
      } catch (error) { reject(error instanceof DemoError ? error : new DemoError('本地演示存储不可用，请刷新后重试。', 503, 'demo_storage_failed')); }
    });
  }

  async function publicJSON(path) {
    const response = await nativeFetch(path, { method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer' });
    if (!response.ok) throw new DemoError(`公开样例加载失败（${response.status}），请刷新重试。`, 503, 'demo_seed_failed');
    return response.json();
  }

  function updateReadingSample(state, sample) {
    if (Number(state.sampleRevision || 0) >= sampleRevision) return;
    const doc = state.documents[seedJobId];
    const item = state.library.items[seedJobId];
    if (doc && item && !item.deleted_at) {
      const blocks = new Set(list(doc.document?.pages).flatMap((page) => list(page.elements).map((block) => block.block_id)));
      const replacements = sample.translations.filter((record) => blocks.has(record.block_id));
      const replacedBlocks = new Set(replacements.map((record) => record.block_id));
      doc.translations = [...doc.translations.filter((record) => !replacedBlocks.has(record.block_id)), ...replacements.map((record) => ({ ...clone(record), profile_id: profileId, provider: 'manual', model: '人工整理译文（示例）', demo: true }))];
      const termKey = (term) => term.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
      for (const entry of Number(state.sampleRevision || 0) === 0 ? sample.vocabulary : []) {
        if (!entry.sources.every((source) => source.job_id === seedJobId && blocks.has(source.block_id)) || state.vocabulary.some((current) => termKey(current.term) === termKey(entry.term))) continue;
        state.vocabulary.push({ ...clone(entry), created_at: now(), updated_at: now() });
      }
      if (sample.reading_source?.job_id === seedJobId && blocks.has(sample.reading_source.block_id)) state.readingSource = clone(sample.reading_source);
    }
    // Store the revision even when the document was deleted or uses a synthetic fixture.
    state.sampleRevision = sampleRevision;
  }

  async function initialize() {
    await openDatabase();
    const current = await transaction(false, (state) => ({ output: { exists: state?.version === 1, sampleRevision: Number(state?.sampleRevision || 0) } }));
    if (current.exists && current.sampleRevision >= sampleRevision) return;
    const sample = await publicJSON(samplePath);
    if (!Array.isArray(sample.translations) || !Array.isArray(sample.vocabulary)) fail('公开阅读样例格式不完整，请刷新重试。', 503, 'demo_seed_failed');
    if (current.exists) {
      await transaction(true, (state) => { updateReadingSample(state, sample); return { state }; });
      return;
    }
    const [health, jobsPayload, libraryPayload, settings] = await Promise.all(['/api/health', '/api/jobs', '/api/library', '/api/settings'].map(publicJSON));
    const job = list(jobsPayload.jobs).find((entry) => entry.job_id === seedJobId);
    if (!job || !object(libraryPayload.library) || !object(libraryPayload.library.items?.[seedJobId])) fail('公开 Attention 样例不可用，请刷新重试。', 503, 'demo_seed_failed');
    const base = `/api/jobs/${seedJobId}`;
    const [translations, annotations, notes, media] = await Promise.all(['translations', 'annotations', 'notes', 'media-layout'].map((route) => publicJSON(`${base}/${route}`)));
    if (!Array.isArray(translations.translations) || !Array.isArray(annotations.annotations) || typeof notes.markdown !== 'string' || !object(media.media_layout)) fail('公开样例格式不完整，请刷新重试。', 503, 'demo_seed_failed');
    const documentData = object(job.document) ? job.document : { pages: [{ elements: translations.translations.filter((entry) => entry.block_id && typeof entry.source_text === 'string').map((entry) => ({ block_id: entry.block_id, text: entry.source_text })) }] };
    const library = clone(libraryPayload.library);
    library.items = { [seedJobId]: library.items[seedJobId] };
    library.permanently_deleted = [];
    const safeSettings = clone(settings);
    safeSettings.ai = services();
    safeSettings.ai_services = services();
    safeSettings.ai_status_history = [];
    const seed = { version: 1, created_at: now(), health, jobs: [job], library, settings: safeSettings, vocabulary: [], documents: { [seedJobId]: { translations: translations.translations.map((record) => ({ ...record, profile_id: profileId, demo: true, model: '公开归档译文（示例）' })), annotations: annotations.annotations, notes: { markdown: notes.markdown, revision: await sha256(notes.markdown) }, media_layout: media.media_layout, document: documentData, highlights: null } } };
    await transaction(true, (state) => {
      const target = state || seed;
      updateReadingSample(target, sample);
      return { state: target };
    });
  }

  const ready = enabled ? initialize() : Promise.resolve();
  ready.catch(() => {});

  async function readingSource() {
    if (!enabled) return null;
    await ready;
    return transaction(false, (state) => {
      const source = state.readingSource;
      const item = source && state.library.items[source.job_id];
      const doc = source && state.documents[source.job_id];
      const compatible = item && !item.deleted_at && list(doc?.document?.pages).some((page) => list(page.elements).some((block) => block.block_id === source.block_id));
      return { output: compatible ? clone(source) : null };
    });
  }

  function snapshot(state) {
    const library = clone(state.library);
    for (const [jobId, item] of Object.entries(library.items)) item.job = state.jobs.find((job) => job.job_id === jobId);
    const counts = Object.fromEntries(list(library.folders).map((folder) => [folder.id, 0]));
    const items = Object.values(library.items);
    for (const item of items.filter((item) => !item.deleted_at)) for (const folder of list(item.folder_ids)) counts[folder] = (counts[folder] || 0) + 1;
    Object.assign(counts, { 'system-all': items.filter((item) => !item.deleted_at).length, 'system-unfiled': items.filter((item) => !item.deleted_at && !list(item.folder_ids).length).length, 'system-trash': items.filter((item) => item.deleted_at).length });
    library.folder_counts = counts;
    return library;
  }
  const libraryPayload = (state, fields = {}) => ({ ...fields, library: snapshot(state) });
  function documentFor(state, jobId) {
    if (!owns(state.documents, jobId) || !owns(state.library.items, jobId)) fail('文献不存在或已在此浏览器中清除。', 404, 'not_found');
    return state.documents[jobId];
  }
  const annotationPayload = (state, doc, fields = {}) => ({ annotations: doc.annotations, annotation_style_revision: Number(state.settings.annotation_style_revision) || 0, ...fields });
  const find = (values, value, label) => values.find((entry) => entry.id === value) || fail(`${label}不存在。`, 404, 'not_found');
  const editable = (entry, label) => { if (entry.system) fail(`系统${label}不能修改或删除。`); return entry; };

  function actionSnapshot(state, payload) {
    if (!payload.action_id && !payload.label) return {};
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(String(payload.action_id || ''))) fail('自定义标记 ID 无效。');
    const label = named(payload.label, '自定义标记名称', 40);
    const current = list(state.settings.annotation_actions?.custom).find((entry) => entry.id === payload.action_id);
    return current ? { action_id: current.id, label: current.label, kind: current.kind, color: current.color } : { action_id: payload.action_id, label };
  }

  function saveSettings(state, payload) {
    if (['base_url', 'model', 'api_key', 'server_preset', 'translation', 'chat'].some((key) => owns(payload, key))) unsupported();
    if (payload.ai) {
      for (const service of Object.values(payload.ai)) {
        if (!object(service) || ['api_key', 'access_key_id', 'secret_access_key'].some((key) => service[key]) || service.base_url || (service.model && service.model !== profile().model)) unsupported();
      }
    }
    const updates = [];
    if (owns(payload, 'annotation_actions')) {
      const actions = payload.annotation_actions;
      if (!object(actions) || !Array.isArray(actions.custom) || !Array.isArray(actions.hidden_builtin) || actions.custom.length > 32) fail('选区工具栏按钮配置无效。');
      const seen = new Set();
      const custom = actions.custom.map((entry) => {
        if (!object(entry) || !/^[a-zA-Z0-9_-]{1,64}$/.test(String(entry.id)) || seen.has(entry.id) || !['highlight', 'underline'].includes(entry.kind) || !/^#[0-9a-f]{6}$/i.test(String(entry.color))) fail('自定义标记需要唯一 ID、有效颜色及高亮或划线类型。');
        seen.add(entry.id);
        const normalized = { id: entry.id, label: named(entry.label, '标记名称', 40), kind: entry.kind, color: entry.color, enabled: entry.enabled !== false };
        const old = list(state.settings.annotation_actions?.custom).find((item) => item.id === entry.id);
        if (!old || ['label', 'kind', 'color'].some((key) => old[key] !== normalized[key])) updates.push({ action_id: entry.id, label: normalized.label, kind: normalized.kind, color: normalized.color });
        return normalized;
      });
      state.settings.annotation_actions = { hidden_builtin: actions.hidden_builtin.filter((entry) => ['highlight', 'underline', 'highlight_note', 'underline_note', 'translate', 'chat', 'copy', 'vocabulary'].includes(entry)), custom, show_shortcut_hints: actions.show_shortcut_hints !== false };
      if (updates.length) {
        state.settings.annotation_style_revision = (Number(state.settings.annotation_style_revision) || 0) + 1;
        for (const doc of Object.values(state.documents)) for (const annotation of doc.annotations) {
          const update = updates.find((entry) => entry.action_id === annotation.action_id);
          if (update && annotation.source !== 'ai') Object.assign(annotation, update);
        }
      }
    }
    for (const key of ['appearance', 'shortcuts', 'metadata', 'parsing']) if (owns(payload, key)) {
      if (!object(payload[key])) fail('设置必须是对象。');
      state.settings[key] = { ...state.settings[key], ...clone(payload[key]) };
    }
    for (const key of ['highlight_color', 'annotation_colors']) if (owns(payload, key)) state.settings[key] = key === 'highlight_color' ? color(payload[key]) : { highlight: color(payload[key]?.highlight), underline: color(payload[key]?.underline) };
    const settings = clone(state.settings);
    if (updates.length) settings.annotation_style_sync = { revision: state.settings.annotation_style_revision, updates: Object.fromEntries(updates.map(({ action_id, ...fields }) => [action_id, fields])) };
    return { settings };
  }

  function validatePropertyValue(prop, value) {
    if (prop.type === 'rating') {
      const number = Number(value || 0);
      if (!Number.isFinite(number)) fail('评分必须是数字。');
      return Math.max(0, Math.min(prop.max || 5, Math.trunc(number)));
    }
    if (prop.type === 'select') {
      const result = String(value || '');
      if (result && prop.options?.length && !prop.options.includes(result)) fail(`属性“${prop.label}”的选项无效。`);
      return result;
    }
    if (prop.type === 'multi-select') {
      const result = unique(limitedList(value));
      if (prop.options?.length && result.some((entry) => !prop.options.includes(entry))) fail(`属性“${prop.label}”包含无效选项。`);
      return result;
    }
    return String(value || '').slice(0, 1000);
  }

  const metadataFields = ['title', 'authors', 'abstract', 'year', 'venue', 'publication_title', 'proceedings_title', 'conference_name', 'book_title', 'repository', 'institution', 'doi', 'arxiv_id', 'pmid', 'url', 'publisher', 'volume', 'issue', 'pages', 'language', 'keywords', 'item_type'];
  function libraryRoute(state, method, parts, payload) {
    const library = state.library;
    if (!parts.length && method === 'GET') return libraryPayload(state);
    if (parts[0] === 'display' && parts.length === 1) {
      if (method === 'GET') return { display: library.display };
      if (!['PATCH', 'POST'].includes(method)) unsupported();
      const allowed = new Set([...list(library.display.columns), ...library.properties].map((entry) => entry.id));
      if (owns(payload, 'columns')) {
        if (!Array.isArray(payload.columns) || !payload.columns.length) fail('至少保留一列。');
        const seen = new Set();
        const columns = payload.columns.map((entry, order) => {
          if (!object(entry) || !allowed.has(entry.id) || seen.has(entry.id)) fail('列配置包含未知列或重复列。');
          seen.add(entry.id);
          const old = library.display.columns.find((item) => item.id === entry.id) || {};
          const column = { ...old, id: entry.id, label: named(entry.label || old.label, '列名称', 80), visible: entry.visible !== false, system: Boolean(old.system), order };
          if (owns(entry, 'width')) { if (typeof entry.width !== 'number' || !Number.isFinite(entry.width) || entry.width < 40 || entry.width > 2000) fail('列宽无效。'); column.width = entry.width; }
          return column;
        });
        for (const entry of library.display.columns.filter((entry) => entry.system && !seen.has(entry.id))) columns.push({ ...entry, order: columns.length });
        library.display.columns = columns;
      }
      if (owns(payload, 'group_by')) { if (!allowed.has(payload.group_by)) fail('未知分类列。'); library.display.group_by = payload.group_by; }
      return libraryPayload(state, { display: library.display });
    }
    if (['folders', 'properties', 'views'].includes(parts[0])) {
      const category = parts[0];
      const values = library[category];
      const singular = { folders: 'folder', properties: 'property', views: 'view' }[category];
      const label = { folders: '文件夹', properties: '属性', views: '视图' }[category];
      let entry;
      if (parts.length === 1 && method === 'POST') {
        entry = { id: id(`${singular}-`).slice(0, singular.length + 13), system: false, created_at: now() };
        if (category === 'folders') Object.assign(entry, { name: named(payload.name, '文件夹名称', 120), parent_id: payload.parent_id || null, sort_order: values.length });
        if (category === 'views') Object.assign(entry, { name: named(payload.name, '视图名称', 80), filters: list(payload.filters), sort_by: String(payload.sort_by || 'updated_at'), sort_direction: payload.sort_direction === 'asc' ? 'asc' : 'desc' });
        if (category === 'properties') {
          if (!['select', 'multi-select', 'rating', 'text'].includes(payload.type || 'text')) fail('不支持的属性类型。');
          const propLabel = named(payload.label, '属性名称', 80);
          if ([...values, ...library.display.columns].some((item) => item.label?.toLowerCase() === propLabel.toLowerCase())) fail('已有同名属性或系统列。');
          Object.assign(entry, { label: propLabel, type: payload.type || 'text', options: unique(limitedList(payload.options)), hidden: false, order: values.length });
          if (entry.type === 'rating') { if (payload.max !== undefined && !Number.isInteger(payload.max)) fail('评分最大值必须是整数。'); entry.max = Math.max(1, Math.min(10, payload.max || 5)); }
          library.display.columns.push({ id: entry.id, label: entry.label, visible: payload.visible !== false, system: false, order: library.display.columns.length });
        }
        values.push(entry);
      } else if (parts.length === 2 && ['PATCH', 'DELETE'].includes(method)) {
        entry = find(values, parts[1], label);
        if (method === 'DELETE') {
          editable(entry, label);
          library[category] = values.filter((item) => item !== entry);
          if (category === 'folders') {
            for (const child of library.folders) if (child.parent_id === entry.id) child.parent_id = entry.parent_id;
            for (const item of Object.values(library.items)) item.folder_ids = list(item.folder_ids).filter((folder) => folder !== entry.id);
          }
          if (category === 'properties') {
            library.display.columns = library.display.columns.filter((column) => column.id !== entry.id);
            if (library.display.group_by === entry.id) library.display.group_by = 'reading_status';
            for (const item of Object.values(library.items)) delete item.values[entry.id];
          }
          return libraryPayload(state);
        }
        if (category === 'folders') {
          editable(entry, label);
          if (owns(payload, 'name')) entry.name = named(payload.name, '文件夹名称', 120);
          if (owns(payload, 'parent_id')) entry.parent_id = payload.parent_id || null;
        }
        if (category === 'views') {
          if (owns(payload, 'name')) { editable(entry, label); entry.name = named(payload.name, '视图名称', 80); }
          if (owns(payload, 'filters')) entry.filters = list(payload.filters);
          if (owns(payload, 'sort_by')) entry.sort_by = String(payload.sort_by || 'updated_at');
          if (owns(payload, 'sort_direction')) entry.sort_direction = payload.sort_direction === 'asc' ? 'asc' : 'desc';
        }
        if (category === 'properties') {
          if (owns(payload, 'label') && !entry.system) {
            const propLabel = named(payload.label, '属性名称', 80);
            if ([...values, ...library.display.columns].some((item) => item.id !== entry.id && item.label?.toLowerCase() === propLabel.toLowerCase())) fail('已有同名属性或系统列。');
            entry.label = propLabel;
            const column = library.display.columns.find((item) => item.id === entry.id);
            if (column) column.label = propLabel;
          }
          if (owns(payload, 'hidden')) entry.hidden = Boolean(payload.hidden);
          if (owns(payload, 'options') && ['select', 'multi-select'].includes(entry.type)) entry.options = unique(limitedList(payload.options));
        }
      } else unsupported();
      if (category === 'folders' && entry.parent_id) {
        let parentId = entry.parent_id;
        const seen = new Set([entry.id]);
        while (parentId) {
          if (seen.has(parentId)) fail('文件夹不能嵌套到自身或子文件夹中。');
          seen.add(parentId);
          const parent = find(library.folders, parentId, '父文件夹');
          editable(parent, '文件夹');
          parentId = parent.parent_id;
        }
      }
      return libraryPayload(state, { [singular]: entry });
    }
    if (parts[0] === 'items') {
      if (parts[1] === 'permanent' && parts.length === 2 && method === 'POST') {
        if (!Array.isArray(payload.job_ids)) fail('文献列表必须是数组。');
        for (const jobId of unique(payload.job_ids)) removeItem(state, jobId);
        return libraryPayload(state, { deleted: payload.job_ids.length });
      }
      const jobId = parts[1];
      documentFor(state, jobId);
      const item = library.items[jobId];
      if (parts.length === 2 && method === 'PATCH') {
        if (owns(payload, 'alias')) item.alias = checkedText(payload.alias, '显示名称', 200);
        if (owns(payload, 'folder_ids')) {
          if (!Array.isArray(payload.folder_ids)) fail('文件夹列表必须是数组。');
          item.folder_ids = unique(payload.folder_ids.filter((folder) => !String(folder).startsWith('system-')));
          for (const folder of item.folder_ids) find(library.folders, folder, '文件夹');
        }
        if (owns(payload, 'values')) {
          if (!object(payload.values)) fail('属性值必须是对象。');
          for (const [key, value] of Object.entries(payload.values)) item.values[key] = validatePropertyValue(find(library.properties, key, '属性'), value);
        }
        if (owns(payload, 'progress')) {
          if (!object(payload.progress)) fail('阅读进度必须是对象。');
          const progress = { ...item.progress, updated_at: now() };
          for (const key of ['page', 'scroll_top', 'percent']) if (owns(payload.progress, key)) {
            const value = Number(payload.progress[key] || 0);
            if (!Number.isFinite(value)) fail('阅读进度必须是有限数字。');
            progress[key] = key === 'page' ? Math.max(1, Math.trunc(value)) : key === 'percent' ? Math.max(0, Math.min(100, Math.round(value * 100) / 100)) : Math.max(0, Math.round(value * 100) / 100);
          }
          item.progress = progress;
        }
        item.updated_at = now();
        return libraryPayload(state, { item });
      }
      if (parts.length === 3 && ['trash', 'restore'].includes(parts[2]) && method === 'POST') {
        item.deleted_at = parts[2] === 'trash' ? now() : null;
        item.updated_at = now();
        return libraryPayload(state, { item });
      }
      if (parts.length === 3 && parts[2] === 'permanent' && method === 'DELETE') { removeItem(state, jobId); return libraryPayload(state); }
      if (parts.length === 3 && parts[2] === 'metadata') {
        if (method === 'GET') return { metadata: item.metadata };
        if (method !== 'PATCH') unsupported();
        const fields = payload.fields || payload;
        if (!object(fields)) fail('元数据字段必须是对象。');
        for (const [key, value] of Object.entries(fields)) {
          if (!metadataFields.includes(key)) fail(`未知元数据字段：${key}`);
          if (['authors', 'keywords'].includes(key)) item.metadata.fields[key] = limitedList(value);
          else if (key === 'year') {
            const year = value === null || value === '' ? null : Number(value);
            if (year !== null && (!Number.isInteger(year) || year < 1000 || year > new Date().getFullYear() + 2)) fail('出版年份无效。');
            item.metadata.fields.year = year;
          } else item.metadata.fields[key] = String(value || '').trim().slice(0, key === 'abstract' ? 12000 : 2000);
          item.metadata.sources[key] = { provider: 'user', confidence: 1, retrieved_at: now() };
        }
        item.metadata.locked_fields = unique([...list(item.metadata.locked_fields), ...Object.keys(fields)]).filter((field) => !list(payload.unlock_fields).includes(field));
        item.metadata.error = '';
        item.updated_at = now();
        return libraryPayload(state, { metadata: item.metadata });
      }
    }
    unsupported();
  }

  function removeItem(state, jobId) {
    documentFor(state, jobId);
    if (!state.library.items[jobId].deleted_at) fail('请先将文献移入回收站。');
    delete state.library.items[jobId];
    delete state.documents[jobId];
    state.jobs = state.jobs.filter((job) => job.job_id !== jobId);
    state.library.permanently_deleted.push(jobId);
  }

  function highlightsFor(doc) {
    const blocks = list(doc.document.pages).flatMap((page) => list(page.elements).map((block) => ({ ...block, page: page.page })));
    const patterns = [/solely on attention|based solely on attention/i, /scaled dot.product|queries.*keys/i, /multi.head attention|different representation subspaces/i];
    return patterns.map((pattern, index) => blocks.find((block) => block.block_id && typeof block.text === 'string' && pattern.test(block.text))).filter(Boolean).map((block, index) => ({ block_id: block.block_id, page: block.page, quote: block.text.slice(0, 10000), category: index ? 'method' : 'research_goal', reason: `【示例】${index ? '这一段介绍 Attention 样例的方法机制。' : '这一段概括 Attention 样例的研究目标。'}` }));
  }

  function aiResponse(doc, route, payload) {
    if (route === 'translate') {
      const language = String(payload.target_language || '中文').toLowerCase();
      if (!['中文', 'zh', 'zh-cn', 'zh-hans', 'chinese', '简体中文'].includes(language)) unsupported();
      if (payload.refresh) fail('【示例】演示仅提供公开归档译文，不能调用模型重新翻译。', 501, 'demo_translation_unavailable');
      const source = String(payload.text || '').trim();
      const record = doc.translations.find((entry) => payload.block_id ? entry.block_id === payload.block_id && (payload.source_hash && entry.source_hash ? payload.source_hash === entry.source_hash : String(entry.source_text || '').trim() === source) : source && String(entry.source_text || '').trim() === source);
      if (!record) fail('【示例】该选区没有公开归档译文；浏览器演示不调用真实模型，也不生成任意翻译。', 501, 'demo_translation_unavailable');
      return { result: { ...record, cached: true, demo: true, notice: '【示例】公开归档译文；未调用真实模型。' } };
    }
    if (route === 'chat') {
      if (payload.selected_image) fail('【示例】浏览器演示不提供图片模型分析。', 501, 'demo_unsupported');
      const question = String(list(payload.messages).at(-1)?.content || '');
      let text = '【示例回答｜未调用真实模型】\n\n《Attention Is All You Need》提出 Transformer：以注意力机制构建编码器与解码器。公开样例前五页介绍了模型结构、缩放点积注意力、多头注意力和嵌入层。你可以在本地保存笔记、标注与聊天记录；此回答是预制示例。';
      if (/softmax|缩放|点积|scaled|sqrt|公式/i.test(question)) text = '【示例回答｜未调用真实模型】\n\n论文的缩放点积注意力为 Attention(Q,K,V)=softmax(QKᵀ/√dₖ)V。Q 与 K 的点积用于得到相关性分数，除以 √dₖ 控制分数尺度，再用 softmax 权重对 V 加权求和。此内容来自公开 Attention 样例的方法说明。';
      else if (/multi.?head|多头/i.test(question)) text = '【示例回答｜未调用真实模型】\n\n多头注意力对 Q、K、V 分别做多组线性投影，并行执行注意力，然后拼接各头输出并再次投影。论文用它让模型同时关注不同位置与表示子空间。这是公开 Attention 样例的预制解释。';
      else if (/位置|position/i.test(question)) text = '【示例回答｜未调用真实模型】\n\nTransformer 使用位置编码表示序列顺序。当前五页公开样例未包含位置编码章节，因此这里仅展示预设说明，不作为对样例正文的引用。';
      return { result: { text, model: 'Attention 示例助手', demo: true } };
    }
    if (route === 'reference-summary') return { result: { text: '【示例】此处展示参考文献摘要交互。Attention 样例讨论了注意力机制、序列转导与 Transformer；演示没有检索或阅读全文之外的参考文献。', evidence_level: 'demo', sources: [{ provider: 'public-demo', label: 'Attention 公开样例（示例）' }], demo: true } };
    if (route === 'auto-highlights') return { result: { status: 'demo', highlights: highlightsFor(doc), demo: true, notice: '【示例】基于公开 Attention 样例的预制阅读建议。' } };
    unsupported();
  }

  function vocabularyRoute(state, method, parts, payload) {
    if (!parts.length && method === 'GET') return { entries: state.vocabulary };
    if (!parts.length && method === 'POST') {
      const term = named(payload.term, '生词', 120);
      if (/\p{Cc}/u.test(term)) fail('请仅保存单词或短语，不含换行。');
      const language = String(payload.language || 'auto').toLowerCase();
      if (!/^[a-z][a-z0-9-]{0,34}$/.test(language)) fail('语言代码无效。');
      if (!object(payload.source)) fail('请提供生词所在文献。');
      const source = clone(payload.source);
      documentFor(state, source.job_id);
      const job = state.jobs.find((entry) => entry.job_id === source.job_id);
      checkedText(source.quote || '', '原句', 20000);
      Object.assign(source, { title: state.library.items[source.job_id].metadata?.fields?.title || job.title || job.source_filename, source_filename: job.source_filename || '', source_sha256: job.source_sha256 || '', selected_text: term, surface: source.surface || 'source' });
      if (!['source', 'paper', 'translation'].includes(source.surface)) fail('生词来源视图无效。');
      for (const key of ['page', 'start', 'end']) if (source[key] != null && (!Number.isInteger(source[key]) || source[key] < 0)) fail('生词位置无效。');
      if ((source.start != null) !== (source.end != null) || (source.start != null && source.end <= source.start)) fail('生词选区起止位置无效。');
      const key = (value) => value.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
      let entry = state.vocabulary.find((entry) => entry.language === language && key(entry.term) === key(term));
      const created = !entry;
      if (!entry) {
        entry = { id: id(), term, language, meaning: checkedText(payload.meaning || '', '释义', 10000), note: '', tags: normalizeTags(payload.tags || []), sources: [], created_at: now(), updated_at: now(), review: { status: 'new', review_count: 0, last_reviewed_at: null } };
        state.vocabulary.unshift(entry);
      }
      const signature = (entry) => JSON.stringify(['job_id', 'quote', 'surface', 'block_id', 'source_block_id', 'page', 'start', 'end', 'render_generation'].map((key) => entry[key] ?? null));
      if (!entry.sources.some((entry) => signature(entry) === signature(source))) { entry.sources.push(source); entry.updated_at = now(); }
      return { entry, created };
    }
    const entry = find(state.vocabulary, parts[0], '生词');
    if (parts.length === 1 && method === 'DELETE') { state.vocabulary = state.vocabulary.filter((item) => item !== entry); return { ok: true }; }
    if (parts.length === 1 && method === 'PATCH') {
      if (!Object.keys(payload).length || Object.keys(payload).some((key) => !['meaning', 'note', 'tags', 'details', 'only_if_meaning_empty', 'only_if_details_empty'].includes(key))) fail('生词只能修改释义、详细释义、笔记和标签。');
      for (const key of ['meaning', 'note']) if (owns(payload, key) && !(key === 'meaning' && payload.only_if_meaning_empty && entry.meaning.trim())) entry[key] = checkedText(payload[key], key === 'meaning' ? '释义' : '笔记', 10000);
      if (owns(payload, 'tags')) entry.tags = normalizeTags(payload.tags);
      if (owns(payload, 'details') && !(payload.only_if_details_empty && Object.values(entry.details || {}).some(Boolean))) {
        const limits = { part_of_speech: 500, meanings: 6000, synonyms: 2000, antonyms: 2000, examples: 8000, context_explanation: 6000 };
        if (!object(payload.details) || Object.keys(payload.details).some((key) => !owns(limits, key))) fail('详细释义字段无效。');
        entry.details = { ...entry.details };
        for (const [key, value] of Object.entries(payload.details)) entry.details[key] = checkedText(value, '详细释义', limits[key]);
      }
      entry.updated_at = now();
      return { entry };
    }
    if (parts.length === 2 && parts[1] === 'review' && method === 'POST') {
      if (Object.keys(payload).length !== 1 || !['learning', 'mastered'].includes(payload.status)) fail('复习状态必须是 learning 或 mastered。');
      entry.review = { status: payload.status, review_count: entry.review.review_count + 1, last_reviewed_at: now() };
      entry.updated_at = now();
      return { entry };
    }
    if (parts.length === 2 && parts[1] === 'explain' && method === 'POST') {
      const explanations = { attention: '【示例】注意力：根据查询与键的相关性，对值进行加权组合。', transformer: '【示例】Transformer：Attention 论文提出的基于注意力的编码器与解码器架构。', 'self-attention': '【示例】自注意力：查询、键和值都来自同一序列的注意力机制。' };
      const meaning = explanations[entry.term.toLowerCase()];
      if (!meaning) fail('【示例】仅提供 attention、transformer、self-attention 的预制释义，其他词条可手动编辑。', 501, 'demo_unsupported');
      return { details: { part_of_speech: '【示例】名词', meanings: meaning, synonyms: '【示例】未提供。', antonyms: '【示例】无直接反义词。', examples: '【示例】未生成例句。', context_explanation: '【示例】基于公开 Attention 样例；未调用真实模型。' }, model: 'Attention 示例助手', demo: true };
    }
    unsupported();
  }
  function normalizeTags(value) {
    if (!Array.isArray(value) || value.length > 30) fail('标签必须是最多 30 项的列表。');
    return unique(value.map((tag) => checkedText(tag, '标签', 80)).filter(Boolean));
  }

  function pluginRoute(state, method, parts, payload) {
    if (!parts.length && method === 'GET') return { plugins: [vocabularyPlugin()] };
    if (parts.length === 1 && parts[0] === 'runtime-event' && method === 'POST') {
      if (payload.pluginId !== vocabularyManifest.id || payload.pluginSession !== 'browser-demo-v1') fail('演示插件会话无效。', 403);
      return {};
    }
    if (parts.length !== 2 || parts[0] !== vocabularyManifest.id || parts[1] !== 'invoke' || method !== 'POST') unsupported();
    if (payload.pluginSession !== 'browser-demo-v1' || payload.previewSession) fail('演示插件会话无效。', 403);
    const args = payload.arguments;
    if (!object(args)) fail('插件能力参数必须是对象。');
    const name = payload.name;
    const vocabulary = { vocabulary_list: ['GET', []], vocabulary_save: ['POST', []], vocabulary_update: ['PATCH', [args.entry_id]], vocabulary_delete: ['DELETE', [args.entry_id]], vocabulary_review: ['POST', [args.entry_id, 'review']], vocabulary_explain: ['POST', [args.entry_id, 'explain']] };
    if (owns(vocabulary, name)) {
      const [verb, routeParts] = vocabulary[name];
      const body = { ...args };
      delete body.entry_id;
      return { result: vocabularyRoute(state, verb, routeParts, body) };
    }
    if (name === 'translate_text') {
      if (!args.requestId) documentFor(state, args.job_id);
      return { result: { authorized: true } };
    }
    if (name === 'open_source') {
      if (!object(args.source)) fail('来源必须是对象。');
      documentFor(state, args.source.job_id);
      return { result: { authorized: true } };
    }
    if (['storage_get', 'storage_set', 'storage_remove'].includes(name)) {
      const key = named(args.key, 'storage key', 200);
      if (!(state.pluginStorage instanceof Map)) state.pluginStorage = new Map();
      if (name === 'storage_get') return { result: { value: state.pluginStorage.get(key) ?? null } };
      if (name === 'storage_set') {
        if (!owns(args, 'value')) fail('storage_set 缺少 value。');
        state.pluginStorage.set(key, args.value);
      } else state.pluginStorage.delete(key);
      if (new TextEncoder().encode(JSON.stringify(Object.fromEntries(state.pluginStorage))).length > 1024 * 1024) fail('插件 storage 超过 1 MiB。');
      return { result: { ok: true } };
    }
    unsupported();
  }

  function route(state, method, path, payload, nextRevision) {
    const parts = path.split('/').filter(Boolean);
    if (path === '/api/health' && method === 'GET') return { ...state.health, readonly: false, mode: 'browser-demo', demo: true, ai: { ...state.health.ai, services: services() }, account: { authenticated: false }, storage: { library_id: databaseName, migration: { active: false } } };
    if (path === '/api/jobs' && method === 'GET') return { jobs: state.jobs };
    if (path === '/api/settings') {
      if (method === 'GET') return state.settings;
      if (['POST', 'PUT'].includes(method)) return saveSettings(state, payload);
    }
    if (path === '/api/parsing/providers' && method === 'GET') return { providers: [], active_provider_id: 'browser-demo', demo: true };
    if (path === '/api/account/status' && method === 'GET') return { authenticated: false, demo: true };
    if (parts[1] === 'plugins') return pluginRoute(state, method, parts.slice(2), payload);
    if (path === '/api/capabilities' && method === 'GET') return { tools: [] };
    if (parts[1] === 'library') return libraryRoute(state, method, parts.slice(2), payload);
    if (parts[1] === 'vocabulary') return vocabularyRoute(state, method, parts.slice(2), payload);
    if (parts[1] !== 'jobs' || parts.length < 3) unsupported();
    const jobId = parts[2];
    const doc = documentFor(state, jobId);
    if (parts.length === 3 && method === 'GET') return state.jobs.find((job) => job.job_id === jobId);
    const resource = parts[3];
    if (parts.length === 4 && resource === 'notes') {
      if (method === 'GET') return doc.notes;
      if (method === 'PUT') {
        if (typeof payload.expected_revision !== 'string') fail('保存笔记必须提供读取时的 expected_revision。');
        if (payload.expected_revision !== doc.notes.revision) fail('笔记已被其他窗口更新，请重新读取后合并。', 409, 'revision_conflict');
        doc.notes = { markdown: payload.markdown, revision: nextRevision };
        return { ...doc.notes, saved_at: now() };
      }
    }
    if (resource === 'annotations') {
      if (parts.length === 4 && method === 'GET') return annotationPayload(state, doc);
      if (parts.length === 4 && method === 'DELETE') {
        const removed = doc.annotations.filter((entry) => entry.source !== 'ai').length;
        doc.annotations = doc.annotations.filter((entry) => entry.source === 'ai');
        return annotationPayload(state, doc, { deleted: removed });
      }
      if (parts.length === 4 && method === 'POST') {
        const quote = named(payload.quote, '划线内容', 10000);
        const source = payload.source === 'ai' ? 'ai' : 'manual';
        const action = source === 'manual' ? actionSnapshot(state, payload) : {};
        const kind = action.kind || payload.kind || 'highlight';
        if (!['highlight', 'underline'].includes(kind)) fail('标注类型只能是 highlight 或 underline。');
        const candidate = { id: id(), kind, color: color(payload.color), category: String(payload.category || 'method'), quote, note: String(payload.note || '').slice(0, 10000), page: payload.page ?? null, block_id: payload.block_id ?? null, start: payload.start ?? null, end: payload.end ?? null, source, quote_prefix: String(payload.quote_prefix || '').slice(-48), quote_suffix: String(payload.quote_suffix || '').slice(0, 48), render_generation: String(payload.render_generation || state.jobs.find((job) => job.job_id === jobId).active_render || 'base'), created_at: now(), ...action };
        if (['paper', 'translation'].includes(payload.surface)) candidate.surface = payload.surface;
        if (payload.source_block_id) candidate.source_block_id = String(payload.source_block_id);
        if (source === 'ai') Object.assign(candidate, { suggestion_state: 'suggested', suggestion_key: `${candidate.block_id || ''}:${quote}:${candidate.category}` });
        const precise = Number.isFinite(candidate.start) && Number.isFinite(candidate.end) && candidate.end > candidate.start;
        const fields = ['kind', 'block_id', 'quote', 'source', 'action_id', ...(source === 'manual' && precise ? ['surface', 'source_block_id', 'page', 'start', 'end'] : [])];
        const existing = doc.annotations.find((entry) => fields.every((key) => (entry[key] ?? null) === (candidate[key] ?? null)));
        if (existing) return annotationPayload(state, doc, { annotation: existing });
        doc.annotations.push(candidate);
        return annotationPayload(state, doc, { annotation: candidate });
      }
      if (parts.length === 5 && ['PATCH', 'DELETE'].includes(method)) {
        const annotation = find(doc.annotations, parts[4], '笔记标记');
        if (method === 'DELETE') { doc.annotations = doc.annotations.filter((entry) => entry !== annotation); return annotationPayload(state, doc); }
        if (owns(payload, 'note')) annotation.note = checkedText(payload.note || '', '标注笔记', 10000, false);
        if (owns(payload, 'color')) annotation.color = color(payload.color);
        if (owns(payload, 'kind')) {
          if (annotation.source === 'ai' || !['highlight', 'underline'].includes(payload.kind)) fail('只有人工标注可以切换高亮或划线。');
          const fields = ['surface', 'source_block_id', 'page', 'block_id', 'start', 'end', 'quote', 'action_id'];
          if (doc.annotations.some((entry) => entry !== annotation && entry.source !== 'ai' && entry.kind === payload.kind && fields.every((key) => (entry[key] ?? null) === (annotation[key] ?? null)))) fail('同一选区已存在目标类型的标注。', 409);
          annotation.kind = payload.kind;
        }
        if (owns(payload, 'suggestion_state')) {
          if (annotation.source !== 'ai' || !['suggested', 'ignored'].includes(payload.suggestion_state)) fail('AI 建议状态无效。');
          annotation.suggestion_state = payload.suggestion_state;
        }
        if (owns(payload, 'action_id') || owns(payload, 'label')) Object.assign(annotation, actionSnapshot(state, { ...annotation, ...payload }));
        return annotationPayload(state, doc, { annotation });
      }
    }
    if (parts.length === 4 && resource === 'media-layout') {
      if (method === 'GET') return { media_layout: doc.media_layout };
      if (method === 'PATCH') {
        if (Object.keys(payload).length !== 1 || !object(payload.items) || Object.keys(payload.items).length > 2048) fail('媒体布局请求只能包含 items 对象，最多 2048 项。');
        for (const [key, value] of Object.entries(payload.items)) {
          if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(key) || !object(value) || Object.keys(value).length !== 1 || typeof value.width_percent !== 'number' || !Number.isFinite(value.width_percent) || value.width_percent < 24 || value.width_percent > 100) fail('媒体宽度必须在 24 到 100 之间。');
          doc.media_layout.items[key] = { width_percent: value.width_percent };
        }
        if (Object.keys(doc.media_layout.items).length > 2048 || new TextEncoder().encode(JSON.stringify(doc.media_layout)).length > 512 * 1024) fail('媒体布局超过大小限制。');
        return { media_layout: doc.media_layout };
      }
    }
    if (parts.length === 4 && resource === 'translations' && method === 'GET') return { translations: doc.translations, profile_id: profileId };
    if (parts.length === 4 && resource === 'auto-highlights' && method === 'GET') return { result: doc.highlights || { status: 'not-run', highlights: [], demo: true } };
    if (parts.length === 4 && resource === 'ai-review' && method === 'GET') return { result: { status: 'not-run', reason: '浏览器演示不运行真实 AI 复核。', demo: true } };
    if (parts.length === 4 && ['translate', 'chat', 'reference-summary', 'auto-highlights'].includes(resource) && method === 'POST') {
      const response = aiResponse(doc, resource, payload);
      if (resource === 'auto-highlights') doc.highlights = response.result;
      return response;
    }
    unsupported();
  }

  function assetAllowed(url) {
    const prefix = `/api/jobs/${seedJobId}/`;
    if (!url.pathname.startsWith(prefix)) return false;
    const relative = url.pathname.slice(prefix.length);
    const queryAllowed = [...url.searchParams].every(([key, value]) => ['reader', 'download'].includes(key) && value === '1');
    return queryAllowed && /^(?:(?:renders\/[1-9][0-9]{0,8}\/)?(?:document\.html|assets\/images\/[a-zA-Z0-9][a-zA-Z0-9._@-]{0,180}\.(?:png|jpe?g|webp|gif|svg)|pages\/[a-zA-Z0-9][a-zA-Z0-9._@-]{0,180}\.(?:png|jpe?g|webp)|assets\/pages\/[a-zA-Z0-9][a-zA-Z0-9._@-]{0,180}\.jpg)|source\.pdf|content\/(?:manifest\.json|english\/blocks\.json))$/.test(relative);
  }

  async function demoFetch(input, init) {
    if (!enabled) return nativeFetch(input, init);
    const request = input instanceof Request ? input : null;
    const signal = init?.signal || request?.signal;
    if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    try {
      const url = new URL(request?.url || String(input), window.location.href);
      const method = String(init?.method || request?.method || 'GET').toUpperCase();
      if (url.origin !== window.location.origin || url.username || url.password || url.hash) fail('浏览器演示只允许当前站点的公开样例资源。', 403, 'demo_network_blocked');
      await ready;
      if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
      if (method === 'GET' && assetAllowed(url)) {
        const available = await transaction(false, (state) => ({ output: Boolean(state.documents[seedJobId]) }));
        if (!available) fail('样例已在本地清除，请重置演示以恢复。', 404);
        return nativeFetch(url.pathname + url.search, { method: 'GET', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', ...(signal ? { signal } : {}) });
      }
      const allTranslations = method === 'GET' && url.pathname === `/api/jobs/${seedJobId}/translations` && url.searchParams.size === 1 && url.searchParams.get('scope') === 'all';
      if (url.search && !allTranslations) fail('演示 API 不接受此查询参数。', 400);
      let payload = {};
      if (!['GET', 'HEAD'].includes(method)) {
        const body = init && owns(init, 'body') ? init.body : request ? await request.clone().text() : '';
        if (body && typeof body !== 'string') unsupported();
        if (typeof body === 'string' && body.length > 5 * 1024 * 1024) fail('请求内容超过本地演示大小限制。', 413);
        try { payload = body ? JSON.parse(body) : {}; } catch (_) { fail('请求必须包含有效 JSON。'); }
        if (!object(payload)) fail('请求 JSON 必须是对象。');
      }
      let nextRevision;
      if (method === 'PUT' && /^\/api\/jobs\/[^/]+\/notes$/.test(url.pathname)) {
        if (typeof payload.markdown !== 'string' || new TextEncoder().encode(payload.markdown).length > 2_000_000) fail('笔记必须是字符串且不超过 2 MB。');
        nextRevision = await sha256(payload.markdown);
      }
      const write = !['GET', 'HEAD'].includes(method);
      const output = await transaction(write, (state) => {
        if (!state) fail('本地演示尚未初始化，请刷新。', 503);
        const output = route(state, method, url.pathname, payload, nextRevision);
        if (write) state.library.updated_at = now();
        return { ...(write ? { state } : {}), output };
      });
      if (payload.stream && output.result?.text) {
        const text = output.result.text;
        return new Response(`data: ${JSON.stringify({ delta: text })}\n\ndata: ${JSON.stringify(output)}\n\n`, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-My-Scholar-Demo': 'browser-local-v1' } });
      }
      const created = method === 'POST' && (/^\/api\/library\/(folders|properties|views)$/.test(url.pathname) || /^\/api\/jobs\/[^/]+\/annotations$/.test(url.pathname));
      return json(output, created ? 201 : 200);
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      return json({ error: error instanceof DemoError ? error.message : '本地演示操作失败，数据未确认保存。请刷新后重试。', code: error instanceof DemoError ? error.code : 'demo_storage_failed', demo: true }, error instanceof DemoError ? error.status : 503);
    }
  }

  async function reset() {
    if (!enabled) return;
    invalidate();
    await ready.catch(() => {});
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(databaseName);
      request.onsuccess = resolve;
      request.onerror = () => reject(new DemoError('无法清除本地演示数据。', 503, 'demo_storage_failed'));
      request.onblocked = () => reject(new DemoError('请关闭其他演示标签页后重试重置。', 503, 'demo_storage_blocked'));
    });
    for (const key of Object.keys(localStorage)) if (key.startsWith(statePrefix)) localStorage.removeItem(key);
  }

  window.MyScholarDemo = Object.freeze({ enabled, statePrefix, ready, fetch: demoFetch, reset, readingSource, get invalidated() { return invalidated; } });
})();
