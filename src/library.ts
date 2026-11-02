import { AppError, boundedInt, publicError,
  type DocumentRecord, type Layer } from './core';
import { Credentials } from './credentials';
import { MinerUClient, safeRemoteURL } from './mineru';
import { importArchive } from './pdf-results';
import { Inference } from './inference';
import { Store, type Job } from './store';
import { modelFingerprint } from './models';
import { CitationBridge } from './citation-bridge';
import { metadataText, rankDocuments, readFulltext, searchBlocks } from './retrieval';
import { ACTIVE, canResume, resumedJob, requiresRebuild, type ResumeReason } from './queue';

export interface Settings { autoIndex: boolean; cloudEnabled: boolean; model: 'qwen' | 'e5';
  embeddingsEnabled: boolean; mcpEnabled: boolean; ocr: boolean; }
const DEFAULTS: Settings = { autoIndex: false, cloudEnabled: false, model: 'qwen',
  embeddingsEnabled: true, mcpEnabled: false, ocr: true };
const AUTH_ERRORS = ['MINERU_KEY_MISSING', 'MINERU_TOKEN_EXPIRED', 'MINERU_TOKEN_INVALID', 'MINERU_AUTH_FAILED'];
export class Library {
  store: Store;
  credentials: Credentials;
  mineru: MinerUClient;
  inference: Inference;
  citations: CitationBridge;
  settings = { ...DEFAULTS };
  private working = false;
  private stopped = false;
  private timer: any;
  private scanTimer: any;
  private listeners = new Set<() => void>();
  private enqueueChain: Promise<any> = Promise.resolve();
  private transfers = new Set<any>();
  private async remoteFetch(url: string, options: any = {}) {
    const controller = new this.win.AbortController(); this.transfers.add(controller);
    const timer = this.win.setTimeout(() => controller.abort(), 120000);
    const done = () => { this.win.clearTimeout(timer); this.transfers.delete(controller); };
    try { return { response: await this.win.fetch(url, { ...options, signal: controller.signal }), done }; }
    catch { done(); throw new AppError({ code: 'MINERU_NETWORK_ERROR', message: 'MinerU 文件传输中断或超时，请重试。', retryable: true }); }
  }
  constructor(public root: string, private win: any) {
    this.store = new Store(root);
    this.credentials = new Credentials(this.store, () => this.changed());
    this.mineru = new MinerUClient(async (method, url, body, headers) => {
      const xhr = await Zotero.HTTP.request(method, url, { headers,
        body: body === undefined ? undefined : JSON.stringify(body), responseType: 'text',
        successCodes: false, timeout: 60000, debug: false, logBodyLength: 0 });
      let parsed; try { parsed = JSON.parse(xhr.responseText); } catch { parsed = {}; }
      return { status: xhr.status, body: parsed };
    }, () => this.credentials.read(), (revision, error) => this.credentials.report(revision, error));
    this.inference = new Inference(win, win, () => this.changed(), PathUtils.join(root, 'models'));
    this.citations = new CitationBridge(this);
  }
  async init() {
    await this.store.init();
    this.settings = { ...DEFAULTS, ...await this.store.get('settings', DEFAULTS) };
    await this.credentials.init();
    this.citations.install();
    if (!await this.store.get('mcpToken', '')) await this.store.set('mcpToken',
      Services.uuid.generateUUID().toString().replace(/[{}-]/g, '') + Services.uuid.generateUUID().toString().replace(/[{}-]/g, ''));
    for (const job of await this.store.jobs()) {
      if (job.state === 'submitting') {
        job.state = 'failed'; job.retryState = 'queued';
        job.error = { code: 'MINERU_SUBMISSION_UNCERTAIN', message: '上次提交响应未保存，是否已创建云端任务未知，请检查后手动重试。', retryable: false, requires_user_action: true };
        await this.store.putJob(job);
      }
      if (job.state === 'uploading') {
        // A lost upload response must be reconciled against the existing cloud task.
        job.state = job.batchID ? 'pending' : 'queued';
        await this.store.putJob(job);
      }
    }
    this.schedule(2000);
    this.scanTimer = this.win.setInterval(() => this.reconcile().catch(() => {}), 5 * 60000);
  }
  onChange(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  changed() { for (const listener of this.listeners) { try { listener(); } catch {} } }
  async saveSettings(input: Partial<Settings>) {
    const wasAuto = this.settings.autoIndex, wasCloud = this.settings.cloudEnabled;
    const previousModel = this.settings.model, wereEmbeddings = this.settings.embeddingsEnabled;
    const safe: Partial<Settings> = {};
    for (const k of ['autoIndex', 'cloudEnabled', 'embeddingsEnabled', 'mcpEnabled', 'ocr'] as const)
      if (typeof input[k] === 'boolean') safe[k] = input[k];
    if (input.model === 'qwen' || input.model === 'e5') safe.model = input.model;
    this.settings = { ...this.settings, ...safe };
    await this.store.set('settings', this.settings); this.changed(); this.schedule();
    if (!wasAuto && this.settings.autoIndex) {
      await this.store.set('autoScanSince', new Date().toISOString().slice(0, 19).replace('T', ' '));
    }
    if (!wasCloud && this.settings.cloudEnabled) await this.resume('cloud');
    if (previousModel !== this.settings.model || wereEmbeddings && !this.settings.embeddingsEnabled) await this.resume('model');
    return this.settings;
  }
  modelFingerprint() { return modelFingerprint(this.settings.model) + ':layers-v2'; }
  parserFingerprint() { return `mineru-v4:vlm:table:formula:ocr=${this.settings.ocr}:schema1`; }
  async snapshot(item: any, attachment?: any): Promise<DocumentRecord> {
    const group = Zotero.Libraries.get(item.libraryID)?.libraryType === 'group'
      ? Zotero.Groups.getGroupIDFromLibraryID(item.libraryID) : null;
    const libraryKey = group ? `groups/${group}` : 'library';
    const creators = item.getCreators().map((c: any) => c.name || [c.firstName, c.lastName].filter(Boolean).join(' ')).join(', ');
    const doc: DocumentRecord = { id: `${item.libraryID}:${item.key}:${attachment?.key || 'metadata'}`,
      libraryID: item.libraryID, libraryKey, itemKey: item.key, attachmentKey: attachment?.key || null,
      title: item.getField('title') || 'Untitled', creators, year: String(item.getField('date') || '').slice(0, 4),
      publication: item.getField('publicationTitle') || '', doi: item.getField('DOI') || '',
      abstract: item.getField('abstractNote') || '', tags: item.getTags().map((t: any) => t.tag),
      collections: item.getCollections().map((id: number) => Zotero.Collections.get(id)?.key).filter(Boolean),
      modified: item.dateModified || '', sections: [], chunks: [], state: 'metadata' };
    doc.bibliographic = Object.fromEntries(['ISSN', 'volume', 'issue', 'pages', 'url', 'publisher', 'journalAbbreviation', 'language']
      .map(field => [field, String(item.getField(field) || '')]));
    doc.metadataHash = await this.hashText(JSON.stringify([doc.title, doc.creators, doc.year, doc.publication, doc.doi,
      doc.abstract, doc.tags, doc.collections, doc.bibliographic]));
    return doc;
  }
  async hashText(text: string): Promise<string> {
    const hash = Cc['@mozilla.org/security/hash;1'].createInstance(Ci.nsICryptoHash);
    hash.init(hash.SHA256);
    const bytes = new TextEncoder().encode(text);
    hash.update(bytes, bytes.length);
    return Array.from(hash.finish(false), (c: any) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  }
  async hashFile(path: string): Promise<string> {
    const stream = Cc['@mozilla.org/network/file-input-stream;1'].createInstance(Ci.nsIFileInputStream);
    stream.init(Zotero.File.pathToFile(path), 0x01, 0, 0);
    try {
      const hash = Cc['@mozilla.org/security/hash;1'].createInstance(Ci.nsICryptoHash);
      hash.init(hash.SHA256); hash.updateFromStream(stream, -1);
      return Array.from(hash.finish(false), (c: any) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
    } finally { stream.close(); }
  }
  async resolve(libraryID: number, key: string) {
    const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, key);
    if (!item || item.deleted) throw new AppError({ code: 'ITEM_NOT_FOUND', message: 'Zotero 条目不存在或已在回收站。', retryable: false });
    return item;
  }
  async enqueueItem(item: any, force = false, automatic = false) {
    const task = this.enqueueChain.then(() => this.enqueueItemInternal(item, force, automatic));
    this.enqueueChain = task.catch(() => {});
    return task;
  }
  private async enqueueItemInternal(item: any, force = false, automatic = false) {
    if (item.isNote?.() || item.isAnnotation?.()) return [];
    if (item.isAttachment?.() && item.parentID) item = await Zotero.Items.getAsync(item.parentID);
    if (!item || item.deleted) return [];
    if (item.getTags().some((t: any) => t.tag === 'literature-library-exclude')) return [];
    const attachments = item.isAttachment?.() ? [item] : (await Zotero.Items.getAsync(item.getAttachments()))
      .filter((a: any) => a.isPDFAttachment?.() && !a.deleted);
    const jobs = await this.store.jobs();
    const results: any[] = [];
    for (const attachment of attachments.length ? attachments : [null]) {
      const fresh = await this.snapshot(item, attachment);
      const existing = jobs.find(j => j.documentID === fresh.id);
      if (existing && ACTIVE.includes(existing.state)) {
        results.push({ document_id: fresh.id, job_id: existing.id, state: 'already_queued' }); continue;
      }
      // Periodic scans must never turn a paused/uncertain cloud submission into a
      // new upload. Explicit rebuild remains available after the user checks it.
      if (existing && !['done', 'skipped'].includes(existing.state) && (automatic || requiresRebuild(existing) && !force)) {
        results.push({ document_id: fresh.id, job_id: existing.id, state: existing.state, error: existing.error }); continue;
      }
      const old = await this.store.document(fresh.id);
      const doc = old ? { ...old, ...fresh, chunks: old.chunks, sections: old.sections,
        markdown: old.markdown, pdfHash: old.pdfHash, parserFingerprint: old.parserFingerprint,
        modelFingerprint: old.modelFingerprint, indexedAt: old.indexedAt, state: old.state,
        metadataHash: old.metadataHash } : fresh;
      await this.store.putDocument(doc);
      const job: Job = { id: existing?.id || Services.uuid.generateUUID().toString(), documentID: doc.id,
        state: 'queued', attempts: 0, nextRun: Date.now(), force,
        createdAt: new Date().toISOString(), metadataHash: fresh.metadataHash };
      await this.store.putJob(job, true);
      results.push({ document_id: doc.id, job_id: job.id, state: 'queued' });
    }
    // Metadata-only placeholders are replaced once a real attachment is present.
    if (attachments.length) await this.store.removeDocument(`${item.libraryID}:${item.key}:metadata`);
    this.changed(); this.schedule(); return results;
  }
  async enqueueSelected(force = false) {
    const items = this.win.ZoteroPane.getSelectedItems();
    const result: any[] = [];
    for (const item of items) result.push(...await this.enqueueItem(item, force));
    return result;
  }
  async resume(reason: ResumeReason = 'manual', jobID?: string) {
    let resumed = 0;
    for (const job of await this.store.jobs()) {
      if ((!jobID || job.id === jobID) && canResume(job, reason)) {
        await this.store.putJob(resumedJob(job)); resumed++;
      }
    }
    this.schedule(); this.changed();
    return { resumed };
  }
  schedule(delay = 500) {
    if (this.stopped) return;
    if (this.timer) this.win.clearTimeout(this.timer);
    this.timer = this.win.setTimeout(() => { this.tick().catch(() => {}); }, delay);
  }
  async tick() {
    if (this.working || this.stopped) return;
    this.working = true;
    try {
      const jobs = await this.store.jobs();
      const job = jobs.filter(j => ACTIVE.includes(j.state) && j.nextRun <= Date.now())
        .sort((a, b) => a.nextRun - b.nextRun)[0];
      if (job) await this.process(job);
    } finally { this.working = false; if (!this.stopped) this.schedule(1500); }
  }
  private async process(job: Job) {
    let doc = await this.store.document(job.documentID);
    if (!doc) return;
    if (!(await this.store.jobs()).some(current => current.id === job.id && current.documentID === doc!.id)) return;
    try {
      if (job.state === 'retry') job.state = job.retryState || (job.batchID ? 'pending' : 'queued');
      const item = await this.resolve(doc.libraryID, doc.itemKey);
      const attachment = doc.attachmentKey ? await this.resolve(doc.libraryID, doc.attachmentKey) : null;
      const fresh = await this.snapshot(item, attachment);
      const oldMetadataHash = doc.metadataHash;
      doc = { ...doc, ...fresh, chunks: doc.chunks, sections: doc.sections, markdown: doc.markdown,
        pdfHash: doc.pdfHash, parserFingerprint: doc.parserFingerprint, modelFingerprint: doc.modelFingerprint,
        indexedAt: doc.indexedAt, state: doc.state };
      if (job.state === 'queued' || job.state === 'waiting_file') {
        if (attachment) {
          const path = await attachment.getFilePathAsync();
          if (!path || !await IOUtils.exists(path)) {
            job.state = 'waiting_file'; job.attempts++; job.nextRun = Date.now() + Math.min(300000, 5000 * 2 ** Math.min(job.attempts, 6));
            if (job.attempts > 12) throw new AppError({ code: 'PDF_MISSING', message: 'PDF 尚未下载，请在 Zotero 下载后重试。', retryable: false });
            await this.store.putJob(job); return;
          }
          const stat = await IOUtils.stat(path);
          if (stat.size > 200 * 1024 * 1024) throw new AppError({ code: 'MINERU_FILE_TOO_LARGE', message: 'PDF 超过 200 MB 上传限制。', retryable: false });
          job.pdfHash = await this.hashFile(path);
          if (!job.force && doc.pdfHash === job.pdfHash && doc.parserFingerprint === this.parserFingerprint() && doc.markdown) {
            if (oldMetadataHash === fresh.metadataHash && (!this.settings.embeddingsEnabled || doc.modelFingerprint === this.modelFingerprint())) {
              doc.state = 'ready'; doc.error = undefined; job.state = 'skipped'; job.error = undefined;
              await this.store.commit(doc, job); return;
            }
            job.state = 'embedding';
          } else {
            if (!this.settings.cloudEnabled) throw new AppError({ code: 'MINERU_UPLOAD_DISABLED', message: '请在设置中启用 MinerU PDF 上传后继续。', retryable: false, requires_user_action: true });
            job.credentialRevision = (await this.credentials.read()).revision;
            job.dataID = `${job.id.replace(/[{}-]/g, '')}_${job.pdfHash.slice(0, 16)}`;
            job.parserFingerprint = this.parserFingerprint(); job.state = 'submitting'; await this.store.putJob(job);
            let task;
            try { task = await this.mineru.create(`${attachment.key}.pdf`, job.dataID, this.settings.ocr); }
            catch (error) {
              if (publicError(error).code === 'MINERU_NETWORK_ERROR') throw new AppError({ code: 'MINERU_SUBMISSION_UNCERTAIN',
                message: '提交响应中断，云端任务是否创建未知；请检查 MinerU 后手动重试。', retryable: false, requires_user_action: true });
              throw error;
            }
            job.batchID = task.batchID; job.state = 'uploading'; job.force = false;
            await this.store.putJob(job); this.changed();
            const bytes = await IOUtils.read(path);
            const transfer = await this.remoteFetch(safeRemoteURL(task.uploadURL), { method: 'PUT', body: bytes,
              credentials: 'omit', redirect: 'error' });
            const response = transfer.response; transfer.done();
            if (!response.ok) throw new AppError({ code: 'MINERU_UPLOAD_FAILED',
              message: 'PDF 上传未完成，请检查网络或重新提交。', retryable: false });
            job.state = 'pending'; job.nextRun = Date.now() + 3000;
          }
        } else {
          if (!job.force && doc.indexedAt && oldMetadataHash === fresh.metadataHash
              && (!this.settings.embeddingsEnabled || doc.modelFingerprint === this.modelFingerprint())) {
            doc.state = 'ready'; doc.error = undefined; job.state = 'skipped'; job.error = undefined;
            await this.store.commit(doc, job); return;
          }
          job.state = 'embedding';
        }
      }
      if (['pending', 'running', 'converting', 'download', 'uploading'].includes(job.state)) {
        if (!this.settings.cloudEnabled) throw new AppError({ code: 'MINERU_UPLOAD_DISABLED', message: 'MinerU 云端访问已停用。', retryable: false });
        const result = await this.mineru.poll(job.batchID!, job.dataID!);
        if (result.state === 'waiting-file') throw new AppError({ code: 'MINERU_UPLOAD_INCOMPLETE',
          message: '原任务尚未收到完整 PDF，请强制重建；未自动重复上传。', retryable: false, requires_user_action: true });
        if (result.state !== 'done') {
          job.state = ['pending', 'running', 'converting'].includes(result.state) ? result.state : 'pending';
          job.progress = result.progress; job.nextRun = Date.now() + 5000;
          await this.store.putJob(job); this.changed(); return;
        }
        job.state = 'download'; await this.store.putJob(job); this.changed();
        const target = PathUtils.join(this.root, 'documents', doc.id.replaceAll(':', '_'), job.id.replace(/[{}-]/g, ''));
        await IOUtils.makeDirectory(target, { ignoreExisting: true });
        const zip = PathUtils.join(target, 'result.zip');
        const transfer = await this.remoteFetch(result.downloadURL!, { credentials: 'omit', redirect: 'error' });
        const response = transfer.response;
        if (!response.ok) { transfer.done(); throw new AppError({ code: 'MINERU_RESULT_DOWNLOAD_FAILED', message: '无法下载 MinerU 结果，请稍后重试。', retryable: true }); }
        const max = 512 * 1024 * 1024;
        if (Number(response.headers.get('content-length')) > max) { transfer.done(); await response.body?.cancel(); throw Error('解析结果超过下载上限。'); }
        const reader = response.body.getReader(); const parts: Uint8Array[] = []; let size = 0;
        try {
          for (;;) { const { done, value } = await reader.read(); if (done) break;
            size += value.length; if (size > max) throw Error('解析结果超过下载上限。'); parts.push(value);
          }
        } finally { transfer.done(); await reader.cancel(); }
        const buffer = new Uint8Array(size); let offset = 0;
        for (const part of parts) { buffer.set(part, offset); offset += part.length; }
        await IOUtils.write(zip, buffer);
        const parsed = await importArchive(zip, target);
        const path = await attachment.getFilePathAsync();
        if (await this.hashFile(path) !== job.pdfHash) {
          job.batchID = undefined; job.state = 'queued'; job.nextRun = Date.now(); await this.store.putJob(job); return;
        }
        doc = { ...doc, ...parsed, pdfHash: job.pdfHash, parserFingerprint: job.parserFingerprint || this.parserFingerprint(), modelFingerprint: undefined };
        await IOUtils.writeJSON(PathUtils.join(target, 'document.json'), { sections: doc.sections, chunks: doc.chunks,
          pdfHash: doc.pdfHash, parserFingerprint: doc.parserFingerprint });
        job.state = 'embedding';
        await this.store.commit(doc, job);
      }
      if (job.state === 'embedding') {
        const abstractChunks = doc.abstract ? [{ id: 'abstract', sectionId: 'abstract', text: doc.abstract,
          page: null, layer: 'abstract' as Layer }] : [];
        doc.chunks = [{ id: 'metadata', sectionId: 'metadata', text: metadataText(doc), page: null, layer: 'metadata' },
          ...abstractChunks, ...doc.chunks.filter(c => c.layer === 'fulltext')];
        if (this.settings.embeddingsEnabled) {
          const model = this.settings.model, fingerprint = this.modelFingerprint();
          for (let i = 0; i < doc.chunks.length; i += 2) {
            if (this.stopped) return;
            const vectors = await this.inference.embed(model, doc.chunks.slice(i, i + 2).map(c => `${doc!.title}\n${c.text}`));
            vectors.forEach((v, j) => { doc!.chunks[i + j].vector = v; });
            job.progress = { embedded: Math.min(i + 2, doc.chunks.length), total: doc.chunks.length };
            await this.store.putJob(job); this.changed();
          }
          if (this.modelFingerprint() !== fingerprint) throw new AppError({ code: 'MODEL_CHANGED', message: '模型已切换，请重新入库。', retryable: false });
          doc.modelFingerprint = fingerprint;
        } else { doc.chunks.forEach(c => delete c.vector); doc.modelFingerprint = undefined; }
        if (attachment && await this.hashFile(await attachment.getFilePathAsync()) !== job.pdfHash
            || (await this.snapshot(await this.resolve(doc.libraryID, doc.itemKey), attachment)).metadataHash !== doc.metadataHash) {
          job.state = 'queued'; job.batchID = undefined; job.nextRun = Date.now();
          await this.store.putJob(job); return;
        }
        doc.state = 'ready'; doc.indexedAt = new Date().toISOString(); doc.error = undefined;
        job.state = 'done'; job.error = undefined; job.progress = undefined;
      }
      await this.store.commit(doc, job);
    } catch (error) {
      const detail = publicError(error);
      job.error = detail; job.attempts++;
      job.retryState = job.state === 'submitting' ? 'queued' : job.state;
      job.state = AUTH_ERRORS.includes(detail.code) ? 'blocked_credentials' : detail.code === 'MINERU_UPLOAD_DISABLED'
        ? 'blocked_cloud' : /EMBEDDING|模型|Worker|onnx|wasm/i.test(detail.code + detail.message) ? 'blocked_model'
        : detail.retryable && job.attempts < 6 ? 'retry' : 'failed';
      if (job.state === 'blocked_credentials' && job.credentialRevision !== undefined
          && job.credentialRevision !== this.credentials.status().revision
          && ['configured', 'valid'].includes(this.credentials.status().state)) job.state = 'retry';
      job.nextRun = Date.now() + Math.min(300000, 5000 * 2 ** Math.min(job.attempts, 6));
      // The last usable document remains readable while the replacement is blocked.
      const saved = await this.store.document(job.documentID);
      if (saved) { saved.error = detail; saved.state = saved.indexedAt ? 'stale' : job.state; await this.store.commit(saved, job); }
      else await this.store.putJob(job);
    } finally { this.changed(); }
  }
  async status() {
    const docs = await this.store.summaries(), jobs = await this.store.jobs();
    return { settings: this.settings, credentials: this.credentials.status(), model: this.inference.state, citation_handoff: this.citations.status(),
      coverage: { documents: docs.length, abstracts: docs.filter(d => d.abstract).length,
        fulltext: docs.filter(d => d.hasFulltext).length, vectors: docs.filter(d => d.modelFingerprint === this.modelFingerprint() && d.hasVectors).length },
      queue: jobs.map(job => ({ ...job, can_resume: canResume(job, 'manual'), requires_rebuild: requiresRebuild(job) })),
      local_only: !this.settings.cloudEnabled, parsing_provider: 'mineru', endpoint: `http://127.0.0.1:${Zotero.Prefs.get('httpServer.port') || 23119}/literature-library/mcp` };
  }
  async list() {
    const [docs, jobs] = await Promise.all([this.store.summaries(), this.store.jobs()]);
    const tasks = new Map(jobs.map(job => [job.documentID, job]));
    return docs.map(doc => ({ ...doc,
      taskState: tasks.has(doc.id) && !['done', 'skipped'].includes(tasks.get(doc.id)!.state) ? tasks.get(doc.id)!.state : null,
      hasCurrentVectors: doc.modelFingerprint === this.modelFingerprint() && doc.hasVectors }));
  }
  async read(input: any) {
    const doc = await this.store.document(String(input.document_id));
    if (!doc) throw new Error('未找到已入库文献，请提供 document_id。');
    const layer: Layer = input.layer || 'metadata';
    const base = { document_id: doc.id, item_key: doc.itemKey, title: doc.title, state: doc.state,
      link: `zotero://select/${doc.libraryKey}/items/${doc.itemKey}` };
    const limit = boundedInt(input.max_chars, 12000, 60000);
    if (layer === 'metadata') return { ...base, metadata: { creators: doc.creators, year: doc.year,
      publication: doc.publication, doi: doc.doi, ...doc.bibliographic, tags: doc.tags, collections: doc.collections },
      available_layers: ['metadata', ...(doc.abstract ? ['abstract'] : []), ...(doc.markdown ? ['outline', 'fulltext'] : [])] };
    if (layer === 'abstract') return { ...base, text: doc.abstract.slice(0, limit), source: 'zotero.abstractNote',
      missing: !doc.abstract, truncated: doc.abstract.length > limit };
    if (layer === 'outline') return { ...base, sections: doc.sections.map(({ text, ...s }) => ({ ...s, chars: text.length })) };
    if (layer === 'notes') {
      const item = await this.resolve(doc.libraryID, doc.itemKey);
      const notes = item.getNotes ? await Zotero.Items.getAsync(item.getNotes()) : [];
      const texts = []; let remaining = limit, truncated = false;
      for (const note of notes) {
        const content = String(note.getNote()).replace(/<[^>]*>/g, ' ');
        if (!remaining) { truncated = true; break; }
        const excerpt = content.slice(0, remaining);
        texts.push({ key: note.key, text: excerpt, source: 'user_note' });
        remaining -= excerpt.length; if (excerpt.length < content.length) truncated = true;
      }
      return { ...base, notes: texts, truncated };
    }
    if (layer !== 'fulltext') throw new Error('不支持的 layer。');
    return { ...base, ...readFulltext(doc, input) };
  }
  async search(input: any) {
    const query = String(input.query || '').trim();
    if (!query || query.length > 4000) throw new Error('query 长度必须为 1–4000 字符。');
    const layer = input.layer || 'auto';
    if (!['auto', 'metadata', 'abstract', 'fulltext'].includes(layer)) throw new Error('无效检索层。');
    if (input.mode && !['keyword', 'hybrid', 'semantic'].includes(input.mode)) throw new Error('无效检索模式。');
    const docs = (await this.store.documents()).filter(d => (!input.library_id || d.libraryID === input.library_id)
      && (!input.year || d.year === String(input.year)) && (!input.publication || d.publication.toLowerCase().includes(String(input.publication).toLowerCase())));
    let vector: number[] | undefined, semanticError: any;
    const indexed = docs.filter(d => d.modelFingerprint === this.modelFingerprint() && searchBlocks(d, layer).some(c => c.vector?.length));
    if (input.mode === 'semantic' || input.mode === 'hybrid') {
      try {
        if (docs.length && !indexed.length) throw new AppError({ code: 'INDEX_VECTORS_MISSING',
          message: '当前检索层没有与所选模型匹配的向量，请启用向量化并重新入库。', retryable: false, requires_user_action: true });
        if (docs.length) vector = (await this.inference.embed(this.settings.model, [query], true))[0];
      }
      catch (error) { semanticError = publicError(error); if (input.mode === 'semantic') throw error; }
    }
    return { results: rankDocuments(docs, { ...input, query, layer }, this.modelFingerprint(), vector),
      mode: vector ? input.mode : input.mode === 'semantic' && !docs.length ? 'semantic' : 'keyword',
      warning: semanticError, coverage: { candidates: docs.length, indexed: indexed.length }, active_model: this.modelFingerprint() };
  }
  async reconcile(ids?: number[]) {
    const scanStarted = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const fullScan = !ids;
    const documents = await this.store.documents();
    for (const doc of documents) {
      const item = await Zotero.Items.getByLibraryAndKeyAsync(doc.libraryID, doc.itemKey);
      const att = doc.attachmentKey ? await Zotero.Items.getByLibraryAndKeyAsync(doc.libraryID, doc.attachmentKey) : null;
      if (!item || item.deleted || doc.attachmentKey && (!att || att.deleted) || item.getTags().some((t: any) => t.tag === 'literature-library-exclude'))
        await this.store.removeDocument(doc.id);
    }
    if (this.settings.autoIndex && !ids) {
      const since = await this.store.get('autoScanSince', new Date().toISOString().slice(0, 19).replace('T', ' '));
      const affected = new Set<number>();
      for (const library of Zotero.Libraries.getAll()) {
        for (const item of await Zotero.Items.getAll(library.libraryID, false, false)) {
          if (item.isNote() || item.isAnnotation()) continue;
          if (item.dateAdded >= since || item.dateModified >= since || documents.some(d => d.libraryID === item.libraryID
              && (d.itemKey === item.key || d.attachmentKey === item.key))) affected.add(item.parentID || item.id);
        }
      }
      ids = [...affected];
    }
    if (this.settings.autoIndex && ids) {
      const items = await Zotero.Items.getAsync(ids);
      for (let item of items) {
        if (!item || item.deleted) continue;
        if (item.parentID) item = await Zotero.Items.getAsync(item.parentID);
        if (item) await this.enqueueItem(item, false, true);
      }
    }
    if (this.settings.autoIndex && fullScan) await this.store.set('autoScanSince', scanStarted);
    this.changed();
  }
  async styles() {
    await Zotero.Styles.init();
    return Zotero.Styles.getVisible().map((style: any) => ({ id: style.styleID, title: style.title }));
  }
  async citation(input: any) {
    await Zotero.Styles.init();
    const style = Zotero.Styles.get(String(input.style));
    if (!style) throw new Error('请使用 citation_styles 返回的已安装 style ID。');
    const items = [];
    for (const id of (input.document_ids || []).slice(0, 100)) {
      const doc = await this.store.document(String(id));
      if (doc) items.push(await this.resolve(doc.libraryID, doc.itemKey));
    }
    if (!items.length) throw new Error('未选择有效文献。');
    const engine = style.getCiteProc(input.locale || Zotero.locale, 'text');
    try { return { text: Zotero.Cite.makeFormattedBibliographyOrCitationList(engine, items, 'text', input.output === 'citation'),
      style: style.styleID, dynamic_field: false }; }
    finally { engine.free?.(); }
  }
  async stop() {
    this.citations.close();
    this.stopped = true; this.win.clearTimeout(this.timer); this.inference.close();
    for (const controller of this.transfers) controller.abort();
    this.win.clearInterval(this.scanTimer);
    while (this.working) await new Promise(r => this.win.setTimeout(r, 50));
    await this.store.close();
  }
}
