const fs = require('fs');
const path = require('path');
const { launchManagedChromium } = require('./playwright.cjs');

const baseURL = process.argv[2] || 'http://127.0.0.1:8768';
const primaryModifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const sourceRoot = process.env.MY_SCHOLAR_TEST_DATA || path.resolve(__dirname, '..', 'data');
let browser = null;
let browserSession = null;

(async () => {
  browserSession = await launchManagedChromium();
  browser = browserSession.browser;
  const page = await browser.newPage({ viewport: { width: 1600, height: 980 } });
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('**/api/health', async (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, service: 'my-scholar', version: '0.1', shell: 'reference', ai: { services: { translation: { enabled: true, configured: true, model: 'translation-smoke', profile_id: 'translation-smoke-profile' }, chat: { enabled: true, configured: true, model: 'chat-smoke', profile_id: 'chat-smoke-profile' } } } }),
  }));
  // The source fixture may already have a complete translation cache. Keep
  // this regression deterministic by presenting an empty cache to the client;
  // translation POST requests are mocked below and never consume model quota.
  await page.route('**/api/jobs/*/translations', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ translations: [] }) });
  });
  await page.route('**/api/jobs/*/translate', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 180));
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { text: '这是回归测试译文。', profile_id: 'translation-smoke-profile' } }) });
  });
  await page.route('**/api/jobs/*/auto-highlights', async (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ result: { status: 'mock', highlights: [] } }),
  }));

  await page.goto(baseURL, { waitUntil: 'networkidle' });

  const json = async (url, options) => page.evaluate(async ({ url, options }) => {
    const response = await fetch(url, options);
    return response.json();
  }, { url, options });
  const jobsPayload = await json('/api/jobs');
  const jobs = jobsPayload.jobs.filter((job) => job.status === 'completed');
  if (jobs.length < 2) throw new Error('Interaction regression needs at least two completed jobs');
  // Prefer a real converted document with paragraph block IDs. Historical
  // fixtures also contain plain HTML fallback jobs, which are valid library
  // rows but cannot exercise translation interactions.
  const richJobs = jobs.filter((job) => {
    const htmlPath = path.join(sourceRoot, 'jobs', job.job_id, 'document.html');
    return fs.existsSync(htmlPath) && /data-block-id=/u.test(fs.readFileSync(htmlPath, 'utf8'));
  });
  if (richJobs.length < 2) throw new Error('Interaction regression needs two completed jobs with translatable blocks');
  const cacheSizes = await Promise.all(richJobs.map(async (job) => ((await json(`/api/jobs/${job.job_id}/translations`)).translations || []).length));
  const firstIndex = Math.max(0, cacheSizes.findIndex((size) => size === 0));
  const first = richJobs[firstIndex];
  const second = richJobs.find((job, index) => index !== firstIndex) || richJobs[1];

  await page.locator('#recent-list .library-row').first().waitFor();

  // Enter in the topic editor must take the save path, not the dialog's first
  // (cancel) submit button.
  const topic = `回归主题-${Date.now()}`;
  await page.locator(`#recent-list .library-row[data-job-id="${first.job_id}"]`).click();
  await page.locator('#library-details [data-details-edit="research_topic"]').click();
  await page.locator('#editor-multi').fill(topic);
  await page.locator('#editor-multi').press('Enter');
  await page.waitForFunction(() => !document.querySelector('#library-editor-dialog')?.open);
  const afterTopic = await json('/api/library');
  const topicValues = afterTopic.library.items[first.job_id]?.values?.research_topic || [];
  if (!topicValues.includes(topic)) throw new Error('Enter did not persist the research topic');

  // Open one document first so an import does not steal the reader focus. The
  // upload is a duplicate title and is sent while a custom folder is active.
  await page.locator(`#recent-list .library-row[data-job-id="${first.job_id}"]`).dblclick();
  await page.locator('#reader-view.active-view').waitFor();
  await page.locator('[data-view="library-view"]').click();
  await page.locator('#library-view.active-view').waitFor();
  const folderPayload = await json('/api/library/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: `Import smoke ${Date.now()}` }) });
  const folderId = folderPayload.folder.id;
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator(`[data-library-folder="${folderId}"]`).click();
  const source = path.join(sourceRoot, 'jobs', first.job_id, 'source.pdf');
  if (!fs.existsSync(source)) throw new Error(`Missing source PDF for duplicate upload: ${source}`);
  const beforeCount = (await json('/api/jobs')).jobs.length;
  await page.locator('#file-input').setInputFiles({ name: first.source_filename, mimeType: 'application/pdf', buffer: fs.readFileSync(source) });
  await page.waitForTimeout(250);
  await page.waitForFunction(() => document.querySelector('#progress-card')?.hidden === true, null, { timeout: 8000 });
  const afterImport = await json('/api/jobs');
  if (afterImport.jobs.length !== beforeCount) throw new Error('Duplicate upload created a second job');
  const afterFolder = await json('/api/library');
  const duplicateIds = afterImport.jobs.filter((job) => job.source_filename === first.source_filename).map((job) => job.job_id);
  if (!duplicateIds.some((jobId) => afterFolder.library.items[jobId]?.folder_ids?.includes(folderId))) throw new Error('Duplicate upload did not retain the active folder index');

  // Open two tabs and ensure the document strip uses the space before 设置.
  await page.locator('[data-library-folder="system-all"]').click();
  await page.locator(`#recent-list .library-row[data-job-id="${first.job_id}"]`).dblclick();
  await page.locator('[data-view="library-view"]').click();
  await page.locator(`#recent-list .library-row[data-job-id="${second.job_id}"]`).dblclick();
  await page.locator('[data-view="library-view"]').click();
  await page.locator(`#recent-list .library-row[data-job-id="${first.job_id}"]`).dblclick();
  await page.locator('#document-tabs .document-tab').nth(1).waitFor();
  const tabStrip = await page.locator('#document-tabs').boundingBox();
  const settings = await page.locator('[data-view="settings-view"]').boundingBox();
  if (!tabStrip || !settings || tabStrip.width < 500 || tabStrip.right > settings.left + 2) throw new Error('Document tab strip did not expand into the view-to-settings region');
  const firstTab = page.locator(`#document-tabs .document-tab[data-job-id="${first.job_id}"]`);
  await firstTab.focus();
  await firstTab.press('ArrowRight');
  const rovingTabs = await page.locator('#document-tabs').evaluate((strip) => ({
    tabbable: [...strip.querySelectorAll('.document-tab')].filter((tab) => tab.tabIndex === 0).map((tab) => tab.dataset.jobId),
    selected: [...strip.querySelectorAll('.document-tab[aria-selected="true"]')].map((tab) => tab.dataset.jobId),
    focused: document.activeElement?.dataset?.jobId || '',
  }));
  if (rovingTabs.tabbable.length !== 1 || rovingTabs.tabbable[0] !== second.job_id || rovingTabs.focused !== second.job_id || rovingTabs.selected[0] !== first.job_id) throw new Error(`Document tabs did not implement manual roving focus (${JSON.stringify(rovingTabs)})`);
  await page.keyboard.press('ArrowLeft');
  if (await page.evaluate(() => document.activeElement?.dataset?.jobId || '') !== first.job_id) throw new Error('ArrowLeft did not restore focus to the previous document tab');

  // Start the first run, switch documents while its request is in flight, and
  // verify the second document keeps an independent enabled action.
  const firstRequest = page.waitForRequest((request) => request.method() === 'POST' && request.url().includes(`/api/jobs/${first.job_id}/translate`));
  await page.locator('#full-translate-button').click();
  await firstRequest;
  await page.locator(`#document-tabs .document-tab[data-job-id="${second.job_id}"]`).click();
  await page.locator('#reader-view.active-view').waitFor();
  await page.waitForTimeout(160);
  if (await page.locator('#full-translate-button').isDisabled()) throw new Error('A different document inherited the first document translation disabled state');
  await page.locator('#full-translate-button').click();
  await page.waitForTimeout(300);
  if (errors.some((message) => /reading ['"]?stop|Cannot read properties of null/u.test(message))) throw new Error(`Translation switch emitted a null stop error: ${errors.join(' | ')}`);
  await page.frameLocator('#html-preview').locator('body').press(`${primaryModifier}+1`);
  await page.locator('#library-view.active-view').waitFor();
  await page.locator(`#document-tabs .document-tab[data-job-id="${second.job_id}"]`).click();
  await page.locator('#reader-view.active-view').waitFor();

  // Closing an inactive document should visibly finish its exit motion before
  // removing the tab, without disturbing the active reader.
  const closingTab = page.locator(`#document-tabs .document-tab[data-job-id="${first.job_id}"]`);
  await closingTab.locator('[data-close-job-id]').click();
  const closingState = await closingTab.evaluate((tab) => ({ closing: tab.classList.contains('is-closing'), pointerEvents: getComputedStyle(tab).pointerEvents }));
  if (!closingState.closing || closingState.pointerEvents !== 'none') throw new Error(`Document tab was removed without a guarded exit motion (${JSON.stringify(closingState)})`);
  await closingTab.waitFor({ state: 'detached' });
  if (await page.locator(`#document-tabs .document-tab[data-job-id="${second.job_id}"].active`).count() !== 1) throw new Error('Closing an inactive tab changed the active document');

  await json(`/api/library/folders/${folderId}`, { method: 'DELETE' });
  await json(`/api/library/items/${first.job_id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values: { research_topic: [] } }) });
  console.log(JSON.stringify({ topicEnter: true, duplicateUpload: true, folderRetention: true, importProgressDismissed: true, expandedTabs: true, rovingTabs: true, iframeShortcuts: true, perDocumentTranslation: true, errors }));
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
