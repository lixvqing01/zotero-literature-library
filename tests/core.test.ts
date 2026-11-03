import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError, credentialDisplay, expiryDates, mineruError, parseDocument, redact, keywordScore } from '../src/core';
import { MinerUClient, safeRemoteURL, validateUploadPDF } from '../src/mineru';
import { rpc } from '../src/agent';
import { CitationBridge } from '../src/citation-bridge';
import { rankDocuments, readFulltext } from '../src/retrieval';
import { canResume, resumedJob, requiresRebuild, displayJobState, isLibraryDocument, UPLOAD_CONFIRMATION_TIMEOUT } from '../src/queue';
import { Library } from '../src/library';
import { Inference } from '../src/inference';
import { summarize } from '../src/store';
import { EmbeddingAPI, embeddingURL } from '../src/embedding-api';
import { AgentInstaller, installClaudeConfig, installCodexBlock } from '../src/agent-installer';
import { posix } from 'node:path';
import { isModelCacheURL } from '../src/models';
import type { DocumentRecord } from '../src/core';
import type { Job } from '../src/store';

function paper(id: string, title: string, vector?: number[], text = 'Evidence on a different topic.'): DocumentRecord {
  return { id, itemKey: id, libraryID: 1, libraryKey: 'library', attachmentKey: `PDF${id}`, title,
    creators: 'Test Author', year: '2026', publication: 'Journal', doi: '', abstract: '', tags: [], collections: [],
    modified: '', state: 'ready', modelFingerprint: 'fixture-model', markdown: '# Methods\n' + text,
    sections: [{ id: 's1', heading: 'Methods', level: 1, kind: 'content', page: 2, text }],
    chunks: [{ id: 'c1', sectionId: 's1', text, page: 2, layer: 'fulltext', vector }] };
}

test('ModelScope model URLs persist in the approved local cache without accepting unrelated hosts', () => {
  assert(isModelCacheURL('https://www.modelscope.cn/models/onnx-community/Qwen3-Embedding-0.6B-ONNX/resolve/master/onnx/model_quantized.onnx'));
  assert(isModelCacheURL('https://hf-mirror.com/Xenova/multilingual-e5-small/resolve/master/tokenizer.json'));
  assert(!isModelCacheURL('https://www.modelscope.cn/Xenova/multilingual-e5-small/resolve/master/config.json'));
  assert(!isModelCacheURL('https://example.com/models/Xenova/multilingual-e5-small/resolve/master/config.json'));
});

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

test('first-time failed and in-progress entries stay in the task queue, while prior successful records remain searchable', async () => {
  const lib: any = Object.create(Library.prototype);
  const docs: any[] = [
    { ...paper('successful', 'Previously indexed'), indexedAt: '2026-01-01' },
    { ...paper('failed', 'First parse failed'), state: 'failed', error: { code: 'MINERU_PARSE_FAILED' } },
    { ...paper('queued', 'Waiting to parse'), state: 'queued' },
    { ...paper('metadata', 'Metadata only'), state: 'metadata' }
  ];
  const jobs: Job[] = [
    { id: 'fail', documentID: 'failed', state: 'failed', attempts: 1, nextRun: 0, createdAt: '', error: { code: 'MINERU_PARSE_FAILED', message: 'failed', retryable: false } },
    { id: 'queue', documentID: 'queued', state: 'queued', attempts: 0, nextRun: 0, createdAt: '' }
  ];
  lib.store = { summaries: async () => docs, jobs: async () => jobs };
  lib.modelFingerprint = () => 'fixture-model';
  const listed = await lib.list();
  assert.deepEqual(listed.map((doc: any) => doc.id), ['successful', 'metadata']);
  assert.equal(isLibraryDocument(docs[1], jobs[0]), false);
  assert.equal(isLibraryDocument(docs[0], jobs[0]), true);
});

function uploadFixture(state = 'queued') {
  const lib: any = Object.create(Library.prototype);
  let doc = { ...paper('upload', 'Upload fixture'), markdown: undefined, pdfHash: undefined, metadataHash: 'metadata-v1' };
  let job: Job = { id: 'upload-job', documentID: doc.id, state, attempts: 0, nextRun: 0, createdAt: '' };
  const calls = { create: 0, upload: 0, poll: [] as string[] };
  let remoteState = 'waiting-file';
  const bytes = new TextEncoder().encode('%PDF-1.7\nfixture bytes\n%%EOF');
  const attachment = { key: doc.attachmentKey, getFilePathAsync: async () => '/fixture/paper.pdf' };
  lib.store = {
    document: async () => structuredClone(doc), jobs: async () => [structuredClone(job)],
    removeDocument: async (id: string) => { assert.match(id, /:metadata$/); },
    putJob: async (value: Job) => { job = structuredClone(value); },
    commit: async (value: any, task: Job) => { doc = structuredClone(value); job = structuredClone(task); }
  };
  lib.resolve = async (_id: number, key: string) => key === doc.attachmentKey ? attachment : {};
  lib.snapshot = async () => ({ ...paper('upload', 'Upload fixture'), markdown: undefined, metadataHash: 'metadata-v1' });
  lib.settings = { cloudEnabled: true, embeddingsEnabled: false, ocr: true };
  lib.hashFile = async () => 'fixture-hash';
  lib.credentials = { read: async () => ({ revision: 1 }) };
  lib.mineru = {
    create: async () => { calls.create++; return { batchID: 'original-batch', uploadURL: 'https://mineru.net/fixture-upload' }; },
    poll: async (batch: string, data: string) => { calls.poll.push(`${batch}:${data}`); return { state: remoteState }; }
  };
  lib.remoteFetch = async (_url: string, options: any) => {
    calls.upload++; assert.deepEqual(options.body, bytes); assert.equal(options.method, 'PUT');
    return { response: { ok: true, status: 200 }, done() {} };
  };
  lib.changed = () => {}; lib.schedule = () => {};
  const root: any = globalThis, originalIO = root.IOUtils;
  root.IOUtils = { exists: async () => true, stat: async () => ({ size: bytes.length }), read: async () => bytes };
  return { lib, calls, bytes, job: () => job, doc: () => doc,
    process: () => lib.process(structuredClone(job)),
    setJob: (change: Partial<Job>) => { job = { ...job, ...change }; },
    setRemote: (state: string) => { remoteState = state; }, restore: () => { root.IOUtils = originalIO; } };
}

test('PDF validation rejects empty, truncated and HTML files before creating a cloud task', async () => {
  const pdf = new TextEncoder().encode('%PDF-1.7\nfixture');
  validateUploadPDF(pdf, pdf.length);
  assert.throws(() => validateUploadPDF(pdf, pdf.length + 1), (e: any) => e.detail.code === 'PDF_READ_INCOMPLETE');
  for (const bytes of [new Uint8Array(), new TextEncoder().encode('<html>Access denied</html>')]) {
    const f = uploadFixture();
    try {
      (globalThis as any).IOUtils.read = async () => bytes;
      (globalThis as any).IOUtils.stat = async () => ({ size: bytes.length });
      await f.process();
      assert.equal(f.job().state, 'failed');
      assert.equal(f.job().error?.code, bytes.length ? 'PDF_INVALID_HEADER' : 'PDF_READ_INCOMPLETE');
      assert.equal(f.calls.create, 0); assert.equal(f.calls.upload, 0);
    } finally { f.restore(); }
  }
});

test('successful upload persists confirmation and waits before the first poll', async () => {
  const f = uploadFixture();
  try {
    const before = Date.now(); await f.process();
    assert.equal(f.calls.create, 1); assert.equal(f.calls.upload, 1); assert.equal(f.calls.poll.length, 0);
    assert.equal(f.job().state, 'pending'); assert.equal(displayJobState(f.job()), 'confirming_upload');
    assert.equal(f.job().uploadHTTPStatus, 200); assert.equal(f.job().pdfBytes, f.bytes.length);
    assert(f.job().uploadCompletedAt! >= before); assert(f.job().nextRun >= before + 3000);
  } finally { f.restore(); }
});

test('repeated waiting-file responses keep the original upload and can advance to parsing', async () => {
  const f = uploadFixture();
  try {
    await f.process(); const identity = `${f.job().batchID}:${f.job().dataID}`;
    const since = f.job().uploadWaitSince;
    for (let i = 0; i < 3; i++) {
      await f.process(); assert.equal(f.job().state, 'pending'); assert.equal(f.job().error, undefined);
      assert.equal(f.job().attempts, 0); assert.equal(f.job().uploadWaitSince, since);
    }
    f.setRemote('running'); await f.process();
    assert.equal(f.job().state, 'running'); assert.equal(displayJobState(f.job()), 'running');
    assert.deepEqual(f.calls.poll, Array(4).fill(identity));
    assert.equal(f.calls.create, 1); assert.equal(f.calls.upload, 1);
  } finally { f.restore(); }
});

test('confirmation timeout can resume only the original cloud task without another upload', async () => {
  const f = uploadFixture();
  try {
    await f.process(); const batch = f.job().batchID, dataID = f.job().dataID;
    f.setJob({ uploadWaitSince: Date.now() - UPLOAD_CONFIRMATION_TIMEOUT - 1 });
    await f.process();
    assert.equal(f.job().state, 'failed'); assert.equal(f.job().error?.code, 'MINERU_UPLOAD_CONFIRMATION_TIMEOUT');
    assert.match(f.job().error!.message, /HTTP 200/); assert.equal(requiresRebuild(f.job()), true);
    assert.equal(canResume(f.job(), 'manual'), true);
    for (const reason of ['credentials', 'cloud', 'model'] as const) {
      assert.equal(canResume(f.job(), reason), false); assert.equal((await f.lib.resume(reason)).resumed, 0);
    }
    assert.equal((await f.lib.resume('manual', f.job().id)).resumed, 1);
    assert.equal(f.job().state, 'pending'); assert.equal(f.doc().error, undefined);
    assert.equal(f.doc().state, 'pending'); assert.equal(f.job().error, undefined);
    assert.equal(f.job().batchID, batch); assert.equal(f.job().dataID, dataID);
    f.setRemote('running'); await f.process();
    assert.equal(f.job().state, 'running'); assert.equal(f.calls.create, 1); assert.equal(f.calls.upload, 1);
  } finally { f.restore(); }
});

test('legacy upload failures resume as polling, while missing remote identity still requires rebuild', () => {
  const job: Job = { id: 'old', documentID: 'paper', state: 'failed', retryState: 'queued',
    attempts: 1, nextRun: 0, createdAt: '', batchID: 'old-batch', dataID: 'old-file', pdfHash: 'old-hash',
    error: { code: 'MINERU_UPLOAD_INCOMPLETE', message: 'Legacy failure', retryable: false } };
  assert.equal(canResume(job, 'manual'), true); assert.equal(requiresRebuild(job), true);
  const resumed = resumedJob(job);
  assert.equal(resumed.state, 'pending'); assert.equal(resumed.error, undefined);
  assert.equal(resumed.batchID, job.batchID); assert.equal(resumed.dataID, job.dataID); assert.equal(resumed.pdfHash, job.pdfHash);
  assert.equal(canResume({ ...job, dataID: undefined }, 'manual'), false);
  assert.equal(canResume({ ...job, batchID: undefined }, 'manual'), false);
});

test('ordinary enqueue and automatic scans cannot rebuild a legacy upload failure', async () => {
  const f = uploadFixture('failed');
  try {
    f.setJob({ batchID: 'legacy-batch', dataID: 'legacy-file', error: {
      code: 'MINERU_UPLOAD_INCOMPLETE', message: 'Legacy failure', retryable: false } });
    f.lib.enqueueChain = Promise.resolve();
    const item = { isAttachment: () => true, getTags: () => [] };
    for (const automatic of [false, true]) {
      const result = await f.lib.enqueueItem(item, false, automatic);
      assert.equal(result[0].state, 'failed'); assert.equal(f.job().batchID, 'legacy-batch');
    }
    assert.equal(f.calls.create, 0); assert.equal(f.calls.upload, 0);
  } finally { f.restore(); }
});

test('interrupted uploads with an existing batch are reconciled without claiming upload success', async () => {
  const f = uploadFixture('pending');
  try {
    f.setJob({ batchID: 'interrupted-batch', dataID: 'interrupted-file' });
    await f.process(); assert.equal(f.job().state, 'pending'); assert.equal(f.job().uploadCompletedAt, undefined);
    f.setJob({ uploadWaitSince: Date.now() - UPLOAD_CONFIRMATION_TIMEOUT - 1 });
    await f.process(); assert.equal(f.job().state, 'failed');
    assert.match(f.job().error!.message, /是否完成尚未确认/); assert.doesNotMatch(f.job().error!.message, /HTTP 200/);
    assert.equal(f.calls.create, 0); assert.equal(f.calls.upload, 0);
  } finally { f.restore(); }
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

test('OpenAI-compatible embedding API validates local endpoints, sorts responses and normalizes vectors', async () => {
  assert.equal(embeddingURL('https://api.example.com/v1/'), 'https://api.example.com/v1/embeddings');
  assert.equal(embeddingURL('https://api.example.com/v1/embeddings'), 'https://api.example.com/v1/embeddings');
  assert.equal(embeddingURL('http://127.0.0.1:9000/v1'), 'http://127.0.0.1:9000/v1/embeddings');
  assert.throws(() => embeddingURL('http://api.example.com/v1'));
  assert.throws(() => embeddingURL('https://user:pass@api.example.com/v1'));
  let sent: any;
  const api = new EmbeddingAPI(async (_url, key, body) => {
    assert.equal(key, 'fixture-embedding-key'); sent = body;
    return { data: [{ index: 1, embedding: [0, 2, 0] }, { index: 0, embedding: [3, 4, 0] }] };
  }, async () => 'fixture-embedding-key');
  const vectors = await api.embed('https://api.example.com/v1', 'fixture-model', ['first', 'second']);
  assert.deepEqual(sent.input, ['first', 'second']);
  assert.deepEqual(vectors[0], [0.6, 0.8, 0]);
  assert.deepEqual(vectors[1], [0, 1, 0]);
});

test('OpenAI-compatible embedding rejects malformed or zero vectors without exposing credentials', async () => {
  const api = new EmbeddingAPI(async () => ({ data: [{ index: 0, embedding: [0, 0] }] }), async () => 'fixture-secret');
  await assert.rejects(api.embed('https://api.example.com/v1', 'fixture', ['text']), (e: any) =>
    e.detail.code === 'EMBEDDING_API_BAD_RESPONSE' && !e.message.includes('fixture-secret'));
  const mismatched = new EmbeddingAPI(async () => ({ data: [] }), async () => 'fixture-secret');
  await assert.rejects(mismatched.embed('https://api.example.com/v1', 'fixture', ['text']),
    (e: any) => e.detail.code === 'EMBEDDING_API_BAD_RESPONSE');
});

test('Agent setup updates only the Literature Library entry and remains idempotent', () => {
  const json = installClaudeConfig(JSON.stringify({ theme: 'dark', mcpServers: { other: { type: 'http', url: 'https://example.com' } } }),
    'http://127.0.0.1:23119/literature-library/mcp', 'fixture-token');
  const parsed = JSON.parse(json);
  assert.equal(parsed.theme, 'dark'); assert.equal(parsed.mcpServers.other.url, 'https://example.com');
  assert.equal(parsed.mcpServers.zotero_literature_library.headers.Authorization, 'Bearer fixture-token');
  assert.throws(() => installClaudeConfig('{bad json', 'http://127.0.0.1/x', 'fixture-token'), /未修改/);
  const toml = '# preserved\n[mcp_servers.other]\nurl = "http://127.0.0.1:9999"\n';
  const once = installCodexBlock(toml, 'http://127.0.0.1:23119/literature-library/mcp', 'fixture-token');
  const twice = installCodexBlock(once, 'http://127.0.0.1:23119/literature-library/mcp', 'fixture-token');
  assert.equal(twice.match(/\[mcp_servers\.zotero_literature_library\]/g)?.length, 1);
  assert(twice.includes('[mcp_servers.other]')); assert(twice.includes('Authorization = "Bearer fixture-token"'));
  const nested = installCodexBlock(`${toml}[mcp_servers.zotero_literature_library.env]\nOLD = "remove"\n[mcp_servers.after]\nvalue = true\n`,
    'http://127.0.0.1:23119/literature-library/mcp', 'fixture-token');
  assert(!nested.includes('OLD = "remove"')); assert(nested.includes('[mcp_servers.after]'));
});

test('Agent config replacement restores the original on write failure and backs it up', async () => {
  const root: any = globalThis, originalIO = root.IOUtils, originalPaths = root.PathUtils;
  const original = JSON.stringify({ theme: 'dark' }), path = '/fixture/.claude.json';
  const files = new Map<string, string>([[path, original]]);
  root.PathUtils = { join: posix.join, parent: posix.dirname };
  root.IOUtils = { exists: async (p: string) => files.has(p), readUTF8: async (p: string) => files.get(p),
    writeUTF8: async (p: string, value: string) => { files.set(p, value); }, makeDirectory: async () => {},
    remove: async (p: string) => { files.delete(p); }, move: async () => { throw Error('fixture write failure'); } };
  try {
    const installer = new AgentInstaller('/fixture', async () => ({ url: 'http://127.0.0.1:23119/mcp', token: 'fixture-token' }));
    await assert.rejects(installer.install('claude-code'), /无法更新/);
    assert.equal(files.get(path), original);
    assert.equal(files.get(path + '.literature-library.bak'), original);
    assert.equal(files.has(path + '.literature-library.tmp'), false);
  } finally { root.IOUtils = originalIO; root.PathUtils = originalPaths; }
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
