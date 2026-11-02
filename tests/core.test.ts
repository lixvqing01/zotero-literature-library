import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError, credentialDisplay, expiryDates, mineruError, parseDocument, redact, keywordScore } from '../src/core';
import { MinerUClient, safeRemoteURL } from '../src/mineru';
import { rpc } from '../src/agent';
import { CitationBridge } from '../src/citation-bridge';
import { rankDocuments, readFulltext } from '../src/retrieval';
import { canResume, resumedJob } from '../src/queue';
import { Library } from '../src/library';
import { Inference } from '../src/inference';
import { summarize } from '../src/store';
import type { DocumentRecord } from '../src/core';

function paper(id: string, title: string, vector?: number[], text = 'Evidence on a different topic.'): DocumentRecord {
  return { id, itemKey: id, libraryID: 1, libraryKey: 'library', attachmentKey: `PDF${id}`, title,
    creators: 'Test Author', year: '2026', publication: 'Journal', doi: '', abstract: '', tags: [], collections: [],
    modified: '', state: 'ready', modelFingerprint: 'fixture-model', markdown: '# Methods\n' + text,
    sections: [{ id: 's1', heading: 'Methods', level: 1, kind: 'content', page: 2, text }],
    chunks: [{ id: 'c1', sectionId: 's1', text, page: 2, layer: 'fulltext', vector }] };
}

test('pure semantic search excludes lexical-only metadata and incompatible vectors', () => {
  const docs = [paper('lexical', 'needle needle', undefined), paper('semantic', 'Other topic', [1, 0]),
    { ...paper('old', 'needle', [1, 0]), modelFingerprint: 'old-model' }];
  const results = rankDocuments(docs, { query: 'needle', mode: 'semantic' }, 'fixture-model', [1, 0]);
  assert.deepEqual(results.map(r => r.document_id), ['semantic']);
  assert.equal(results[0].score_type, 'cosine');
  assert.equal(results[0].page, 2);
});

test('hybrid rank fusion rewards agreement and paper results deduplicate attachments', () => {
  const docs = [paper('lexical', 'needle', [0, 1]), paper('both', 'Other', [0.9, 0.1], 'needle evidence'),
    { ...paper('second-pdf', 'Other', [0.9, 0.1], 'needle evidence'), itemKey: 'both' }];
  const results = rankDocuments(docs, { query: 'needle', mode: 'hybrid' }, 'fixture-model', [1, 0]);
  assert.equal(results[0].document_id, 'both');
  assert.equal(results[0].score_type, 'rrf');
  assert.equal(results.length, 2);
  assert.equal(rankDocuments(docs, { query: 'needle', mode: 'keyword', granularity: 'passages' }, 'fixture-model').length, 3);
});

test('reference-only evidence is excluded and scope restrictions are respected', () => {
  const doc = paper('one', 'needle', [1, 0], 'needle evidence'); doc.sections[0].kind = 'references';
  assert.equal(rankDocuments([doc], { query: 'needle', layer: 'fulltext', mode: 'semantic' }, 'fixture-model', [1, 0]).length, 0);
  assert.equal(rankDocuments([doc], { query: 'needle', layer: 'abstract' }, 'fixture-model').length, 0);
});

test('fulltext pagination reconstructs the section and exact chunks preserve PDF provenance', () => {
  const doc = paper('one', 'Paper', undefined, '中文证据和 supporting evidence. '.repeat(800));
  let offset = 0, complete = '';
  for (;;) {
    const part = readFulltext(doc, { section_id: 's1', offset, max_chars: 12000 });
    complete += part.text;
    if (part.next_offset === null) break;
    offset = part.next_offset;
  }
  assert.equal(complete, '## Methods\n' + doc.sections[0].text);
  const exact = readFulltext(doc, { chunk_id: 'c1', max_chars: 60000 });
  assert.equal(exact.text, doc.chunks[0].text);
  assert.equal(exact.pdf_link, 'zotero://open-pdf/library/items/PDFone?page=2');
  assert.equal(readFulltext(doc, { page: 9 }).matched, false);
  assert.equal(readFulltext(doc, { chunk_id: 'absent' }).text, '');
  assert.throws(() => readFulltext(doc, { page: 0 }));
  assert.throws(() => readFulltext(doc, { offset: Infinity }));
});

test('credential and bulk recovery never resubmit uncertain or unrelated failures', () => {
  const base: any = { id: 'j1', documentID: 'one', state: 'blocked_credentials', retryState: 'download',
    attempts: 3, nextRun: 0, createdAt: '', batchID: 'existing-batch', error: { code: 'MINERU_TOKEN_EXPIRED' } };
  assert.equal(canResume(base, 'credentials'), true);
  assert.equal(canResume({ ...base, state: 'failed' }, 'credentials'), false);
  const resumed = resumedJob(base);
  assert.equal(resumed.state, 'download'); assert.equal(resumed.batchID, 'existing-batch');
  for (const code of ['MINERU_SUBMISSION_UNCERTAIN', 'MINERU_UPLOAD_INCOMPLETE', 'MINERU_TASK_NOT_FOUND']) {
    assert.equal(canResume({ ...base, error: { ...base.error, code } }, 'manual'), false);
    assert.equal(canResume({ ...base, error: { ...base.error, code } }, 'credentials'), false);
  }
});

test('missing vectors trigger an explicit fallback without downloading a model', async () => {
  const lib: any = Object.create(Library.prototype);
  lib.store = { documents: async () => [paper('one', 'needle')] };
  lib.modelFingerprint = () => 'fixture-model'; lib.settings = { model: 'qwen' };
  lib.inference = { embed: () => { throw Error('Should not load a model for an empty vector index'); } };
  const result = await lib.search({ query: 'needle', mode: 'hybrid' });
  assert.equal(result.warning.code, 'INDEX_VECTORS_MISSING');
  assert.equal(result.mode, 'keyword'); assert.equal(result.results.length, 1);
  await assert.rejects(lib.search({ query: 'needle', mode: 'semantic' }), (e: any) => e.detail.code === 'INDEX_VECTORS_MISSING');
});

test('dashboard summaries omit the vector arrays and fulltext payload', () => {
  const summary = summarize(paper('one', 'Paper', Array(1024).fill(0.1), 'Evidence'.repeat(10000)));
  assert.equal(summary.hasVectors, true); assert.equal(summary.hasFulltext, true);
  assert(!('chunks' in summary)); assert(!('sections' in summary)); assert(!('markdown' in summary));
  assert(JSON.stringify(summary).length < 1000);
});

test('failed inference host initialization can be retried without restarting Zotero', async () => {
  const root: any = globalThis;
  root.Services = { uuid: { generateUUID: () => ({ toString: () => 'fixture-token' }) } };
  let attempts = 0; const listeners = new Set<any>();
  const frame: any = { style: {}, addEventListener() {}, remove() {}, src: '', contentWindow: {
    location: { hash: '#fixture-token' }, postMessage(data: any) { queueMicrotask(() => {
      for (const fn of listeners) fn({ data: { ...data, source: 'literature-inference', vectors: [[1, 0]] } });
    }); }
  } };
  const win: any = { setTimeout: (fn: any, ms: number) => setTimeout(fn, ms === 30000 ? 5 : ms), clearTimeout,
    addEventListener: (_name: string, fn: any) => listeners.add(fn), removeEventListener: (_name: string, fn: any) => listeners.delete(fn),
    document: { createElementNS: () => frame, documentElement: { append() { if (++attempts > 1) queueMicrotask(() => {
      for (const fn of listeners) fn({ data: { bridgeToken: 'fixture-token', source: 'literature-inference', ready: true } });
    }); } } } };
  const inference = new Inference(win, win, () => {}, 'fixture-cache');
  try {
    await assert.rejects(inference.embed('qwen', ['test']), /未就绪/);
    assert.deepEqual(await inference.embed('qwen', ['test']), [[1, 0]]);
  } finally { inference.close(); }
});

test('HTTP 200 with A0211 remains a non-retryable expired-credential failure', () => {
  const error = mineruError(200, { code: 'A0211', msg: 'Token expired' });
  assert.equal(error?.detail.code, 'MINERU_TOKEN_EXPIRED');
  assert.equal(error?.detail.requires_user_action, true);
  assert.equal(error?.detail.retryable, false);
  assert.equal(mineruError(200, { code: 'A0202' })?.detail.code, 'MINERU_TOKEN_INVALID');
  assert.equal(mineruError(403, {})?.detail.code, 'MINERU_AUTH_FAILED');
  assert.equal(mineruError(429, {})?.detail.code, 'MINERU_RATE_LIMITED');
  assert.equal(mineruError(200, { code: 0 }), null);
});
test('expiry originates from issue date rather than the date of saving', () => {
  assert.throws(() => expiryDates('2026-02-31', null));
  assert.equal(expiryDates('2026-08-01', null).expiresAt, '2026-10-30');
  const unknown = credentialDisplay({ state: 'configured', revision: 1, issuedAt: null, expiresAt: null, checkedAt: null });
  assert.equal(unknown.daysRemaining, null);
  const estimate = credentialDisplay({ state: 'valid', revision: 1, issuedAt: '2026-08-01', expiresAt: '2026-10-30', checkedAt: null }, Date.parse('2026-11-01'));
  assert.equal(estimate.state, 'valid');
  assert.equal(estimate.estimatedExpired, true);
});
test('native citation handoff preselects only new citations and restores the original integration function', async () => {
  const root: any = globalThis, seen: any[] = [];
  root.Services = { uuid: { generateUUID: () => ({ toString: () => 'fixture-request' }) } };
  const original = async (_url: any, _options: any, io: any) => { seen.push(io.citation.citationItems); };
  root.Zotero = { Integration: { displayDialog: original, currentDoc: false } };
  const lib: any = { store: { document: async () => ({ title: 'Paper', libraryID: 1, itemKey: 'KEY' }) },
    resolve: async () => ({ id: 1, isRegularItem: () => true }), changed() {} };
  const bridge = new CitationBridge(lib); bridge.install();
  try {
    const prepared: any = await bridge.prepare({ document_ids: ['d1', 'd1'] });
    assert.equal(prepared.inserted, false);
    const edited = { citation: { citationItems: [{ id: 2 }] }, promise: Promise.resolve() };
    await root.Zotero.Integration.displayDialog('chrome://zotero/content/integration/citationDialog.xhtml', '', edited, 'citation');
    assert.deepEqual(edited.citation.citationItems, [{ id: 2 }]);
    assert.equal(bridge.status().state, 'prepared');
    const fresh = { citation: { citationItems: [] }, promise: Promise.resolve() };
    await root.Zotero.Integration.displayDialog('chrome://zotero/content/integration/citationDialog.xhtml', '', fresh, 'citation');
    assert.deepEqual(fresh.citation.citationItems, [{ id: 1 }]);
    assert.equal(bridge.status().state, 'native_dialog_accepted');
  } finally { bridge.close(); assert.equal(root.Zotero.Integration.displayDialog, original); }
});
test('MinerU errors preserve the revision captured before a request', async () => {
  const reported: any[] = [];
  let revision = 1;
  const client = new MinerUClient(async () => { revision = 2; return { status: 200, body: { code: 'A0211' } }; },
    async () => ({ key: 'fixture-only-not-a-real-key', revision }), async (rev, err) => { reported.push([rev, err?.detail.code]); });
  await assert.rejects(client.create('paper.pdf', 'fixture', true), (error: any) => error.detail.code === 'MINERU_TOKEN_EXPIRED');
  assert.deepEqual(reported, [[1, 'MINERU_TOKEN_EXPIRED']]);
});
test('structure parser preserves PDF page provenance and marks bibliography', () => {
  const parsed = parseDocument('# Paper\ntext', [
    { type: 'text', text_level: 1, text: 'Methods', page_idx: 0 },
    { type: 'text', text: 'First-page evidence.', page_idx: 0 },
    { type: 'text', text: 'Second-page evidence.', page_idx: 1 },
    { type: 'text', text_level: 1, text: 'References', page_idx: 2 },
    { type: 'text', text: 'A bibliography entry.', page_idx: 2 }
  ]);
  assert.deepEqual(parsed.chunks.map(c => c.page), [1, 2, 3]);
  assert.equal(parsed.sections[2].kind, 'references');
  assert.equal(parseDocument('# Unknown\nNo page information.').chunks[0].page, null);
});
test('resource URLs cannot carry credentials or escape to unrelated hosts', () => {
  assert.throws(() => safeRemoteURL('http://mineru.net/file'));
  assert.throws(() => safeRemoteURL('https://attacker.invalid/file'));
  assert.throws(() => safeRemoteURL('https://user:secret@mineru.net/file'));
  assert.equal(safeRemoteURL('https://cdn-mineru.openxlab.org.cn/result.zip'), 'https://cdn-mineru.openxlab.org.cn/result.zip');
});
test('redaction strips API tokens and signed URLs from diagnostics', () => {
  const result = redact('Bearer fixture-secret https://mineru.net/file?signature=hidden sk-' + 'x'.repeat(25));
  assert(!result.includes('fixture-secret')); assert(!result.includes('signature')); assert(!result.includes('x'.repeat(25)));
});
test('Chinese keyword search does not assume English whitespace tokens', () => {
  assert(keywordScore('中文文献', '用于中文文献检索') > 0);
});
test('MCP initialization, notifications, unknown tools and actionable credential errors', async () => {
  const fake: any = { status: async () => ({ credentials: { state: 'expired' } }),
    search: async () => { throw new AppError({ code: 'MINERU_TOKEN_EXPIRED', message: 'Expired', retryable: false, requires_user_action: true }); } };
  const initialized = await rpc(fake, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(initialized.result.protocolVersion, '2025-06-18');
  assert.equal(await rpc(fake, { jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const failed = await rpc(fake, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'literature_search', arguments: { query: 'x' } } });
  assert.equal(failed.result.isError, true);
  assert.equal(failed.result.structuredContent.error.code, 'MINERU_TOKEN_EXPIRED');
  const unknown = await rpc(fake, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'unknown' } });
  assert.equal(unknown.error.code, -32602);
});
