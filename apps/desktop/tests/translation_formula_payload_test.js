const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
function functionSource(name, next) {
  const start = source.indexOf(`  ${name === 'requestTranslation' ? 'async ' : ''}function ${name}(`);
  assert.ok(start >= 0);
  return source.slice(start, source.indexOf(`\n  ${next}`, start));
}
const requests = [];
const context = vm.createContext({
  state: { activeJob: { job_id: 'synthetic' } },
  hashText: () => 'hash',
  translationProfileId: () => 'fixture',
  protectSpecialTokens: (text) => ({ text, tokens: [] }),
  cachedTranslation: () => null,
  jsonOptions: (body) => ({ body }),
  api: async (_url, { body }) => { requests.push(JSON.parse(JSON.stringify(body))); return { result: { text: body.text, profile_id: 'fixture' } }; },
  repairFormulaTokens: (text) => text,
  translationCacheFor: () => [],
  setTranslationCacheFor: () => {},
  restoreSpecialTokens: (text) => text,
  restoreInlineMarkers: (text) => text,
  restoreInlineMath: (text) => text,
});
vm.runInContext(`${functionSource('protectInlineMath', 'const SPECIAL_MATH_TOKEN_RE')}\n${functionSource('requestTranslation', 'function insertTranslation')}\nthis.request = requestTranslation;`, context);

(async () => {
  const costs = 'Costs $4.48 ± $1.02 per article and $200 per batch.';
  await context.request(costs, 'paragraph', []);
  assert.equal(requests.at(-1).text, costs);
  assert.deepEqual(requests.at(-1).formulas, []);
  await context.request(costs, null, []);
  assert.equal(requests.at(-1).text, costs, 'Selected visible DOM text also has an authoritative empty math list.');
  assert.deepEqual(requests.at(-1).formulas, []);
  await context.request('Citation __MY_SCHOLAR_MATH_0__ and __MY_SCHOLAR_MATH_1__.', 'mixed', [
    { token: '__MY_SCHOLAR_MATH_0__', tex: '12', markup: '<sup>12</sup>' },
    { token: '__MY_SCHOLAR_MATH_1__', tex: '[公式原图]', markup: '<span class="math-source-visual">[公式原图]</span>' },
  ]);
  assert.deepEqual(requests.at(-1).formulas, [{ token: '__MY_SCHOLAR_MATH_0__', tex: '12' }, { token: '__MY_SCHOLAR_MATH_1__', tex: '[公式原图]' }]);
  await context.request('Legacy $x^2$ survives.');
  assert.equal(requests.at(-1).text, 'Legacy __MY_SCHOLAR_MATH_0__ survives.');
  assert.deepEqual(requests.at(-1).formulas, [{ token: '__MY_SCHOLAR_MATH_0__', tex: 'x^2' }]);
  console.log(JSON.stringify({ translationFormulaPayload: true, authoritativeEmptyParagraph: true, authoritativeEmptySelection: true, mixedSupAndSourceImage: true, legacyRawTex: true, checks: 4 }));
})().catch((error) => { console.error(error); process.exitCode = 1; });
