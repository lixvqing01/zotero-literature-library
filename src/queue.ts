import type { Job } from './store';

export const ACTIVE = ['queued', 'waiting_file', 'submitting', 'uploading', 'pending', 'running', 'converting', 'download', 'embedding', 'retry'];
export type ResumeReason = 'manual' | 'credentials' | 'cloud' | 'model';
const NEEDS_REBUILD = ['MINERU_SUBMISSION_UNCERTAIN', 'MINERU_UPLOAD_INCOMPLETE', 'MINERU_UPLOAD_CONFIRMATION_TIMEOUT', 'MINERU_UPLOAD_FAILED',
  'MINERU_TASK_NOT_FOUND', 'MINERU_TASK_FORBIDDEN', 'MINERU_PARSE_FAILED', 'MINERU_BAD_RESPONSE'];

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

export const UPLOAD_CONFIRMATION_TIMEOUT = 5 * 60 * 1000;
