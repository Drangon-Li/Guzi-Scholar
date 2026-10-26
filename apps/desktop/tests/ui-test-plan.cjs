'use strict';

// Every suite runs against the synthetic library produced by
// tests/fixtures/seed_library.py. The reader suites assert on fixed block ids,
// verbatim sentences and an exact document census, so the fixture reproduces
// that shape deliberately -- see the comments in seed_library.py.
const tests = [
  ['document', 'web_smoke.js', { ci: true }],
  ['features', 'feature_smoke.js', { ci: true }],
  ['ai-controls', 'ai_controls_smoke.js', { ci: true }],
  ['vocabulary', 'vocabulary_smoke.js', { ci: true }],
  ['plugin-market', 'plugin_market_smoke.js', { ci: true }],
  ['notes-revision', 'notes_revision_smoke.js', { ci: true }],
  ['zotero-import', 'zotero_import_smoke.js', { ci: true }],
  ['zotero-note-markers', 'zotero_note_markers_smoke.js', { ci: true }],
  ['zotero-anchor-mapping', 'zotero_anchor_mapping_smoke.js', { ci: true }],
  ['translation', 'translation_smoke.js', { ci: true }],
  ['translation-controls', 'translation_controls_smoke.js', { ci: true }],
  ['math-typography', 'math_typography_smoke.js', { ci: true }],
  ['chat-math', 'chat_math_rendering_test.js', { ci: true }],
  ['reader-experience', 'reader_experience_smoke.js', { ci: true }],
  ['sentence-translation', 'sentence_translation_smoke.js', { ci: true }],
  ['reader-copy', 'reader_copy_test.js', { ci: true }],
  ['translation-annotation', 'translation_annotation_test.js', { ci: true }],
  ['annotation-colors', 'annotation_colors_smoke.js', { ci: true }],
  ['annotation-hover', 'annotation_hover_smoke.js', { ci: true }],
  ['reader-transition', 'reader_transition_smoke.js', { ci: true }],
  ['reader-keepalive', 'reader_keepalive_smoke.js', { ci: true }],
  ['reader-memory', 'reader_memory_smoke.js', { ci: true }],
  ['reader-switch-performance', 'reader_switch_performance_smoke.js', { ci: true }],
  ['navigation-performance', 'navigation_performance_smoke.js', { ci: true }],
  ['citations', 'citation_anchor_smoke.js', { ci: true }],
  ['library', 'library_smoke.js', { ci: true }],
  ['library-v3', 'library_v3_smoke.js', { ci: true }],
  ['interactions', 'interaction_regression.js', { ci: true }],
  ['library-v4', 'library_interactions_v4.js', { ci: true }],
  ['reading-progress', 'reading_progress_retirement_smoke.js', { ci: true }],
  ['graph', 'graph_ui_smoke.js', { ci: true }],
  ['onboarding', 'onboarding_smoke.js', { ci: true }],
];


function selectTests(args, env = process.env) {
  const ciOnly = args.includes('--ci')
    || ['1', 'true', 'yes'].includes(String(env.MY_SCHOLAR_UI_CI || '').toLowerCase());
  const only = args.find((arg) => arg.startsWith('--only='))?.slice('--only='.length) || '';
  if (only && !tests.some(([name]) => name === only)) throw new Error(`Unknown UI suite: ${only}`);
  const shardArgs = args.filter((arg) => arg === '--shard' || arg.startsWith('--shard='));
  let shard = { index: 1, total: 1 };
  if (shardArgs.length) {
    const match = shardArgs.length === 1 && /^--shard=([1-9]\d*)\/([1-9]\d*)$/.exec(shardArgs[0]);
    if (!match) throw new Error('UI shard must use --shard=INDEX/TOTAL (1-based integers)');
    shard = { index: Number(match[1]), total: Number(match[2]) };
    if (!Number.isSafeInteger(shard.index) || !Number.isSafeInteger(shard.total) || shard.index > shard.total) {
      throw new Error('UI shard index must be within 1..TOTAL');
    }
  }
  const eligible = tests.filter(([name, , meta]) => (!ciOnly || meta.ci) && (!only || name === only));
  const selected = eligible.filter((_, index) => index % shard.total === shard.index - 1);
  if (!selected.length) throw new Error(`UI shard ${shard.index}/${shard.total} selects no suites`);
  return { ciOnly, shard, selected };
}

module.exports = { tests, selectTests };
