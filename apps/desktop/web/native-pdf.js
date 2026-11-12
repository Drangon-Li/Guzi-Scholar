(() => {
  const pdfBase = '/web/vendor/pdfjs/';
  const maxFitWidth = 1100;
  const zoomLevels = [50, 75, 100, 125, 150, 200, 300];
  const legacyColors = { yellow: '#ffd400', red: '#ff6666', green: '#5fb236', blue: '#2ea8e5', purple: '#a28ae5', magenta: '#e56eee', orange: '#f19837', gray: '#aaaaaa' };
  let pdfModule;

  function loadPdfModule() {
    pdfModule ??= import(`${pdfBase}build/pdf.mjs`).then((pdf) => {
      pdf.GlobalWorkerOptions.workerSrc = `${pdfBase}build/pdf.worker.mjs`;
      return pdf;
    });
    return pdfModule;
  }

  function create({ container, translate, onParse, onOpenParsed, onBack, embedded = false,
    onSelection, onAnnotationClick, isSelectionInteraction, onViewportChange }) {
    let active;
    container.classList.add('native-pdf');
    container.classList.toggle('native-pdf-embedded', embedded);

    function open(job) {
      close();
      container.innerHTML = `
        <header class="native-pdf-toolbar">
          ${embedded ? '' : '<button type="button" data-native-pdf-action="back" class="action-button">‹ 文献库</button>'}
          <h1 id="native-pdf-title" class="native-pdf-title"></h1>
          <form class="native-pdf-pages" aria-label="PDF 页码">
            <button type="button" data-native-pdf-action="previous" class="action-button" aria-label="上一页" aria-keyshortcuts="ArrowLeft" title="上一页（←）">‹</button>
            <input class="native-pdf-page-input" type="text" inputmode="numeric" aria-label="页码">
            <span class="native-pdf-page-count"></span>
            <button type="button" data-native-pdf-action="next" class="action-button" aria-label="下一页" aria-keyshortcuts="ArrowRight" title="下一页（→）">›</button>
          </form>
          <div class="native-pdf-zoom" aria-label="PDF 缩放">
            <button type="button" data-native-pdf-action="zoom-out" class="action-button" aria-label="缩小">−</button>
            <select class="native-pdf-zoom-select" aria-label="缩放比例">
              <option value="fit">适合宽度</option>
              ${zoomLevels.map((zoom) => `<option value="${zoom}">${zoom}%</option>`).join('')}
            </select>
            <button type="button" data-native-pdf-action="zoom-in" class="action-button" aria-label="放大">+</button>
          </div>
          <div class="native-pdf-parse-controls">
            <span class="native-pdf-parse-status" role="status" hidden></span>
            <button type="button" data-native-pdf-action="parse" class="action-button">解析 PDF</button>
            <button type="button" data-native-pdf-action="open-parsed" class="action-button" hidden>打开解析版</button>
          </div>
        </header>
        <div class="native-pdf-scroll" tabindex="0" role="region" aria-label="原始 PDF">
          <div class="native-pdf-stage"></div>
          <div class="native-pdf-reader-state">
            <p class="native-pdf-reader-message" role="status"></p>
            <button type="button" data-native-pdf-action="retry-document" class="action-button" hidden>重试</button>
          </div>
        </div>
        <p class="native-pdf-page-hint" role="status" hidden></p>
        ${onSelection ? '' : `<div class="native-pdf-popover" role="group" aria-label="PDF 划词翻译" hidden>
          <div class="native-pdf-popover-actions">
            <button type="button" data-native-pdf-action="translate" class="action-button">翻译</button>
            <button type="button" data-native-pdf-action="copy" class="action-button" hidden>复制译文</button>
            <button type="button" data-native-pdf-action="dismiss" class="action-button" aria-label="关闭翻译" title="关闭翻译" hidden>×</button>
          </div>
          <p class="native-pdf-translation" aria-live="polite" hidden></p>
          <p class="native-pdf-copy-status" aria-live="polite" hidden></p>
        </div>`}`;

      const find = (selector) => container.querySelector(selector);
      const button = (action) => find(`[data-native-pdf-action="${action}"]`);
      const session = active = {
        job,
        annotations: new Map(),
        controller: new AbortController(),
        pageNumber: 1,
        pages: [],
        renderedPages: new Set(),
        title: find('.native-pdf-title'),
        scroll: find('.native-pdf-scroll'),
        stage: find('.native-pdf-stage'),
        pageInput: find('.native-pdf-page-input'),
        zoom: find('.native-pdf-zoom-select'),
        hint: find('.native-pdf-page-hint'),
        popover: find('.native-pdf-popover'),
        translation: find('.native-pdf-translation'),
        copyStatus: find('.native-pdf-copy-status'),
        button,
      };
      const { signal } = session.controller;
      session.title.textContent = job.title || job.source_filename || '原始 PDF';
      session.title.title = session.title.textContent;
      update(job);

      find('.native-pdf-pages').addEventListener('submit', (event) => {
        event.preventDefault();
        const number = Number(session.pageInput.value);
        if (Number.isInteger(number) && number > 0 && number <= session.pdf?.numPages) {
          goToPage(session, number);
        } else {
          session.pageInput.value = session.pageNumber;
        }
      }, { signal });
      session.pageInput.addEventListener('blur', () => { session.pageInput.value = session.pageNumber; }, { signal });
      session.zoom.addEventListener('change', () => resizePages(session), { signal });
      button('back')?.addEventListener('click', () => onBack(session.job), { signal });
      button('previous').addEventListener('click', () => goToPage(session, session.pageNumber - 1), { signal });
      button('next').addEventListener('click', () => goToPage(session, session.pageNumber + 1), { signal });
      button('zoom-out').addEventListener('click', () => stepZoom(session, -1), { signal });
      button('zoom-in').addEventListener('click', () => stepZoom(session, 1), { signal });
      button('retry-document').addEventListener('click', () => open(session.job), { signal });
      button('parse').addEventListener('click', () => parse(session), { signal });
      button('open-parsed').addEventListener('click', () => onOpenParsed(session.job), { signal });
      bindSelection(session);

      session.resize = new ResizeObserver(() => {
        if (!session.pages.length) return;
        const fitWidth = Math.min(session.scroll.clientWidth, maxFitWidth);
        if (session.zoom.value === 'fit' && session.fitWidth !== fitWidth) resizePages(session);
        else refreshViewport(session);
      });
      session.resize.observe(session.scroll);
      session.documentReady = loadDocument(session);
    }

    function update(job) {
      if (!active || active.job.job_id !== job.job_id) return;
      const session = active;
      session.job = job;
      const status = container.querySelector('.native-pdf-parse-status');
      const progress = { queued: '等待解析…', running: '正在解析…' }[job.status];
      const complete = job.status === 'completed';
      const failed = job.status === 'failed';
      if (progress || complete) session.parseError = '';
      const message = session.parseError || progress || (session.parsing ? '正在启动解析…' : failed ? 'PDF 解析失败。' : '');
      status.textContent = message;
      status.hidden = !message;
      status.classList.toggle('is-error', Boolean(session.parseError || failed));
      session.button('parse').hidden = complete || Boolean(progress);
      session.button('parse').disabled = Boolean(session.parsing);
      session.button('parse').textContent = failed ? '重试解析' : '解析 PDF';
      session.button('open-parsed').hidden = !complete;
    }

    async function parse(session) {
      session.parsing = true;
      session.parseError = '';
      update(session.job);
      try {
        await onParse(session.job);
      } catch (error) {
        session.parseError = error.message || '无法启动解析，请重试。';
      } finally {
        session.parsing = false;
        if (active === session) update(session.job);
      }
    }

    function close() {
      const session = active;
      if (!session) return;
      active = null;
      session.controller.abort();
      session.resize.disconnect();
      cancelAnimationFrame(session.scrollFrame);
      window.clearTimeout(session.rasterTimer);
      clearSelection(session);
      for (const page of session.renderedPages) releasePage(session, page);
      session.loading?.destroy().catch(() => {});
      container.replaceChildren();
    }

    function readerState(session, message = '', retry = false) {
      container.querySelector('.native-pdf-reader-message').textContent = message;
      container.querySelector('.native-pdf-reader-state').hidden = !message;
      session.button('retry-document').hidden = !retry;
    }

    async function loadDocument(session) {
      syncPageControls(session);
      readerState(session, '正在打开 PDF…');
      try {
        const { links } = session.job;
        if (!links?.source) throw new Error('找不到原始 PDF 文件。');
        session.pdfjs = await loadPdfModule();
        if (active !== session) return;
        session.loading = session.pdfjs.getDocument({
          url: links.source,
          cMapUrl: `${pdfBase}cmaps/`,
          standardFontDataUrl: `${pdfBase}standard_fonts/`,
          wasmUrl: `${pdfBase}wasm/`,
          iccUrl: `${pdfBase}iccs/`,
        });
        const pdf = await session.loading.promise;
        if (active !== session) return;
        const firstPage = await pdf.getPage(1);
        if (active !== session) return;
        session.pdf = pdf;
        session.firstBaseline = firstPage.getViewport({ scale: 96 / 72 });
        const shells = document.createDocumentFragment();
        for (let number = 1; number <= pdf.numPages; number++) {
          const wrapper = document.createElement('div');
          wrapper.className = 'native-pdf-page';
          wrapper.dataset.pageNumber = number;
          session.pages.push({ number, wrapper });
          shells.append(wrapper);
        }
        session.stage.append(shells);
        readerState(session);
        resizePages(session);
      } catch (error) {
        if (active !== session) return;
        const message = error.name === 'PasswordException'
          ? '这份 PDF 需要密码。请在解密后重新导入。'
          : `无法打开 PDF。${error.message || ''}`;
        readerState(session, message, error.name !== 'PasswordException');
      }
    }

    function syncPageControls(session) {
      const count = session.pdf?.numPages;
      session.pageInput.disabled = !count;
      session.pageInput.value = count ? session.pageNumber : '';
      container.querySelector('.native-pdf-page-count').textContent = count ? `/ ${count}` : '';
      session.button('previous').disabled = !count || session.pageNumber === 1;
      session.button('next').disabled = !count || session.pageNumber === count;
      session.zoom.disabled = !count;
      const page = session.pages[session.pageNumber - 1];
      const percent = page ? pageZoom(session, page) : 0;
      session.button('zoom-out').disabled = !count || !zoomLevels.some((zoom) => zoom < percent - 0.5);
      session.button('zoom-in').disabled = !count || !zoomLevels.some((zoom) => zoom > percent + 0.5);
    }

    function pageZoom(session, page) {
      if (session.zoom.value !== 'fit') return Number(session.zoom.value);
      const { width } = page.baseline || session.firstBaseline;
      return 100 * Math.min(2, Math.max(0.25, (session.fitWidth - 36) / width));
    }

    function sizePage(session, page) {
      const baseline = page.baseline || session.firstBaseline;
      const scale = pageZoom(session, page) / 100;
      page.viewportScale = baseline.scale * scale;
      page.wrapper.style.width = `${baseline.width * scale}px`;
      page.wrapper.style.height = `${baseline.height * scale}px`;
      page.wrapper.style.setProperty('--total-scale-factor', page.viewportScale * baseline.userUnit);
    }

    function pageAt(session, y) {
      let first = 0;
      let last = session.pages.length - 1;
      while (first < last) {
        const middle = Math.floor((first + last) / 2);
        const { wrapper } = session.pages[middle];
        if (wrapper.offsetTop + wrapper.offsetHeight <= y) first = middle + 1;
        else last = middle;
      }
      return first;
    }

    function refreshViewport(session, preferredPage) {
      if (!session.pages.length) return;
      const { scrollTop, clientHeight, scrollHeight } = session.scroll;
      const first = pageAt(session, scrollTop);
      const last = pageAt(session, scrollTop + clientHeight);
      if (preferredPage !== undefined || session.viewportTop !== scrollTop) {
        const bottom = scrollTop > 0 && scrollTop + clientHeight >= scrollHeight - 1;
        session.pageNumber = preferredPage ?? (bottom ? session.pages.length : pageAt(session, scrollTop + 22) + 1);
        session.viewportTop = scrollTop;
        syncPageControls(session);
        syncPageHint(session);
      }
      const nearby = new Set([session.pages[session.pageNumber - 1], ...session.pages.slice(Math.max(0, first - 1), last + 2)]);
      const selection = document.getSelection();
      for (const page of session.renderedPages) {
        if (nearby.has(page) || page === session.selection?.page ||
            (session.dragging && page.wrapper.contains(selection?.anchorNode))) continue;
        releasePage(session, page);
      }
      for (const page of nearby) renderPage(session, page);
      positionPopover(session);
      onViewportChange?.();
    }

    function goToPage(session, pageNumber) {
      const page = session.pages[pageNumber - 1];
      if (!page) return;
      clearSelection(session);
      const fromText = Boolean(document.activeElement?.closest('.native-pdf-page .textLayer'));
      if (fromText) session.scroll.focus({ preventScroll: true });
      session.scroll.scrollTop = page.wrapper.offsetTop - 18;
      refreshViewport(session, pageNumber);
      if (fromText) page.render.done.then(() => {
        if (active === session && document.activeElement === session.scroll && session.pageNumber === pageNumber) {
          page.render?.layer?.focus({ preventScroll: true });
        }
      });
      return page;
    }

    function resizePages(session) {
      if (!session.pages.length) return;
      const anchor = session.pages[pageAt(session, session.scroll.scrollTop)];
      const offset = session.scroll.scrollTop - anchor.wrapper.offsetTop;
      const fraction = Math.max(0, offset) / (anchor.wrapper.offsetHeight || 1);
      session.fitWidth = Math.min(session.scroll.clientWidth, maxFitWidth);
      for (const page of session.pages) sizePage(session, page);
      session.scroll.scrollTop = anchor.wrapper.offsetTop + Math.min(0, offset) + fraction * anchor.wrapper.offsetHeight;
      for (const { render } of session.renderedPages) {
        if (render.annotationElements.size) positionAnnotationAnchors(render);
      }
      refreshViewport(session, session.pageNumber);
      window.clearTimeout(session.rasterTimer);
      session.rasterTimer = window.setTimeout(() => {
        session.rasterTimer = 0;
        for (const page of session.renderedPages) void refreshPageRaster(session, page);
      }, 150);
    }

    function stepZoom(session, direction) {
      const current = pageZoom(session, session.pages[session.pageNumber - 1]);
      const zoom = direction < 0
        ? zoomLevels.findLast((level) => level < current - 0.5)
        : zoomLevels.find((level) => level > current + 0.5);
      if (!zoom) return;
      session.zoom.value = zoom;
      resizePages(session);
    }

    function releasePage(session, page) {
      const { render, wrapper } = page;
      page.render = null;
      session.renderedPages.delete(page);
      if (wrapper.contains(document.activeElement)) session.scroll.focus({ preventScroll: true });
      render.task?.cancel();
      render.textLayer?.cancel();
      if (render.canvas) {
        render.canvas.width = 0;
        render.canvas.height = 0;
      }
      render.page?.cleanup();
      wrapper.replaceChildren();
    }

    function renderPage(session, page) {
      if (page.render) return;
      const render = page.render = { annotationElements: new Map() };
      session.renderedPages.add(page);
      render.done = drawPage(session, page, render);
    }

    function syncPageHint(session) {
      const hint = session.pages[session.pageNumber - 1].hint;
      session.hint.textContent = hint || '';
      session.hint.hidden = !hint;
    }

    function canvasSize(viewport) {
      const density = Math.min(window.devicePixelRatio || 1, 2, 4096 / viewport.width,
        4096 / viewport.height, Math.sqrt(12000000 / (viewport.width * viewport.height)));
      return {
        width: Math.max(1, Math.floor(viewport.width * density)),
        height: Math.max(1, Math.floor(viewport.height * density)),
      };
    }

    function rasterizePage(page, viewport, { width, height }) {
      const canvas = document.createElement('canvas');
      canvas.setAttribute('aria-hidden', 'true');
      canvas.width = width;
      canvas.height = height;
      const task = page.render({
        canvas,
        viewport,
        transform: [width / viewport.width, 0, 0, height / viewport.height, 0, 0],
      });
      return { canvas, task };
    }

    async function refreshPageRaster(session, entry) {
      const { render, viewportScale } = entry;
      if (!render?.ready) return;
      const viewport = render.page.getViewport({ scale: viewportScale });
      const size = canvasSize(viewport);
      if (size.width === render.canvas.width && size.height === render.canvas.height) return;
      render.task?.cancel();
      const { canvas, task } = rasterizePage(render.page, viewport, size);
      render.task = task;
      try {
        await task.promise;
        if (active !== session || entry.render !== render || render.task !== task || entry.viewportScale !== viewportScale) return;
        const previous = render.canvas;
        previous.replaceWith(canvas);
        render.canvas = canvas;
        previous.width = previous.height = 0;
      } catch {
        // Keep the painted canvas if a newer resize cancels this render or rendering fails.
      } finally {
        if (render.task === task) render.task = null;
        if (render.canvas !== canvas) canvas.width = canvas.height = 0;
      }
    }

    async function drawPage(session, entry, render) {
      const { wrapper, number } = entry;
      const isCurrent = () => active === session && entry.render === render;
      try {
        const page = await session.pdf.getPage(number);
        if (!isCurrent()) return;
        render.page = page;
        if (!entry.baseline) {
          const { scrollTop } = session.scroll;
          const anchor = session.pages[pageAt(session, scrollTop + 22)].wrapper;
          const before = anchor.offsetTop;
          entry.baseline = page.getViewport({ scale: 96 / 72 });
          sizePage(session, entry);
          const shift = anchor.offsetTop - before;
          if (shift) {
            session.scroll.scrollTop = scrollTop + shift;
            session.viewportTop = session.scroll.scrollTop;
          }
        }
        const viewport = page.getViewport({ scale: entry.viewportScale });
        const layer = render.layer = document.createElement('div');
        layer.className = 'textLayer';
        layer.tabIndex = 0;
        layer.setAttribute('role', 'group');
        layer.setAttribute('aria-label', `第 ${number} 页文字`);
        const annotations = render.annotations = document.createElement('div');
        annotations.className = 'native-pdf-annotation-layer';
        const textLayer = render.textLayer = new session.pdfjs.TextLayer({
          textContentSource: page.streamTextContent(),
          container: layer,
          viewport,
        });
        const { canvas, task } = rasterizePage(page, viewport, canvasSize(viewport));
        render.canvas = canvas;
        render.task = task;
        wrapper.append(canvas, layer, annotations);
        const [drawing, text] = await Promise.allSettled([task.promise, textLayer.render()]);
        render.task = null;
        render.textLayer = null;
        if (!isCurrent()) return;
        if (drawing.status === 'rejected') throw drawing.reason;
        entry.hint = '';
        if (text.status === 'rejected' || !textLayer.textContentItemsStr.some((item) => item.trim())) {
          layer.remove();
          render.layer = null;
          entry.hint = text.status === 'rejected'
            ? '本页文字层加载失败，仍可查看原始页面。'
            : '本页没有可选文字。扫描页需先识别文字才能划词翻译。';
        }
        render.ready = true;
        paintAnnotations(session, entry);
        if (session.pageNumber === number) {
          syncPageControls(session);
          syncPageHint(session);
        }
        onViewportChange?.();
        if (!session.rasterTimer && entry.viewportScale !== viewport.scale) void refreshPageRaster(session, entry);
      } catch (error) {
        if (!isCurrent()) return;
        const message = document.createElement('div');
        message.className = 'native-pdf-page-error';
        const label = document.createElement('p');
        label.textContent = `无法显示第 ${number} 页。${error.message || ''}`;
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'action-button';
        retry.textContent = `重试第 ${number} 页`;
        retry.addEventListener('click', () => {
          releasePage(session, entry);
          renderPage(session, entry);
        }, { once: true });
        message.append(label, retry);
        wrapper.replaceChildren(message);
      }
    }

    function normalizedRects(range, wrapper) {
      const page = wrapper.getBoundingClientRect();
      const root = range.commonAncestorContainer;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const fragment = document.createRange();
      const lines = [];
      for (let node = root.nodeType === Node.TEXT_NODE ? root : walker.nextNode(); node; node = walker.nextNode()) {
        if (!range.intersectsNode(node)) continue;
        const start = node === range.startContainer ? range.startOffset : 0;
        const end = node === range.endContainer ? range.endOffset : node.length;
        if (start === end || !node.data.slice(start, end).trim()) continue;
        fragment.setStart(node, start);
        fragment.setEnd(node, end);
        for (const rect of fragment.getClientRects()) {
          if (!rect.width || !rect.height) continue;
          const previous = lines.at(-1);
          const wordGap = Math.max(3, rect.height * 0.5);
          if (previous && Math.abs(previous.top - rect.top) <= 2 && Math.abs(previous.bottom - rect.bottom) <= 2 &&
              rect.left <= previous.right + wordGap && rect.right >= previous.left - wordGap) {
            previous.left = Math.min(previous.left, rect.left);
            previous.right = Math.max(previous.right, rect.right);
          } else {
            lines.push({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
          }
        }
      }
      const normalize = (offset, size) => Math.round(Math.max(0, Math.min(1, offset / size)) * 1e6) / 1e6;
      return lines.map(({ left, top, right, bottom }) => [
        normalize(left - page.left, page.width), normalize(top - page.top, page.height),
        normalize(right - page.left, page.width), normalize(bottom - page.top, page.height),
      ]).filter(([left, top, right, bottom]) => left < right && top < bottom);
    }

    function buildPdfTextIndex(layer) {
      const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
      const positions = [];
      let text = '';
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const value = node.nodeType === Node.TEXT_NODE ? node.data : node.nodeName === 'BR' ? ' ' : '';
        for (let offset = 0; offset < value.length; offset++) {
          const character = /\s/u.test(value[offset]) ? ' ' : value[offset];
          if (character === ' ' && (!text || text.endsWith(' '))) continue;
          text += character;
          positions.push([node, offset]);
        }
      }
      return { text, positions };
    }

    function annotationRects(annotation, render, wrapper) {
      if (annotation.surface === 'pdf') return annotation.pdf_rects || [];
      if (!render.layer || annotation.surface === 'translation' || annotation.import_anchor_disabled) return [];
      const quote = annotation.quote?.trim().replace(/\s+/gu, ' ');
      if (!quote) return [];
      const { text, positions } = (render.quoteIndex ??= buildPdfTextIndex(render.layer));
      const start = text.indexOf(quote);
      if (start < 0 || text.indexOf(quote, start + 1) >= 0) return [];
      const [startNode, startOffset] = positions[start];
      const [endNode, endOffset] = positions[start + quote.length - 1];
      const range = document.createRange();
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset + 1);
      return normalizedRects(range, wrapper);
    }

    function paintAnnotations(session, page) {
      const { render, wrapper } = page;
      if (!render?.ready) return;
      const keep = new Set();
      for (const annotation of session.annotations.get(page.number) || []) {
        if (annotation.source === 'ai' || !['highlight', 'underline'].includes(annotation.kind)) continue;
        const rects = annotationRects(annotation, render, wrapper);
        if (!rects.length) continue;
        keep.add(annotation.id);
        let item = render.annotationElements.get(annotation.id);
        if (!item) {
          const group = document.createElement('div');
          group.className = 'native-pdf-annotation';
          const anchor = document.createElement('button');
          anchor.type = 'button';
          anchor.className = 'native-pdf-annotation-anchor annotation-note-trigger';
          anchor.dataset.annotationId = annotation.id;
          item = { group, anchor };
          group.append(anchor);
          render.annotations.append(group);
          render.annotationElements.set(annotation.id, item);
        }
        item.annotation = annotation;
        item.group.dataset.kind = annotation.kind;
        const color = legacyColors[annotation.color] || annotation.color;
        item.group.style.setProperty('--annotation-color', /^#[\da-f]{6}$/i.test(color) ? color : 'var(--user-highlight)');
        item.anchor.classList.toggle('has-note', Boolean(annotation.note?.trim()));
        const label = annotation.label || (annotation.kind === 'underline' ? '划线笔记' : '重点笔记');
        item.anchor.setAttribute('aria-label', label);
        item.anchor.title = label;
        if (JSON.stringify(rects) === JSON.stringify(item.rects)) continue;
        item.rects = rects;
        const marks = rects.map(([left, top, right, bottom]) => {
          const mark = document.createElement('span');
          mark.className = 'native-pdf-mark';
          mark.dataset.annotationId = annotation.id;
          mark.setAttribute('aria-hidden', 'true');
          Object.assign(mark.style, { left: `${left * 100}%`, top: `${top * 100}%`,
            width: `${(right - left) * 100}%`, height: `${(bottom - top) * 100}%` });
          return mark;
        });
        for (const oldMark of item.group.querySelectorAll('.native-pdf-mark')) oldMark.remove();
        item.anchor.before(...marks);
      }
      for (const [id, item] of render.annotationElements) {
        if (keep.has(id)) continue;
        item.group.remove();
        render.annotationElements.delete(id);
      }
      positionAnnotationAnchors(render);
    }

    function positionAnnotationAnchors(render) {
      const { clientWidth: width, clientHeight: height } = render.annotations;
      const anchorSize = 14;
      const spacing = anchorSize + 2;
      const placed = [];
      for (const { anchor, rects } of render.annotationElements.values()) {
        const [, top, right, bottom] = rects.at(-1);
        const y = Math.max(anchorSize / 2, Math.min(height - anchorSize / 2, (top + bottom) * height / 2));
        const preferred = Math.min(width - anchorSize, right * width + 3);
        const overlaps = (x) => placed.some((item) => Math.abs(item.x - x) < spacing && Math.abs(item.y - y) < spacing);
        let x = preferred;
        for (let offset = spacing; overlaps(x) && offset < width; offset += spacing) {
          const available = [preferred + offset, preferred - offset].find((candidate) =>
            candidate >= 0 && candidate <= width - anchorSize && !overlaps(candidate));
          if (available !== undefined) x = available;
        }
        placed.push({ x, y });
        anchor.style.left = `${x}px`;
        anchor.style.top = `${y}px`;
      }
    }

    function setAnnotations(list) {
      if (!active) return;
      active.annotations = Map.groupBy(list, (annotation) => Number(annotation.page));
      for (const page of active.renderedPages) paintAnnotations(active, page);
    }

    function annotationElement(id) {
      if (!active) return null;
      for (const page of active.renderedPages) {
        const item = page.render.annotationElements.get(id);
        if (item) return item.anchor;
      }
      return null;
    }

    async function locateAnnotation(annotation) {
      const session = active;
      const page = Number(annotation.page);
      if (!session || !Number.isInteger(page) || page < 1) return null;
      await session.documentReady;
      if (active !== session || !session.pdf || page > session.pdf.numPages) return null;
      const target = goToPage(session, page);
      let render;
      do {
        render = target.render;
        await render?.done;
      } while (active === session && session.pageNumber === page && render !== target.render);
      if (active !== session || session.pageNumber !== page) return null;
      const anchor = target.render?.annotationElements.get(annotation.id)?.anchor;
      anchor?.scrollIntoView({ block: 'center', inline: 'nearest', container: 'nearest' });
      return anchor;
    }

    function clickAnnotation(session, event) {
      const wrapper = event.target.closest('.native-pdf-page');
      const render = session.pages[Number(wrapper?.dataset.pageNumber) - 1]?.render;
      if (!onAnnotationClick || !render?.ready) return;
      const id = event.target.closest('.native-pdf-annotation-anchor')?.dataset.annotationId;
      let item = id ? render.annotationElements.get(id) : null;
      if (!item && !session.selection && !pdfSelection(session)) {
        const page = wrapper.getBoundingClientRect();
        const x = (event.clientX - page.left) / page.width;
        const y = (event.clientY - page.top) / page.height;
        item = Array.from(render.annotationElements.values()).findLast(({ rects }) =>
          rects.some(([left, top, right, bottom]) => x >= left && x <= right && y >= top && y <= bottom));
      }
      if (item) onAnnotationClick(session.job, item.annotation, item.anchor);
    }

    function textLayerFor(node) {
      return (node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement)?.closest('.native-pdf-page .textLayer');
    }

    function pdfSelection(session) {
      const selection = document.getSelection();
      if (selection?.isCollapsed || !selection?.rangeCount ||
          !session.stage.contains(textLayerFor(selection.anchorNode)) || !session.stage.contains(textLayerFor(selection.focusNode))) return null;
      return selection;
    }

    function clearSelection(session, { keepNative = false, notify = true } = {}) {
      if (!keepNative) pdfSelection(session)?.removeAllRanges();
      window.CSS?.highlights?.delete('guzi-native-pdf-selection');
      const hadSelection = Boolean(session.selection);
      session.keepSelection = false;
      session.selection = null;
      if (session.popover) session.popover.hidden = true;
      if (hadSelection && notify) onSelection?.(session.job, null);
    }

    function isPopoverInteraction(session, target) {
      return Boolean(session.popover?.contains(target) ||
        target?.closest?.('#selection-popover, .annotation-note-popover') || isSelectionInteraction?.(target));
    }

    function captureSelection(session) {
      if (session.dragging || session.extending) return;
      const selection = pdfSelection(session);
      const layer = textLayerFor(selection?.anchorNode);
      if (layer !== textLayerFor(selection?.focusNode)) {
        clearSelection(session, { keepNative: true });
        return;
      }
      const text = selection?.toString().trim();
      if (!text) {
        if (session.selection && (session.keepSelection || isPopoverInteraction(session, document.activeElement))) {
          if (window.Highlight) window.CSS?.highlights?.set('guzi-native-pdf-selection', new Highlight(session.selection.range));
        } else {
          clearSelection(session, { keepNative: true });
        }
        return;
      }
      const range = selection.getRangeAt(0);
      const prior = session.selection?.range;
      if (prior && prior.compareBoundaryPoints(Range.START_TO_START, range) === 0 &&
          prior.compareBoundaryPoints(Range.END_TO_END, range) === 0) return;
      clearSelection(session, { keepNative: true, notify: false });
      const page = session.pages[Number(layer.parentElement.dataset.pageNumber) - 1];
      session.selection = { range: range.cloneRange(), page, text, result: '', pending: false };
      if (onSelection) {
        const rect = selectionRect();
        const pdf_rects = normalizedRects(range, page.wrapper);
        if (rect && pdf_rects.length) {
          onSelection(session.job, { surface: 'pdf', page: page.number, pdf_rects, quote: text, rect });
        } else {
          clearSelection(session, { keepNative: true });
        }
        return;
      }
      session.copyStatus.hidden = true;
      session.button('copy').hidden = true;
      translateSelection(session);
    }

    function visibleSelectionRect(session) {
      if (!session?.selection) return null;
      const rect = session.scroll.getBoundingClientRect();
      const left = Math.max(0, rect.left);
      const right = Math.min(window.innerWidth, rect.right);
      const top = Math.max(0, rect.top);
      const bottom = Math.min(window.innerHeight, rect.bottom);
      return Array.from(session.selection.range.getClientRects()).findLast((fragment) => fragment.width > 0 && fragment.height > 0 &&
        fragment.bottom > top && fragment.top < bottom && fragment.right > left && fragment.left < right) || null;
    }

    function selectionRect() {
      return visibleSelectionRect(active);
    }

    function positionPopover(session) {
      if (!session.popover || !session.selection) return;
      const anchor = visibleSelectionRect(session);
      session.popover.hidden = !anchor;
      if (!anchor) return;
      const rect = session.scroll.getBoundingClientRect();
      const left = Math.max(0, rect.left);
      const right = Math.min(window.innerWidth, rect.right);
      const top = Math.max(0, rect.top);
      const bottom = Math.min(window.innerHeight, rect.bottom);
      const gap = 8;
      const { offsetWidth: width, offsetHeight: height } = session.popover;
      const upper = anchor.top - height - gap;
      const lower = anchor.bottom + gap;
      const y = upper >= top + gap ? upper : lower;
      const x = (anchor.left + anchor.right - width) / 2;
      session.popover.style.left = `${Math.max(left + gap, Math.min(right - width - gap, x))}px`;
      session.popover.style.top = `${Math.max(top + gap, Math.min(bottom - height - gap, y))}px`;
    }

    async function translateSelection(session) {
      const selection = session.selection;
      if (!selection || selection.pending) return;
      const focusWasOnTranslate = document.activeElement === session.button('translate');
      selection.pending = true;
      session.keepSelection = true;
      if (window.Highlight && window.CSS?.highlights) {
        window.CSS.highlights.set('guzi-native-pdf-selection', new Highlight(selection.range));
        pdfSelection(session)?.removeAllRanges();
      }
      session.button('translate').hidden = true;
      session.button('dismiss').hidden = false;
      if (focusWasOnTranslate) session.button('dismiss').focus();
      session.translation.hidden = false;
      session.translation.classList.remove('is-error');
      session.translation.textContent = '正在翻译…';
      positionPopover(session);
      try {
        const result = await translate(session.job, selection.text);
        if (active !== session || session.selection !== selection) return;
        if (!result?.trim()) throw new Error('翻译服务未返回译文。');
        selection.result = result;
        session.translation.textContent = result;
        session.button('copy').hidden = false;
      } catch (error) {
        if (active !== session || session.selection !== selection) return;
        session.translation.textContent = error.message || '翻译失败，请重试。';
        session.translation.classList.add('is-error');
        session.button('translate').textContent = '重试翻译';
        session.button('translate').hidden = false;
      } finally {
        selection.pending = false;
        if (active === session && session.selection === selection) positionPopover(session);
      }
    }

    function bindSelection(session) {
      const { signal } = session.controller;
      let frame;
      document.addEventListener('selectionchange', () => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => { if (active === session) captureSelection(session); });
      }, { signal });
      document.addEventListener('pointerdown', (event) => {
        if (isPopoverInteraction(session, event.target)) {
          if (session.selection) session.keepSelection = true;
          return;
        }
        clearSelection(session, { keepNative: true });
        session.dragging = session.stage.contains(event.target);
      }, { signal });
      document.addEventListener('pointerup', () => {
        if (!session.dragging) return;
        session.dragging = false;
        captureSelection(session);
      }, { signal });
      document.addEventListener('pointercancel', () => { session.dragging = false; }, { signal });
      document.addEventListener('keydown', (event) => {
        const onPage = session.stage.contains(event.target);
        if (event.key === 'Escape' && session.selection && (onPage || isPopoverInteraction(session, event.target))) {
          const restoreFocus = session.popover?.contains(document.activeElement);
          const layer = session.selection.page.render?.layer;
          clearSelection(session);
          if (restoreFocus) layer?.focus({ preventScroll: true });
          event.preventDefault();
          return;
        }
        if (!event.defaultPrevented && !event.isComposing && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey &&
            ['ArrowLeft', 'ArrowRight'].includes(event.key) && session.pdf && session.scroll.clientHeight &&
            (container.contains(event.target) || event.target === document.body) &&
            !event.target.closest('input, textarea, select, [contenteditable], [role="slider"], [role="listbox"]') &&
            !isPopoverInteraction(session, event.target) && !document.querySelector('dialog[open]')) {
          event.preventDefault();
          goToPage(session, session.pageNumber + (event.key === 'ArrowLeft' ? -1 : 1));
          return;
        }
        if (!onPage) return;
        if (event.key === 'Enter' && session.selection && session.popover && !session.popover.hidden && !session.button('translate').hidden) {
          event.preventDefault();
          session.keepSelection = true;
          session.button('translate').focus();
        }
        if (event.shiftKey && event.key.startsWith('Arrow')) extendSelection(session, event);
      }, { signal });
      document.addEventListener('keyup', (event) => {
        if (!session.extending || (event.key !== 'Shift' && !event.key.startsWith('Arrow'))) return;
        session.extending = false;
        captureSelection(session);
      }, { signal });
      session.stage.addEventListener('click', (event) => clickAnnotation(session, event), { signal });
      session.scroll.addEventListener('scroll', () => {
        cancelAnimationFrame(session.scrollFrame);
        session.scrollFrame = requestAnimationFrame(() => refreshViewport(session));
      }, { passive: true, signal });
      if (!session.popover) return;
      session.button('translate').addEventListener('pointerdown', (event) => event.preventDefault(), { signal });
      session.button('translate').addEventListener('click', () => translateSelection(session), { signal });
      session.button('dismiss').addEventListener('click', () => {
        const layer = session.selection?.page.render?.layer;
        clearSelection(session);
        layer?.focus({ preventScroll: true });
      }, { signal });
      session.button('copy').addEventListener('click', async () => {
        const selection = session.selection;
        if (!selection?.result) return;
        let message = '译文已复制';
        try {
          await navigator.clipboard.writeText(selection.result);
        } catch {
          message = '无法访问剪贴板，可手动选中译文复制。';
        }
        if (active !== session || session.selection !== selection) return;
        session.copyStatus.textContent = message;
        session.copyStatus.hidden = false;
        positionPopover(session);
      }, { signal });
    }

    function extendSelection(session, event) {
      const layer = textLayerFor(event.target);
      if (!layer) return;
      const selection = document.getSelection();
      if (!layer.contains(selection.anchorNode) || !layer.contains(selection.focusNode)) {
        const first = Array.from(layer.querySelectorAll('span')).find((span) =>
          span.firstChild?.nodeType === Node.TEXT_NODE && span.textContent.trim());
        if (!first) return;
        selection.collapse(first.firstChild, 0);
      }
      const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
      const direction = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'backward', ArrowDown: 'forward' }[event.key];
      const granularity = horizontal ? (event.altKey || event.ctrlKey ? 'word' : 'character') : 'line';
      session.extending = true;
      selection.modify('extend', direction, granularity);
      event.preventDefault();
    }

    return { open, update, close, setAnnotations, annotationElement, locateAnnotation, selectionRect,
      clearSelection: () => { if (active) clearSelection(active); } };
  }

  window.GuziNativePdf = { create };
})();
