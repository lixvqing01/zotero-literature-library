export function previewBridge(fixture: any) {
  return {
    status: async () => fixture.status, list: async () => fixture.documents,
    enqueueSelected: async () => [], search: async ({ query }: any) => ({ results: fixture.documents.filter((d: any) =>
      `${d.title} ${d.creators} ${d.abstract}`.toLowerCase().includes(query.toLowerCase())).map((d: any) => ({ document_id: d.id, snippet: d.abstract })) }),
    read: async ({ document_id, layer }: any) => { const d = fixture.documents.find((v: any) => v.id === document_id); return { title: d.title, text: layer === 'abstract' ? d.abstract : d.markdown, sections: d.sections, metadata: d, link: '#' }; },
    saveCredentials: async (input: any) => { fixture.status.credentials.state = input.clear ? 'missing' : 'configured'; },
    saveSettings: async (input: any) => Object.assign(fixture.status.settings, input),
    testCredentials: async () => ({ message: '预览模式不会调用 MinerU。' }), resume: async () => {},
    reindex: async () => {}, remove: async (id: string) => { fixture.documents = fixture.documents.filter((d: any) => d.id !== id); },
    loadModel: async () => { fixture.status.model.state = 'ready'; },
    connectionConfig: async () => ({ preview: true }), rotateToken: async () => {}
  };
}
