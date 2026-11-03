import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
const fixture = {
  status: {
    settings: { autoIndex: true, cloudEnabled: true, model: 'qwen', embeddingProvider: 'local', modelSource: 'modelscope',
      embeddingApiBaseUrl: 'https://api.openai.com/v1', embeddingApiModel: 'text-embedding-3-small',
      embeddingsEnabled: true, mcpEnabled: true, ocr: true },
    credentials: { state: 'configured', revision: 1, issuedAt: null, expiresAt: null, checkedAt: null, daysRemaining: null },
    model: { state: 'idle', model: 'qwen', provider: 'local', progress: null, checkedAt: null, dimension: null },
    embedding_credentials: { state: 'missing' },
    agents: { codex: { configured: false, path: 'C:/Users/You/.codex/config.toml' }, claudeCode: { configured: false, path: 'C:/Users/You/.claude.json' } },
    coverage: { documents: 3, abstracts: 3, fulltext: 3, vectors: 2 },
    endpoint: 'http://127.0.0.1:23119/literature-library/mcp',
    queue: [{ id: 'j2', documentID: 'd3', state: 'blocked_model', can_resume: true, error: { message: '模型下载中断，请重试。' } }, { id: 'j3', documentID: 'd2', state: 'failed', requires_rebuild: true, error: { message: '提交结果未知，请检查 MinerU。' } }, { id: 'j1', documentID: 'd4', state: 'running', attempts: 0, progress: { extracted_pages: 8, total_pages: 14 } },
      { id: 'j4', documentID: 'd4', documentTitle: '面向科学文献的分层检索与证据定位', state: 'failed', batchID: 'fixture-batch', dataID: 'fixture-file', can_resume: true, requires_rebuild: true, error: { code: 'MINERU_UPLOAD_INCOMPLETE', message: '原任务尚未收到完整 PDF，请强制重建；未自动重复上传。' } }]
  },
  documents: [
    ['d1', 'Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks', 'Patrick Lewis, Ethan Perez', '2020', 'NeurIPS', 'ready'],
    ['d2', 'Attention Is All You Need', 'Ashish Vaswani, Noam Shazeer', '2017', 'NeurIPS', 'ready'],
    ['d3', 'Qwen3 Embedding: Advancing Text Embedding and Reranking', 'Yanzhao Zhang, Mingxin Li', '2025', 'arXiv', 'ready'],
    ['d4', '面向科学文献的分层检索与证据定位', '陈明, 李华', '2026', '计算机学报', 'metadata']
  ].map(([id, title, creators, year, publication, state], i) => ({ id, title, creators, year, publication, state, ...(i < 3 ? { indexedAt: '2026-01-01T00:00:00.000Z' } : {}),
    itemKey: `TEST000${i}`, libraryKey: 'library', abstract: 'We study retrieval and scientific evidence through structured document access. 本研究讨论文献检索与证据定位。',
    hasFulltext: i < 3, hasCurrentVectors: i < 2, modelFingerprint: i < 2 ? 'qwen:q8' : undefined, tags: [], collections: [],
    markdown: '# Abstract\nA structured literature retrieval study.\n\n# Methods\nMethods and supporting evidence.',
    chunks: [{ id: 'c1', sectionId: 's2', layer: 'fulltext', page: 3, text: 'Methods and supporting evidence.' }], sections: [{ id: 's1', heading: 'Abstract', page: 1, text: 'A structured literature retrieval study.' }, { id: 's2', heading: 'Methods', page: 3, text: 'Methods and supporting evidence. '.repeat(700) }] }))
};
const base = resolve('build/addon/content');
const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (path === '/preview-data.json') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(fixture)); return; }
    const file = resolve(base, '.' + (path === '/' ? '/manager.xhtml' : path));
    if (!file.startsWith(base + sep)) { res.writeHead(403).end(); return; }
    const content = await readFile(file);
    const mime = { '.xhtml': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml' };
    res.setHeader('Content-Type', mime[extname(file)] || 'application/octet-stream'); res.end(content);
  } catch { res.writeHead(404).end(); }
});
server.listen(4179, '127.0.0.1', () => console.log('UI preview with fixture data: http://127.0.0.1:4179'));
