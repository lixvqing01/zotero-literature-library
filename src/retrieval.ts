import { boundedInt, cosine, keywordScore, type DocumentRecord, type Layer } from './core';

export function metadataText(doc: DocumentRecord) {
  return [doc.title, doc.creators, doc.year, doc.publication, doc.doi, ...doc.tags,
    ...Object.values(doc.bibliographic || {})].filter(Boolean).join('\n');
}

export function searchBlocks(doc: DocumentRecord, layer: string) {
  const blocks = doc.chunks.filter(c => (layer === 'auto' || c.layer === layer)
    && doc.sections.find(s => s.id === c.sectionId)?.kind !== 'references');
  if (['auto', 'metadata'].includes(layer) && !blocks.some(c => c.layer === 'metadata'))
    blocks.unshift({ id: 'metadata', sectionId: 'metadata', text: metadataText(doc), page: null, layer: 'metadata' });
  if (['auto', 'abstract'].includes(layer) && doc.abstract && !blocks.some(c => c.layer === 'abstract'))
    blocks.push({ id: 'abstract', sectionId: 'abstract', text: doc.abstract, page: null, layer: 'abstract' });
  return blocks;
}

interface Hit { doc: DocumentRecord; layer: Layer; text: string; section: string; chunk: string;
  page: number | null; keyword: number; semantic: number | null; score: number; }

// Fuse rankings, not unrelated keyword/cosine score scales. Collapse each ranking first
// in paper mode so a long PDF cannot gain extra votes just by containing more chunks.
export function rankDocuments(docs: DocumentRecord[], input: any, fingerprint: string, vector?: number[]) {
  const mode = vector ? input.mode : 'keyword';
  const hits: Hit[] = docs.flatMap(doc => searchBlocks(doc, input.layer || 'auto').map(chunk => ({
    doc, layer: chunk.layer, text: chunk.text, section: chunk.sectionId, chunk: chunk.id, page: chunk.page,
    keyword: keywordScore(input.query, chunk.text),
    semantic: vector && chunk.vector && doc.modelFingerprint === fingerprint ? cosine(vector, chunk.vector) : null,
    score: 0
  })));
  const key = (h: Hit) => input.granularity === 'passages' ? `${h.doc.id}:${h.chunk}` : `${h.doc.libraryID}:${h.doc.itemKey}`;
  const unique = (list: Hit[]) => { const seen = new Set<string>(); return list.filter(h => {
    const id = key(h); if (seen.has(id)) return false; seen.add(id); return true;
  }); };
  const keyword = unique(hits.filter(h => h.keyword > 0).sort((a, b) => b.keyword - a.keyword));
  const semantic = unique(hits.filter(h => h.semantic !== null && h.semantic > 0.1)
    .sort((a, b) => b.semantic! - a.semantic!));
  let ranked: Hit[];
  if (mode === 'hybrid') {
    const fused = new Map<string, Hit>();
    for (const ranking of [keyword, semantic]) ranking.forEach((hit, index) => {
      const id = key(hit), previous = fused.get(id);
      if (previous) previous.score += 1 / (60 + index + 1);
      else fused.set(id, { ...hit, score: 1 / (60 + index + 1) });
    });
    ranked = [...fused.values()].sort((a, b) => b.score - a.score);
  } else ranked = (mode === 'semantic' ? semantic : keyword).map(h => ({ ...h, score: mode === 'semantic' ? h.semantic! : h.keyword }));
  return ranked.slice(0, boundedInt(input.top_k, 10, 100)).map(hit => ({
    document_id: hit.doc.id, item_key: hit.doc.itemKey, library_id: hit.doc.libraryID,
    title: hit.doc.title, creators: hit.doc.creators, year: hit.doc.year,
    layer: hit.layer, section_id: hit.section, chunk_id: hit.chunk, page: hit.page,
    snippet: hit.text.slice(0, 900), score: hit.score, semantic_score: hit.semantic,
    score_type: mode === 'hybrid' ? 'rrf' : mode === 'semantic' ? 'cosine' : 'keyword',
    link: hit.page && hit.doc.attachmentKey ? `zotero://open-pdf/${hit.doc.libraryKey}/items/${hit.doc.attachmentKey}?page=${hit.page}`
      : `zotero://select/${hit.doc.libraryKey}/items/${hit.doc.itemKey}`
  }));
}

export function readFulltext(doc: DocumentRecord, input: any) {
  if (input.page !== undefined && (!Number.isInteger(input.page) || input.page < 1)) throw Error('page 必须为从 1 开始的 PDF 页号。');
  if (input.offset !== undefined && (!Number.isSafeInteger(input.offset) || input.offset < 0)) throw Error('offset 必须为非负整数。');
  const sections = doc.sections.filter(s => (!input.section_id || s.id === input.section_id)
    && (input.page === undefined || s.page === input.page));
  const chunk = input.chunk_id ? doc.chunks.find(c => c.id === input.chunk_id && c.layer === 'fulltext'
    && sections.some(s => s.id === c.sectionId)) : null;
  const matchedSections = input.chunk_id ? sections.filter(s => s.id === chunk?.sectionId) : sections;
  const content = input.chunk_id ? chunk?.text || '' : sections.map(s => `## ${s.heading}\n${s.text}`).join('\n');
  const offset = input.offset || 0, limit = boundedInt(input.max_chars, 12000, 60000);
  return { text: content.slice(offset, offset + limit), offset, total_chars: content.length,
    truncated: offset + limit < content.length, next_offset: offset + limit < content.length ? offset + limit : null,
    source: 'mineru', sections: matchedSections.map(s => ({ id: s.id, heading: s.heading, page: s.page })),
    pdf_link: matchedSections.length === 1 && matchedSections[0].page && doc.attachmentKey
      ? `zotero://open-pdf/${doc.libraryKey}/items/${doc.attachmentKey}?page=${matchedSections[0].page}` : null,
    missing: !doc.markdown, matched: matchedSections.length > 0 };
}
