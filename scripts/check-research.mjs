import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
const browser = await chromium.launch({ headless: true, channel: 'chromium' });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/preview-data.json', async route => {
    const response = await route.fetch(), fixture = await response.json();
    fixture.workspaces = [{ id: 'review', title: '成岩作用与 REY 再分配', themes: [{ id: 'carriers', title: '矿物载体与迁移', candidates: 1, evidence: 1 }] }];
    fixture.researchDetails = [{ workspace_id: 'review', theme_id: 'carriers', title: '矿物载体与迁移', total: 1, next_offset: null,
      evidence_total: 1, next_evidence_offset: null, candidates: [{ document_id: 'd1', title: fixture.documents[0].title, status: 'included', reason: '已读原始摘要；正文需核对迁移条件', changed: true }],
      evidence: [{ document_id: 'd1', chunk_id: 'c1', page: 3, claim: '矿物载体发生迁移', stance: 'supports', excerpt: 'Methods and supporting evidence.' }],
      queries: [{ query: 'diagenesis REY carriers', layer: 'fulltext', returned: 1 }] }];
    await route.fulfill({ json: fixture });
  });
  await page.goto('http://127.0.0.1:4179');
  await page.getByRole('button', { name: '调研主题', exact: true }).click();
  await page.getByText('成岩作用与 REY 再分配', { exact: true }).waitFor();
  await page.getByRole('button', { name: '矿物载体与迁移 1 篇 · 1 条证据' }).click();
  await page.getByText('已纳入 · 来源版本已变化，需重新核对', { exact: true }).waitFor();
  await page.locator('#refresh').click();
  await page.getByText('已纳入 · 来源版本已变化，需重新核对', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks', exact: true }).click();
  await page.locator('#detail-dialog[open]').waitFor();
  assert((await page.locator('#detail-content').innerText()).includes('本研究'));
  await page.locator('#close-detail').click();
  await page.getByRole('button', { name: '读取原始证据' }).click();
  await page.locator('#detail-dialog[open]').waitFor();
  assert((await page.locator('#detail-content').innerText()).includes('Methods and supporting evidence.'));
  await page.locator('#close-detail').click();
  await page.screenshot({ path: 'test-output/ui-research.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert(overflow <= 2, `Research page overflows by ${overflow}px`);
  await page.screenshot({ path: 'test-output/ui-research-390.png', fullPage: true });
  const workerReport = await page.evaluate(async () => {
    const token = 'headless-search-bridge-test', frame = document.createElement('iframe');
    let request = 0; const pending = new Map(); let readyResolve;
    const ready = new Promise(resolve => { readyResolve = resolve; });
    const listener = ({ data }) => {
      if (data?.source !== 'literature-search' || data.bridgeToken !== token) return;
      if (data.ready) readyResolve(); else if (data.fatal) throw Error(data.fatal); else {
        const callback = pending.get(data.id); if (callback) { pending.delete(data.id); callback(data); }
      }
    };
    window.addEventListener('message', listener); frame.src = '/search.html#' + token; frame.hidden = true; document.body.append(frame);
    const timeout = () => new Promise((_, reject) => setTimeout(() => reject(Error('Search bridge timeout')), 10000));
    await Promise.race([ready, timeout()]);
    const call = async data => {
      const id = ++request, result = new Promise(resolve => pending.set(id, resolve));
      frame.contentWindow.postMessage({ ...data, id, group: 'discovery', source: 'literature-search-host', bridgeToken: token }, '*');
      const response = await Promise.race([result, timeout()]); if (response.error) throw Error(JSON.stringify(response.error)); return response.result;
    };
    const doc = { id: 'paper', itemKey: 'ITEM', libraryID: 1, libraryKey: 'library', attachmentKey: 'PDF', title: 'Marine REY', creators: 'Li',
      year: '2021', publication: 'Journal', doi: '', abstract: '成岩作用引起稀土元素迁移。', tags: [], collections: [], modelFingerprint: 'model', vectorLayers: ['abstract'], version: '1' };
    const block = { id: 'block', documentID: 'paper', chunk: 'abstract', section: 'abstract', layer: 'abstract', page: null,
      heading: 'Abstract', role: 'abstract', title: '', creators: '', publication: '', tags: '', doi: '', text: doc.abstract };
    await call({ action: 'apply', value: { revision: 1, reset: true, documents: [doc], blocks: [block] } });
    const lexical = await call({ action: 'search', input: { query: '成岩作用', mode: 'keyword' }, fingerprint: 'model' });
    if (lexical.results[0]?.document_id !== 'paper') throw Error('Worker lexical result missing');
    const dump = await call({ action: 'dump' }); await call({ action: 'restore', value: dump });
    await call({ action: 'vectors', key: 'scope', value: [{ id: 'block', vector: [1, 0] }] });
    const semantic = await call({ action: 'search', input: { query: 'different vocabulary', mode: 'semantic' }, fingerprint: 'model', vector: [1, 0] });
    if (semantic.results[0]?.document_id !== 'paper') throw Error('Worker semantic result missing');
    window.removeEventListener('message', listener); frame.remove();
    return { bridge: true, lexical: true, semantic: true, snapshot: true };
  });
  assert.deepEqual(errors, []);
  await writeFile('test-output/research-ui-report.json', JSON.stringify({ ok: true, runtime: 'headless Chromium; native Zotero/Gecko not launched', gui: true, mobile: true, worker: workerReport }, null, 2));
  console.log('Research GUI and compiled iframe/Worker bridge passed (headless Chromium).');
} finally { await browser.close(); }
