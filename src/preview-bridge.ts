import { readFulltext } from './retrieval';
export function previewBridge(fixture: any) {
  return {
    status: async () => fixture.status, list: async () => fixture.documents,
    enqueueSelected: async () => [], search: async ({ query }: any) => ({ results: fixture.documents.filter((d: any) =>
      `${d.title} ${d.creators} ${d.abstract}`.toLowerCase().includes(query.toLowerCase())).map((d: any) => ({ document_id: d.id, snippet: d.abstract })) }),
    read: async (input: any) => { const d = fixture.documents.find((v: any) => v.id === input.document_id); return { title: d.title, text: input.layer === 'abstract' ? d.abstract : undefined, sections: d.sections, metadata: input.layer === 'metadata' ? d : undefined, link: '#', ...(input.layer === 'fulltext' ? readFulltext(d, input) : {}) }; },
    saveCredentials: async (input: any) => { fixture.status.credentials.state = input.clear ? 'missing' : 'configured'; },
    saveSettings: async (input: any) => Object.assign(fixture.status.settings, input),
    testCredentials: async () => ({ message: '预览模式不会调用 MinerU。' }), resume: async (id?: string) => { let resumed = 0; for (const job of fixture.status.queue) if (job.can_resume && (!id || job.id === id)) { job.state = 'queued'; job.can_resume = false; resumed++; } return { resumed }; },
    reindex: async () => {}, remove: async (id: string) => { fixture.documents = fixture.documents.filter((d: any) => d.id !== id); },
    loadModel: async () => { fixture.status.model.state = 'ready'; },
    connectionConfig: async () => ({ preview: true }), rotateToken: async () => {}
  };
}
