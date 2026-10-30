import { AppError } from './core';
export class Inference {
  private frame: any;
  private ready?: Promise<void>;
  private pending = new Map<string, { resolve: (value: number[][]) => void; reject: (error: Error) => void; timer: any }>();
  state: any = { state: 'idle', model: 'qwen', progress: null };
  private listener: any;
  constructor(private window: any, private timerWindow: any, private changed: () => void, private cacheRoot: string) {}
  private async cache(data: any, bridgeToken: string) {
    let cacheResult: any = null;
    try {
      if (!/^https:\/\/huggingface\.co\/(onnx-community\/Qwen3-Embedding-0\.6B-ONNX|Xenova\/multilingual-e5-small)\/resolve\/[a-f0-9]{40}\/[a-zA-Z0-9_./-]+$/.test(data.cache.key)) throw Error('Invalid model cache key');
      const hash = Cc['@mozilla.org/security/hash;1'].createInstance(Ci.nsICryptoHash); hash.init(hash.SHA256);
      const bytes = new TextEncoder().encode(data.cache.key); hash.update(bytes, bytes.length);
      const name = Array.from(hash.finish(false), (c: any) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
      const path = PathUtils.join(this.cacheRoot, name);
      if (data.cache.op === 'put') {
        await IOUtils.makeDirectory(this.cacheRoot, { ignoreExisting: true });
        await IOUtils.write(path, new Uint8Array(data.cache.body)); cacheResult = true;
      } else if (await IOUtils.exists(path)) {
        const content = await IOUtils.read(path); cacheResult = content.buffer;
      }
    } catch {}
    const message = { source: 'literature-host', bridgeToken, cacheID: data.cacheID, cacheResult };
    this.frame?.contentWindow.postMessage(message, '*', cacheResult instanceof ArrayBuffer ? [cacheResult] : []);
  }
  private init() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const doc = this.window.document;
      const bridgeToken = Services.uuid.generateUUID().toString();
      const startupTimer = this.timerWindow.setTimeout(() => reject(new AppError({ code: 'EMBEDDING_HOST_FAILED',
        message: '本地推理页面未就绪，请重启 Zotero 后重试。', retryable: true })), 30000);
      this.frame = doc.createElementNS('http://www.w3.org/1999/xhtml', 'iframe');
      this.frame.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none';
      this.listener = (event: any) => {
        // Gecko deliberately nulls MessageEvent.source for chrome callers.
        if (event.data?.bridgeToken !== bridgeToken || event.data?.source !== 'literature-inference') return;
        const data = event.data;
        if (data.cache) { this.cache(data, bridgeToken).catch(() => {}); return; }
        if (data.ready) { this.timerWindow.clearTimeout(startupTimer); resolve(); return; }
        if (data.progress) { this.state = { ...this.state, state: 'loading', progress: data.progress }; this.changed(); return; }
        const job = this.pending.get(data.id);
        if (job) {
          this.timerWindow.clearTimeout(job.timer); this.pending.delete(data.id);
          if (data.error) { this.state = { ...this.state, state: 'error', message: data.error }; job.reject(new Error(data.error)); }
          else { this.state = { ...this.state, state: 'ready', progress: null }; job.resolve(data.vectors); }
          this.changed();
        } else if (data.error) {
          this.timerWindow.clearTimeout(startupTimer); reject(new Error(data.error));
          this.state = { state: 'error', message: data.error }; this.changed();
          for (const job of this.pending.values()) { this.timerWindow.clearTimeout(job.timer); job.reject(new Error(data.error)); }
          this.pending.clear();
        }
      };
      this.window.addEventListener('message', this.listener);
      this.frame.addEventListener('error', () => reject(new Error('推理页面加载失败。')), { once: true });
      this.frame.src = 'chrome://literature-library/content/inference.html#' + encodeURIComponent(bridgeToken);
      doc.documentElement.append(this.frame);
    });
    return this.ready;
  }
  async embed(model: string, texts: string[], query = false): Promise<number[][]> {
    await this.init();
    this.state = { ...this.state, state: 'working', model }; this.changed();
    return new Promise((resolve, reject) => {
      const id = Services.uuid.generateUUID().toString();
      const timer = this.timerWindow.setTimeout(() => {
        const error = new AppError({ code: 'EMBEDDING_TIMEOUT', message: '本地模型加载或推理超时，可重试或切换轻量模型。', retryable: true });
        this.pending.delete(id); this.close(); this.state = { state: 'error', message: error.message }; this.changed(); reject(error);
      }, 20 * 60 * 1000);
      this.pending.set(id, { resolve, reject, timer });
      this.frame.contentWindow.postMessage({ source: 'literature-host', bridgeToken: decodeURIComponent(this.frame.contentWindow.location.hash.slice(1)), id, model, texts, query }, '*');
    });
  }
  close() {
    if (this.listener) this.window.removeEventListener('message', this.listener);
    for (const job of this.pending.values()) { this.timerWindow.clearTimeout(job.timer); job.reject(new Error('插件已关闭。')); }
    this.pending.clear(); this.frame?.remove();
    this.frame = undefined; this.ready = undefined;
  }
}
