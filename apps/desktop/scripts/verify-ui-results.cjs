'use strict';

const fs = require('fs');
const path = require('path');
const { tests, selectTests } = require('../tests/ui-test-plan.cjs');

function verifyReports(reports, expectedShards) {
  if (!Number.isSafeInteger(expectedShards) || expectedShards < 1) throw new Error('EXPECTED_SHARDS must be a positive integer');
  if (reports.length !== expectedShards) throw new Error(`Expected ${expectedShards} shard reports, found ${reports.length}`);
  const ciTests = tests.filter(([, , meta]) => meta.ci);
  const seenShards = new Set();
  const seenSuites = new Set();
  for (const report of reports) {
    const index = report.shard?.index;
    if (report.schemaVersion !== 1 || report.ciOnly !== true || report.complete !== true || report.error !== null) {
      throw new Error('UI report is failed, incomplete, or not a CI report');
    }
    if (!Number.isSafeInteger(index) || index < 1 || index > expectedShards || report.shard.total !== expectedShards || seenShards.has(index)) {
      throw new Error(`Invalid or duplicate UI shard: ${index}`);
    }
    seenShards.add(index);
    const expected = selectTests(['--ci', `--shard=${index}/${expectedShards}`], {}).selected;
    if (!Array.isArray(report.expectedSuites) || JSON.stringify(report.expectedSuites) !== JSON.stringify(expected.map(([name]) => name))) {
      throw new Error(`UI shard ${index} has an incorrect suite plan`);
    }
    if (!Array.isArray(report.results) || report.results.length !== expected.length) throw new Error(`UI shard ${index} has missing or extra results`);
    const expectedScripts = new Map(expected.map(([name, script]) => [name, script]));
    for (const result of report.results) {
      if (!result || !expectedScripts.has(result.name) || expectedScripts.get(result.name) !== result.script || seenSuites.has(result.name)) {
        throw new Error(`Unexpected or duplicate UI suite: ${result?.name}`);
      }
      if (result.passed !== true || result.status !== 0 || result.signal !== null || result.error !== null
        || !Number.isFinite(result.durationMs) || result.durationMs < 0) {
        throw new Error(`UI suite did not pass: ${result.name}`);
      }
      seenSuites.add(result.name);
    }
  }
  if (seenSuites.size !== ciTests.length || ciTests.some(([name]) => !seenSuites.has(name))) throw new Error('UI CI suite coverage is incomplete');
  return { shards: seenShards.size, suites: seenSuites.size };
}

function readReports(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) return readReports(filename);
    return entry.isFile() && entry.name.endsWith('.json') ? [JSON.parse(fs.readFileSync(filename, 'utf8'))] : [];
  });
}

if (require.main === module) {
  try {
    const [directory, count, ...extra] = process.argv.slice(2);
    if (!directory || !/^[1-9]\d*$/.test(count || '') || extra.length) throw new Error('Usage: node scripts/verify-ui-results.cjs DIRECTORY EXPECTED_SHARDS');
    const result = verifyReports(readReports(directory), Number(count));
    console.log(`UI results verified: ${result.shards} shards, ${result.suites} suites passed`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { verifyReports, readReports };
