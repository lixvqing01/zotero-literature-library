import MiniSearch from 'minisearch';
import { AppError, boundedInt, normalizeYear, sectionRole, type DocumentRecord } from './core';

export interface SearchDocument {
  id: string; itemKey: string; libraryID: number; libraryKey: string; attachmentKey: string | null;
  title: string; creators: string; year: string; publication: string; doi: string; abstract: string;
  tags: string[]; collections: string[]; modified: string; state: string; indexedAt?: string;
  modelFingerprint?: string; hasFulltext: boolean; vectorLayers: string[]; version: string;
  bibliographic?: Record<string, string>;
}
export interface SearchBlock {
  id: string; documentID: string; chunk: string; section: string; layer: string; page: number | null;
  heading: string; role: string; title: string; creators: string; publication: string; tags: string; doi: string; text: string;
}
export interface SearchVector { id: string; documentID: string; layer: string; fingerprint: string; vector: number[]; }
export interface SearchBundle { revision: number; documents: SearchDocument[]; blocks: SearchBlock[]; removed?: string[]; reset?: boolean; }
export function projectDocument(doc: DocumentRecord) {
  const document: SearchDocument = { id: doc.id, itemKey: doc.itemKey, libraryID: doc.libraryID, libraryKey: doc.libraryKey,
    attachmentKey: doc.attachmentKey, title: doc.title, creators: doc.creators, year: normalizeYear(doc.year), publication: doc.publication,
    doi: doc.doi, abstract: doc.abstract, tags: doc.tags, collections: doc.collections, modified: doc.modified, state: doc.state,
    indexedAt: doc.indexedAt, modelFingerprint: doc.modelFingerprint, hasFulltext: !!doc.markdown,
    vectorLayers: [...new Set(doc.chunks.filter(c => c.vector?.length).map(c => c.layer))], bibliographic: doc.bibliographic,
    version: [doc.pdfHash, doc.metadataHash, doc.parserFingerprint, doc.modelFingerprint, doc.indexedAt, doc.modified].join('|') };
  const blocks: SearchBlock[] = [], vectors: SearchVector[] = [];
  const add = (chunk: string, layer: string, text: string, section: string, page: number | null, heading = '', role = 'unknown', vector?: number[]) => {
    const id = JSON.stringify([doc.id, chunk]);
    blocks.push({ id, documentID: doc.id, chunk, section, layer, page, heading, role,
      title: layer === 'metadata' ? doc.title : '', creators: layer === 'metadata' ? doc.creators : '',
      publication: layer === 'metadata' ? doc.publication : '', tags: layer === 'metadata' ? doc.tags.join(' ') : '',
      doi: layer === 'metadata' ? doc.doi : '', text });
    if (vector?.length && doc.modelFingerprint) vectors.push({ id, documentID: doc.id, layer, fingerprint: doc.modelFingerprint, vector });
  };
  add('metadata', 'metadata', Object.values(doc.bibliographic || {}).join(' '), 'metadata', null, '', 'metadata', doc.chunks.find(c => c.layer === 'metadata')?.vector);
  if (doc.abstract) add('abstract', 'abstract', doc.abstract, 'abstract', null, 'Abstract', 'abstract', doc.chunks.find(c => c.layer === 'abstract')?.vector);
  const sections = new Map(doc.sections.map(s => [s.id, s]));
  for (const chunk of doc.chunks.filter(c => c.layer === 'fulltext')) {
    const section = sections.get(chunk.sectionId);
    add(chunk.id, chunk.layer, chunk.text, chunk.sectionId, chunk.page, section?.heading,
      section?.kind === 'references' ? 'references' : sectionRole(section?.heading || ''), chunk.vector);
  }
  return { document, blocks, vectors };
}

export function matchesScope(doc: SearchDocument, input: any) {
  const scope = input.scope || {}, filters = { ...input, ...(input.filters || {}) };
  if (scope.document_ids && !scope.document_ids.includes(doc.id)) return false;
  if ((scope.exclude_document_ids || []).includes(doc.id)) return false;
  if (filters.library_id !== undefined && doc.libraryID !== filters.library_id) return false;
  if (filters.year && doc.year !== String(filters.year)) return false;
  if (filters.year_from !== undefined && (!doc.year || Number(doc.year) < filters.year_from)) return false;
  if (filters.year_to !== undefined && (!doc.year || Number(doc.year) > filters.year_to)) return false;
  if (filters.publication && !doc.publication.toLowerCase().includes(String(filters.publication).toLowerCase())) return false;
  if (filters.author && !doc.creators.toLowerCase().includes(String(filters.author).toLowerCase())) return false;
  if (filters.collection_keys?.length && !filters.collection_keys.some((key: string) => doc.collections.includes(key))) return false;
  if (filters.tags?.length && !filters.tags.every((tag: string) => doc.tags.includes(tag))) return false;
  return true;
}
function signature(value: any) {
  let hash = 2166136261;
  const canonical = (item: any): any => Array.isArray(item) ? item.map(canonical) : item && typeof item === 'object'
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])])) : item;
  for (const char of JSON.stringify(canonical(value))) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(36);
}
export function searchTokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9_.-]*|[\p{Script=Han}]+/gu) || []).map(word => word.replace(/[._-]+$/, '')).flatMap(word => /\p{Script=Han}/u.test(word) && word.length > 2
    ? Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2)) : [word]);
}
const options = { fields: ['title', 'creators', 'publication', 'tags', 'doi', 'heading', 'text'],
  storeFields: [] as string[], tokenize: searchTokens, processTerm: (term: string) => term.toLowerCase() };
export class SearchEngine {
  private index = new MiniSearch<SearchBlock>(options);
  private documents = new Map<string, SearchDocument>();
  private blocks = new Map<string, SearchBlock>();
  private byDocument = new Map<string, string[]>();
  private vectors = new Map<string, Float32Array>();
  private vectorKey = '';
  revision = -1;
  apply(bundle: SearchBundle) {
    if (bundle.reset) { this.index = new MiniSearch(options); this.documents.clear(); this.blocks.clear(); this.byDocument.clear(); }
    const changed = new Set([...(bundle.removed || []), ...bundle.documents.map(d => d.id)]);
    for (const id of changed) {
      for (const blockID of this.byDocument.get(id) || []) { this.index.discard(blockID); this.blocks.delete(blockID); }
      this.byDocument.delete(id); this.documents.delete(id);
    }
    for (const doc of bundle.documents) this.documents.set(doc.id, doc);
    for (const block of bundle.blocks) {
      this.blocks.set(block.id, block); this.index.add(block);
      const ids = this.byDocument.get(block.documentID) || []; ids.push(block.id); this.byDocument.set(block.documentID, ids);
    }
    this.revision = bundle.revision; this.vectors.clear(); this.vectorKey = '';
    return { revision: this.revision, documents: this.documents.size, blocks: this.blocks.size };
  }
  dump() { return JSON.stringify({ schema: 1, revision: this.revision, documents: [...this.documents.values()], blocks: [...this.blocks.values()], index: this.index.toJSON() }); }
  restore(raw: string) {
    const data = JSON.parse(raw); if (data.schema !== 1) throw Error('检索快照版本不匹配');
    const index = MiniSearch.loadJSON<SearchBlock>(JSON.stringify(data.index), options);
    const documents = new Map<string, SearchDocument>(data.documents.map((d: SearchDocument) => [d.id, d]));
    const blocks = new Map<string, SearchBlock>(data.blocks.map((b: SearchBlock) => [b.id, b]));
    const byDocument = new Map<string, string[]>();
    for (const block of blocks.values()) { const ids = byDocument.get(block.documentID) || []; ids.push(block.id); byDocument.set(block.documentID, ids); }
    this.index = index; this.documents = documents; this.blocks = blocks; this.byDocument = byDocument;
    this.revision = data.revision; this.vectors.clear(); this.vectorKey = '';
    return { revision: this.revision };
  }
  loadVectors(key: string, vectors: SearchVector[]) {
    if (this.vectorKey === key) return;
    this.vectors = new Map(vectors.map(v => [v.id, new Float32Array(v.vector)])); this.vectorKey = key;
  }
  scope(input: any) { return [...this.documents.values()].filter(d => matchesScope(d, input)); }
  search(input: any, fingerprint: string, vector?: number[]) {
    const started = Date.now(), layer = input.layer || 'auto', mode = vector ? input.mode : input.mode === 'semantic' ? 'semantic' : 'keyword';
    const docs = this.scope(input), allowed = new Map(docs.map(d => [d.id, d]));
    const boolean = input.boolean || {};
    const eligible = (block: SearchBlock) => {
      if (!allowed.has(block.documentID) || !(layer === 'auto' ? ['metadata', 'abstract'].includes(block.layer) : block.layer === layer)) return false;
      if (!input.include_references && block.role === 'references') return false;
      if (input.section_roles?.length && !input.section_roles.includes(block.role)) return false;
      const text = [block.title, block.creators, block.publication, block.tags, block.doi, block.heading, block.text].join('\n').toLowerCase();
      const tokens = boolean.all?.length || boolean.any?.length || boolean.not?.length ? new Set(searchTokens(text)) : null;
      const contains = (s: string) => { const query = searchTokens(s); return query.length > 0 && query.every(t => tokens!.has(t)); };
      return (!boolean.all?.length || boolean.all.every(contains)) && (!boolean.any?.length || boolean.any.some(contains))
        && !(boolean.not || []).some(contains) && (boolean.phrases || []).every((s: string) => text.includes(s.toLowerCase()));
    };
    type Hit = { block: SearchBlock; score: number; lexical?: number; semantic?: number; matched?: string[] };
    const lexical: Hit[] = this.index.search(input.query, { combineWith: input.operator || 'OR',
      boost: { title: 4, doi: 5, tags: 2, creators: 2, heading: 1.5 },
      filter: result => eligible(this.blocks.get(String(result.id))!) }).map(r => ({ block: this.blocks.get(String(r.id))!, score: r.score, lexical: r.score, matched: r.terms }));
    const semantic: Hit[] = [];
    if (vector) for (const [id, values] of this.vectors) {
      const block = this.blocks.get(id); if (!block || !eligible(block) || allowed.get(block.documentID)?.modelFingerprint !== fingerprint || vector.length !== values.length) continue;
      let dot = 0, a = 0, b = 0;
      for (let i = 0; i < values.length; i++) { dot += values[i] * vector[i]; a += values[i] ** 2; b += vector[i] ** 2; }
      const score = a && b ? dot / Math.sqrt(a * b) : -1;
      if (score > 0.1) semantic.push({ block, score, semantic: score });
    }
    const stable = (a: Hit, b: Hit) => b.score - a.score || a.block.id.localeCompare(b.block.id);
    const key = (h: Hit) => input.granularity === 'passages' ? h.block.id : `${allowed.get(h.block.documentID)!.libraryID}:${allowed.get(h.block.documentID)!.itemKey}`;
    const unique = (hits: Hit[]) => { const seen = new Set<string>(); return hits.sort(stable).filter(h => { const id = key(h); if (seen.has(id)) return false; seen.add(id); return true; }); };
    const keywords = unique(lexical), semantics = unique(semantic);
    let ranked: Hit[];
    if (mode === 'hybrid') {
      const fused = new Map<string, Hit>();
      for (const ranking of [keywords, semantics]) ranking.forEach((hit, i) => {
        const id = key(hit), previous = fused.get(id), score = 1 / (61 + i);
        if (previous) { previous.score += score; previous.lexical ??= hit.lexical; previous.semantic ??= hit.semantic; previous.matched ??= hit.matched; }
        else fused.set(id, { ...hit, score });
      });
      ranked = [...fused.values()].sort(stable);
    } else ranked = mode === 'semantic' ? semantics : keywords;
    const { cursor, ...queryIdentity } = input;
    const queryKey = signature([queryIdentity, fingerprint]); let offset = 0;
    if (cursor) {
      const parts = String(cursor).split(':');
      if (parts.length !== 3 || Number(parts[0]) !== this.revision || parts[1] !== queryKey || !/^\d+$/.test(parts[2]) || !Number.isSafeInteger(Number(parts[2])))
        throw new AppError({ code: 'SEARCH_CURSOR_INVALID', message: '索引或查询范围已变化，请从第一页重新检索。', retryable: false });
      offset = Number(parts[2]);
    }
    const results: any[] = [], limit = boundedInt(input.top_k, 10, 100), budget = boundedInt(input.max_chars, 18000, 60000);
    let used = 0, consumed = 0;
    for (const hit of ranked.slice(offset, offset + limit)) {
      const block = hit.block, doc = allowed.get(block.documentID)!;
      const result = { document_id: doc.id, paper_id: `${doc.libraryID}:${doc.itemKey}`, item_key: doc.itemKey, library_id: doc.libraryID,
        title: doc.title, creators: doc.creators, year: doc.year, layer: block.layer, section_id: block.section, section_role: block.role,
        chunk_id: block.chunk, page: block.page, snippet: (block.layer === 'metadata' ? doc.title : block.text).slice(0, input.snippet_chars === 0 ? 0 : boundedInt(input.snippet_chars, 500, 1200)),
        score: hit.score, score_type: mode === 'hybrid' ? 'rrf' : mode === 'semantic' ? 'cosine' : 'bm25+',
        lexical_score: hit.lexical ?? null, semantic_score: hit.semantic ?? null, matched_terms: hit.matched || [],
        version: doc.version, has_abstract: !!doc.abstract, has_fulltext: doc.hasFulltext,
        link: block.page && doc.attachmentKey ? `zotero://open-pdf/${doc.libraryKey}/items/${doc.attachmentKey}?page=${block.page}` : `zotero://select/${doc.libraryKey}/items/${doc.itemKey}` };
      const size = JSON.stringify(result).length;
      if (used + size > budget) {
        if (!results.length) throw new AppError({ code: 'SEARCH_BUDGET_TOO_SMALL', message: '单条结果超过字符预算，请增大 max_chars 或减小 snippet_chars。', retryable: false });
        break;
      }
      results.push(result); used += size; consumed++;
    }
    const next = offset + consumed, hasMore = next < ranked.length;
    return { results, mode, snapshot: this.revision, total_results: ranked.length, has_more: hasMore,
      next_cursor: hasMore ? `${this.revision}:${queryKey}:${next}` : null, truncated_reason: hasMore ? consumed < Math.min(limit, ranked.length - offset) ? 'character_budget' : 'page_limit' : null,
      coverage: { scope: 'plugin_derived_library', candidates: docs.length, abstracts: docs.filter(d => !!d.abstract).length,
        fulltext: docs.filter(d => d.hasFulltext).length, indexed: docs.filter(d => d.modelFingerprint === fingerprint && d.vectorLayers.some(l => layer === 'auto' ? ['metadata', 'abstract'].includes(l) : l === layer)).length },
      timing_ms: { retrieval: Date.now() - started }, active_model: fingerprint };
  }
}
