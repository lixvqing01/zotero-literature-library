export type Layer = 'metadata' | 'abstract' | 'outline' | 'fulltext' | 'notes';
export type CredentialState = 'missing' | 'configured' | 'valid' | 'expired' | 'invalid' | 'auth_failed';
export interface CredentialInfo {
  state: CredentialState;
  revision: number;
  issuedAt: string | null;
  expiresAt: string | null;
  checkedAt: string | null;
  providerCode?: string;
}
export interface Section {
  id: string; heading: string; level: number; kind: string;
  page: number | null; text: string;
}
export function normalizeYear(value: unknown): string {
  return String(value ?? '').match(/(?:^|\D)((?:1[5-9]|20|21)\d{2})(?!\d)/)?.[1] || '';
}
export function sectionRole(heading: string): string {
  const name = heading.replace(/^\s*(?:(?:[IVXLCDM]+|\d+(?:\.\d+)*|[A-Z])[.)：:\s-]+)\s*/i, '').trim();
  if (/^(?:(?:references|bibliography|works cited|literature cited)\b|参考文献)/i.test(name)) return 'references';
  if (/^(?:abstract\b|摘要)/i.test(name)) return 'abstract';
  if (/^(?:.*\bmethods?\b|.*\bmaterials\b|实验方法|材料与方法|研究方法)/i.test(name)) return 'methods';
  if (/^(?:results?\b|结果)/i.test(name)) return 'results';
  if (/^(?:discussion\b|讨论)/i.test(name)) return 'discussion';
  if (/^(?:conclusions?\b|结论)/i.test(name)) return 'conclusions';
  if (/^(?:introduction\b|引言|绪论)/i.test(name)) return 'introduction';
  return 'unknown';
}
export interface Chunk {
  id: string; sectionId: string; text: string; page: number | null;
  layer: Layer; vector?: number[];
}
export interface DocumentRecord {
  id: string; libraryID: number; libraryKey: string; itemKey: string; attachmentKey: string | null;
  title: string; creators: string; year: string; publication: string; doi: string;
  abstract: string; tags: string[]; collections: string[]; modified: string;
  pdfHash?: string; parserFingerprint?: string; modelFingerprint?: string;
  markdown?: string; sections: Section[]; chunks: Chunk[];
  state: string; indexedAt?: string; error?: PublicError; metadataHash?: string;
  bibliographic?: Record<string, string>;
}
export interface PublicError {
  code: string; message: string; provider?: string; provider_code?: string;
  retryable: boolean; requires_user_action?: boolean; action?: string; trace_id?: string;
}
export class AppError extends Error {
  constructor(public detail: PublicError) { super(detail.message); this.name = 'AppError'; }
}
export function redact(value: unknown): string {
  return String(value ?? '').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, '[redacted]')
    .replace(/(?:api[_-]?key|token|authorization)(?:\s*[:=]\s*|%3[dD])[^\s&,"']+/gi, '[secret redacted]')
    .replace(/https?:\/\/[^\s"<>]+\?[^\s"<>]+/g, '[signed URL redacted]').slice(0, 600);
}
export function publicError(error: unknown): PublicError {
  if (error instanceof AppError) return { ...error.detail, message: redact(error.detail.message) };
  return { code: 'INTERNAL_ERROR', message: redact(error instanceof Error ? error.message : error), retryable: false };
}
export function mineruError(status: number, body: any): AppError | null {
  const code = String(body?.code ?? '');
  if (status >= 200 && status < 300 && code === '0') return null;
  const providerMessage = redact(body?.msg ?? body?.message ?? '');
  const base = { provider: 'mineru', provider_code: code || `HTTP_${status}`,
    trace_id: typeof body?.trace_id === 'string' ? body.trace_id.slice(0, 100) : undefined };
  const mapped: Record<string, PublicError> = {
    A0211: { code: 'MINERU_TOKEN_EXPIRED', message: 'MinerU Key 已过期，请在插件设置或知识库 GUI 中更新。', retryable: false, requires_user_action: true, action: 'update_mineru_key' },
    A0202: { code: 'MINERU_TOKEN_INVALID', message: 'MinerU Key 无效或格式错误，请检查并重新配置。', retryable: false, requires_user_action: true, action: 'update_mineru_key' },
    '-60005': { code: 'MINERU_FILE_TOO_LARGE', message: 'PDF 超出 MinerU 文件大小限制。', retryable: false },
    '-60006': { code: 'MINERU_PAGE_LIMIT', message: 'PDF 页数超出 MinerU 限制。', retryable: false },
    '-60012': { code: 'MINERU_TASK_NOT_FOUND', message: 'MinerU 任务不存在或已失效，请手动重建。', retryable: false, requires_user_action: true },
    '-60013': { code: 'MINERU_TASK_FORBIDDEN', message: '当前 Key 无权访问原任务，可能属于其他账号，请手动重建。', retryable: false, requires_user_action: true }
  };
  if (mapped[code]) return new AppError({ ...base, ...mapped[code] });
  if (status === 401 || status === 403) return new AppError({ ...base, code: 'MINERU_AUTH_FAILED',
    message: `MinerU 鉴权失败，请检查 Key 或权限。${providerMessage}`, retryable: false, requires_user_action: true, action: 'update_mineru_key' });
  if (status === 429) return new AppError({ ...base, code: 'MINERU_RATE_LIMITED', message: 'MinerU 请求限流，请稍后重试。', retryable: true });
  return new AppError({ ...base, code: 'MINERU_SERVICE_ERROR', message: providerMessage || `MinerU 请求失败（HTTP ${status}）。`, retryable: status >= 500 || code === '-10001' });
}
export function credentialDisplay(info: CredentialInfo, now = Date.now()) {
  const end = info.expiresAt ? Date.parse(info.expiresAt) : NaN;
  const days = Number.isFinite(end) ? Math.ceil((end - now) / 86400000) : null;
  return { ...info, daysRemaining: days, estimatedExpired: days !== null && days <= 0,
    expirySource: Number.isFinite(end) ? 'user_estimate' : 'unknown' };
}
export function expiryDates(issuedAt: string | null, expiresAt: string | null) {
  const valid = (s: string | null) => !s || /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s))
    && new Date(Date.parse(s)).toISOString().slice(0, 10) === s;
  if (!valid(issuedAt) || !valid(expiresAt)) throw new Error('日期格式应为 YYYY-MM-DD。');
  return { issuedAt: issuedAt || null, expiresAt: expiresAt || (issuedAt ? new Date(Date.parse(issuedAt) + 90 * 86400000).toISOString().slice(0, 10) : null) };
}
export function splitText(text: string, maxChars = 1000): string[] {
  const result: string[] = [];
  for (const para of text.split(/\n\s*\n/)) {
    let remaining = para.trim();
    while (remaining.length) {
      if (remaining.length <= maxChars) { result.push(remaining); break; }
      let end = remaining.lastIndexOf(' ', maxChars);
      if (end < maxChars * 0.5) end = maxChars;
      result.push(remaining.slice(0, end).trim());
      remaining = remaining.slice(end).trim();
    }
  }
  return result;
}
export function parseDocument(markdown: string, contentList: any[] = []): { sections: Section[]; chunks: Chunk[] } {
  const sections: Section[] = [];
  let current: Section | null = null;
  const create = (heading: string, level: number, page: number | null, kind = 'content') => {
    current = { id: `s${sections.length}`, heading, level, page, kind, text: '' };
    sections.push(current); return current;
  };
  const pageOf = (block: any) => Number.isInteger(block.page_idx) && block.page_idx >= 0 ? block.page_idx + 1 : null;
  for (const block of contentList) {
    if (!block || typeof block !== 'object') continue;
    const page = pageOf(block);
    const text = block.type === 'table' ? [block.table_caption, block.table_body, block.table_footnote].flat().filter(Boolean).join('\n')
      : block.type === 'image' ? [...(Array.isArray(block.img_caption) ? block.img_caption : []), ...(Array.isArray(block.img_footnote) ? block.img_footnote : [])].join('\n')
      : String(block.text ?? '');
    if (!text.trim()) continue;
    if (Number(block.text_level) > 0) { create(text.trim(), Math.min(6, Number(block.text_level)), page); continue; }
    if (!current) create('正文', 1, page);
    // Preserve page boundaries so an evidence chunk never borrows another page's label.
    if (current!.page !== page) create(current!.heading, current!.level, page, current!.kind);
    current!.text += `${text}\n\n`;
  }
  if (!sections.length || !sections.some(s => s.text.trim())) {
    sections.length = 0; current = null;
    for (const line of markdown.split('\n')) {
      const heading = /^(#{1,6})\s+(.+)$/.exec(line);
      if (heading) create(heading[2], heading[1].length, null);
      else { if (!current) create('正文', 1, null); current!.text += `${line}\n`; }
    }
  }
  const chunks: Chunk[] = [];
  for (const section of sections) {
    section.kind = sectionRole(section.heading) === 'references' ? 'references' : section.kind;
    for (const text of splitText(section.text)) chunks.push({ id: `c${chunks.length}`, sectionId: section.id,
      text, page: section.page, layer: 'fulltext' });
  }
  return { sections, chunks };
}
export function terms(query: string): string[] {
  const words = query.toLowerCase().match(/[a-z0-9][a-z0-9_.-]*|[\p{Script=Han}]+/gu) ?? [];
  return [...new Set(words.flatMap(w => /\p{Script=Han}/u.test(w) && w.length > 2
    ? Array.from({ length: w.length - 1 }, (_, i) => w.slice(i, i + 2)) : [w]))];
}
export function keywordScore(query: string, text: string): number {
  const tokens = terms(query); if (!tokens.length) return 0;
  const lower = text.toLowerCase();
  return tokens.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0) / tokens.length;
}
export function cosine(a: number[], b: number[]) {
  if (!a.length || a.length !== b.length) return -1;
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : -1;
}
export function boundedInt(value: unknown, fallback: number, max: number) {
  return Number.isInteger(value) ? Math.max(1, Math.min(max, Number(value))) : fallback;
}
