'use strict';
const assert = require('node:assert/strict');
const { itemImportReason, collectionLabels, resultDescription, batchSummary, shouldPollBatch, buildImportBody, selectionForItems, importChunks } = require('../web/zotero-import.js');

assert.equal(itemImportReason({ attachments: [{ key: 'PDF' }] }), '');
assert.match(itemImportReason({ attachments: [] }), /本机可用的 PDF/u);
assert.equal(itemImportReason({ attachments: [], reason: '附件尚未下载' }), '附件尚未下载');
assert.deepEqual(collectionLabels([
  { key: 'child', name: '子分类', parent_key: 'parent' },
  { key: 'parent', name: '研究', parent_key: null },
  { key: 'orphan', name: '单独分类', parent_key: 'absent' },
]), [{ key: 'child', label: '研究 / 子分类' }, { key: 'parent', label: '研究' }, { key: 'orphan', label: '单独分类' }]);
assert.deepEqual(collectionLabels([{ key: 'a', name: 'A', parent_key: 'b' }, { key: 'b', name: 'B', parent_key: 'a' }]), [{ key: 'a', label: 'B / A' }, { key: 'b', label: 'A / B' }]);
const selected = new Map([
  ['item-1', { item_key: 'item-1', attachment_key: 'pdf-2', title: 'local-only-display' }],
  ['item-3', { item_key: 'item-3', attachment_key: 'pdf-3' }],
]);
assert.deepEqual(buildImportBody('group:7', selected, 'folder-1'), { library: 'group:7', folder_id: 'folder-1', items: [{ item_key: 'item-1', attachment_key: 'pdf-2' }, { item_key: 'item-3', attachment_key: 'pdf-3' }] });
assert.equal(Object.hasOwn(buildImportBody('user:0', selected), 'folder_id'), false);
const pending = { status: 'imported', notes_count: 2, annotations_count: 3, pending: true };
assert.match(resultDescription(pending), /已复制到本机.*2 条笔记.*3 条标注.*正文正在解析/u);
assert.doesNotMatch(resultDescription(pending), /解析已完成/u);
assert.match(resultDescription({ status: 'existing', unanchored_count: 4 }), /已有文献.*4 条标注未能唯一定位.*保留笔记与页码/u);
assert.match(resultDescription({ status: 'failed', error: '无法读取附件' }), /导入失败.*无法读取附件/u);
assert.match(batchSummary({ status: 'running', completed: 1, total: 4 }), /正在复制.*1\/4/u);
assert.match(batchSummary({ status: 'completed', completed: 3, total: 3, results: [pending, { status: 'existing' }, { status: 'failed' }] }), /复制结束.*新增 1 篇.*已有 1 篇.*失败 1 篇.*仍在解析/u);
assert.match(batchSummary({ status: 'failed', completed: 1, total: 3, results: [] }), /批次已停止/u);
assert.equal(shouldPollBatch({ status: 'completed', results: [{ pending: true }] }), true);
assert.equal(shouldPollBatch({ status: 'completed', results: [{ pending: true, error: 'merge failed' }] }), false);
assert.doesNotMatch(resultDescription({ status: 'imported', pending: true, error: '合并失败', warnings: ['需人工检查'] }), /正文正在解析/u);
assert.match(resultDescription({ status: 'existing', warnings: ['需人工检查'] }), /需人工检查/u);
const allSelected = new Map();
const choices = new Map([['MULTI', 'SECOND']]);
assert.deepEqual(selectionForItems([
  { key: 'SINGLE', title: 'Single', attachments: [{ key: 'ONLY' }] },
  { key: 'MULTI', attachments: [{ key: 'FIRST' }, { key: 'SECOND' }] },
  { key: 'AMBIGUOUS', attachments: [{ key: 'A' }, { key: 'B' }] },
  { key: 'MISSING', attachments: [] },
], allSelected, choices), { unavailable: 1, ambiguous: 1 });
assert.equal(allSelected.size, 2);
assert.equal(allSelected.get('MULTI').attachment_key, 'SECOND');
assert.equal(allSelected.get('SINGLE').title, 'Single');
const largeSelection = new Map(Array.from({ length: 205 }, (_, index) => [String(index), { item_key: String(index), attachment_key: `PDF${index}` }]));
assert.deepEqual(importChunks(largeSelection).map((chunk) => chunk.length), [100, 100, 5]);
assert.equal(importChunks(largeSelection).flat().length, largeSelection.size);
console.log('Zotero import UI helpers tests passed');
