import { normalizeYear, type DocumentRecord, type PublicError } from './core';
import { canDeleteJob } from './queue';
import { projectDocument, type SearchBundle, type SearchDocument, type SearchVector } from './search-engine';
export interface Job {
  id: string; documentID: string; state: string; attempts: number; nextRun: number;
  batchID?: string; dataID?: string; pdfHash?: string; metadataHash?: string;
  force?: boolean; progress?: any; error?: PublicError; createdAt: string;
  retryState?: string; credentialRevision?: number;
  parserFingerprint?: string;
  uploadCompletedAt?: number; uploadWaitSince?: number; uploadHTTPStatus?: number; pdfBytes?: number;
}
export function summarize({ chunks, sections, markdown, ...doc }: DocumentRecord) {
  return { ...doc, year: normalizeYear(doc.year), chunkCount: chunks.length, sectionCount: sections.length, hasFulltext: !!markdown,
    hasVectors: chunks.some(c => !!c.vector?.length) };
}
export class Store {
  db: any;
  constructor(public root: string) {}
  async init() {
    await IOUtils.makeDirectory(this.root, { ignoreExisting: true });
    this.db = new Zotero.DBConnection(PathUtils.join(this.root, 'library.sqlite'));
    await this.db.queryAsync('PRAGMA journal_mode=WAL');
    await this.db.queryAsync('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    await this.db.queryAsync('CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
    await this.db.queryAsync('CREATE TABLE IF NOT EXISTS document_summaries (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
    await this.db.queryAsync('CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, document_id TEXT NOT NULL UNIQUE, data TEXT NOT NULL)');
    await this.db.queryAsync('CREATE TABLE IF NOT EXISTS search_documents (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
    await this.db.queryAsync('CREATE TABLE IF NOT EXISTS search_blocks (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, layer TEXT NOT NULL, data TEXT NOT NULL)');
    await this.db.queryAsync('CREATE INDEX IF NOT EXISTS search_blocks_document ON search_blocks(document_id,layer)');
    await this.db.queryAsync('CREATE TABLE IF NOT EXISTS search_vectors (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, layer TEXT NOT NULL, fingerprint TEXT NOT NULL, data TEXT NOT NULL)');
    await this.db.queryAsync('CREATE INDEX IF NOT EXISTS search_vectors_scope ON search_vectors(document_id,layer,fingerprint)');
    await this.db.queryAsync('CREATE TABLE IF NOT EXISTS search_changes (id TEXT PRIMARY KEY, revision INTEGER NOT NULL)');
    await this.db.queryAsync('CREATE TABLE IF NOT EXISTS search_snapshots (layer TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL)');
    await this.db.queryAsync('CREATE TABLE IF NOT EXISTS research_workspaces (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
    // Resumable local projection migration: original documents and vectors remain intact.
    for (;;) {
      const pending = await this.db.columnQueryAsync('SELECT data FROM documents WHERE id NOT IN (SELECT id FROM search_documents) LIMIT 8');
      if (!pending.length) break;
      await this.db.executeTransaction(async () => { for (const raw of pending) await this.writeProjection(JSON.parse(raw)); });
    }
    const missing = await this.db.columnQueryAsync('SELECT data FROM documents WHERE id NOT IN (SELECT id FROM document_summaries)');
    await this.db.executeTransaction(async () => {
      for (const raw of missing) {
        const doc = JSON.parse(raw);
        await this.db.queryAsync('INSERT INTO document_summaries (id,data) VALUES (?,?)', [doc.id, JSON.stringify(summarize(doc))]);
      }
    });
  }
  async get<T>(key: string, fallback: T): Promise<T> {
    const raw = await this.db.valueQueryAsync('SELECT value FROM settings WHERE key=?', [key]);
    return raw ? JSON.parse(raw) : fallback;
  }
  async set(key: string, value: any) {
    await this.db.queryAsync('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)', [key, JSON.stringify(value)]);
  }
  async documents(): Promise<DocumentRecord[]> {
    return (await this.db.columnQueryAsync('SELECT data FROM documents')).map((s: string) => JSON.parse(s));
  }
  async document(id: string): Promise<DocumentRecord | null> {
    const raw = await this.db.valueQueryAsync('SELECT data FROM documents WHERE id=?', [id]);
    return raw ? JSON.parse(raw) : null;
  }
  async summaries(): Promise<ReturnType<typeof summarize>[]> {
    return (await this.db.columnQueryAsync('SELECT data FROM document_summaries')).map((s: string) => JSON.parse(s));
  }
  async putDocument(doc: DocumentRecord) {
    await this.db.executeTransaction(() => this.writeDocument(doc));
  }
  private async writeDocument(doc: DocumentRecord) {
    await this.db.queryAsync('INSERT OR REPLACE INTO documents (id,data) VALUES (?,?)', [doc.id, JSON.stringify(doc)]);
    await this.writeProjection(doc);
  }
  private async markSearchChange(id: string) {
    const revision = await this.searchRevision() + 1;
    await this.set('searchRevision', revision);
    await this.db.queryAsync('INSERT OR REPLACE INTO search_changes (id,revision) VALUES (?,?)', [id, revision]);
  }
  private async writeProjection(doc: DocumentRecord) {
    if (doc.year && !normalizeYear(doc.year)) {
      try {
        const item = await Zotero.Items.getByLibraryAndKeyAsync(doc.libraryID, doc.itemKey);
        const date = item?.getField('date');
        doc = { ...doc, year: normalizeYear(Zotero.Date?.strToDate?.(date)?.year || date) };
      } catch { /* Missing Zotero metadata stays unknown, never fabricate a year. */ }
    }
    const { document, blocks, vectors } = projectDocument(doc);
    await this.db.queryAsync('INSERT OR REPLACE INTO document_summaries (id,data) VALUES (?,?)', [doc.id, JSON.stringify(summarize(doc))]);
    await this.db.queryAsync('INSERT OR REPLACE INTO search_documents (id,data) VALUES (?,?)', [doc.id, JSON.stringify(document)]);
    await this.db.queryAsync('DELETE FROM search_blocks WHERE document_id=?', [doc.id]);
    await this.db.queryAsync('DELETE FROM search_vectors WHERE document_id=?', [doc.id]);
    for (const block of blocks) await this.db.queryAsync('INSERT INTO search_blocks (id,document_id,layer,data) VALUES (?,?,?,?)',
      [block.id, doc.id, block.layer, JSON.stringify(block)]);
    for (const vector of vectors) await this.db.queryAsync('INSERT INTO search_vectors (id,document_id,layer,fingerprint,data) VALUES (?,?,?,?,?)',
      [vector.id, doc.id, vector.layer, vector.fingerprint, JSON.stringify(vector)]);
    await this.markSearchChange(doc.id);
  }
  private async deleteProjection(id: string) {
    for (const table of ['search_blocks', 'search_vectors']) await this.db.queryAsync(`DELETE FROM ${table} WHERE document_id=?`, [id]);
    await this.db.queryAsync('DELETE FROM search_documents WHERE id=?', [id]);
    await this.markSearchChange(id);
  }
  async searchRevision(): Promise<number> { return this.get('searchRevision', 0); }
  async searchDocuments(): Promise<SearchDocument[]> {
    return (await this.db.columnQueryAsync('SELECT data FROM search_documents')).map((s: string) => JSON.parse(s));
  }
  async searchDocument(id: string): Promise<SearchDocument | null> {
    const raw = await this.db.valueQueryAsync('SELECT data FROM search_documents WHERE id=?', [id]); return raw ? JSON.parse(raw) : null;
  }
  async searchBundle(layer: string, since = -1): Promise<SearchBundle> {
    return this.db.executeTransaction(async () => {
      const revision = await this.searchRevision();
      const changed = since < 0 ? null : await this.db.columnQueryAsync('SELECT id FROM search_changes WHERE revision>?', [since]);
      const documents = await this.db.columnQueryAsync(since < 0 ? 'SELECT data FROM search_documents'
        : 'SELECT data FROM search_documents WHERE id IN (SELECT id FROM search_changes WHERE revision>?)', since < 0 ? [] : [since]);
      const blocks = await this.db.columnQueryAsync(`SELECT data FROM search_blocks WHERE ${layer === 'fulltext' ? "layer='fulltext'" : "layer IN ('metadata','abstract')"}${since < 0 ? '' : ' AND document_id IN (SELECT id FROM search_changes WHERE revision>?)'}`, since < 0 ? [] : [since]);
      return { revision, documents: documents.map((s: string) => JSON.parse(s)), blocks: blocks.map((s: string) => JSON.parse(s)), removed: changed || [], reset: since < 0 };
    });
  }
  async searchVectors(layer: string, fingerprint: string, ids: string[]): Promise<SearchVector[]> {
    const vectors: SearchVector[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);
      const rows = await this.db.columnQueryAsync(`SELECT data FROM search_vectors WHERE fingerprint=? AND ${layer === 'auto' ? "layer IN ('metadata','abstract')" : 'layer=?'} AND document_id IN (${batch.map(() => '?').join(',')})`,
        [fingerprint, ...(layer === 'auto' ? [] : [layer]), ...batch]);
      vectors.push(...rows.map((s: string) => JSON.parse(s)));
    }
    return vectors;
  }
  async searchSnapshot(layer: string, revision: number): Promise<string | null> {
    return await this.db.valueQueryAsync('SELECT data FROM search_snapshots WHERE layer=? AND revision=?', [layer, revision]) || null;
  }
  async saveSearchSnapshot(layer: string, revision: number, data: string) {
    await this.db.queryAsync('INSERT OR REPLACE INTO search_snapshots (layer,revision,data) VALUES (?,?,?)', [layer, revision, data]);
  }
  async workspace(id: string): Promise<any> {
    const raw = await this.db.valueQueryAsync('SELECT data FROM research_workspaces WHERE id=?', [id]); return raw ? JSON.parse(raw) : null;
  }
  async putWorkspace(value: any) {
    await this.db.queryAsync('INSERT OR REPLACE INTO research_workspaces (id,data) VALUES (?,?)', [value.id, JSON.stringify(value)]);
  }
  async workspaces(): Promise<any[]> { return (await this.db.columnQueryAsync('SELECT data FROM research_workspaces')).map((s: string) => JSON.parse(s)); }
  async deleteWorkspace(id: string) { await this.db.queryAsync('DELETE FROM research_workspaces WHERE id=?', [id]); }
  async removeDocument(id: string) {
    await this.db.executeTransaction(async () => {
      await this.db.queryAsync('DELETE FROM documents WHERE id=?', [id]);
      await this.db.queryAsync('DELETE FROM document_summaries WHERE id=?', [id]);
      await this.db.queryAsync('DELETE FROM jobs WHERE document_id=?', [id]);
      await this.deleteProjection(id);
    });
  }
  async deleteJob(id: string, documentID: string) {
    return this.db.executeTransaction(async () => {
      const raw = await this.db.valueQueryAsync('SELECT data FROM jobs WHERE id=? AND document_id=?', [id, documentID]);
      if (!raw) return false;
      const job = JSON.parse(raw) as Job;
      if (!canDeleteJob(job)) return false;
      const docRaw = await this.db.valueQueryAsync('SELECT data FROM documents WHERE id=?', [documentID]);
      const doc = docRaw ? JSON.parse(docRaw) as DocumentRecord : null;
      if (!doc?.indexedAt) {
        await this.db.queryAsync('DELETE FROM documents WHERE id=?', [documentID]);
        await this.db.queryAsync('DELETE FROM document_summaries WHERE id=?', [documentID]);
        await this.deleteProjection(documentID);
      }
      await this.db.queryAsync('DELETE FROM jobs WHERE id=? AND document_id=?', [id, documentID]);
      return true;
    });
  }
  async jobs(): Promise<Job[]> {
    return (await this.db.columnQueryAsync('SELECT data FROM jobs')).map((s: string) => JSON.parse(s));
  }
  async putJob(job: Job, create = false) {
    if (create) await this.db.queryAsync('INSERT OR REPLACE INTO jobs (id,document_id,data) SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM documents WHERE id=?)',
      [job.id, job.documentID, JSON.stringify(job), job.documentID]);
    else await this.db.queryAsync('UPDATE jobs SET data=? WHERE id=? AND document_id=?', [JSON.stringify(job), job.id, job.documentID]);
  }
  async commit(doc: DocumentRecord, job: Job) {
    await this.db.executeTransaction(async () => {
      const current = await this.db.valueQueryAsync('SELECT id FROM jobs WHERE document_id=?', [job.documentID]);
      if (current !== job.id || !await this.document(doc.id)) return;
      await this.writeDocument(doc); await this.putJob(job);
    });
  }
  async close() { if (this.db) await this.db.closeDatabase(); }
}
