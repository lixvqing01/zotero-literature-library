import { AppError, boundedInt, publicError, normalizeYear,
  type DocumentRecord, type Layer } from './core';
import { Credentials, EmbeddingCredentials } from './credentials';
import { EmbeddingAPI, embeddingURL } from './embedding-api';
import { MinerUClient, safeRemoteURL, validateUploadPDF } from './mineru';
import { importArchive } from './pdf-results';
import { Inference } from './inference';
import { Store, type Job } from './store';
import { modelFingerprint, type ModelSource } from './models';
import { CitationBridge } from './citation-bridge';
import { metadataText, readFulltext, logicalOutline } from './retrieval';
import { SearchService, SearchTransport } from './search-service';
import { matchesScope } from './search-engine';
import { validateSearch } from './search-input';
import { ResearchWorkspaces } from './research';
import { ACTIVE, canResume, canBulkResume, canDeleteJob, retryExclusion, resumedJob, requiresRebuild, displayJobState, isLibraryDocument, UPLOAD_CONFIRMATION_TIMEOUT, type ResumeReason } from './queue';
import { AgentInstaller } from './agent-installer';

export interface Settings { autoIndex: boolean; cloudEnabled: boolean; model: 'qwen' | 'e5';
  embeddingProvider: 'local' | 'api'; modelSource: ModelSource; embeddingApiBaseUrl: string; embeddingApiModel: string;
  embeddingsEnabled: boolean; mcpEnabled: boolean; ocr: boolean; }
const DEFAULTS: Settings = { autoIndex: false, cloudEnabled: true, model: 'qwen', embeddingProvider: 'local',
  modelSource: 'modelscope', embeddingApiBaseUrl: 'https://api.openai.com/v1', embeddingApiModel: 'text-embedding-3-small',
  embeddingsEnabled: true, mcpEnabled: false, ocr: true };
const AUTH_ERRORS = ['MINERU_KEY_MISSING', 'MINERU_TOKEN_EXPIRED', 'MINERU_TOKEN_INVALID', 'MINERU_AUTH_FAILED'];
export class Library {
  store: Store;
  credentials: Credentials;
  embeddingCredentials: EmbeddingCredentials;
  embeddingAPI: EmbeddingAPI;
  agentInstaller: AgentInstaller;
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
  private lastEmbeddingCheck: any;
  private searchService?: SearchService;
  private researchService?: ResearchWorkspaces;
  private queryVectors = new Map<string, Promise<number[]>>();
  private researchRevision = 0;
  private get research() { return this.researchService ||= new ResearchWorkspaces(this.store); }
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
    this.embeddingCredentials = new EmbeddingCredentials(async () => {
      this.lastEmbeddingCheck = null; await this.store.set('embeddingModelCheck', null); this.changed();
    });
    this.mineru = new MinerUClient(async (method, url, body, headers) => {
      const xhr = await Zotero.HTTP.request(method, url, { headers,
        body: body === undefined ? undefined : JSON.stringify(body), responseType: 'text',
        successCodes: false, timeout: 60000, debug: false, logBodyLength: 0 });
      let parsed; try { parsed = JSON.parse(xhr.responseText); } catch { parsed = {}; }
      return { status: xhr.status, body: parsed };
    }, () => this.credentials.read(), (revision, error) => this.credentials.report(revision, error));
    this.inference = new Inference(win, win, () => this.changed(), PathUtils.join(root, 'models'));
    this.embeddingAPI = new EmbeddingAPI(async (url, key, body) => {
      try {
        const xhr = await Zotero.HTTP.request('POST', url, { headers: { Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json' }, body: JSON.stringify(body), responseType: 'text', successCodes: false,
          timeout: 120000, debug: false, logBodyLength: 0 });
        if (!xhr.status) throw new AppError({ code: 'EMBEDDING_API_NETWORK_ERROR', message: '连接向量 API 失败，请检查网络、端点和服务状态。', retryable: true });
        if (xhr.status < 200 || xhr.status >= 300) throw new AppError({ code: `EMBEDDING_API_HTTP_${xhr.status}`,
          message: xhr.status === 401 || xhr.status === 403 ? '向量 API 鉴权失败，请检查 API Key 与权限。'
            : xhr.status === 429 ? '向量 API 请求受限，请检查额度后重试。'
              : `向量 API 返回 HTTP ${xhr.status}，请检查端点与模型配置。`, retryable: xhr.status === 429 || xhr.status >= 500,
          requires_user_action: xhr.status === 401 || xhr.status === 403 });
        try { return JSON.parse(xhr.responseText); }
        catch { throw new AppError({ code: 'EMBEDDING_API_BAD_RESPONSE', message: '向量 API 没有返回 JSON。', retryable: false }); }
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError({ code: 'EMBEDDING_API_NETWORK_ERROR', message: '连接向量 API 失败，请检查网络、端点和服务状态。', retryable: true });
      }
    }, () => this.embeddingCredentials.read());
    const home = Services.dirsvc.get('Home', Ci.nsIFile).path;
    this.agentInstaller = new AgentInstaller(home, async () => {
      const status = await this.status();
      return { url: status.endpoint, token: await this.store.get('mcpToken', '') };
    });
    this.citations = new CitationBridge(this);
  }
  async init() {
    await this.store.init();
    const storedSettings = await this.store.get('settings', DEFAULTS);
    this.settings = { ...DEFAULTS, ...storedSettings, cloudEnabled: true,
      modelSource: ['modelscope', 'hf-mirror', 'huggingface'].includes(storedSettings.modelSource) ? storedSettings.modelSource : 'modelscope',
      embeddingProvider: storedSettings.embeddingProvider === 'api' ? 'api' : 'local' };
    await this.store.set('settings', this.settings);
    this.lastEmbeddingCheck = await this.store.get('embeddingModelCheck', null);
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
    await this.resume('cloud');
    this.schedule(2000);
    this.scanTimer = this.win.setInterval(() => this.reconcile().catch(() => {}), 5 * 60000);
  }
  onChange(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  changed() { for (const listener of this.listeners) { try { listener(); } catch {} } }
  async saveSettings(input: Partial<Settings>) {
    const wasAuto = this.settings.autoIndex, wasCloud = this.settings.cloudEnabled;
    const previousFingerprint = this.modelFingerprint(), wereEmbeddings = this.settings.embeddingsEnabled;
    const safe: Partial<Settings> = {};
    for (const k of ['autoIndex', 'embeddingsEnabled', 'mcpEnabled', 'ocr'] as const)
      if (typeof input[k] === 'boolean') safe[k] = input[k];
    if (input.model === 'qwen' || input.model === 'e5') safe.model = input.model;
    if (input.embeddingProvider === 'local' || input.embeddingProvider === 'api') safe.embeddingProvider = input.embeddingProvider;
    if (input.modelSource && ['modelscope', 'hf-mirror', 'huggingface'].includes(input.modelSource)) safe.modelSource = input.modelSource;
    if (typeof input.embeddingApiBaseUrl === 'string' && input.embeddingApiBaseUrl.length <= 1200) {
      embeddingURL(input.embeddingApiBaseUrl); safe.embeddingApiBaseUrl = input.embeddingApiBaseUrl.trim();
    }
    if (typeof input.embeddingApiModel === 'string' && input.embeddingApiModel.length <= 300) safe.embeddingApiModel = input.embeddingApiModel.trim();
    this.settings = { ...this.settings, ...safe };
    this.settings.cloudEnabled = true;
    await this.store.set('settings', this.settings); this.changed(); this.schedule();
    if (!wasAuto && this.settings.autoIndex) {
      await this.store.set('autoScanSince', new Date().toISOString().slice(0, 19).replace('T', ' '));
    }
    if (!wasCloud) await this.resume('cloud');
    if (previousFingerprint !== this.modelFingerprint() || wereEmbeddings && !this.settings.embeddingsEnabled) await this.resume('model');
    return this.settings;
  }
  modelFingerprint() {
    if (this.settings.embeddingProvider === 'api') {
      let endpoint = this.settings.embeddingApiBaseUrl.trim().replace(/\/+$/, '').replace(/\/embeddings$/i, '');
      return `openai-embeddings:${endpoint}:${this.settings.embeddingApiModel.trim()}:normalized-v1:layers-v3`;
    }
    return modelFingerprint(this.settings.model, this.settings.modelSource) + ':layers-v3';
  }
  async embedTexts(texts: string[], query = false) {
    if (this.settings.embeddingProvider === 'api')
      return this.embeddingAPI.embed(this.settings.embeddingApiBaseUrl, this.settings.embeddingApiModel, texts);
    return this.inference.embed(this.settings.model, texts, query, this.settings.modelSource);
  }
  async testEmbeddingModel() {
    this.lastEmbeddingCheck = null; await this.store.set('embeddingModelCheck', null);
    const fingerprint = this.modelFingerprint(), provider = this.settings.embeddingProvider;
    const model = provider === 'local' ? this.settings.model : this.settings.embeddingApiModel;
    const vectors = await this.embedTexts(['测试本地或 API 向量模型是否正常工作。']);
    if (fingerprint !== this.modelFingerprint()) throw new Error('模型配置已变化，请测试当前模型。');
    const result = { state: 'ready', provider, model, dimension: vectors[0].length, checkedAt: new Date().toISOString(), fingerprint };
    await this.store.set('embeddingModelCheck', result); this.lastEmbeddingCheck = result; this.changed(); return result;
  }
  parserFingerprint() { return `mineru-v4:vlm:table:formula:ocr=${this.settings.ocr}:schema1`; }
  async snapshot(item: any, attachment?: any): Promise<DocumentRecord> {
    const group = Zotero.Libraries.get(item.libraryID)?.libraryType === 'group'
      ? Zotero.Groups.getGroupIDFromLibraryID(item.libraryID) : null;
    const libraryKey = group ? `groups/${group}` : 'library';
    const creators = item.getCreators().map((c: any) => c.name || [c.firstName, c.lastName].filter(Boolean).join(' ')).join(', ');
    const doc: DocumentRecord = { id: `${item.libraryID}:${item.key}:${attachment?.key || 'metadata'}`,
      libraryID: item.libraryID, libraryKey, itemKey: item.key, attachmentKey: attachment?.key || null,
      title: item.getField('title') || 'Untitled', creators, year: normalizeYear(Zotero.Date?.strToDate?.(String(item.getField('date') || ''))?.year || item.getField('date')),
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
  async resume(reason: ResumeReason = 'manual', jobID?: string | string[]) {
    let resumed = 0, skipped = 0;
    const exclusions: Record<string, number> = {};
    const targetIDs = Array.isArray(jobID) ? new Set(jobID) : jobID ? new Set([jobID]) : null;
    for (const job of await this.store.jobs()) {
      if ((!targetIDs || targetIDs.has(job.id)) && reason === 'manual' && (!jobID || Array.isArray(jobID)) && !['done', 'skipped'].includes(job.state)) {
        if (!canBulkResume(job)) {
          if (!ACTIVE.includes(job.state)) { skipped++; const cause = retryExclusion(job) || '当前状态不可重试'; exclusions[cause] = (exclusions[cause] || 0) + 1; }
          continue;
        }
        const doc = await this.store.document(job.documentID);
        let hasPDF = false;
        try {
          if (doc?.attachmentKey) {
            const attachment = await this.resolve(doc.libraryID, doc.attachmentKey);
            const path = await attachment.getFilePathAsync();
            hasPDF = !!path && await IOUtils.exists(path);
          }
        } catch {}
        if (!hasPDF) { skipped++; exclusions['无可用 PDF 附件'] = (exclusions['无可用 PDF 附件'] || 0) + 1; continue; }
      }
      if ((!targetIDs || targetIDs.has(job.id)) && canResume(job, reason)) {
        const resumedTask = resumedJob(job);
        const saved = await this.store.document(job.documentID);
        if (saved) { saved.error = undefined; saved.state = saved.indexedAt ? 'stale' : resumedTask.state; await this.store.commit(saved, resumedTask); }
        else await this.store.putJob(resumedTask);
        resumed++;
      }
    }
    this.schedule(); this.changed();
    return { resumed, skipped, exclusions };
  }
  async deleteJobs(jobIDs: string[]) {
    const selected = new Set(jobIDs);
    let deleted = 0, skipped = 0;
    const jobs = await this.store.jobs();
    for (const job of jobs) {
      if (!selected.has(job.id)) continue;
      if (!canDeleteJob(job)) { skipped++; continue; }
      if (await this.store.deleteJob(job.id, job.documentID)) deleted++; else skipped++;
    }
    this.changed();
    return { deleted, skipped };
  }
  async clearCompletedJobs() {
    const jobs = await this.store.jobs();
    return this.deleteJobs(jobs.filter(job => ['done', 'skipped'].includes(job.state)).map(job => job.id));
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
            const bytes = await IOUtils.read(path);
            validateUploadPDF(bytes, stat.size);
            job.pdfBytes = bytes.length;
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
            const transfer = await this.remoteFetch(safeRemoteURL(task.uploadURL), { method: 'PUT', body: bytes,
              credentials: 'omit', redirect: 'error' });
            const response = transfer.response; transfer.done();
            if (!response.ok) throw new AppError({ code: 'MINERU_UPLOAD_FAILED',
              message: `PDF 上传返回 HTTP ${response.status}，请检查网络或重新提交。`, retryable: false });
            job.uploadHTTPStatus = response.status;
            job.uploadCompletedAt = Date.now(); job.uploadWaitSince = job.uploadCompletedAt;
            job.state = 'pending'; job.nextRun = Date.now() + 3000;
            job.progress = { stage: 'upload_confirmation', uploaded_bytes: bytes.length,
              message: 'PDF 已上传，等待 MinerU 确认接收；将继续查询原任务。' };
            doc.error = undefined; job.error = undefined;
            await this.store.commit(doc, job); return;
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
        if (result.state === 'waiting-file') {
          job.uploadWaitSince ??= Date.now();
          if (Date.now() - job.uploadWaitSince >= UPLOAD_CONFIRMATION_TIMEOUT)
            throw new AppError({ code: 'MINERU_UPLOAD_CONFIRMATION_TIMEOUT', message: job.uploadCompletedAt
              ? `上传已返回 HTTP ${job.uploadHTTPStatus || '2xx'}，但 MinerU 在 5 分钟内仍未确认文件。可恢复查询原任务；需要重新上传时再重建。`
              : 'MinerU 仍在等待文件，上次上传是否完成尚未确认。可恢复查询原任务，或检查原任务后重建。',
              retryable: false, requires_user_action: true });
          job.state = 'pending'; job.error = undefined; doc.error = undefined;
          job.progress = { stage: 'upload_confirmation', uploaded_bytes: job.pdfBytes,
            message: '等待 MinerU 确认上传；将继续查询原任务，不重复上传。' };
          job.nextRun = Date.now() + 5000;
          await this.store.commit(doc, job); return;
        }
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
          const fingerprint = this.modelFingerprint();
          for (let i = 0; i < doc.chunks.length; i += 2) {
            if (this.stopped) return;
            const vectors = await this.embedTexts(doc.chunks.slice(i, i + 2).map(c => `${doc!.title}\n${c.text}`));
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
    const taskByDocument = new Map(jobs.map(job => [job.documentID, job]));
    const summaryByDocument = new Map(docs.map(doc => [doc.id, doc]));
    const libraryDocs = docs.filter(doc => isLibraryDocument(doc, taskByDocument.get(doc.id)));
    const embeddingModel = this.settings.embeddingProvider === 'api' ? { state: this.embeddingCredentials.status().state,
      provider: 'api', model: this.settings.embeddingApiModel, dimension: this.lastEmbeddingCheck?.fingerprint === this.modelFingerprint() ? this.lastEmbeddingCheck.dimension : null,
      checkedAt: this.lastEmbeddingCheck?.fingerprint === this.modelFingerprint() ? this.lastEmbeddingCheck.checkedAt : null } : { ...this.inference.state,
      provider: 'local', source: this.settings.modelSource, checkedAt: this.lastEmbeddingCheck?.fingerprint === this.modelFingerprint() ? this.lastEmbeddingCheck.checkedAt : null,
      dimension: this.lastEmbeddingCheck?.fingerprint === this.modelFingerprint() ? this.lastEmbeddingCheck.dimension : null };
    return { settings: this.settings, credentials: this.credentials.status(), embedding_credentials: this.embeddingCredentials.status(),
      model: embeddingModel, inference: this.inference.state, citation_handoff: this.citations.status(),
      coverage: { documents: libraryDocs.length, abstracts: libraryDocs.filter(d => d.abstract).length,
        fulltext: libraryDocs.filter(d => d.hasFulltext).length, vectors: libraryDocs.filter(d => d.modelFingerprint === this.modelFingerprint() && d.hasVectors).length },
      queue: jobs.map(job => ({ ...job, documentTitle: summaryByDocument.get(job.documentID)?.title || job.documentID,
        displayState: displayJobState(job), can_resume: canResume(job, 'manual'),
        can_bulk_resume: canBulkResume(job) && !!summaryByDocument.get(job.documentID)?.attachmentKey,
        retry_exclusion: retryExclusion(job) || (!summaryByDocument.get(job.documentID)?.attachmentKey ? '无 PDF 附件' : null),
        requires_rebuild: requiresRebuild(job) })),
      agents: await this.agentInstaller.status(), local_only: false, parsing_provider: 'mineru',
      research_revision: this.researchRevision,
      endpoint: `http://127.0.0.1:${Zotero.Prefs.get('httpServer.port') || 23119}/literature-library/mcp` };
  }
  async list() {
    const [docs, jobs] = await Promise.all([this.store.summaries(), this.store.jobs()]);
    const tasks = new Map(jobs.map(job => [job.documentID, job]));
    return docs.filter(doc => isLibraryDocument(doc, tasks.get(doc.id))).map(doc => ({ ...doc,
      taskState: tasks.has(doc.id) && !['done', 'skipped'].includes(tasks.get(doc.id)!.state) ? displayJobState(tasks.get(doc.id)!) : null,
      hasCurrentVectors: doc.modelFingerprint === this.modelFingerprint() && doc.hasVectors }));
  }
  async read(input: any) {
    if (input.document_ids !== undefined) return this.readBatch(input);
    if (['metadata', 'abstract'].includes(input.layer || 'metadata')) {
      const doc = await this.store.searchDocument(String(input.document_id));
      if (!doc) throw Error('未找到文献，请提供 document_id。');
      const base = { document_id: doc.id, item_key: doc.itemKey, title: doc.title, state: doc.state, version: doc.version,
        link: `zotero://select/${doc.libraryKey}/items/${doc.itemKey}` };
      const limit = boundedInt(input.max_chars, 12000, 60000);
      if ((input.layer || 'metadata') === 'metadata') return { ...base, metadata: { creators: doc.creators, year: doc.year,
        publication: doc.publication, doi: doc.doi, ...doc.bibliographic, tags: doc.tags, collections: doc.collections },
        available_layers: ['metadata', ...(doc.abstract ? ['abstract'] : []), ...(doc.hasFulltext ? ['outline', 'fulltext'] : [])], source: 'zotero' };
      const offset = input.offset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0) throw Error('offset 必须为非负整数。');
      return { ...base, text: doc.abstract.slice(offset, offset + limit), source: 'zotero.abstractNote', missing: !doc.abstract,
        offset, total_chars: doc.abstract.length, truncated: offset + limit < doc.abstract.length,
        next_offset: offset + limit < doc.abstract.length ? offset + limit : null };
    }
    const doc = await this.store.document(String(input.document_id));
    if (!doc) throw new Error('未找到已入库文献，请提供 document_id。');
    const layer: Layer = input.layer;
    const base = { document_id: doc.id, item_key: doc.itemKey, title: doc.title, state: doc.state,
      link: `zotero://select/${doc.libraryKey}/items/${doc.itemKey}` };
    const limit = boundedInt(input.max_chars, 12000, 60000);
    const version = (await this.store.searchDocument(doc.id))?.version;
    if (layer === 'outline') {
      const sections = logicalOutline(doc), offset = input.offset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0) throw Error('offset 必须为非负整数。');
      const output = []; let chars = 0;
      for (const section of sections.slice(offset)) { const size = JSON.stringify(section).length; if (chars + size > limit) break; output.push(section); chars += size; }
      if (!output.length && offset < sections.length) throw new AppError({ code: 'READ_BUDGET_TOO_SMALL', message: '目录条目超过字符预算，请增大 max_chars。', retryable: false });
      return { ...base, version, sections: output, total_sections: sections.length, offset,
        next_offset: offset + output.length < sections.length ? offset + output.length : null, truncated: offset + output.length < sections.length };
    }
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
    if (input.neighbors !== undefined && (!Number.isInteger(input.neighbors) || input.neighbors < 0 || input.neighbors > 3)) throw Error('neighbors 范围为 0–3。');
    return { ...base, version, ...readFulltext(doc, input) };
  }
  async search(input: any) {
    if (!input || typeof input !== 'object') throw Error('无效检索参数。');
    if (input.queries !== undefined) {
      if (!Array.isArray(input.queries) || !input.queries.length || input.queries.length > 8) throw Error('每批支持 1–8 条查询。');
      if (input.max_chars !== undefined && (!Number.isInteger(input.max_chars) || input.max_chars < 2000 * input.queries.length || input.max_chars > 60000)) throw Error('批次 max_chars 至少每条查询 2000，合计最多 60000。');
      const { queries, ...common } = input, budget = Math.floor((input.max_chars || 60000) / queries.length), results = [];
      for (let i = 0; i < queries.length; i++) {
        const query = queries[i];
        try {
          if (!query || typeof query !== 'object' || Array.isArray(query) || query.queries !== undefined) throw Error('批次子查询必须为对象。');
          results.push({ query_id: query.query_id || `q${i + 1}`, theme_id: query.theme_id || null,
            ...await this.searchOne({ ...common, ...query, max_chars: Math.min(query.max_chars || budget, budget) }) });
        } catch (error) { results.push({ query_id: query?.query_id || `q${i + 1}`, theme_id: query?.theme_id || null, error: publicError(error), results: [] }); }
      }
      return { queries: results, partial: results.some(r => r.error), scope: 'plugin_derived_library' };
    }
    return this.searchOne(input);
  }
  private async searchOne(raw: any) {
    const started = Date.now();
    const input = validateSearch(raw);
    input.scope = await this.research.scope(input.scope);
    const docs = (await this.store.searchDocuments()).filter(d => matchesScope(d, input));
    const fingerprint = this.modelFingerprint();
    const indexed = docs.filter(d => d.modelFingerprint === fingerprint && d.vectorLayers.some(l => input.layer === 'auto' ? ['metadata', 'abstract'].includes(l) : l === input.layer));
    let vector: number[] | undefined, warning: any;
    const inferStarted = Date.now();
    if (input.mode === 'semantic' || input.mode === 'hybrid') try {
      if (docs.length && !indexed.length) throw new AppError({ code: 'INDEX_VECTORS_MISSING',
        message: '当前检索层没有与所选模型匹配的向量，请启用向量化并重新入库。', retryable: false, requires_user_action: true });
      if (docs.length) {
        this.queryVectors ||= new Map();
        const key = JSON.stringify([fingerprint, input.query]);
        let pending = this.queryVectors.get(key);
        if (!pending) {
          pending = this.embedTexts([input.query], true).then(values => values[0]);
          this.queryVectors.set(key, pending);
          if (this.queryVectors.size > 64) this.queryVectors.delete(this.queryVectors.keys().next().value!);
          pending.catch(() => this.queryVectors.delete(key));
        }
        vector = await pending;
        if (fingerprint !== this.modelFingerprint()) throw new AppError({ code: 'MODEL_CHANGED', message: '查询期间模型配置已变化，请重试。', retryable: true });
      }
    } catch (error) { warning = publicError(error); if (input.mode === 'semantic') throw error; }
    const inferenceTime = Date.now() - inferStarted;
    this.searchService ||= new SearchService(this.store, new SearchTransport(this.win));
    const result = await this.searchService.search(input, fingerprint, vector);
    if (input.scope.workspace_id) {
      await this.research.trace(input.scope.workspace_id, input.scope.theme_id, {
        query: input.query, layer: input.layer, filters: input.filters || {}, snapshot: result.snapshot, time: new Date().toISOString(),
        returned: result.results.length, document_ids: result.results.map((r: any) => r.document_id), query_id: input.query_id || null });
      this.researchRevision++; this.changed();
    }
    return { ...result, warning, timing_ms: { ...result.timing_ms, inference_and_queue: inferenceTime, total: Date.now() - started } };
  }
  async workspace(input: any) {
    if (!input || !['create', 'list', 'get', 'upsert_theme', 'update_candidates', 'save_evidence', 'remove_evidence', 'delete'].includes(input.action)) throw Error('无效工作区操作。');
    if (input.max_chars !== undefined && (!Number.isInteger(input.max_chars) || input.max_chars < 10000 || input.max_chars > 60000)) throw Error('max_chars 范围为 10000–60000。');
    const result = await this.research.call(input);
    if (!['get', 'list'].includes(input.action)) { this.researchRevision++; this.changed(); }
    return result;
  }
  private async readBatch(input: any) {
    if (input.document_id !== undefined) throw Error('document_id 与 document_ids 不能同时使用。');
    if (!Array.isArray(input.document_ids) || !input.document_ids.length || input.document_ids.length > 20
      || input.document_ids.some((id: any) => typeof id !== 'string' || id.length > 200)) throw Error('批量读取支持 1–20 篇文献。');
    if (!['metadata', 'abstract', 'outline'].includes(input.layer || 'abstract')) throw Error('批读支持书目、摘要或目录；正文请按片段读取。');
    if (input.max_chars !== undefined && (!Number.isInteger(input.max_chars) || input.max_chars < 2000 || input.max_chars > 60000)) throw Error('max_chars 范围为 2000–60000。');
    const budget = boundedInt(input.max_chars, 24000, 60000), ids = [...new Set<string>(input.document_ids)], results: any[] = [];
    let used = 0;
    for (const id of ids) {
      if (budget - used < 1000) break;
      let result;
      try { result = await this.read({ document_id: id, layer: input.layer || 'abstract', offset: input.offset,
        max_chars: Math.max(1, Math.min(6000, budget - used - 900)) }); }
      catch (error) { result = { document_id: id, error: publicError(error) }; }
      const size = JSON.stringify(result).length; if (used + size > budget) break;
      results.push(result); used += size;
    }
    return { results, used_chars: used, truncated: results.length < ids.length || results.some(r => r.truncated),
      remaining_document_ids: ids.slice(results.length), content_is_untrusted: true };
  }
  async agentStatus(input: any = {}) {
    const [docs, jobs] = await Promise.all([this.store.searchDocuments(), this.store.jobs()]);
    if (input.view === 'jobs') {
      if (input.offset !== undefined && (!Number.isSafeInteger(input.offset) || input.offset < 0)) throw Error('无效 offset。');
      const sorted = jobs.filter(j => !input.state || j.state === input.state).sort((a, b) => a.id.localeCompare(b.id));
      const offset = input.offset || 0, limit = boundedInt(input.limit, 20, 100);
      const titles = new Map(docs.map(d => [d.id, d.title]));
      return { jobs: sorted.slice(offset, offset + limit).map(j => ({ id: j.id, document_id: j.documentID, title: titles.get(j.documentID),
        state: j.state, attempts: j.attempts, error: j.error, can_bulk_resume: canBulkResume(j) })),
        total: sorted.length, next_offset: offset + limit < sorted.length ? offset + limit : null };
    }
    if (input.view && input.view !== 'overview') throw Error('无效 view。');
    const states: Record<string, number> = {};
    for (const job of jobs) states[job.state] = (states[job.state] || 0) + 1;
    const collections = new Map<string, number>(), tags = new Map<string, number>();
    for (const doc of docs) {
      for (const key of doc.collections) collections.set(`${doc.libraryID}:${key}`, (collections.get(`${doc.libraryID}:${key}`) || 0) + 1);
      for (const tag of doc.tags) tags.set(tag, (tags.get(tag) || 0) + 1);
    }
    const tasks = new Map(jobs.map(j => [j.documentID, j])), libraryDocs = docs.filter(d => isLibraryDocument(d, tasks.get(d.id)));
    return { scope: 'plugin_derived_library', complete_zotero_library: false, snapshot: await this.store.searchRevision(),
      coverage: { candidates: docs.length, documents: libraryDocs.length, abstracts: docs.filter(d => !!d.abstract).length,
        fulltext: docs.filter(d => d.hasFulltext).length, vectors: docs.filter(d => d.modelFingerprint === this.modelFingerprint() && d.vectorLayers.length).length,
        missing_abstracts: docs.filter(d => !d.abstract).length }, queue: { total: jobs.length, states }, credentials: this.credentials.status(),
      model: { provider: this.settings.embeddingProvider, fingerprint: this.modelFingerprint(), state: this.settings.embeddingProvider === 'local' ? this.inference.state.state : this.embeddingCredentials.status().state },
      facets: { collections: [...collections].slice(0, 50).map(([id, count]) => ({ id, count })), collections_total: collections.size,
        tags: [...tags].sort((a, b) => b[1] - a[1]).slice(0, 50).map(([tag, count]) => ({ tag, count })), tags_total: tags.size },
      workflow: 'Search metadata/abstracts (auto), batch read abstracts, select candidates, search scoped fulltext, read neighbors. Missing abstracts do not imply irrelevance.' };
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
    this.searchService?.close(); this.queryVectors?.clear();
    this.citations.close();
    this.stopped = true; this.win.clearTimeout(this.timer); this.inference.close();
    for (const controller of this.transfers) controller.abort();
    this.win.clearInterval(this.scanTimer);
    while (this.working) await new Promise(r => this.win.setTimeout(r, 50));
    await this.store.close();
  }
}
