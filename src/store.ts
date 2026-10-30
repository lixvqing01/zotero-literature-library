import type { DocumentRecord, PublicError } from './core';
export interface Job {
  id: string; documentID: string; state: string; attempts: number; nextRun: number;
  batchID?: string; dataID?: string; pdfHash?: string; metadataHash?: string;
  force?: boolean; progress?: any; error?: PublicError; createdAt: string;
  retryState?: string; credentialRevision?: number;
  parserFingerprint?: string;
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
    await this.db.queryAsync('CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, document_id TEXT NOT NULL UNIQUE, data TEXT NOT NULL)');
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
  async putDocument(doc: DocumentRecord) {
    await this.db.queryAsync('INSERT OR REPLACE INTO documents (id,data) VALUES (?,?)', [doc.id, JSON.stringify(doc)]);
  }
  async removeDocument(id: string) {
    await this.db.executeTransaction(async () => {
      await this.db.queryAsync('DELETE FROM documents WHERE id=?', [id]);
      await this.db.queryAsync('DELETE FROM jobs WHERE document_id=?', [id]);
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
      await this.putDocument(doc); await this.putJob(job);
    });
  }
  async close() { if (this.db) await this.db.closeDatabase(); }
}
