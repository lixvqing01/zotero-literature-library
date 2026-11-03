import { readFulltext } from './retrieval';
import { resumedJob, displayJobState, requiresRebuild } from './queue';
export function previewBridge(fixture: any) {
  return {
    status: async () => fixture.status, list: async () => fixture.documents.filter((doc: any) => {
      const job = fixture.status.queue.find((task: any) => task.documentID === doc.id);
      return !!doc.indexedAt || !job || ['done', 'skipped'].includes(job.state);
    }),
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
    testCredentials: async () => ({ message: '预览模式不会调用 MinerU。' }), resume: async (id?: string) => { let resumed = 0; for (const job of fixture.status.queue) if (job.can_resume && (!id || job.id === id)) {
      Object.assign(job, resumedJob(job)); job.displayState = displayJobState(job);
      job.can_resume = false; job.requires_rebuild = requiresRebuild(job); resumed++;
    } return { resumed }; },
    reindex: async () => {}, remove: async (id: string) => { fixture.documents = fixture.documents.filter((d: any) => d.id !== id); },
    testEmbeddingModel: async () => { fixture.status.model = { ...fixture.status.model, state: 'ready', checkedAt: new Date().toISOString(), dimension: 384, provider: fixture.status.settings.embeddingProvider, model: fixture.status.settings.embeddingProvider === 'api' ? fixture.status.settings.embeddingApiModel : fixture.status.settings.model }; return fixture.status.model; },
    installAgent: async (target: string) => { if (target === 'codex') fixture.status.agents.codex.configured = true; else fixture.status.agents.claudeCode.configured = true; return { backup: 'preview-only' }; },
    connectionConfig: async () => ({ mcpServers: { zotero_literature_library: { type: 'http', url: fixture.status.endpoint, headers: { Authorization: 'Bearer preview-token' } } } }), rotateToken: async () => {}
  };
}
