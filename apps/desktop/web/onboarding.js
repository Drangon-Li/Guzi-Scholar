// Onboarding: the first-run walkthrough and the startup library-recovery card.
//
// Split out of app.js as the second per-feature module after core.js. It uses
// the same window-attached shape as graph-model.js and graph-view.js, so the
// page keeps loading plain classic scripts with no build step.
//
// This cluster was picked first because it is the most self-contained one that
// the CI UI suite actually covers: it calls nothing else in app.js, and the
// only binding it shares is reducedMotionQuery, which is injected. Everything
// else comes from MyScholarCore or window.myScholarDesktop.
(function attachOnboarding(root) {
  function create({ reducedMotionQuery }) {
    const {
      $,
      $$,
      isDesktopApp,
      flushPersistentStateWrites,
      persistentStateGet,
      persistentStateSet,
    } = root.MyScholarCore;
    const onboardingStorageKey = 'my-scholar-onboarding-v2';
    const onboardingVersion = 2;

    let onboardingStepIndex = 0;
    let onboardingPreviousFocus = null;
    let onboardingFinishing = false;
    let onboardingStartupContext = null;

    function renderOnboardingStorage(report = onboardingStartupContext?.storage) {
      const card = $('#onboarding-library-recovery');
      const title = $('#onboarding-library-recovery-title');
      const detail = $('#onboarding-library-recovery-detail');
      const actions = $('#onboarding-library-conflict-actions');
      if (!card || !title || !detail || !actions) return;
      const legacy = Array.isArray(report?.legacy) ? report.legacy.filter((candidate) => candidate?.valid && !candidate.empty) : [];
      const selected = report?.selected || legacy[0] || null;
      const currentCount = Number(report?.current?.itemCount) || 0;
      const legacyCount = Number(selected?.itemCount) || 0;
      const currentUsable = Boolean(report?.current?.valid);
      const keepCurrent = $('#onboarding-keep-current-library');
      const useLegacy = $('#onboarding-use-legacy-library');
      card.hidden = false;
      card.classList.toggle('is-warning', ['conflict', 'invalid'].includes(report?.state));
      actions.hidden = true;
      if (keepCurrent) keepCurrent.hidden = false;
      if (useLegacy) useLegacy.hidden = false;
      if (report?.state === 'adopted') {
        title.textContent = `已恢复 ${legacyCount} 篇旧版文献`;
        detail.textContent = '继续使用原来的本地目录，没有复制、合并或删除任何文件。';
      } else if (report?.state === 'conflict') {
        title.textContent = currentUsable ? '发现两个都有内容的文献库' : '当前文献库无法安全读取';
        detail.textContent = currentUsable
          ? `当前库 ${currentCount} 篇，旧版库 ${legacyCount} 篇。为避免覆盖，请选择本次继续使用哪一个。`
          : `另一个旧版文献库包含 ${legacyCount} 篇文献，可以安全切换使用；当前目录会原样保留。`;
        actions.hidden = false;
        if (keepCurrent) {
          keepCurrent.hidden = !currentUsable;
          keepCurrent.dataset.path = report?.current?.path || '';
        }
        if (useLegacy) {
          useLegacy.hidden = !selected;
          useLegacy.dataset.path = selected?.path || '';
        }
      } else if (report?.state === 'invalid') {
        title.textContent = '发现旧版目录，但没有自动切换';
        detail.textContent = report?.legacy?.find((candidate) => candidate?.error)?.error || '旧版文献库结构无法安全识别，请稍后在设置中检查。';
      } else if (['already-selected', 'kept-current', 'selected-legacy'].includes(report?.state) && currentCount > 0) {
        title.textContent = `已连接包含 ${currentCount} 篇文献的本地库`;
        detail.textContent = '重复安装不会清除这个目录中的文献、笔记和标注。';
      } else {
        title.textContent = '本地文献库已准备好';
        detail.textContent = '没有发现需要恢复的旧版文献；以后重复安装仍会继续使用同一数据目录。';
      }
    }
    function hasCompletedOnboarding() {
      try {
        const payload = JSON.parse(persistentStateGet(onboardingStorageKey) || 'null');
        return Number(payload?.version) >= onboardingVersion && ['completed', 'skipped'].includes(payload?.action);
      } catch (_) {
        return false;
      }
    }
    function updateOnboardingStep(nextIndex, { focus = true } = {}) {
      const dialog = $('#onboarding-dialog');
      const slides = $$('[data-onboarding-step]');
      if (!dialog || !slides.length) return;
      onboardingStepIndex = Math.max(0, Math.min(slides.length - 1, Number(nextIndex) || 0));
      slides.forEach((slide, index) => {
        slide.classList.toggle('is-active', index === onboardingStepIndex);
        slide.classList.toggle('is-before', index < onboardingStepIndex);
        slide.classList.toggle('is-after', index > onboardingStepIndex);
        slide.setAttribute('aria-hidden', String(index !== onboardingStepIndex));
      });
      const activeSlide = slides[onboardingStepIndex];
      const heading = activeSlide.querySelector('h1');
      const description = activeSlide.querySelector('p[id]');
      if (heading) dialog.setAttribute('aria-labelledby', heading.id);
      if (description) dialog.setAttribute('aria-describedby', description.id);
      const current = onboardingStepIndex + 1;
      const label = $('#onboarding-step-label');
      if (label) label.textContent = `第 ${current} 步，共 ${slides.length} 步`;
      const progress = $('#onboarding-progress');
      if (progress) {
        progress.setAttribute('aria-valuemax', String(slides.length));
        progress.setAttribute('aria-valuenow', String(current));
        progress.querySelector('span').style.width = `${(current / slides.length) * 100}%`;
      }
      $$('#onboarding-dots span').forEach((dot, index) => dot.classList.toggle('is-active', index === onboardingStepIndex));
      const back = $('#onboarding-back');
      if (back) back.disabled = onboardingStepIndex === 0;
      const next = $('#onboarding-next');
      if (next) next.textContent = onboardingStepIndex === slides.length - 1 ? '进入谷子学术' : '下一步';
      if (focus && heading) heading.focus({ preventScroll: true });
    }
    function showOnboarding() {
      if (!isDesktopApp) return;
      const dialog = $('#onboarding-dialog');
      if (!dialog) return;
      onboardingPreviousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      onboardingFinishing = false;
      dialog.classList.remove('is-closing');
      const status = $('#onboarding-status');
      if (status) { status.hidden = true; status.textContent = ''; }
      renderOnboardingStorage();
      updateOnboardingStep(0, { focus: false });
      if (!dialog.open) dialog.showModal();
      window.requestAnimationFrame(() => dialog.querySelector('.onboarding-slide.is-active h1')?.focus({ preventScroll: true }));
    }
    async function finishOnboarding(action) {
      const dialog = $('#onboarding-dialog');
      if (!dialog?.open || onboardingFinishing) return;
      onboardingFinishing = true;
      const controls = [$('#onboarding-skip'), $('#onboarding-back'), $('#onboarding-next')].filter(Boolean);
      controls.forEach((control) => { control.disabled = true; });
      const status = $('#onboarding-status');
      if (status) { status.hidden = true; status.textContent = ''; }
      persistentStateSet(onboardingStorageKey, JSON.stringify({ version: onboardingVersion, action, completedAt: new Date().toISOString() }));
      try {
        await flushPersistentStateWrites();
      } catch (error) {
        onboardingFinishing = false;
        controls.forEach((control) => { control.disabled = false; });
        updateOnboardingStep(onboardingStepIndex, { focus: false });
        if (status) { status.textContent = error.message || '引导状态暂时无法保存，请重试。'; status.hidden = false; }
        return;
      }
      dialog.classList.add('is-closing');
      if (!reducedMotionQuery.matches) await new Promise((resolve) => window.setTimeout(resolve, 170));
      dialog.close(action);
      dialog.classList.remove('is-closing');
      onboardingFinishing = false;
      controls.forEach((control) => { control.disabled = false; });
      onboardingPreviousFocus?.focus?.({ preventScroll: true });
    }
    async function initializeOnboarding() {
      const settingsRow = $('#onboarding-settings-row');
      if (settingsRow) settingsRow.hidden = !isDesktopApp;
      if (!isDesktopApp) return;
      $('#onboarding-back')?.addEventListener('click', () => updateOnboardingStep(onboardingStepIndex - 1));
      $('#onboarding-next')?.addEventListener('click', () => {
        const finalStep = onboardingStepIndex >= $$('[data-onboarding-step]').length - 1;
        if (finalStep) void finishOnboarding('completed');
        else updateOnboardingStep(onboardingStepIndex + 1);
      });
      $('#onboarding-skip')?.addEventListener('click', () => { void finishOnboarding('skipped'); });
      $('#replay-onboarding')?.addEventListener('click', showOnboarding);
      $('#onboarding-dialog')?.addEventListener('cancel', (event) => {
        event.preventDefault();
        void finishOnboarding('skipped');
      });
      $('#onboarding-dialog')?.addEventListener('keydown', (event) => {
        if (event.target instanceof Element && event.target.closest('input,textarea,select,button,a')) return;
        if (event.key === 'ArrowLeft' && onboardingStepIndex > 0) { event.preventDefault(); updateOnboardingStep(onboardingStepIndex - 1); }
        if (event.key === 'ArrowRight' && onboardingStepIndex < $$('[data-onboarding-step]').length - 1) { event.preventDefault(); updateOnboardingStep(onboardingStepIndex + 1); }
      });
      const selectStartupLibrary = async (button) => {
        const selectedPath = String(button?.dataset.path || '');
        const desktop = window.myScholarDesktop;
        if (!selectedPath || typeof desktop?.selectStartupLibrary !== 'function') return;
        const controls = [$('#onboarding-keep-current-library'), $('#onboarding-use-legacy-library')].filter(Boolean);
        controls.forEach((control) => { control.disabled = true; });
        const title = $('#onboarding-library-recovery-title');
        const detail = $('#onboarding-library-recovery-detail');
        if (title) title.textContent = '正在安全切换文献库';
        if (detail) detail.textContent = '谷子学术会先等待保存完成，再切换路径并核对文献数量。';
        try {
          const result = await desktop.selectStartupLibrary(selectedPath);
          if (!result?.ok) throw new Error(result?.error || '文献库没有切换完成。');
          if (!result.reloading) {
            onboardingStartupContext.storage = {
              ...onboardingStartupContext.storage,
              state: 'kept-current',
              selected: { path: result.currentPath, itemCount: result.items, jobCount: result.jobs },
            };
            renderOnboardingStorage(onboardingStartupContext.storage);
          }
        } catch (error) {
          if (title) title.textContent = '文献库切换失败';
          if (detail) detail.textContent = error.message || '仍在使用原来的文献库，未覆盖任何文件。';
          controls.forEach((control) => { control.disabled = false; });
        }
      };
      $('#onboarding-keep-current-library')?.addEventListener('click', (event) => { void selectStartupLibrary(event.currentTarget); });
      $('#onboarding-use-legacy-library')?.addEventListener('click', (event) => { void selectStartupLibrary(event.currentTarget); });

      try {
        const response = await window.myScholarDesktop.getStartupContext();
        if (response?.ok) onboardingStartupContext = response;
      } catch (_) {
        onboardingStartupContext = { app: null, storage: { state: 'invalid', current: null, legacy: [] } };
      }
      renderOnboardingStorage(onboardingStartupContext?.storage);
      if (!hasCompletedOnboarding()) showOnboarding();
    }

    // loadAppInfo refetches the startup context for the update card; keep the
    // module's copy in step so a later no-argument render still has it.
    function setStartupContext(context) {
      onboardingStartupContext = context;
    }

    return Object.freeze({ renderOnboardingStorage, initializeOnboarding, setStartupContext });
  }

  const api = Object.freeze({ create });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MyScholarOnboarding = api;
})(typeof window === 'undefined' ? globalThis : window);
