(function attachZoteroImport(root) {
  'use strict';

  const endpoint = '/api/integrations/zotero';
  const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

  function itemImportReason(item) {
    return item.attachments?.length ? '' : String(item.reason || '没有本机可用的 PDF 附件；请先在 Zotero 中下载 PDF。');
  }

  function collectionLabels(collections) {
    const byKey = new Map(collections.map((collection) => [collection.key, collection]));
    return collections.map((collection) => {
      const names = [collection.name];
      const seen = new Set([collection.key]);
      let parent = byKey.get(collection.parent_key);
      while (parent && !seen.has(parent.key)) {
        names.unshift(parent.name);
        seen.add(parent.key);
        parent = byKey.get(parent.parent_key);
      }
      return { key: collection.key, label: names.join(' / ') };
    });
  }

  function resultDescription(result) {
    const labels = { imported: '已复制到本机', existing: '已关联本机已有文献', failed: '导入失败', skipped: '已跳过' };
    const parts = [labels[result.status] || result.status || '已处理'];
    if (result.error) parts.push(`错误：${result.error}`);
    if (Array.isArray(result.warnings)) parts.push(...result.warnings.map(String));
    else if (result.warnings) parts.push(String(result.warnings));
    if (result.notes_count > 0) parts.push(`${result.notes_count} 条笔记`);
    if (result.annotations_count > 0) parts.push(`${result.annotations_count} 条标注`);
    if (result.pending && !result.error) parts.push('正文正在解析；附属笔记与标注将在解析完成后呈现');
    if (result.unanchored_count > 0) parts.push(`${result.unanchored_count} 条标注未能唯一定位，已保留笔记与页码`);
    return parts.join(' · ');
  }

  function batchSummary(batch) {
    if (batch.status === 'running') return `正在复制 PDF · ${batch.completed || 0}/${batch.total || 0} 已处理`;
    const counts = { imported: 0, existing: 0, failed: 0, skipped: 0, pending: 0 };
    for (const result of batch.results || []) {
      if (Object.hasOwn(counts, result.status)) counts[result.status] += 1;
      if (result.pending && !result.error) counts.pending += 1;
    }
    const parts = [batch.status === 'failed' ? '批次已停止' : 'PDF 导入复制结束'];
    for (const [key, label] of [['imported', '新增'], ['existing', '已有'], ['failed', '失败'], ['skipped', '跳过']]) {
      if (counts[key]) parts.push(`${label} ${counts[key]} 篇`);
    }
    if (counts.pending) parts.push(`${counts.pending} 篇正文仍在解析`);
    return parts.join(' · ');
  }

  function shouldPollBatch(batch) {
    return batch?.status === 'running' || (batch?.results || []).some((result) => result.pending === true && !result.error);
  }

  function buildImportBody(library, selected, folderId = '') {
    return { library, items: [...selected.values()].map(({ item_key, attachment_key }) => ({ item_key, attachment_key })), ...(folderId ? { folder_id: folderId } : {}) };
  }

  function selectionForItems(items, selected, choices) {
    let unavailable = 0, ambiguous = 0;
    for (const item of items) {
      const attachments = Array.isArray(item.attachments) ? item.attachments : [];
      if (!attachments.length) { selected.delete(item.key); unavailable += 1; continue; }
      const chosen = selected.get(item.key)?.attachment_key || choices.get(item.key) || (attachments.length === 1 ? attachments[0].key : '');
      if (!attachments.some((attachment) => attachment.key === chosen)) { selected.delete(item.key); ambiguous += 1; continue; }
      selected.set(item.key, { item_key: item.key, attachment_key: chosen, title: item.title });
    }
    return { unavailable, ambiguous };
  }

  function importChunks(selected) {
    const items = [...selected.values()];
    return Array.from({ length: Math.ceil(items.length / 100) }, (_, index) => items.slice(index * 100, (index + 1) * 100));
  }

  function create({ dialog, request, getTargetFolder = () => null, onComplete = () => {} }) {
    if (!dialog) return null;
    const document = dialog.ownerDocument;
    const $ = (selector) => dialog.querySelector(selector);
    const state = {
      connected: false, busy: false, library: '', collection: '', query: '', items: [], total: 0,
      start: 0, nextStart: null, previousStarts: [], selected: new Map(), attachments: new Map(),
      target: null, batch: null, refreshedKey: '', pollTimer: null, polling: false, generation: 0,
      selecting: false, selectionGeneration: 0, run: null,
    };
    const openButtons = [...document.querySelectorAll('[data-open-zotero-import]')];
    const selectionActions = document.createElement('div');
    selectionActions.id = 'zotero-selection-actions';
    selectionActions.className = 'dialog-actions';
    selectionActions.innerHTML = '<button id="zotero-select-all" class="secondary-button compact-button" type="button">全选当前筛选结果</button><button id="zotero-cancel-select-all" class="secondary-button compact-button" type="button" hidden>取消全选</button><button id="zotero-clear-selection" class="secondary-button compact-button" type="button">清空选择</button><span id="zotero-selection-progress" role="status" aria-live="polite"></span>';
    $('#zotero-items').before(selectionActions);
    const resultDialog = document.createElement('dialog');
    resultDialog.id = 'zotero-result-dialog';
    resultDialog.className = 'library-dialog zotero-import-dialog';
    resultDialog.setAttribute('aria-labelledby', 'zotero-result-title');
    resultDialog.innerHTML = '<form method="dialog"><div class="dialog-heading"><h2 id="zotero-result-title">Zotero 导入结果</h2></div><div class="dialog-content"><p id="zotero-result-summary" role="status" aria-live="polite"></p><p id="zotero-result-explanation"></p><ol id="zotero-result-details" class="zotero-results"></ol></div><div class="dialog-actions"><button id="zotero-continue-import" class="secondary-button" type="button">继续导入</button><button id="zotero-finish-import" class="primary-button" type="button">已完成</button></div></form>';
    document.body.append(resultDialog);
    const resultNode = (selector) => resultDialog.querySelector(selector);

    function displayBatch() {
      if (!state.run) return state.batch;
      const batches = [...state.run.batches.values()];
      return {
        id: batches[0]?.id || '', total: state.run.total,
        status: state.run.queue.length || state.run.submitting || state.batch?.status === 'running' ? 'running' : state.run.error || batches.some((batch) => batch.status === 'failed') ? 'failed' : 'completed',
        completed: batches.reduce((total, batch) => total + (batch.completed || 0), 0) + state.run.skipped.length,
        results: [...batches.flatMap((batch) => batch.results || []), ...state.run.skipped],
        error: state.run.error || batches.find((batch) => batch.error)?.error,
      };
    }

    function status(message = '', error = false) {
      $('#zotero-status').textContent = message;
      $('#zotero-status').classList.toggle('error', error);
    }

    function syncControls() {
      const running = displayBatch()?.status === 'running';
      const disabled = state.busy || running || state.selecting;
      $('#zotero-connect').disabled = disabled;
      $('#zotero-connect').textContent = state.connected ? '重新连接' : '连接 Zotero';
      for (const id of ['library', 'collection', 'search', 'search-button']) $(`#zotero-${id}`).disabled = disabled || !state.connected;
      $('#zotero-prev').disabled = disabled || !state.previousStarts.length;
      $('#zotero-next').disabled = disabled || state.nextStart === null;
      $('#zotero-import-selected').disabled = disabled || !state.connected || !state.selected.size;
      $('#zotero-select-all').disabled = disabled || !state.connected || !state.total;
      $('#zotero-clear-selection').disabled = disabled || !state.selected.size;
      $('#zotero-cancel-select-all').hidden = !state.selecting;
      $('#zotero-selection-count').textContent = `已选 ${state.selected.size} 篇（跨页保留）`;
      $('#zotero-page-status').textContent = state.total ? `${state.start + 1}–${state.start + state.items.length} / ${state.total}` : '0 篇';
      $('#zotero-target').textContent = `导入到：${state.target?.name || '本机文献库'}${running ? ' · 关闭窗口后仍会继续复制' : ''}`;
      $('#zotero-items').setAttribute('aria-busy', String(state.busy));
      $('#zotero-items').querySelectorAll('input,select').forEach((input) => {
        input.disabled = disabled || input.dataset.unavailable === 'true';
      });
    }

    function renderItems() {
      const list = $('#zotero-items');
      if (!state.items.length) {
        list.innerHTML = `<p class="zotero-empty">${state.connected ? '没有匹配的文献。试试其他分类或搜索词。' : '连接后选择个人库或组库，浏览本机文献。'}</p>`;
        syncControls();
        return;
      }
      list.innerHTML = state.items.map((item, index) => {
        const attachments = Array.isArray(item.attachments) ? item.attachments : [];
        const reason = itemImportReason(item);
        const selected = state.selected.get(item.key);
        const choice = selected?.attachment_key || state.attachments.get(item.key) || (attachments.length === 1 ? attachments[0].key : '');
        if (choice) state.attachments.set(item.key, choice);
        const authors = Array.isArray(item.authors) ? item.authors.join('、') : item.authors || '';
        const tags = Array.isArray(item.tags) ? item.tags.map((tag) => typeof tag === 'string' ? tag : tag.tag || '').filter(Boolean).join(' · ') : '';
        const unavailable = Boolean(reason || !choice);
        return `<article class="zotero-item${reason ? ' is-unavailable' : ''}" data-zotero-item="${escapeHTML(item.key)}">
          <div class="zotero-item-heading"><input id="zotero-item-${index}" type="checkbox" data-zotero-select="${escapeHTML(item.key)}" data-unavailable="${unavailable}"${selected ? ' checked' : ''}${unavailable ? ' disabled' : ''}><label for="zotero-item-${index}">${escapeHTML(item.title || '未命名文献')}</label></div>
          <p class="zotero-item-meta">${escapeHTML([authors, item.year].filter(Boolean).join(' · '))}</p>
          ${tags ? `<p class="zotero-item-tags">${escapeHTML(tags)}</p>` : ''}
          ${reason ? `<p class="zotero-item-reason">${escapeHTML(reason)}</p>` : `<label class="zotero-attachment-field">PDF 附件<select data-zotero-attachment="${escapeHTML(item.key)}" aria-label="${escapeHTML(item.title || '文献')}的 PDF 附件">${attachments.length > 1 ? '<option value="">请选择要导入的 PDF</option>' : ''}${attachments.map((attachment) => `<option value="${escapeHTML(attachment.key)}"${attachment.key === choice ? ' selected' : ''}>${escapeHTML(attachment.filename || attachment.title || attachment.key)}</option>`).join('')}</select></label>${attachments.length > 1 ? '<p class="zotero-item-meta">含多个 PDF，请先选附件，再勾选文献。</p>' : ''}`}
        </article>`;
      }).join('');
      syncControls();
    }

    function renderBatch() {
      const batch = displayBatch();
      $('#zotero-batch').hidden = !batch;
      if (!batch) return;
      $('#zotero-batch-summary').textContent = batchSummary(batch);
      $('#zotero-progress').max = Math.max(1, batch.total || 0);
      $('#zotero-progress').value = batch.completed || 0;
      $('#zotero-progress').setAttribute('aria-valuetext', `${batch.completed || 0}/${batch.total || 0} 已处理`);
      const rows = (batch.results || []).map((result) => `<li class="zotero-result is-${escapeHTML(result.status)}"><strong>${escapeHTML(result.title || state.run?.titles.get(result.item_key) || result.item_key || '未命名文献')}</strong><span>${escapeHTML(resultDescription(result))}</span></li>`).join('');
      $('#zotero-results').innerHTML = rows;
      resultNode('#zotero-result-summary').textContent = batchSummary(batch);
      resultNode('#zotero-result-details').innerHTML = rows;
      resultNode('#zotero-result-explanation').textContent = (batch.results || []).some((result) => result.pending && !result.error) ? 'PDF 复制已完成；正文仍在解析，笔记和标注将在解析完成后呈现。可以关闭此窗口，解析会继续。' : '请查看每篇文献的成功、失败或跳过详情。';
      if (batch.error) status(String(batch.error), true);
      syncControls();
    }

    function stopPoll() {
      if (state.pollTimer !== null) root.clearTimeout(state.pollTimer);
      state.pollTimer = null;
    }

    function schedulePoll() {
      stopPoll();
      if (shouldPollBatch(displayBatch())) state.pollTimer = root.setTimeout(() => { state.pollTimer = null; void poll(); }, 900);
    }

    async function acceptBatch(batch) {
      state.batch = batch;
      state.run?.batches.set(batch.id, batch);
      $('#zotero-retry-progress').hidden = true;
      if (batch.status !== 'running') {
        if (!state.run?.cleared.has(batch.id)) {
          state.run?.cleared.add(batch.id);
          if (state.run && batch.status === 'failed') {
            const processed = new Set((batch.results || []).map((result) => result.item_key));
            state.run.skipped.push(...(state.run.itemsByBatch.get(batch.id) || []).filter((item) => !processed.has(item.item_key)).map((item) => ({ ...item, status: 'skipped', error: '批次中断，尚未完成导入；请核对后重试。' })));
          }
          if (!state.run || state.library === state.run.library) {
            for (const result of batch.results || []) {
              if (['imported', 'existing'].includes(result.status)) state.selected.delete(result.item_key);
            }
          }
        }
        renderItems();
        const combined = displayBatch();
        const refreshKey = JSON.stringify([combined.id, combined.results]);
        if (state.refreshedKey !== refreshKey) {
          state.refreshedKey = refreshKey;
          try { await onComplete(combined); }
          catch (error) { status(`复制已结束，但刷新文献库失败：${error.message}`, true); }
        }
        if (batch.status === 'failed' && state.run) {
          state.run.skipped.push(...state.run.queue.flat().map((item) => ({ ...item, status: 'skipped', error: '前一批次中断，本次尚未提交。' })));
          state.run.queue = [];
        }
        if (state.run?.queue.length) { await submitNext(); return; }
      }
      const combined = displayBatch();
      if (!combined.error) status(combined.status === 'running' ? '正在复制 PDF 到本机文献库。' : shouldPollBatch(combined) ? 'PDF 复制已结束，正在等待正文解析和附属数据处理。' : 'PDF 复制已结束，请查看逐项处理结果。');
      renderBatch();
      if (combined.status !== 'running' && state.run && !state.run.resultShown) {
        state.run.resultShown = true;
        if (dialog.open && !resultDialog.open) resultDialog.showModal();
      }
      schedulePoll();
    }

    async function poll() {
      if (!shouldPollBatch(displayBatch()) || state.polling) return;
      stopPoll();
      state.polling = true;
      const run = state.run;
      const currentId = state.batch.id;
      try {
        const batches = run ? [...run.batches.values()].filter(shouldPollBatch) : [state.batch];
        for (const batch of batches) {
          const payload = await request(`${endpoint}/imports/${encodeURIComponent(batch.id)}`);
          if (state.run !== run) return;
          if (run) run.batches.set(batch.id, payload.import);
          if (batch.id === currentId) state.batch = payload.import;
        }
        if (state.run === run) await acceptBatch(state.batch);
      } catch (error) {
        if (state.run !== run) return;
        status(`暂时无法读取导入进度：${error.message}。可以重试读取；不会重复提交导入。`, true);
        $('#zotero-retry-progress').hidden = false;
      } finally { state.polling = false; if (state.run !== run) schedulePoll(); }
    }

    async function loadItems({ reset = true, start = 0 } = {}) {
      const generation = ++state.generation;
      state.busy = true;
      status('正在读取 Zotero 文献…');
      syncControls();
      const params = new URLSearchParams({ library: state.library, collection: state.collection, q: state.query, start: String(start) });
      try {
        const payload = await request(`${endpoint}/items?${params}`);
        if (generation !== state.generation) return;
        state.items = Array.isArray(payload.items) ? payload.items : [];
        state.total = Number(payload.total) || 0;
        state.start = Number(payload.start) || 0;
        state.nextStart = Number.isInteger(payload.next_start) ? payload.next_start : null;
        if (reset) state.previousStarts = [];
        status('仅导入本机可用的 PDF；标签、笔记、高亮与下划线会一并导入。');
        renderItems();
      } catch (error) {
        if (generation !== state.generation) return;
        state.items = [];
        state.total = 0;
        state.nextStart = null;
        status(`读取 Zotero 文献失败：${error.message}`, true);
        renderItems();
      } finally {
        if (generation === state.generation) { state.busy = false; syncControls(); }
      }
    }

    async function loadLibrary() {
      state.busy = true;
      status('正在读取 Zotero 分类…');
      syncControls();
      try {
        const params = new URLSearchParams({ library: state.library });
        const payload = await request(`${endpoint}/collections?${params}`);
        $('#zotero-collection').innerHTML = '<option value="">全部文献</option>' + collectionLabels(payload.collections || []).map(({ key, label }) => `<option value="${escapeHTML(key)}">${escapeHTML(label)}</option>`).join('');
        state.collection = '';
        state.query = '';
        $('#zotero-search').value = '';
        await loadItems();
      } catch (error) {
        state.items = [];
        state.total = 0;
        state.nextStart = null;
        renderItems();
        status(`读取 Zotero 分类失败：${error.message}`, true);
      } finally { state.busy = false; syncControls(); }
    }

    async function connect() {
      state.busy = true;
      status('正在连接本机 Zotero…');
      syncControls();
      try {
        const payload = await request(`${endpoint}/status`);
        if (!payload.available) throw new Error(payload.error || '无法连接。请打开 Zotero，并在“设置 → 高级”中允许本机其他应用通信。');
        const libraries = Array.isArray(payload.libraries) ? payload.libraries : [];
        if (!libraries.length) throw new Error('Zotero 没有返回可访问的个人库或组库。');
        state.connected = true;
        $('#zotero-browser').hidden = false;
        $('#zotero-library').innerHTML = libraries.map((library) => `<option value="${escapeHTML(library.id)}">${escapeHTML(library.name)}</option>`).join('');
        if (!libraries.some((library) => library.id === state.library)) {
          state.library = libraries[0].id;
          state.selected.clear();
          state.attachments.clear();
        }
        $('#zotero-library').value = state.library;
        await loadLibrary();
      } catch (error) {
        state.connected = false;
        status(`连接失败：${error.message}`, true);
      } finally { state.busy = false; syncControls(); }
    }

    async function submitNext() {
      const run = state.run;
      const items = run.queue.shift();
      if (!items) return;
      run.submitting = true;
      state.busy = true;
      stopPoll();
      status('正在创建本机导入批次…');
      syncControls();
      try {
        const payload = await request(`${endpoint}/imports`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildImportBody(run.library, new Map(items.map((item) => [item.item_key, item])), run.folderId)) });
        run.submitting = false;
        run.itemsByBatch.set(payload.import.id, items);
        await acceptBatch(payload.import);
      } catch (error) {
        run.submitting = false;
        run.error = `创建导入失败：${error.message}。已提交的批次会继续；请核对结果后重新选择尚未导入的文献。`;
        run.skipped.push(...[items, ...run.queue].flat().map((item) => ({ ...item, status: 'skipped', error: '未确认已提交，请核对后重试。' })));
        run.queue = [];
        status(run.error, true);
        renderBatch();
        run.resultShown = true;
        if (dialog.open && !resultDialog.open) resultDialog.showModal();
        schedulePoll();
      } finally { state.busy = false; syncControls(); }
    }

    async function importSelected() {
      if (!state.connected || state.busy || state.selecting || !state.selected.size || displayBatch()?.status === 'running') return;
      state.run = { library: state.library, folderId: state.target?.id || '', total: state.selected.size, queue: importChunks(state.selected), batches: new Map(), itemsByBatch: new Map(), cleared: new Set(), skipped: [], titles: new Map([...state.selected].map(([key, item]) => [key, item.title])), resultShown: false, resultAcknowledged: false, submitting: false };
      state.batch = null;
      await submitNext();
    }

    async function selectAll() {
      if (state.selecting || state.busy || displayBatch()?.status === 'running') return;
      const generation = ++state.selectionGeneration;
      state.selecting = true;
      $('#zotero-selection-progress').textContent = '正在全选 · 已读取 0 篇';
      syncControls();
      const selected = new Map(state.selected);
      let start = 0, scanned = 0, unavailable = 0, ambiguous = 0;
      const seen = new Set();
      try {
        do {
          if (seen.has(start)) throw new Error('Zotero 分页没有前进，请重新读取文库。');
          seen.add(start);
          const params = new URLSearchParams({ library: state.library, collection: state.collection, q: state.query, start: String(start) });
          const payload = await request(`${endpoint}/items?${params}`);
          if (generation !== state.selectionGeneration) return;
          const items = Array.isArray(payload.items) ? payload.items : [];
          const skipped = selectionForItems(items, selected, state.attachments);
          unavailable += skipped.unavailable;
          ambiguous += skipped.ambiguous;
          scanned += items.length;
          if (scanned > 10000 || Number(payload.total) > 10000) throw new Error('筛选结果超过 10000 篇，请缩小范围。');
          $('#zotero-selection-progress').textContent = `正在全选 · 已读取 ${scanned}/${Number(payload.total) || scanned} 篇`;
          start = Number.isInteger(payload.next_start) ? payload.next_start : null;
        } while (start !== null);
        state.selected = selected;
        $('#zotero-selection-progress').textContent = `全选完成 · 无 PDF 跳过 ${unavailable} 篇 · 多 PDF 待选 ${ambiguous} 篇`;
        status('已选中当前筛选结果中可确定 PDF 的文献（包含全部分页）；多 PDF 条目请先选择附件。');
        renderItems();
      } catch (error) {
        if (generation === state.selectionGeneration) status(`全选失败：${error.message}；原选择保持不变。`, true);
      } finally {
        if (generation === state.selectionGeneration) { state.selecting = false; syncControls(); }
      }
    }

    function cancelSelectAll() {
      state.selectionGeneration += 1;
      state.selecting = false;
      $('#zotero-selection-progress').textContent = '已取消全选；原选择保持不变。';
      syncControls();
    }

    function open() {
      if (state.batch?.status !== 'running') state.target = getTargetFolder();
      syncControls();
      if (!dialog.open) dialog.showModal();
      if (shouldPollBatch(displayBatch())) void poll();
      if (displayBatch()?.status !== 'running' && state.run?.resultShown && !state.run.resultAcknowledged && !resultDialog.open) resultDialog.showModal();
    }
    const close = () => { if (state.selecting) cancelSelectAll(); dialog.close(); };
    const continueImport = () => { if (state.run) state.run.resultAcknowledged = true; resultDialog.close(); };
    const finishImport = () => { continueImport(); close(); };
    const clearSelection = () => { state.selected.clear(); $('#zotero-selection-progress').textContent = ''; renderItems(); };
    const search = () => { state.query = $('#zotero-search').value.trim(); void loadItems(); };
    const changeLibrary = () => {
      state.library = $('#zotero-library').value;
      state.selected.clear();
      state.attachments.clear();
      void loadLibrary();
    };
    const changeCollection = () => { state.collection = $('#zotero-collection').value; void loadItems(); };
    const previous = () => {
      const start = state.previousStarts.pop();
      if (start !== undefined) void loadItems({ reset: false, start });
    };
    const next = () => {
      if (state.nextStart === null) return;
      state.previousStarts.push(state.start);
      void loadItems({ reset: false, start: state.nextStart });
    };
    function changeItem(event) {
      const itemKey = event.target.dataset.zoteroSelect || event.target.dataset.zoteroAttachment;
      if (!itemKey) return;
      const item = state.items.find((value) => value.key === itemKey);
      if (!item) return;
      if (event.target.dataset.zoteroAttachment) {
        const choice = event.target.value;
        if (choice) state.attachments.set(itemKey, choice);
        else state.attachments.delete(itemKey);
        if (state.selected.has(itemKey)) {
          if (choice) state.selected.set(itemKey, { item_key: itemKey, attachment_key: choice, title: item.title });
          else state.selected.delete(itemKey);
        }
        renderItems();
      } else {
        const attachmentKey = state.attachments.get(itemKey);
        if (event.target.checked && attachmentKey) state.selected.set(itemKey, { item_key: itemKey, attachment_key: attachmentKey, title: item.title });
        else state.selected.delete(itemKey);
        syncControls();
      }
    }
    function searchKey(event) { if (event.key === 'Enter') { event.preventDefault(); search(); } }
    const listeners = [
      [$('#zotero-connect'), 'click', connect], [$('#zotero-close'), 'click', close],
      [$('#zotero-library'), 'change', changeLibrary], [$('#zotero-collection'), 'change', changeCollection],
      [$('#zotero-search-button'), 'click', search], [$('#zotero-search'), 'keydown', searchKey],
      [$('#zotero-prev'), 'click', previous], [$('#zotero-next'), 'click', next],
      [$('#zotero-items'), 'change', changeItem], [$('#zotero-import-selected'), 'click', importSelected],
      [$('#zotero-retry-progress'), 'click', poll],
      [$('#zotero-select-all'), 'click', selectAll], [$('#zotero-cancel-select-all'), 'click', cancelSelectAll], [$('#zotero-clear-selection'), 'click', clearSelection],
      [dialog, 'close', () => { if (state.selecting) cancelSelectAll(); }],
      [resultDialog, 'cancel', () => { if (state.run) state.run.resultAcknowledged = true; }],
      [resultNode('#zotero-continue-import'), 'click', continueImport], [resultNode('#zotero-finish-import'), 'click', finishImport], ...openButtons.map((button) => [button, 'click', open]),
    ];
    for (const [node, type, handler] of listeners) node.addEventListener(type, handler);
    root.addEventListener?.('pagehide', stopPoll);
    renderItems();
    return Object.freeze({ open, destroy() { stopPoll(); state.generation += 1; state.selectionGeneration += 1; selectionActions.remove(); resultDialog.remove(); for (const [node, type, handler] of listeners) node.removeEventListener(type, handler); root.removeEventListener?.('pagehide', stopPoll); } });
  }

  const api = Object.freeze({ create, itemImportReason, collectionLabels, resultDescription, batchSummary, shouldPollBatch, buildImportBody, selectionForItems, importChunks });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MyScholarZoteroImport = api;
})(typeof window === 'undefined' ? globalThis : window);
