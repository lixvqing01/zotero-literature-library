import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
const fixture = {
  status: {
    settings: { autoIndex: true, cloudEnabled: true, model: 'qwen', embeddingsEnabled: true, mcpEnabled: true, ocr: true },
    credentials: { state: 'configured', revision: 1, issuedAt: null, expiresAt: null, checkedAt: null, daysRemaining: null },
    model: { state: 'ready', model: 'qwen', progress: null },
    coverage: { documents: 4, abstracts: 4, fulltext: 3, vectors: 2 },
    endpoint: 'http://127.0.0.1:23119/literature-library/mcp',
    queue: [{ id: 'j1', documentID: 'd4', state: 'running', attempts: 0, progress: { extracted_pages: 8, total_pages: 14 } }]
  },
  documents: [
    ['d1', 'Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks', 'Patrick Lewis, Ethan Perez', '2020', 'NeurIPS', 'ready'],
    ['d2', 'Attention Is All You Need', 'Ashish Vaswani, Noam Shazeer', '2017', 'NeurIPS', 'ready'],
    ['d3', 'Qwen3 Embedding: Advancing Text Embedding and Reranking', 'Yanzhao Zhang, Mingxin Li', '2025', 'arXiv', 'ready'],
    ['d4', '面向科学文献的分层检索与证据定位', '陈明, 李华', '2026', '计算机学报', 'metadata']
  ].map(([id, title, creators, year, publication, state], i) => ({ id, title, creators, year, publication, state,
    itemKey: `TEST000${i}`, libraryKey: 'library', abstract: 'We study retrieval and scientific evidence through structured document access. 本研究讨论文献检索与证据定位。',
    hasFulltext: i < 3, modelFingerprint: i < 2 ? 'qwen:q8' : undefined, tags: [], collections: [],
    markdown: '# Abstract\nA structured literature retrieval study.\n\n# Methods\nMethods and supporting evidence.',
    sections: [{ id: 's1', heading: 'Abstract', page: 1 }, { id: 's2', heading: 'Methods', page: 3 }] }))
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
