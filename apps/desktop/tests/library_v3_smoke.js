const { launchManagedChromium } = require('./playwright.cjs');

const baseURL = process.argv[2] || 'http://127.0.0.1:8766';
let browser;
let browserSession;

(async () => {
  browserSession = await launchManagedChromium();
  browser = browserSession.browser;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  let expectingImportanceFailure = false;
  let expectingImportPollFailure = false;
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    const expectedImportanceError = expectingImportanceFailure && message.text().includes('500');
    const expectedImportPollError = expectingImportPollFailure && message.text().includes('503');
    if (message.type() === 'error' && !expectedImportanceError && !expectedImportPollError) errors.push(`console: ${message.text()}`);
  });
  // The metadata follow-up this suite exercises only runs when automatic
  // retrieval is on, and the CI fixture ships it off so a run never reaches
  // the network. Declare the precondition here; online lookup stays off.
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await page.request.get(route.request().url());
    const settings = await response.json();
    settings.metadata = { ...(settings.metadata || {}), auto_retrieve: true, online_lookup: false };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(settings) });
  });
  await page.goto(baseURL, { waitUntil: 'networkidle' });
  await page.locator('#recent-list .library-row').first().waitFor();
  if (await page.locator('.library-import').count()) throw new Error('The large import panel is still rendered');
  if (await page.locator('#file-input[multiple]').count() !== 1) throw new Error('The import input is not configured for multiple files');

  const systemIconCounts = await page.locator('#library-system-filters .system-filter').evaluateAll((buttons) => buttons.map((button) => button.querySelectorAll('svg.sidebar-item-icon[aria-hidden="true"]').length));
  if (systemIconCounts.length !== 3 || systemIconCounts.some((count) => count !== 1)) throw new Error(`System filters do not have one decorative icon each (${systemIconCounts.join(',')})`);
  const sidebarIconAlignment = await page.evaluate(() => {
    const headings = [...document.querySelectorAll('.library-sidebar-heading strong')].map((heading) => heading.getBoundingClientRect().left);
    const icon = document.querySelector('#library-system-filters .system-filter .sidebar-item-icon').getBoundingClientRect();
    const sidebar = document.querySelector('.library-sidebar').getBoundingClientRect();
    const divider = document.querySelector('.library-sidebar-divider').getBoundingClientRect();
    const emptyNode = document.querySelector('.folder-empty');
    const emptyRange = emptyNode ? document.createRange() : null;
    if (emptyRange) emptyRange.selectNodeContents(emptyNode);
    const empty = emptyRange?.getBoundingClientRect();
    return {
      headingOffsets: headings.map((left) => Number(Math.abs(left - icon.left).toFixed(2))),
      dividerOffset: Number(Math.abs(divider.left - icon.left).toFixed(2)),
      emptyOffset: empty ? Number(Math.abs(empty.left - icon.left).toFixed(2)) : null,
      inset: Number((icon.left - sidebar.left).toFixed(2)),
      width: icon.width,
      height: icon.height,
    };
  });
  if (sidebarIconAlignment.headingOffsets.some((offset) => offset > 1.5) || sidebarIconAlignment.dividerOffset > 1.5 || (sidebarIconAlignment.emptyOffset !== null && sidebarIconAlignment.emptyOffset > 1.5) || sidebarIconAlignment.inset > 20) throw new Error(`Sidebar icon baseline is not left aligned (${JSON.stringify(sidebarIconAlignment)})`);
  if (Math.abs(sidebarIconAlignment.width - 20) > 0.5 || Math.abs(sidebarIconAlignment.height - 20) > 0.5) throw new Error(`Sidebar icons are not 20px (${JSON.stringify(sidebarIconAlignment)})`);

  const inactiveSystemFilter = page.locator('#library-system-filters .system-filter:not(.active)').first();
  await inactiveSystemFilter.focus();
  const focusOutline = await inactiveSystemFilter.evaluate((button) => ({ style: getComputedStyle(button).outlineStyle, width: getComputedStyle(button).outlineWidth }));
  if (focusOutline.style === 'none' || parseFloat(focusOutline.width) <= 0) throw new Error(`Sidebar keyboard focus is not visible (${JSON.stringify(focusOutline)})`);
  const inactiveColor = await inactiveSystemFilter.evaluate((button) => getComputedStyle(button).color);
  await inactiveSystemFilter.hover();
  const hoverColors = await inactiveSystemFilter.evaluate((button) => ({ button: getComputedStyle(button).color, icon: getComputedStyle(button.querySelector('.sidebar-item-icon')).color }));
  if (hoverColors.button === inactiveColor || hoverColors.button !== hoverColors.icon) throw new Error(`Sidebar icon does not inherit the changed hover color (${JSON.stringify({ inactiveColor, ...hoverColors })})`);

  await page.setViewportSize({ width: 680, height: 900 });
  const mobileSidebarLayout = await page.locator('.library-sidebar').evaluate((sidebar) => {
    const icon = sidebar.querySelector('#library-system-filters .system-filter .sidebar-item-icon').getBoundingClientRect();
    const count = sidebar.querySelector('#library-system-filters .system-filter b').getBoundingClientRect();
    const bounds = sidebar.getBoundingClientRect();
    return { clientWidth: sidebar.clientWidth, scrollWidth: sidebar.scrollWidth, iconLeft: icon.left, countRight: count.right, sidebarLeft: bounds.left, sidebarRight: bounds.right };
  });
  if (mobileSidebarLayout.scrollWidth > mobileSidebarLayout.clientWidth + 1 || mobileSidebarLayout.iconLeft < mobileSidebarLayout.sidebarLeft || mobileSidebarLayout.countRight > mobileSidebarLayout.sidebarRight + 1) throw new Error(`Sidebar overflows at the mobile breakpoint (${JSON.stringify(mobileSidebarLayout)})`);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.mouse.move(1435, 895);

  const homeTypography = await page.evaluate(() => {
    const fontSize = (selector) => parseFloat(getComputedStyle(document.querySelector(selector)).fontSize);
    return {
      navigation: fontSize('[data-view="library-view"]'),
      sidebarHeading: fontSize('.library-sidebar-heading'),
      sidebarFilter: fontSize('.system-filter'),
      sidebarCount: fontSize('.system-filter b'),
      subtitle: fontSize('.library-subtitle'),
      search: fontSize('#library-search'),
      sort: fontSize('#library-sort'),
      columns: fontSize('.library-columns'),
      rowTitle: fontSize('.library-row-name strong'),
      rowMeta: fontSize('.library-row-name small'),
      property: fontSize('.row-status'),
      ratingStar: fontSize('.row-stars'),
      action: fontSize('.row-more-button'),
      rowHeight: document.querySelector('.library-row').getBoundingClientRect().height,
    };
  });
  const homeMinimums = { navigation: 14, sidebarHeading: 16, sidebarFilter: 13, sidebarCount: 12, subtitle: 13, search: 13, sort: 13, columns: 11, rowTitle: 14, rowMeta: 12, property: 12, ratingStar: 13, action: 15, rowHeight: 54 };
  for (const [name, minimum] of Object.entries(homeMinimums)) {
    if (homeTypography[name] < minimum) throw new Error(`Home typography regressed for ${name}: ${homeTypography[name]} < ${minimum}`);
  }
  const homeMaximums = { rowTitle: 14, rowMeta: 12, property: 13, ratingStar: 13, action: 15, rowHeight: 58 };
  for (const [name, maximum] of Object.entries(homeMaximums)) {
    if (homeTypography[name] > maximum) throw new Error(`Home density regressed for ${name}: ${homeTypography[name]} > ${maximum}`);
  }

  const responsiveWidths = [1480, 1360, 1200, 1040, 900, 861, 860, 680, 390];
  for (const width of responsiveWidths) {
    await page.setViewportSize({ width, height: 900 });
    const responsiveLayout = await page.evaluate(() => {
      const readRect = (selector) => {
        const node = document.querySelector(selector);
        const rect = node?.getBoundingClientRect();
        return rect ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height } : null;
      };
      const buttons = ['#library-sort', '#columns-button', '#import-pdf-button'].map((selector) => {
        const node = document.querySelector(selector);
        const rect = node?.getBoundingClientRect();
        const style = node ? getComputedStyle(node) : null;
        return rect && style ? { selector, rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height }, whiteSpace: style.whiteSpace, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight } : null;
      }).filter(Boolean);
      return {
        main: readRect('.library-main'),
        heading: readRect('.library-main-heading'),
        title: readRect('#library-heading'),
        subtitle: readRect('#library-subtitle'),
        actions: readRect('#library-list-actions'),
        buttons,
        scrollWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
      };
    });
    const title = responsiveLayout.title;
    const subtitle = responsiveLayout.subtitle;
    const actions = responsiveLayout.actions;
    const main = responsiveLayout.main;
    const buttonTops = responsiveLayout.buttons.map(({ rect }) => rect.top);
    const buttonBottoms = responsiveLayout.buttons.map(({ rect }) => rect.bottom);
    if (!main || !title || !subtitle || !actions || title.width < 60 || title.height > 32 || subtitle.height > 24) throw new Error(`Library heading became compressed at ${width}px (${JSON.stringify(responsiveLayout)})`);
    if (responsiveLayout.scrollWidth > responsiveLayout.viewportWidth + 1 || actions.left < main.left - 1 || actions.right > main.right + 1) throw new Error(`Library heading overflowed at ${width}px (${JSON.stringify(responsiveLayout)})`);
    if (responsiveLayout.buttons.some(({ rect, whiteSpace, scrollHeight, clientHeight }) => whiteSpace !== 'nowrap' || rect.height > 44 || scrollHeight > clientHeight + 1)) throw new Error(`Library toolbar text wrapped at ${width}px (${JSON.stringify(responsiveLayout.buttons)})`);
    if (buttonTops.length && Math.max(...buttonTops) - Math.min(...buttonTops) > 1.5) throw new Error(`Library toolbar buttons no longer share a row at ${width}px (${JSON.stringify(responsiveLayout.buttons)})`);
    if (buttonBottoms.length && Math.max(...buttonBottoms) - Math.min(...buttonBottoms) > 1.5) throw new Error(`Library toolbar buttons have mismatched heights at ${width}px (${JSON.stringify(responsiveLayout.buttons)})`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  const measureContrasts = () => page.evaluate(() => {
    const parseColor = (value) => {
      const parts = value.match(/[\d.]+/g)?.map(Number) || [];
      return { r: parts[0] || 0, g: parts[1] || 0, b: parts[2] || 0, a: parts.length > 3 ? parts[3] : 1 };
    };
    const composite = (foreground, background) => ({
      r: foreground.r * foreground.a + background.r * (1 - foreground.a),
      g: foreground.g * foreground.a + background.g * (1 - foreground.a),
      b: foreground.b * foreground.a + background.b * (1 - foreground.a),
      a: 1,
    });
    const luminance = (color) => {
      const channel = (value) => {
        const normalized = value / 255;
        return normalized <= .04045 ? normalized / 12.92 : ((normalized + .055) / 1.055) ** 2.4;
      };
      return .2126 * channel(color.r) + .7152 * channel(color.g) + .0722 * channel(color.b);
    };
    const ratio = (foreground, background) => {
      const light = Math.max(luminance(foreground), luminance(background));
      const dark = Math.min(luminance(foreground), luminance(background));
      return (light + .05) / (dark + .05);
    };
    const effectiveBackground = (node) => {
      const layers = [];
      for (let current = node; current; current = current.parentElement) layers.push(parseColor(getComputedStyle(current).backgroundColor));
      return layers.reverse().reduce((background, foreground) => foreground.a ? composite(foreground, background) : background, { r: 0, g: 0, b: 0, a: 1 });
    };
    const measure = (selector) => {
      const node = document.querySelector(selector);
      const style = getComputedStyle(node);
      const background = effectiveBackground(node);
      const foreground = composite(parseColor(style.color), background);
      return { contrast: Number(ratio(foreground, background).toFixed(2)), color: style.color, background };
    };
    return {
      rowTitle: measure('.library-row-name strong'),
      rowMeta: measure('.library-row-name small'),
      columns: measure('.library-columns'),
      readingStatus: measure('.row-status'),
      placeholder: measure('.property-placeholder'),
      rating: measure('.row-stars'),
      activeFilter: measure('.system-filter.active'),
      activeSidebarIcon: measure('.system-filter.active .sidebar-item-icon'),
      inactiveSidebarIcon: measure('.system-filter:not(.active) .sidebar-item-icon'),
    };
  });
  // Both themes are gated. Dark alone left the light ramp unchecked long
  // enough for its faintest text token to sit under the floor unnoticed.
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(250);
  const darkContrasts = await measureContrasts();
  for (const [name, metric] of Object.entries(darkContrasts)) {
    if (metric.contrast < 4.5) throw new Error(`Dark-mode contrast regressed for ${name}: ${JSON.stringify(metric)}`);
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForTimeout(250);
  const lightContrasts = await measureContrasts();
  for (const [name, metric] of Object.entries(lightContrasts)) {
    if (metric.contrast < 4.5) throw new Error(`Light-mode contrast regressed for ${name}: ${JSON.stringify(metric)}`);
  }

  // Exercise bounded uploads and the shared job poller without starting a real
  // conversion. Keep each POST open briefly so the observed request peak is
  // meaningful, then hold all jobs in progress until the assertions release
  // them together.
  const baselineJobs = await page.evaluate(async () => (await (await fetch('/api/jobs')).json()).jobs || []);
  const baselineLibrary = await page.evaluate(async () => (await (await fetch('/api/library')).json()).library);
  let activeUploads = 0;
  let peakUploads = 0;
  let batchIndex = 0;
  let pollCount = 0;
  let releasePollCount = 0;
  let metadataRefineReady = false;
  let importLibraryRefreshes = 0;
  let releaseBatch = false;
  const uploadStarts = [];
  const mockJobs = new Map();
  expectingImportPollFailure = true;
  await page.route('**/api/jobs', async (route) => {
    if (route.request().method() === 'GET') {
      pollCount += 1;
      if (pollCount === 1) {
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'transient progress outage' }) });
        return;
      }
      if (releaseBatch) {
        releasePollCount += 1;
        metadataRefineReady = releasePollCount >= 3;
      }
      const jobs = [...mockJobs.values()].map((job, index) => releaseBatch
        ? {
          ...job,
          status: index === 1 ? 'failed' : 'completed',
          progress: 1,
          stage: index === 1 ? '模拟转换失败' : '已完成',
          error: index === 1 ? '模拟转换失败' : '',
          metadata_phase: index === 1 ? undefined : 'refine',
          metadata_status: index === 1 ? undefined : (metadataRefineReady ? 'complete' : 'retrieving'),
          metadata_venue: index === 1 || !metadataRefineReady ? '' : 'Metadata Follow-up Journal',
        }
        : job);
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jobs: [...baselineJobs, ...jobs] }) });
      return;
    }
    if (route.request().method() !== 'POST') return route.continue();
    const index = batchIndex;
    batchIndex += 1;
    activeUploads += 1;
    peakUploads = Math.max(peakUploads, activeUploads);
    uploadStarts.push({ index, at: Date.now() });
    await new Promise((resolve) => setTimeout(resolve, 240));
    const progress = [0.2, 0.6, 0.4][index] ?? 0.25;
    const job = { job_id: `batch-smoke-${index + 1}`, status: 'running', stage: `解析 ${index + 1}`, progress };
    mockJobs.set(job.job_id, job);
    activeUploads -= 1;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ job }),
    });
  });
  await page.route('**/api/library', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    importLibraryRefreshes += 1;
    const library = JSON.parse(JSON.stringify(baselineLibrary));
    library.items ||= {};
    library.display ||= { columns: [] };
    const venueColumn = (library.display.columns || []).find((column) => column.id === 'venue');
    if (venueColumn) venueColumn.visible = true;
    else library.display.columns.push({ id: 'venue', label: '接收/来源', visible: true, system: true, order: library.display.columns.length });
    [...mockJobs.values()].forEach((job, index) => {
      const completed = releaseBatch && index !== 1;
      library.items[job.job_id] = {
        folder_ids: [],
        values: { reading_status: '未开始', importance: 0, research_topic: [], venue: '' },
        metadata: {
          status: completed ? (metadataRefineReady ? 'complete' : 'retrieving') : 'not-run',
          fields: { title: `Batch Smoke ${index + 1}`, venue: completed && metadataRefineReady ? 'Metadata Follow-up Journal' : '' },
          sources: {}, locked_fields: [], candidates: [], error: '', retrieved_at: null,
        },
        progress: { percent: 0, page: 1, scroll_top: 0 },
        deleted_at: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      };
    });
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ library }) });
  });
  await page.evaluate(() => {
    const first = new File(['%PDF-1.4 smoke one'], 'batch-one.pdf', { type: 'application/pdf', lastModified: 101 });
    const second = new File(['%PDF-1.4 smoke two'], 'batch-two.pdf', { type: 'application/pdf', lastModified: 202 });
    const transfer = new DataTransfer();
    transfer.items.add(first);
    transfer.items.add(second);
    transfer.items.add(first);
    const input = document.querySelector('#file-input');
    Object.defineProperty(input, 'files', { configurable: true, value: transfer.files });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(() => document.querySelectorAll('.import-queue-item.uploading').length === 2);
  if (await page.locator('.import-queue-item').count() !== 2) throw new Error('A duplicate file in the same batch was not removed');
  await page.evaluate(() => {
    const third = new File(['%PDF-1.4 smoke three'], 'batch-three.pdf', { type: 'application/pdf', lastModified: 303 });
    const transfer = new DataTransfer();
    transfer.items.add(third);
    const input = document.querySelector('#file-input');
    Object.defineProperty(input, 'files', { configurable: true, value: transfer.files });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const uploadDeadline = Date.now() + 4000;
  while (uploadStarts.length < 3 && Date.now() < uploadDeadline) await page.waitForTimeout(40);
  if (uploadStarts.length !== 3) throw new Error(`A queued upload waited for earlier conversions (${uploadStarts.length}/3 submitted)`);
  if (peakUploads !== 2) throw new Error(`Upload concurrency is not bounded at two (peak ${peakUploads})`);
  await page.waitForFunction(() => document.querySelector('#progress-value')?.textContent === '40%');
  expectingImportPollFailure = false;
  if (await page.locator('.import-queue-item.failed').count()) throw new Error('A transient batch polling failure marked a backend job as failed');
  if (!(await page.locator('#progress-stage').textContent()).includes('并行导入')) throw new Error('Parallel import stages are not represented in the progress UI');
  releaseBatch = true;
  await page.locator('.import-queue-item.done').nth(1).waitFor();
  await page.locator('.import-queue-item.failed').waitFor();
  if (await page.locator('.import-queue-item.done').count() !== 2 || await page.locator('.import-queue-item.failed').count() !== 1) throw new Error('One failed conversion prevented the remaining batch items from completing');
  const importedVenue = page.locator('#recent-list [data-job-id="batch-smoke-1"] .row-venue');
  await importedVenue.filter({ hasText: 'Metadata Follow-up Journal' }).waitFor();
  if (importLibraryRefreshes < 2 || importLibraryRefreshes > 3) throw new Error(`Metadata follow-up caused an unexpected library refresh count (${importLibraryRefreshes})`);
  await page.unroute('**/api/jobs');
  await page.unroute('**/api/library');
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('#recent-list .library-row').first().waitFor();

  await page.locator('[data-view="settings-view"]').click();
  await page.locator('#settings-view.active-view').waitFor();
  const settingsViewMotion = await page.locator('#settings-view').evaluate((view) => {
    const style = getComputedStyle(view);
    return {
      animationName: style.animationName,
      durationMs: style.animationDuration.split(',').reduce((maximum, value) => Math.max(maximum, parseFloat(value) * (value.trim().endsWith('ms') ? 1 : 1000)), 0),
      activeAnimations: view.getAnimations().length,
    };
  });
  if (settingsViewMotion.animationName === 'none' || settingsViewMotion.durationMs < 140 || settingsViewMotion.activeAnimations < 1) throw new Error(`Primary view change has no visible motion (${JSON.stringify(settingsViewMotion)})`);
  if (await page.locator('#setting-metadata-auto').count() !== 1 || await page.locator('#setting-metadata-online').count() !== 1) throw new Error('Metadata settings are not exposed in the settings view');
  if (await page.locator('#setting-app-font').count() !== 1 || await page.locator('#setting-reader-font').count() !== 1 || await page.locator('input[name="setting-accent"]').count() !== 6 || await page.locator('#setting-highlight-color').count() !== 0 || await page.locator('#shortcut-highlight-note').count() !== 1 || await page.locator('#shortcut-underline-note').count() !== 1) throw new Error('Appearance presets or annotation shortcuts are missing from settings');
  await page.locator('[data-view="library-view"]').click();
  await page.locator('#recent-list .library-row').first().waitFor();

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('#manage-views-button').click();
  await page.locator('#views-view.active-view').waitFor();
  const reducedViewMotion = await page.locator('#views-view').evaluate((view) => ({ animationName: getComputedStyle(view).animationName, activeAnimations: view.getAnimations().length }));
  if (reducedViewMotion.animationName !== 'none' || reducedViewMotion.activeAnimations) throw new Error(`Reduced-motion navigation still animates (${JSON.stringify(reducedViewMotion)})`);
  await page.locator('[data-view="library-view"]').click();
  await page.locator('#recent-list .library-row').first().waitFor();
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  const dialogFolderName = `Dialog Smoke Folder ${Date.now()}`;
  await page.locator('#create-folder-button').click();
  await page.locator('#library-editor-dialog[open]').waitFor();
  const dialogMotion = await page.locator('#library-editor-dialog').evaluate((dialog) => {
    const style = getComputedStyle(dialog);
    return {
      properties: style.transitionProperty,
      durationMs: style.transitionDuration.split(',').reduce((maximum, value) => Math.max(maximum, parseFloat(value) * (value.trim().endsWith('ms') ? 1 : 1000)), 0),
    };
  });
  if (!dialogMotion.properties.includes('opacity') || !dialogMotion.properties.includes('transform') || dialogMotion.durationMs < 140) throw new Error(`Dialog open/close motion is missing (${JSON.stringify(dialogMotion)})`);
  await page.locator('#editor-folder-name').fill(dialogFolderName);
  await page.locator('#library-editor-save').click();
  const dialogFolder = page.locator('.folder-tree-node').filter({ hasText: dialogFolderName });
  await dialogFolder.waitFor();
  if (await dialogFolder.locator('.folder-button svg.sidebar-item-icon[aria-hidden="true"]').count() !== 1) throw new Error('Custom folder does not have one decorative folder icon');
  const dialogFolderId = await dialogFolder.locator('.folder-button').first().getAttribute('data-library-folder');
  const rootFolderAlignment = await dialogFolder.locator('.folder-button .sidebar-item-icon').evaluate((icon) => Math.abs(icon.getBoundingClientRect().left - document.querySelector('.library-sidebar-heading strong').getBoundingClientRect().left));
  if (rootFolderAlignment > 1.5) throw new Error(`First-level custom folder is not aligned (${rootFolderAlignment})`);
  await dialogFolder.locator('[data-folder-delete]').click();
  await page.locator('#confirm-dialog[open]').waitFor();
  await page.locator('#confirm-cancel').click();
  await page.locator('#confirm-dialog').waitFor({ state: 'hidden' });

  const nestedFolderName = `Nested Smoke Folder ${Date.now()}`;
  const nestedFolderId = await page.evaluate(async ({ name, parentId }) => {
    const response = await fetch('/api/library/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, parent_id: parentId }) });
    return (await response.json()).folder.id;
  }, { name: nestedFolderName, parentId: dialogFolderId });
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('#recent-list .library-row').first().waitFor();
  const nestedFolderAlignment = await page.evaluate(({ rootId, nestedId }) => {
    const root = document.querySelector(`[data-library-folder="${CSS.escape(rootId)}"] .sidebar-item-icon`).getBoundingClientRect();
    const nested = document.querySelector(`[data-library-folder="${CSS.escape(nestedId)}"] .sidebar-item-icon`).getBoundingClientRect();
    return { rootLeft: root.left, nestedLeft: nested.left, indent: nested.left - root.left };
  }, { rootId: dialogFolderId, nestedId: nestedFolderId });
  if (nestedFolderAlignment.indent < 10 || nestedFolderAlignment.indent > 14) throw new Error(`Nested folder indentation is incorrect (${JSON.stringify(nestedFolderAlignment)})`);

  const row = page.locator('#recent-list .library-row').first();
  const jobId = await row.getAttribute('data-job-id');
  if (await row.locator('[data-folder-edit-job-id]').count()) throw new Error('The removed inline classification action is still rendered');

  const originalImportance = await page.evaluate(async (id) => Number((await (await fetch('/api/library')).json()).library.items[id]?.values?.importance || 0), jobId);
  const nextImportance = originalImportance === 4 ? 3 : 4;
  await row.locator('.library-row-name').click();
  await page.locator(`#library-details [data-details-importance="${nextImportance}"]`).click();
  await page.locator(`#library-details [data-details-importance="${nextImportance}"][aria-checked="true"]`).waitFor();
  if (await page.locator('#library-editor-dialog').evaluate((dialog) => dialog.open)) throw new Error('Inline importance opened the modal editor');
  const savedImportance = await page.evaluate(async (id) => Number((await (await fetch('/api/library')).json()).library.items[id]?.values?.importance || 0), jobId);
  if (savedImportance !== nextImportance) throw new Error(`Inline importance did not persist (${savedImportance})`);
  const rejectedImportance = nextImportance === 5 ? 2 : 5;
  await page.route(`**/api/library/items/${jobId}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue();
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '模拟评分保存失败' }) });
  });
  expectingImportanceFailure = true;
  await page.locator(`#library-details [data-details-importance="${rejectedImportance}"]`).click();
  await page.locator(`#library-details [data-details-importance="${nextImportance}"][aria-checked="true"]`).waitFor();
  const rolledBackImportance = await page.evaluate(async (id) => Number((await (await fetch('/api/library')).json()).library.items[id]?.values?.importance || 0), jobId);
  if (rolledBackImportance !== nextImportance) throw new Error(`Failed importance save did not restore the persisted score (${rolledBackImportance})`);
  await page.unroute(`**/api/library/items/${jobId}`);
  expectingImportanceFailure = false;

  await row.click({ button: 'right' });
  const contextMenu = row.locator('[data-row-more-menu]');
  await contextMenu.waitFor({ state: 'visible' });
  const contextActions = await contextMenu.locator('[data-row-action]').allTextContents();
  if (!contextActions.some((text) => text.includes('打开文献')) || !contextActions.some((text) => text.includes('编辑元数据')) || !contextActions.some((text) => text.includes('添加到文件夹')) || !contextActions.some((text) => text.includes('移入回收站'))) throw new Error(`The row context menu is incomplete (${contextActions.join(' | ')})`);
  await contextMenu.locator('[data-row-action="folders"]').click();
  await page.locator('#library-editor-dialog[open]').waitFor();
  if ((await page.locator('#library-editor-title').textContent()).trim() !== '选择文献分类') throw new Error('The context-menu folder action did not open the folder picker');
  await page.locator('#library-editor-cancel').click();
  await page.locator('#library-editor-dialog').waitFor({ state: 'hidden' });

  await row.focus();
  await page.keyboard.press('Meta+i');
  await page.locator('#metadata-dialog[open]').waitFor();
  await page.locator('#metadata-dialog .dialog-close').click();
  await page.locator('#metadata-dialog').waitFor({ state: 'hidden' });
  await row.focus();
  await page.keyboard.press('Control+i');
  if (await page.locator('#metadata-dialog').evaluate((dialog) => dialog.open)) throw new Error('Control+I incorrectly triggered a Command-only row shortcut');
  await page.locator('#columns-button').focus();
  await page.keyboard.press('Meta+i');
  if (await page.locator('#metadata-dialog').evaluate((dialog) => dialog.open)) throw new Error('Row shortcut triggered while focus was outside the selected row');

  const customColumnLabel = `复现阶段 ${Date.now()}`;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('#columns-button').evaluate((button) => button.click());
  await page.locator('#library-editor-dialog[open]').waitFor();
  if (await page.locator('#library-editor-dialog [data-column-width], #library-editor-dialog .column-width-field').count()) throw new Error('Column settings still expose a duplicate numeric width control');
  const columnsDialogLayout = await page.locator('#library-editor-dialog[open]').evaluate((dialog) => {
    const editor = dialog.querySelector('.columns-editor');
    const existing = dialog.querySelector('.columns-existing')?.getBoundingClientRect();
    const creator = dialog.querySelector('.column-creator')?.getBoundingClientRect();
    const cards = [...dialog.querySelectorAll('.column-option')].slice(0, 2).map((node) => node.getBoundingClientRect());
    return {
      dialogWidth: dialog.getBoundingClientRect().width,
      viewportWidth: window.innerWidth,
      editorColumns: getComputedStyle(editor).gridTemplateColumns,
      horizontalRegions: Boolean(existing && creator && creator.left > existing.right),
      horizontalCards: cards.length === 2 && Math.abs(cards[0].top - cards[1].top) < 2 && cards[1].left > cards[0].right,
    };
  });
  if (columnsDialogLayout.dialogWidth < Math.min(1100, columnsDialogLayout.viewportWidth - 48)) throw new Error(`Column editor did not expand into a page-like workspace (${JSON.stringify(columnsDialogLayout)})`);
  if (!columnsDialogLayout.horizontalRegions || !columnsDialogLayout.horizontalCards) throw new Error(`Column editor did not use the expected horizontal layout (${JSON.stringify(columnsDialogLayout)})`);

  await page.setViewportSize({ width: 680, height: 720 });
  const responsiveColumnsLayout = await page.locator('#library-editor-dialog[open]').evaluate((dialog) => {
    const content = dialog.querySelector('.dialog-content');
    const existing = dialog.querySelector('.columns-existing')?.getBoundingClientRect();
    const creator = dialog.querySelector('.column-creator')?.getBoundingClientRect();
    const cards = [...dialog.querySelectorAll('.column-option')].slice(0, 2).map((node) => node.getBoundingClientRect());
    const actions = dialog.querySelector('.dialog-actions').getBoundingClientRect();
    return {
      stackedRegions: Boolean(existing && creator && creator.top > existing.bottom),
      singleColumnCards: cards.length === 2 && cards[1].top > cards[0].bottom,
      noHorizontalOverflow: content.scrollWidth <= content.clientWidth + 1,
      actionsBottom: actions.bottom,
      viewportHeight: window.innerHeight,
    };
  });
  if (!responsiveColumnsLayout.stackedRegions || !responsiveColumnsLayout.singleColumnCards || !responsiveColumnsLayout.noHorizontalOverflow || responsiveColumnsLayout.actionsBottom > responsiveColumnsLayout.viewportHeight) throw new Error(`Column editor responsive layout regressed (${JSON.stringify(responsiveColumnsLayout)})`);
  await page.locator('#library-editor-cancel').click();
  await page.locator('#library-editor-dialog').waitFor({ state: 'hidden' });

  await page.setViewportSize({ width: 1440, height: 420 });
  const backgroundBeforeColumnsDialog = await page.evaluate(() => {
    const maximum = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    window.scrollTo(0, Math.min(240, maximum));
    return window.scrollY;
  });
  if (backgroundBeforeColumnsDialog <= 0) throw new Error('Column editor scroll regression requires a scrollable background');
  await page.locator('#columns-button').evaluate((button) => button.click());
  await page.locator('#library-editor-dialog[open]').waitFor();
  const compactColumnsDialogLayout = await page.locator('#library-editor-dialog[open]').evaluate((dialog) => {
    const content = dialog.querySelector('.dialog-content');
    const actions = dialog.querySelector('.dialog-actions').getBoundingClientRect();
    return { actionsBottom: actions.bottom, viewportHeight: window.innerHeight, contentScrollable: content.scrollHeight > content.clientHeight };
  });
  if (compactColumnsDialogLayout.actionsBottom > compactColumnsDialogLayout.viewportHeight) throw new Error(`Column editor actions are clipped (${JSON.stringify(compactColumnsDialogLayout)})`);
  if (!compactColumnsDialogLayout.contentScrollable) throw new Error(`Column editor content is not independently scrollable (${JSON.stringify(compactColumnsDialogLayout)})`);

  const columnsDialog = page.locator('#library-editor-dialog[open]');
  const columnsContent = columnsDialog.locator('.dialog-content');
  const contentBox = await columnsContent.boundingBox();
  const dialogBox = await columnsDialog.boundingBox();
  if (!contentBox || !dialogBox) throw new Error('Column editor scroll containers could not be measured');
  const backgroundWhileOpen = await page.evaluate(() => window.scrollY);
  await columnsContent.evaluate((content) => { content.scrollTop = 0; });
  await page.mouse.move(contentBox.x + contentBox.width / 2, contentBox.y + Math.min(120, contentBox.height / 2));
  await page.mouse.wheel(0, 360);
  await page.waitForTimeout(100);
  const afterInnerWheel = await page.evaluate(() => ({ background: window.scrollY, content: document.querySelector('#library-editor-content').scrollTop }));
  if (afterInnerWheel.content <= 0) throw new Error(`Column editor did not consume an inner wheel gesture (${JSON.stringify(afterInnerWheel)})`);
  if (Math.abs(afterInnerWheel.background - backgroundWhileOpen) > 1) throw new Error(`Column editor wheel leaked into the page background (${JSON.stringify({ backgroundWhileOpen, afterInnerWheel })})`);

  const contentBottom = await columnsContent.evaluate((content) => {
    content.scrollTop = content.scrollHeight;
    return content.scrollTop;
  });
  await page.mouse.wheel(0, 360);
  await page.waitForTimeout(100);
  const afterBottomWheel = await page.evaluate(() => ({ background: window.scrollY, content: document.querySelector('#library-editor-content').scrollTop }));
  if (Math.abs(afterBottomWheel.content - contentBottom) > 1 || Math.abs(afterBottomWheel.background - backgroundWhileOpen) > 1) throw new Error(`Column editor chained a bottom-edge wheel into the background (${JSON.stringify({ backgroundWhileOpen, contentBottom, afterBottomWheel })})`);

  await page.mouse.move(Math.max(2, Math.min(8, dialogBox.x / 2)), Math.max(2, Math.min(8, dialogBox.y / 2)));
  await page.mouse.wheel(0, 360);
  await page.waitForTimeout(100);
  const backgroundAfterBackdropWheel = await page.evaluate(() => window.scrollY);
  if (Math.abs(backgroundAfterBackdropWheel - backgroundWhileOpen) > 1) throw new Error(`Column editor backdrop wheel scrolled the page (${JSON.stringify({ backgroundWhileOpen, backgroundAfterBackdropWheel })})`);

  await page.locator('#editor-new-column-label').fill(customColumnLabel);
  await page.locator('#editor-new-column-type').selectOption('text');
  await page.locator('#library-editor-save').click();
  await page.locator('#library-editor-dialog').waitFor({ state: 'hidden' });
  const backgroundAfterColumnsDialog = await page.evaluate(() => window.scrollY);
  if (Math.abs(backgroundAfterColumnsDialog - backgroundBeforeColumnsDialog) > 1) throw new Error(`Closing the column editor did not restore the background scroll position (${JSON.stringify({ backgroundBeforeColumnsDialog, backgroundAfterColumnsDialog })})`);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.mouse.move(1400, 500);
  await page.mouse.wheel(0, 240);
  await page.waitForTimeout(100);
  const backgroundAfterCloseWheel = await page.evaluate(() => window.scrollY);
  if (backgroundAfterCloseWheel <= 0) throw new Error('Closing the column editor left background scrolling locked');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForFunction((label) => document.querySelector('#library-columns')?.innerText.includes(label), customColumnLabel);
  const customPropertyId = await page.evaluate(async (label) => (await (await fetch('/api/library')).json()).library.properties.find((property) => property.label === label)?.id, customColumnLabel);
  if (!customPropertyId) throw new Error('Column settings did not create a custom property');
  await page.locator('#columns-button').click();
  await page.locator(`#library-editor-dialog[open] [data-column-visible="${customPropertyId}"]`).uncheck();
  await page.locator('#library-editor-save').click();
  await page.locator('#library-editor-dialog').waitFor({ state: 'hidden' });
  if ((await page.locator('#library-columns').innerText()).includes(customColumnLabel)) throw new Error('Column visibility setting did not hide the custom column');
  const customColumnVisible = await page.evaluate(async (propertyId) => (await (await fetch('/api/library')).json()).library.display.columns.find((column) => column.id === propertyId)?.visible, customPropertyId);
  if (customColumnVisible !== false) throw new Error('Hidden custom column was not persisted');

  await row.locator('.library-row-name').click();
  await page.locator('#library-details [data-details-action="metadata"]').click();
  await page.locator('#metadata-dialog[open]').waitFor();
  if (await page.locator('[data-metadata-field="title"]').count() !== 1) throw new Error('Metadata editor did not render a title field');
  await page.locator('#metadata-dialog .dialog-close').click();
  await page.locator('#metadata-dialog').waitFor({ state: 'hidden' });

  await page.locator('#library-details [data-details-edit="venue"]').click();
  await page.locator('#library-editor-dialog[open]').waitFor();
  await page.locator('#editor-value').fill('Smoke Venue');
  await page.locator('#library-editor-save').click();
  await page.locator('#library-editor-dialog').waitFor({ state: 'hidden' });
  if (!(await page.locator(`#recent-list .library-row[data-job-id="${jobId}"]`).innerText()).includes('Smoke Venue')) throw new Error('Source editor did not persist its value');

  await page.locator('#library-details [data-details-edit="research_topic"]').click();
  await page.locator('#library-editor-dialog[open]').waitFor();
  await page.locator('#editor-multi').fill('Vision, Smoke');
  await page.locator('#library-editor-save').click();
  await page.locator('#library-editor-dialog').waitFor({ state: 'hidden' });
  if (!(await page.locator(`#recent-list .library-row[data-job-id="${jobId}"]`).innerText()).includes('Vision')) throw new Error('Topic editor did not persist its tags');

  await row.locator('.library-row-name').dblclick();
  await page.locator('#reader-view.active-view').waitFor();
  if (await page.locator('.app-header').evaluate((node) => getComputedStyle(node).display) === 'none') throw new Error('Global app header is hidden in reader mode');
  if (await page.locator('[data-view="library-view"]').count() !== 1 || await page.locator('[data-view="views-view"]').count() !== 0 || await page.locator('[data-view="settings-view"]').count() !== 1 || await page.locator('#manage-views-button').count() !== 1) throw new Error('Global navigation or view management controls are inconsistent in reader mode');
  await page.locator('#document-tabs:not([hidden])').waitFor();
  const topTabMetrics = await page.evaluate(() => {
    document.documentElement.classList.add('desktop-macos');
    const nav = document.querySelector('[data-view="library-view"]');
    const tab = document.querySelector('#document-tabs .document-tab');
    const close = tab?.querySelector('.document-tab-close');
    const navRect = nav?.getBoundingClientRect();
    const tabRect = tab?.getBoundingClientRect();
    return {
      navHeight: navRect?.height,
      tabHeight: tabRect?.height,
      navBottom: navRect?.bottom,
      tabBottom: tabRect?.bottom,
      navFontSize: nav ? getComputedStyle(nav).fontSize : '',
      tabFontSize: tab ? getComputedStyle(tab).fontSize : '',
      tabRegion: getComputedStyle(document.querySelector('#document-tabs')).webkitAppRegion,
      itemRegion: tab ? getComputedStyle(tab).webkitAppRegion : '',
      closeRegion: close ? getComputedStyle(close).webkitAppRegion : '',
    };
  });
  if (Math.abs(topTabMetrics.navHeight - topTabMetrics.tabHeight) > 0.5 || Math.abs(topTabMetrics.navBottom - topTabMetrics.tabBottom) > 0.5 || topTabMetrics.navFontSize !== topTabMetrics.tabFontSize) throw new Error(`Top navigation and document tabs are not aligned (${JSON.stringify(topTabMetrics)})`);
  if (topTabMetrics.tabRegion !== 'drag' || topTabMetrics.itemRegion !== 'no-drag' || topTabMetrics.closeRegion !== 'no-drag') throw new Error(`Document tab strip does not preserve a draggable titlebar (${JSON.stringify(topTabMetrics)})`);
  await page.locator('[data-view="library-view"]').click();
  await page.locator('#library-view.active-view').waitFor();
  await page.locator('#document-tabs:not([hidden])').waitFor();

  await page.locator('#columns-button').click();
  await page.locator('#library-editor-dialog[open]').waitFor();
  if (await page.locator('#library-editor-dialog[open] [data-column-id="status"]').count()) throw new Error('Retired status column is still visible in column settings');
  if (await page.locator('#library-editor-dialog[open] [data-column-id="name"] [data-column-delete]').count()) throw new Error('System column unexpectedly exposes a delete button');
  const quickDelete = page.locator(`#library-editor-dialog[open] [data-column-delete="${customPropertyId}"]`);
  if (await quickDelete.count() !== 1) throw new Error('Custom column does not expose exactly one quick delete button');
  await quickDelete.click();
  await page.locator('#confirm-dialog[open]').waitFor();
  await page.locator('#confirm-accept').click();
  await page.waitForFunction((propertyId) => !document.querySelector(`#library-editor-dialog [data-column-id="${propertyId}"]`), customPropertyId);
  const deletedPropertyStillExists = await page.evaluate(async (propertyId) => Boolean((await (await fetch('/api/library')).json()).library.properties.find((property) => property.id === propertyId)), customPropertyId);
  if (deletedPropertyStillExists) throw new Error('Quick delete did not remove the custom property from the library');
  await page.locator('#library-editor-cancel').click();
  await page.locator('#library-editor-dialog').waitFor({ state: 'hidden' });

  await page.evaluate(async ({ id, importance, nestedId, rootId }) => {
    await fetch(`/api/library/items/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values: { importance } }) });
    await fetch(`/api/library/folders/${nestedId}`, { method: 'DELETE' });
    await fetch(`/api/library/folders/${rootId}`, { method: 'DELETE' });
  }, { id: jobId, importance: originalImportance, nestedId: nestedFolderId, rootId: dialogFolderId });

  console.log(JSON.stringify({ globalNavigation: true, documentTabs: true, importInputMultiple: true, batchImport: true, importConcurrencyPeak: peakUploads, importPollRetries: pollCount, importAggregateProgress: 40, importFailureIsolation: true, importDeduplication: true, metadataFollowupRefreshes: importLibraryRefreshes, metadataVenueRefresh: true, metadataEditor: true, propertyEditor: true, inlineImportance: true, rowContextMenu: true, rowShortcut: true, customColumns: true, customColumnQuickDelete: true, columnsDialogLayout, columnsDialogScrollIsolation: true, appDialogs: true, homeTypography, darkContrasts, jobId, errors }));
  if (errors.length) process.exitCode = 1;
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
