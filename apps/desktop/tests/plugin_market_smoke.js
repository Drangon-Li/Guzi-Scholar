'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { launchManagedChromium } = require('./playwright.cjs');

const baseURL = process.argv[2];
if (!baseURL || !process.env.MY_SCHOLAR_TEST_DATA) throw new Error('Use an isolated fixture server with MY_SCHOLAR_TEST_DATA. This suite installs fixture plugins and updates fixture notes.');

(async () => {
  const session = await launchManagedChromium();
  let page;
  try {
    page = await session.browser.newPage({ viewport: { width: 1460, height: 960 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(15000);
    const errors = [];
    const mcpRequests = [];
    const settingsWrites = [];
    const pluginCalls = [];
    let fixtureCheckFailure = false;
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/mcp/')) mcpRequests.push(request);
      if (new URL(request.url()).pathname === '/api/plugins/call' && request.method() === 'POST') pluginCalls.push(request.postDataJSON());
      if (new URL(request.url()).pathname === '/api/settings' && request.method() === 'POST') settingsWrites.push(request);
    });
    page.on('pageerror', (error) => errors.push(error.message));
    const call = async (name, args = {}) => {
      const response = await page.request.post(`${baseURL}/api/plugins/call`, { data: { name, arguments: args } });
      const payload = await response.json(); assert(response.ok(), `${name}: ${JSON.stringify(payload)}`); return payload.result;
    };
    await page.exposeFunction('fixtureRuntimeCheck', async (request) => {
      const state = await (await page.request.get(`${baseURL}/api/plugins/runtime-status?pluginId=${encodeURIComponent(request.pluginId)}`)).json();
      assert.equal((state.runtime || state).status, 'ready', 'Host must finish reporting ready before desktop check');
      if (fixtureCheckFailure) throw new Error('Fixture desktop runtime check failed');
      if (!request.previewSession) return { ok: true };
      const response = await page.request.post(`${baseURL}/api/plugins/admission`, { headers: { 'X-My-Scholar-Plugin-Admission': 'fixture-admission-token' }, data: { pluginId: request.pluginId, previewSession: request.previewSession, checks: { processIsolation: true, sdkHandshake: true, runtimeStable: true, hostResponsive: true, capabilityBoundary: true, previewWriteIsolation: true } } });
      const result = await response.json(); assert(response.ok(), JSON.stringify(result)); return result;
    });
    const waitUntil = async (read, accepts, description) => {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) { const value = await read(); if (accepts(value)) return value; await new Promise((resolve) => setTimeout(resolve, 100)); }
      throw new Error(description);
    };
    const initialPlugins = await call('list_plugins');
    const initialVocabulary = initialPlugins.plugins.find((plugin) => plugin.id === 'guzi.vocabulary');
    if (!initialVocabulary.enabled) await call('set_plugin_enabled', { pluginId: initialVocabulary.id, enabled: true, grants: initialVocabulary.manifest.permissions });
    await page.goto(baseURL, { waitUntil: 'networkidle' });
    await page.locator('[data-view="market-view"]').click();
    const vocabularyCard = page.locator('#market-plugins [data-plugin-id="guzi.vocabulary"]');
    await vocabularyCard.waitFor();
    assert.equal(await page.locator('#market-view [id*="mcp"]').count(), 0, 'Plugin Market must not contain MCP controls');
    assert.equal(mcpRequests.length, 0, 'Opening Plugin Market must not load MCP settings');
    await vocabularyCard.locator('[data-market-action="toggle"]').click();
    await page.locator('[data-view="vocabulary-view"]').waitFor({ state: 'detached' });
    assert(await page.locator('#selection-add-vocabulary').isHidden());
    await vocabularyCard.locator('[data-market-action="toggle"]').click();
    await page.locator('#confirm-dialog[open]').waitFor();
    assert.match(await page.locator('#confirm-message').innerText(), /生词本|权限/u);
    await page.locator('#confirm-accept').click();
    await page.locator('[data-view="vocabulary-view"]').waitFor();

    const pluginId = `test.market-${Date.now()}`;
    const created = await call('create_plugin_draft', { id: pluginId, name: 'Market isolation fixture' });
    const manifest = { id: pluginId, name: 'Market isolation fixture', version: '1.0.0', sdkVersion: '1', entry: 'index.html', permissions: ['storage', 'reader.open'], contributes: { pages: [{ id: 'fixture', title: 'Fixture tool' }], selectionActions: [{ id: 'selection', title: 'Fixture selection' }] } };
    const main = `(() => {
      const sdk = GuziPlugin;
      document.querySelector('#isolation').textContent = (() => { try { return parent.document.body ? 'UNSAFE' : 'blocked'; } catch (_) { return 'blocked'; } })();
      sdk.onAction(({ context }) => { document.querySelector('#selection').textContent = context.snapshot.term; });
      sdk.ready().then(async () => {
        document.querySelector('#value').value = (await sdk.storage.get('value')) || '';
        document.querySelector('#status').textContent = 'ready';
        sdk.reportTest('parent DOM isolated', document.querySelector('#isolation').textContent === 'blocked');
      });
      document.querySelector('#save').onclick = async () => { await sdk.storage.set('value', document.querySelector('#value').value); document.querySelector('#status').textContent = 'saved'; };
      document.querySelector('#deny').onclick = async () => { try { await sdk.call('get_preferences'); document.querySelector('#status').textContent = 'UNSAFE'; } catch (_) { document.querySelector('#status').textContent = 'denied'; } };
      document.querySelector('#open-source').onclick = async () => { document.querySelector('#status').textContent = 'opening'; try { await sdk.ui.openSource(JSON.parse(document.querySelector('#source').value)); document.querySelector('#status').textContent = 'source-opened'; } catch (error) { document.querySelector('#status').textContent = 'source-error:' + error.message; } };
    })();`;
    const fixtureFiles = {
      'manifest.json': JSON.stringify(manifest),
      'index.html': '<!doctype html><html><head><meta charset="utf-8"></head><body><p id="status">loading</p><p id="isolation"></p><p id="selection"></p><input id="value"><button id="save">Save</button><button id="deny">Denied capability</button><textarea id="source"></textarea><button id="open-source">Open source</button><script src="capture.js"></script><script src="/plugin-sdk.js"></script><script src="main.js"></script></body></html>',
      'capture.js': 'window.addEventListener("message", (event) => { if (event.data?.type === "guzi-plugin-connect") window.fixturePort = event.ports[0]; });',
      'main.js': main,
    };
    for (const [path, content] of Object.entries(fixtureFiles)) await call('write_plugin_file', { draftId: created.draftId, path, content });
    await call('validate_plugin', { draftId: created.draftId });
    const userPreviewPluginId = `test.preview-page-${Date.now()}`;
    const userDraft = await call('create_plugin_draft', { id: userPreviewPluginId, name: 'Preview page fixture' });
    const userManifest = { ...manifest, id: userPreviewPluginId, name: 'Preview page fixture' };
    for (const [path, content] of Object.entries({ ...fixtureFiles, 'manifest.json': JSON.stringify(userManifest) })) await call('write_plugin_file', { draftId: userDraft.draftId, path, content });
    const previewView = page.locator('#plugin-preview-view');
    const previewInstall = page.locator('#market-preview-install');
    const previewStatus = page.locator('#market-preview-status');
    async function openUserPreview(draftId, action = 'preview') {
      await page.locator('[data-view="market-view"]').click();
      await page.locator(`#market-drafts [data-plugin-id="${draftId}"] [data-market-action="${action}"]`).click();
      await page.locator('#plugin-preview-view.active-view').waitFor();
      await page.locator('#confirm-dialog[open]').waitFor();
      await page.locator('#confirm-accept').click();
    }
    async function activeUserPreview(draftId) {
      const result = await waitUntil(() => call('list_plugins'), (result) => result.previews.some((record) => record.pluginId === draftId), 'User preview session was not created');
      await page.locator(`#market-preview iframe[data-plugin-id="${draftId}"]`).waitFor({ state: 'attached' });
      return result.previews.find((record) => record.pluginId === draftId);
    }
    async function assertPreviewRevoked(record) {
      await page.locator(`#market-preview iframe[data-plugin-id="${record.pluginId}"]`).waitFor({ state: 'detached' });
      await waitUntil(() => call('list_plugins'), (result) => !result.previews.some((item) => item.previewId === record.previewId), 'Leaving preview must revoke the server preview');
      assert.equal(await page.locator('#market-preview').evaluate((node) => node.childElementCount), 0, 'Leaving preview must remove runtime slots and failure status content');
      assert.equal(fs.existsSync(path.join(process.env.MY_SCHOLAR_TEST_DATA, 'plugins', 'previews', record.previewId)), false, 'Preview snapshot and temporary storage must be removed');
      const asset = await page.request.get(baseURL + record.url);
      assert([403, 404].includes(asset.status()), 'Closed user preview assets must be inaccessible');
      const invoke = await page.request.post(`${baseURL}/api/plugins/${record.pluginId}/invoke`, { data: { name: 'storage_get', arguments: { key: 'value' }, previewSession: record.previewId } });
      assert([400, 403].includes(invoke.status()), 'Closed user preview capability must be rejected');
      const refusal = await invoke.json();
      assert.match(refusal.error, invoke.status() === 400 ? /插件不存在或未启用/u : /插件运行会话已失效/u, 'Closed preview must fail because its plugin or session is no longer active');
    }
    await openUserPreview(userDraft.draftId);
    const noDesktopPreview = await activeUserPreview(userDraft.draftId);
    assert.equal(await previewView.evaluate((node) => node.classList.contains('view')), true, 'User preview must be an independent application view');
    assert(await page.locator('#market-view').isHidden());
    assert.equal(await page.locator('#market-preview-title').innerText(), userManifest.name);
    assert.match(await previewView.innerText(), /插件独立存储/u);
    assert.match(await previewView.innerText(), /定位阅读来源/u);
    assert.equal(await page.locator('#market-preview iframe').count(), 1, 'User preview page must contain one preview');
    await previewStatus.filter({ hasText: /桌面版|失败/u }).waitFor();
    assert(await previewInstall.isDisabled(), 'Browser without desktop admission must not install a draft');
    assert(!(await call('list_plugins')).plugins.some((record) => record.id === userPreviewPluginId), 'Preview must not install the draft');
    const directInstall = await page.request.post(`${baseURL}/api/plugins/call`, { data: { name: 'install_plugin', arguments: { draftId: userDraft.draftId, enabled: true, grants: userManifest.permissions } } });
    assert(!directInstall.ok(), 'Backend must reject enabled installation without admission');
    const userPreview = page.frameLocator(`#market-preview iframe[data-plugin-id="${userDraft.draftId}"]`);
    await userPreview.locator('#status').filter({ hasText: 'ready' }).waitFor();
    await userPreview.locator('#value').fill('temporary preview storage');
    await userPreview.locator('#save').click();
    await userPreview.locator('#status').filter({ hasText: 'saved' }).waitFor();
    assert(fs.existsSync(path.join(process.env.MY_SCHOLAR_TEST_DATA, 'plugins', 'previews', noDesktopPreview.previewId, 'storage.json')));
    await page.locator('#market-preview-back').click();
    await page.locator('#market-view.active-view').waitFor();
    await assertPreviewRevoked(noDesktopPreview);

    await openUserPreview(userDraft.draftId, 'install-draft');
    const installActionPreview = await activeUserPreview(userDraft.draftId);
    await userPreview.locator('#status').filter({ hasText: 'ready' }).waitFor();
    assert.equal(await page.locator('#market-preview .plugin-preview-runtime').count(), 1, 'Reopening preview must create only one runtime slot');
    assert.equal(await userPreview.locator('#value').inputValue(), '', 'A new preview must not reuse temporary storage');
    assert(!(await call('list_plugins')).plugins.some((record) => record.id === userPreviewPluginId), 'Draft card install must first open preview without installing');
    await page.locator('[data-view="library-view"]').click();
    await page.locator('#library-view.active-view').waitFor();
    await assertPreviewRevoked(installActionPreview);

    await page.evaluate(() => { window.myScholarDesktop = { pluginRuntimeCheck: (request) => window.fixtureRuntimeCheck(request) }; });
    fixtureCheckFailure = true;
    const failedPreviewResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/plugins/call' && response.request().postDataJSON()?.name === 'preview_plugin' && response.request().postDataJSON()?.arguments?.draftId === userDraft.draftId);
    await openUserPreview(userDraft.draftId);
    const failedPreview = (await (await failedPreviewResponse).json()).result;
    await previewStatus.filter({ hasText: /失败|Fixture desktop/u }).waitFor();
    assert(await previewInstall.isDisabled(), 'Failed desktop check must keep explicit install disabled');
    assert(!(await call('list_plugins')).plugins.some((record) => record.id === userPreviewPluginId));
    const failedInstall = await page.request.post(`${baseURL}/api/plugins/call`, { data: { name: 'install_plugin', arguments: { draftId: userDraft.draftId, enabled: true, grants: userManifest.permissions } } });
    assert(!failedInstall.ok(), 'Backend must reject enabled installation after a failed desktop check');
    await page.locator('#market-preview-back').click();
    await assertPreviewRevoked(failedPreview);
    fixtureCheckFailure = false;

    const installCallsBeforePassing = pluginCalls.filter((request) => request.name === 'install_plugin' && request.arguments?.draftId === userDraft.draftId).length;
    await openUserPreview(userDraft.draftId);
    const passedPreview = await activeUserPreview(userDraft.draftId);
    await previewStatus.filter({ hasText: /检查通过|验收通过/u }).waitFor();
    assert.equal(await page.locator('#market-preview .plugin-preview-runtime').count(), 1, 'Preview after a failed check must not retain failed runtime slots');
    await waitUntil(() => previewInstall.isEnabled(), Boolean, 'Admission passed must enable explicit install');
    assert.equal((await call('get_plugin_runtime_status', { pluginId: userDraft.draftId })).admission.status, 'passed');
    assert(!(await call('list_plugins')).plugins.some((record) => record.id === userPreviewPluginId), 'Passing admission alone must not install');
    assert.equal(pluginCalls.filter((request) => request.name === 'install_plugin' && request.arguments?.draftId === userDraft.draftId).length, installCallsBeforePassing, 'Preview must not submit an installation request');
    await previewInstall.click();
    await waitUntil(async () => (await page.locator('#confirm-dialog').isVisible()) || (await call('list_plugins')).plugins.some((record) => record.id === userPreviewPluginId), Boolean, 'Explicit install did not authorize or install');
    if (await page.locator('#confirm-dialog').isVisible()) await page.locator('#confirm-accept').click();
    const userInstalled = await waitUntil(() => call('list_plugins'), (result) => result.plugins.some((record) => record.id === userPreviewPluginId && record.enabled), 'Explicit installation must install and enable the checked draft');
    assert.deepEqual([...userInstalled.plugins.find((record) => record.id === userPreviewPluginId).grants].sort(), [...userManifest.permissions].sort());
    const explicitInstall = pluginCalls.filter((request) => request.name === 'install_plugin' && request.arguments?.draftId === userDraft.draftId).at(-1);
    assert.equal(explicitInstall.arguments.enabled, true);
    assert.deepEqual([...explicitInstall.arguments.grants].sort(), [...userManifest.permissions].sort());
    await assertPreviewRevoked(passedPreview);
    await call('uninstall_plugin', { pluginId: userPreviewPluginId });

    let releasePreview;
    const delayedPreviewRelease = new Promise((resolve) => { releasePreview = resolve; });
    let delayedRecord;
    const delayPreview = async (route) => {
      const request = route.request().postDataJSON();
      if (request.name !== 'preview_plugin' || request.arguments?.draftId !== userDraft.draftId) return route.continue();
      const response = await route.fetch();
      delayedRecord = (await response.json()).result;
      await delayedPreviewRelease;
      await route.fulfill({ response });
    };
    await page.route('**/api/plugins/call', delayPreview);
    try {
      await openUserPreview(userDraft.draftId);
      assert.match(await previewStatus.innerText(), /准备|检查/u);
      assert(await previewInstall.isDisabled(), 'Install must remain disabled while preview creation is pending');
      await waitUntil(async () => delayedRecord, Boolean, 'Delayed preview response was not intercepted');
      await page.locator('#market-preview-back').click();
      await page.locator('#market-view.active-view').waitFor();
      releasePreview();
      await assertPreviewRevoked(delayedRecord);
      assert(await previewView.isHidden(), 'Late preview response must not reopen a page the user left');
      assert.equal(await page.locator('#market-preview iframe').count(), 0, 'Late preview response must not resurrect its iframe');
    } finally {
      releasePreview();
      await page.unroute('**/api/plugins/call', delayPreview);
    }
    await page.evaluate(() => { delete window.myScholarDesktop; });
    await page.locator('[data-view="library-view"]').click();
    const preview = await call('preview_plugin', { draftId: created.draftId, grants: ['storage'] });
    const previewLocator = page.frameLocator(`#plugin-background-previews iframe[data-plugin-id="${created.draftId}"]`);
    assert(await page.locator('#plugin-background-previews').isHidden(), 'MCP previews must use the hidden background preview root');
    assert.equal(await page.locator('#market-preview iframe').count(), 0, 'MCP preview must not mount inside the user preview page');
    await waitUntil(() => call('get_plugin_runtime_status', { pluginId: created.draftId }), (result) => result.status === 'ready' && result.lastTest?.details?.passed === true, 'MCP preview did not run through the real SDK');
    assert(await page.locator('#library-view').isVisible(), 'MCP preview must preserve current reading surface');
    assert.equal(await previewLocator.locator('#isolation').textContent(), 'blocked');
    assert.equal(await page.locator(`iframe[data-plugin-id="${created.draftId}"]`).getAttribute('sandbox'), 'allow-scripts');
    const previewState = await call('get_plugin_runtime_status', { pluginId: created.draftId });
    assert.equal(previewState.admission.status, 'required', 'SDK self-reported tests cannot admit a plugin');
    const previewFrame = page.frames().find((frame) => frame.url().includes(preview.previewId));
    const deniedPreview = await previewFrame.evaluate(async () => {
      const failures = [];
      for (const [name, args] of [['report_plugin_runtime_event', { level: 'ready' }], ['complete_plugin_admission', { checks: {} }], ['open_source', { source: {} }], ['translate_text', { text: 'test' }], ['toast', { message: 'preview-global-leak' }], ['confirm', { message: 'preview-global-leak' }], ['save_notes', { notes: 'preview-global-leak' }]]) {
        try { await globalThis.GuziPlugin.call(name, args); } catch (_) { failures.push(name); }
      }
      globalThis.fixturePort.postMessage({ type: 'log', level: 'ready', message: 'pretend admission passed', details: { admission: { status: 'passed' } } });
      return failures;
    });
    assert.equal(deniedPreview.length, 7);
    assert.equal((await call('get_plugin_runtime_status', { pluginId: created.draftId })).admission.status, 'required');
    assert(await page.locator('#confirm-dialog').isHidden());
    assert(!((await page.locator('#toast').textContent()) || '').includes('preview-global-leak'));
    assert(await page.locator('#library-view').isVisible(), 'Denied preview operations must preserve the reader surface');
    const selfReport = await page.request.post(`${baseURL}/api/plugins/call`, { data: { name: 'report_plugin_runtime_event', arguments: { pluginId: created.draftId, level: 'ready', message: 'bypass' } } });
    assert(!selfReport.ok(), 'Public registry tools cannot report privileged runtime events');
    const firstPreviewFrame = await page.locator(`iframe[data-plugin-id="${created.draftId}"]`).elementHandle();
    const nextPreview = await call('preview_plugin', { draftId: created.draftId, grants: ['storage'] });
    assert.notEqual(preview.previewId, nextPreview.previewId);
    await waitUntil(() => firstPreviewFrame.evaluate((node) => node.isConnected), (connected) => !connected, 'Old preview iframe remained mounted');
    const staleAsset = await page.request.get(baseURL + preview.url);
    assert([403, 404].includes(staleAsset.status()), 'Revoked preview assets must be inaccessible');
    const staleInvoke = await page.request.post(`${baseURL}/api/plugins/${created.draftId}/invoke`, { data: { name: 'storage_get', arguments: { key: 'value' }, previewSession: preview.previewId } });
    assert.equal(staleInvoke.status(), 403);
    await call('stop_plugin_preview', { pluginId: created.draftId, previewId: nextPreview.previewId });
    await page.locator(`iframe[data-plugin-id="${created.draftId}"]`).waitFor({ state: 'detached' });

    await call('install_plugin', { draftId: created.draftId, enabled: false, grants: [] });
    manifest.version = '1.0.1';
    await call('write_plugin_file', { draftId: created.draftId, path: 'manifest.json', content: JSON.stringify(manifest) });
    await call('install_plugin', { draftId: created.draftId, enabled: false, grants: [] });
    await page.locator('[data-view="market-view"]').click();
    const pluginCard = page.locator(`#market-plugins [data-plugin-id="${pluginId}"]`);
    await pluginCard.waitFor();
    const dimensions = await pluginCard.locator('.market-card-actions button').evaluateAll((buttons) => buttons.map((button) => ({ height: button.getBoundingClientRect().height, width: button.getBoundingClientRect().width, font: getComputedStyle(button).fontSize, padding: getComputedStyle(button).padding })));
    assert.equal(dimensions.length, 3);
    assert(dimensions.every((size) => size.height === dimensions[0].height && size.width === dimensions[0].width && size.font === dimensions[0].font && size.padding === dimensions[0].padding), 'Enable/rollback/uninstall buttons must share dimensions and typography');
    await pluginCard.screenshot({ path: require('node:path').join(require('node:os').tmpdir(), 'guzi-market-card-buttons.png') });
    assert.equal(await page.locator(`[data-plugin-nav="${pluginId}"]`).count(), 0);
    await pluginCard.locator('[data-market-action="toggle"]').click();
    await page.locator('#confirm-dialog[open]').waitFor();
    await page.locator('#confirm-accept').click();
    await page.locator('#market-status').filter({ hasText: '桌面版' }).waitFor();
    assert.equal(await pluginCard.locator('.market-badge').innerText(), '检查失败');
    assert.equal(await page.locator(`[data-plugin-nav="${pluginId}"]`).count(), 0, 'Browser preview cannot bypass desktop admission');
    await page.evaluate(() => { window.myScholarDesktop = { pluginRuntimeCheck: (request) => window.fixtureRuntimeCheck(request) }; });
    await pluginCard.locator('[data-market-action="toggle"]').click();
    await page.locator('#confirm-dialog[open]').waitFor();
    await page.locator('#confirm-accept').click();
    await page.locator(`[data-plugin-nav="${pluginId}"]`).click();
    const plugin = page.frameLocator(`iframe[data-plugin-id="${pluginId}"]`);
    await plugin.locator('#status').filter({ hasText: 'ready' }).waitFor();
    await plugin.locator('#value').fill('preserved across disable');
    await plugin.locator('#save').click();
    await plugin.locator('#status').filter({ hasText: 'saved' }).waitFor();
    await plugin.locator('#deny').click();
    await plugin.locator('#status').filter({ hasText: 'denied' }).waitFor();
    const fixtureJobs = (await (await page.request.get(baseURL + '/api/jobs')).json()).jobs;
    const sourceJob = fixtureJobs.find((job) => job.status === 'completed');
    async function openFixtureSource(source) {
      await page.locator(`[data-plugin-nav="${pluginId}"]`).click();
      await plugin.locator('#source').fill(JSON.stringify(source));
      await plugin.locator('#open-source').click();
      return waitUntil(() => plugin.locator('#status').textContent(), (value) => value !== 'opening', 'Plugin source call did not finish');
    }
    assert.equal(await openFixtureSource({ job_id: sourceJob.job_id, kind: 'metadata' }), 'source-opened');
    await page.locator('#reader-view.active-view:not(.is-document-loading)').waitFor();
    assert(!((await page.locator('#toast').textContent()) || '').includes('未找到可确认的原文位置'), 'Document references must open without demanding an exact selection');
    const reader = page.frameLocator('#html-preview');
    const anchor = await reader.locator('.reader-content p[data-block-id]').first().evaluate((node) => {
      const copy = node.cloneNode(true);
      copy.querySelectorAll('button,.paragraph-translate-trigger,.my-scholar-translation').forEach((child) => child.remove());
      const text = copy.textContent.trim();
      const word = text.match(/[A-Za-z]{5,}/u)[0];
      const start = text.indexOf(word);
      return { block_id: node.dataset.blockId, page: node.dataset.page || node.closest('[data-page]')?.dataset.page, selected_text: word, start, end: start + word.length, quote_prefix: text.slice(Math.max(0, start - 48), start), quote_suffix: text.slice(start + word.length, start + word.length + 48) };
    });
    const blockSource = { job_id: sourceJob.job_id, block_id: anchor.block_id, page: anchor.page, render_generation: 'base' };
    assert.equal(await openFixtureSource(blockSource), 'source-opened');
    assert(await reader.locator(`[data-block-id="${anchor.block_id}"]`).evaluate((node) => { const rect = node.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= node.ownerDocument.defaultView.innerHeight; }), 'Block references must scroll the verified source block into view');
    const wrongGeneration = await openFixtureSource({ ...blockSource, render_generation: 'stale-generation' });
    assert.match(wrongGeneration, /source-error:.*另一版正文/u);
    const exactSource = { ...blockSource, ...anchor };
    assert.equal(await openFixtureSource(exactSource), 'source-opened');
    assert.equal(await reader.locator('body').evaluate((node) => node.ownerDocument.getSelection().toString()), anchor.selected_text);
    await openFixtureSource({ ...exactSource, quote_prefix: 'mismatched-prefix' });
    await page.locator('#toast').filter({ hasText: '未找到可确认的原文位置' }).waitFor();
    assert(!((await page.locator('#toast').textContent()) || '').includes('生词本'), 'Shared source messages must describe plugins and sources');
    assert.equal(await reader.locator('body').evaluate((node) => node.ownerDocument.getSelection().toString()), anchor.selected_text, 'An invalid exact reference must preserve the previously verified selection');
    await page.locator('[data-panel="notes-panel"]').click();
    await page.waitForFunction(() => document.querySelector('#notes-editor').contentEditable === 'true');
    await page.locator('#notes-editor').fill('Preview navigation must preserve fixture notes.');
    const notesSaved = page.waitForResponse((response) => response.url() === `${baseURL}/api/jobs/${sourceJob.job_id}/notes` && response.request().method() === 'PUT');
    await page.locator('#save-notes-button').click();
    assert.equal((await notesSaved).status(), 200);
    const notesBeforePreview = await page.locator('#notes-editor').innerText();
    assert.equal(await openFixtureSource(exactSource), 'source-opened');
    const readerNodeBeforePreview = await page.locator('#html-preview').elementHandle();
    await reader.locator('body').evaluate((node) => { node.dataset.previewKeepalive = 'retained'; });
    const readerSourceBeforePreview = await page.locator('#html-preview').getAttribute('src');
    const readerSelectionBeforePreview = await reader.locator('body').evaluate((node) => node.ownerDocument.getSelection().toString());
    assert.equal(readerSelectionBeforePreview, anchor.selected_text, 'Preview preservation must start with a verified nonempty article selection');
    const readerPreview = await call('preview_plugin', { pluginId, grants: manifest.permissions });
    const readerPreviewId = readerPreview.pluginId || readerPreview.id;
    await waitUntil(() => call('get_plugin_runtime_status', { pluginId: readerPreviewId }), (state) => state.status === 'ready' && state.admission?.status === 'passed', 'Installed plugin preview admission did not complete');
    const readerPreviewFrame = page.frames().find((frame) => frame.url().includes(readerPreview.previewId));
    await readerPreviewFrame.evaluate(async () => {
      for (const name of ['open_source', 'toast', 'confirm']) {
        try { await globalThis.GuziPlugin.call(name, { source: {}, message: 'preview-reader-leak' }); throw new Error('Unexpected preview grant'); }
        catch (error) { if (error.message === 'Unexpected preview grant') throw error; }
      }
    });
    assert(await page.locator('#reader-view').isVisible(), 'Preview must preserve active reader view');
    assert.equal(await page.locator('#html-preview').getAttribute('src'), readerSourceBeforePreview);
    assert.equal(await reader.locator('body').evaluate((node) => node.ownerDocument.getSelection().toString()), readerSelectionBeforePreview, 'Preview must preserve reader selection');
    await openUserPreview(created.draftId);
    const readingUserPreview = await activeUserPreview(created.draftId);
    await previewStatus.filter({ hasText: /检查通过|验收通过/u }).waitFor();
    assert.equal(await page.locator('#market-preview iframe').count(), 1);
    assert.equal(await page.locator(`#plugin-background-previews iframe[data-plugin-id="${readerPreviewId}"]`).count(), 1, 'User preview must preserve the separate MCP background preview');
    assert.equal(await readerNodeBeforePreview.evaluate((node) => node.isConnected), true, 'User preview navigation must keep the reader iframe mounted');
    await page.locator('#market-preview-back').click();
    await page.locator('#market-view.active-view').waitFor();
    await assertPreviewRevoked(readingUserPreview);
    assert((await call('list_plugins')).previews.some((record) => record.previewId === readerPreview.previewId), 'Leaving user preview must not revoke MCP background previews');
    await page.locator(`#document-tabs .document-tab[data-job-id="${sourceJob.job_id}"]`).click();
    await page.locator('#reader-view.active-view:not(.is-document-loading)').waitFor();
    assert.equal(await readerNodeBeforePreview.evaluate((node) => node === node.ownerDocument.querySelector('#html-preview')), true, 'Returning to the article must reuse its original iframe');
    assert.equal(await page.locator('#html-preview').getAttribute('src'), readerSourceBeforePreview);
    assert.equal(await reader.locator('body').getAttribute('data-preview-keepalive'), 'retained', 'Returning from preview must preserve the original reader document');
    assert.equal(await reader.locator('body').evaluate((node) => node.ownerDocument.getSelection().toString()), readerSelectionBeforePreview, 'User preview navigation must preserve the verified article selection');
    assert.equal(await page.locator('#notes-editor').innerText(), notesBeforePreview, 'User preview navigation must preserve article notes');
    await call('stop_plugin_preview', { pluginId: readerPreviewId, previewId: readerPreview.previewId });
    await page.locator(`iframe[data-plugin-id="${readerPreviewId}"]`).waitFor({ state: 'detached' });
    await page.locator(`[data-plugin-nav="${pluginId}"]`).click();
    const priorFrame = await page.locator(`iframe[data-plugin-id="${pluginId}"]`).elementHandle();
    await call('set_plugin_enabled', { pluginId, enabled: false });
    await page.locator(`[data-plugin-nav="${pluginId}"]`).waitFor({ state: 'detached' });
    assert.equal(await priorFrame.evaluate((node) => node.isConnected), false);
    const disabledCall = await page.request.post(`${baseURL}/api/plugins/${pluginId}/invoke`, { data: { name: 'storage_set', arguments: { key: 'value', value: 'stale' } } });
    assert([400, 403].includes(disabledCall.status()), 'Disabled plugin invocation must be rejected');
    await call('set_plugin_enabled', { pluginId, enabled: true, grants: manifest.permissions });
    await page.locator(`[data-plugin-nav="${pluginId}"]`).click();
    await plugin.locator('#status').filter({ hasText: 'ready' }).waitFor();
    assert.equal(await plugin.locator('#value').inputValue(), 'preserved across disable');
    await call('uninstall_plugin', { pluginId });
    await page.locator(`[data-plugin-nav="${pluginId}"]`).waitFor({ state: 'detached' });

    await page.locator('[data-view="market-view"]').click();
    assert.equal(mcpRequests.length, 0, 'Plugin operations must not load MCP settings');
    await page.locator('[data-view="settings-view"]').click();
    await page.locator('#settings-view.active-view').waitFor();
    assert(await page.locator('#settings-mcp').isHidden(), 'MCP controls must wait for their settings category');
    assert.equal(mcpRequests.length, 0, 'Opening general settings must not load MCP settings');
    await page.locator('.settings-navigation a[href="#settings-mcp"]').click();
    await page.locator('#settings-mcp-scopes input').first().waitFor();
    assert(await page.locator('#settings-mcp').isVisible());
    assert.equal(await page.locator('#settings-mcp form').count(), 0, 'MCP settings must not nest a form inside the settings form');
    assert.equal(await page.locator('#settings-mcp-save').getAttribute('type'), 'button', 'MCP save must not submit general settings');
    const generalSaveState = await page.locator('#settings-save-status').getAttribute('data-state');
    const generalWritesBeforeMcp = settingsWrites.length;
    const initialMcpStatus = await (await page.request.get(baseURL + '/api/mcp/status')).json();
    const scope = page.locator('#settings-mcp-scopes input').first();
    await scope.setChecked(!(await scope.isChecked()));
    const selectedScopes = await page.locator('#settings-mcp-scopes input:checked').evaluateAll((inputs) => inputs.map((input) => input.value));
    await page.locator('#settings-mcp-enabled').check();
    await page.locator('#settings-mcp-save').click();
    await page.locator('#settings-mcp-status').filter({ hasText: 'MCP 已启用' }).waitFor();
    const mcpStatus = await (await page.request.get(baseURL + '/api/mcp/status')).json();
    assert.equal(mcpStatus.enabled, true);
    assert.deepEqual([...mcpStatus.scopes].sort(), [...selectedScopes].sort(), 'MCP permissions must persist independently');
    assert.match(await page.locator('#settings-mcp-connection').innerText(), /连接凭据文件/u);
    assert.equal(await page.locator('#settings-save-status').getAttribute('data-state'), generalSaveState, 'MCP edits must not dirty general settings');
    const requestsBeforeMarket = mcpRequests.length;
    await page.locator('[data-view="market-view"]').click();
    await page.locator('#market-view.active-view').waitFor();
    await vocabularyCard.waitFor();
    assert.equal(mcpRequests.length, requestsBeforeMarket, 'Returning to Plugin Market must not reload MCP settings');
    await page.locator('[data-view="settings-view"]').click();
    await page.locator('.settings-navigation a[href="#settings-mcp"]').click();
    await page.locator('#settings-mcp-status').filter({ hasText: 'MCP 已启用' }).waitFor();
    assert(await page.locator('#settings-mcp-enabled').isChecked(), 'MCP enabled state must survive navigation');
    assert.deepEqual(await page.locator('#settings-mcp-scopes input:checked').evaluateAll((inputs) => inputs.map((input) => input.value).sort()), [...selectedScopes].sort());
    const rotateRequestsBefore = mcpRequests.filter((request) => new URL(request.url()).pathname === '/api/mcp/rotate').length;
    await page.locator('#settings-mcp-rotate').click();
    await page.locator('#confirm-dialog[open]').waitFor();
    await page.locator('#confirm-cancel').click();
    await page.locator('#confirm-dialog').waitFor({ state: 'hidden' });
    assert.equal(mcpRequests.filter((request) => new URL(request.url()).pathname === '/api/mcp/rotate').length, rotateRequestsBefore, 'Cancelling credential rotation must not rotate credentials');
    assert(await page.locator('#settings-mcp-enabled').isChecked());
    const statusAfterCancel = await (await page.request.get(baseURL + '/api/mcp/status')).json();
    assert.deepEqual(statusAfterCancel, mcpStatus, 'Cancelling credential rotation must preserve MCP state');
    for (const input of await page.locator('#settings-mcp-scopes input').all()) {
      await input.setChecked(initialMcpStatus.scopes.includes(await input.inputValue()));
    }
    await page.locator('#settings-mcp-enabled').uncheck();
    await page.locator('#settings-mcp-save').click();
    await page.locator('#settings-mcp-status').filter({ hasText: 'MCP 已关闭' }).waitFor();
    assert.equal((await (await page.request.get(baseURL + '/api/mcp/status')).json()).enabled, false);
    await page.locator('[data-view="market-view"]').click();
    await page.locator('#market-view.active-view').waitFor();
    assert.equal(settingsWrites.length, generalWritesBeforeMcp, 'MCP changes must not submit or autosave general settings');
    assert.deepEqual(errors, []);
    console.log('Plugin Market smoke passed: standalone preview admission/explicit install/navigation cleanup, SDK isolation, MCP live previews/session revocation, permissions, document/block/exact source navigation, enable/disable/data retention, uninstall and MCP settings.');
  } catch (error) {
    if (page) console.error('Preview diagnostic:', await page.locator('#market-preview-status').textContent().catch(() => ''));
    if (page) console.error('Market diagnostic:', await page.locator('#market-status').textContent().catch(() => ''), await page.locator('#toast').textContent().catch(() => ''));
    throw error;
  } finally { await session.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
