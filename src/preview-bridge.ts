import { readFulltext } from './retrieval';
import { resumedJob, displayJobState, requiresRebuild, canResume, canBulkResume, canDeleteJob, retryExclusion } from './queue';
export function previewBridge(fixture: any) {
  return {
    status: async () => ({ ...fixture.status, queue: fixture.status.queue.map((job: any) => ({ ...job,
      documentTitle: fixture.documents.find((doc: any) => doc.id === job.documentID)?.title || job.documentTitle,
      can_resume: canResume(job, 'manual'), can_bulk_resume: canBulkResume(job), retry_exclusion: retryExclusion(job) })) }), list: async () => fixture.documents.filter((doc: any) => {
      const job = fixture.status.queue.find((task: any) => task.documentID === doc.id);
      return !!doc.indexedAt || !job || ['done', 'skipped'].includes(job.state);
    }),
    workspace: async (input: any) => input.action === 'list' ? { workspaces: fixture.workspaces || [], next_offset: null }
      : fixture.researchDetails?.find((d: any) => d.workspace_id === input.workspace_id && d.theme_id === input.theme_id),
    enqueueSelected: async () => [], search: async ({ query }: any) => ({ results: fixture.documents.filter((d: any) =>
      `${d.title} ${d.creators} ${d.abstract}`.toLowerCase().includes(query.toLowerCase())).map((d: any) => ({ document_id: d.id, snippet: d.abstract })) }),
    read: async (input: any) => { const d = fixture.documents.find((v: any) => v.id === input.document_id); return { title: d.title, text: input.layer === 'abstract' ? d.abstract : undefined, sections: d.sections, metadata: input.layer === 'metadata' ? d : undefined, link: '#', ...(input.layer === 'fulltext' ? readFulltext(d, input) : {}) }; },
    saveCredentials: async (input: any) => { fixture.status.credentials.state = input.clear ? 'missing' : 'configured'; },
    saveEmbeddingCredentials: async (input: any) => { fixture.status.embedding_credentials.state = input.clear ? 'missing' : 'configured'; fixture.status.model = { state: 'idle', checkedAt: null, dimension: null }; },
    saveSettings: async (input: any) => {
      if (['model', 'modelSource', 'embeddingProvider', 'embeddingApiBaseUrl', 'embeddingApiModel'].some(key => key in input && input[key] !== fixture.status.settings[key]))
        fixture.status.model = { state: 'idle', dimension: null, checkedAt: null };
      return Object.assign(fixture.status.settings, input, { cloudEnabled: true });
    },
    testCredentials: async () => ({ message: '预览模式不会调用 MinerU。' }), resume: async (id?: string | string[]) => { let resumed = 0, skipped = 0; for (const job of fixture.status.queue) {
      const selected = Array.isArray(id) ? id.includes(job.id) : !id || job.id === id;
      if (!selected) continue;
      if ((!id || Array.isArray(id)) && !canBulkResume(job) && canResume(job, 'manual')) { skipped++; continue; }
      if (canResume(job, 'manual')) {
      Object.assign(job, resumedJob(job)); job.displayState = displayJobState(job);
      job.can_resume = false; job.requires_rebuild = requiresRebuild(job); resumed++;
    } } return { resumed, skipped, exclusions: skipped ? { '需处理 PDF': skipped } : {} }; },
    deleteJobs: async (ids: string[]) => {
      const allowed = new Set(ids); let deleted = 0, skipped = 0;
      fixture.status.queue = fixture.status.queue.filter((job: any) => {
        if (!allowed.has(job.id)) return true;
        if (!canDeleteJob(job)) { skipped++; return true; }
        fixture.documents = fixture.documents.filter((doc: any) => doc.id !== job.documentID || doc.indexedAt);
        deleted++; return false;
      });
      return { deleted, skipped };
    },
    clearCompletedJobs: async () => {
      const completed = fixture.status.queue.filter((job: any) => ['done', 'skipped'].includes(job.state)).map((job: any) => job.id);
      const allowed = new Set(completed); let deleted = 0;
      fixture.status.queue = fixture.status.queue.filter((job: any) => {
        if (!allowed.has(job.id)) return true;
        deleted++; return false;
      });
      return { deleted, skipped: 0 };
    },
    reindex: async () => {}, remove: async (id: string) => { fixture.documents = fixture.documents.filter((d: any) => d.id !== id); },
    testEmbeddingModel: async () => { fixture.status.model = { ...fixture.status.model, state: 'ready', checkedAt: new Date().toISOString(), dimension: 384, provider: fixture.status.settings.embeddingProvider, model: fixture.status.settings.embeddingProvider === 'api' ? fixture.status.settings.embeddingApiModel : fixture.status.settings.model }; return fixture.status.model; },
    installAgent: async (target: string) => { if (target === 'codex') fixture.status.agents.codex.configured = true; else fixture.status.agents.claudeCode.configured = true; return { backup: 'preview-only' }; },
    connectionConfig: async () => ({ mcpServers: { zotero_literature_library: { type: 'http', url: fixture.status.endpoint, headers: { Authorization: 'Bearer preview-token' } } } }), rotateToken: async () => {}
  };
}
