'use strict';

const os = require('os');
const path = require('path');
const { launchManagedChromium } = require('./playwright.cjs');

const baseURL = process.argv[2] || 'http://127.0.0.1:8766';
// os.tmpdir() rather than /private/tmp: that path only exists on macOS, and
// this suite also runs on the Linux CI runner.
const screenshot = process.argv[3] || path.join(os.tmpdir(), 'my-scholar-onboarding.png');
let browserSession;

(async () => {
  browserSession = await launchManagedChromium();
  const page = await browserSession.browser.newPage({ viewport: { width: 1280, height: 820 } });
  const rendererState = {};
  const errors = [];

  await page.exposeFunction('__onboardingStateLoad', async () => ({ ...rendererState }));
  await page.exposeFunction('__onboardingStateSet', async (key, value) => { rendererState[key] = value; });
  await page.exposeFunction('__onboardingStateRemove', async (key) => { delete rendererState[key]; });
  await page.addInitScript(() => {
    window.__updateCheckCount = 0;
    window.__openedUpdateDownloads = 0;
    Object.defineProperty(window, 'myScholarDesktop', {
      configurable: true,
      value: Object.freeze({
        platform: 'darwin',
        getStartupContext: async () => ({
          ok: true,
          app: { name: '谷子学术', version: '0.1.11', platform: 'darwin', arch: 'arm64', channel: 'internal' },
          storage: {
            state: 'conflict',
            adopted: false,
            current: { path: '/tmp/library', valid: true, empty: false, itemCount: 1, jobCount: 1 },
            legacy: [{ path: '/tmp/legacy-library', valid: true, empty: false, itemCount: 4, jobCount: 4 }],
          },
        }),
        selectStartupLibrary: async (selectedPath) => ({ ok: true, reloading: false, currentPath: selectedPath, items: 0, jobs: 0 }),
        checkForUpdates: async () => {
          window.__updateCheckCount += 1;
          if (window.__updateCheckCount === 1) return { ok: true, status: 'current', currentVersion: '0.1.11', version: '0.1.11', checkedAt: new Date().toISOString() };
          return {
            ok: true,
            status: 'available',
            currentVersion: '0.1.11',
            version: '0.1.11',
            publishedAt: '2026-08-07T00:00:00Z',
            notes: '验证设置中的下载入口。',
            sha256: 'a'.repeat(64),
            checkedAt: new Date().toISOString(),
          };
        },
        openUpdateDownload: async () => {
          window.__openedUpdateDownloads += 1;
          return { ok: true };
        },
        state: Object.freeze({
          loadAll: () => window.__onboardingStateLoad(),
          set: (key, value) => window.__onboardingStateSet(key, value),
          remove: (key) => window.__onboardingStateRemove(key),
        }),
      }),
    });
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    let body = {};
    if (pathname === '/api/health') body = { ok: true, service: 'my-scholar', version: '0.1', shell: 'reference', ai: { services: { translation: { enabled: true, configured: true }, chat: { enabled: true, configured: true } } } };
    else if (pathname === '/api/jobs') body = { jobs: [] };
    else if (pathname === '/api/library') body = { library: { folders: [], views: [], properties: [], items: {}, display: { columns: [], group_by: 'reading_status' } } };
    else if (pathname === '/api/settings') body = { ai: { translation: { base_url: '', model: '', api_key_configured: false }, chat: { base_url: '', model: '', api_key_configured: false } }, metadata: { auto_retrieve: true, online_lookup: true, contact_email: '' }, shortcuts: {}, appearance: { app_font: 'system', reader_font: 'academic', accent: 'amber' }, ai_services: {}, ai_status_history: [], highlight_color: '#f59e0b' };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });

  await page.goto(baseURL, { waitUntil: 'networkidle' });
  await page.locator('#onboarding-dialog[open]').waitFor();
  const initial = await page.locator('#onboarding-dialog').evaluate((dialog) => {
    const surface = dialog.querySelector('.onboarding-surface').getBoundingClientRect();
    const active = dialog.querySelector('.onboarding-slide.is-active');
    const progress = dialog.querySelector('#onboarding-progress');
    const transition = getComputedStyle(active).transitionDuration;
    return {
      ariaModal: dialog.matches(':modal'),
      title: active.querySelector('h1').textContent.trim(),
      activeCount: dialog.querySelectorAll('.onboarding-slide.is-active').length,
      hiddenCount: [...dialog.querySelectorAll('.onboarding-slide')].filter((slide) => slide.getAttribute('aria-hidden') === 'true').length,
      progressNow: progress.getAttribute('aria-valuenow'),
      progressWidth: progress.querySelector('span').style.width,
      transition,
      surfaceWidth: surface.width,
      surfaceHeight: surface.height,
    };
  });
  if (!initial.ariaModal || initial.title !== '欢迎来到谷子学术' || initial.activeCount !== 1 || initial.hiddenCount !== 3 || initial.progressNow !== '1' || initial.progressWidth !== '25%') throw new Error(`首次引导状态异常：${JSON.stringify(initial)}`);
  if (initial.surfaceWidth < 850 || initial.surfaceHeight < 600 || !initial.transition.includes('0.24s')) throw new Error(`首次引导布局或动画异常：${JSON.stringify(initial)}`);
  await page.screenshot({ path: screenshot });

  await page.locator('#onboarding-next').click();
  await page.waitForFunction(() => document.querySelector('.onboarding-slide.is-active h1')?.textContent.trim() === '继续使用你的本地文献库');
  if (!await page.locator('[data-onboarding-step="0"]').evaluate((slide) => slide.classList.contains('is-before'))) throw new Error('前进时上一页没有使用反向离场动画');
  if (await page.locator('#onboarding-library-conflict-actions').isHidden()) throw new Error('双库冲突没有提供安全选择入口');
  const libraryChoiceVisibility = await page.locator('#onboarding-library-conflict-actions').evaluate((actions) => [...actions.querySelectorAll('button')].map((button) => ({ id: button.id, hidden: button.hidden, display: getComputedStyle(button).display, width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height })));
  if (libraryChoiceVisibility.some((button) => button.hidden || button.display === 'none' || button.width <= 0 || button.height <= 0)) throw new Error(`两个有效文献库没有同时提供保留与恢复选项：${JSON.stringify(libraryChoiceVisibility)}`);
  if (await page.locator('#onboarding-use-legacy-library').getAttribute('data-path') !== '/tmp/legacy-library') throw new Error('旧版文献库选择没有绑定到识别出的安全路径');
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.querySelector('.onboarding-slide.is-active h1')?.textContent.trim() === '从阅读走向关联');
  await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(() => document.querySelector('.onboarding-slide.is-active h1')?.textContent.trim() === '继续使用你的本地文献库');
  await page.locator('#onboarding-next').click();
  await page.locator('#onboarding-next').click();
  await page.waitForFunction(() => document.querySelector('.onboarding-slide.is-active h1')?.textContent.trim() === '现在，开始你的研究');
  if (await page.locator('#onboarding-next').textContent() !== '进入谷子学术') throw new Error('最后一步没有呈现明确的完成操作');
  await page.locator('#onboarding-next').click();
  await page.waitForFunction(() => !document.querySelector('#onboarding-dialog').open);

  const stored = JSON.parse(rendererState['my-scholar-onboarding-v2'] || 'null');
  if (stored?.version !== 2 || stored?.action !== 'completed' || Number.isNaN(Date.parse(stored?.completedAt))) throw new Error(`首启完成状态没有正确落盘：${JSON.stringify(stored)}`);
  await page.reload({ waitUntil: 'networkidle' });
  if (await page.locator('#onboarding-dialog[open]').count()) throw new Error('完成引导后重启仍然重复展示');

  await page.locator('[data-view="settings-view"]').click();
  await page.locator('#settings-view.active-view').waitFor();
  if (await page.locator('#onboarding-settings-row').isHidden()) throw new Error('桌面设置没有提供重新查看新手引导的入口');
  await page.waitForFunction(() => document.querySelector('#app-current-version')?.textContent.trim() === 'v0.1.11');
  if (await page.locator('a[href="#settings-updates"]').count() !== 1) throw new Error('设置导航缺少“关于与更新”入口');
  await page.locator('a[href="#settings-updates"]').click();
  await page.locator('#check-updates').click();
  await page.waitForFunction(() => document.querySelector('#update-status-title')?.textContent.trim() === '当前已是最新版本');
  if (!await page.locator('#download-update').isHidden()) throw new Error('当前版本没有隐藏不必要的下载按钮');
  await page.locator('#check-updates').click();
  await page.waitForFunction(() => document.querySelector('#update-status-title')?.textContent.trim() === '发现新版本 v0.1.11');
  if (await page.locator('#download-update').isHidden()) throw new Error('发现新版本后没有提供下载入口');
  if (await page.locator('#update-release-sha').textContent() !== `SHA-256 · ${'a'.repeat(64)}`) throw new Error('更新详情没有展示安装包校验值');
  await page.locator('#download-update').click();
  await page.waitForFunction(() => window.__openedUpdateDownloads === 1);
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await page.locator('a[href="#settings-reading"]').click();
  await page.locator('#replay-onboarding').click();
  await page.locator('#onboarding-dialog[open]').waitFor();
  const reducedMotion = await page.locator('.onboarding-slide.is-active').evaluate((slide) => ({ transition: getComputedStyle(slide).transitionDuration, colorScheme: getComputedStyle(document.documentElement).colorScheme }));
  if (!/^0s(?:, 0s)*$/u.test(reducedMotion.transition) || !reducedMotion.colorScheme.includes('dark')) throw new Error(`减少动态效果或深色模式没有生效：${JSON.stringify(reducedMotion)}`);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#onboarding-dialog').open);
  if (JSON.parse(rendererState['my-scholar-onboarding-v2']).action !== 'skipped') throw new Error('跳过引导没有保持“不再自动展示”的完成状态');
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(JSON.stringify({ firstLaunch: true, animatedSteps: 4, persistentCompletion: true, noRepeatAfterReload: true, settingsReplay: true, updateDownloadEntry: true, reducedMotion: true, darkMode: true, screenshot }));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  try {
    await browserSession?.close();
  } catch (error) {
    console.error(`Failed to close onboarding smoke browser: ${error.message}`);
    process.exitCode = 1;
  }
});
