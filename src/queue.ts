import type { Job } from './store';

export const ACTIVE = ['queued', 'waiting_file', 'submitting', 'uploading', 'pending', 'running', 'converting', 'download', 'embedding', 'retry'];
export type ResumeReason = 'manual' | 'credentials' | 'cloud' | 'model';
// Waiting for configuration does not run background work, so users can remove it.
export function canDeleteJob(job: { state: string }) {
  return ['failed', 'done', 'skipped', 'blocked_credentials', 'blocked_cloud', 'blocked_model'].includes(job.state);
}
const NEEDS_REBUILD = ['MINERU_SUBMISSION_UNCERTAIN', 'MINERU_UPLOAD_INCOMPLETE', 'MINERU_UPLOAD_CONFIRMATION_TIMEOUT', 'MINERU_UPLOAD_FAILED',
  'MINERU_TASK_NOT_FOUND', 'MINERU_TASK_FORBIDDEN', 'MINERU_PARSE_FAILED', 'MINERU_BAD_RESPONSE'];

export function retryExclusion(job: Job): string | null {
  const code = job.error?.code || '';
  if (['PDF_MISSING', 'PDF_INVALID_HEADER', 'PDF_READ_INCOMPLETE', 'ITEM_NOT_FOUND'].includes(code)) return '请先检查或补齐 PDF 附件';
  if (['MINERU_PAGE_LIMIT', 'MINERU_FILE_TOO_LARGE'].includes(code) ||
      /页数.*(超|限制)|超过.*页|page.{0,24}(limit|exceed)|too many pages/i.test(job.error?.message || '')) return '文件页数或大小超限，需先处理 PDF';
  if (requiresRebuild(job) && !canResume(job, 'manual')) return '需检查原任务后单独重建';
  return null;
}

export function canBulkResume(job: Job) {
  return canResume(job, 'manual') && !retryExclusion(job);
}

export function canResume(job: Job, reason: ResumeReason) {
  if (['MINERU_UPLOAD_INCOMPLETE', 'MINERU_UPLOAD_CONFIRMATION_TIMEOUT'].includes(job.error?.code || ''))
    return reason === 'manual' && job.state === 'failed' && !!job.batchID && !!job.dataID;
  if (NEEDS_REBUILD.includes(job.error?.code || '')) return false;
  if (reason === 'manual') return ['blocked_credentials', 'blocked_cloud', 'blocked_model', 'failed'].includes(job.state);
  return job.state === ({ credentials: 'blocked_credentials', cloud: 'blocked_cloud', model: 'blocked_model' } as const)[reason];
}

export function resumedJob(job: Job): Job {
  if (['MINERU_UPLOAD_INCOMPLETE', 'MINERU_UPLOAD_CONFIRMATION_TIMEOUT'].includes(job.error?.code || ''))
    return { ...job, state: 'pending', error: undefined, attempts: 0, nextRun: Date.now(), uploadWaitSince: Date.now(),
      progress: { stage: 'upload_confirmation', uploaded_bytes: job.pdfBytes,
        message: '已恢复查询 MinerU 原任务，不会重新上传 PDF。' } };
  return { ...job, state: job.retryState || (job.batchID ? 'pending' : 'queued'), error: undefined,
    attempts: 0, nextRun: Date.now() };
}

export function requiresRebuild(job: Job) { return NEEDS_REBUILD.includes(job.error?.code || ''); }

export function displayJobState(job: Job) {
  return job.state === 'pending' && job.progress?.stage === 'upload_confirmation' ? 'confirming_upload' : job.state;
}

export function isLibraryDocument(doc: { indexedAt?: string }, job?: Job) {
  return !!doc.indexedAt || !job || job.state === 'done' || job.state === 'skipped';
}

export type DocumentSortKey = 'title' | 'creators' | 'year' | 'publication' | 'state';
export function sortDocuments<T extends { title?: string; creators?: string; year?: string; publication?: string; state?: string; taskState?: string }>(
  docs: T[], key: DocumentSortKey, direction: 'asc' | 'desc') {
  const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
  const field = (doc: T) => key === 'state' ? doc.taskState || doc.state : doc[key];
  return [...docs].sort((a, b) => {
    const left = String(field(a) || ''), right = String(field(b) || '');
    if (!left || !right) return left ? -1 : right ? 1 : collator.compare(a.title || '', b.title || '');
    const compared = collator.compare(left, right);
    return (direction === 'asc' ? compared : -compared) || collator.compare(a.title || '', b.title || '');
  });
}

export const UPLOAD_CONFIRMATION_TIMEOUT = 5 * 60 * 1000;
