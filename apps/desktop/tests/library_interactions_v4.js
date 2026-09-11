/*
 * Literature-library interaction contract (v4).
 *
 * This is intentionally a browser-level regression test.  Run it against a
 * server backed by a disposable MY_SCHOLAR_DATA_DIR, for example:
 *
 *   node tests/library_interactions_v4.js http://127.0.0.1:8770
 *
 * The test only creates temporary folders/properties and restores every
 * touched item/display record in the finally block.  It does not upload or
 * delete a source PDF.
 */
const { launchManagedChromium } = require('./playwright.cjs');

const baseURL = process.argv[2] || 'http://127.0.0.1:8766';
const viewport = { width: 1600, height: 980 };

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

async function visibleLocator(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count() && await locator.isVisible().catch(() => false)) return locator;
  }
  return null;
}

async function waitForLibrary(page) {
  await page.locator('#library-view.active-view').waitFor();
  await page.locator('#recent-list .library-row').first().waitFor();
}

(async () => {
  let browser;
  let browserSession;
  const createdFolders = [];
  const createdProperties = [];
  const originalItems = new Map();
  let originalDisplay = null;
  let expectingColumnResizeFailure = false;
  const errors = [];
  const libraryItemPatchBodies = [];
  const originalColumnsPayload = () => (originalDisplay?.columns || []).map((column) => Object.prototype.hasOwnProperty.call(column, 'width') ? clone(column) : { ...clone(column), width: null });

  try {
    browserSession = await launchManagedChromium();
    browser = browserSession.browser;
    const page = await browser.newPage({ viewport });
    page.setDefaultTimeout(15000);
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error' && !(expectingColumnResizeFailure && message.text().includes('500'))) errors.push(`console: ${message.text()}`);
    });
    page.on('request', (request) => {
      if (request.method() !== 'PATCH' || !/\/api\/library\/items\//u.test(request.url())) return;
      try { libraryItemPatchBodies.push(JSON.parse(request.postData() || '{}')); } catch (_) { libraryItemPatchBodies.push({ malformed: true }); }
    });

    const api = async (url, options) => page.evaluate(async ({ url: requestURL, options: requestOptions }) => {
      const response = await fetch(requestURL, requestOptions);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `${response.status} ${requestURL}`);
      return payload;
    }, { url, options });
    const json = (body, method = 'POST') => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const row = (jobId) => page.locator(`#recent-list .library-row[data-job-id="${String(jobId).replace(/"/g, '\\"')}"]`).first();
    const rowBody = (jobId) => row(jobId).locator('.library-row-name, [data-row-content], .library-row-title').first();
    const selectedRows = () => page.locator('#recent-list .library-row.is-selected, #recent-list .library-row[aria-selected="true"], #recent-list .library-row[data-selected="true"]');
    const menuLocator = () => page.locator('#recent-list [data-row-more-menu]:visible, #recent-list [role="menu"]:visible').last();
    const libraryEditor = page.locator('#library-editor-dialog');

    await page.goto(baseURL, { waitUntil: 'networkidle' });
    await waitForLibrary(page);
    const libraryPayload = await api('/api/library');
    originalDisplay = clone(libraryPayload.library?.display || {});
    const allRows = page.locator('#recent-list .library-row');
    const rowIds = await allRows.evaluateAll((nodes) => nodes.map((node) => node.dataset.jobId).filter(Boolean));
    if (rowIds.length < 2) throw new Error('v4 UI 回归至少需要两篇可见文献。');
    const firstId = rowIds[0];
    const secondId = rowIds[1];
    const lastId = rowIds[rowIds.length - 1];
    for (const id of new Set([firstId, secondId, lastId])) {
      originalItems.set(id, clone(libraryPayload.library?.items?.[id] || {}));
    }

    // 1. A single click selects only; a quick double click opens the reader.
    // Opening still advances the reading status, but opening, scrolling and
    // closing must leave the retired numeric progress record untouched.
    await api(`/api/library/items/${firstId}`, json({ values: { reading_status: '未开始' } }, 'PATCH'));
    await page.reload({ waitUntil: 'networkidle' });
    await waitForLibrary(page);
    const firstRow = row(firstId);
    const progressBefore = clone((await api('/api/library')).library?.items?.[firstId]?.progress);
    libraryItemPatchBodies.length = 0;
    await rowBody(firstId).click();
    await page.waitForFunction((id) => {
      const node = document.querySelector(`#recent-list .library-row[data-job-id="${CSS.escape(id)}"]`);
      return Boolean(node?.classList.contains('is-selected') || node?.getAttribute('aria-selected') === 'true' || node?.dataset.selected === 'true');
    }, firstId);
    if (await page.locator('#reader-view.active-view').count()) throw new Error('单击文献行直接打开了阅读器；应先进入选中状态。');
    const rowMeta = await firstRow.locator('.library-row-name small').textContent();
    if (String(rowMeta || '').includes('%')) throw new Error(`文献行仍展示数值阅读进度（${rowMeta}）`);
    if ((await page.locator('#library-details').textContent()).includes('阅读进度')) throw new Error('文献详情仍展示阅读进度字段。');
    if (await page.locator('#library-details .copyable-data').count() < 2 || await page.locator('#library-details .copyable-data').first().evaluate((node) => getComputedStyle(node).userSelect) !== 'text') throw new Error('文献详情数据字段不可选择复制。');
    const venueButtonForSelection = page.locator('#library-details [data-details-edit="venue"]').first();
    const venueValueForSelection = venueButtonForSelection.locator('xpath=preceding-sibling::span[1]');
    const venueSelection = await venueValueForSelection.evaluate((node) => {
      const text = node.ownerDocument.createTreeWalker(node, NodeFilter.SHOW_TEXT).nextNode();
      if (!text || text.nodeValue.length < 2) throw new Error('Nested venue selection fixture is unavailable');
      const startRange = node.ownerDocument.createRange();
      startRange.setStart(text, 0);
      startRange.setEnd(text, 1);
      const endOffset = Math.min(text.nodeValue.length, 6);
      const endRange = node.ownerDocument.createRange();
      endRange.setStart(text, endOffset - 1);
      endRange.setEnd(text, endOffset);
      const start = startRange.getBoundingClientRect();
      const end = endRange.getBoundingClientRect();
      return { expected: text.nodeValue.slice(0, endOffset), start: { x: start.left + 1, y: start.top + start.height / 2 }, end: { x: end.right - 1, y: end.top + end.height / 2 } };
    });
    await page.mouse.move(venueSelection.start.x, venueSelection.start.y);
    await page.mouse.down();
    await page.mouse.move(venueSelection.end.x, venueSelection.end.y, { steps: 6 });
    await page.mouse.up();
    const selectedVenueText = await page.evaluate(() => document.getSelection()?.toString() || '');
    if (!selectedVenueText || !venueSelection.expected.includes(selectedVenueText.trim())) throw new Error(`Nested venue text could not be selected with the pointer (${JSON.stringify(selectedVenueText)})`);
    if (await venueValueForSelection.evaluate((node) => getComputedStyle(node).userSelect) !== 'text') throw new Error('Nested details value still inherits user-select:none');
    if (await venueButtonForSelection.evaluate((node) => getComputedStyle(node).userSelect) !== 'none') throw new Error('Details controls became selectable while opening the information surface');
    const oldVenueNode = await venueValueForSelection.elementHandle();
    const sameStatus = page.locator('#library-details [data-details-status-select]').first();
    const sameKeyRefresh = page.waitForResponse((response) => response.request().method() === 'PATCH' && response.url().endsWith(`/api/library/items/${firstId}`));
    // Re-committing the value already shown still refreshes the same paper.
    await sameStatus.evaluate((select) => select.dispatchEvent(new Event('change', { bubbles: true })));
    await sameKeyRefresh;
    if (!await oldVenueNode.evaluate((node) => node.isConnected)) throw new Error('Same-paper details refresh destroyed an active selection');
    if ((await page.evaluate(() => document.getSelection()?.toString() || '')) !== selectedVenueText) throw new Error('Same-paper details refresh changed the active selection');
    await page.evaluate(() => document.getSelection()?.removeAllRanges());
    await page.waitForFunction((node) => !node.isConnected, oldVenueNode);
    await page.setViewportSize({ width: 900, height: 900 });
    await page.locator('body.details-open #library-details:not([aria-hidden="true"])').waitFor();
    const detailsClose = page.locator('#library-details [data-details-close]');
    await detailsClose.waitFor({ state: 'visible' });
    await detailsClose.click();
    if (await page.locator('body').evaluate((body) => body.classList.contains('details-open')) || await page.locator('#library-details').getAttribute('aria-hidden') !== 'true' || !await page.locator('#library-details').evaluate((panel) => panel.inert)) throw new Error('详情底部面板关闭后仍可交互或暴露给辅助技术。');
    await page.setViewportSize(viewport);
    await rowBody(firstId).dblclick();
    await page.locator('#reader-view.active-view').waitFor();
    await page.waitForFunction(async (id) => {
      const response = await fetch('/api/library');
      const payload = await response.json();
      return payload.library?.items?.[id]?.values?.reading_status === '阅读中';
    }, firstId);
    const readerFrame = page.frameLocator('#html-preview');
    await readerFrame.locator('body').waitFor();
    await readerFrame.locator('body').evaluate(() => window.scrollTo(0, 240));
    await page.waitForTimeout(700);
    await page.locator('[data-view="library-view"]').click();
    await waitForLibrary(page);
    await page.waitForTimeout(600);
    const progressAfter = clone((await api('/api/library')).library?.items?.[firstId]?.progress);
    if (JSON.stringify(progressAfter) !== JSON.stringify(progressBefore)) throw new Error(`打开、滚动或关闭阅读器修改了已退役的阅读进度（${JSON.stringify({ progressBefore, progressAfter })}）`);
    const progressPatches = libraryItemPatchBodies.filter((body) => Object.prototype.hasOwnProperty.call(body, 'progress'));
    if (progressPatches.length) throw new Error(`打开、滚动或关闭阅读器仍发送 progress PATCH（${JSON.stringify(progressPatches)}）`);

    // 2. The last row's context menu must stay next to that row and inside the
    // viewport. This catches the old “always near the first row” positioning.
    const lastRow = row(lastId);
    await lastRow.scrollIntoViewIfNeeded();
    const lastBox = await lastRow.boundingBox();
    if (!lastBox) throw new Error('无法测量最后一条文献行。');
    const clickX = Math.min(viewport.width - 12, Math.max(12, lastBox.x + lastBox.width - 28));
    const clickY = Math.min(viewport.height - 12, Math.max(12, lastBox.y + lastBox.height / 2));
    await page.mouse.click(clickX, clickY, { button: 'right' });
    const lastMenu = menuLocator();
    await lastMenu.waitFor({ state: 'visible' });
    await page.waitForFunction((jobId) => {
      const menu = document.querySelector(`.library-row[data-job-id="${jobId}"] [data-row-more-menu]`);
      return Boolean(menu?.style.left && menu?.style.top);
    }, lastId);
    const menuPosition = await lastMenu.evaluate((node) => getComputedStyle(node).position);
    if (menuPosition !== 'fixed') throw new Error(`最后一行右键菜单没有脱离列表裁剪层（position=${menuPosition}）`);
    const menuBox = await lastMenu.boundingBox();
    if (!menuBox) throw new Error('最后一行右键菜单没有可测量的位置。');
    const rowRect = { left: lastBox.x, right: lastBox.x + lastBox.width, top: lastBox.y, bottom: lastBox.y + lastBox.height };
    const menuRect = { left: menuBox.x, right: menuBox.x + menuBox.width, top: menuBox.y, bottom: menuBox.y + menuBox.height };
    const horizontalNear = menuRect.left <= rowRect.right + 24 && menuRect.right >= rowRect.left - 24;
    const verticalNear = menuRect.top <= rowRect.bottom + 24 && menuRect.bottom >= rowRect.top - 24;
    if (!horizontalNear || !verticalNear || menuRect.top < 0 || menuRect.bottom > viewport.height + 1) {
      throw new Error(`最后一行右键菜单偏移或越界（row=${JSON.stringify(rowRect)}, menu=${JSON.stringify(menuRect)}）`);
    }
    await page.mouse.click(10, 10);
    await lastMenu.waitFor({ state: 'hidden' }).catch(() => {});

    // 3. Per-item editing lives in the details panel. Its editor still closes
    // from the backdrop without requiring a dedicated Cancel click.
    await rowBody(firstId).click();
    const venueButton = page.locator('#library-details [data-details-edit="venue"]').first();
    await venueButton.click();
    await libraryEditor.waitFor({ state: 'visible' });
    const editorBox = await libraryEditor.boundingBox();
    if (!editorBox) throw new Error('来源编辑器没有可测量的弹窗位置。');
    await page.mouse.click(Math.max(4, editorBox.x - 8), Math.max(4, editorBox.y - 8));
    await libraryEditor.waitFor({ state: 'hidden' });

    // 4. New text fields are placeholders, not pre-filled values.
    await page.locator('#create-folder-button').click();
    await libraryEditor.waitFor({ state: 'visible' });
    const folderInput = page.locator('#editor-folder-name');
    if (!(await folderInput.count())) throw new Error('新建文件夹缺少名称输入框。');
    const folderInputValue = await folderInput.inputValue();
    const folderPlaceholder = await folderInput.getAttribute('placeholder');
    if (folderInputValue !== '' || !String(folderPlaceholder || '').trim()) throw new Error(`新建文件夹仍使用默认填充值（value=${JSON.stringify(folderInputValue)}, placeholder=${JSON.stringify(folderPlaceholder)}）`);
    await page.locator('#library-editor-cancel').click();
    await libraryEditor.waitFor({ state: 'hidden' });

    const initialResizerValues = await page.locator('#library-columns [data-column-resizer]').evaluateAll((handles) => handles.map((handle) => handle.getAttribute('aria-valuenow')));
    if (!initialResizerValues.length || initialResizerValues.some((value) => value === null || value.trim() === '' || !Number.isFinite(Number(value)))) throw new Error(`表头列宽控制柄缺少有效 aria-valuenow（${JSON.stringify(initialResizerValues)}）`);
    await page.locator('#columns-button').click();
    await libraryEditor.waitFor({ state: 'visible' });
    if (await libraryEditor.locator('[data-column-width], .column-width-field').count()) throw new Error('列设置仍提供重复的数字列宽输入；列宽应只在文献库表头拖拽调整。');
    const newColumnInput = page.locator('#editor-new-column-label');
    if (await newColumnInput.count()) {
      const value = await newColumnInput.inputValue();
      const placeholder = await newColumnInput.getAttribute('placeholder');
      if (value !== '' || !String(placeholder || '').trim()) throw new Error(`列设置的新列输入仍使用默认填充值（value=${JSON.stringify(value)}, placeholder=${JSON.stringify(placeholder)}）`);
    }
    await page.locator('#library-editor-cancel').click();
    await libraryEditor.waitFor({ state: 'hidden' });

    // 5. Reading status uses an accessible radio group in the details panel
    // and persists the selected value.
    await waitForLibrary(page);
    await rowBody(firstId).click();
    const statusSelect = page.locator('#library-details [data-details-status-select]').first();
    if (!(await statusSelect.count())) throw new Error('阅读状态没有使用可访问的下拉选择。');
    await statusSelect.waitFor({ state: 'visible' });
    if (await statusSelect.getAttribute('aria-label') !== '阅读状态') throw new Error('阅读状态下拉缺少可访问名称。');
    if (await statusSelect.locator('option').count() < 4) throw new Error('阅读状态下拉没有“未开始/计划中/阅读中/已完成”四个选项。');
    const previousStatus = originalItems.get(firstId)?.values?.reading_status || '未开始';
    await statusSelect.selectOption('阅读中');
    await page.waitForFunction(async (id) => {
      const response = await fetch('/api/library');
      const payload = await response.json();
      return payload.library?.items?.[id]?.values?.reading_status === '阅读中';
    }, firstId);
    const checkedReading = await statusSelect.inputValue();
    if (checkedReading !== '阅读中') throw new Error(`阅读状态选中态不正确（${checkedReading}）`);
    await api(`/api/library/items/${firstId}`, json({ values: { reading_status: previousStatus } }, 'PATCH'));
    await page.reload({ waitUntil: 'networkidle' });
    await waitForLibrary(page);

    // 6. The all-papers surface stays flat and unique. Sidebar categories use
    // the saved grouping field as a separate filtered page.
    const groupingButton = page.locator('#grouping-button');
    if (!(await groupingButton.count())) throw new Error('左侧分类按钮缺失。');
    const initialAllIds = await page.locator('#recent-list .library-row').evaluateAll((rows) => rows.map((row) => row.dataset.jobId));
    if (new Set(initialAllIds).size !== initialAllIds.length) throw new Error(`全部文献出现重复条目（${initialAllIds.join(',')}）。`);
    if (await page.locator('#recent-list .library-group, #recent-list .library-group-heading').count()) throw new Error('全部文献仍按属性渲染分组标题。');
    const originalGroupBy = originalDisplay?.group_by || 'reading_status';
    const initialGroupBy = await groupingButton.getAttribute('data-group-by');
    if (initialGroupBy !== originalGroupBy && originalGroupBy === 'reading_status') throw new Error(`默认分类不是阅读状态（${initialGroupBy}）`);
    const groupingList = page.locator('#library-grouping-list');
    const firstGroupingValue = groupingList.locator('.grouping-value').first();
    const groupingValueBefore = await firstGroupingValue.boundingBox();
    await groupingButton.click();
    const groupingMenu = page.locator('#grouping-field-menu');
    await groupingMenu.waitFor({ state: 'visible' });
    const groupingOverlayState = await groupingMenu.evaluate((menu) => ({
      position: getComputedStyle(menu).position,
      parentId: menu.parentElement?.id || '',
      role: menu.getAttribute('role'),
      labelledBy: menu.getAttribute('aria-labelledby'),
      controls: document.querySelector('#grouping-button')?.getAttribute('aria-controls'),
      placement: menu.dataset.placement || '',
      rect: (() => { const value = menu.getBoundingClientRect(); return { top: value.top, right: value.right, bottom: value.bottom, left: value.left, width: value.width, height: value.height }; })(),
      hit: (() => { const value = menu.getBoundingClientRect(); const target = document.elementFromPoint(value.left + value.width / 2, value.top + value.height / 2); return Boolean(target && menu.contains(target)); })(),
    }));
    const groupingValueAfter = await firstGroupingValue.boundingBox();
    if (groupingOverlayState.position !== 'fixed' || groupingOverlayState.parentId !== 'global-menu-layer' || groupingOverlayState.role !== 'listbox' || groupingOverlayState.labelledBy !== 'grouping-button' || groupingOverlayState.controls !== 'grouping-field-menu') throw new Error(`分类字段菜单没有作为 body-level 可访问浮层呈现（${JSON.stringify(groupingOverlayState)}）`);
    if (groupingOverlayState.rect.top < 7 || groupingOverlayState.rect.left < 7 || groupingOverlayState.rect.right > page.viewportSize().width - 7 || groupingOverlayState.rect.bottom > page.viewportSize().height - 7 || !groupingOverlayState.hit) throw new Error(`分类字段菜单没有保持在视口内或无法真实命中（${JSON.stringify(groupingOverlayState)}）`);
    if (!groupingValueBefore || !groupingValueAfter || Math.abs(groupingValueAfter.y - groupingValueBefore.y) > 1) throw new Error(`分类字段菜单把分类值向下挤动（before=${JSON.stringify(groupingValueBefore)}, after=${JSON.stringify(groupingValueAfter)}）`);
    await page.locator('#library-heading').click();
    await groupingMenu.waitFor({ state: 'hidden' });
    await groupingButton.focus();
    await groupingButton.press('ArrowDown');
    await groupingMenu.waitFor({ state: 'visible' });
    await page.locator('.library-sidebar').evaluate((sidebar) => sidebar.dispatchEvent(new Event('scroll')));
    await groupingMenu.waitFor({ state: 'hidden' });
    await groupingButton.press('ArrowDown');
    await groupingMenu.waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement?.id === 'grouping-button');
    await groupingButton.press('ArrowDown');
    await groupingMenu.waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.activeElement?.classList.contains('grouping-option'));
    const focusedGroupingOption = await page.evaluate(() => ({ role: document.activeElement?.getAttribute('role'), selected: document.activeElement?.getAttribute('aria-selected'), tabIndex: document.activeElement?.tabIndex }));
    if (focusedGroupingOption.role !== 'option' || focusedGroupingOption.selected !== 'true' || focusedGroupingOption.tabIndex !== 0) throw new Error(`分类字段菜单没有把焦点移到当前选项（${JSON.stringify(focusedGroupingOption)}）`);
    await page.keyboard.press('End');
    if (await groupingMenu.locator('.grouping-option').last().evaluate((node) => document.activeElement === node) !== true) throw new Error('分类字段菜单 End 键没有移动到最后一项。');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement?.id === 'grouping-button');

    const groupingViewport = page.viewportSize();
    await page.setViewportSize({ width: 760, height: 900 });
    await page.locator('#mobile-sidebar-toggle').click();
    await page.locator('body.sidebar-open').waitFor();
    await groupingButton.evaluate((button) => { const sidebar = button.closest('.library-sidebar'); if (sidebar) sidebar.scrollTop = sidebar.scrollHeight; });
    await groupingButton.click();
    await groupingMenu.waitFor({ state: 'visible' });
    const mobileGroupingGeometry = await groupingMenu.evaluate((menu) => {
      const rect = menu.getBoundingClientRect();
      const firstOption = menu.querySelector('.grouping-option')?.getBoundingClientRect();
      const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + Math.min(rect.height / 2, 24));
      return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, optionHeight: firstOption?.height || 0, placement: menu.dataset.placement || '', hit: Boolean(target && menu.contains(target)) };
    });
    if (mobileGroupingGeometry.top < 7 || mobileGroupingGeometry.left < 7 || mobileGroupingGeometry.right > 753 || mobileGroupingGeometry.bottom > 893 || mobileGroupingGeometry.optionHeight < 39 || mobileGroupingGeometry.placement !== 'top' || !mobileGroupingGeometry.hit) throw new Error(`移动端分类字段浮层越界、未向上翻转或无法命中（${JSON.stringify(mobileGroupingGeometry)}）`);
    await page.keyboard.press('Escape');
    await page.locator('#library-scrim').click();
    await page.setViewportSize(groupingViewport);

    await groupingButton.click();
    await groupingMenu.waitFor({ state: 'visible' });
    const importanceOption = groupingMenu.locator('[data-group-by="importance"], .grouping-option').filter({ hasText: '重要程度' }).first();
    if (!(await importanceOption.count())) throw new Error('分类菜单没有提供文献库中的重要程度列。');
    await importanceOption.click();
    await page.waitForFunction(() => document.querySelector('#grouping-button')?.dataset.groupBy === 'importance');
    const groupedPayload = await api('/api/library');
    if (groupedPayload.library?.display?.group_by !== 'importance') throw new Error('分类字段没有持久化到 library.display.group_by。');
    if (await page.locator('#recent-list .library-group, #recent-list .library-group-heading').count()) throw new Error('切换分类字段后，全部文献重新出现了分组标题。');
    const groupFilter = groupingList.locator('.grouping-value[data-group-filter]').first();
    if (!(await groupFilter.count())) throw new Error('左侧分类区域没有提供分类入口。');
    const categoryLabel = (await groupFilter.locator('span').textContent()).trim();
    const categoryCount = Number((await groupFilter.locator('b').textContent()).trim());
    await groupFilter.click();
    await page.waitForFunction((label) => document.querySelector('#library-heading')?.textContent?.includes(label), categoryLabel);
    const categoryIds = await page.locator('#recent-list .library-row').evaluateAll((rows) => rows.map((row) => row.dataset.jobId));
    if (categoryIds.length !== categoryCount || new Set(categoryIds).size !== categoryIds.length) throw new Error(`分类页数量或唯一性不正确（expected=${categoryCount}, ids=${categoryIds.join(',')}）。`);
    if (await page.locator('#recent-list .library-group, #recent-list .library-group-heading').count()) throw new Error('分类页内部又嵌套渲染了分组标题。');
    if (await page.locator('[data-library-folder="system-all"].active').count()) throw new Error('分类页仍把“全部文献”标记为当前页面。');
    await groupFilter.click();
    await page.waitForFunction(() => document.querySelector('#library-heading')?.textContent?.trim() === '全部文献');
    if (!(await page.locator('[data-library-folder="system-all"].active').count())) throw new Error('退出分类页后没有返回“全部文献”。');
    await page.reload({ waitUntil: 'networkidle' });
    await waitForLibrary(page);
    if (await page.locator('#grouping-button').getAttribute('data-group-by') !== 'importance') throw new Error('重载后分类没有恢复上次选择。');

    // 7. Column settings preserve an existing width while changing label,
    // visibility and order. Width itself is owned by the table-header drag
    // handle, persists through the API and survives a reload.
    const seededNameWidth = 260;
    const seededColumns = originalColumnsPayload().map((column) => column.id === 'name' ? { ...column, width: seededNameWidth } : column);
    await api('/api/library/display', json({ columns: seededColumns, group_by: originalGroupBy }, 'PATCH'));
    await page.reload({ waitUntil: 'networkidle' });
    await waitForLibrary(page);
    await page.locator('#columns-button').click();
    await libraryEditor.waitFor({ state: 'visible' });
    if (await page.getByRole('dialog', { name: '文献库列设置', exact: true }).count() !== 1) throw new Error('列设置弹窗没有暴露“文献库列设置”可访问名称。');
    if (await libraryEditor.locator('[data-column-width], .column-width-field').count()) throw new Error('列设置保存流程仍暴露数字列宽输入。');
    const nameOption = libraryEditor.locator('.column-option[data-column-id="name"]');
    const researchTopicOption = libraryEditor.locator('.column-option[data-column-id="research_topic"]');
    const titleVisibility = libraryEditor.locator('[data-column-visible="title"]');
    if (!(await nameOption.count()) || !(await researchTopicOption.count()) || !(await titleVisibility.count())) throw new Error('列设置缺少名称、研究主题或标题列配置。');
    if (await libraryEditor.locator('.column-option[data-column-id="status"]').count()) throw new Error('已退役的状态列仍出现在列设置中。');
    if (await nameOption.locator('[data-column-delete]').count()) throw new Error('系统列错误地提供了删除按钮。');
    const editedNameLabel = `名称 ${Date.now()}`;
    await nameOption.locator('[data-column-label="name"]').fill(editedNameLabel);
    const titleWasVisible = await titleVisibility.isChecked();
    if (titleWasVisible) await titleVisibility.uncheck();
    else await titleVisibility.check();
    const nameGrip = nameOption.locator('[data-column-grip="name"]');
    const gripLabel = await nameGrip.getAttribute('aria-label');
    if (!String(gripLabel || '').includes('名称')) throw new Error(`名称列拖动柄缺少可访问名称（${JSON.stringify(gripLabel)}）`);
    await nameGrip.focus();
    await nameGrip.press('ArrowRight');
    const keyboardMovedOrder = await libraryEditor.locator('.column-option').evaluateAll((nodes) => nodes.map((node) => node.dataset.columnId));
    if (keyboardMovedOrder.indexOf('name') <= keyboardMovedOrder.indexOf('research_topic')) throw new Error(`ArrowRight 没有向右移动名称列（${keyboardMovedOrder.join(',')}）`);
    const focusedGripAfterMove = await page.evaluate(() => document.activeElement?.dataset?.columnGrip || '');
    if (focusedGripAfterMove !== 'name') throw new Error(`键盘移动列后焦点没有保留在原拖动柄（${focusedGripAfterMove}）`);
    await nameGrip.press('ArrowLeft');
    const keyboardRestoredOrder = await libraryEditor.locator('.column-option').evaluateAll((nodes) => nodes.map((node) => node.dataset.columnId));
    if (keyboardRestoredOrder.indexOf('name') >= keyboardRestoredOrder.indexOf('research_topic')) throw new Error(`ArrowLeft 没有向左恢复名称列（${keyboardRestoredOrder.join(',')}）`);
    const visualColumnCount = await libraryEditor.locator('.columns-list').evaluate((list) => {
      const options = [...list.querySelectorAll(':scope > .column-option')];
      const firstTop = options[0]?.offsetTop ?? 0;
      const rowBreak = options.findIndex((option) => Math.abs(option.offsetTop - firstTop) > 1);
      return rowBreak > 0 ? rowBreak : Math.max(1, options.length);
    });
    const beforeVerticalOrder = [...keyboardRestoredOrder];
    const beforeVerticalIndex = beforeVerticalOrder.indexOf('name');
    await nameGrip.press('ArrowDown');
    const keyboardDownOrder = await libraryEditor.locator('.column-option').evaluateAll((nodes) => nodes.map((node) => node.dataset.columnId));
    if (keyboardDownOrder.indexOf('name') !== beforeVerticalIndex + visualColumnCount) throw new Error(`ArrowDown 没有向下跨越一行（${keyboardDownOrder.join(',')}）`);
    await nameGrip.press('ArrowUp');
    const keyboardUpOrder = await libraryEditor.locator('.column-option').evaluateAll((nodes) => nodes.map((node) => node.dataset.columnId));
    if (JSON.stringify(keyboardUpOrder) !== JSON.stringify(beforeVerticalOrder)) throw new Error(`ArrowUp 没有恢复原视觉行（${keyboardUpOrder.join(',')}）`);
    await page.evaluate(() => {
      const source = document.querySelector('#library-editor-dialog .column-option[data-column-id="name"]');
      const target = document.querySelector('#library-editor-dialog .column-option[data-column-id="research_topic"]');
      if (!source || !target) throw new Error('无法构造列排序拖拽源或目标。');
      const transfer = new DataTransfer();
      source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      const targetRect = target.getBoundingClientRect();
      target.dispatchEvent(new DragEvent('dragover', {
        bubbles: true,
        cancelable: true,
        clientX: targetRect.right - 1,
        clientY: targetRect.top + targetRect.height / 2,
        dataTransfer: transfer,
      }));
      source.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    const editedOrder = await libraryEditor.locator('.column-option').evaluateAll((nodes) => nodes.map((node) => node.dataset.columnId));
    if (editedOrder.indexOf('research_topic') < 0 || editedOrder.indexOf('name') <= editedOrder.indexOf('research_topic')) throw new Error(`列拖拽排序没有更新编辑器顺序（${editedOrder.join(',')}）`);
    await page.locator('#library-editor-save').click();
    await libraryEditor.waitFor({ state: 'hidden' });
    const editedDisplay = (await api('/api/library')).library?.display;
    const editedName = (editedDisplay?.columns || []).find((column) => column.id === 'name');
    const editedTitle = (editedDisplay?.columns || []).find((column) => column.id === 'title');
    const savedOrder = (editedDisplay?.columns || []).map((column) => column.id);
    if (Number(editedName?.width) !== seededNameWidth) throw new Error(`列设置修改名称/显隐/顺序时篡改了既有列宽（${JSON.stringify(editedName)}）`);
    if (editedName?.label !== editedNameLabel) throw new Error(`列名称没有保存（${JSON.stringify(editedName)}）`);
    if (Boolean(editedTitle?.visible) === titleWasVisible) throw new Error(`列显隐没有保存（${JSON.stringify(editedTitle)}）`);
    if (savedOrder.indexOf('name') <= savedOrder.indexOf('research_topic')) throw new Error(`列顺序没有保存（${savedOrder.join(',')}）`);

    let nameHeader = page.locator('#library-columns [data-column-id="name"], #library-columns [data-column="name"]').first();
    if (!(await nameHeader.count())) throw new Error('文献列标题没有暴露名称列。');
    const seededHeaderBox = await nameHeader.boundingBox();
    if (!seededHeaderBox || Math.abs(seededHeaderBox.width - seededNameWidth) > 2) throw new Error(`列设置保存后表头没有保持已知列宽（expected=${seededNameWidth}, actual=${seededHeaderBox?.width}）`);
    let nameResizer = await visibleLocator(page, [
      '#library-columns [data-column-resizer="name"]',
      '#library-columns [data-resize-column="name"]',
      '#library-columns [data-column-id="name"] .column-resizer',
      '#library-columns [data-column="name"] .column-resizer',
    ]);
    if (!nameResizer) throw new Error('名称列没有可拖拽的列宽控制柄。');
    const initialAriaWidth = Number(await nameResizer.getAttribute('aria-valuenow'));
    if (!Number.isFinite(initialAriaWidth) || initialAriaWidth <= 0) throw new Error(`名称列控制柄 aria-valuenow 无效（${initialAriaWidth}）`);

    await nameResizer.focus();
    await nameResizer.press('ArrowRight');
    await page.waitForFunction(async ({ id, before }) => {
      const payload = await (await fetch('/api/library')).json();
      const column = (payload.library?.display?.columns || []).find((item) => item.id === id);
      return Number(column?.width) > before;
    }, { id: 'name', before: initialAriaWidth });
    const afterRightPayload = await api('/api/library');
    const afterRightWidth = Number((afterRightPayload.library?.display?.columns || []).find((column) => column.id === 'name')?.width);
    nameResizer = page.locator('#library-columns [data-column-resizer="name"]').first();
    const afterRightAriaWidth = Number(await nameResizer.getAttribute('aria-valuenow'));
    if (!Number.isFinite(afterRightWidth) || afterRightWidth <= initialAriaWidth || afterRightAriaWidth !== afterRightWidth) throw new Error(`ArrowRight 列宽或 aria-valuenow 未正确更新（before=${initialAriaWidth}, stored=${afterRightWidth}, aria=${afterRightAriaWidth}）`);

    await nameResizer.focus();
    await nameResizer.press('ArrowLeft');
    await page.waitForFunction(async ({ id, before }) => {
      const payload = await (await fetch('/api/library')).json();
      const column = (payload.library?.display?.columns || []).find((item) => item.id === id);
      return Number(column?.width) < before;
    }, { id: 'name', before: afterRightWidth });
    const afterLeftPayload = await api('/api/library');
    const afterLeftWidth = Number((afterLeftPayload.library?.display?.columns || []).find((column) => column.id === 'name')?.width);
    nameResizer = page.locator('#library-columns [data-column-resizer="name"]').first();
    const afterLeftAriaWidth = Number(await nameResizer.getAttribute('aria-valuenow'));
    if (!Number.isFinite(afterLeftWidth) || afterLeftWidth >= afterRightWidth || afterLeftAriaWidth !== afterLeftWidth) throw new Error(`ArrowLeft 列宽或 aria-valuenow 未正确更新（right=${afterRightWidth}, stored=${afterLeftWidth}, aria=${afterLeftAriaWidth}）`);

    const widthBeforeFailedPatch = afterLeftWidth;
    await page.route('**/api/library/display', async (route) => {
      if (route.request().method() !== 'PATCH') return route.continue();
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '模拟列宽保存失败' }) });
    });
    expectingColumnResizeFailure = true;
    await nameResizer.focus();
    await nameResizer.press('ArrowRight');
    await page.locator('.toast').filter({ hasText: '保存列宽失败' }).waitFor({ state: 'visible' });
    await page.waitForFunction(({ id, expected }) => {
      const header = document.querySelector(`#library-columns [data-column-id="${CSS.escape(id)}"]`);
      const handle = header?.querySelector('[data-column-resizer]');
      return Math.abs((header?.getBoundingClientRect().width || 0) - expected) <= 2 && Number(handle?.getAttribute('aria-valuenow')) === expected;
    }, { id: 'name', expected: widthBeforeFailedPatch });
    const failedPatchPayload = await api('/api/library');
    const widthAfterFailedPatch = Number((failedPatchPayload.library?.display?.columns || []).find((column) => column.id === 'name')?.width);
    if (widthAfterFailedPatch !== widthBeforeFailedPatch) throw new Error(`失败的列宽 PATCH 改写了持久化状态（before=${widthBeforeFailedPatch}, after=${widthAfterFailedPatch}）`);
    await page.unroute('**/api/library/display');
    expectingColumnResizeFailure = false;

    nameHeader = page.locator('#library-columns [data-column-id="name"], #library-columns [data-column="name"]').first();
    nameResizer = await visibleLocator(page, [
      '#library-columns [data-column-resizer="name"]',
      '#library-columns [data-resize-column="name"]',
      '#library-columns [data-column-id="name"] .column-resizer',
      '#library-columns [data-column="name"] .column-resizer',
    ]);
    const nameHeaderBefore = await nameHeader.boundingBox();
    if (!nameResizer || !nameHeaderBefore) throw new Error('键盘列宽测试后无法重新测量名称列表头。');
    const resizerBox = await nameResizer.boundingBox();
    if (!resizerBox) throw new Error('名称列宽控制柄无法测量。');
    await page.mouse.move(resizerBox.x + resizerBox.width / 2, resizerBox.y + resizerBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(resizerBox.x + resizerBox.width / 2 + 72, resizerBox.y + resizerBox.height / 2, { steps: 6 });
    await page.mouse.up();
    const resizedWidthHandle = await page.waitForFunction((before) => {
      const node = document.querySelector('#library-columns [data-column-id="name"], #library-columns [data-column="name"]') || [...document.querySelectorAll('#library-columns span')].find((item) => item.textContent.trim() === '名称');
      const width = node?.getBoundingClientRect().width || 0;
      return width > before + 20 ? width : false;
    }, nameHeaderBefore.width);
    const resizedWidth = Number(await resizedWidthHandle.jsonValue());
    if (!Number.isFinite(resizedWidth) || resizedWidth <= nameHeaderBefore.width + 20) throw new Error(`列宽拖拽没有生效（before=${nameHeaderBefore.width}, after=${resizedWidth}）`);
    await page.waitForFunction(async ({ id, before }) => {
      const response = await fetch('/api/library');
      const payload = await response.json();
      const column = (payload.library?.display?.columns || []).find((item) => item.id === id);
      return Number(column?.width) > before + 20;
    }, { id: 'name', before: nameHeaderBefore.width });
    const resizedPayload = await api('/api/library');
    const resizedColumn = (resizedPayload.library?.display?.columns || []).find((column) => column.id === 'name');
    if (!Number.isFinite(Number(resizedColumn?.width)) || Number(resizedColumn.width) <= nameHeaderBefore.width) throw new Error(`列宽没有写入 display.columns[].width（${JSON.stringify(resizedColumn)}）`);
    await page.reload({ waitUntil: 'networkidle' });
    await waitForLibrary(page);
    const persistedNameHeader = page.locator('#library-columns [data-column-id="name"], #library-columns [data-column="name"]').first();
    const persistedHeader = await persistedNameHeader.boundingBox();
    if (!persistedHeader || persistedHeader.width <= nameHeaderBefore.width + 20) throw new Error('重载后名称列宽没有保持。');
    const persistedPayload = await api('/api/library');
    const persistedColumn = (persistedPayload.library?.display?.columns || []).find((column) => column.id === 'name');
    const persistedAriaWidth = Number(await persistedNameHeader.locator('[data-column-resizer="name"], .column-resizer').first().getAttribute('aria-valuenow'));
    if (Number(persistedColumn?.width) !== Number(resizedColumn?.width) || Math.abs(persistedAriaWidth - Number(persistedColumn?.width)) > 1) throw new Error(`重载后的列宽、存储值与无障碍值不一致（stored=${JSON.stringify(persistedColumn)}, aria=${persistedAriaWidth}）`);

    await api('/api/library/display', json({ columns: originalColumnsPayload(), group_by: originalGroupBy }, 'PATCH'));
    await page.reload({ waitUntil: 'networkidle' });
    await waitForLibrary(page);

    // 8. Long-press dragging a row onto a folder assigns it without opening
    // the reader. The item is restored during cleanup below.
    const folderPayload = await api('/api/library/folders', json({ name: `v4 长按拖拽 ${Date.now()}` }));
    const folderId = folderPayload.folder?.id;
    if (!folderId) throw new Error('无法创建长按拖拽测试文件夹。');
    createdFolders.push(folderId);
    await page.reload({ waitUntil: 'networkidle' });
    await waitForLibrary(page);
    const dragRow = row(firstId);
    const dragTarget = page.locator(`[data-library-folder="${folderId}"]`).first();
    await dragTarget.scrollIntoViewIfNeeded();
    const dragRowBox = await dragRow.boundingBox();
    const dragTargetBox = await dragTarget.boundingBox();
    if (!dragRowBox || !dragTargetBox) throw new Error('长按拖拽源或目标无法测量。');
    await page.mouse.move(dragRowBox.x + Math.min(32, dragRowBox.width / 2), dragRowBox.y + dragRowBox.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(650);
    await page.mouse.move(dragTargetBox.x + dragTargetBox.width / 2, dragTargetBox.y + dragTargetBox.height / 2, { steps: 10 });
    await page.waitForTimeout(180);
    await page.mouse.up();
    await page.waitForFunction(async ({ id, folder }) => {
      const response = await fetch('/api/library');
      const payload = await response.json();
      return Boolean(payload.library?.items?.[id]?.folder_ids?.includes(folder));
    }, { id: firstId, folder: folderId });
    if (await page.locator('#reader-view.active-view').count()) throw new Error('长按拖拽文献时意外打开了阅读器。');

    // 9. Finder-style marquee selection selects multiple rows, and clicking
    // the empty list canvas clears the selection.
    await page.locator('[data-library-folder="system-all"]').click();
    await waitForLibrary(page);
    if (await page.locator('#library-multi-select-button, #library-selection-tools, #recent-list [data-library-select]').count()) throw new Error('旧的显式多选控件仍然存在。');
    const selectionList = page.locator('#recent-list');
    const selectionListBox = await selectionList.boundingBox();
    const selectionFirstBox = await row(firstId).boundingBox();
    const selectionLastBox = await row(lastId).boundingBox();
    if (!selectionListBox || !selectionFirstBox || !selectionLastBox) throw new Error('无法测量框选区域。');
    const selectionStart = { x: selectionListBox.x + 18, y: selectionLastBox.y + selectionLastBox.height + 60 };
    const selectionEnd = { x: selectionListBox.x + Math.max(220, selectionListBox.width - 28), y: selectionFirstBox.y + selectionFirstBox.height / 2 };
    if (selectionStart.y >= selectionListBox.y + selectionListBox.height) throw new Error('列表没有提供可用的空白框选区域。');

    // A quick drag that starts on a row should enter marquee selection; the
    // long-press folder gesture remains reserved for a stationary pointer.
    await page.mouse.move(selectionFirstBox.x + 40, selectionFirstBox.y + selectionFirstBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(selectionLastBox.x + 40, selectionLastBox.y + selectionLastBox.height / 2, { steps: 12 });
    if (await page.locator('.library-selection-marquee').count() !== 1) throw new Error('从文献行开始拖拽时没有显示选择框。');
    await page.waitForTimeout(180);
    await page.mouse.up();
    if (await selectedRows().count() < 2) throw new Error('从文献行开始框选没有选中多篇文献。');
    await page.mouse.click(selectionStart.x, selectionStart.y);
    if (await selectedRows().count() !== 0) throw new Error('行内框选后的空白点击没有清空选择。');

    // Keep the pointer up delayed long enough to exercise the native click
    // that follows pointer capture; it must not clear the completed selection.
    await page.mouse.move(selectionStart.x, selectionStart.y);
    await page.mouse.down();
    await page.mouse.move(selectionEnd.x, selectionEnd.y, { steps: 12 });
    if (await page.locator('.library-selection-marquee').count() !== 1) throw new Error('拖拽时没有显示选择框。');
    await page.waitForTimeout(180);
    await page.mouse.up();
    if (await selectedRows().count() < 2) throw new Error('框选没有选中多篇文献。');
    await page.mouse.click(selectionStart.x, selectionStart.y);
    if (await selectedRows().count() !== 0) throw new Error('点击列表空白处没有清空框选结果。');

    // The whole library column is a Finder-style selection surface.  A drag
    // that starts below the list (the empty column canvas) must still reach
    // the rows above it, rather than requiring the pointer to start in
    // #recent-list itself.
    const librarySurface = page.locator('#library-view .library-main');
    const librarySurfaceBox = await librarySurface.boundingBox();
    const listSurfaceBox = await page.locator('#library-list-surface').boundingBox();
    if (!librarySurfaceBox || !listSurfaceBox) throw new Error('无法测量整列框选区域。');
    const outsideStartY = Math.max(listSurfaceBox.y + listSurfaceBox.height + 24, librarySurfaceBox.y + 24);
    if (outsideStartY >= librarySurfaceBox.y + librarySurfaceBox.height - 8) throw new Error('列表下方没有可用的整列空白框选区域。');
    const outsideStart = { x: librarySurfaceBox.x + 22, y: outsideStartY };
    const outsideEnd = { x: Math.max(outsideStart.x + 220, librarySurfaceBox.x + librarySurfaceBox.width - 28), y: selectionFirstBox.y + selectionFirstBox.height / 2 };
    await page.mouse.move(outsideStart.x, outsideStart.y);
    await page.mouse.down();
    await page.mouse.move(outsideEnd.x, outsideEnd.y, { steps: 12 });
    if (await page.locator('.library-selection-marquee').count() !== 1) throw new Error('从列表下方空白列开始拖拽时没有显示选择框。');
    await page.mouse.up();
    if (await selectedRows().count() < 2) throw new Error('从列表下方空白列开始框选没有选中多篇文献。');
    await page.mouse.click(outsideStart.x, outsideStart.y);
    if (await selectedRows().count() !== 0) throw new Error('点击列表下方空白列没有清空框选结果。');

    // Command+A selects every row currently visible in the library while
    // leaving native text selection untouched in editable controls.
    await rowBody(firstId).click();
    await page.keyboard.press('Meta+A');
    if (await selectedRows().count() !== rowIds.length) throw new Error('Command+A 没有选中当前可见的全部文献。');

    await rowBody(firstId).click();
    await page.keyboard.down('Meta');
    await rowBody(secondId).click();
    await page.keyboard.up('Meta');
    if (await selectedRows().count() < 2) {
      await rowBody(firstId).click();
      await page.keyboard.down('Control');
      await rowBody(secondId).click();
      await page.keyboard.up('Control');
    }
    if (await selectedRows().count() < 2) throw new Error('无法通过 Command/Ctrl-click 选中多篇文献。');
    await row(secondId).click({ button: 'right', position: { x: 24, y: 24 } });
    const batchMenu = menuLocator();
    await batchMenu.waitFor({ state: 'visible' });
    const batchText = await batchMenu.textContent();
    if (!/批量|已选|添加到文件夹|移入回收站/u.test(batchText || '')) throw new Error(`多选右键菜单没有批量操作（${batchText}）`);

    // A value cell edits in place, and being a button is what keeps row
    // selection, double-click-to-open and the marquee drag off the same press.
    await page.keyboard.press('Escape');
    await waitForLibrary(page);
    const cellEditor = page.locator('#cell-editor-popover');
    const valueCell = (id, propertyId) => row(id).locator(`[data-cell-edit="${propertyId}"]`);
    await valueCell(firstId, 'reading_status').click();
    await cellEditor.waitFor({ state: 'visible' });
    const inlineChoices = await cellEditor.locator('[data-cell-option]').allTextContents();
    if (!inlineChoices.includes('计划中')) throw new Error(`快速编辑没有列出阅读状态选项（${inlineChoices.join('|')}）`);
    const inlineStatusPatch = page.waitForResponse((response) => response.request().method() === 'PATCH' && response.url().endsWith(`/api/library/items/${firstId}`));
    await cellEditor.locator('[data-cell-option="计划中"]').click();
    await inlineStatusPatch;
    await page.waitForFunction((id) => document.querySelector(`.library-row[data-job-id="${id}"] .row-status`)?.textContent.trim() === '计划中', firstId);
    if (!(await cellEditor.isHidden())) throw new Error('快速编辑在提交后没有关闭。');
    await valueCell(firstId, 'research_topic').click();
    await cellEditor.locator('[data-cell-input]').waitFor();
    await cellEditor.locator('[data-cell-input]').fill('快速编辑标签');
    await page.keyboard.press('Enter');
    await cellEditor.locator('[data-cell-tag="快速编辑标签"][aria-pressed="true"]').waitFor();
    const inlineTopicPatch = page.waitForResponse((response) => response.request().method() === 'PATCH' && response.url().endsWith(`/api/library/items/${firstId}`));
    await cellEditor.locator('[data-cell-save]').click();
    await inlineTopicPatch;
    await page.waitForFunction((id) => [...document.querySelectorAll(`.library-row[data-job-id="${id}"] .tag-chip`)].some((chip) => chip.textContent.trim() === '快速编辑标签'), firstId);
    await valueCell(firstId, 'venue').click();
    await cellEditor.waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    if (!(await cellEditor.isHidden())) throw new Error('Esc 没有关闭快速编辑。');
    // A value cell covers most of a row, so double-clicking one still opens
    // the paper; the quick editor gives way rather than swallowing it.
    await valueCell(firstId, 'venue').dblclick();
    await page.locator('#reader-view.active-view').waitFor();
    if (!(await cellEditor.isHidden())) throw new Error('打开阅读器后快速编辑没有关闭。');
    await page.locator('.nav-button[data-view="library-view"]').click();
    await page.locator('#library-view.active-view').waitFor();
    await waitForLibrary(page);

    console.log(JSON.stringify({
      singleClickSelect: true,
      doubleClickOpen: true,
      lastRowContextMenu: true,
      outsideClickDismiss: true,
      placeholders: true,
      readingStatusDropdown: true,
      inlineCellEditing: true,
      readingStatusMenuVisible: true,
      flatAllPapersAndCategoryPage: true,
      columnSettingsPreserveWidth: true,
      columnResizePersistence: true,
      longPressFolderDrag: true,
      marqueeRowStart: true,
      marqueeDelayedRelease: true,
      marqueeOutsideListSurface: true,
      commandASelectAll: true,
      multiSelectionContextMenu: true,
      errors,
    }));
    if (errors.length) process.exitCode = 1;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    // Best-effort cleanup for failures that occur halfway through the test.
    // A disposable server/data directory is still recommended by the header.
    if (browser) {
      try {
        const cleanupPage = await browser.newPage({ viewport });
        const cleanup = async (url, options) => cleanupPage.evaluate(async ({ url: requestURL, options: requestOptions }) => {
          await fetch(requestURL, requestOptions);
        }, { url, options });
        await cleanupPage.goto(baseURL, { waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {});
        if (originalDisplay) await cleanup('/api/library/display', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ columns: originalColumnsPayload(), group_by: originalDisplay.group_by || 'reading_status' }) }).catch(() => {});
        for (const [id, item] of originalItems) await cleanup(`/api/library/items/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder_ids: item.folder_ids || [], values: item.values || {}, progress: item.progress || {} }) }).catch(() => {});
        for (const folderId of createdFolders) await cleanup(`/api/library/folders/${folderId}`, { method: 'DELETE' }).catch(() => {});
        for (const propertyId of createdProperties) await cleanup(`/api/library/properties/${propertyId}`, { method: 'DELETE' }).catch(() => {});
        await cleanupPage.close().catch(() => {});
      } catch (_) {
        // The main error is more useful than a cleanup error when a test
        // server has already exited.
      }
    }
    try {
      await browserSession?.close();
    } catch (closeError) {
      console.error(`Failed to close browser: ${closeError.message}`);
      process.exitCode = 1;
    }
  }
})();
