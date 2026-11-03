export const MODELS = {
  qwen: { id: 'onnx-community/Qwen3-Embedding-0.6B-ONNX', revision: 'c25a394dd583836952667c12f008335071b3f43d', pooling: 'last_token', limit: 1024 },
  e5: { id: 'Xenova/multilingual-e5-small', revision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78', pooling: 'mean', limit: 512 }
} as const;
export type ModelSource = 'modelscope' | 'hf-mirror' | 'huggingface';
export const MODEL_SOURCES: Record<ModelSource, { label: string; host: string; path: string; revision: string }> = {
  modelscope: { label: 'ModelScope（国内推荐）', host: 'https://www.modelscope.cn/models/', path: '{model}/resolve/{revision}/', revision: 'master' },
  'hf-mirror': { label: 'Hugging Face 镜像（hf-mirror.com）', host: 'https://hf-mirror.com/', path: '{model}/resolve/{revision}/', revision: '' },
  huggingface: { label: 'Hugging Face（可能需要代理）', host: 'https://huggingface.co/', path: '{model}/resolve/{revision}/', revision: '' }
};
export function isModelCacheURL(value: string) {
  try {
    const url = new URL(value), scope = url.hostname === 'www.modelscope.cn';
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
        || !['huggingface.co', 'hf-mirror.com', 'www.modelscope.cn'].includes(url.hostname)) return false;
    if (scope && !url.pathname.startsWith('/models/')) return false;
    const path = scope ? url.pathname.slice('/models'.length) : url.pathname;
    return /^\/(?:onnx-community\/Qwen3-Embedding-0\.6B-ONNX|Xenova\/multilingual-e5-small)\/resolve\/(?:[a-f0-9]{40}|master)\/[a-zA-Z0-9_./-]+$/.test(path);
  } catch { return false; }
}
export function modelFingerprint(model: keyof typeof MODELS, source: ModelSource = 'modelscope') {
  const spec = MODELS[model], src = MODEL_SOURCES[source];
  const revision = source === 'modelscope' ? src.revision : spec.revision;
  return `transformers-3.8.1:${source}:${spec.id}@${revision}:q8:token-windows-v2`;
}
