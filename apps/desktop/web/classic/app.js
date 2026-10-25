(() => {
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const desktopPlatform = window.myScholarDesktop?.platform;
  const browserPlatform = navigator.userAgentData?.platform || navigator.platform || '';
  const appPlatform = ['darwin', 'win32', 'linux'].includes(desktopPlatform) ? desktopPlatform
    : /mac/iu.test(browserPlatform) ? 'darwin' : /win/iu.test(browserPlatform) ? 'win32' : 'linux';
  const isMacPlatform = appPlatform === 'darwin';
  const shortcutPrimaryModifier = isMacPlatform ? 'Cmd' : 'Ctrl';
  const shortcutLabel = (value) => String(value).replace(/\b(?:Cmd|Command|Meta|Windows|Win)\b/giu, isMacPlatform ? 'Cmd' : appPlatform === 'win32' ? 'Windows' : 'Meta').replace(/\b(?:Option|Alt)\b/giu, isMacPlatform ? 'Option' : 'Alt');
  $('#chat-input').placeholder = `针对当前文章提问…（Enter 发送，${isMacPlatform ? '⌘ Enter' : 'Ctrl+Enter'} 换行）`;
  $('#shortcut-library').value = `${shortcutPrimaryModifier}+1`;
  $('#shortcut-settings').value = `${shortcutPrimaryModifier}+,`;
  const state = { jobs: [], activeJob: null, selection: null, annotations: [], chat: [] };
  let pickedFile = null;
  let activeJobId = null;
  let pollHandle = null;

  const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const api = async (url, options = {}) => {
    const response = await fetch(url, options);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `请求失败（${response.status}）`);
    return payload;
  };
  const jsonOptions = (body, method = 'POST') => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  function selectionElement(rootDocument, event) {
    const selection = rootDocument?.getSelection?.();
    const node = selection?.anchorNode || event?.target || rootDocument?.activeElement;
    if (!node) return null;
    return node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  }

  function isEditableAppSurface(element) {
    return Boolean(element?.closest?.('input, textarea, [contenteditable="true"], .notes-preview'));
  }

  function guardAppSelection(event) {
    if (!isEditableAppSurface(selectionElement(document, event))) event.preventDefault();
  }

  document.addEventListener('selectstart', guardAppSelection);
  document.addEventListener('copy', guardAppSelection);

  function showError(message) {
    const node = $('#upload-error');
    node.textContent = message || '';
    node.hidden = !message;
  }

  function switchView(viewId) {
    $$('.view').forEach((view) => { view.hidden = view.id !== viewId; view.classList.toggle('active-view', view.id === viewId); });
    $$('.nav-button').forEach((button) => button.classList.toggle('active', button.dataset.view === viewId));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  $$('.nav-button').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.view)));
  $('#back-library').addEventListener('click', () => switchView('library-view'));

  function choose(file) {
    showError('');
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.pdf')) { showError('请选择 .pdf 文件。'); return; }
    pickedFile = file;
    $('#selected-file').textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB`;
    $('#selected-file').hidden = false;
    $('#upload-button').disabled = false;
  }

  const dropZone = $('#drop-zone');
  $('#choose-button').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', () => choose($('#file-input').files[0]));
  ['dragenter', 'dragover'].forEach((eventName) => dropZone.addEventListener(eventName, (event) => { event.preventDefault(); dropZone.classList.add('dragging'); }));
  ['dragleave', 'drop'].forEach((eventName) => dropZone.addEventListener(eventName, (event) => { event.preventDefault(); dropZone.classList.remove('dragging'); }));
  dropZone.addEventListener('drop', (event) => choose(event.dataTransfer.files[0]));

  function setProgress(job) {
    const value = Math.max(0, Math.min(100, Math.round((job.progress || 0) * 100)));
    $('#progress-card').hidden = false;
    $('#progress-bar').style.width = `${value}%`;
    $('#progress-value').textContent = `${value}%`;
    $('#progress-stage').textContent = job.stage || '处理中';
    $('#progress-detail').textContent = job.status === 'failed' ? (job.error || '转换失败') : '版面、图片、公式和表格正在生成可追溯结构…';
  }

  async function upload() {
    if (!pickedFile) return;
    showError('');
    const button = $('#upload-button');
    button.disabled = true; button.textContent = '解析中…';
    const form = new FormData(); form.append('file', pickedFile, pickedFile.name);
    try {
      const payload = await api('/api/jobs', { method: 'POST', body: form });
      activeJobId = payload.job.job_id; setProgress(payload.job); poll();
    } catch (error) { showError(error.message); button.disabled = false; }
    finally { button.textContent = '加入文献库'; }
  }
  $('#upload-button').addEventListener('click', upload);

  async function poll() {
    if (!activeJobId) return;
    try {
      const job = await api(`/api/jobs/${activeJobId}`); setProgress(job);
      if (job.status === 'completed') { window.clearTimeout(pollHandle); await loadLibrary(); openReader(job); return; }
      if (job.status === 'failed') { window.clearTimeout(pollHandle); showError(job.error || '转换失败'); $('#upload-button').disabled = false; await loadLibrary(); return; }
      pollHandle = window.setTimeout(poll, 700);
    } catch (error) { $('#progress-detail').textContent = error.message; pollHandle = window.setTimeout(poll, 1500); }
  }

  function renderLibrary(jobs = state.jobs) {
    const query = ($('#library-search').value || '').trim().toLowerCase();
    const filtered = jobs.filter((job) => !query || String(job.source_filename || '').toLowerCase().includes(query));
    $('#library-count').textContent = jobs.length;
    if (!filtered.length) { $('#recent-list').innerHTML = '<div class="empty-state">没有匹配的文献。</div>'; return; }
    $('#recent-list').innerHTML = filtered.map((job) => {
      const counts = job.manifest?.counts || {};
      const stateLabel = job.status === 'completed' ? '可阅读' : (job.status === 'failed' ? '失败' : '处理中');
      const date = job.created_at ? new Date(job.created_at).toLocaleDateString('zh-CN') : '';
      return `<article class="library-card" data-job-id="${escapeHTML(job.job_id)}"><div class="library-card-head"><span class="file-badge">PDF</span><div><div class="library-name" title="${escapeHTML(job.source_filename)}">${escapeHTML(job.source_filename)}</div><div class="library-date">${date} · ${stateLabel}</div></div></div><div class="library-metrics"><span>${counts.pages ?? '—'} 页</span><span>${counts.tables ?? 0} 表</span><span>${counts.images ?? counts.major_figures ?? 0} 图</span><span>${counts.formulas ?? counts.display_formulas ?? 0} 公式</span></div><div class="library-card-footer">${job.status === 'completed' ? '<button class="open-link" type="button">打开阅读器 →</button>' : ''}</div></article>`;
    }).join('');
    $$('.library-card').forEach((card) => card.addEventListener('click', () => {
      const job = state.jobs.find((item) => item.job_id === card.dataset.jobId); if (job?.status === 'completed') openReader(job);
    }));
  }

  async function loadLibrary() {
    try { state.jobs = (await api('/api/jobs')).jobs || []; renderLibrary(); } catch (error) { $('#recent-list').innerHTML = `<div class="empty-state">文献库读取失败：${escapeHTML(error.message)}</div>`; }
  }
  $('#library-search').addEventListener('input', () => renderLibrary());

  function frameDocument() { return $('#html-preview').contentDocument; }
  function isPaperSelectionSurface(element) {
    if (!element?.closest?.('.reader-content')) return false;
    return !element.closest('button, input, textarea, select, summary, .paragraph-translate-trigger, .annotation-note-trigger, .annotation-note-popover, .source-crop, .page-source');
  }

  function guardFrameSelection(event) {
    const doc = event.currentTarget;
    if (!isPaperSelectionSurface(selectionElement(doc, event))) event.preventDefault();
  }

  function blockForNode(node) { return node?.nodeType === Node.ELEMENT_NODE ? node.closest('[data-block-id]') : node?.parentElement?.closest('[data-block-id]'); }
  function clearSelectionPopover() { $('#selection-popover').hidden = true; }

  function textNodes(root, doc = frameDocument()) {
    if (!root || !doc) return [];
    const showText = doc.defaultView?.NodeFilter?.SHOW_TEXT || NodeFilter.SHOW_TEXT;
    const walker = doc.createTreeWalker(root, showText);
    const nodes = [];
    let node;
    while ((node = walker.nextNode())) {
      if (node.parentElement?.closest('.annotation-note-trigger, .paragraph-translate-trigger')) continue;
      if (node.nodeValue) nodes.push(node);
    }
    return nodes;
  }

  function textOffset(root, target, offset, doc = frameDocument()) {
    if (!root || !target || !doc || target.nodeType !== Node.TEXT_NODE) return null;
    let total = 0;
    for (const node of textNodes(root, doc)) {
      if (node === target) return total + Math.max(0, Math.min(offset, node.nodeValue.length));
      total += node.nodeValue.length;
    }
    return null;
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
    return range;
  }

  function annotationRange(root, annotation, doc = frameDocument()) {
    const quote = String(annotation.quote || '');
    const nodes = textNodes(root, doc);
    const fullText = nodes.map((node) => node.nodeValue).join('');
    let start = Number(annotation.start);
    let end = Number(annotation.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || fullText.slice(start, end) !== quote) {
      start = quote ? fullText.indexOf(quote) : -1;
      end = start >= 0 ? start + quote.length : -1;
    }
    return start >= 0 && end > start ? rangeAtOffsets(root, start, end, doc) : null;
  }

  function showSelection() {
    const frame = $('#html-preview'); const doc = frameDocument();
    if (!doc) return;
    const selection = doc.getSelection(); const text = selection?.toString().trim();
    if (!text || !selection.rangeCount) { clearSelectionPopover(); return; }
    const range = selection.getRangeAt(0); const block = blockForNode(selection.anchorNode);
    const rect = range.getBoundingClientRect(); const frameRect = frame.getBoundingClientRect(); const wrapRect = $('.reader-frame-wrap').getBoundingClientRect();
    const left = Math.max(8, Math.min(wrapRect.width - 260, frameRect.left - wrapRect.left + rect.left));
    const top = Math.max(8, frameRect.top - wrapRect.top + rect.bottom + 6);
    const popover = $('#selection-popover'); popover.style.left = `${left}px`; popover.style.top = `${top}px`; popover.hidden = false;
    const start = block ? textOffset(block, range.startContainer, range.startOffset, doc) : null;
    const end = block ? textOffset(block, range.endContainer, range.endOffset, doc) : null;
    state.selection = { quote: text.slice(0, 10000), block_id: block?.dataset.blockId || null, page: block?.dataset.page || null, start, end };
    $('#selection-preview').textContent = text;
    $('#selected-context').textContent = `已选：${text}`; $('#selected-context').hidden = false;
  }

  function wireFrame() {
    const doc = frameDocument(); if (!doc) return;
    doc.body.classList.add('reader-embedded');
    doc.addEventListener('selectstart', guardFrameSelection);
    doc.addEventListener('copy', guardFrameSelection);
    doc.addEventListener('mouseup', () => window.setTimeout(showSelection, 20));
    doc.addEventListener('keyup', () => window.setTimeout(showSelection, 20));
    doc.addEventListener('contextmenu', (event) => {
      if (doc.getSelection()?.toString().trim()) {
        event.preventDefault();
        showSelection();
      }
    });
    doc.addEventListener('click', (event) => {
      const trigger = event.target.closest?.('.annotation-note-trigger');
      if (trigger) {
        event.preventDefault();
        event.stopPropagation();
        const annotation = state.annotations.find((item) => item.id === trigger.dataset.annotationId);
        if (annotation) showInlineAnnotation(annotation, trigger);
        return;
      }
      const link = event.target.closest?.('a.citation, a.cross-reference');
      if (link) {
        event.preventDefault();
        doc.querySelector(link.getAttribute('href'))?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      if (!event.target.closest?.('.annotation-note-popover')) closeInlineAnnotation(doc);
    });
    installParagraphTranslationControls();
    renderFrameAnnotations();
  }
  $('#html-preview').addEventListener('load', wireFrame);

  function cssEscape(value) { return window.CSS?.escape ? window.CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&'); }
  function removeMark(annotationId) {
    const doc = frameDocument(); if (!doc) return;
    doc.querySelectorAll(`[data-annotation-id="${cssEscape(annotationId || '')}"]`).forEach((node) => {
      if (node.classList.contains('annotation-note-trigger')) { node.remove(); return; }
      const parent = node.parentNode;
      if (!parent) return;
      while (node.firstChild) parent.insertBefore(node.firstChild, node);
      node.remove();
    });
  }

  function applyMark(annotation) {
    const doc = frameDocument();
    const root = doc?.querySelector(`[data-block-id="${cssEscape(annotation.block_id || '')}"]`);
    if (!root || !annotation.quote || !annotation.id) return false;
    if (doc.querySelector(`[data-annotation-id="${cssEscape(annotation.id)}"]`)) return true;
    const range = annotationRange(root, annotation, doc);
    if (!range || range.collapsed) return false;
    const mark = doc.createElement('mark');
    mark.dataset.annotationId = annotation.id;
    mark.className = annotation.kind === 'underline' ? 'my-scholar-underline' : 'my-scholar-highlight';
    try {
      const fragment = range.extractContents();
      mark.appendChild(fragment);
      range.insertNode(mark);
      const trigger = doc.createElement('button');
      trigger.type = 'button';
      trigger.className = 'annotation-note-trigger';
      trigger.dataset.annotationId = annotation.id;
      trigger.title = annotation.note ? '查看句内笔记' : '添加或查看句内笔记';
      trigger.setAttribute('aria-label', trigger.title);
      trigger.textContent = annotation.note ? '✎' : '＋';
      mark.insertAdjacentElement('afterend', trigger);
      root.normalize();
      return true;
    } catch (_) {
      return false;
    }
  }

  function closeInlineAnnotation(doc = frameDocument()) {
    doc?.querySelector('.annotation-note-popover')?.remove();
  }

  function showInlineAnnotation(annotation, trigger) {
    const doc = frameDocument(); if (!doc || !trigger) return;
    closeInlineAnnotation(doc);
    const popover = doc.createElement('div');
    popover.className = 'annotation-note-popover';
    popover.innerHTML = `<div class="annotation-note-popover-head"><strong>${annotation.kind === 'underline' ? '划线笔记' : '重点笔记'}</strong><span>第 ${escapeHTML(annotation.page || '—')} 页</span></div><div class="annotation-note-popover-quote">${escapeHTML(annotation.quote)}</div><div class="annotation-note-popover-body">${annotation.note ? escapeHTML(annotation.note) : '<span class="annotation-note-empty">还没有笔记，点击“添加笔记”。</span>'}</div><div class="annotation-note-popover-actions"><button type="button" data-action="edit">${annotation.note ? '编辑笔记' : '添加笔记'}</button><button type="button" data-action="sidebar">打开划线列表</button><button type="button" data-action="delete">删除</button><button type="button" data-action="close">关闭</button></div>`;
    doc.body.appendChild(popover);
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(330, Math.max(220, doc.documentElement.clientWidth - 24));
    popover.style.width = `${width}px`;
    popover.style.left = `${Math.max(12, Math.min(doc.documentElement.clientWidth - width - 12, rect.left))}px`;
    popover.style.top = `${Math.min(doc.documentElement.clientHeight - 190, rect.bottom + 8)}px`;
    popover.querySelector('[data-action="close"]').addEventListener('click', () => closeInlineAnnotation(doc));
    popover.querySelector('[data-action="sidebar"]').addEventListener('click', () => { switchSidebar('annotations-panel'); closeInlineAnnotation(doc); });
    popover.querySelector('[data-action="edit"]').addEventListener('click', () => editAnnotationNote(annotation, trigger));
    popover.querySelector('[data-action="delete"]').addEventListener('click', () => deleteAnnotation(annotation));
  }

  function renderFrameAnnotations() {
    const doc = frameDocument(); if (!doc) return;
    closeInlineAnnotation(doc);
    doc.querySelectorAll('.annotation-note-trigger, mark[data-annotation-id]').forEach((node) => {
      if (node.classList.contains('annotation-note-trigger')) node.remove();
      else removeMark(node.dataset.annotationId);
    });
    state.annotations.forEach((annotation) => applyMark(annotation));
  }

  async function saveAnnotation(kind) {
    if (!state.activeJob || !state.selection) return;
    let note = '';
    if (kind === 'underline') note = window.prompt('给这段划线添加一条简短笔记（可留空）：', '') || '';
    try {
      const payload = await api(`/api/jobs/${state.activeJob.job_id}/annotations`, jsonOptions({ ...state.selection, kind, note, color: kind === 'underline' ? 'blue' : 'yellow' }));
      state.annotations = payload.annotations || []; applyMark(payload.annotation); renderAnnotations(); clearSelectionPopover();
    } catch (error) { setPanelStatus(error.message, true); }
  }
  $('#selection-highlight').addEventListener('click', () => saveAnnotation('highlight'));
  $('#selection-underline').addEventListener('click', () => saveAnnotation('underline'));
  $('#selection-add-chat').addEventListener('click', () => {
    if (!state.selection) return;
    const quote = state.selection.quote;
    switchSidebar('chat-panel');
    const input = $('#chat-input');
    const prefix = input.value.trim() ? `${input.value.trim()}\n\n` : '';
    input.value = `${prefix}[选中文本]\n${quote}\n`;
    input.focus();
    $('#selected-context').textContent = `已加入 Chat：${quote}`;
    $('#selected-context').hidden = false;
    state.selection = null;
    clearSelectionPopover();
  });

  async function editAnnotationNote(annotation, trigger) {
    const note = window.prompt('编辑这条句内笔记（可留空删除）：', annotation.note || '');
    if (note === null || !state.activeJob) return;
    try {
      const payload = await api(`/api/jobs/${state.activeJob.job_id}/annotations/${annotation.id}`, jsonOptions({ note }, 'PATCH'));
      state.annotations = payload.annotations || state.annotations;
      renderAnnotations();
      trigger.textContent = note ? '✎' : '＋';
      trigger.title = note ? '查看句内笔记' : '添加或查看句内笔记';
      showInlineAnnotation(state.annotations.find((item) => item.id === annotation.id) || annotation, trigger);
    } catch (error) { setPanelStatus(error.message, true); }
  }

  async function deleteAnnotation(annotation) {
    if (!state.activeJob || !annotation?.id) return;
    try {
      await api(`/api/jobs/${state.activeJob.job_id}/annotations/${annotation.id}`, { method: 'DELETE' });
      removeMark(annotation.id);
      closeInlineAnnotation();
      state.annotations = state.annotations.filter((item) => item.id !== annotation.id);
      renderAnnotations();
    } catch (error) { setPanelStatus(error.message, true); }
  }

  function paragraphText(block) {
    const clone = block?.cloneNode(true);
    if (!clone) return '';
    clone.querySelectorAll('.paragraph-translate-trigger, .annotation-note-trigger, .annotation-note-popover').forEach((node) => node.remove());
    clone.querySelectorAll('math').forEach((math) => {
      const annotation = math.querySelector('annotation[encoding="application/x-tex"]');
      if (annotation?.textContent) math.replaceWith(` ${annotation.textContent} `);
    });
    return String(clone.innerText || clone.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 12000);
  }

  async function requestTranslation(text, blockId = null) {
    const payload = await api(`/api/jobs/${state.activeJob.job_id}/translate`, jsonOptions({
      text,
      target_language: '中文',
      block_id: blockId,
    }));
    const result = payload.result || {};
    if (!result.text) throw new Error('模型返回为空。');
    return result.text;
  }

  function insertTranslation(blockId, text, { pending = false, error = false } = {}) {
    const doc = frameDocument();
    const block = doc?.querySelector(`[data-block-id="${cssEscape(blockId || '')}"]`);
    if (!block) return null;
    doc.querySelectorAll(`.my-scholar-translation[data-for="${cssEscape(blockId || '')}"]`).forEach((node) => node.remove());
    const node = doc.createElement('div');
    node.className = `my-scholar-translation${pending ? ' is-pending' : ''}${error ? ' is-error' : ''}`;
    node.dataset.for = blockId;
    const label = doc.createElement('span');
    label.textContent = '译';
    const body = doc.createElement('div');
    body.className = 'translation-text';
    body.textContent = text;
    node.append(label, body);
    block.insertAdjacentElement('afterend', node);
    return node;
  }

  async function translateBlock(blockId, trigger) {
    if (!state.activeJob || !blockId || !trigger) return;
    const doc = frameDocument();
    const block = doc?.querySelector(`[data-block-id="${cssEscape(blockId)}"]`);
    const text = paragraphText(block);
    if (!text) return;
    trigger.disabled = true;
    trigger.textContent = '…';
    insertTranslation(blockId, '正在翻译…', { pending: true });
    try {
      const translated = await requestTranslation(text, blockId);
      insertTranslation(blockId, translated);
      setPanelStatus('本段翻译已插入原文下方。');
    } catch (error) {
      insertTranslation(blockId, `翻译失败：${error.message}`, { error: true });
      setPanelStatus(error.message, true);
    } finally {
      trigger.disabled = false;
      trigger.textContent = '译';
    }
  }

  function installParagraphTranslationControls() {
    const doc = frameDocument(); if (!doc) return;
    doc.querySelectorAll('p[data-block-id], ul[data-block-id], ol[data-block-id]').forEach((block) => {
      if (block.querySelector(':scope > .paragraph-translate-trigger')) return;
      const trigger = doc.createElement('button');
      trigger.type = 'button';
      trigger.className = 'paragraph-translate-trigger';
      trigger.dataset.translateBlockId = block.dataset.blockId || '';
      trigger.title = '翻译本段';
      trigger.setAttribute('aria-label', '翻译本段');
      trigger.textContent = '译';
      trigger.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        translateBlock(trigger.dataset.translateBlockId, trigger);
      });
      block.appendChild(trigger);
    });
  }

  async function translateSelection() {
    if (!state.activeJob || !state.selection) return;
    const selection = state.selection;
    $('#selection-translate').disabled = true;
    try {
      const translated = await requestTranslation(selection.quote, selection.block_id);
      insertTranslation(selection.block_id, translated);
      state.selection = null;
      clearSelectionPopover();
    } catch (error) { setPanelStatus(error.message, true); }
    finally { $('#selection-translate').disabled = false; }
  }
  $('#selection-translate').addEventListener('click', translateSelection);

  function setPanelStatus(message, error = false) { const node = $('#chat-status'); node.textContent = message || ''; node.hidden = !message; node.classList.toggle('error', error); }
  function switchSidebar(panelId) { $$('.sidebar-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.panel === panelId)); $$('.sidebar-panel').forEach((panel) => { panel.hidden = panel.id !== panelId; panel.classList.toggle('active-panel', panel.id === panelId); }); }
  $$('.sidebar-tab').forEach((tab) => tab.addEventListener('click', () => switchSidebar(tab.dataset.panel)));

  function renderAnnotations() {
    $('#annotation-count').textContent = `${state.annotations.length} 条`;
    if (!state.annotations.length) { $('#annotations-list').innerHTML = '<div class="chat-empty">还没有划线。选中文章中的一句话试试。</div>'; return; }
    $('#annotations-list').innerHTML = state.annotations.slice().reverse().map((item) => `<div class="annotation-item ${item.kind === 'underline' ? 'underline' : ''}" data-annotation-id="${escapeHTML(item.id)}"><div class="annotation-quote">${escapeHTML(item.quote)}</div>${item.note ? `<div class="annotation-note">${escapeHTML(item.note)}</div>` : ''}<div class="annotation-meta"><span>第 ${escapeHTML(item.page || '—')} 页</span><button type="button" class="delete-annotation">删除</button></div></div>`).join('');
    $$('.annotation-item').forEach((node) => {
      const item = state.annotations.find((annotation) => annotation.id === node.dataset.annotationId);
      node.querySelector('.annotation-quote').addEventListener('click', () => {
        const target = frameDocument()?.querySelector(`[data-block-id="${cssEscape(item?.block_id || '')}"]`);
        target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const trigger = frameDocument()?.querySelector(`.annotation-note-trigger[data-annotation-id="${cssEscape(item?.id || '')}"]`);
        if (trigger && item) showInlineAnnotation(item, trigger);
      });
      node.querySelector('.delete-annotation').addEventListener('click', () => deleteAnnotation(item));
    });
  }

  function chatStorageKey() { return `my-scholar-chat:${state.activeJob?.job_id || 'none'}`; }
  function renderChat() { const messages = state.chat; if (!messages.length) { $('#chat-messages').innerHTML = '<div class="chat-empty">可以问我：这篇文章的贡献是什么？表格中的指标如何比较？</div>'; return; } $('#chat-messages').innerHTML = messages.map((message) => `<div class="chat-bubble ${message.role === 'user' ? 'user' : 'assistant'}"><small>${message.role === 'user' ? '你' : '文章助手'}</small>${escapeHTML(message.content)}</div>`).join(''); $('#chat-messages').scrollTop = $('#chat-messages').scrollHeight; }
  $('#chat-input')?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
    const input = event.currentTarget;
    if (isMacPlatform ? event.metaKey : event.ctrlKey) {
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
  $('#chat-form').addEventListener('submit', async (event) => { event.preventDefault(); if (!state.activeJob) return; const input = $('#chat-input'); const content = input.value.trim(); if (!content) return; const user = { role: 'user', content: state.selection?.quote ? `${content}\n\n[选中文本]\n${state.selection.quote}` : content }; state.chat.push(user); input.value = ''; renderChat(); setPanelStatus('正在请求文章助手…'); try { const payload = await api(`/api/jobs/${state.activeJob.job_id}/chat`, jsonOptions({ messages: state.chat, selected_text: state.selection?.quote || '' })); state.chat.push({ role: 'assistant', content: payload.result?.text || '模型没有返回内容。' }); setPanelStatus(''); } catch (error) { state.chat.push({ role: 'assistant', content: `请求失败：${error.message}` }); setPanelStatus(error.message, true); } localStorage.setItem(chatStorageKey(), JSON.stringify(state.chat.slice(-40))); renderChat(); });

  async function autoHighlights() {
    if (!state.activeJob) return; $('#auto-highlight-button').disabled = true; $('#auto-highlight-button').textContent = '生成中…';
    try { const payload = await api(`/api/jobs/${state.activeJob.job_id}/auto-highlights`, jsonOptions({})); const suggestions = payload.result?.highlights || []; let added = 0; for (const suggestion of suggestions) { if (state.annotations.some((item) => item.block_id === suggestion.block_id && item.quote === suggestion.quote)) continue; const saved = await api(`/api/jobs/${state.activeJob.job_id}/annotations`, jsonOptions({ kind: 'highlight', quote: suggestion.quote, block_id: suggestion.block_id, note: suggestion.reason || '', color: 'yellow' })); state.annotations = saved.annotations || state.annotations; applyMark(saved.annotation); added += 1; } renderAnnotations(); switchSidebar('annotations-panel'); setPanelStatus(payload.result?.status === 'local-fallback' ? `未配置 AI，已显示 ${added} 条本地规则候选。` : `已生成 ${added} 条重点。`); } catch (error) { setPanelStatus(error.message, true); } finally { $('#auto-highlight-button').disabled = false; $('#auto-highlight-button').textContent = '✦ 自动重点'; }
  }
  $('#auto-highlight-button').addEventListener('click', autoHighlights);

  async function loadReaderData(jobId) {
    const [annotations, notes] = await Promise.all([api(`/api/jobs/${jobId}/annotations`), api(`/api/jobs/${jobId}/notes`)]);
    state.annotations = annotations.annotations || []; $('#notes-editor').value = notes.markdown || ''; updateNotesPreview(); renderAnnotations(); renderFrameAnnotations();
    state.chat = JSON.parse(localStorage.getItem(chatStorageKey()) || '[]'); renderChat();
  }

  function openReader(job) { state.activeJob = job; activeJobId = job.job_id; $('#reader-title').textContent = job.source_filename; const counts = job.manifest?.counts || {}; $('#reader-meta').textContent = `${counts.pages || '—'} 页 · ${counts.tables || 0} 表 · ${counts.images || counts.major_figures || 0} 图 · ${counts.formulas || counts.display_formulas || 0} 公式`; $('#html-preview').src = `${job.links.html}?reader=1`; switchView('reader-view'); loadReaderData(job.job_id).catch((error) => setPanelStatus(error.message, true)); }

  function renderMarkdown(markdown) {
    let safe = escapeHTML(markdown || '');
    safe = safe.replace(/^### (.*)$/gm, '<h3>$1</h3>').replace(/^## (.*)$/gm, '<h2>$1</h2>').replace(/^# (.*)$/gm, '<h1>$1</h1>');
    safe = safe.replace(/!\[([^\]]*)\]\((data:image\/[a-zA-Z0-9.+-]+;base64,[^)]+)\)/g, '<img alt="$1" src="$2">');
    safe = safe.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
    return safe.split(/\n{2,}/).map((block) => /^<h[1-3]>/.test(block) || /^<img/.test(block) ? block : `<p>${block.replace(/\n/g, '<br>')}</p>`).join('');
  }
  function updateNotesPreview() { $('#notes-preview').innerHTML = renderMarkdown($('#notes-editor').value); }
  $('#notes-editor').addEventListener('input', updateNotesPreview);
  async function saveNotes() { if (!state.activeJob) return; try { await api(`/api/jobs/${state.activeJob.job_id}/notes`, jsonOptions({ markdown: $('#notes-editor').value }, 'PUT')); $('#notes-saved').textContent = '已保存'; window.setTimeout(() => { $('#notes-saved').textContent = ''; }, 1800); } catch (error) { $('#notes-saved').textContent = error.message; } }
  $('#save-notes-button').addEventListener('click', saveNotes);
  let notesTimer; $('#notes-editor').addEventListener('input', () => { window.clearTimeout(notesTimer); notesTimer = window.setTimeout(saveNotes, 1200); });
  $('#insert-image-button').addEventListener('click', () => $('#note-image-input').click());
  $('#note-image-input').addEventListener('change', () => { const file = $('#note-image-input').files[0]; if (!file) return; const reader = new FileReader(); reader.onload = () => { const image = new Image(); image.onload = () => { const max = 1200; const scale = Math.min(1, max / Math.max(image.width, image.height)); const canvas = document.createElement('canvas'); canvas.width = Math.round(image.width * scale); canvas.height = Math.round(image.height * scale); canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height); $('#notes-editor').value += `\n\n![${file.name}](${canvas.toDataURL('image/jpeg', .78)})\n`; updateNotesPreview(); saveNotes(); }; image.src = reader.result; }; reader.readAsDataURL(file); });

  function renderAIServices(services = {}) { for (const service of ['translation', 'chat']) { const config = services[service] || {}; const status = $(`#setting-${service}-status`); status.textContent = config.enabled === true ? '可用' : '不可用'; status.classList.toggle('is-ready', config.enabled === true); $(`#setting-${service}-model`).textContent = config.model || '未指定'; } }
  async function loadSettings() { try { const settings = await api('/api/settings'); renderAIServices(settings.ai_services || {}); const shortcuts = settings.shortcuts || {}; $('#shortcut-library').value = shortcutLabel(shortcuts.open_library || `${shortcutPrimaryModifier}+1`); $('#shortcut-settings').value = shortcutLabel(shortcuts.open_settings || `${shortcutPrimaryModifier}+,`); } catch (error) { $('#settings-status').textContent = error.message; $('#settings-status').hidden = false; } }
  const settingsPayload = () => ({ shortcuts: { open_library: $('#shortcut-library').value.trim(), open_settings: $('#shortcut-settings').value.trim() } });
  $('#settings-form').addEventListener('submit', async (event) => { event.preventDefault(); const status = $('#settings-status'); status.classList.remove('error'); status.hidden = false; status.textContent = '保存中…'; try { await api('/api/settings', jsonOptions(settingsPayload())); status.textContent = '设置已保存。'; await checkHealth(); await loadSettings(); } catch (error) { status.textContent = error.message; status.classList.add('error'); } });
  $('#test-ai-button').addEventListener('click', async () => { const button = $('#test-ai-button'); const status = $('#settings-status'); const output = $('#setting-ai-results'); button.disabled = true; status.classList.remove('error'); status.hidden = false; status.textContent = '正在测试翻译与文章助手服务…'; output.textContent = ''; try { const payload = await api('/api/ai/test', { method: 'POST' }); const results = payload.results || payload.result?.services || payload.result || {}; const summary = ['translation', 'chat'].map((service) => { const result = results[service] || {}; const ok = result.ok === true || result.success === true || result.status === 'ok'; return `${service === 'translation' ? '翻译' : '文章助手'}：${ok ? '可用' : (result.error || result.message || '不可用')}`; }); output.textContent = summary.join(' · '); status.textContent = '连接测试完成。'; await checkHealth(); await loadSettings(); } catch (error) { status.textContent = error.message; status.classList.add('error'); } finally { button.disabled = false; } });

  async function checkHealth() { try { await api('/api/health'); } catch (_) { /* the shell no longer exposes a persistent health badge */ } }
  document.addEventListener('keydown', (event) => { const modifier = event.metaKey || event.ctrlKey; if (!modifier) return; if (event.key === '1') { event.preventDefault(); switchView('library-view'); } if (event.key === ',') { event.preventDefault(); switchView('settings-view'); loadSettings(); } });

  checkHealth(); loadLibrary(); loadSettings();
})();
