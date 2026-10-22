(() => {
  'use strict';

  function validTerm(value) {
    const term = String(value || '').trim();
    return Boolean(term && !/\p{Cc}/u.test(term) && Array.from(term).length <= 120);
  }

  function sentenceContext(text, start, end) {
    const before = text.slice(0, start);
    const boundary = /[.!?。！？]\s+/gu;
    let left = 0;
    for (const match of before.matchAll(boundary)) left = match.index + match[0].length;
    const tail = text.slice(end).match(/[.!?。！？](?:\s|$)/u);
    return text.slice(left, tail ? end + tail.index + 1 : text.length).trim().slice(0, 10000);
  }

  const detailLabels = Object.freeze({ part_of_speech: '词性', meanings: '多义项', synonyms: '同义词', antonyms: '反义词', examples: '例句与译文', context_explanation: '论文语境' });
  const detailLimits = Object.freeze({ part_of_speech: 500, meanings: 6000, synonyms: 2000, antonyms: 2000, examples: 8000, context_explanation: 6000 });
  const normalizeDetails = (value) => Object.fromEntries(Object.keys(detailLabels).map((key) => [key, typeof value?.[key] === 'string' ? value[key] : '']));
  const hasDetails = (value) => Object.values(normalizeDetails(value)).some((text) => text.trim());

  function matches(entry, { query = '', status = 'all', tag = '' } = {}) {
    if (status === 'unfiled' && entry.tags?.length) return false;
    if (status === 'learning' && entry.review?.status === 'mastered') return false;
    if (status === 'mastered' && entry.review?.status !== 'mastered') return false;
    if (tag && !entry.tags?.includes(tag)) return false;
    const haystack = [entry.term, entry.meaning, entry.note, ...Object.values(normalizeDetails(entry.details)), ...(entry.tags || []), ...(entry.sources || []).map((source) => `${source.quote || ''} ${source.title || ''}`)].join(' ').toLocaleLowerCase();
    return haystack.includes(query.trim().toLocaleLowerCase());
  }

  function create({ api, jsonOptions, escapeHTML: h, translate, openSource, toast, confirm }) {
    const root = document.querySelector('#vocabulary-view');
    const list = root.querySelector('#vocabulary-list');
    const reviewNode = root.querySelector('#vocabulary-review');
    const statusNode = root.querySelector('#vocabulary-status');
    let entries = [];
    let loadToken = 0;
    let mutationRevision = 0;
    const entryRevisions = new Map();
    let editingId = '';
    let draft = null;
    let draftFields = new Set();
    let review = null;
    const pendingSaves = new Map();
    const completing = new Set();
    const explaining = new Set();
    const expandedDetails = new Set();
    const filters = () => ({ query: root.querySelector('#vocabulary-search').value, status: root.querySelector('#vocabulary-filter').value, tag: root.querySelector('#vocabulary-tag').value });
    const filtered = () => entries.filter((entry) => matches(entry, filters()));
    const report = (message, error = false) => {
      statusNode.textContent = message;
      statusNode.hidden = !message;
      statusNode.classList.toggle('error', error);
    };
    const syncDraft = (entry) => {
      if (!draft || editingId !== entry?.id) return;
      for (const field of ['meaning', 'note', 'tags']) {
        if (!draftFields.has(field)) draft[field] = field === 'tags' ? (entry.tags || []).join(', ') : entry[field] || '';
      }
      for (const [field, value] of Object.entries(normalizeDetails(entry.details))) {
        if (!draftFields.has(`details.${field}`)) draft.details[field] = value;
      }
    };
    const upsert = (entry) => {
      entryRevisions.set(entry.id, ++mutationRevision);
      const index = entries.findIndex((item) => item.id === entry.id);
      if (index < 0) entries.unshift(entry); else entries[index] = entry;
      syncDraft(entry);
      render();
    };
    const entryURL = (id) => `/api/vocabulary/${encodeURIComponent(id)}`;
    function applyPatchResponse(id, before, body, updated) {
      const current = entries.find((entry) => entry.id === id);
      if (!current) return;
      const merged = { ...current };
      for (const field of ['meaning', 'note', 'tags', 'review']) {
        if (field in body && JSON.stringify(current[field]) === JSON.stringify(before[field])) merged[field] = updated[field];
      }
      if (body.details) {
        merged.details = normalizeDetails(current.details);
        const previous = normalizeDetails(before.details);
        const incoming = normalizeDetails(updated.details);
        for (const field of Object.keys(body.details)) {
          if (merged.details[field] === previous[field]) merged.details[field] = incoming[field];
        }
      }
      upsert(merged);
      return merged;
    }
    async function load() {
      const token = ++loadToken;
      const revision = mutationRevision;
      report('正在读取生词本…');
      try {
        const payload = await api('/api/vocabulary');
        if (token !== loadToken) return;
        const current = new Map(entries.map((entry) => [entry.id, entry]));
        const changed = (id) => (entryRevisions.get(id) || 0) > revision;
        const fetched = (payload.entries || []).flatMap((entry) => changed(entry.id) ? (current.has(entry.id) ? [current.get(entry.id)] : []) : [entry]);
        const fetchedIds = new Set(fetched.map((entry) => entry.id));
        entries = [...entries.filter((entry) => changed(entry.id) && !fetchedIds.has(entry.id)), ...fetched];
        syncDraft(entries.find((entry) => entry.id === editingId));
        render();
        report('');
      } catch (error) { if (token === loadToken) report(`读取失败：${error.message}`, true); }
    }
    function detailsMarkup(entry, { editing = false, reviewCard = false } = {}) {
      const details = normalizeDetails(entry.details);
      if (!editing && !hasDetails(details)) return '';
      const key = `${editing ? 'edit' : reviewCard ? 'review' : 'card'}:${entry.id}`;
      const fields = Object.entries(detailLabels).flatMap(([field, label]) => editing
        ? [`<label>${label}<textarea name="details.${field}" rows="3" maxlength="${detailLimits[field]}">${h(details[field])}</textarea></label>`]
        : details[field].trim() ? [`<div class="vocabulary-detail-field"><dt>${label}</dt><dd>${h(details[field])}</dd></div>`] : []).join('');
      return `<details class="vocabulary-details" data-details-key="${h(key)}"${expandedDetails.has(key) ? ' open' : ''}><summary>详细释义 <span class="vocabulary-details-badge">AI 辅助 · 可编辑</span></summary>${editing ? `<div class="vocabulary-details-editor">${fields}</div>` : `<dl>${fields}</dl>`}</details>`;
    }
    async function explain(entry) {
      if (explaining.has(entry.id)) return;
      explaining.add(entry.id); render();
      try {
        const generated = await api(`${entryURL(entry.id)}/explain`, jsonOptions({}));
        const current = entries.find((item) => item.id === entry.id);
        if (!current) return;
        const editingDetails = () => editingId === entry.id && [...draftFields].some((field) => field.startsWith('details.'));
        if (hasDetails(current.details) || editingDetails()) { report('已保留手动编辑的详细释义。'); return; }
        const details = normalizeDetails(generated.details);
        if (!hasDetails(details)) throw new Error('服务没有返回详细释义，请重试。');
        const previous = JSON.stringify(normalizeDetails(current.details));
        const payload = await api(entryURL(entry.id), jsonOptions({ details, only_if_details_empty: true }, 'PATCH'));
        const latest = entries.find((item) => item.id === entry.id);
        if (!latest || editingDetails()) return;
        if (JSON.stringify(normalizeDetails(latest.details)) !== previous) return;
        upsert({ ...latest, details: normalizeDetails(payload.entry.details) });
        report('详细释义已生成，可展开查看或编辑。');
      } finally { explaining.delete(entry.id); render(); }
    }
    function renderReview() {
      reviewNode.hidden = !review;
      if (!review) { reviewNode.replaceChildren(); return; }
      const entry = entries.find((item) => item.id === review.ids[review.index]);
      if (!entry) {
        reviewNode.innerHTML = `<div class="vocabulary-review-heading"><strong>本轮复习完成</strong><button data-vocab-action="end-review" class="secondary-button" type="button">返回生词本</button></div><p>已复习 ${review.index} 个词条。</p>`;
        return;
      }
      reviewNode.innerHTML = `<div class="vocabulary-review-heading"><span>复习 ${review.index + 1} / ${review.ids.length}</span><button data-vocab-action="end-review" class="tiny-button" type="button">结束复习</button></div><h2>${h(entry.term)}</h2><blockquote>${h(entry.sources?.[0]?.quote || '暂无原句')}</blockquote>${review.revealed ? `<div class="vocabulary-review-meaning">${h(entry.meaning || '尚未填写释义，可返回词条补全。')}</div>${entry.note ? `<p>${h(entry.note)}</p>` : ''}${detailsMarkup(entry, { reviewCard: true })}<div class="vocabulary-review-actions"><button data-vocab-action="rate" data-status="learning" class="secondary-button" type="button"${review.busy ? ' disabled' : ''}>还需复习</button><button data-vocab-action="rate" data-status="mastered" class="primary-button" type="button"${review.busy ? ' disabled' : ''}>已掌握</button></div>` : '<button data-vocab-action="reveal" class="primary-button" type="button">显示释义</button>'}`;
    }
    function render() {
      const tagSelect = root.querySelector('#vocabulary-tag');
      const selectedTag = tagSelect.value;
      const tags = [...new Set(entries.flatMap((entry) => entry.tags || []))].sort((a, b) => a.localeCompare(b));
      tagSelect.innerHTML = `<option value="">全部标签</option>${tags.map((tag) => `<option value="${h(tag)}">${h(tag)}</option>`).join('')}`;
      tagSelect.value = tags.includes(selectedTag) ? selectedTag : '';
      const shown = filtered();
      root.querySelector('#vocabulary-count').textContent = `${shown.length} / ${entries.length} 个词条`;
      root.querySelector('#vocabulary-start-review').disabled = !shown.length;
      root.querySelector('#vocabulary-browser').hidden = Boolean(review);
      list.innerHTML = shown.length ? shown.map((entry) => {
        const editing = entry.id === editingId;
        const model = editing ? draft : entry;
        return `<article class="vocabulary-card" data-vocabulary-id="${h(entry.id)}"><div class="vocabulary-card-heading"><h2>${h(entry.term)}</h2><span class="vocabulary-review-status">${entry.review?.status === 'mastered' ? '已掌握' : '未掌握'}</span><div class="vocabulary-card-actions"><button data-vocab-action="edit" class="tiny-button" type="button">编辑</button><button data-vocab-action="delete" class="tiny-button" type="button">删除</button></div></div>${editing ? `<form class="vocabulary-edit"><label>释义<textarea name="meaning" rows="3" maxlength="10000">${h(model.meaning || '')}</textarea></label><label>标签<span class="vocabulary-field-hint">逗号分隔，修改后保存即可分类或改名</span><input name="tags" maxlength="1000" value="${h(model.tags || '')}" placeholder="例如：机器学习, 数学"></label><label>备注<textarea name="note" rows="2" maxlength="10000">${h(model.note || '')}</textarea></label>${detailsMarkup({ ...entry, details: model.details }, { editing: true })}<div class="vocabulary-edit-actions"><button class="primary-button compact-button" type="submit">保存</button><button data-vocab-action="cancel-edit" class="secondary-button compact-button" type="button">取消</button></div></form>` : `<p class="vocabulary-meaning">${h(entry.meaning || '暂无释义')}</p>${!entry.meaning ? `<button data-vocab-action="complete" class="tiny-button" type="button"${completing.has(entry.id) ? ' disabled' : ''}>${completing.has(entry.id) ? '补全中…' : '补全释义 / 重试'}</button>` : ''}${entry.note ? `<p class="vocabulary-note">${h(entry.note)}</p>` : ''}${detailsMarkup(entry)}${!hasDetails(entry.details) ? `<button data-vocab-action="explain" class="tiny-button vocabulary-explain" type="button"${explaining.has(entry.id) ? ' disabled aria-busy="true"' : ''}>${explaining.has(entry.id) ? '详细释义生成中…' : '生成详细释义 / 重试'}</button>` : ''}<div class="vocabulary-tags">${(entry.tags || []).map((tag) => `<button data-vocab-action="tag" data-tag="${h(tag)}" type="button">${h(tag)}</button>`).join('')}</div>`}<div class="vocabulary-sources">${(entry.sources || []).map((source, index) => `<div class="vocabulary-source"><blockquote>${h(source.quote || source.selected_text || entry.term)}</blockquote><button data-vocab-action="source" data-source-index="${index}" class="tiny-button" type="button">${h(source.title || '来源文献')}${source.page ? ` · 第 ${h(source.page)} 页` : ''} ↗</button></div>`).join('')}</div></article>`;
      }).join('') : '<div class="empty-state">没有匹配的词条。阅读原文时选中单词或短语，点击「加入生词本」。</div>';
      renderReview();
    }
    async function fillMeaning(entry, translation) {
      const text = String(translation || '').trim();
      if (!text) return;
      const before = entries.find((item) => item.id === entry.id);
      if (!before) return;
      const body = { meaning: text, only_if_meaning_empty: true };
      const payload = await api(entryURL(entry.id), jsonOptions(body, 'PATCH'));
      return applyPatchResponse(entry.id, before, body, payload.entry);
    }
    async function saveSelection(snapshot, { meaning = '', translation = null } = {}) {
      if (!validTerm(snapshot.term) || snapshot.source.surface !== 'source') throw new Error('请在原文中选择不超过 120 字符、无换行的单词或短语。');
      meaning = String(meaning).trim();
      const key = JSON.stringify(snapshot);
      if (pendingSaves.has(key)) return pendingSaves.get(key);
      const revision = mutationRevision;
      const task = (async () => {
        const payload = await api('/api/vocabulary', jsonOptions({ ...snapshot, language: 'auto', meaning, tags: [] }));
        const current = entries.find((item) => item.id === payload.entry.id);
        if ((entryRevisions.get(payload.entry.id) || 0) > revision) {
          if (!current) return;
          payload.entry = { ...current, sources: [...new Map([...(current.sources || []), ...(payload.entry.sources || [])].map((source) => [JSON.stringify(source), source])).values()] };
        }
        upsert(payload.entry);
        toast(payload.created ? '已加入生词本。' : '已在生词本中，来源已保存。');
        if (!payload.entry.meaning && (meaning || translation)) {
          const fillError = (error) => report(`词条已保存，释义补全失败：${error.message}，可在词条中重试。`, true);
          if (meaning) {
            try { return await fillMeaning(payload.entry, meaning); }
            catch (error) { fillError(error); }
          } else {
            void Promise.resolve(translation).then((text) => fillMeaning(payload.entry, text)).catch(fillError);
          }
        }
        return payload.entry;
      })();
      pendingSaves.set(key, task);
      try { return await task; } finally { pendingSaves.delete(key); }
    }
    for (const id of ['vocabulary-search', 'vocabulary-filter', 'vocabulary-tag']) {
      root.querySelector(`#${id}`).addEventListener(id === 'vocabulary-search' ? 'input' : 'change', render);
    }
    root.querySelector('#vocabulary-reload').addEventListener('click', () => void load());
    root.querySelector('#vocabulary-start-review').addEventListener('click', () => {
      const ids = filtered().map((entry) => entry.id);
      if (!ids.length) return;
      review = { ids, index: 0, revealed: false, busy: false };
      render();
    });
    root.addEventListener('toggle', (event) => {
      const key = event.target.dataset?.detailsKey;
      if (!key) return;
      if (event.target.open) expandedDetails.add(key); else expandedDetails.delete(key);
    }, true);
    root.addEventListener('input', (event) => {
      if (event.target.closest('.vocabulary-edit') && draft) {
        const field = event.target.name;
        if (field.startsWith('details.')) draft.details[field.slice(8)] = event.target.value;
        else draft[field] = event.target.value;
        draftFields.add(event.target.name);
      }
    });
    root.addEventListener('submit', async (event) => {
      if (!event.target.matches('.vocabulary-edit')) return;
      event.preventDefault();
      const id = editingId;
      const body = {};
      for (const field of draftFields) {
        if (field.startsWith('details.')) (body.details ||= {})[field.slice(8)] = draft.details[field.slice(8)];
        else body[field] = field === 'tags' ? [...new Set(draft.tags.split(/[,，]/u).map((tag) => tag.trim()).filter(Boolean))] : draft[field];
      }
      if (!Object.keys(body).length) { editingId = ''; draft = null; render(); return; }
      const before = entries.find((entry) => entry.id === id);
      try {
        const payload = await api(entryURL(id), jsonOptions(body, 'PATCH'));
        if (editingId === id) { editingId = ''; draft = null; }
        applyPatchResponse(id, before, body, payload.entry);
        report('已保存。');
      } catch (error) { report(error.message, true); }
    });
    root.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-vocab-action]');
      if (!button || button.disabled) return;
      const action = button.dataset.vocabAction;
      const id = button.closest('[data-vocabulary-id]')?.dataset.vocabularyId;
      const entry = entries.find((item) => item.id === id);
      try {
        if (action === 'edit' && entry) { expandedDetails.delete(`edit:${id}`); editingId = id; draft = { meaning: entry.meaning || '', note: entry.note || '', tags: (entry.tags || []).join(', '), details: normalizeDetails(entry.details) }; draftFields = new Set(); render(); }
        if (action === 'cancel-edit') { editingId = ''; draft = null; render(); }
        if (action === 'delete' && entry && await confirm(`将删除「${entry.term}」的释义、复习记录和来源。原论文与批注不会被删除。`, '删除生词？')) {
          await api(entryURL(id), { method: 'DELETE' });
          entryRevisions.set(id, ++mutationRevision);
          entries = entries.filter((item) => item.id !== id);
          if (editingId === id) { editingId = ''; draft = null; }
          render();
        }
        if (action === 'tag') { root.querySelector('#vocabulary-tag').value = button.dataset.tag; render(); }
        if (action === 'source' && entry) await openSource(entry.sources[Number(button.dataset.sourceIndex)]);
        if (action === 'complete' && entry && !completing.has(id)) {
          completing.add(id); render();
          try { await fillMeaning(entry, await translate(entry.term, entry.sources?.[0]?.job_id)); report('释义已补全。'); }
          finally { completing.delete(id); render(); }
        }
        if (action === 'explain' && entry) await explain(entry);
        if (action === 'end-review') { review = null; render(); }
        if (action === 'reveal' && review) { review.revealed = true; renderReview(); }
        if (action === 'rate' && review?.revealed && !review.busy) {
          const session = review;
          session.busy = true; renderReview();
          try {
            const id = session.ids[session.index];
            const before = entries.find((entry) => entry.id === id);
            const payload = await api(`${entryURL(id)}/review`, jsonOptions({ status: button.dataset.status }));
            session.index += 1; session.revealed = false;
            applyPatchResponse(id, before, { review: true }, payload.entry);
          } finally { session.busy = false; renderReview(); }
        }
      } catch (error) { report(error.message, true); }
    });
    return { load, saveSelection };
  }

  window.MyScholarVocabulary = { create, validTerm, sentenceContext, matches, normalizeDetails, hasDetails };
})();
