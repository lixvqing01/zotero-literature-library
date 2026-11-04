// The browser build is bundled with the XPI; no Node runtime or model service is used.
import { env, pipeline } from '@huggingface/transformers';
import { MODELS, MODEL_SOURCES } from './models';
import { PriorityQueue } from './priority-queue';
env.allowRemoteModels = true;
env.allowLocalModels = false;
// Gecko's CacheStorage is unsafe in a system-principal Worker. Persist through
// the Zotero host instead of accessing browser CacheStorage from chrome code.
env.useBrowserCache = false;
env.useCustomCache = true;
const cacheRequests = new Map<string, (value: any) => void>();
let cacheCounter = 0;
function cacheCall(op: string, key: string, body?: ArrayBuffer) {
  return new Promise<any>(resolve => {
    const cacheID = String(++cacheCounter); cacheRequests.set(cacheID, resolve);
    self.postMessage({ cache: { op, key, body }, cacheID }, body ? [body] : []);
  });
}
env.customCache = {
  match: async (key: string) => { const value = await cacheCall('match', key); return value ? new Response(value) : undefined; },
  put: async (key: string, response: Response) => { await cacheCall('put', key, await response.arrayBuffer()); }
};
const wasm = env.backends.onnx.wasm!;
wasm.wasmPaths = new URL('./vendor/', import.meta.url).href;
wasm.numThreads = 1;
wasm.proxy = false;
let extractor: any;
let active = '';
const workQueue = new PriorityQueue();
self.onmessage = ({ data }) => {
  if (data.cacheID && data.cacheResult !== undefined) {
    cacheRequests.get(data.cacheID)?.(data.cacheResult); cacheRequests.delete(data.cacheID); return;
  }
  workQueue.enqueue(async () => {
    const { id, model, texts, query, modelSource = 'modelscope' } = data;
    try {
      const spec = MODELS[model as keyof typeof MODELS];
      if (!spec) throw new Error('未知向量模型。');
      if (!MODEL_SOURCES[modelSource as keyof typeof MODEL_SOURCES]) throw new Error('未知模型下载源。');
      if (active !== `${model}:${modelSource}`) {
        if (extractor) await extractor.dispose();
        extractor = undefined; active = '';
        const sourceSpec = MODEL_SOURCES[modelSource as keyof typeof MODEL_SOURCES];
        env.remoteHost = sourceSpec.host;
        env.remotePathTemplate = sourceSpec.path;
        const revision = modelSource === 'modelscope' ? sourceSpec.revision : spec.revision;
        extractor = await pipeline('feature-extraction', spec.id, { dtype: 'q8', device: 'wasm', revision,
          progress_callback: (progress: any) => self.postMessage({ id, progress: { status: progress.status,
            file: progress.file, progress: progress.progress } }) });
        active = `${model}:${modelSource}`;
      }
      const vectors = [];
      for (const text of texts) {
        const tokens = extractor.tokenizer.encode(text, { add_special_tokens: false });
        const sum: number[] = [];
        for (let i = 0; i < Math.max(tokens.length, 1); i += spec.limit - 128) {
          const slice = tokens.slice(i, i + spec.limit - 128);
          const body = extractor.tokenizer.decode(slice, { skip_special_tokens: true });
          const input = model === 'e5' ? `${query ? 'query' : 'passage'}: ${body}`
            : query ? `Instruct: Given a research question, retrieve relevant scientific passages that answer it\nQuery: ${body}` : body;
          const output = await extractor(input, { pooling: spec.pooling, normalize: true, truncation: false });
          const vector = output.tolist()[0];
          vector.forEach((v: number, j: number) => { sum[j] = (sum[j] || 0) + v * Math.max(slice.length, 1); });
        }
        const norm = Math.sqrt(sum.reduce((s, v) => s + v * v, 0));
        if (!norm || !Number.isFinite(norm)) throw Error('模型返回无效向量。');
        vectors.push(sum.map(v => v / norm));
      }
      self.postMessage({ id, vectors, model });
    } catch (error) { self.postMessage({ id, error: error instanceof Error ? error.message : '向量推理失败。' }); }
  }, !!data.query);
};
