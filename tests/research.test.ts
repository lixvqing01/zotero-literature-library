import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { writeFile } from 'node:fs/promises';
import { AppError, normalizeYear, parseDocument, sectionRole, type DocumentRecord } from '../src/core';
import { SearchEngine, projectDocument, searchTokens } from '../src/search-engine';
import { SearchService } from '../src/search-service';
import { ResearchWorkspaces } from '../src/research';
import { Store } from '../src/store';
import { Library } from '../src/library';
import { logicalOutline, readFulltext } from '../src/retrieval';
import { PriorityQueue } from '../src/priority-queue';
import { rpc, TOOLS } from '../src/agent';

function paper(id: string, abstract = 'Rare earth redistribution in marine sediments.', body = 'Diagenesis transfers REY from oxides to apatite.'): DocumentRecord {
  const parsed = parseDocument('', [
    { type: 'text', text_level: 1, text: '3. Results', page_idx: 2 },
    { type: 'text', text: body, page_idx: 2 },
    { type: 'text', text: 'The neighboring paragraph constrains the sediment redox conditions.', page_idx: 3 },
    { type: 'text', text_level: 1, text: 'I. References', page_idx: 4 },
    { type: 'text', text: 'A quoted paper about mythical unicorn mineral transformations.', page_idx: 4 },
    { type: 'text', text: 'Another citation about unicorn mineral transformations.', page_idx: 5 }
  ]);
  return { id, itemKey: id, libraryID: 1, libraryKey: 'library', attachmentKey: `PDF${id}`, title: `Marine REY study ${id}`,
    creators: 'Li, Wang', year: '2021', publication: 'Chemical Geology', doi: `10.1000/${id}`, abstract,
    tags: ['REY'], collections: ['MARINE'], modified: '2026-11-04', indexedAt: '2026-11-04', state: 'ready',
    modelFingerprint: 'model-v1', markdown: '# Results\n' + body, ...parsed,
    chunks: [{ id: 'metadata', sectionId: 'metadata', layer: 'metadata', text: `Marine REY study ${id}`, page: null, vector: [1, 0] },
      ...(abstract ? [{ id: 'abstract', sectionId: 'abstract', layer: 'abstract' as const, text: abstract, page: null, vector: [1, 0] }] : []),
      ...parsed.chunks.map(c => ({ ...c, vector: [1, 0] }))] };
}
function engineWith(docs: DocumentRecord[], revision = 1) {
  const engine = new SearchEngine(), values = docs.map(projectDocument);
  engine.apply({ revision, documents: values.map(p => p.document), blocks: values.flatMap(p => p.blocks), reset: true });
  engine.loadVectors('fixture', values.flatMap(p => p.vectors)); return engine;
}
function databaseFixture(legacy?: DocumentRecord) {
  const database = new DatabaseSync(':memory:'), statements: string[] = [];
  if (legacy) { database.exec('CREATE TABLE documents(id TEXT PRIMARY KEY,data TEXT NOT NULL)'); database.prepare('INSERT INTO documents VALUES (?,?)').run(legacy.id, JSON.stringify(legacy)); }
  const previous = Object.fromEntries(['Zotero', 'IOUtils', 'PathUtils'].map(key => [key, (globalThis as any)[key]]));
  const adapter = {
    queryAsync: async (sql: string, params: any[] = []) => { statements.push(sql); const statement = database.prepare(sql); return statement.columns().length ? statement.all(...params) : statement.run(...params); },
    valueQueryAsync: async (sql: string, params: any[] = []) => { statements.push(sql); const row = database.prepare(sql).get(...params); return row ? Object.values(row)[0] : null; },
    columnQueryAsync: async (sql: string, params: any[] = []) => { statements.push(sql); return database.prepare(sql).all(...params).map(row => Object.values(row)[0]); },
    executeTransaction: async (run: () => Promise<any>) => { database.exec('BEGIN'); try { const result = await run(); database.exec('COMMIT'); return result; } catch (error) { database.exec('ROLLBACK'); throw error; } },
    closeDatabase: async () => database.close()
  };
  (globalThis as any).Zotero = { DBConnection: function () { return adapter; } };
  (globalThis as any).IOUtils = { makeDirectory: async () => {} };
  (globalThis as any).PathUtils = { join: (...parts: string[]) => parts.join('/') };
  const store = new Store('/fixture');
  const engines = new Map<string, SearchEngine>();
  const transport = { call: async (data: any) => {
    let engine = engines.get(data.group); if (!engine) { engine = new SearchEngine(); engines.set(data.group, engine); }
    if (data.action === 'apply') return engine.apply(data.value);
    if (data.action === 'restore') return engine.restore(data.value);
    if (data.action === 'dump') return engine.dump();
    if (data.action === 'vectors') return engine.loadVectors(data.key, data.value);
    if (data.action === 'search') return engine.search(data.input, data.fingerprint, data.vector);
    throw Error('Unexpected transport action');
  }, close: () => engines.clear() };
  let uuid = 0, embeddingCalls = 0;
  const lib: any = Object.create(Library.prototype);
  Object.assign(lib, { store, searchService: new SearchService(store, transport), researchService: new ResearchWorkspaces(store, () => `workspace-${++uuid}`),
    changed: () => {}, researchRevision: 0,
    modelFingerprint: () => 'model-v1', settings: { embeddingProvider: 'local' }, credentials: { status: () => ({ state: 'valid' }) }, inference: { state: { state: 'ready' } },
    embedTexts: async () => { embeddingCalls++; return [[1, 0]]; } });
  return { store, lib, statements, database, embeddings: () => embeddingCalls, transport,
    restore: async () => { lib.searchService.close(); await store.close(); Object.assign(globalThis, previous); } };
}

test('numbered reference headings, continuation pages, roles and non-ISO dates normalize without invented years', () => {
  for (const name of ['I. References', '12. Bibliography', 'VII References', '参考文献', '4.2 References']) assert.equal(sectionRole(name), 'references');
  const doc = paper('a'); assert.equal(doc.sections.filter(s => s.kind === 'references').length, 2);
  const outline = logicalOutline(doc); assert.equal(outline.length, 2); assert.deepEqual(outline[0].pages, [3, 4]);
  const parent = readFulltext(doc, { section_id: outline[0].id }); assert.match(parent.text, /neighboring/); assert.doesNotMatch(parent.text, /unicorn/);
  const evidence = readFulltext(doc, { chunk_id: 'c0', neighbors: 2 }); assert.deepEqual(evidence.chunks.map(c => c.page), [3, 4]); assert.doesNotMatch(evidence.text, /unicorn/);
  assert.equal(normalizeYear('08/21/2017'), '2017'); assert.equal(normalizeYear('08/2'), ''); assert.equal(normalizeYear('12021'), '');
});

test('BM25 discovery is abstract-first, exact scientific tokens and strict filters work, fulltext excludes bibliography', () => {
  const doc = paper('a', '稀土元素在成岩作用中发生迁移。 Nd Ni REY marine sediment.'), other = paper('b', 'Unrelated abstract', 'Unicorn mineral transformations.');
  other.tags = ['other']; other.collections = ['OTHER']; other.year = '2010';
  const engine = engineWith([doc, other]);
  assert.equal(engine.search({ query: 'unicorn', layer: 'auto' }, 'model-v1').results.length, 0);
  assert.deepEqual(engine.search({ query: 'unicorn', layer: 'fulltext' }, 'model-v1').results.map(r => r.document_id), ['b']);
  assert.equal(engine.search({ query: 'unicorn', layer: 'fulltext', include_references: true, granularity: 'passages' }, 'model-v1').results.length, 5);
  assert.equal(engine.search({ query: '成岩作用', layer: 'abstract' }, 'model-v1').results[0].document_id, 'a');
  assert.equal(engine.search({ query: 'Nd Ni', operator: 'AND', layer: 'abstract', filters: { tags: ['REY'], collection_keys: ['MARINE'], year_from: 2020, author: 'Li' } }, 'model-v1').results.length, 1);
  assert.equal(engine.search({ query: 'Nd', boolean: { not: ['Ni'] } }, 'model-v1').results.length, 0);
  assert.equal(engine.search({ query: 'marine', boolean: { phrases: ['marine sediment'] } }, 'model-v1').results.length, 1);
  assert.equal(engine.search({ query: 'marine', scope: { document_ids: [] } }, 'model-v1').results.length, 0);
  assert.deepEqual(searchTokens('REY REY Nd Ni'), ['rey', 'rey', 'nd', 'ni']);
  assert.deepEqual(searchTokens('REY. Nd-143; Fe-Mn.'), ['rey', 'nd-143', 'fe-mn']);
});

test('semantic recall stays independent of lexical matches and paper collapse does not reward long attachments', () => {
  const docs = [paper('a'), { ...paper('a2'), itemKey: 'a' }, paper('b')];
  const engine = engineWith(docs);
  const semantic = engine.search({ query: 'no shared vocabulary', mode: 'semantic', layer: 'abstract' }, 'model-v1', [1, 0]);
  assert.equal(semantic.results.length, 2); assert(semantic.results.every(r => r.score_type === 'cosine'));
  assert.equal(engine.search({ query: 'no shared vocabulary', mode: 'semantic', layer: 'abstract' }, 'changed-model', [1, 0]).results.length, 0);
  assert.equal(engine.search({ query: 'REY', mode: 'hybrid', layer: 'abstract', scope: { document_ids: ['b'] } }, 'model-v1', [1, 0]).results.length, 1);
});

test('stable cursors survive repeat searches, reject changed scope and revision, snapshots restore exact rankings', () => {
  const engine = engineWith(Array.from({ length: 8 }, (_, i) => paper(`d${i}`)));
  const input = { query: 'REY', top_k: 2, layer: 'auto', mode: 'keyword' };
  const seen = new Set<string>(); let cursor: string | null = null;
  do { const page = engine.search({ ...input, ...(cursor ? { cursor } : {}) }, 'model-v1'); for (const r of page.results) { assert(!seen.has(r.document_id)); seen.add(r.document_id); } cursor = page.next_cursor; } while (cursor);
  assert.equal(seen.size, 8);
  const first = engine.search(input, 'model-v1'), restored = new SearchEngine(); restored.restore(engine.dump());
  assert.deepEqual(restored.search(input, 'model-v1').results, first.results);
  assert.throws(() => engine.search({ ...input, scope: { document_ids: ['d1'] }, cursor: first.next_cursor }, 'model-v1'), (e: any) => e.detail.code === 'SEARCH_CURSOR_INVALID');
  engine.apply({ revision: 2, removed: ['d0'], documents: [], blocks: [] });
  assert.throws(() => engine.search({ ...input, cursor: first.next_cursor }, 'model-v1'), AppError);
});

test('legacy SQLite migration is local, restartable and atomically maintains projections and vector separation', async () => {
  const legacy = paper('old'), fixture = databaseFixture(legacy);
  try {
    await fixture.store.init(); const revision = await fixture.store.searchRevision();
    assert(revision > 0); assert.deepEqual((await fixture.store.document('old'))?.chunks, legacy.chunks);
    const bundle = await fixture.store.searchBundle('discovery'); assert(bundle.blocks.every(b => b.layer !== 'fulltext')); assert(!JSON.stringify(bundle).includes('"vector":'));
    assert.equal((await fixture.store.searchVectors('abstract', 'model-v1', ['old'])).length, 1);
    await fixture.store.init(); assert.equal(await fixture.store.searchRevision(), revision);
    await fixture.store.putDocument(paper('new')); const changed = await fixture.store.searchBundle('discovery', revision); assert.deepEqual(changed.documents.map(d => d.id), ['new']);
    fixture.statements.length = 0;
    await fixture.lib.search({ query: 'REY' }); await fixture.lib.read({ document_ids: ['old', 'new'], layer: 'abstract' });
    assert(!fixture.statements.some(s => /^SELECT data FROM documents/.test(s)), 'discovery and abstract reads must not load full documents');
    await fixture.store.removeDocument('new'); assert.equal(await fixture.store.searchDocument('new'), null);
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS n FROM search_vectors WHERE document_id=?').get('new')!.n, 0);
    const result = await fixture.lib.search({ query: 'REY' }); assert.deepEqual(result.results.map((r: any) => r.document_id), ['old']);
  } finally { await fixture.restore(); }
});

test('three-theme research workflow supports batches, screening, scoped evidence, query traces, gaps and source changes', async () => {
  const fixture = databaseFixture();
  try {
    await fixture.store.init();
    await fixture.store.putDocument(paper('diagenesis'));
    await fixture.store.putDocument(paper('methods', 'Sequential extraction identifies mineral carriers.', 'Methods quantify Nd with sequential extraction.'));
    await fixture.store.putDocument(paper('missing', '', 'A counterexample describes REY release without oxide dissolution.'));
    const workspace = await fixture.lib.workspace({ action: 'create', title: 'Marine REY review' });
    for (const theme of ['carriers', 'methods', 'counterexamples']) await fixture.lib.workspace({ action: 'upsert_theme', workspace_id: workspace.id, theme_id: theme, title: theme });
    const batch = await fixture.lib.search({ queries: [
      { query_id: 'q1', theme_id: 'carriers', query: 'rare earth', layer: 'abstract' },
      { query_id: 'q2', theme_id: 'methods', query: 'sequential extraction', layer: 'abstract' },
      { query_id: 'q3', theme_id: 'counterexamples', query: 'counterexample', layer: 'fulltext' },
      { query_id: 'invalid', query: '', layer: 'abstract' }
    ] });
    assert.equal(batch.partial, true); assert.equal(batch.queries[0].results[0].document_id, 'diagenesis');
    assert.equal(batch.queries[1].results[0].document_id, 'methods'); assert.equal(batch.queries[2].results[0].document_id, 'missing'); assert(batch.queries[3].error);
    const read = await fixture.lib.read({ document_ids: ['diagenesis', 'methods', 'missing'], layer: 'abstract', max_chars: 5000 });
    assert.equal(read.results.length, 3); assert.equal(read.results[2].missing, true); assert(read.used_chars <= 5000);
    await fixture.lib.workspace({ action: 'update_candidates', workspace_id: workspace.id, theme_id: 'carriers', candidates: [
      { document_id: 'diagenesis', status: 'included', reason: 'Relevant original abstract', read_layers: ['abstract'] },
      { document_id: 'methods', status: 'excluded', reason: 'Methods theme only' }
    ] });
    const scoped = await fixture.lib.search({ query: 'REY', layer: 'fulltext', granularity: 'passages', scope: { workspace_id: workspace.id, theme_id: 'carriers' } });
    assert(scoped.results.length); assert(scoped.results.every((r: any) => r.document_id === 'diagenesis'));
    const hit = scoped.results[0], exact = await fixture.lib.read({ document_id: hit.document_id, layer: 'fulltext', chunk_id: hit.chunk_id, neighbors: 1 });
    assert.match(exact.text, /neighboring/); assert.equal(exact.chunks[0].page, 3); assert.doesNotMatch(exact.text, /unicorn/);
    await fixture.lib.workspace({ action: 'save_evidence', workspace_id: workspace.id, theme_id: 'carriers', document_id: hit.document_id,
      chunk_id: hit.chunk_id, version: hit.version, claim: 'Carrier transfer under diagenesis', stance: 'supports' });
    let theme = await fixture.lib.workspace({ action: 'get', workspace_id: workspace.id, theme_id: 'carriers' });
    assert.equal(theme.evidence[0].page, 3); assert.equal(theme.queries.length, 1); assert.equal(theme.candidates[0].changed, false);
    const reopened = new ResearchWorkspaces(fixture.store);
    const persisted = await reopened.call({ action: 'get', workspace_id: workspace.id, theme_id: 'carriers' });
    assert.equal(persisted.evidence[0].chunk_id, hit.chunk_id); assert.equal(persisted.candidates[0].status, 'included');
    const gaps = await fixture.lib.search({ query: 'counterexample', layer: 'fulltext', scope: { exclude_document_ids: ['diagenesis', 'methods'] } });
    assert.equal(gaps.results[0].document_id, 'missing');
    await fixture.store.putDocument({ ...paper('diagenesis'), modified: '2026-11-05' });
    theme = await fixture.lib.workspace({ action: 'get', workspace_id: workspace.id, theme_id: 'carriers' });
    assert.equal(theme.candidates[0].changed, true); assert.equal(theme.evidence[0].changed, true);
    await assert.rejects(fixture.lib.workspace({ action: 'save_evidence', workspace_id: workspace.id, theme_id: 'carriers', document_id: hit.document_id, chunk_id: hit.chunk_id,
      version: hit.version, claim: 'Old evidence', stance: 'supports' }), (e: any) => e.detail.code === 'EVIDENCE_CHANGED');
    await fixture.store.removeDocument('diagenesis');
    theme = await fixture.lib.workspace({ action: 'get', workspace_id: workspace.id, theme_id: 'carriers' }); assert.equal(theme.evidence[0].missing, true);
  } finally { await fixture.restore(); }
});

test('failed projection writes roll back the complete source transaction, preserving the last successful index', async () => {
  const fixture = databaseFixture(paper('safe'));
  try {
    await fixture.store.init(); const revision = await fixture.store.searchRevision();
    const original = fixture.store.db.queryAsync;
    fixture.store.db.queryAsync = async (sql: string, params: any[]) => {
      if (sql.startsWith('INSERT INTO search_blocks')) throw Error('Simulated disk write failure');
      return original(sql, params);
    };
    await assert.rejects(fixture.store.putDocument({ ...paper('safe'), title: 'Uncommitted title' }));
    fixture.store.db.queryAsync = original;
    assert.equal((await fixture.store.document('safe'))?.title, 'Marine REY study safe');
    assert.equal((await fixture.store.searchDocument('safe'))?.title, 'Marine REY study safe');
    assert.equal(await fixture.store.searchRevision(), revision);
    const results = await fixture.lib.search({ query: 'REY' }); assert.equal(results.results[0].title, 'Marine REY study safe');
  } finally { await fixture.restore(); }
});

test('semantic search retries an index revision change during vector loading instead of mixing corpus versions', async () => {
  const fixture = databaseFixture(paper('a'));
  try {
    await fixture.store.init(); let changed = false;
    const original = fixture.store.searchVectors.bind(fixture.store);
    fixture.store.searchVectors = async (...args) => {
      const vectors = await original(...args);
      if (!changed) { changed = true; await fixture.store.putDocument(paper('b')); }
      return vectors;
    };
    const result = await fixture.lib.search({ query: 'different wording', layer: 'abstract', mode: 'semantic' });
    assert.equal(result.results.length, 2); assert.equal(result.snapshot, await fixture.store.searchRevision());
  } finally { await fixture.restore(); }
});

test('query embedding reuse, empty scopes, validation, abstract budgets and compact status keep agent calls bounded', async () => {
  const fixture = databaseFixture();
  try {
    await fixture.store.init(); for (let i = 0; i < 12; i++) await fixture.store.putDocument(paper(`p${i}`, 'Long REY abstract. '.repeat(1000)));
    await fixture.lib.search({ query: 'rare earth', layer: 'abstract', mode: 'hybrid' });
    await fixture.lib.search({ query: 'rare earth', layer: 'fulltext', mode: 'hybrid' }); assert.equal(fixture.embeddings(), 1);
    await fixture.lib.search({ query: 'new wording', mode: 'semantic', scope: { document_ids: [] } }); assert.equal(fixture.embeddings(), 1);
    const read = await fixture.lib.read({ document_ids: Array.from({ length: 12 }, (_, i) => `p${i}`), max_chars: 5000 });
    assert(read.used_chars <= 5000); assert(read.remaining_document_ids.length); assert(read.results[0].truncated); assert(read.results[0].next_offset > 0);
    await assert.rejects(fixture.lib.search({ query: 'a', scope: { document_ids: 'bad' } }));
    await assert.rejects(fixture.lib.search({ query: 'a', filters: { year_from: 2024, year_to: 2000 } }));
    for (let i = 0; i < 432; i++) {
      const doc = { ...paper(`queue${i}`), abstract: '', sections: [], chunks: [], markdown: undefined };
      await fixture.store.putDocument(doc);
      await fixture.store.putJob({ id: `job${i}`, documentID: doc.id, state: 'failed', attempts: 1, nextRun: 0, createdAt: '' }, true);
    }
    const status = await fixture.lib.agentStatus(); assert(!Array.isArray(status.queue)); assert.equal(status.queue.total, 432); assert.equal(status.complete_zotero_library, false);
    const response: any = await rpc(fixture.lib, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'literature_status' } });
    assert(JSON.stringify(response).length < 16000); assert(TOOLS.some(t => t.name === 'literature_workspace'));
    const jobs = await fixture.lib.agentStatus({ view: 'jobs', limit: 1 }); assert.equal(jobs.jobs.length, 1); assert.equal(jobs.next_offset, 1);
  } finally { await fixture.restore(); }
});

test('interactive inference jumps queued ingestion only after the running batch completes', async () => {
  const queue = new PriorityQueue(), order: string[] = []; let release!: () => void;
  queue.enqueue(async () => { order.push('running'); await new Promise<void>(resolve => { release = resolve; }); });
  queue.enqueue(async () => { order.push('background'); });
  queue.enqueue(async () => { order.push('query'); }, true);
  assert.deepEqual(order, ['running']); release();
  await new Promise(resolve => setTimeout(resolve, 20)); assert.deepEqual(order, ['running', 'query', 'background']);
});

test('synthetic warm discovery benchmark reports measured latency and fixture-only relevance', async () => {
  const docs = Array.from({ length: 432 }, (_, i) => paper(`bench${i}`, i % 3 ? 'Oxidation controls cerium anomalies in marine sediments.' : 'Sequential extraction measures mineral carriers.'));
  const cold = performance.now(), engine = engineWith(docs), coldMs = performance.now() - cold;
  const timings: number[] = [];
  for (let i = 0; i < 30; i++) { const start = performance.now(); engine.search({ query: 'sequential extraction', layer: 'abstract', top_k: 20 }, 'model-v1'); timings.push(performance.now() - start); }
  const hits = engine.search({ query: 'sequential extraction', layer: 'abstract', top_k: 20 }, 'model-v1').results;
  assert.equal(hits.length, 20); assert(hits.every(h => Number(h.document_id.slice(5)) % 3 === 0));
  timings.sort((a, b) => a - b); const report = { fixture: 'synthetic 432 papers; not production Zotero or Qwen inference', cold_index_ms: coldMs,
    warm_p50_ms: timings[15], warm_p95_ms: timings[28], precision_at_20_fixture: 1, samples: timings.length };
  await writeFile('test-output/retrieval-report.json', JSON.stringify(report, null, 2));
});
