import { AppError, mineruError, redact } from './core';
export interface TransportResponse { status: number; body: any; }
export type Transport = (method: string, url: string, body?: unknown, headers?: Record<string, string>) => Promise<TransportResponse>;
export function validateUploadPDF(bytes: Uint8Array, expectedSize: number) {
  if (!bytes.length || bytes.length !== expectedSize)
    throw new AppError({ code: 'PDF_READ_INCOMPLETE', message: '本地 PDF 读取不完整或文件在读取时发生变化，请确认附件已下载完成后重试。', retryable: false });
  const header = String.fromCharCode(...bytes.subarray(0, 1024));
  if (!header.includes('%PDF-'))
    throw new AppError({ code: 'PDF_INVALID_HEADER', message: '附件文件头不是 PDF，可能下载成了网页或错误页面；请在 Zotero 打开原附件检查。', retryable: false });
}
export class MinerUClient {
  constructor(private transport: Transport, private credential: () => Promise<{ key: string; revision: number }>,
    private report: (revision: number, error: AppError | null) => Promise<void>) {}
  async request(method: string, path: string, body?: unknown) {
    const { key, revision } = await this.credential();
    let response: TransportResponse;
    try { response = await this.transport(method, `https://mineru.net/api/v4${path}`, body,
      { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }); }
    catch { throw new AppError({ code: 'MINERU_NETWORK_ERROR', message: '无法连接 MinerU，请检查网络后重试。', retryable: true }); }
    const error = mineruError(response.status, response.body);
    await this.report(revision, error);
    if (error) throw error;
    return response.body.data;
  }
  async create(name: string, dataID: string, ocr: boolean) {
    const data = await this.request('POST', '/file-urls/batch', { files: [{ name, data_id: dataID, is_ocr: ocr }],
      model_version: 'vlm', enable_formula: true, enable_table: true });
    if (!data?.batch_id || !Array.isArray(data.file_urls) || !data.file_urls[0])
      throw new AppError({ code: 'MINERU_BAD_RESPONSE', message: 'MinerU 未返回有效上传链接。', retryable: false });
    return { batchID: String(data.batch_id), uploadURL: safeRemoteURL(data.file_urls[0]) };
  }
  async poll(batchID: string, dataID: string) {
    const data = await this.request('GET', `/extract-results/batch/${encodeURIComponent(batchID)}`);
    const result = data?.extract_result?.find((r: any) => r.data_id === dataID) ??
      (data?.extract_result?.length === 1 ? data.extract_result[0] : null);
    if (!result) throw new AppError({ code: 'MINERU_BAD_RESPONSE', message: 'MinerU 结果中缺少当前文件。', retryable: false });
    if (result.state === 'failed') throw new AppError({ code: 'MINERU_PARSE_FAILED',
      message: redact(result.err_msg || 'MinerU 解析失败。'), retryable: false });
    if (result.state === 'done') return { state: 'done', downloadURL: safeRemoteURL(result.full_zip_url) };
    return { state: String(result.state), progress: result.extract_progress ?? null };
  }
}
export function safeRemoteURL(value: unknown): string {
  const url = new URL(String(value));
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' ||
    !/(^|\.)(mineru\.net|openxlab\.org\.cn|shlab\.tech|aliyuncs\.com)$/.test(url.hostname))
    throw new AppError({ code: 'MINERU_UNSAFE_URL', message: 'MinerU 返回的资源域名不在允许列表中。', retryable: false });
  return url.href;
}
