const { launchManagedChromium } = require('./playwright.cjs');
const os = require('os');
const path = require('path');

const baseURL = process.argv[2] || 'http://127.0.0.1:8766';
// os.tmpdir() rather than /private/tmp, which only exists on macOS.
const screenshot = process.argv[3] || path.join(os.tmpdir(), 'my-scholar-reader.png');
const normalizeFontFamily = (value) => String(value || '').replace(/["']/gu, '').replace(/\s+/gu, '').toLowerCase();
let browser;
let browserSession;

(async () => {
  browserSession = await launchManagedChromium();
  browser = browserSession.browser;
  const page = await browser.newPage({ viewport: { width: 1500, height: 980 } });
  const errors = [];
  const selectionTranslationText = '这是选中文本的自动翻译结果。';
  const selectionTranslationRequests = [];
  const settingsWrites = [];
  let settingsAppearance = { app_font: 'system', reader_font: 'academic', accent: 'amber' };
  let settingsShortcuts = {};
  let settingsMetadata = { auto_retrieve: true, online_lookup: true, contact_email: '' };
  let activeSettingsWrites = 0;
  let maxConcurrentSettingsWrites = 0;
  let aiStatusHistory = [];
  let aiTestRequests = 0;
  let parsingInstallPolls = 0;
  let parsingDiscoverMode = 'empty';
  let parsingDiscoverRequests = 0;
  const parsingSelectedPaths = [];
  const parsingCandidates = [
    { executable: '/Users/test/mineru-a/bin/mineru', runtime_root: '/Users/test/mineru-a', source: 'virtualenv', version: 'mineru, version 3.4.4', health: { ready: true } },
    { executable: '/opt/homebrew/bin/mineru', runtime_root: '/opt/homebrew', source: 'homebrew', version: 'mineru, version 3.4.5', health: { ready: true } },
  ];
  let parsingProvider = {
    id: 'local-mineru',
    kind: 'local',
    state: 'not_installed',
    reason_code: 'not_installed',
    ready: false,
    can_install: true,
    version: '2.1.0',
    requirements: { min_os_version: '14', min_memory_bytes: 16 * 1024 ** 3, min_free_disk_bytes: 20 * 1024 ** 3 },
  };
  let settingsAI = {
    translation: { base_url: '', model: '', api_key_configured: false },
    chat: { base_url: '', model: '', api_key_configured: false },
  };
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  await page.route('**/api/health', async (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, service: 'my-scholar', version: '0.1', shell: 'reference', ai: { services: { translation: { enabled: true, configured: true, model: 'translation-smoke', profile_id: 'translation-smoke-profile' }, chat: { enabled: true, configured: true, model: 'chat-smoke', profile_id: 'chat-smoke-profile' } } } }),
  }));
  await page.route('**/api/settings', async (route) => {
    const isWrite = route.request().method() === 'POST';
    if (isWrite) {
      activeSettingsWrites += 1;
      maxConcurrentSettingsWrites = Math.max(maxConcurrentSettingsWrites, activeSettingsWrites);
      const payload = route.request().postDataJSON();
      settingsWrites.push(payload);
      settingsAppearance = { ...settingsAppearance, ...(payload.appearance || {}) };
      settingsShortcuts = { ...settingsShortcuts, ...(payload.shortcuts || {}) };
      settingsMetadata = { ...settingsMetadata, ...(payload.metadata || {}) };
      Object.keys(settingsAI).forEach((service) => {
        const incoming = payload.ai?.[service];
        if (!incoming) return;
        settingsAI[service] = {
          base_url: incoming.base_url || '',
          model: incoming.model || '',
          api_key_configured: Boolean(incoming.api_key || incoming.api_key_configured) || (settingsAI[service].api_key_configured && !incoming.clear_api_key),
        };
        if (incoming.clear_api_key) settingsAI[service].api_key_configured = false;
      });
      await new Promise((resolve) => setTimeout(resolve, 55));
      activeSettingsWrites -= 1;
    }
    const settings = { ai: settingsAI, ai_services: { translation: { enabled: true, model: 'translation-smoke' }, chat: { enabled: true, model: 'chat-smoke' } }, ai_status_history: aiStatusHistory, metadata: settingsMetadata, shortcuts: settingsShortcuts, appearance: settingsAppearance, highlight_color: '#f59e0b' };
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(isWrite ? { settings } : settings),
    });
  });
  await page.route('**/api/parsing/providers', async (route) => {
    if (parsingProvider.state === 'installing') {
      parsingInstallPolls += 1;
      if (parsingInstallPolls >= 2) {
        parsingProvider = {
          ...parsingProvider,
          state: 'ready', reason_code: 'ready', ready: true, can_install: false,
          installed_bytes: 18 * 1024 ** 3, progress: undefined, stage: undefined,
        };
      } else {
        parsingProvider = { ...parsingProvider, state: 'installing', progress: 0.48, stage: '正在下载模型' };
      }
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ providers: [parsingProvider, { id: 'remote-guzi', kind: 'remote', state: 'disabled', reason_code: 'not_configured', ready: false }] }) });
  });
  await page.route('**/api/parsing/providers/local-mineru/install', async (route) => {
    parsingInstallPolls = 0;
    parsingProvider = { ...parsingProvider, state: 'installing', reason_code: 'installing', ready: false, can_install: false, progress: 0.17, stage: '正在下载运行组件' };
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ provider: parsingProvider }) });
  });
  await page.route('**/api/parsing/providers/local-mineru/install/cancel', async (route) => {
    parsingProvider = { ...parsingProvider, state: 'cancelled', reason_code: 'cancelled', ready: false, can_install: true, progress: 0.48, stage: '安装已取消' };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ provider: parsingProvider }) });
  });
  await page.route('**/api/parsing/providers/local-mineru/discover', async (route) => {
    parsingDiscoverRequests += 1;
    if (route.request().method() !== 'POST') throw new Error('MinerU discovery did not use POST');
    const candidates = parsingDiscoverMode === 'empty' ? [] : parsingDiscoverMode === 'single' ? parsingCandidates.slice(0, 1) : parsingCandidates;
    if (parsingDiscoverMode === 'empty') {
      parsingProvider = { ...parsingProvider, state: 'artifact_unavailable', reason_code: 'artifact_unavailable', ready: false, can_install: false, version: 'unpublished', external: false };
    } else if (parsingDiscoverMode === 'single') {
      parsingProvider = { ...parsingProvider, state: 'ready', reason_code: 'ready', ready: true, can_install: false, external: true, source: 'external-discovery', version: parsingCandidates[0].version };
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ provider: parsingProvider, candidates, failures: [] }) });
  });
  await page.route('**/api/parsing/providers/local-mineru/select', async (route) => {
    const payload = route.request().postDataJSON();
    parsingSelectedPaths.push(payload.path);
    const candidate = parsingCandidates.find((item) => item.executable === payload.path || item.runtime_root === payload.path);
    parsingProvider = { ...parsingProvider, state: 'ready', reason_code: 'ready', ready: true, can_install: false, external: true, source: 'external-user-selected', version: candidate?.version || 'mineru, version 3.4.5' };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ provider: parsingProvider }) });
  });
  await page.route('**/api/parsing/providers/local-mineru/component', async (route) => {
    parsingProvider = { ...parsingProvider, state: 'not_installed', reason_code: 'not_installed', ready: false, can_install: true, version: '2.1.0', external: false, source: undefined, installed_bytes: undefined, progress: undefined, stage: undefined };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ provider: parsingProvider }) });
  });
  await page.route('**/api/ai/test', async (route) => {
    aiTestRequests += 1;
    const results = { translation: { ok: true, model: 'translation-smoke', elapsed_ms: 8 }, chat: { ok: true, model: 'chat-smoke', elapsed_ms: 11 } };
    const record = { checkedAt: '2026-08-06T08:00:00Z', results: { translation: { ok: true, elapsed_ms: 8 }, chat: { ok: true, elapsed_ms: 11 } } };
    aiStatusHistory = [record];
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ results, record }) });
  });
  await page.route('**/api/jobs/*/translate', async (route) => {
    const payload = route.request().postDataJSON();
    const isSelectionRequest = payload.block_id == null || payload.block_id === '';
    if (isSelectionRequest) selectionTranslationRequests.push(payload);
    await new Promise((resolve) => setTimeout(resolve, isSelectionRequest ? 260 : 10));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ result: { text: isSelectionRequest ? selectionTranslationText : '这是测试译文。', cached: false, profile_id: 'translation-smoke-profile' } }),
    });
  });
  await page.route('**/api/jobs/*/auto-highlights', async (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ result: { status: 'mock', highlights: [] } }),
  }));
  await page.goto(baseURL, { waitUntil: 'networkidle' });
  await page.locator('[data-view="settings-view"]').click();
  await page.locator('#settings-view.active-view').waitFor();
  if (await page.locator('#settings-account').count()) throw new Error('Account settings remained in the open-source UI');
  if (await page.locator('#account-username,#account-password,#account-invite,#account-email').count()) throw new Error('Account form fields remained in the open-source UI');
  if ((await page.locator('.ai-service-card').count()) !== 2) throw new Error('Settings did not render both AI service status cards');
  if (await page.locator('#setting-translation-base-url,#setting-chat-base-url,#setting-translation-api-key,#setting-chat-api-key,#setting-translation-model,#setting-chat-model').count() !== 6) throw new Error('User AI credential fields are missing from settings');
  if ((await page.locator('#setting-translation-api-key').getAttribute('type')) !== 'password' || (await page.locator('#setting-chat-api-key').getAttribute('type')) !== 'password') throw new Error('AI keys were not rendered as password fields');
  if (await page.locator('#setting-translation-clear-key[type="checkbox"],#setting-chat-clear-key[type="checkbox"]').count()) throw new Error('AI key clearing still uses an accidental checkbox control');
  if (await page.locator('#setting-translation-clear-key,#setting-chat-clear-key').count() !== 2) throw new Error('AI key clear buttons are missing');
  const translationProtocolStyle = await page.locator('#setting-translation-mode').evaluate((node) => {
    const style = getComputedStyle(node);
    return { borderRadius: style.borderRadius, minHeight: Number.parseFloat(style.minHeight), fontSize: Number.parseFloat(style.fontSize) };
  });
  if (translationProtocolStyle.borderRadius !== '8px' || translationProtocolStyle.minHeight < 40 || translationProtocolStyle.fontSize < 12) throw new Error(`Translation protocol select did not use the settings control style (${JSON.stringify(translationProtocolStyle)})`);
  if ((await page.locator('#settings-ai').textContent()).match(/translation-smoke|chat-smoke/)) throw new Error('Settings leaked model parameters into the AI service cards');
  const settingsStructure = await page.locator('#settings-view').evaluate((view) => {
    const form = view.querySelector('.settings-product-form');
    const sections = [...form.querySelectorAll(':scope > .settings-section')];
    const navigationLinks = [...view.querySelectorAll('.settings-navigation a[href^="#settings-"]')];
    const sectionRects = sections.map((section) => section.getBoundingClientRect());
    return {
      formCount: view.querySelectorAll('.settings-product-form').length,
      sectionIds: sections.map((section) => section.id),
      sectionTops: sectionRects.map((rect) => rect.top),
      sectionGaps: sectionRects.slice(1).map((rect, index) => rect.top - sectionRects[index].bottom),
      sectionBorders: sections.map((section) => getComputedStyle(section).borderTopWidth),
      sectionRadii: sections.map((section) => Number.parseFloat(getComputedStyle(section).borderTopLeftRadius)),
      visibleSectionIds: sections.filter((section) => !section.hidden && getComputedStyle(section).display !== 'none' && section.getBoundingClientRect().height > 0).map((section) => section.id),
      navigationCount: navigationLinks.length,
      navigationIcons: navigationLinks.map((link) => link.querySelectorAll('.settings-navigation-icon svg').length),
    };
  });
  const expectedSettingsSections = ['settings-reading', 'settings-shortcuts', 'settings-metadata', 'settings-parsing', 'settings-ai', 'settings-updates'];
  const sectionsAreCards = settingsStructure.sectionBorders.every((width) => width !== '0px') && settingsStructure.sectionRadii.every((radius) => radius >= 10);
  if (settingsStructure.formCount !== 1 || JSON.stringify(settingsStructure.sectionIds) !== JSON.stringify(expectedSettingsSections) || JSON.stringify(settingsStructure.visibleSectionIds) !== JSON.stringify(['settings-reading']) || !sectionsAreCards) throw new Error(`Settings modules did not render as single active card categories (${JSON.stringify(settingsStructure)})`);
  if (settingsStructure.navigationCount !== expectedSettingsSections.length || settingsStructure.navigationIcons.some((count) => count !== 1)) throw new Error(`Settings navigation did not render one SVG icon per module (${JSON.stringify(settingsStructure)})`);
  await page.locator('.settings-navigation a[href="#settings-parsing"]').click();
  await page.waitForFunction(() => document.querySelector('#local-mineru-status')?.textContent.trim() === '未安装');
  if (await page.locator('#remote-parsing-provider button').count()) throw new Error('The unavailable remote parsing provider exposed an action');
  if (!/不会上传 PDF/u.test(await page.locator('#remote-parsing-provider').textContent())) throw new Error('The remote parsing placeholder did not preserve the no-upload boundary');
  await page.locator('#scan-local-mineru').click();
  await page.locator('#local-mineru-discovery:not([hidden])').filter({ hasText: '未扫描到可复用的 MinerU' }).waitFor();
  if (parsingDiscoverRequests !== 1 || !/手动选择.*官方安装方式/u.test(await page.locator('#local-mineru-discovery').textContent())) throw new Error('Zero-candidate discovery did not expose manual reuse and official installation guidance');
  const installGuide = page.locator('#local-mineru-install-guide:not([hidden])');
  await installGuide.waitFor();
  if (!/opendatalab\/MinerU\/blob\/mineru-3\.4\.5-released\/docs\/zh\/quick_start\/index\.md/u.test(await installGuide.getAttribute('href'))) throw new Error('MinerU official installation guide did not use the pinned 3.4.5 documentation');
  if (await page.locator('#install-local-mineru').isVisible()) throw new Error('Artifact-unavailable discovery exposed a fake one-click installation action');

  await page.evaluate((selectedPath) => {
    window.myScholarDesktop = {
      chooseMineruComponent: async () => ({ ok: true, cancelled: false, path: selectedPath }),
    };
    document.querySelector('#import-local-mineru').click();
  }, parsingCandidates[0].runtime_root);
  await page.waitForFunction(() => document.querySelector('#local-mineru-status')?.textContent.trim() === '可以使用');
  if (parsingSelectedPaths.at(-1) !== parsingCandidates[0].runtime_root || !/已复用外部 MinerU/u.test(await page.locator('#local-mineru-detail').textContent())) throw new Error('Manual MinerU selection did not validate and reuse the chosen environment');
  await page.locator('#remove-local-mineru').click();
  await page.locator('#confirm-accept').click();
  await page.waitForFunction(() => document.querySelector('#local-mineru-status')?.textContent.trim() === '未安装');

  parsingDiscoverMode = 'single';
  const selectedBeforeSingleScan = parsingSelectedPaths.length;
  await page.locator('#scan-local-mineru').click();
  await page.locator('#local-mineru-discovery').filter({ hasText: '已自动复用本机版面引擎' }).waitFor();
  if (parsingSelectedPaths.length !== selectedBeforeSingleScan || !/已复用外部 MinerU/u.test(await page.locator('#local-mineru-detail').textContent())) throw new Error('Single-candidate discovery did not reuse the backend-activated environment');
  await page.locator('#remove-local-mineru').click();
  await page.locator('#confirm-accept').click();
  await page.waitForFunction(() => document.querySelector('#local-mineru-status')?.textContent.trim() === '未安装');

  parsingDiscoverMode = 'multiple';
  await page.locator('#scan-local-mineru').click();
  await page.locator('#local-mineru-discovery [data-reuse-mineru-candidate]').nth(1).click();
  await page.waitForFunction(() => document.querySelector('#local-mineru-status')?.textContent.trim() === '可以使用');
  if (parsingSelectedPaths.at(-1) !== parsingCandidates[1].executable || !/已复用外部 MinerU/u.test(await page.locator('#local-mineru-detail').textContent())) throw new Error('Selected MinerU candidate was not validated and reused through the selection endpoint');
  await page.locator('#remove-local-mineru').click();
  await page.locator('#confirm-accept').click();
  await page.waitForFunction(() => document.querySelector('#local-mineru-status')?.textContent.trim() === '未安装');

  await page.locator('#install-local-mineru').click();
  await page.locator('#confirm-dialog[open]').waitFor();
  if (!/macOS 14\+.*16\.00 GB 内存.*20\.00 GB 可用空间/u.test(await page.locator('#confirm-message').textContent())) throw new Error('The component confirmation omitted system requirements');
  await page.locator('#confirm-accept').click();
  await page.locator('#local-mineru-install-progress:not([hidden])').waitFor();
  await page.waitForFunction(() => {
    const value = Number.parseInt(document.querySelector('#local-mineru-install-value')?.textContent || '', 10);
    return value > 0 && value < 100;
  });
  await page.locator('#cancel-local-mineru-install').click();
  await page.waitForFunction(() => document.querySelector('#local-mineru-status')?.textContent.trim() === '已取消');
  if (await page.locator('#remove-local-mineru').isVisible()) throw new Error('A cancelled component install was shown as installed');
  await page.locator('#install-local-mineru').click();
  await page.locator('#confirm-accept').click();
  await page.waitForFunction(() => document.querySelector('#local-mineru-status')?.textContent.trim() === '可以使用');
  if (await page.locator('#local-mineru-version').textContent() !== 'v2.1.0' || await page.locator('#local-mineru-disk').textContent() !== '18.00 GB') throw new Error('Installed component metadata did not render');
  const settingsLayoutAt = async (width) => {
    await page.setViewportSize({ width, height: 980 });
    await page.waitForTimeout(80);
    return page.locator('#settings-view').evaluate((view) => {
      const navigation = view.querySelector('.settings-navigation').getBoundingClientRect();
      const form = view.querySelector('.settings-product-form').getBoundingClientRect();
      return { navigation: { top: navigation.top, right: navigation.right, bottom: navigation.bottom, width: navigation.width }, form: { top: form.top, left: form.left, right: form.right }, viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth };
    });
  };
  const settingsWide = await settingsLayoutAt(1500);
  const settingsMedium = await settingsLayoutAt(900);
  const settingsNarrow = await settingsLayoutAt(680);
  if (Math.abs(settingsWide.navigation.width - 250) > 2 || Math.abs(settingsWide.form.left - settingsWide.navigation.right - 30) > 2) throw new Error(`Wide settings layout does not match the library grid (${JSON.stringify(settingsWide)})`);
  if (Math.abs(settingsMedium.navigation.width - 210) > 2 || Math.abs(settingsMedium.form.left - settingsMedium.navigation.right - 16) > 2) throw new Error(`Medium settings layout did not use the compact grid (${JSON.stringify(settingsMedium)})`);
  if (settingsNarrow.form.top < settingsNarrow.navigation.bottom || settingsNarrow.scrollWidth > settingsNarrow.viewport + 1) throw new Error(`Narrow settings layout stacked or overflowed incorrectly (${JSON.stringify(settingsNarrow)})`);
  await page.setViewportSize({ width: 1500, height: 980 });
  await page.locator('.settings-navigation a[href="#settings-shortcuts"]').click();
  await page.waitForFunction(() => {
    const section = document.querySelector('#settings-shortcuts');
    const link = document.querySelector('.settings-navigation a[href="#settings-shortcuts"]');
    return section && !section.hidden && link?.getAttribute('aria-current') === 'location' && document.querySelectorAll('.settings-navigation a[aria-current]').length === 1;
  });
  if (await page.locator('.settings-navigation a[href="#settings-shortcuts"]').getAttribute('aria-current') !== 'location' || await page.locator('.settings-navigation a[aria-current]').count() !== 1) throw new Error('Settings navigation did not expose the current section');
  const shortcutSave = page.waitForResponse((response) => {
    if (!response.url().endsWith('/api/settings') || response.request().method() !== 'POST' || !response.ok()) return false;
    return response.request().postDataJSON()?.shortcuts?.highlight === 'Cmd+Shift+L';
  });
  const shortcutHighlight = page.locator('#shortcut-highlight');
  await shortcutHighlight.focus();
  await page.keyboard.press('Meta+Shift+L');
  await shortcutSave;
  await page.waitForFunction(() => document.querySelector('#settings-save-status')?.dataset.state === 'saved');
  if (await shortcutHighlight.inputValue() !== 'Cmd+Shift+L' || await shortcutHighlight.getAttribute('aria-invalid') !== 'false') throw new Error('Shortcut capture did not format and validate the pressed macOS combination');
  const shortcutUnderline = page.locator('#shortcut-underline');
  const writesBeforeDuplicateShortcut = settingsWrites.length;
  await shortcutUnderline.focus();
  await page.keyboard.press('Meta+Shift+L');
  if (await shortcutUnderline.getAttribute('aria-invalid') !== 'true' || !/已被其他操作使用/u.test(await page.locator('#shortcut-status').textContent())) throw new Error('Duplicate shortcut was not rejected with an accessible validation message');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(80);
  if (settingsWrites.length !== writesBeforeDuplicateShortcut || await shortcutUnderline.inputValue() !== 'Cmd+Shift+U') throw new Error('Invalid shortcut was saved or Escape did not restore the previous value');
  await page.locator('.settings-navigation a[href="#settings-metadata"]').click();
  const metadataEmail = page.locator('#setting-metadata-email');
  await metadataEmail.focus();
  await page.keyboard.press('Meta+1');
  if (await page.locator('#settings-view').isHidden()) throw new Error('Global application shortcut fired while a settings field was focused');
  const pendingEmail = `release-race-${Date.now()}@example.test`;
  await metadataEmail.fill(pendingEmail);
  await page.locator('[data-view="library-view"]').click();
  await page.locator('[data-view="settings-view"]').click();
  await page.locator('#settings-view.active-view').waitFor();
  await page.waitForFunction(() => document.querySelector('#settings-save-status')?.dataset.state === 'saved');
  if (await metadataEmail.inputValue() !== pendingEmail || settingsMetadata.contact_email !== pendingEmail) throw new Error('Re-entering settings replaced a pending text edit with stale server state');
  await page.locator('.settings-navigation a[href="#settings-reading"]').click();
  await page.waitForFunction(() => {
    const section = document.querySelector('#settings-reading');
    return section && !section.hidden && document.querySelector('.settings-navigation a[href="#settings-reading"]')?.getAttribute('aria-current') === 'location';
  });
  await page.waitForFunction(() => document.querySelector('#setting-app-font')?.value === 'system' && document.querySelector('#setting-reader-font')?.value === 'academic' && document.querySelector('input[name="setting-accent"][value="amber"]')?.checked);
  const finalAppearanceSave = page.waitForResponse((response) => {
    if (!response.url().endsWith('/api/settings') || response.request().method() !== 'POST' || !response.ok()) return false;
    const payload = response.request().postDataJSON();
    return JSON.stringify(payload?.appearance) === JSON.stringify({ app_font: 'songti', reader_font: 'georgia', accent: 'blue' });
  });
  await page.locator('#setting-app-font').selectOption('songti');
  await page.locator('#setting-reader-font').selectOption('georgia');
  await page.locator('input[name="setting-accent"][value="blue"]').check();
  await finalAppearanceSave;
  await page.waitForFunction(() => document.querySelector('#settings-save-status')?.dataset.state === 'saved');
  if (maxConcurrentSettingsWrites !== 1) throw new Error(`Settings writes were not serialized (${maxConcurrentSettingsWrites} concurrent requests)`);
  const appearancePreview = await page.locator('#settings-appearance-preview').evaluate((node) => {
    const style = getComputedStyle(node);
    return { accent: style.getPropertyValue('--accent').trim(), appFont: style.getPropertyValue('--preview-app-font').trim(), readerFont: style.getPropertyValue('--preview-reader-font').trim() };
  });
  if (appearancePreview.accent !== '#2563eb' || !/songti/iu.test(appearancePreview.appFont) || !/georgia/iu.test(appearancePreview.readerFont)) throw new Error(`Appearance controls did not update the scoped preview (${JSON.stringify(appearancePreview)})`);
  const settingsWrite = settingsWrites.at(-1) || {};
  if (JSON.stringify(settingsWrite.appearance) !== JSON.stringify({ app_font: 'songti', reader_font: 'georgia', accent: 'blue' })) throw new Error(`Settings did not save the selected appearance (${JSON.stringify(settingsWrite.appearance)})`);
  if (['base_url', 'model', 'api_key', 'ai_services', 'server_preset'].some((key) => Object.hasOwn(settingsWrite, key))) throw new Error(`Settings payload leaked fixed AI fields (${JSON.stringify(Object.keys(settingsWrite))})`);
  const rootAppearanceAfterSave = await page.locator('html').evaluate((node) => {
    const style = getComputedStyle(node);
    return { accent: style.getPropertyValue('--accent').trim(), appFont: style.getPropertyValue('--app-font').trim(), readerFont: style.getPropertyValue('--reader-content-font-family').trim() };
  });
  if (rootAppearanceAfterSave.accent !== '#2563eb' || !/songti/iu.test(rootAppearanceAfterSave.appFont) || !/georgia/iu.test(rootAppearanceAfterSave.readerFont)) throw new Error(`Saved appearance was not applied globally (${JSON.stringify(rootAppearanceAfterSave)})`);
  const libraryLocationFallback = await page.locator('.settings-library-location').evaluate((row) => {
    const button = row.querySelector('#choose-library-location');
    return {
      buttonDisabled: Boolean(button?.disabled),
      path: row.querySelector('#library-location-path')?.textContent?.trim(),
      status: row.querySelector('#library-location-status')?.textContent?.trim(),
    };
  });
  if (!libraryLocationFallback.buttonDisabled || !/浏览器服务/u.test(libraryLocationFallback.path || '') || !/桌面客户端/u.test(libraryLocationFallback.status || '')) throw new Error(`Browser settings did not expose the desktop-only library location fallback (${JSON.stringify(libraryLocationFallback)})`);
  const aiSourceText = await page.locator('#settings-updates').textContent();
  const sourceHref = await page.locator('#settings-updates a[href*="github.com/Chinese-Dragon-Li/Guzi-Scholar"]').getAttribute('href');
  if (!/谷子学术|Guzi Scholar/u.test(aiSourceText) || !sourceHref) throw new Error('Open-source attribution was missing from the settings page');
  await page.locator('.settings-navigation a[href="#settings-ai"]').click();
  const translationBaseURL = page.locator('#setting-translation-base-url');
  const translationKey = page.locator('#setting-translation-api-key');
  const translationModel = page.locator('#setting-translation-model');
  const chatBaseURL = page.locator('#setting-chat-base-url');
  const chatKey = page.locator('#setting-chat-api-key');
  const chatModel = page.locator('#setting-chat-model');
  const aiConfigSave = page.waitForResponse((response) => {
    if (!response.url().endsWith('/api/settings') || response.request().method() !== 'POST' || !response.ok()) return false;
    const payload = response.request().postDataJSON();
    return payload?.ai?.translation?.base_url === 'https://translate.example/v1' && payload?.ai?.chat?.model === 'chat-model';
  });
  await translationBaseURL.fill('https://translate.example/v1');
  await translationKey.fill('translation-secret');
  await translationModel.fill('translate-model');
  await chatBaseURL.fill('https://chat.example/v1');
  await chatKey.fill('chat-secret');
  await chatModel.fill('chat-model');
  await aiConfigSave;
  await page.waitForFunction(() => document.querySelector('#settings-save-status')?.dataset.state === 'saved');
  const aiWrite = settingsWrites.at(-1)?.ai;
  if (aiWrite?.translation?.api_key !== 'translation-secret' || aiWrite?.chat?.api_key !== 'chat-secret') throw new Error(`AI credentials were not included in the settings payload (${JSON.stringify(aiWrite)})`);
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('[data-view="settings-view"]').click();
  await page.locator('#settings-view.active-view').waitFor();
  if (await translationKey.inputValue() !== '' || await chatKey.inputValue() !== '') throw new Error('Saved AI keys were echoed back into password inputs');
  if (!/已配置/u.test(await translationKey.getAttribute('placeholder')) || !/已配置/u.test(await chatKey.getAttribute('placeholder'))) throw new Error('Configured AI key state was not exposed without revealing the secret');
  const clearSave = page.waitForResponse((response) => response.url().endsWith('/api/settings') && response.request().method() === 'POST' && response.ok() && response.request().postDataJSON()?.ai?.translation?.clear_api_key === true);
  await page.locator('#setting-translation-clear-key').click();
  await clearSave;
  await page.waitForFunction(() => document.querySelector('#settings-save-status')?.dataset.state === 'saved');
  if (settingsAI.translation.api_key_configured) throw new Error('Clearing the translation API key did not update persisted state');

  if (await page.locator('#ai-status-overview-title').textContent() !== '尚未检测' || await page.locator('#settings-ai .ai-service-status.is-unknown').count() !== 2 || await page.locator('#ai-status-history-list .ai-status-history-empty').count() !== 1) throw new Error('Configured AI services were presented as checked before a real connection test');
  const writesBeforeTest = settingsWrites.length;
  await page.locator('#test-ai-button').click();
  await page.locator('#ai-status-overview.is-operational #ai-status-overview-title').filter({ hasText: 'AI 服务运行正常' }).waitFor();
  const aiStatusResult = await page.locator('#settings-ai').evaluate((section) => ({
    translationLatency: section.querySelector('#setting-translation-latency')?.textContent?.trim(),
    chatLatency: section.querySelector('#setting-chat-latency')?.textContent?.trim(),
    historyRows: section.querySelectorAll('#ai-status-history-list > li.is-operational').length,
    historyText: section.querySelector('#ai-status-history-list')?.textContent?.trim(),
  }));
  if (aiStatusResult.translationLatency !== '8 ms' || aiStatusResult.chatLatency !== '11 ms' || aiStatusResult.historyRows !== 1 || !/全部服务正常/u.test(aiStatusResult.historyText || '')) throw new Error(`AI status page did not render latency and persisted history (${JSON.stringify(aiStatusResult)})`);
  if (aiTestRequests !== 1 || settingsWrites.length !== writesBeforeTest) throw new Error('AI connection test saved settings or made an unexpected number of test requests');
  await page.locator('[data-view="library-view"]').click();
  const testDocumentCard = page.locator('.library-card').filter({ hasText: 'OneLLM: One Framework' }).first();
  await testDocumentCard.waitFor();
  const jobId = await testDocumentCard.getAttribute('data-job-id');
  const metadataSnapshot = await page.evaluate(async (id) => (await (await fetch(`/api/library/items/${id}/metadata`)).json()).metadata, jobId);
  let metadataDialogGets = 0;
  await page.route(`**/api/library/items/${jobId}/metadata`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    metadataDialogGets += 1;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ metadata: { ...metadataSnapshot, status: 'retrieving' } }) });
  });
  await page.route(`**/api/library/items/${jobId}/metadata/retrieve`, async (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ metadata: { ...metadataSnapshot, status: 'retrieving' } }) }));
  await testDocumentCard.click();
  await page.locator('#library-details [data-details-action="metadata"]').click();
  await page.locator('#metadata-dialog[open]').waitFor();
  await page.locator('#metadata-retrieve-button').click();
  await page.locator('#metadata-dialog .dialog-close').click();
  await page.locator('#metadata-dialog').waitFor({ state: 'hidden' });
  await page.waitForTimeout(650);
  if (metadataDialogGets !== 1) throw new Error(`Closing the metadata editor did not cancel its fixed-job polling session (${metadataDialogGets} GETs)`);
  await page.unroute(`**/api/library/items/${jobId}/metadata`);
  await page.unroute(`**/api/library/items/${jobId}/metadata/retrieve`);
  const annotations = await page.evaluate(async (id) => (await fetch(`/api/jobs/${id}/annotations`)).json(), jobId);
  for (const annotation of annotations.annotations || []) {
    if (annotation.block_id !== 'block-1-6-paragraph' || !String(annotation.quote || '').startsWith('Large Language Models (LLMs)')) continue;
    await page.evaluate(async ({ id, annotationId }) => fetch(`/api/jobs/${id}/annotations/${annotationId}`, { method: 'DELETE' }), { id: jobId, annotationId: annotation.id });
  }
  await testDocumentCard.dblclick();
  await page.locator('#reader-view.active-view').waitFor();
  await page.locator('#reader-sidebar.is-open').waitFor();
  const assistantToggle = page.locator('#assistant-toggle');
  if (await assistantToggle.getAttribute('aria-expanded') !== 'true') throw new Error('Desktop assistant was not open by default');
  if (await assistantToggle.locator('svg').count() !== 1 || (await assistantToggle.textContent()).includes('▣')) throw new Error('Reader assistant still uses a placeholder instead of its SVG icon');
  const desktopOpenAssistantLabel = await assistantToggle.getAttribute('aria-label');
  if (!desktopOpenAssistantLabel || !/折叠|关闭/u.test(desktopOpenAssistantLabel)) throw new Error(`Open desktop assistant did not expose a dynamic accessible label (${desktopOpenAssistantLabel})`);
  const desktopLayout = await page.evaluate(() => {
    const sidebar = document.querySelector('#reader-sidebar');
    const frameWrap = document.querySelector('.reader-frame-wrap');
    const sidebarRect = sidebar.getBoundingClientRect();
    const frameRect = frameWrap.getBoundingClientRect();
    const frameStyle = getComputedStyle(frameWrap);
    return {
      sidebarLeft: sidebarRect.left,
      sidebarRight: sidebarRect.right,
      frameLeft: frameRect.left,
      frameRight: frameRect.right,
      gap: frameRect.left - sidebarRect.right,
      borderTopWidth: frameStyle.borderTopWidth,
      borderRightWidth: frameStyle.borderRightWidth,
      borderBottomWidth: frameStyle.borderBottomWidth,
      borderLeftWidth: frameStyle.borderLeftWidth,
      borderRadius: frameStyle.borderRadius,
      boxShadow: frameStyle.boxShadow,
    };
  });
  if (desktopLayout.sidebarRight <= desktopLayout.frameRight - 1 || desktopLayout.sidebarLeft < desktopLayout.frameRight - 1) throw new Error('Reader did not use a right-assistant/right-docked layout');
  if ([desktopLayout.borderTopWidth, desktopLayout.borderRightWidth, desktopLayout.borderBottomWidth, desktopLayout.borderLeftWidth].some((value) => parseFloat(value) > 0) || parseFloat(desktopLayout.borderRadius) > 0 || desktopLayout.boxShadow !== 'none') throw new Error('Reader still used a card-like visual boundary');
  await assistantToggle.click();
  await page.locator('#reader-sidebar:not(.is-open)').waitFor();
  const desktopClosedAssistantLabel = await assistantToggle.getAttribute('aria-label');
  if (!desktopClosedAssistantLabel || !/展开|打开/u.test(desktopClosedAssistantLabel) || desktopClosedAssistantLabel === desktopOpenAssistantLabel) throw new Error(`Collapsed desktop assistant did not update its accessible label (${desktopClosedAssistantLabel})`);
  await assistantToggle.click();
  await page.locator('#reader-sidebar.is-open').waitFor();
  await page.keyboard.press('Escape');
  if (await assistantToggle.getAttribute('aria-expanded') !== 'true') throw new Error('Escape incorrectly collapsed the docked desktop assistant');
  const sidebarPanels = ['chat-panel', 'outline-panel', 'highlights-panel', 'annotations-panel', 'notes-panel'];
  for (const panelId of sidebarPanels) {
    await page.locator(`.sidebar-tab[data-panel="${panelId}"]`).click();
    const panel = page.locator(`#${panelId}`);
    await page.locator(`#${panelId}.active-panel:not([hidden])`).waitFor();
    if (await panel.isHidden()) throw new Error(`Sidebar panel ${panelId} did not become visible`);
    if (await page.locator(`.sidebar-tab[data-panel="${panelId}"]`).getAttribute('aria-selected') !== 'true') throw new Error(`Sidebar tab ${panelId} did not expose its active state`);
  }
  if (await page.locator('.sidebar-tab[data-panel="translation-panel"], #translation-panel, #translation-panel-start, #translation-summary').count()) throw new Error('The removed translation subpage is still present in the reading assistant');

  const assistantResizer = page.locator('#reader-sidebar-resizer');
  await assistantResizer.waitFor({ state: 'visible' });
  const resizerSemantics = await assistantResizer.evaluate((node) => ({
    role: node.getAttribute('role'),
    orientation: node.getAttribute('aria-orientation'),
    controls: node.getAttribute('aria-controls'),
    minimum: Number(node.getAttribute('aria-valuemin')),
    maximum: Number(node.getAttribute('aria-valuemax')),
    value: Number(node.getAttribute('aria-valuenow')),
  }));
  if (resizerSemantics.role !== 'separator' || resizerSemantics.orientation !== 'vertical' || resizerSemantics.controls !== 'reader-sidebar' || !(resizerSemantics.minimum < resizerSemantics.value && resizerSemantics.value < resizerSemantics.maximum)) throw new Error(`Assistant resize handle did not expose usable separator semantics (${JSON.stringify(resizerSemantics)})`);
  const readAssistantGeometry = () => page.evaluate(() => {
    const sidebar = document.querySelector('#reader-sidebar').getBoundingClientRect();
    const frame = document.querySelector('.reader-frame-wrap').getBoundingClientRect();
    const heading = document.querySelector('.reader-heading').getBoundingClientRect();
    return {
      sidebar: { left: sidebar.left, right: sidebar.right, width: sidebar.width },
      frame: { left: frame.left, right: frame.right, width: frame.width },
      heading: { left: heading.left, right: heading.right, width: heading.width },
    };
  });
  const assistantGeometryBefore = await readAssistantGeometry();
  const resizerBox = await assistantResizer.boundingBox();
  if (!resizerBox) throw new Error('Assistant resize handle could not be measured');
  await page.mouse.move(resizerBox.x + resizerBox.width / 2, resizerBox.y + Math.min(180, resizerBox.height / 2));
  await page.mouse.down();
  await page.mouse.move(resizerBox.x + resizerBox.width / 2 - 88, resizerBox.y + Math.min(180, resizerBox.height / 2), { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction((before) => document.querySelector('#reader-sidebar')?.getBoundingClientRect().width > before + 55, assistantGeometryBefore.sidebar.width);
  await page.waitForTimeout(240);
  const assistantGeometryAfter = await readAssistantGeometry();
  const persistedAssistantWidth = await page.evaluate(() => Number(localStorage.getItem('my-scholar-assistant-width-v1')));
  const resizedAriaValue = Number(await assistantResizer.getAttribute('aria-valuenow'));
  const sidebarDelta = assistantGeometryAfter.sidebar.width - assistantGeometryBefore.sidebar.width;
  const frameDelta = assistantGeometryBefore.frame.width - assistantGeometryAfter.frame.width;
  if (sidebarDelta < 55 || Math.abs(sidebarDelta - frameDelta) > 3) throw new Error(`Assistant drag did not resize the sidebar and reading surface together (${JSON.stringify({ before: assistantGeometryBefore, after: assistantGeometryAfter })})`);
  if (Math.abs(assistantGeometryAfter.sidebar.left - assistantGeometryAfter.heading.left) > 2 || Math.abs(assistantGeometryAfter.sidebar.width - assistantGeometryAfter.heading.width) > 2) throw new Error(`Reader heading did not follow the resized assistant boundary (${JSON.stringify(assistantGeometryAfter)})`);
  if (Math.abs(persistedAssistantWidth - assistantGeometryAfter.sidebar.width) > 2 || Math.abs(resizedAriaValue - persistedAssistantWidth) > 1) throw new Error(`Assistant width was not persisted with its accessible value (${JSON.stringify({ persistedAssistantWidth, resizedAriaValue, geometry: assistantGeometryAfter })})`);

  await page.reload({ waitUntil: 'networkidle' });
  if (!(await page.locator('#reader-view.active-view').count())) {
    await page.locator(`.library-card[data-job-id="${jobId}"]`).first().dblclick();
  }
  await page.locator('#reader-view.active-view').waitFor();
  await page.locator('#reader-sidebar.is-open').waitFor();
  await page.waitForTimeout(240);
  const assistantGeometryReloaded = await readAssistantGeometry();
  if (Math.abs(assistantGeometryReloaded.sidebar.width - persistedAssistantWidth) > 2 || Math.abs(assistantGeometryReloaded.sidebar.left - assistantGeometryReloaded.heading.left) > 2) throw new Error(`Assistant width did not survive reload (${JSON.stringify({ persistedAssistantWidth, reloaded: assistantGeometryReloaded })})`);

  await page.setViewportSize({ width: 760, height: 980 });
  await page.locator('#reader-sidebar:not(.is-open)').waitFor();
  const narrowAssistantState = await assistantToggle.evaluate((toggle) => {
    const label = toggle.querySelector('.assistant-toggle-label');
    const icon = toggle.querySelector('svg');
    const iconRect = icon?.getBoundingClientRect();
    return {
      ariaLabel: toggle.getAttribute('aria-label'),
      labelDisplay: label ? getComputedStyle(label).display : null,
      iconVisible: Boolean(iconRect && iconRect.width > 0 && iconRect.height > 0),
    };
  });
  if (narrowAssistantState.labelDisplay !== 'none' || !narrowAssistantState.iconVisible || !/打开|展开/u.test(narrowAssistantState.ariaLabel || '')) throw new Error(`Narrow assistant control lost its accessible icon-only state (${JSON.stringify(narrowAssistantState)})`);
  if (await assistantResizer.isVisible()) throw new Error('Assistant resize handle remained visible in the narrow overlay layout');
  await assistantToggle.click();
  await page.locator('#reader-sidebar.is-open').waitFor();
  if (!/关闭|折叠/u.test((await assistantToggle.getAttribute('aria-label')) || '')) throw new Error('Opening the narrow assistant did not update its aria-label');
  await page.keyboard.press('Escape');
  await page.locator('#reader-sidebar:not(.is-open)').waitFor();
  const chapterRailToggle = page.locator('#reader-chapter-rail-toggle');
  await chapterRailToggle.waitFor({ state: 'visible' });
  await page.locator('#reader-chapter-list').waitFor({ state: 'hidden' });
  await chapterRailToggle.hover();
  const narrowRailHoverState = await page.locator('#reader-chapter-list').evaluate((node) => ({ visibility: getComputedStyle(node).visibility, railClass: node.closest('#reader-chapter-rail')?.className, expanded: document.querySelector('#reader-chapter-rail-toggle')?.getAttribute('aria-expanded') }));
  if (narrowRailHoverState.visibility !== 'hidden' || /(?:^|\s)is-open(?:\s|$)/u.test(narrowRailHoverState.railClass || '') || narrowRailHoverState.expanded !== 'false') throw new Error(`Narrow chapter rail expanded from hover instead of its explicit control (${JSON.stringify(narrowRailHoverState)})`);
  await chapterRailToggle.click();
  await page.locator('#reader-chapter-rail.is-open').waitFor();
  await page.locator('#reader-chapter-list').waitFor({ state: 'visible' });
  await page.waitForTimeout(220);
  const narrowRailGeometry = await page.locator('#reader-chapter-list').evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const itemHeight = node.querySelector('.reader-chapter-item')?.getBoundingClientRect().height || 0;
    const titleDisplay = getComputedStyle(node.querySelector('.reader-chapter-title')).display;
    const tooltip = document.querySelector('#reader-chapter-tooltip');
    return { width: rect.width, right: rect.right, viewport: innerWidth, visibility: getComputedStyle(node).visibility, itemHeight, titleDisplay, tooltipDisplay: getComputedStyle(tooltip).display, railClass: node.closest('#reader-chapter-rail')?.className, expanded: document.querySelector('#reader-chapter-rail-toggle')?.getAttribute('aria-expanded') };
  });
  if (narrowRailGeometry.visibility !== 'visible' || narrowRailGeometry.width > 260.5 || narrowRailGeometry.right > narrowRailGeometry.viewport + 1 || narrowRailGeometry.itemHeight < 43 || narrowRailGeometry.titleDisplay === 'none' || narrowRailGeometry.tooltipDisplay !== 'none') throw new Error(`Narrow chapter rail escaped its explicit touch overlay boundary (${JSON.stringify(narrowRailGeometry)})`);
  await page.keyboard.press('Escape');
  await page.locator('#reader-chapter-rail:not(.is-open)').waitFor();
  if (await chapterRailToggle.getAttribute('aria-expanded') !== 'false') throw new Error('Escape did not collapse the narrow chapter rail');
  await page.setViewportSize({ width: 1500, height: 980 });
  await page.locator('#reader-sidebar.is-open').waitFor();
  await assistantResizer.waitFor({ state: 'visible' });
  await page.waitForFunction((expected) => Math.abs((document.querySelector('#reader-sidebar')?.getBoundingClientRect().width || 0) - expected) <= 2, persistedAssistantWidth);
  const restoredDesktopWidth = await page.locator('#reader-sidebar').evaluate((node) => node.getBoundingClientRect().width);
  if (Math.abs(restoredDesktopWidth - persistedAssistantWidth) > 2) throw new Error(`Desktop assistant width changed after visiting the narrow layout (${persistedAssistantWidth} -> ${restoredDesktopWidth})`);
  for (const removedId of ['figures-panel', 'reader-markdown', 'reader-open-new', 'table-review-button', 'table-review-details', 'translation-panel', 'translation-panel-start', 'translation-summary', 'selection-translate', 'selection-preview']) {
    if (await page.locator(`#${removedId}`).count()) throw new Error(`Removed reader control still exists: ${removedId}`);
  }
  const frame = page.frameLocator('#html-preview');
  await frame.locator('.pdf-page').first().waitFor();
  const sectionNavigation = await page.evaluate(() => ({
    outline: document.querySelectorAll('#outline-list [data-reader-section-index]').length,
    rail: document.querySelectorAll('#reader-chapter-list [data-reader-section-index]').length,
    progressRole: document.querySelector('#reader-progress-track')?.getAttribute('role'),
  }));
  if (!sectionNavigation.outline || sectionNavigation.outline !== sectionNavigation.rail || sectionNavigation.progressRole !== 'progressbar') throw new Error(`Outline and chapter rail did not share one section model (${JSON.stringify(sectionNavigation)})`);
  const railMarkerStyles = await page.locator('#reader-chapter-list [data-reader-section-index]').evaluateAll((items) => items.map((item) => {
    const marker = item.querySelector('.reader-chapter-dot');
    const markerStyle = getComputedStyle(marker);
    const markerRect = marker.getBoundingClientRect();
    return {
      indent: parseFloat(getComputedStyle(item).getPropertyValue('--reader-section-rail-indent')) || 0,
      left: markerRect.left,
      width: markerRect.width,
      height: markerRect.height,
      color: markerStyle.backgroundColor,
      opacity: Number(markerStyle.opacity),
      active: item.matches('.active,[aria-current="location"]'),
    };
  }));
  if (railMarkerStyles.some((marker) => marker.height > 3 || marker.width < 6 || marker.width <= marker.height * 2)) throw new Error(`Chapter rail still rendered dot-shaped markers (${JSON.stringify(railMarkerStyles)})`);
  const railMarkerLefts = [...new Set(railMarkerStyles.map((marker) => Math.round(marker.left * 100) / 100))];
  if (railMarkerLefts.length > 1) throw new Error(`Chapter rail markers are not left-aligned (${JSON.stringify(railMarkerStyles)})`);
  const railMarkerByIndent = [...new Map(railMarkerStyles.map((marker) => [marker.indent, marker.width])).entries()].sort((left, right) => left[0] - right[0]);
  if (railMarkerByIndent.length > 1 && railMarkerByIndent.some((entry, index) => index > 0 && entry[1] >= railMarkerByIndent[index - 1][1])) throw new Error(`Chapter rail hierarchy did not shorten deeper markers (${JSON.stringify(railMarkerByIndent)})`);
  const activeRailMarker = railMarkerStyles.find((marker) => marker.active);
  const inactiveRailMarker = railMarkerStyles.find((marker) => !marker.active);
  if (!activeRailMarker || activeRailMarker.opacity < 0.99 || (inactiveRailMarker && activeRailMarker.color === inactiveRailMarker.color)) throw new Error(`Chapter rail active marker lost its accent (${JSON.stringify(railMarkerStyles)})`);
  const railItems = page.locator('#reader-chapter-list [data-reader-section-index]');
  const desktopRailDensity = await page.locator('#reader-chapter-list').evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const items = [...node.querySelectorAll('.reader-chapter-item')];
    const heights = items.map((item) => item.getBoundingClientRect().height);
    const centers = items.map((item) => {
      const itemRect = item.getBoundingClientRect();
      return itemRect.top + itemRect.height / 2;
    });
    const pitches = centers.slice(1).map((center, index) => center - centers[index]);
    return {
      width: rect.width,
      height: rect.height,
      clientHeight: node.clientHeight,
      scrollHeight: node.scrollHeight,
      count: items.length,
      minItemHeight: Math.min(...heights),
      maxItemHeight: Math.max(...heights),
      minPitch: Math.min(...pitches),
      maxPitch: Math.max(...pitches),
      visibleTitles: items.filter((item) => getComputedStyle(item.querySelector('.reader-chapter-title')).display !== 'none').length,
    };
  });
  if (desktopRailDensity.count < 6 || desktopRailDensity.width > 35 || desktopRailDensity.minItemHeight < 7.5 || desktopRailDensity.maxItemHeight > 8.5 || desktopRailDensity.minPitch < 7.5 || desktopRailDensity.maxPitch > 8.5 || desktopRailDensity.scrollHeight > desktopRailDensity.clientHeight + 1 || desktopRailDensity.visibleTitles) throw new Error(`Desktop chapter rail did not keep an 8px Codex-style rhythm (${JSON.stringify(desktopRailDensity)})`);
  const longRailReachability = await page.locator('#reader-chapter-list').evaluate((node) => {
    const originals = [...node.children];
    const fixtures = [];
    while (node.children.length < 120) {
      const clone = originals[fixtures.length % originals.length].cloneNode(true);
      clone.dataset.longRailFixture = 'true';
      fixtures.push(clone);
      node.append(clone);
    }
    node.scrollTop = 0;
    const listRect = node.getBoundingClientRect();
    const firstRect = node.firstElementChild.getBoundingClientRect();
    const firstReachable = firstRect.top >= listRect.top - 1;
    const last = node.lastElementChild;
    last.scrollIntoView({ block: 'end' });
    const lastRect = last.getBoundingClientRect();
    const result = {
      clientHeight: node.clientHeight,
      scrollHeight: node.scrollHeight,
      scrollTop: node.scrollTop,
      firstReachable,
      lastReachable: lastRect.bottom <= listRect.bottom + 1 && lastRect.top >= listRect.top - 1,
    };
    fixtures.forEach((fixture) => fixture.remove());
    node.scrollTop = 0;
    return result;
  });
  if (longRailReachability.scrollHeight <= longRailReachability.clientHeight || !longRailReachability.firstReachable || !longRailReachability.lastReachable || longRailReachability.scrollTop <= 0) throw new Error(`Long chapter rail could not reach both ends (${JSON.stringify(longRailReachability)})`);
  const frameWidthBeforeRail = await page.locator('.reader-frame-wrap').evaluate((node) => node.getBoundingClientRect().width);
  const tooltipIndex = Math.max(2, Math.min(4, sectionNavigation.rail - 3));
  const tooltipItem = railItems.nth(tooltipIndex);
  const tooltipTitle = await tooltipItem.getAttribute('data-reader-section-title');
  const markerGeometryBeforeHover = await railItems.evaluateAll((items) => items.map((item) => {
    const rect = item.querySelector('.reader-chapter-dot').getBoundingClientRect();
    return { left: rect.left, width: rect.width };
  }));
  await tooltipItem.hover();
  await page.locator('#reader-chapter-tooltip').waitFor({ state: 'visible' });
  await page.waitForTimeout(180);
  const hoverCurve = await railItems.evaluateAll((items, { baseline, center }) => items.map((item, index) => {
    const rect = item.querySelector('.reader-chapter-dot').getBoundingClientRect();
    return { distance: Math.abs(index - center), shift: rect.left - baseline[index].left, widthRatio: rect.width / baseline[index].width };
  }), { baseline: markerGeometryBeforeHover, center: tooltipIndex });
  const hoverCenter = hoverCurve.find((item) => item.distance === 0);
  const hoverNear = hoverCurve.filter((item) => item.distance === 1);
  const hoverOuter = hoverCurve.filter((item) => item.distance === 2);
  const hoverFar = hoverCurve.filter((item) => item.distance >= 3);
  if (!hoverCenter || hoverCenter.shift < 5.5 || hoverCenter.widthRatio < 1.24 || hoverNear.some((item) => item.shift < 3.5 || item.shift > 4.5 || item.widthRatio < 1.12) || hoverOuter.some((item) => item.shift < 1.5 || item.shift > 2.5 || item.widthRatio < 1.03) || hoverFar.some((item) => Math.abs(item.shift) > .6)) throw new Error(`Desktop chapter rail did not form a three-level hover curve (${JSON.stringify(hoverCurve)})`);
  const tooltipState = await page.locator('#reader-chapter-tooltip').evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return { text: node.textContent, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight, count: document.querySelectorAll('.reader-chapter-tooltip').length, fontSize: parseFloat(style.fontSize), fontWeight: Number(style.fontWeight), color: style.color, ink: getComputedStyle(document.body).color };
  });
  const collapsedRailWidth = await page.locator('#reader-chapter-list').evaluate((node) => node.getBoundingClientRect().width);
  const frameWidthWithRail = await page.locator('.reader-frame-wrap').evaluate((node) => node.getBoundingClientRect().width);
  if (tooltipState.text !== tooltipTitle || tooltipState.count !== 1 || tooltipState.fontSize < 12.9 || tooltipState.fontWeight < 550 || tooltipState.color !== tooltipState.ink || tooltipState.left < 0 || tooltipState.right > tooltipState.viewportWidth + 1 || tooltipState.top < 0 || tooltipState.bottom > tooltipState.viewportHeight + 1 || collapsedRailWidth > 35 || Math.abs(frameWidthWithRail - frameWidthBeforeRail) > 1) throw new Error(`Desktop chapter tooltip escaped its readable single-item overlay boundary (${JSON.stringify({ tooltipState, tooltipTitle, collapsedRailWidth, frameWidthBeforeRail, frameWidthWithRail })})`);
  await page.locator('.reader-action-bar').hover();
  await page.locator('#reader-chapter-tooltip').waitFor({ state: 'hidden' });
  await tooltipItem.focus();
  await page.locator('#reader-chapter-tooltip').waitFor({ state: 'visible' });
  await page.waitForTimeout(180);
  const focusCurve = await railItems.evaluateAll((items, { baseline, center }) => items.map((item, index) => {
    const rect = item.querySelector('.reader-chapter-dot').getBoundingClientRect();
    return { distance: Math.abs(index - center), shift: rect.left - baseline[index].left };
  }), { baseline: markerGeometryBeforeHover, center: tooltipIndex });
  if (focusCurve.find((item) => item.distance === 0)?.shift < 5.5 || focusCurve.filter((item) => item.distance === 1).some((item) => item.shift < 3.5) || focusCurve.filter((item) => item.distance === 2).some((item) => item.shift < 1.5)) throw new Error(`Chapter rail focus did not reproduce the hover curve (${JSON.stringify(focusCurve)})`);
  await page.keyboard.press('ArrowDown');
  const nextTooltipIndex = (tooltipIndex + 1) % sectionNavigation.rail;
  if (await page.evaluate(() => Number(document.activeElement?.dataset?.readerSectionIndex)) !== nextTooltipIndex) throw new Error('Chapter rail ArrowDown did not move its roving focus');
  if (await page.locator('#reader-chapter-tooltip').textContent() !== await railItems.nth(nextTooltipIndex).getAttribute('data-reader-section-title')) throw new Error('Chapter rail roving focus did not update its single-item tooltip');
  await page.keyboard.press('Escape');
  await page.locator('#reader-chapter-tooltip').waitFor({ state: 'hidden' });
  if (await chapterRailToggle.getAttribute('aria-expanded') !== 'false') throw new Error('Chapter rail keyboard Escape changed the desktop rail expansion state');
  await page.evaluate(() => document.activeElement?.blur());
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await railItems.first().hover();
  await page.locator('#reader-chapter-tooltip').waitFor({ state: 'visible' });
  const reducedRailMotion = await page.evaluate(() => {
    const tooltip = getComputedStyle(document.querySelector('#reader-chapter-tooltip'));
    const item = getComputedStyle(document.querySelector('#reader-chapter-list .reader-chapter-item'));
    const marker = getComputedStyle(document.querySelector('#reader-chapter-list .reader-chapter-dot'));
    return { tooltipAnimation: tooltip.animationName, tooltipTransition: tooltip.transitionDuration, itemTransition: item.transitionDuration, markerTransition: marker.transitionDuration };
  });
  if (reducedRailMotion.tooltipAnimation !== 'none' || reducedRailMotion.tooltipTransition !== '0s' || reducedRailMotion.itemTransition !== '0s' || reducedRailMotion.markerTransition !== '0s') throw new Error(`Chapter rail ignored reduced motion (${JSON.stringify(reducedRailMotion)})`);
  if (sectionNavigation.rail > 1) {
    await railItems.nth(1).click();
    await page.waitForFunction(() => document.querySelector('#reader-chapter-list [data-reader-section-index="1"]')?.matches('.active,[aria-current="location"]'));
  }
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  const iframeBox = await page.locator('#html-preview').boundingBox();
  if (!iframeBox) throw new Error('Reader iframe was not visible for a user scroll');
  await frame.locator('body').evaluate((node) => node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true, pointerType: 'mouse' })));
  await page.mouse.click(iframeBox.x + iframeBox.width / 2, iframeBox.y + Math.min(120, iframeBox.height / 2));
  await page.mouse.move(iframeBox.x + iframeBox.width / 2, iframeBox.y + iframeBox.height / 2);
  await page.mouse.wheel(0, 120);
  await frame.locator('html').evaluate(() => {
    const scroller = document.scrollingElement || document.documentElement;
    const maximum = Math.max(0, scroller.scrollHeight - window.innerHeight);
    window.scrollTo({ top: maximum * 0.42, behavior: 'auto' });
  });
  await page.waitForFunction(() => Number(document.querySelector('#reader-progress-track')?.getAttribute('aria-valuenow') || 0) > 0);
  await page.waitForTimeout(1100);
  const savedReadingLocation = await page.evaluate(({ id, key }) => {
    const payload = JSON.parse(localStorage.getItem(key) || 'null');
    const doc = document.querySelector('#html-preview')?.contentDocument;
    const scroller = doc?.scrollingElement || doc?.documentElement;
    return { payload, location: payload?.locations?.[id] || null, bytes: new TextEncoder().encode(JSON.stringify(payload || {})).byteLength, scroll: { y: doc?.defaultView?.scrollY, height: scroller?.scrollHeight, viewport: doc?.defaultView?.innerHeight } };
  }, { id: jobId, key: 'my-scholar-reading-locations-v1' });
  if (savedReadingLocation.payload?.version !== 1 || savedReadingLocation.payload?.lru?.length > 256 || savedReadingLocation.bytes > 128 * 1024 || !savedReadingLocation.location?.blockId || !(savedReadingLocation.location.progress > 0)) throw new Error(`Reading location was not normalized and persisted (${JSON.stringify(savedReadingLocation)})`);
  await page.locator('[data-view="library-view"]').click();
  await page.locator('#library-view.active-view').waitFor();
  const locationToRestore = await page.evaluate(({ id, key }) => JSON.parse(localStorage.getItem(key) || 'null')?.locations?.[id] || null, { id: jobId, key: 'my-scholar-reading-locations-v1' });
  if (!locationToRestore?.blockId) throw new Error('Leaving the reader did not synchronously capture its final location');
  await page.locator(`#document-tabs .document-tab[data-job-id="${jobId}"]`).click();
  await page.locator('#reader-view.active-view').waitFor();
  await frame.locator(`[data-block-id="${locationToRestore.blockId}"]`).waitFor();
  await page.waitForTimeout(1500);
  const restoredAnchor = await frame.locator(`[data-block-id="${locationToRestore.blockId}"]`).evaluate((node) => ({ top: node.getBoundingClientRect().top, height: node.getBoundingClientRect().height }));
  const expectedOffset = Math.min(restoredAnchor.height, locationToRestore.offsetPx);
  if (Math.abs(restoredAnchor.top + expectedOffset) > 28) {
    const restoreDiagnostics = await page.evaluate(({ id, key }) => {
      const frame = document.querySelector('#html-preview');
      const doc = frame?.contentDocument;
      const scroller = doc?.scrollingElement || doc?.documentElement;
      return { loading: document.querySelector('#reader-view')?.classList.contains('is-document-loading'), src: frame?.src, url: doc?.URL, scrollY: doc?.defaultView?.scrollY, scrollHeight: scroller?.scrollHeight, stored: JSON.parse(localStorage.getItem(key) || 'null')?.locations?.[id] || null };
    }, { id: jobId, key: 'my-scholar-reading-locations-v1' });
    throw new Error(`Reader did not restore the saved block-relative position (${JSON.stringify({ saved: locationToRestore, restoredAnchor, restoreDiagnostics })})`);
  }
  const frameAppearance = await frame.locator('html').evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      accent: style.getPropertyValue('--accent').trim(),
      appFont: style.getPropertyValue('--ui-font').trim(),
      readerFont: style.getPropertyValue('--paper-font').trim(),
      accentPriority: node.style.getPropertyPriority('--accent'),
      readerPriority: node.style.getPropertyPriority('--paper-font'),
    };
  });
  if (frameAppearance.accent !== '#2563eb' || !/songti/iu.test(frameAppearance.appFont) || !/georgia/iu.test(frameAppearance.readerFont) || frameAppearance.accentPriority !== 'important' || frameAppearance.readerPriority !== 'important') throw new Error(`Saved appearance did not override the legacy reader theme (${JSON.stringify(frameAppearance)})`);
  const selectionPolicy = await page.evaluate(() => {
    const copyEvent = new Event('copy', { bubbles: true, cancelable: true });
    document.querySelector('.brand-mark').dispatchEvent(copyEvent);
    return {
      body: getComputedStyle(document.body).userSelect,
      brand: getComputedStyle(document.querySelector('.brand-mark')).userSelect,
      notesEditor: getComputedStyle(document.querySelector('#notes-editor')).userSelect,
      notesContentEditable: document.querySelector('#notes-editor').getAttribute('contenteditable'),
      notesPreviewCount: document.querySelectorAll('#notes-preview, .notes-preview-label').length,
      chromeCopyPrevented: copyEvent.defaultPrevented,
    };
  });
  const frameSelectionPolicy = await frame.locator('.reader-content').evaluate((content) => {
    const paperCopy = new Event('copy', { bubbles: true, cancelable: true });
    content.dispatchEvent(paperCopy);
    const button = content.querySelector('button, .paragraph-translate-trigger, .annotation-note-trigger');
    let chromeCopyPrevented = false;
    if (button) {
      const chromeCopy = new Event('copy', { bubbles: true, cancelable: true });
      button.dispatchEvent(chromeCopy);
      chromeCopyPrevented = chromeCopy.defaultPrevented;
    }
    return {
      paper: getComputedStyle(content).userSelect,
      paperCopyAllowed: !paperCopy.defaultPrevented,
      chromeCopyPrevented,
    };
  });
  if (selectionPolicy.body !== 'none' || selectionPolicy.brand !== 'none' || selectionPolicy.notesEditor !== 'text' || selectionPolicy.notesContentEditable !== 'true' || selectionPolicy.notesPreviewCount !== 0 || !selectionPolicy.chromeCopyPrevented) throw new Error(`Application selection policy is incorrect: ${JSON.stringify(selectionPolicy)}`);
  if (frameSelectionPolicy.paper !== 'text' || !frameSelectionPolicy.paperCopyAllowed || !frameSelectionPolicy.chromeCopyPrevented) throw new Error(`Paper selection policy is incorrect: ${JSON.stringify(frameSelectionPolicy)}`);
  const metrics = {
    desktopAssistantDocked: true,
    assistantPanels: sidebarPanels.length,
    cardBoundaryRemoved: true,
    pages: await frame.locator('.pdf-page').count(),
    figures: await frame.locator('figure.pdf-figure').count(),
    tables: await frame.locator('figure.pdf-table').count(),
    equations: await frame.locator('.equation-entry').count(),
    references: await frame.locator('[id^="ref-"]').count(),
    blocks: await frame.locator('[data-block-id]').count(),
    semanticTables: await frame.locator('figure.pdf-table table').count(),
    tableImages: await frame.locator('figure.pdf-table .table-source-primary img').count(),
    tableRefs: await frame.locator('a.cross-reference[href^="#table-"]').count(),
    paragraphTranslationControls: await frame.locator('p[data-block-id] .paragraph-translate-trigger').count(),
    captionTranslationControls: await frame.locator('figcaption[data-translate-block-id] .paragraph-translate-trigger').count(),
    translationProgressBar: await page.locator('.translation-progress-track[role="progressbar"] #translation-progress-bar').count(),
    appSelectionPolicy: selectionPolicy,
    frameSelectionPolicy,
    assistantResize: { before: assistantGeometryBefore, after: assistantGeometryAfter, reloaded: assistantGeometryReloaded, persistedWidth: persistedAssistantWidth },
  };
  metrics.referenceListStyle = await frame.locator('.references').first().evaluate((node) => getComputedStyle(node).listStyleType);
  metrics.paperSectionStyles = await frame.locator('.reader-content').evaluate((root) => {
    const headings = [...root.querySelectorAll('h1, h2, h3, h4, h5, h6')];
    const abstractHeading = headings.find((heading) => /^(?:abstract|摘\s*要)\s*(?:[:：.—-])?$/iu.test(heading.textContent.trim()));
    const introductionHeading = headings.find((heading) => /introduction/iu.test(heading.textContent));
    const abstractBody = root.querySelector('.paper-abstract-body');
    const introductionBody = introductionHeading?.nextElementSibling?.matches('p') ? introductionHeading.nextElementSibling : null;
    const visualStyle = (selector) => {
      const node = root.querySelector(selector);
      return node ? { backgroundColor: getComputedStyle(node).backgroundColor } : null;
    };
    return {
      abstractHeading: abstractHeading ? getComputedStyle(abstractHeading).fontStyle : null,
      abstractBody: abstractBody ? getComputedStyle(abstractBody).fontStyle : null,
      introductionBody: introductionBody ? getComputedStyle(introductionBody).fontStyle : null,
      abstractTranslation: root.querySelector('.paper-abstract-translation') ? getComputedStyle(root.querySelector('.paper-abstract-translation')).fontStyle : null,
      figure: visualStyle('.pdf-figure'),
      table: visualStyle('.pdf-table'),
    };
  });
  const transparent = (value) => value === 'transparent' || /^rgba\(0,\s*0,\s*0,\s*0\)$/u.test(value || '');
  if (metrics.paperSectionStyles.abstractHeading !== 'normal' || metrics.paperSectionStyles.abstractBody !== 'italic' || metrics.paperSectionStyles.introductionBody !== 'normal') throw new Error(`Abstract typography was not isolated from the main body (${JSON.stringify(metrics.paperSectionStyles)})`);
  if (metrics.paperSectionStyles.abstractTranslation && metrics.paperSectionStyles.abstractTranslation !== 'italic') throw new Error(`Abstract translation was not italic (${JSON.stringify(metrics.paperSectionStyles)})`);
  if (!metrics.paperSectionStyles.figure || !metrics.paperSectionStyles.table || !transparent(metrics.paperSectionStyles.figure.backgroundColor) || !transparent(metrics.paperSectionStyles.table.backgroundColor)) throw new Error(`Figure/table modules still have a background (${JSON.stringify(metrics.paperSectionStyles)})`);
  await page.locator('#typography-button').click();
  await page.locator('#typography-popover:not([hidden])').waitFor();
  if (await page.locator('#typography-popover').evaluate((node) => node.parentElement?.id) !== 'reader-overlay-layer') throw new Error('Typography popover was still nested inside the scrolling reader toolbar');
  const typographyPopover = await page.locator('#typography-popover').boundingBox();
  if (!typographyPopover || typographyPopover.x < 0 || typographyPopover.y < 0 || typographyPopover.x + typographyPopover.width > 1500 || typographyPopover.y + typographyPopover.height > 980) throw new Error('Typography popover was not visible inside the window');
  const popoverHitTarget = await page.evaluate(({ x, y, width, height }) => document.elementFromPoint(x + width / 2, y + Math.min(18, height / 2))?.closest('#typography-popover')?.id || '', typographyPopover);
  if (popoverHitTarget !== 'typography-popover') throw new Error('Typography popover was visible but not hit-testable');
  await page.locator('#typography-button').click();
  await page.locator('#typography-button').click();
  await page.locator('#typography-popover:not([hidden]):not(.is-closing)').waitFor();
  if (await page.locator('#typography-button').getAttribute('aria-expanded') !== 'true') throw new Error('Typography popover could not reopen during its close animation');
  const typographyReaderTarget = frame.locator('.reader-content p[data-block-id]').first();
  await typographyReaderTarget.scrollIntoViewIfNeeded();
  await typographyReaderTarget.click({ position: { x: 8, y: 8 } });
  await page.locator('#typography-popover').waitFor({ state: 'hidden' });
  if (await page.locator('#typography-button').getAttribute('aria-expanded') !== 'false') throw new Error('Clicking reader iframe text did not close the typography popover');
  await page.locator('#typography-button').click();
  await page.locator('#typography-popover:not([hidden]):not(.is-closing)').waitFor();
  const selectionActions = await page.locator('.selection-actions > button').allTextContents();
  const expectedSelectionActions = ['高亮', '高亮笔记', '划线', '划线随笔', '加入 Chat'];
  if (JSON.stringify(selectionActions) !== JSON.stringify(expectedSelectionActions)) throw new Error(`Selection menu actions or order were incorrect (${JSON.stringify(selectionActions)})`);
  const readerHeading = await page.locator('.reader-heading').innerText();
  if (/\.pdf\b/i.test(readerHeading)) throw new Error('Reader assistant header leaked the document filename');
  const initialPageMargin = await frame.locator('.pdf-page').first().evaluate((node) => parseFloat(getComputedStyle(node).paddingLeft));
  const typographyConstraints = await page.evaluate(() => ['font-size', 'line-height', 'page-margin'].map((name) => ({
    range: ['min', 'max', 'step'].map((attribute) => document.querySelector(`#${name}-range`)?.getAttribute(attribute)),
    number: ['min', 'max', 'step'].map((attribute) => document.querySelector(`#${name}-value`)?.getAttribute(attribute)),
  })));
  const expectedTypographyConstraints = [[['70', '200', '1'], ['70', '200', '1']], [['100', '300', '1'], ['100', '300', '1']], [['0', '250', '1'], ['0', '250', '1']]];
  if (JSON.stringify(typographyConstraints.map((entry) => [entry.range, entry.number])) !== JSON.stringify(expectedTypographyConstraints)) throw new Error(`Typography controls exposed inconsistent limits (${JSON.stringify(typographyConstraints)})`);
  await page.locator('#font-size-value').fill('173');
  if (await page.locator('#font-size-range').inputValue() !== '173') throw new Error('Font number input did not synchronize its range');
  await page.locator('#line-height-range').evaluate((node) => { node.value = '231'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  if (await page.locator('#line-height-value').inputValue() !== '231') throw new Error('Line-height range did not synchronize its number input');
  await page.locator('#page-margin-value').fill('0');
  if (await page.locator('#page-margin-range').inputValue() !== '0') throw new Error('Page-margin number input did not preserve the valid zero boundary');
  await page.locator('#font-size-value').fill('999');
  if (await page.locator('#font-size-value').inputValue() !== '200' || await page.locator('#font-size-range').inputValue() !== '200') throw new Error('Typography number input was not normalized to its upper bound');
  await page.locator('#typography-reset').click();
  const resetTypography = await page.evaluate(() => ({
    ranges: ['font-size-range', 'line-height-range', 'page-margin-range'].map((id) => document.getElementById(id)?.value),
    numbers: ['font-size-value', 'line-height-value', 'page-margin-value'].map((id) => document.getElementById(id)?.value),
    saved: JSON.parse(localStorage.getItem('my-scholar-typography') || '{}'),
  }));
  if (JSON.stringify(resetTypography.ranges) !== JSON.stringify(['100', '172', '100']) || JSON.stringify(resetTypography.numbers) !== JSON.stringify(['100', '172', '100']) || JSON.stringify(resetTypography.saved) !== JSON.stringify({ fontSize: 100, lineHeight: 172, pageMargin: 100 })) throw new Error(`Typography reset did not normalize every control (${JSON.stringify(resetTypography)})`);
  await page.locator('#font-size-range').evaluate((node) => { node.value = '115'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.locator('#line-height-range').evaluate((node) => { node.value = '190'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.locator('#page-margin-range').evaluate((node) => { node.value = '140'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  metrics.typography = await frame.locator('.reader-content').evaluate((node) => {
    const pageNode = node.querySelector('.pdf-page');
    const style = getComputedStyle(node);
    return { fontFamily: style.fontFamily, fontSize: style.fontSize, lineHeight: style.lineHeight, pageMargin: getComputedStyle(pageNode).paddingLeft };
  });
  metrics.assistantTypography = await page.locator('#notes-editor').evaluate((node) => {
    const style = getComputedStyle(node);
    const root = getComputedStyle(document.documentElement);
    const heading = getComputedStyle(document.querySelector('#notes-panel .panel-intro strong'));
    return {
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
      headingFontSize: heading.fontSize,
      fontScale: root.getPropertyValue('--reader-font-scale').trim(),
      contentFontSize: root.getPropertyValue('--reader-content-font-size').trim(),
      contentFontFamily: root.getPropertyValue('--reader-content-font-family').trim(),
      lineHeightToken: root.getPropertyValue('--reader-line-height').trim(),
    };
  });
  const frameTypographyTokens = await frame.locator('html').evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      fontScale: style.getPropertyValue('--reader-font-scale').trim(),
      contentFontSize: style.getPropertyValue('--reader-content-font-size').trim(),
      contentFontFamily: style.getPropertyValue('--reader-content-font-family').trim(),
      lineHeightToken: style.getPropertyValue('--reader-line-height').trim(),
    };
  });
  const persistedTypography = await page.evaluate(() => JSON.parse(localStorage.getItem('my-scholar-typography') || '{}'));
  if (parseFloat(metrics.typography.fontSize) < 19 || parseFloat(metrics.typography.lineHeight) < 35) throw new Error('Typography controls did not update the document font size and line spacing');
  if (parseFloat(metrics.assistantTypography.fontSize) < 13 || parseFloat(metrics.assistantTypography.lineHeight) < parseFloat(metrics.assistantTypography.fontSize) * 1.5) throw new Error(`Assistant typography lost its readable compact scale (${JSON.stringify({ document: metrics.typography, assistant: metrics.assistantTypography })})`);
  if (normalizeFontFamily(metrics.assistantTypography.fontFamily) !== normalizeFontFamily(metrics.typography.fontFamily)) throw new Error(`Assistant note font did not match the document (${JSON.stringify({ document: metrics.typography, assistant: metrics.assistantTypography })})`);
  if (metrics.assistantTypography.fontScale !== '1.15' || metrics.assistantTypography.lineHeightToken !== '1.9' || frameTypographyTokens.fontScale !== '1.15' || frameTypographyTokens.lineHeightToken !== '1.9' || metrics.assistantTypography.contentFontSize !== frameTypographyTokens.contentFontSize || normalizeFontFamily(metrics.assistantTypography.contentFontFamily) !== normalizeFontFamily(frameTypographyTokens.contentFontFamily)) throw new Error(`Typography tokens were not synchronized across documents (${JSON.stringify({ assistant: metrics.assistantTypography, frame: frameTypographyTokens })})`);
  if (parseFloat(metrics.typography.pageMargin) <= initialPageMargin || persistedTypography.pageMargin !== 140 || await page.locator('#page-margin-value').inputValue() !== '140') throw new Error(`Page margin control did not update and persist (${JSON.stringify({ initialPageMargin, typography: metrics.typography, persistedTypography })})`);
  await frame.locator('#fig-2').scrollIntoViewIfNeeded();
  await page.waitForTimeout(1200);
  await frame.locator('#fig-2 img').evaluate((img) => {
    if (!img.complete || img.naturalWidth < 1200 || !/@300\./u.test(img.currentSrc || img.src)) throw new Error(`Figure 2 did not load its high-resolution PDF crop (${img.naturalWidth}px)`);
  });
  await frame.locator('#table-1').scrollIntoViewIfNeeded();
  await page.waitForTimeout(1200);
  await frame.locator('#table-1 img').evaluate((img) => {
    if (!img.complete || img.naturalWidth < 1200 || !/@300\./u.test(img.currentSrc || img.src)) throw new Error(`Table 1 did not load its high-resolution PDF crop (${img.naturalWidth}px)`);
  });
  if (!metrics.tableRefs || !(await frame.locator('#table-1').count())) throw new Error('Table cross-reference anchor was not generated');
  await frame.locator('a.cross-reference[href="#table-1"]').first().click();
  const manualHighlightsBefore = await frame.locator('mark.my-scholar-highlight[data-user-color="true"]').count();
  const selectedBlockTranslationsBefore = await frame.locator('.my-scholar-translation[data-for="block-1-6-paragraph"]').count();
  await frame.locator('[data-block-id="block-1-6-paragraph"]').evaluate((block) => {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    const node = walker.nextNode();
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, Math.min(30, node.nodeValue.length));
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.locator('#selection-popover:not([hidden])').waitFor();
  const selectionTranslationResult = page.locator('#selection-translation-result');
  await selectionTranslationResult.locator('.selection-translation-loading').waitFor();
  await selectionTranslationResult.filter({ hasText: selectionTranslationText }).waitFor();
  const selectionTranslationState = await selectionTranslationResult.getAttribute('data-state');
  const selectedBlockTranslationsAfter = await frame.locator('.my-scholar-translation[data-for="block-1-6-paragraph"]').count();
  if (selectionTranslationState !== 'ready' || selectionTranslationRequests.length !== 1) throw new Error(`Selected text was not translated automatically exactly once (${JSON.stringify({ state: selectionTranslationState, requests: selectionTranslationRequests })})`);
  if (selectionTranslationRequests[0].block_id != null && selectionTranslationRequests[0].block_id !== '') throw new Error(`Selection translation reused a paragraph cache key (${JSON.stringify(selectionTranslationRequests[0])})`);
  if (selectedBlockTranslationsAfter !== selectedBlockTranslationsBefore) throw new Error(`Selection translation inserted or replaced a document translation (${selectedBlockTranslationsBefore} -> ${selectedBlockTranslationsAfter})`);
  const selectionStructure = await page.locator('#selection-popover').evaluate((node) => {
    const actions = node.querySelector('.selection-actions').getBoundingClientRect();
    const result = node.querySelector('#selection-translation-result').getBoundingClientRect();
    return { actionsBottom: actions.bottom, resultTop: result.top };
  });
  if (selectionStructure.actionsBottom > selectionStructure.resultTop + 1) throw new Error(`Selection translation was not placed below the action row (${JSON.stringify(selectionStructure)})`);
  const readSelectionTypography = () => page.locator('#selection-popover').evaluate((node) => {
    const style = getComputedStyle(node);
    const resultStyle = getComputedStyle(node.querySelector('#selection-translation-result'));
    const buttonStyle = getComputedStyle(node.querySelector('.selection-actions button'));
    const wrapRect = document.querySelector('.reader-frame-wrap').getBoundingClientRect();
    const rect = node.getBoundingClientRect();
    return {
      fontSize: parseFloat(style.fontSize),
      buttonFontSize: parseFloat(buttonStyle.fontSize),
      resultFontSize: parseFloat(resultStyle.fontSize),
      resultLineHeight: parseFloat(resultStyle.lineHeight),
      supportToken: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--reader-support-font-size')),
      contentToken: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--reader-content-font-size')),
      lineHeightToken: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--reader-line-height')),
      placement: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, wrapLeft: wrapRect.left, wrapRight: wrapRect.right, wrapTop: wrapRect.top, wrapBottom: wrapRect.bottom },
    };
  });
  metrics.selectionTypography = { at115: await readSelectionTypography() };
  await page.locator('#font-size-range').evaluate((node) => { node.value = '120'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  metrics.selectionTypography.at120 = await readSelectionTypography();
  await page.locator('#font-size-range').evaluate((node) => { node.value = '115'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  for (const measurement of Object.values(metrics.selectionTypography)) {
    const expectedToolbarSize = measurement.supportToken * .88;
    const expectedResultSize = measurement.contentToken * .82;
    if (measurement.fontSize < 11 || Math.abs(measurement.fontSize - expectedToolbarSize) > 0.2 || Math.abs(measurement.buttonFontSize - expectedToolbarSize) > 0.2 || Math.abs(measurement.resultFontSize - expectedResultSize) > 0.2 || Math.abs(measurement.resultLineHeight - expectedResultSize * 1.48) > 0.3) throw new Error(`Selection toolbar or translation did not keep its compact reader-relative typography (${JSON.stringify(metrics.selectionTypography)})`);
    const { placement } = measurement;
    if (placement.left < placement.wrapLeft - 1 || placement.right > placement.wrapRight + 1 || placement.top < placement.wrapTop - 1 || placement.bottom > placement.wrapBottom + 1) throw new Error(`Scaled selection toolbar escaped the reading area (${JSON.stringify(metrics.selectionTypography)})`);
  }
  if (metrics.selectionTypography.at120.fontSize <= metrics.selectionTypography.at115.fontSize) throw new Error(`Selection toolbar font did not scale with the reader setting (${JSON.stringify(metrics.selectionTypography)})`);
  if (metrics.selectionTypography.at120.resultFontSize <= metrics.selectionTypography.at115.resultFontSize || selectionTranslationRequests.length !== 1) throw new Error(`Selection translation typography or request deduplication failed (${JSON.stringify({ typography: metrics.selectionTypography, requests: selectionTranslationRequests })})`);
  await page.locator('#selection-highlight').click();
  const manualHighlight = frame.locator('mark.my-scholar-highlight[data-user-color="true"]').nth(manualHighlightsBefore);
  await manualHighlight.waitFor();
  const manualHighlightId = await manualHighlight.getAttribute('data-annotation-id');
  const sidebarAnnotationItem = page.locator(`#annotations-list .annotation-item[data-annotation-id="${manualHighlightId}"]`);
  if (await sidebarAnnotationItem.count()) throw new Error('A pure highlight leaked into the note-only sidebar');
  const noteTrigger = frame.locator(`.annotation-note-trigger[data-annotation-id="${manualHighlightId}"]`);
  await noteTrigger.click();
  const annotationPopover = frame.locator('.annotation-note-popover');
  await annotationPopover.waitFor();
  const annotationPopoverTypography = await annotationPopover.evaluate((node) => {
    const read = (selector) => {
      const style = getComputedStyle(node.querySelector(selector));
      return { fontFamily: style.fontFamily, fontSize: style.fontSize, lineHeight: style.lineHeight };
    };
    const rect = node.getBoundingClientRect();
    return {
      contentToken: parseFloat(getComputedStyle(node.ownerDocument.documentElement).getPropertyValue('--reader-content-font-size')),
      popover: { fontSize: getComputedStyle(node).fontSize, lineHeight: getComputedStyle(node).lineHeight },
      quote: read('.annotation-note-popover-quote'),
      body: read('.annotation-note-popover-body'),
      placement: { top: rect.top, bottom: rect.bottom, viewportHeight: innerHeight },
    };
  });
  await annotationPopover.locator('[data-action="edit"]').click();
  annotationPopoverTypography.editor = await annotationPopover.locator('.annotation-note-editor').evaluate((node) => {
    const style = getComputedStyle(node);
    return { fontFamily: style.fontFamily, fontSize: style.fontSize, lineHeight: style.lineHeight };
  });
  for (const [surface, typography] of Object.entries(annotationPopoverTypography)) {
    if (surface === 'placement' || surface === 'contentToken') continue;
    const ratio = surface === 'quote' ? .78 : .82;
    const expectedSize = annotationPopoverTypography.contentToken * ratio;
    if (Math.abs(parseFloat(typography.fontSize) - expectedSize) > 0.2 || Math.abs(parseFloat(typography.lineHeight) - expectedSize * 1.48) > 0.3) throw new Error(`Inline annotation ${surface} did not keep its compact reader-relative typography (${JSON.stringify({ reader: metrics.typography, annotationPopoverTypography })})`);
    if (surface !== 'popover' && normalizeFontFamily(typography.fontFamily) !== normalizeFontFamily(metrics.typography.fontFamily)) throw new Error(`Inline annotation ${surface} did not use the document font (${JSON.stringify({ reader: metrics.typography, annotationPopoverTypography })})`);
  }
  if (annotationPopoverTypography.placement.top < 0 || annotationPopoverTypography.placement.bottom > annotationPopoverTypography.placement.viewportHeight + 1) throw new Error(`Scaled annotation popover escaped the reader viewport (${JSON.stringify(annotationPopoverTypography.placement)})`);
  await annotationPopover.locator('.annotation-note-editor').fill('紧凑排版 smoke note');
  await annotationPopover.locator('[data-action="save-note"]').click();
  await annotationPopover.locator('.annotation-note-popover-body').getByText('紧凑排版 smoke note', { exact: false }).waitFor();
  await frame.locator('.annotation-note-popover [data-action="close"]').click();
  await page.locator('[data-panel="annotations-panel"]').click();
  const sidebarAnnotation = page.locator(`#annotations-list .annotation-item[data-annotation-id="${manualHighlightId}"] .annotation-quote`);
  await sidebarAnnotation.waitFor();
  metrics.annotationTypography = {
    popover: annotationPopoverTypography,
    sidebar: await sidebarAnnotation.evaluate((node) => {
      const style = getComputedStyle(node);
      return { fontFamily: style.fontFamily, fontSize: style.fontSize, lineHeight: style.lineHeight };
    }),
  };
  const expectedSidebarSize = annotationPopoverTypography.contentToken * .78;
  if (Math.abs(parseFloat(metrics.annotationTypography.sidebar.fontSize) - expectedSidebarSize) > 0.2 || Math.abs(parseFloat(metrics.annotationTypography.sidebar.lineHeight) - expectedSidebarSize * 1.48) > 0.3) throw new Error(`Sidebar annotation lost its compact scale (${JSON.stringify(metrics.annotationTypography)})`);
  if (normalizeFontFamily(metrics.annotationTypography.sidebar.fontFamily) !== normalizeFontFamily(metrics.typography.fontFamily)) throw new Error(`Sidebar annotation did not use the document font (${JSON.stringify(metrics.annotationTypography)})`);
  const highlightColor = await manualHighlight.evaluate((node) => {
    const style = getComputedStyle(node);
    return { background: style.backgroundColor, variable: style.getPropertyValue('--user-highlight').trim().toLowerCase() };
  });
  const systemAccentWhileHighlighted = await page.locator('html').evaluate((node) => getComputedStyle(node).getPropertyValue('--accent').trim());
  const amberComputed = /245|158|f59e0b|0\.960784|0\.619608/i.test(highlightColor.background);
  if (systemAccentWhileHighlighted !== '#2563eb' || highlightColor.variable !== '#f59e0b' || !amberComputed) throw new Error(`Manual highlight incorrectly followed the system accent (${JSON.stringify({ systemAccentWhileHighlighted, highlightColor })})`);
  await page.locator('[data-panel="notes-panel"]').click();
  const notesEditor = page.locator('#notes-editor[contenteditable="true"]');
  await notesEditor.evaluate((node) => node.replaceChildren());
  await notesEditor.fill('Smoke note\nReader interaction passed.');
  await notesEditor.press('Control+A');
  const selectedNoteText = await notesEditor.evaluate((node) => node.ownerDocument.getSelection()?.toString().replace(/\s+/gu, ' ').trim());
  if (selectedNoteText !== 'Smoke note Reader interaction passed.') throw new Error(`Select All did not stay inside the article-note editor (${selectedNoteText})`);
  await page.locator('#notes-panel [role="toolbar"] [data-format="bold"]').click();
  await notesEditor.locator('b, strong').filter({ hasText: 'Smoke note' }).waitFor();
  await page.locator('#save-notes-button').click();
  await page.locator('#notes-saved').filter({ hasText: '已保存' }).waitFor();
  const savedArticleNote = await page.evaluate(async (id) => (await (await fetch(`/api/jobs/${id}/notes`)).json()).markdown || '', jobId);
  if (!savedArticleNote.includes('**Smoke note**') || !savedArticleNote.includes('Reader interaction passed.')) throw new Error(`Article-note rich text was not persisted as Markdown (${savedArticleNote})`);
  const literalArticleNote = 'C:\\models\\draft\n# literal heading\n*literal stars*';
  await notesEditor.evaluate((node) => node.replaceChildren());
  await notesEditor.fill(literalArticleNote);
  await page.locator('#save-notes-button').click();
  await page.locator('#notes-saved').filter({ hasText: '已保存' }).waitFor();
  const escapedArticleNote = await page.evaluate(async (id) => (await (await fetch(`/api/jobs/${id}/notes`)).json()).markdown || '', jobId);
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator(`.library-card[data-job-id="${jobId}"]`).first().dblclick();
  await page.locator('#reader-view.active-view').waitFor();
  await frame.locator('.pdf-page').first().waitFor();
  const reloadedAppearance = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const frameRoot = document.querySelector('#html-preview')?.contentDocument?.documentElement;
    const frameStyle = frameRoot ? getComputedStyle(frameRoot) : null;
    return {
      hostAccent: root.getPropertyValue('--accent').trim(),
      hostAppFont: root.getPropertyValue('--app-font').trim(),
      hostReaderFont: root.getPropertyValue('--reader-content-font-family').trim(),
      frameAccent: frameStyle?.getPropertyValue('--accent').trim(),
      frameReaderFont: frameStyle?.getPropertyValue('--paper-font').trim(),
    };
  });
  if (reloadedAppearance.hostAccent !== '#2563eb' || reloadedAppearance.frameAccent !== '#2563eb' || !/songti/iu.test(reloadedAppearance.hostAppFont) || !/georgia/iu.test(reloadedAppearance.hostReaderFont) || !/georgia/iu.test(reloadedAppearance.frameReaderFont)) throw new Error(`Saved appearance did not survive reload (${JSON.stringify(reloadedAppearance)})`);
  await page.locator('[data-panel="notes-panel"]').click();
  await notesEditor.waitFor();
  metrics.typographyAfterReload = {
    reader: await frame.locator('.reader-content').evaluate((node) => { const style = getComputedStyle(node); return { fontFamily: style.fontFamily, fontSize: style.fontSize, lineHeight: style.lineHeight }; }),
    notes: await notesEditor.evaluate((node) => { const style = getComputedStyle(node); return { fontFamily: style.fontFamily, fontSize: style.fontSize, lineHeight: style.lineHeight }; }),
    assistant: await page.evaluate(() => {
      const measure = (node) => {
        const style = getComputedStyle(node);
        return { fontFamily: style.fontFamily, fontSize: style.fontSize, lineHeight: style.lineHeight };
      };
      const chatMessages = document.querySelector('#chat-messages');
      let chatEmpty = chatMessages.querySelector('.chat-empty');
      let temporaryEmpty = false;
      if (!chatEmpty) {
        chatEmpty = document.createElement('div');
        chatEmpty.className = 'chat-empty';
        chatEmpty.textContent = 'Typography reload prompt';
        chatMessages.append(chatEmpty);
        temporaryEmpty = true;
      }
      let chatBubble = chatMessages.querySelector('.chat-bubble.assistant');
      let temporaryBubble = false;
      if (!chatBubble) {
        chatBubble = document.createElement('div');
        chatBubble.className = 'chat-bubble assistant';
        chatBubble.textContent = 'Typography reload reply';
        chatMessages.append(chatBubble);
        temporaryBubble = true;
      }
      const root = getComputedStyle(document.documentElement);
      const result = {
        contentSize: root.getPropertyValue('--reader-content-font-size').trim(),
        supportSize: root.getPropertyValue('--reader-support-font-size').trim(),
        toolbarSize: getComputedStyle(document.querySelector('.action-button')).fontSize,
        appFont: getComputedStyle(document.body).fontFamily,
        chatBubble: measure(chatBubble),
        chatEmpty: measure(chatEmpty),
        chatInput: measure(document.querySelector('#chat-input')),
        sidebarTab: measure(document.querySelector('.sidebar-tab')),
        assistantToggle: measure(document.querySelector('#assistant-toggle')),
      };
      if (temporaryEmpty) chatEmpty.remove();
      if (temporaryBubble) chatBubble.remove();
      return result;
    }),
    controls: {
      fontSize: await page.locator('#font-size-range').inputValue(),
      lineHeight: await page.locator('#line-height-range').inputValue(),
      fontNumber: await page.locator('#font-size-value').inputValue(),
      lineNumber: await page.locator('#line-height-value').inputValue(),
    },
  };
  if (metrics.typographyAfterReload.controls.fontSize !== '115' || metrics.typographyAfterReload.controls.lineHeight !== '190' || metrics.typographyAfterReload.controls.fontNumber !== '115' || metrics.typographyAfterReload.controls.lineNumber !== '190' || parseFloat(metrics.typographyAfterReload.notes.fontSize) < 13 || parseFloat(metrics.typographyAfterReload.notes.lineHeight) < parseFloat(metrics.typographyAfterReload.notes.fontSize) * 1.5 || normalizeFontFamily(metrics.typographyAfterReload.reader.fontFamily) !== normalizeFontFamily(metrics.typographyAfterReload.notes.fontFamily)) throw new Error(`Typography synchronization did not survive reload (${JSON.stringify(metrics.typographyAfterReload)})`);
  const reloadedAssistant = metrics.typographyAfterReload.assistant;
  if (parseFloat(reloadedAssistant.chatBubble.fontSize) < 13 || parseFloat(reloadedAssistant.chatBubble.lineHeight) < parseFloat(reloadedAssistant.chatBubble.fontSize) * 1.5 || normalizeFontFamily(reloadedAssistant.chatBubble.fontFamily) !== normalizeFontFamily(metrics.typographyAfterReload.reader.fontFamily)) throw new Error(`Chat content typography did not survive reload (${JSON.stringify(metrics.typographyAfterReload)})`);
  for (const surface of ['chatEmpty', 'chatInput', 'sidebarTab']) {
    const style = reloadedAssistant[surface];
    if (Math.abs(parseFloat(style.fontSize) - parseFloat(reloadedAssistant.toolbarSize)) > 0.2 || normalizeFontFamily(style.fontFamily) !== normalizeFontFamily(reloadedAssistant.appFont)) throw new Error(`Assistant UI typography did not survive reload for ${surface} (${JSON.stringify(metrics.typographyAfterReload)})`);
  }
  if (Math.abs(parseFloat(reloadedAssistant.assistantToggle.fontSize) - parseFloat(reloadedAssistant.toolbarSize)) > 0.2 || normalizeFontFamily(reloadedAssistant.assistantToggle.fontFamily) !== normalizeFontFamily(reloadedAssistant.appFont)) throw new Error(`Assistant toggle typography did not survive reload (${JSON.stringify(metrics.typographyAfterReload)})`);
  for (const surface of ['chatEmpty', 'chatInput', 'sidebarTab']) {
    const style = reloadedAssistant[surface];
    if (Math.abs(parseFloat(style.lineHeight) - parseFloat(style.fontSize) * 1.45) > 0.3) throw new Error(`Assistant UI line height did not survive reload for ${surface} (${JSON.stringify(metrics.typographyAfterReload)})`);
  }
  const literalRoundTrip = await notesEditor.evaluate((node) => ({ text: node.textContent || '', html: node.innerHTML }));
  if (!literalRoundTrip.text.includes('C:\\models\\draft') || !literalRoundTrip.text.includes('# literal heading') || !literalRoundTrip.text.includes('*literal stars*') || /<(?:h[1-3]|em)>/iu.test(literalRoundTrip.html)) throw new Error(`Escaped literal Markdown was corrupted after reload (${JSON.stringify(literalRoundTrip)})`);
  await page.locator('#save-notes-button').click();
  await page.locator('#notes-saved').filter({ hasText: '已保存' }).waitFor();
  const escapedArticleNoteAgain = await page.evaluate(async (id) => (await (await fetch(`/api/jobs/${id}/notes`)).json()).markdown || '', jobId);
  if (escapedArticleNoteAgain !== escapedArticleNote) throw new Error(`Article-note Markdown was not stable across a save/reload/save cycle (${escapedArticleNote} -> ${escapedArticleNoteAgain})`);
  metrics.articleNoteMarkdownRoundTrip = true;
  await page.emulateMedia({ colorScheme: 'dark' });
  metrics.darkMode = await page.evaluate(() => ({ shell: getComputedStyle(document.body).backgroundColor, reader: getComputedStyle(document.querySelector('.reader-sidebar')).backgroundColor }));
  metrics.darkDocument = await frame.locator('body').evaluate((node) => getComputedStyle(node).backgroundColor);
  if (metrics.darkMode.shell === 'rgb(255, 255, 255)' || metrics.darkDocument === 'rgb(255, 255, 255)') throw new Error('System dark mode was not applied to both shell and document');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.screenshot({ path: screenshot, fullPage: true });
  const captureDir = path.dirname(screenshot);
  await frame.locator('#fig-3').scrollIntoViewIfNeeded();
  await page.waitForTimeout(1200);
  await frame.locator('#fig-3 img').evaluate((img) => {
    if (!img.complete || img.naturalHeight === 0) throw new Error('Figure 3 image did not load');
  });
  await frame.locator('#table-1').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await frame.locator('#fig-3').screenshot({ path: path.join(captureDir, 'my-scholar-figure3.png') });
  await frame.locator('#eq-1').screenshot({ path: path.join(captureDir, 'my-scholar-equation1.png') });
  await frame.locator('#table-1').screenshot({ path: path.join(captureDir, 'my-scholar-table1.png') });
  const cleanup = await page.evaluate(async (id) => (await fetch(`/api/jobs/${id}/annotations`)).json(), jobId);
  for (const annotation of cleanup.annotations || []) {
    if (annotation.block_id !== 'block-1-6-paragraph' || !String(annotation.quote || '').startsWith('Large Language Models (LLMs)')) continue;
    await page.evaluate(async ({ id, annotationId }) => fetch(`/api/jobs/${id}/annotations/${annotationId}`, { method: 'DELETE' }), { id: jobId, annotationId: annotation.id });
  }
  console.log(JSON.stringify({ metrics, desktopLayout, errors, screenshot }));
  if (errors.length || metrics.pages !== 12 || metrics.figures !== 3 || metrics.tables !== 7 || metrics.tableImages !== 7 || metrics.semanticTables !== 0 || metrics.equations !== 2 || metrics.references !== 100 || metrics.paragraphTranslationControls < 10 || metrics.captionTranslationControls !== 0 || metrics.translationProgressBar !== 1 || metrics.referenceListStyle !== 'none') {
    process.exitCode = 1;
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  try {
    await browserSession?.close();
  } catch (closeError) {
    console.error(`Failed to close browser: ${closeError.message}`);
    process.exitCode = 1;
  }
});
