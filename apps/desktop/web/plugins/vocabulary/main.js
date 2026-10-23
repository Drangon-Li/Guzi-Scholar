(() => {
  'use strict';
  const sdk = window.GuziPlugin;
  const jsonOptions = (body, method = 'POST') => ({ method, body: JSON.stringify(body) });
  const api = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : {};
    const match = url.match(/^\/api\/vocabulary(?:\/([^/]+))?(?:\/(review|explain))?$/u);
    if (!match) throw new Error('未知词库操作。');
    const args = match[1] ? { entry_id: decodeURIComponent(match[1]), ...body } : body;
    const name = match[2] ? `vocabulary_${match[2]}` : match[1] ? options.method === 'DELETE' ? 'vocabulary_delete' : 'vocabulary_update' : options.method === 'POST' ? 'vocabulary_save' : 'vocabulary_list';
    return sdk.call(name, args);
  };
  const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/gu, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const controller = window.MyScholarVocabulary.create({
    api, jsonOptions, escapeHTML,
    translate: (text, job_id) => sdk.call('translate_text', { text, job_id }),
    openSource: (source) => sdk.ui.openSource(source),
    toast: (message) => { void sdk.ui.toast(message); },
    confirm: (message, title) => sdk.ui.confirm(message, title),
  });
  sdk.onContext(() => controller.load());
  sdk.onAction(async ({ actionId, context }) => {
    if (actionId !== 'keep') return;
    const translation = context.translationRequestId ? sdk.call('translate_text', { requestId: context.translationRequestId }) : null;
    if (translation) translation.catch(() => {});
    return controller.saveSelection(context.snapshot, { meaning: context.meaning || '', translation });
  });
  void sdk.ready().then(() => controller.load());
})();
