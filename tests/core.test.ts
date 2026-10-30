import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError, credentialDisplay, expiryDates, mineruError, parseDocument, redact, keywordScore } from '../src/core';
import { MinerUClient, safeRemoteURL } from '../src/mineru';
import { rpc } from '../src/agent';
import { CitationBridge } from '../src/citation-bridge';

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
