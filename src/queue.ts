import type { Job } from './store';

export const ACTIVE = ['queued', 'waiting_file', 'submitting', 'uploading', 'pending', 'running', 'converting', 'download', 'embedding', 'retry'];
export type ResumeReason = 'manual' | 'credentials' | 'cloud' | 'model';
const NEEDS_REBUILD = ['MINERU_SUBMISSION_UNCERTAIN', 'MINERU_UPLOAD_INCOMPLETE', 'MINERU_UPLOAD_FAILED',
  'MINERU_TASK_NOT_FOUND', 'MINERU_TASK_FORBIDDEN', 'MINERU_PARSE_FAILED', 'MINERU_BAD_RESPONSE'];

export function canResume(job: Job, reason: ResumeReason) {
  if (NEEDS_REBUILD.includes(job.error?.code || '')) return false;
  if (reason === 'manual') return ['blocked_credentials', 'blocked_cloud', 'blocked_model', 'failed'].includes(job.state);
  return job.state === ({ credentials: 'blocked_credentials', cloud: 'blocked_cloud', model: 'blocked_model' } as const)[reason];
}

export function resumedJob(job: Job): Job {
  return { ...job, state: job.retryState || (job.batchID ? 'pending' : 'queued'), error: undefined,
    attempts: 0, nextRun: Date.now() };
}

export function requiresRebuild(job: Job) { return NEEDS_REBUILD.includes(job.error?.code || ''); }
