export const MODELS = {
  qwen: { id: 'onnx-community/Qwen3-Embedding-0.6B-ONNX', revision: 'c25a394dd583836952667c12f008335071b3f43d', pooling: 'last_token', limit: 1024 },
  e5: { id: 'Xenova/multilingual-e5-small', revision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78', pooling: 'mean', limit: 512 }
} as const;
export function modelFingerprint(model: keyof typeof MODELS) {
  return `transformers-3.8.1:${MODELS[model].id}@${MODELS[model].revision}:q8:token-windows-v2`;
}
