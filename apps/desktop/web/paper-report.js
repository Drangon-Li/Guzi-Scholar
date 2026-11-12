(function () {
  'use strict';

  const questions = [
    ['why', '为什么做？'],
    ['what', '做了什么？'],
    ['how', '怎么做？'],
    ['results', '结果如何？'],
    ['so_what', '有什么意义？'],
  ];
  const sections = [
    ['summary', '一言以蔽之'],
    ['idea', 'IDEA 从何而来'],
    ['implementation', 'IDEA 的实现'],
    ['example', '玩具例子'],
    ['experiments', '实验'],
  ];
  const conceptArticleHeadings = {
    basics: '基本概念', mechanism: '工作原理', example: '一个例子', paper: '在这篇论文中', limits: '适用范围与局限',
  };
  const statusLabels = {
    unassessed: '未评估', familiar: '熟悉', learning: '学习中', mastered: '已掌握',
  };
  const kindLabels = { inference: '推断', example: '示意', gap: '证据缺口' };
  const sourceLabels = { ai: 'AI', manual: '手动编辑', restore: '恢复版本' };
  const mediaLabels = new Map([['figure', '原文图'], ['table', '原文表格'], ['equation', '原文公式']]);
  const chatTextLimit = 4000;

  function reportMediaAssetURL(jobId, media) {
    const generation = String(media.render_generation);
    const filename = typeof media.asset === 'string'
      ? /^assets\/images\/([a-z0-9][a-z0-9._@-]{0,180}\.(?:png|jpe?g|webp|gif))$/iu.exec(media.asset)?.[1]
      : '';
    if (!/^[a-f0-9]{12,40}$/u.test(jobId) || !filename) return '';
    const prefix = '/api/jobs/' + jobId + '/';
    if (generation === 'base') return prefix + 'assets/images/' + encodeURIComponent(filename);
    return /^[1-9][0-9]{0,8}$/u.test(generation)
      ? prefix + 'renders/' + generation + '/assets/images/' + encodeURIComponent(filename)
      : '';
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(label, action, className = 'secondary-button') {
    const node = element('button', className, label);
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
  }

  function requestOptions(method, body, extra = {}) {
    return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...extra };
  }

  function create({ api, openSource, openOriginal, backToLibrary, showKnowledge, openKnowledgeEntry,
    renderMath = () => {}, aiConfigured = () => true }) {
    const byId = (id) => document.getElementById(id);
    const ui = {};
    for (const id of ['shell', 'scroll', 'title', 'coverage', 'status', 'draft', 'content', 'back', 'regenerate', 'edit',
      'save', 'cancel-edit', 'history', 'discuss', 'knowledge', 'original', 'drawer', 'drawer-title',
      'drawer-content', 'close-drawer', 'evidence', 'evidence-title', 'evidence-status', 'quote', 'locate',
      'concept-article', 'concept-article-title', 'concept-article-content', 'concept-article-scroll',
      'concept-article-status', 'concept-article-retry']) {
      ui[id] = byId('paper-report-' + id);
    }
    const knowledgeView = byId('report-knowledge-view');
    const knowledgeList = byId('report-knowledge-list');
    const knowledgeTitle = byId('report-knowledge-title');
    let current;
    let evidence;
    let conceptArticle;
    let knowledgeRequest;
    let knowledgeEntries = new Map();
    let selectionPointer = null;
    let selectionTimer;
    let attachedRange;
    const conceptKey = (jobId, id) => JSON.stringify([jobId, id]);
    const path = (session) => '/api/jobs/' + encodeURIComponent(session.job.job_id) + '/report';
    const isActive = () => ui.shell.classList.contains('active-view');
    const hasReportChanges = (session) => Boolean(session.edit?.dirty || session.draft);
    const hasLocalChanges = () => current && (hasReportChanges(current) || current.conceptDirty.size > 0);
    const focus = (node) => node?.focus({ preventScroll: true });
    const modelAvailable = (session) => session.job.status === 'completed' && aiConfigured();
    const labelForEvidence = (citation) => citation.page ? '第 ' + citation.page + ' 页' : '原文';

    function reportStatus(node, message = '', error = false) {
      node.textContent = message;
      node.hidden = !message;
      node.classList.toggle('error', error);
    }

    function canGenerateReport(session, regenerate) {
      return current === session && Boolean(session.report) === regenerate && modelAvailable(session)
        && !(session.loading || session.generating || session.edit || session.write || session.conceptWrite
          || session.chatBusy || session.draft || session.conflict);
    }

    function refreshToolbar(session) {
      const loaded = Boolean(session.report);
      ui.regenerate.hidden = !loaded;
      ui.regenerate.disabled = !canGenerateReport(session, true);
      ui.regenerate.textContent = session.generating ? '正在重新生成…' : '重新生成';
      ui.regenerate.title = modelAvailable(session) ? '' : '在设置中配置 AI 对话后可重新生成。';
      ui.edit.hidden = !loaded || Boolean(session.edit);
      ui.edit.disabled = Boolean(session.generating || session.write || session.conceptWrite || session.chatBusy || session.draft || session.conflict);
      ui.save.hidden = ui['cancel-edit'].hidden = !session.edit;
      ui.save.disabled = !session.edit?.dirty || Boolean(session.write || session.conceptWrite || session.conflict);
      ui['cancel-edit'].disabled = Boolean(session.write);
      ui.discuss.hidden = !loaded;
      ui.history.hidden = !loaded && !session.history.length;
      ui.history.setAttribute('aria-expanded', String(session.drawer === 'history'));
      ui.discuss.setAttribute('aria-expanded', String(session.drawer === 'discuss'));
      ui.original.disabled = session.job.status !== 'completed';
    }

    function viewTitle(session, report) {
      return report?.title || session.job.title || session.job.filename || '精读报告';
    }

    function render(session) {
      if (current !== session) return;
      const report = session.draftPreview ? session.draft?.report : session.edit?.report || session.report;
      ui.title.textContent = viewTitle(session, report);
      const source = report?.source;
      ui.coverage.textContent = source ? '解析文本覆盖 ' + source.blocks_read + ' / ' + source.blocks_total + ' 段' : '';
      ui.coverage.hidden = !source;
      reportStatus(ui.status, session.notice?.text, session.notice?.error);
      refreshToolbar(session);
      renderDraft(session);
      renderArticle(session, report);
      renderDrawer(session);
      if (conceptArticle?.session === session && (session.conflict || conceptArticle.revision !== session.revision)) {
        renderConceptArticle(conceptArticle);
      }
    }

    function renderDraft(session) {
      ui.draft.replaceChildren();
      const candidate = session.draft;
      if ((!candidate || candidate.kind === 'initial' && session.write) && !session.conflict) {
        ui.draft.hidden = true;
        return;
      }
      const actions = element('div', 'paper-report-actions');
      if (session.conflict) {
        const message = hasReportChanges(session) ? '报告已在别处更新。当前草稿仍在这里，可复制需要保留的文字。'
          : '报告已在别处更新。请载入最新版本后继续。';
        ui.draft.append(element('p', '', message));
        const latest = button('载入最新报告…', () => void loadLatest(session));
        latest.disabled = Boolean(session.write);
        actions.append(latest);
      }
      if (candidate) {
        const revision = candidate.kind === 'revision';
        const regenerated = candidate.kind === 'regeneration';
        const description = regenerated ? '新报告草稿已生成，应用后将保存为新版本。'
          : revision ? '有一份 AI 修改建议待确认。' : '生成的报告尚未保存。';
        ui.draft.append(element('p', '', description));
        const preview = button(session.draftPreview ? '查看已保存报告' : '预览草稿', () => {
          session.draftPreview = !session.draftPreview;
          render(session);
          focus(ui.draft.querySelector('button[data-report-preview]'));
        });
        preview.dataset.reportPreview = '';
        preview.disabled = Boolean(session.edit || session.write);
        if (session.report) actions.append(preview);
        const apply = button(regenerated ? '应用新报告' : revision ? '应用建议' : '保存报告', () => void applyDraft(session));
        apply.dataset.reportApply = '';
        apply.disabled = Boolean(session.edit || session.write || session.conceptWrite || session.conflict);
        actions.append(apply);
        if (!session.conflict) {
          const discard = button('放弃草稿', () => {
            session.draft = null;
            session.draftPreview = false;
            session.notice = null;
            render(session);
            focus(regenerated ? ui.regenerate : ui.discuss.hidden ? ui.title : ui.discuss);
          });
          discard.disabled = Boolean(session.write);
          actions.append(discard);
        }
      }
      ui.draft.append(actions);
      ui.draft.hidden = false;
    }

    function renderArticle(session, report) {
      if (!report) {
        const state = element('div', 'paper-report-state');
        const available = modelAvailable(session);
        let description = '生成精读报告，先查看论文的主要问题、方法与实验结果。';
        if (session.loading) description = '正在读取报告…';
        else if (session.generating) description = '正在阅读原文并生成报告…';
        else if (session.readError) description = session.readError;
        else if (session.job.status !== 'completed') description = '文献解析完成后可生成报告。';
        else if (!available) description = '在设置中配置 AI 对话后即可生成报告。';
        state.append(element('p', 'paper-report-muted', description));
        if (session.readError) state.append(button('重新读取', () => void loadReport(session, true)));
        else if (available && !session.loading && !session.generating && !session.draft) {
          state.append(button('生成报告', () => void generateReport(session), 'primary-button compact-button'));
        }
        ui.content.replaceChildren(state);
        return;
      }
      const reportSections = new Map(report.sections.map((section) => [section.key, section.paragraphs]));
      const concepts = new Map(report.concepts.map((concept) => [concept.term, concept]));
      const media = new Map((report.media || []).map((item) => [item.id, item]));
      const table = element('table', 'paper-report-questions');
      table.createCaption().textContent = '论文五问';
      const body = table.createTBody();
      for (const [key, label] of questions) {
        const row = body.insertRow();
        const heading = element('th', '', label);
        heading.scope = 'row';
        row.append(heading);
        const answer = row.insertCell();
        appendParagraphs(answer, reportSections.get(key), concepts, media, session, label);
      }
      const article = document.createDocumentFragment();
      article.append(table);
      for (const [key, label] of sections) {
        const section = element('section', 'paper-report-section');
        section.append(element('h2', '', label));
        appendParagraphs(section, reportSections.get(key), concepts, media, session, label);
        article.append(section);
      }
      ui.content.replaceChildren(article);
      if (ui.content.querySelector('.paper-report-equation[data-tex]')) renderMath();
    }

    function appendParagraphs(target, paragraphs, concepts, media, session, label) {
      const editing = Boolean(session.edit);
      for (const [index, paragraph] of (paragraphs || []).entries()) {
        const node = element('div', 'paper-report-paragraph copyable-data');
        if (kindLabels[paragraph.kind]) node.append(element('small', 'paper-report-kind', kindLabels[paragraph.kind]));
        if (editing) {
          const field = element('textarea', 'paper-report-editor');
          field.setAttribute('aria-label', label + '，第 ' + (index + 1) + ' 段');
          field.value = paragraph.text;
          field.rows = Math.min(7, Math.max(2, Math.ceil(paragraph.text.length / 53)));
          field.disabled = Boolean(session.write);
          field.addEventListener('input', () => {
            paragraph.text = field.value;
            session.edit.dirty = session.edit.report.sections.some((section, sectionIndex) =>
              section.paragraphs.some((item, itemIndex) =>
                item.text !== session.report.sections[sectionIndex].paragraphs[itemIndex].text));
            refreshToolbar(session);
          });
          node.append(field);
        } else {
          const prose = element('span', 'paper-report-prose');
          let offset = 0;
          for (const match of paragraph.text.matchAll(/\[\[([^\][\r\n]+)\]\]/gu)) {
            prose.append(paragraph.text.slice(offset, match.index));
            const term = match[1];
            const concept = concepts.get(term);
            if (concept) {
              const control = button(term, () => openConcept(session, concept, control), 'paper-report-inline paper-report-term');
              control.setAttribute('aria-controls', 'paper-report-drawer');
              prose.append(control);
            } else {
              prose.append(term);
            }
            offset = match.index + match[0].length;
          }
          prose.append(paragraph.text.slice(offset));
          node.append(prose);
        }
        for (const citation of paragraph.citations) node.append(citationButton(session, citation));
        for (const id of new Set(paragraph.media_ids)) {
          const item = media.get(id);
          if (item) {
            const figure = renderMedia(session, item);
            if (figure) node.append(figure);
          }
        }
        target.append(node);
      }
      if (!paragraphs?.length) target.append(element('p', 'paper-report-muted', '暂无内容'));
    }

    function renderMedia(session, media) {
      const label = mediaLabels.get(media.kind);
      const src = reportMediaAssetURL(session.job.job_id, media);
      const tex = media.kind === 'equation' && typeof media.tex === 'string' ? media.tex : '';
      if (!label || (!src && !tex)) return null;

      const figure = element('figure', 'paper-report-media');
      figure.dataset.reportMediaId = media.id;
      figure.dataset.reportMediaKind = media.kind;
      const fallback = tex ? element('code', 'paper-report-equation-source', tex)
        : element('p', 'paper-report-muted', '原文图片暂时无法显示。');
      let visual = fallback;
      if (src) {
        const image = element('img', 'paper-report-media-image');
        image.alt = media.caption ? '' : label;
        image.loading = 'lazy';
        image.decoding = 'async';
        image.addEventListener('error', () => image.replaceWith(fallback), { once: true });
        image.src = src;
        visual = image;
      }
      if (tex) {
        const equation = element('div', 'paper-report-equation math-display');
        equation.dataset.tex = tex;
        equation.append(visual);
        visual = equation;
      }
      figure.append(visual);

      const caption = element('figcaption', 'paper-report-media-caption');
      caption.append(element('span', 'copyable-data', media.caption || label));
      const pageLabel = labelForEvidence(media);
      const status = element('p', 'paper-report-status');
      status.setAttribute('role', 'status');
      status.hidden = true;
      const locate = button(pageLabel, async () => {
        locate.disabled = true;
        reportStatus(status);
        try {
          if (await openSource(session.job, media) === false) throw new Error('找不到对应的原文位置。');
        } catch (error) {
          reportStatus(status, error.message, true);
        } finally {
          locate.disabled = false;
        }
      }, 'paper-report-inline paper-report-citation paper-report-media-source');
      locate.setAttribute('aria-label', '定位' + label + '，' + pageLabel);
      caption.append(locate, status);
      figure.append(caption);

      const explanation = media.explanation;
      if (media.kind !== 'equation' && explanation) {
        const detail = element('div', 'paper-report-media-explanation');
        if (explanation.basis === 'unavailable') {
          const message = explanation.image_supplied ? '本次未能从原图提取可核对的解读。' : '本次未核读原图，题注与原文解读暂缺。';
          detail.append(element('p', 'paper-report-muted', message));
        } else if (typeof explanation.text === 'string') {
          const source = explanation.basis === 'visual' ? '图表解读 · 依据原图' : '图表解读 · 仅依据题注或正文';
          detail.append(element('p', 'paper-report-media-explanation-label', source));
          const text = element('p', 'copyable-data paper-report-media-explanation-text', explanation.text);
          for (const citation of explanation.citations || []) text.append(citationButton(session, citation));
          detail.append(text);
        }
        figure.append(detail);
      }
      return figure;
    }

    function citationButton(session, citation) {
      const label = labelForEvidence(citation);
      const control = button(label, () => showEvidence(session, citation), 'paper-report-inline paper-report-citation');
      control.setAttribute('aria-label', '查看原文证据，' + label);
      control.setAttribute('aria-haspopup', 'dialog');
      return control;
    }

    function showEvidence(session, citation) {
      if (current !== session) return;
      evidence = { session, citation };
      ui['evidence-title'].textContent = '原文证据 · ' + labelForEvidence(citation);
      ui.quote.textContent = citation.quote;
      ui.locate.disabled = false;
      reportStatus(ui['evidence-status']);
      if (!ui.evidence.open) ui.evidence.showModal();
      focus(ui['evidence-title']);
    }

    function takeSnapshot(session, snapshot) {
      session.report = snapshot.report;
      session.revision = snapshot.revision;
      session.history = snapshot.history;
      if (session.concept) {
        const next = session.report?.concepts.find((item) => item.id === session.concept.id);
        session.concept = next;
        if (!next && session.drawer === 'concept') session.drawer = null;
      }
    }

    async function loadReport(session, generate) {
      session.loading = true;
      session.readError = '';
      render(session);
      try {
        const snapshot = await api(path(session), { signal: session.abort.signal });
        if (current !== session) return;
        takeSnapshot(session, snapshot);
      } catch (error) {
        if (current !== session) return;
        session.readError = '报告读取失败。' + error.message;
      } finally {
        session.loading = false;
        render(session);
      }
      if (current !== session || session.readError) return;
      if (session.conceptId && session.report) showRequestedConcept(session);
      if (!session.report && generate && modelAvailable(session)) await generateReport(session);
    }

    async function generateReport(session, regenerate = false) {
      if (!canGenerateReport(session, regenerate)) return;
      session.generating = true;
      session.autoGenerateAttempted = true;
      session.notice = regenerate ? { text: '正在阅读原文并重新生成报告…' } : null;
      const base = session.revision;
      render(session);
      try {
        const { draft } = await api(path(session) + '/draft',
          requestOptions('POST', { expected_revision: base }, { closeBarrier: false, signal: session.abort.signal }));
        if (current !== session) return;
        session.draft = { report: draft, base, kind: regenerate ? 'regeneration' : 'initial' };
        if (regenerate) {
          session.notice = null;
          session.draftPreview = true;
        } else if (!await applyDraft(session)) {
          session.draftPreview = true;
        }
      } catch (error) {
        if (current !== session) return;
        if (error.status === 409) session.conflict = true;
        session.notice = { text: (regenerate ? '重新生成失败。' : '报告生成失败。') + error.message, error: true };
      } finally {
        session.generating = false;
        render(session);
        if (regenerate && current === session && isActive()) {
          const preview = ui.draft.querySelector('[data-report-preview]');
          if (preview) ui.scroll.scrollTop = 0;
          if (document.activeElement === document.body) {
            focus(preview || (ui.regenerate.disabled ? ui.title : ui.regenerate));
          }
        }
      }
    }

    async function saveReport(session, body) {
      if (session.write || session.conceptWrite || current !== session || session.conflict) return false;
      session.notice = { text: '正在保存…' };
      const write = (async () => {
        try {
          const snapshot = await api(path(session), requestOptions('PUT', body, { closeSave: true }));
          if (current !== session) return true;
          takeSnapshot(session, snapshot);
          session.edit = session.draft = null;
          session.draftPreview = false;
          session.notice = { text: '报告已保存。' };
          return true;
        } catch (error) {
          if (current !== session) return false;
          if (error.status === 409) session.conflict = true;
          session.notice = { text: '报告保存失败。' + error.message, error: true };
          return false;
        }
      })();
      session.write = write;
      render(session);
      const saved = await write;
      session.write = null;
      render(session);
      return saved;
    }

    function applyDraft(session) {
      if (!session.draft || session.edit) return false;
      return saveReport(session, { report: session.draft.report, expected_revision: session.draft.base, source: 'ai' });
    }

    function saveEdit(session) {
      if (!session.edit?.dirty) return true;
      return saveReport(session, { report: session.edit.report, expected_revision: session.edit.base, source: 'manual' });
    }

    async function loadLatest(session) {
      if (session.write) return;
      if (hasReportChanges(session) && !window.confirm('载入最新报告并放弃当前报告草稿？')) return;
      const write = (async () => {
        try {
          const snapshot = await api(path(session), { signal: session.abort.signal, closeSave: true });
          if (current !== session) return;
          takeSnapshot(session, snapshot);
          session.edit = session.draft = null;
          session.conflict = session.draftPreview = false;
          session.notice = null;
          return true;
        } catch (error) {
          if (current === session) session.notice = { text: '最新报告读取失败。' + error.message, error: true };
          return false;
        }
      })();
      session.write = write;
      render(session);
      await write;
      session.write = null;
      render(session);
      if (isActive() && current === session) focus(ui.title);
    }

    function switchDrawer(session, pane, anchor, { moveFocus = true } = {}) {
      if (current !== session) return;
      if (!pane) focus(session.drawerAnchor?.isConnected ? session.drawerAnchor : ui.discuss);
      session.drawer = pane;
      if (pane) session.drawerAnchor = anchor;
      refreshToolbar(session);
      renderDrawer(session);
      if (pane && moveFocus) focus(ui['drawer-title']);
    }

    function reportSelection() {
      if (!current?.report || !isActive() || current.edit || ui.evidence.open || ui['concept-article'].open
        || !modelAvailable(current)) return null;
      const selection = document.getSelection();
      if (!selection?.rangeCount || selection.isCollapsed) return null;
      const range = selection.getRangeAt(0);
      return ui.content.contains(range.startContainer) && ui.content.contains(range.endContainer) ? range : null;
    }

    function selectedProse(range) {
      let text = '';
      for (const prose of ui.content.querySelectorAll('.paper-report-prose')) {
        if (!range.intersectsNode(prose)) continue;
        const part = document.createRange();
        part.selectNodeContents(prose);
        if (part.compareBoundaryPoints(Range.START_TO_START, range) < 0) part.setStart(range.startContainer, range.startOffset);
        if (part.compareBoundaryPoints(Range.END_TO_END, range) > 0) part.setEnd(range.endContainer, range.endOffset);
        const excerpt = part.toString().trim();
        if (!excerpt) continue;
        text += (text ? '\n\n' : '') + excerpt;
        if (text.length > chatTextLimit) break;
      }
      const clipped = text.length > chatTextLimit;
      if (clipped) text = text.slice(0, chatTextLimit - 1).replace(/[\uD800-\uDBFF]$/u, '').trimEnd() + '…';
      return { text, clipped };
    }

    function queueSelection(delay) {
      window.clearTimeout(selectionTimer);
      if (selectionPointer === null) selectionTimer = window.setTimeout(discussSelection, delay);
    }

    function discussSelection() {
      const range = reportSelection();
      if (!range) {
        attachedRange = null;
        return;
      }
      if (attachedRange && range.compareBoundaryPoints(Range.START_TO_START, attachedRange) === 0
        && range.compareBoundaryPoints(Range.END_TO_END, attachedRange) === 0) return;
      const quote = selectedProse(range);
      if (!quote.text) return;
      attachedRange = range.cloneRange();
      const session = current;
      const chat = getChat(session, null);
      chat.quote = quote;
      if (session.drawer === 'discuss') renderDrawer(session);
      else switchDrawer(session, 'discuss', ui.discuss, { moveFocus: false });
    }

    function openConcept(session, concept, anchor) {
      session.concept = concept;
      switchDrawer(session, 'concept', anchor);
      if (!session.knowledgeLoaded && !session.knowledgeLoading && session.report?.concepts.some((item) => item.id === concept.id)) {
        void refreshConceptKnowledge(session);
      }
    }

    function showRequestedConcept(session) {
      if (!session.conceptId) return;
      const concept = session.report?.concepts.find((item) => item.id === session.conceptId);
      session.conceptId = null;
      if (concept) openConcept(session, concept, ui.title);
      else {
        session.notice = { text: '当前报告版本未包含这条知识记录对应的概念。', error: true };
        render(session);
      }
    }

    function setDrawerOpen(open) {
      if (!open && ui.drawer.contains(document.activeElement)) focus(ui.discuss);
      ui.drawer.inert = !open;
      ui.drawer.classList.toggle('is-open', open);
    }

    function renderDrawer(session) {
      setDrawerOpen(Boolean(session.drawer));
      if (!session.drawer) return;
      const titles = { discuss: '报告讨论', concept: '概念笔记', history: '版本历史' };
      ui['drawer-title'].textContent = titles[session.drawer];
      const previous = document.activeElement;
      const controlId = ui['drawer-content'].contains(previous) && previous.dataset.reportControl;
      if (session.drawer === 'history') {
        ui['drawer-content'].replaceChildren(renderHistory(session));
        return;
      }
      const isConcept = session.drawer === 'concept';
      const nodes = isConcept ? [renderConcept(session)] : [];
      const savedConcept = session.report?.concepts.some((concept) => concept.id === session.concept?.id);
      if (!isConcept || savedConcept) nodes.push(renderChat(session, isConcept ? session.concept.id : null));
      ui['drawer-content'].replaceChildren(...nodes);
      const messages = ui['drawer-content'].querySelector('.paper-report-messages');
      if (messages) messages.scrollTop = messages.scrollHeight;
      if (controlId) {
        const next = [...ui['drawer-content'].querySelectorAll('[data-report-control]')]
          .find((node) => node.dataset.reportControl === controlId && !node.disabled);
        focus(next);
        if (next instanceof HTMLTextAreaElement) next.setSelectionRange(previous.selectionStart, previous.selectionEnd);
      }
    }

    function renderHistory(session) {
      if (!session.history.length) return element('p', 'paper-report-muted', '暂无已保存版本。');
      const list = element('ol', 'paper-report-versions');
      for (const version of [...session.history].reverse()) {
        const row = element('li');
        const info = element('div');
        const label = sourceLabels[version.source];
        info.append(element('strong', '', '版本 ' + version.revision + (label ? ' · ' + label : '')));
        if (version.created_at) {
          const date = new Date(version.created_at);
          const time = element('time', '', Number.isNaN(date.getTime()) ? version.created_at : date.toLocaleString('zh-CN'));
          time.dateTime = version.created_at;
          info.append(time);
        }
        row.append(info);
        if (version.revision === session.revision) {
          row.append(element('span', 'paper-report-muted', '当前版本'));
        } else {
          const restore = button('恢复…', () => {
            if (!window.confirm('恢复版本 ' + version.revision + '？当前报告会保留在版本历史中。')) return;
            void saveReport(session, { expected_revision: session.revision, restore_revision: version.revision });
          });
          restore.disabled = Boolean(session.generating || session.write || session.conceptWrite || session.chatBusy || session.edit || session.draft || session.conflict);
          row.append(restore);
        }
        list.append(row);
      }
      return list;
    }

    function getChat(session, conceptId) {
      if (!session.chats.has(conceptId)) {
        session.chats.set(conceptId, { turns: [], input: '', error: '', mode: conceptId ? 'knowledge' : 'question' });
      }
      return session.chats.get(conceptId);
    }

    function renderChatQuote(text, { clipped = false, remove } = {}) {
      const quote = element('div', 'paper-report-chat-quote');
      const heading = element('div', 'paper-report-chat-quote-heading');
      heading.append(element('small', '', clipped ? '报告选段（已截取前 4000 字符）' : '报告选段'));
      if (remove) {
        const clear = button('×', remove, 'toolbar-icon-button');
        clear.setAttribute('aria-label', '移除选段');
        heading.append(clear);
      }
      quote.append(heading, element('blockquote', 'copyable-data', text));
      return quote;
    }

    function renderChat(session, conceptId) {
      const chat = getChat(session, conceptId);
      const surface = element('section', conceptId ? 'paper-report-chat' : 'paper-report-chat paper-report-chat--discussion');
      surface.setAttribute('aria-label', conceptId ? '概念讨论' : '报告讨论');
      if (!modelAvailable(session)) {
        surface.append(element('p', 'paper-report-muted', '在设置中配置 AI 对话后即可讨论。'));
        return surface;
      }
      const messages = element('ol', 'paper-report-messages');
      messages.setAttribute('aria-live', 'polite');
      for (const turn of chat.turns) {
        const row = element('li', 'paper-report-message copyable-data ' + turn.role);
        row.append(element('small', '', turn.role === 'user' ? '你' : 'AI'));
        if (turn.selected_text) row.append(renderChatQuote(turn.selected_text));
        row.append(element('div', 'copyable-data', turn.content));
        messages.append(row);
      }
      surface.append(messages);
      if (!conceptId && !chat.quote && !chat.turns.length) {
        surface.append(element('p', 'paper-report-chat-hint', '可以直接提问，也可以划选报告正文，把那段文字带入讨论。'));
      }
      const form = element('form', 'paper-report-form');
      const fieldLabel = element('label', '', conceptId ? '向 AI 追问概念' : '向 AI 讨论报告');
      const field = element('textarea', 'paper-report-editor');
      field.rows = 3;
      field.maxLength = chatTextLimit;
      field.dataset.reportControl = 'chat:' + (conceptId || 'report');
      field.required = true;
      field.value = chat.input;
      field.disabled = session.chatBusy === chat;
      field.placeholder = conceptId ? '这个概念用在论文的哪里？'
        : chat.quote ? '这段在说什么？它的依据是什么？' : '你想核对或修改什么？也可以选中报告文字提问。';
      field.addEventListener('input', () => { chat.input = field.value; });
      fieldLabel.append(field);
      const submit = element('button', 'primary-button compact-button', session.chatBusy === chat ? '正在发送…' : '发送');
      submit.type = 'submit';
      submit.disabled = Boolean(session.generating || session.chatBusy || session.write || session.edit || session.conflict);
      if (!conceptId) {
        const modeLabel = element('label', '', '讨论方式');
        const mode = element('select');
        for (const [value, label] of [['question', '提问'], ['revise', '建议修改报告']]) {
          const option = element('option', '', label);
          option.value = value;
          option.disabled = value === 'revise' && Boolean(session.draft);
          mode.append(option);
        }
        if (session.draft) chat.mode = 'question';
        mode.value = chat.mode;
        mode.addEventListener('change', () => { chat.mode = mode.value; });
        modeLabel.append(mode);
        form.append(modeLabel);
        if (session.draft?.kind === 'revision') {
          form.append(button('查看修改建议', () => {
            ui.scroll.scrollTop = 0;
            focus(ui.draft.querySelector('button[data-report-preview]'));
          }));
        }
      }
      if (session.edit) form.append(element('p', 'paper-report-muted', '完成编辑后可继续讨论。'));
      if (chat.error) {
        const failure = element('p', 'paper-report-status error', chat.error);
        failure.setAttribute('role', 'status');
        form.append(failure);
      }
      if (chat.quote) form.append(renderChatQuote(chat.quote.text, { clipped: chat.quote.clipped, remove: () => {
        chat.quote = null;
        renderDrawer(session);
        focus(ui['drawer-content'].querySelector('textarea:not(:disabled)'));
      } }));
      form.append(fieldLabel, submit);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        if (!submit.disabled && field.value.trim()) void sendChat(session, chat, conceptId);
      });
      surface.append(form);
      return surface;
    }

    async function sendChat(session, chat, conceptId) {
      const message = chat.input.trim();
      const quote = chat.quote;
      const payload = { expected_revision: session.revision, message, history: chat.turns.slice(-6), mode: chat.mode };
      if (conceptId) payload.concept_id = conceptId;
      if (quote) payload.selected_text = quote.text;
      chat.error = '';
      chat.input = '';
      chat.quote = null;
      chat.turns.push({ role: 'user', content: message, ...(quote && { selected_text: quote.text }) });
      session.chatBusy = chat;
      refreshToolbar(session);
      renderDrawer(session);
      try {
        const response = await api(path(session) + '/chat',
          requestOptions('POST', payload, { closeBarrier: false, signal: session.abort.signal }));
        if (current !== session) return;
        if (response.reply) chat.turns.push({ role: 'assistant', content: response.reply });
        if (response.draft) {
          session.draft = { report: response.draft, base: payload.expected_revision, kind: 'revision' };
          renderDraft(session);
        }
      } catch (error) {
        if (current !== session) return;
        chat.turns.pop();
        chat.input = message;
        chat.quote ??= quote;
        chat.error = '讨论请求失败。' + error.message;
        if (error.status === 409) {
          session.conflict = true;
          renderDraft(session);
        }
      } finally {
        session.chatBusy = null;
        if (current === session) {
          refreshToolbar(session);
          renderDrawer(session);
          if (isActive() && document.activeElement === document.body
            && (session.drawer === 'discuss' && !conceptId || session.drawer === 'concept' && session.concept?.id === conceptId)) {
            focus(ui['drawer-content'].querySelector('.paper-report-chat textarea'));
          }
        }
      }
    }

    let knowledgeVersion = 0;

    async function fetchKnowledge() {
      if (knowledgeRequest) return knowledgeRequest;
      const version = knowledgeVersion;
      const pending = (async () => {
        const { entries } = await api('/api/report-knowledge');
        if (knowledgeVersion === version) {
          knowledgeEntries = new Map(entries.map((entry) => [conceptKey(entry.job_id, entry.concept_id), entry]));
        }
        return knowledgeEntries;
      })();
      knowledgeRequest = pending;
      try { return await pending; }
      finally { if (knowledgeRequest === pending) knowledgeRequest = null; }
    }

    async function refreshConceptKnowledge(session) {
      session.knowledgeLoading = true;
      session.knowledgeError = '';
      renderDrawer(session);
      try {
        await fetchKnowledge();
        session.knowledgeLoaded = true;
      } catch (error) {
        session.knowledgeError = '概念记录读取失败。' + error.message;
      } finally {
        session.knowledgeLoading = false;
        if (current === session && session.drawer === 'concept') renderDrawer(session);
      }
    }

    function openConceptArticle(session, concept) {
      const revision = session.revision;
      const key = JSON.stringify([concept.id, revision]);
      const pending = session.articleLoads.get(key);
      const reading = pending || { session, concept, revision, key };
      conceptArticle = reading;
      ui['concept-article-title'].textContent = concept.term;
      ui['concept-article'].showModal();
      ui['concept-article-scroll'].scrollTop = 0;
      focus(ui['concept-article-title']);
      if (pending) renderConceptArticle(reading);
      else void loadConceptArticle(reading);
    }

    async function loadConceptArticle(reading) {
      const { session, concept, revision, key } = reading;
      if (reading.loading || current !== session || session.conflict || session.revision !== revision) return;
      const url = path(session) + '/concepts/' + encodeURIComponent(concept.id) + '/article';
      const signal = session.abort.signal;
      reading.loading = true;
      reading.error = '';
      reading.message = '正在读取完整解读…';
      session.articleLoads.set(key, reading);
      renderConceptArticle(reading);
      let generating = false;
      try {
        const { article } = await api(url + '?revision=' + revision, { signal });
        if (current !== session || session.revision !== revision || session.conflict) return;
        if (article) {
          reading.article = article;
        } else if (modelAvailable(session)) {
          generating = true;
          reading.message = '正在生成完整解读…';
          renderConceptArticle(reading);
          const result = await api(url, requestOptions('POST', { expected_revision: revision }, { closeBarrier: false, signal }));
          reading.article = result.article;
        } else {
          reading.message = '这个概念还没有完整解读。在设置中启用 AI 对话后，再打开这里即可生成。';
        }
      } catch (error) {
        if (current !== session || session.revision !== revision) return;
        if (error.code === 'report_revision_conflict') {
          session.conflict = true;
          renderDraft(session);
          refreshToolbar(session);
          if (session.drawer === 'concept') renderDrawer(session);
        } else {
          reading.error = (generating ? '完整解读生成失败。' : '完整解读读取失败。') + error.message;
        }
      } finally {
        reading.loading = false;
        session.articleLoads.delete(key);
        renderConceptArticle(reading);
      }
    }

    function renderConceptArticle(reading) {
      const { session, revision, article, loading, message, error } = reading;
      if (conceptArticle !== reading || current !== session || !ui['concept-article'].open) return;
      const outdated = session.conflict || session.revision !== revision;
      const status = session.conflict ? '报告已有更新。关闭解读并载入最新报告后，可重新打开。'
        : outdated ? '报告版本已更新。请关闭解读，再从当前报告打开。' : article ? '' : error || message;
      reportStatus(ui['concept-article-status'], status, !outdated && Boolean(error));
      ui['concept-article-retry'].hidden = outdated || !error;
      const content = ui['concept-article-content'];
      content.setAttribute('aria-busy', String(!outdated && Boolean(loading)));
      content.replaceChildren();
      if (outdated || !article) return;
      ui['concept-article-title'].textContent = article.term;
      for (const { key, paragraphs } of article.sections) {
        const section = element('section');
        section.append(element('h3', '', conceptArticleHeadings[key]));
        for (const { text, citations } of paragraphs) {
          const paragraph = element('p', 'paper-report-paragraph copyable-data', text);
          for (const citation of citations) paragraph.append(citationButton(session, citation));
          section.append(paragraph);
        }
        content.append(section);
      }
    }

    function renderConcept(session) {
      const concept = session.concept;
      const surface = element('section', 'paper-report-concept');
      surface.append(element('h3', 'copyable-data', concept.term), element('p', 'copyable-data', concept.definition));
      const savedConcept = session.report?.concepts.find((item) => item.id === concept.id);
      const read = button('查看完整解读', () => openConceptArticle(session, savedConcept), 'secondary-button paper-report-concept-read');
      read.id = 'paper-report-concept-read';
      read.dataset.reportControl = 'read:' + concept.id;
      read.setAttribute('aria-haspopup', 'dialog');
      read.setAttribute('aria-controls', 'paper-report-concept-article');
      read.disabled = !savedConcept || session.conflict;
      surface.append(read);
      if (!savedConcept) {
        surface.append(element('p', 'paper-report-muted', '保存报告草稿后，可查看完整解读并记录这个概念。'));
        return surface;
      }
      if (session.conflict) surface.append(element('p', 'paper-report-muted', '载入最新报告后可查看完整解读。'));
      else if (session.draftPreview) surface.append(element('p', 'paper-report-muted', '完整解读对应已保存的报告版本。'));
      if (session.knowledgeLoading || session.knowledgeError) {
        surface.append(element('p', 'paper-report-muted', session.knowledgeError || '正在读取概念记录…'));
        if (session.knowledgeError) surface.append(button('重试', () => void refreshConceptKnowledge(session)));
        return surface;
      }
      const saved = knowledgeEntries.get(conceptKey(session.job.job_id, concept.id));
      const form = element('form', 'paper-report-form');
      const input = session.conceptInputs.get(concept.id) || { status: saved?.status || 'unassessed', text: saved?.text || '', saved: saved?.saved || false };
      const stageLabel = element('label', '', '掌握程度');
      const stage = element('select');
      stage.dataset.reportControl = 'stage:' + concept.id;
      for (const [value, label] of Object.entries(statusLabels)) {
        const option = element('option', '', label);
        option.value = value;
        stage.append(option);
      }
      stage.value = input.status;
      stageLabel.append(stage);
      const textLabel = element('label', '', '我的理解');
      const field = element('textarea', 'paper-report-editor');
      field.value = input.text;
      field.maxLength = 16000;
      field.dataset.reportControl = 'note:' + concept.id;
      field.rows = 3;
      textLabel.append(field);
      const saveLabel = element('label', 'paper-report-checkbox');
      const save = element('input');
      save.type = 'checkbox';
      save.dataset.reportControl = 'save:' + concept.id;
      save.checked = input.saved;
      saveLabel.append(save, '加入知识库');
      const submit = element('button', 'secondary-button', session.conceptWrite ? '正在保存…' : '保存概念记录');
      submit.type = 'submit';
      function trackInputs() {
        const values = { status: stage.value, text: field.value, saved: save.checked };
        session.conceptInputs.set(concept.id, values);
        const changed = values.status !== (saved?.status || 'unassessed') || values.text !== (saved?.text || '') || values.saved !== (saved?.saved || false);
        if (changed) session.conceptDirty.add(concept.id);
        else session.conceptDirty.delete(concept.id);
        submit.disabled = Boolean(session.conceptWrite || session.write || session.conflict) || !changed;
        return values;
      }
      form.addEventListener('input', trackInputs);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        if (!submit.disabled) void saveConcept(session, concept, saved, trackInputs());
      });
      form.append(stageLabel, textLabel, saveLabel, submit);
      const suggestion = session.chats.get(concept.id)?.turns.findLast((turn) => turn.role === 'assistant');
      if (suggestion) {
        const useSuggestion = button('用作笔记草稿', () => {
          field.value = suggestion.content;
          trackInputs();
          focus(field);
        }, 'action-button');
        useSuggestion.disabled = Boolean(session.conceptWrite);
        textLabel.before(useSuggestion);
      }
      for (const control of [stage, field, save]) control.disabled = Boolean(session.conceptWrite);
      const notice = session.conceptNotices.get(concept.id);
      if (notice) {
        const status = element('p', 'paper-report-status', notice.text);
        status.classList.toggle('error', notice.error);
        status.setAttribute('role', 'status');
        form.append(status);
      }
      trackInputs();
      surface.append(form);
      return surface;
    }

    async function saveConcept(session, concept, saved, input) {
      if (session.conceptWrite || session.write) return;
      const body = { revision: session.revision, status: input.status };
      if (input.text !== (saved?.text || '')) body.text = input.text;
      if (input.saved !== (saved?.saved || false) || (input.saved && 'text' in body)) body.saved = input.saved;
      session.conceptNotices.delete(concept.id);
      const pending = (async () => {
        try {
          const entry = await api(path(session) + '/concepts/' + encodeURIComponent(concept.id),
            requestOptions('PUT', body, { closeSave: true }));
          knowledgeVersion += 1;
          knowledgeEntries.set(conceptKey(entry.job_id, entry.concept_id), entry);
          session.conceptInputs.delete(concept.id);
          session.conceptDirty.delete(concept.id);
          session.conceptNotices.set(concept.id, { text: '概念记录已保存。', error: false });
          return true;
        } catch (error) {
          session.conceptNotices.set(concept.id, { text: '概念记录保存失败。' + error.message, error: true });
          if (error.status === 409 && current === session) {
            session.conflict = true;
            renderDraft(session);
            refreshToolbar(session);
          }
          return false;
        }
      })();
      session.conceptWrite = pending;
      refreshToolbar(session);
      renderDraft(session);
      renderDrawer(session);
      await pending;
      session.conceptWrite = null;
      if (current === session) {
        refreshToolbar(session);
        renderDraft(session);
        if (session.drawer === 'concept') renderDrawer(session);
      }
    }

    async function openKnowledge({ focusTitle = true } = {}) {
      knowledgeList.replaceChildren(element('p', 'paper-report-muted', '正在读取知识库…'));
      if (focusTitle) focus(knowledgeTitle);
      try {
        const entries = await fetchKnowledge();
        if (!knowledgeView.classList.contains('active-view')) return;
        renderKnowledge([...entries.values()].filter((entry) => entry.saved));
      } catch (error) {
        if (!knowledgeView.classList.contains('active-view')) return;
        const failure = element('p', 'paper-report-status error', '知识库读取失败。' + error.message);
        failure.setAttribute('role', 'status');
        knowledgeList.replaceChildren(failure, button('重新读取', () => void openKnowledge({ focusTitle: false })));
      }
    }

    function renderKnowledge(entries) {
      if (!entries.length) {
        knowledgeList.replaceChildren(element('p', 'paper-report-muted', '打开一份精读报告，点选概念并加入知识库。'));
        return;
      }
      const list = document.createDocumentFragment();
      for (const entry of entries) {
        const item = element('article', 'report-knowledge-entry');
        const header = element('header');
        header.append(element('h2', 'copyable-data', entry.term), element('span', '', statusLabels[entry.status]));
        item.append(header);
        if (entry.text) item.append(element('p', 'report-knowledge-text copyable-data', entry.text));
        if (entry.citation?.quote) item.append(element('blockquote', 'copyable-data', entry.citation.quote));
        const actions = element('div', 'paper-report-actions');
        const status = element('p', 'paper-report-status error');
        status.setAttribute('role', 'status');
        status.hidden = true;
        const navigate = async (options) => {
          reportStatus(status);
          try { await openKnowledgeEntry(entry, options); }
          catch (error) { reportStatus(status, error.message, true); }
        };
        const title = entry.article_title || '来源报告';
        actions.append(button(title, () => void navigate(), 'action-button'));
        if (entry.citation) {
          actions.append(button('原文 · ' + labelForEvidence(entry.citation), () => void navigate({ evidence: entry.citation }), 'action-button'));
        }
        item.append(actions, status);
        list.append(item);
      }
      knowledgeList.replaceChildren(list);
    }

    function close() {
      current?.abort.abort();
      current = null;
      evidence = null;
      conceptArticle = null;
      window.clearTimeout(selectionTimer);
      selectionPointer = null;
      attachedRange = null;
      if (ui.evidence.open) ui.evidence.close();
      if (ui['concept-article'].open) ui['concept-article'].close();
      setDrawerOpen(false);
      ui.content.replaceChildren();
      ui['drawer-content'].replaceChildren();
    }

    async function open(job, { generate = true, conceptId = null } = {}) {
      if (current?.job.job_id === job.job_id) {
        current.job = job;
        if (conceptId) {
          current.conceptId = conceptId;
          if (current.report) showRequestedConcept(current);
        }
        if (!current.loading) render(current);
        if (generate && !current.autoGenerateAttempted && !current.loading && !current.readError && modelAvailable(current)) {
          await generateReport(current);
        }
        return;
      }
      close();
      const session = {
        job, conceptId, abort: new AbortController(), report: null, revision: 0, history: [],
        edit: null, draft: null, draftPreview: false, conflict: false, notice: null, drawer: null,
        chats: new Map(), articleLoads: new Map(), conceptInputs: new Map(), conceptNotices: new Map(), conceptDirty: new Set(),
      };
      current = session;
      ui.scroll.scrollTop = 0;
      const load = loadReport(session, generate);
      if (isActive()) focus(ui.title);
      await load;
    }

    function canLeave() {
      if (current?.write || current?.conceptWrite) return false;
      return !hasLocalChanges() || window.confirm('离开精读报告并放弃尚未保存的修改？');
    }

    async function flush() {
      const session = current;
      if (!session) return true;
      if (session.write && await session.write !== true) return false;
      if (session.conceptWrite && await session.conceptWrite !== true) return false;
      if ((session.conflict && hasLocalChanges()) || (session.draft && session.draft.kind !== 'initial') || session.conceptDirty.size) return false;
      if (session.draft?.kind === 'initial') return applyDraft(session);
      return saveEdit(session);
    }

    ui.back.addEventListener('click', () => backToLibrary());
    byId('report-knowledge-back').addEventListener('click', () => backToLibrary());
    ui.knowledge.addEventListener('click', () => showKnowledge());
    ui.original.addEventListener('click', () => { if (current) void openOriginal(current.job); });
    ui.regenerate.addEventListener('click', () => { if (current) void generateReport(current, true); });
    ui.edit.addEventListener('click', () => {
      const session = current;
      session.edit = { report: structuredClone(session.report), base: session.revision, dirty: false };
      render(session);
      focus(ui.content.querySelector('textarea'));
    });
    ui.save.addEventListener('click', async () => {
      const session = current;
      if (await saveEdit(session) && current === session && isActive()) focus(ui.edit);
    });
    ui['cancel-edit'].addEventListener('click', () => {
      if (current.edit.dirty && !window.confirm('放弃尚未保存的编辑？')) return;
      current.edit = null;
      render(current);
      focus(ui.edit);
    });
    for (const [name, pane] of [['discuss', 'discuss'], ['history', 'history']]) {
      ui[name].addEventListener('click', () => switchDrawer(current, current.drawer === pane ? null : pane, ui[name]));
    }
    document.addEventListener('selectionchange', () => {
      if (!isActive()) return;
      if (document.getSelection()?.isCollapsed) attachedRange = null;
      queueSelection(140);
    });
    ui.content.addEventListener('pointerdown', (event) => {
      if (!event.isPrimary || event.button !== 0) return;
      selectionPointer = event.pointerId;
      window.clearTimeout(selectionTimer);
    });
    function endSelection(event) {
      if (event.pointerId !== selectionPointer) return;
      selectionPointer = null;
      if (event.type === 'pointerup') queueSelection(0);
    }
    document.addEventListener('pointerup', endSelection);
    document.addEventListener('pointercancel', endSelection);
    ui['close-drawer'].addEventListener('click', () => switchDrawer(current, null));
    ui.drawer.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        switchDrawer(current, null);
      }
    });
    ui['concept-article-retry'].addEventListener('click', () => {
      if (!conceptArticle) return;
      focus(ui['concept-article-title']);
      void loadConceptArticle(conceptArticle);
    });
    ui['concept-article'].addEventListener('close', () => {
      if (ui['concept-article'].open) return;
      const reading = conceptArticle;
      conceptArticle = null;
      ui['concept-article-content'].replaceChildren();
      if (!reading || reading.session !== current || !isActive() || ui.evidence.open) return;
      const sameConcept = current.drawer === 'concept' && current.concept?.id === reading.concept.id;
      const read = byId('paper-report-concept-read');
      if (sameConcept) focus(read?.matches(':enabled') ? read : ui['drawer-title']);
      else focus(ui.title);
    });
    ui.locate.addEventListener('click', async () => {
      const target = evidence;
      if (!target || current !== target.session) return;
      ui.locate.disabled = true;
      ui.evidence.close();
      if (ui['concept-article'].open) ui['concept-article'].close();
      try {
        const result = await openSource(target.session.job, target.citation);
        if (result === false) throw new Error('找不到对应的原文段落。');
      } catch (error) {
        if (current !== target.session || evidence !== target || !isActive()) return;
        showEvidence(target.session, target.citation);
        reportStatus(ui['evidence-status'], error.message, true);
      }
    });

    return { open, openKnowledge, canLeave, flush, close };
  }

  window.GuziPaperReport = { create };
})();
