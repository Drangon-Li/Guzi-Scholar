// Bottom-right tray for work that outlives the reader view: full-document
// translations and AI reflows keep going while another document, the library
// or the settings are on screen.
//
// The active document's own progress panels are static markup inside the tray
// and are painted by app.js, so their ids and aria state stay exactly what the
// reader always exposed. This module renders the cards for every other
// document's run, keeps the collapse toggle and its summary in step with what
// is visible, and lifts the toast above the tray by publishing the tray height
// as a CSS variable. Attaches to window like core.js so the page keeps loading
// plain classic scripts with no build step.
(function attachBackgroundTasks(root) {
  const KIND_LABELS = { translation: '全文翻译', reflow: 'AI 重排' };

  function create({ container, onOpen, onCancel, onDismiss }) {
    if (!container) return null;
    const list = container.querySelector('#background-tasks-list');
    const toggle = container.querySelector('#background-tasks-toggle');
    const summary = container.querySelector('#background-tasks-summary');
    const cards = new Map();
    let collapsed = false;

    function setCollapsed(next) {
      collapsed = Boolean(next);
      container.classList.toggle('is-collapsed', collapsed);
      toggle?.setAttribute('aria-expanded', String(!collapsed));
    }
    toggle?.addEventListener('click', () => setCollapsed(!collapsed));

    function buildCard(task) {
      const card = document.createElement('div');
      card.className = 'translation-progress background-task';
      card.dataset.taskId = task.id;
      card.setAttribute('role', 'status');
      card.innerHTML = `
        <span class="translation-progress-dots" aria-hidden="true"><span></span><span></span><span></span></span>
        <div class="translation-progress-main">
          <div class="translation-progress-head"><span class="background-task-kind"></span><span class="translation-progress-count"></span><span class="background-task-value"></span></div>
          <div class="translation-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="translation-progress-bar"></div></div>
          <div class="translation-progress-detail"></div>
        </div>
        <span class="background-task-actions"><button class="tiny-button" type="button" data-task-open>查看</button><button class="tiny-button" type="button" data-task-cancel>停止</button><button class="tiny-button" type="button" data-task-dismiss aria-label="关闭">×</button></span>`;
      const current = () => cards.get(task.id)?.task || task;
      card.querySelector('[data-task-open]').addEventListener('click', () => onOpen?.(current().jobId));
      card.querySelector('[data-task-cancel]').addEventListener('click', () => onCancel?.(current()));
      card.querySelector('[data-task-dismiss]').addEventListener('click', () => onDismiss?.(current()));
      return card;
    }

    function paint(card, task) {
      const kindLabel = task.kindLabel || KIND_LABELS[task.kind] || '';
      const progress = Math.max(0, Math.min(100, Math.round(Number(task.progress) || 0)));
      card.dataset.state = task.status;
      card.dataset.kind = task.kind;
      card.querySelector('.background-task-kind').textContent = kindLabel;
      const title = card.querySelector('.translation-progress-count');
      title.textContent = task.title || '';
      title.title = task.title || '';
      card.querySelector('.background-task-value').textContent = `${progress}%`;
      card.querySelector('.translation-progress-bar').style.width = `${progress}%`;
      const track = card.querySelector('[role="progressbar"]');
      track.setAttribute('aria-valuenow', String(progress));
      track.setAttribute('aria-label', `${kindLabel}：${task.label || ''} ${progress}%`);
      const detail = card.querySelector('.translation-progress-detail');
      const detailText = [task.label, task.detail].filter(Boolean).join(' · ');
      detail.textContent = detailText;
      detail.hidden = !detailText;
      card.querySelector('[data-task-cancel]').hidden = !task.cancellable;
      card.querySelector('[data-task-dismiss]').hidden = !task.dismissible;
    }

    function syncChrome() {
      const visible = [...container.querySelectorAll('.translation-progress')].filter((panel) => !panel.hidden);
      const stacked = visible.length > 1;
      if (toggle) toggle.hidden = !stacked;
      if (summary) summary.textContent = `${visible.length} 个后台任务`;
      if (!stacked && collapsed) setCollapsed(false);
    }

    // Cards are keyed so a progress tick updates text in place instead of
    // re-entering the tray with the rise-in animation on every paragraph.
    function render(tasks) {
      const seen = new Set();
      tasks.forEach((task) => {
        seen.add(task.id);
        let entry = cards.get(task.id);
        if (!entry) {
          entry = { element: buildCard(task), task };
          cards.set(task.id, entry);
          list.append(entry.element);
        }
        entry.task = task;
        paint(entry.element, task);
      });
      cards.forEach((entry, id) => {
        if (seen.has(id)) return;
        entry.element.remove();
        cards.delete(id);
      });
      syncChrome();
    }

    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver((entries) => {
        const height = Math.round(entries[0]?.contentRect?.height || 0);
        document.documentElement.style.setProperty('--background-tasks-offset', height ? `${height + 10}px` : '0px');
      });
      observer.observe(container);
    }

    return Object.freeze({ render, syncChrome, setCollapsed });
  }

  const api = Object.freeze({ create });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MyScholarBackgroundTasks = api;
})(typeof window === 'undefined' ? globalThis : window);
