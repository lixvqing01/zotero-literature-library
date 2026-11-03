import { AppError } from './core';

export function embeddingURL(base: string) {
  let url: URL;
  try { url = new URL(base.trim()); } catch { throw new AppError({ code: 'EMBEDDING_API_URL_INVALID', message: '请输入有效的 Embeddings API 地址。', retryable: false }); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((!local && url.protocol !== 'https:') || local && !['http:', 'https:'].includes(url.protocol)
      || url.username || url.password || url.search || url.hash)
    throw new AppError({ code: 'EMBEDDING_API_URL_INVALID', message: 'API 地址必须使用 HTTPS；仅本机服务允许 HTTP，且不能包含账号、参数或片段。', retryable: false });
  const path = url.pathname.replace(/\/+$/, '').replace(/\/embeddings$/i, '');
  url.pathname = `${path}/embeddings`.replace(/^\/\//, '/');
  return url.href;
}

export class EmbeddingAPI {
  constructor(private request: (url: string, key: string, body: unknown) => Promise<any>, private key: () => Promise<string>) {}
  async embed(baseURL: string, model: string, input: string[]) {
    if (!model.trim() || model.length > 300 || /[\r\n]/.test(model))
      throw new AppError({ code: 'EMBEDDING_MODEL_INVALID', message: '请输入有效的向量模型名称。', retryable: false });
    if (!input.length || input.length > 16 || input.some(s => !s || s.length > 24000))
      throw new AppError({ code: 'EMBEDDING_INPUT_INVALID', message: '向量请求内容为空或超过批量 / 长度上限。', retryable: false });
    const secret = await this.key();
    let result: any;
    try { result = await this.request(embeddingURL(baseURL), secret, { model: model.trim(), input, encoding_format: 'float' }); }
    catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError({ code: 'EMBEDDING_API_NETWORK_ERROR', message: '无法连接向量 API，请检查地址、网络和服务状态。', retryable: true });
    }
    if (!Array.isArray(result?.data) || result.data.length !== input.length)
      throw new AppError({ code: 'EMBEDDING_API_BAD_RESPONSE', message: '向量 API 返回条数与请求不符。', retryable: false });
    const ordered = [...result.data].sort((a, b) => Number(a.index) - Number(b.index));
    if (ordered.some((row, index) => row?.index !== index))
      throw new AppError({ code: 'EMBEDDING_API_BAD_RESPONSE', message: '向量 API 返回重复或缺失的索引。', retryable: false });
    const vectors: number[][] = ordered.map(row => row.embedding);
    const dimension = vectors[0]?.length;
    if (!dimension || vectors.some(vector => !Array.isArray(vector) || vector.length !== dimension
      || !vector.every((value: any) => typeof value === 'number' && Number.isFinite(value))))
      throw new AppError({ code: 'EMBEDDING_API_BAD_RESPONSE', message: '向量 API 返回空向量、维度不一致或非有限数值。', retryable: false });
    return vectors.map(vector => {
      const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
      if (!norm || !Number.isFinite(norm)) throw new AppError({ code: 'EMBEDDING_API_BAD_RESPONSE', message: '向量 API 返回无效向量。', retryable: false });
      return vector.map(value => value / norm);
    });
  }
}
