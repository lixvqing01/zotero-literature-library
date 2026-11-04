import { AppError } from './core';
import { matchesScope } from './search-engine';
import type { Store } from './store';

export class SearchTransport {
  private frame: any;
  private listener: any;
  private ready?: Promise<void>;
  private rejectReady?: (error: Error) => void;
  private startupTimer: any;
  private counter = 0;
  private token = '';
  private pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void; timer: any }>();
  constructor(private win: any) {}
  private init() {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      this.rejectReady = reject;
      this.token = Services.uuid.generateUUID().toString();
      this.startupTimer = this.win.setTimeout(() => this.fail('检索 Worker 启动超时'), 30000);
      this.listener = ({ data }: any) => {
        if (data?.source !== 'literature-search' || data.bridgeToken !== this.token) return;
        if (data.ready) { this.win.clearTimeout(this.startupTimer); this.rejectReady = undefined; resolve(); return; }
        if (data.fatal) { this.fail(data.fatal); return; }
        const pending = this.pending.get(data.id); if (!pending) return;
        this.win.clearTimeout(pending.timer); this.pending.delete(data.id);
        if (data.error) pending.reject(new AppError(data.error)); else pending.resolve(data.result);
      };
      this.win.addEventListener('message', this.listener);
      this.frame = this.win.document.createElementNS('http://www.w3.org/1999/xhtml', 'iframe');
      this.frame.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none';
      this.frame.src = 'chrome://literature-library/content/search.html#' + encodeURIComponent(this.token);
      this.frame.addEventListener('error', () => this.fail('检索页面加载失败'), { once: true });
      this.win.document.documentElement.append(this.frame);
    });
    return this.ready;
  }
  private fail(message: string) { this.close(new AppError({ code: 'SEARCH_WORKER_UNAVAILABLE', message, retryable: true })); }
  async call(data: any): Promise<any> {
    await this.init();
    return new Promise((resolve, reject) => {
      const id = ++this.counter, timer = this.win.setTimeout(() => this.fail('检索超时，请重试'), 120000);
      this.pending.set(id, { resolve, reject, timer });
      this.frame.contentWindow.postMessage({ ...data, id, source: 'literature-search-host', bridgeToken: this.token }, '*');
    });
  }
  close(error = new Error('检索已关闭')) {
    this.win.clearTimeout(this.startupTimer); this.rejectReady?.(error); this.rejectReady = undefined;
    for (const pending of this.pending.values()) { this.win.clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); if (this.listener) this.win.removeEventListener('message', this.listener);
    this.frame?.remove(); this.frame = undefined; this.ready = undefined;
  }
}

export class SearchService {
  private revisions = new Map<string, number>();
  private vectors = new Map<string, string>();
  private chain: Promise<any> = Promise.resolve();
  constructor(private store: Store, private transport: { call: (data: any) => Promise<any>; close: () => void }) {}
  search(input: any, fingerprint: string, vector?: number[]) {
    const task = this.chain.then(() => this.execute(input, fingerprint, vector));
    this.chain = task.catch((error: any) => {
      if (!error?.detail || ['SEARCH_WORKER_UNAVAILABLE', 'SEARCH_WORKER_ERROR'].includes(error.detail.code)) { this.revisions.clear(); this.vectors.clear(); }
    }); return task;
  }
  private async execute(input: any, fingerprint: string, vector?: number[], attempt = 0): Promise<any> {
    const started = Date.now(), group = input.layer === 'fulltext' ? 'fulltext' : 'discovery';
    const revision = await this.store.searchRevision();
    let current = this.revisions.get(group) ?? -1;
    if (current < 0) {
      const snapshot = await this.store.searchSnapshot(group, revision);
      if (snapshot) try { await this.transport.call({ group, action: 'restore', value: snapshot }); current = revision; } catch {}
    }
    if (current !== revision) {
      const bundle = await this.store.searchBundle(group, current);
      await this.transport.call({ group, action: 'apply', value: bundle }); current = bundle.revision;
      const snapshot = await this.transport.call({ group, action: 'dump' });
      await this.store.saveSearchSnapshot(group, current, snapshot);
      this.vectors.delete(group);
    }
    this.revisions.set(group, current);
    const syncTime = Date.now() - started;
    let vectorTime = 0;
    if (vector) {
      const vectorStarted = Date.now(), layer = input.layer || 'auto';
      const ids = (await this.store.searchDocuments()).filter(d => matchesScope(d, input)).map(d => d.id).sort();
      const key = JSON.stringify([current, layer, fingerprint, ids]);
      if (this.vectors.get(group) !== key) {
        const values = await this.store.searchVectors(layer, fingerprint, ids);
        await this.transport.call({ group, action: 'vectors', key, value: values }); this.vectors.set(group, key);
      }
      vectorTime = Date.now() - vectorStarted;
      if (await this.store.searchRevision() !== current) {
        this.vectors.delete(group);
        if (attempt >= 2) throw new AppError({ code: 'SEARCH_INDEX_BUSY', message: '检索索引正在更新，请稍后重试。', retryable: true });
        return this.execute(input, fingerprint, vector, attempt + 1);
      }
    }
    const result = await this.transport.call({ group, action: 'search', input, fingerprint, vector });
    return { ...result, timing_ms: { ...result.timing_ms, index_sync: syncTime, vector_load: vectorTime, total: Date.now() - started } };
  }
  close() { this.transport.close(); this.revisions.clear(); this.vectors.clear(); }
}
