import { AppError, boundedInt, sectionRole } from './core';
import type { Store } from './store';
const STATUSES = ['unreviewed', 'included', 'excluded', 'uncertain'];
function text(value: any, max: number, name: string) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw Error(`${name} 必须为 1–${max} 字符。`);
  return value.trim();
}
export class ResearchWorkspaces {
  private chain: Promise<any> = Promise.resolve();
  constructor(private store: Store, private uuid = () => Services.uuid.generateUUID().toString().replace(/[{}]/g, '')) {}
  call(input: any): Promise<any> {
    const task = this.chain.then(() => this.execute(input)); this.chain = task.catch(() => {}); return task;
  }
  private async get(id: string) {
    const workspace = await this.store.workspace(text(id, 100, 'workspace_id'));
    if (!workspace) throw Error('调研工作区不存在。'); return workspace;
  }
  async scope(input: any) {
    if (!input?.workspace_id) return input || {};
    const workspace = await this.get(input.workspace_id);
    const theme = workspace.themes.find((t: any) => t.id === input.theme_id);
    if (!theme) throw Error('请提供工作区内存在的 theme_id。');
    let ids = theme.candidates.filter((c: any) => (input.statuses || ['unreviewed', 'included', 'uncertain']).includes(c.status)).map((c: any) => c.document_id);
    if (input.document_ids) ids = ids.filter((id: string) => input.document_ids.includes(id));
    return { ...input, document_ids: ids };
  }
  async trace(workspaceID: string, themeID: string, trace: any) {
    return this.call({ action: '_trace', workspace_id: workspaceID, theme_id: themeID, trace });
  }
  private async execute(input: any): Promise<any> {
    if (input.action === 'list') {
      const all = (await this.store.workspaces()).sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id));
      const offset = Number.isSafeInteger(input.offset) && input.offset >= 0 ? input.offset : 0, limit = boundedInt(input.limit, 20, 100);
      return { workspaces: all.slice(offset, offset + limit).map(w => ({ id: w.id, title: w.title, updated_at: w.updated_at,
        themes: w.themes.map((t: any) => ({ id: t.id, title: t.title, candidates: t.candidates.length, evidence: t.evidence.length })) })),
        total: all.length, next_offset: offset + limit < all.length ? offset + limit : null };
    }
    if (input.action === 'create') {
      const workspace = { id: this.uuid(), title: text(input.title, 300, 'title'), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), themes: [] };
      await this.store.putWorkspace(workspace); return workspace;
    }
    const workspace = await this.get(input.workspace_id);
    if (input.action === 'delete') { await this.store.deleteWorkspace(workspace.id); return { deleted: true }; }
    if (input.action === 'get') {
      const theme = input.theme_id ? workspace.themes.find((t: any) => t.id === input.theme_id) : null;
      if (input.theme_id && !theme) throw Error('主题不存在。');
      if (!theme) return { id: workspace.id, title: workspace.title, updated_at: workspace.updated_at,
        themes: workspace.themes.map((t: any) => ({ id: t.id, title: t.title, candidates: t.candidates.length, evidence: t.evidence.length })) };
      const offset = Number.isSafeInteger(input.offset) && input.offset >= 0 ? input.offset : 0, limit = boundedInt(input.limit, 20, 100);
      const candidates = [];
      for (const candidate of theme.candidates.slice(offset, offset + limit)) {
        const current = await this.store.searchDocument(candidate.document_id);
        candidates.push({ ...candidate, title: current?.title.slice(0, 1000) || null, missing: !current, changed: !!current && candidate.version !== current.version });
      }
      const evidenceOffset = Number.isSafeInteger(input.evidence_offset) && input.evidence_offset >= 0 ? input.evidence_offset : 0;
      const evidence = [];
      for (const entry of theme.evidence.slice(evidenceOffset, evidenceOffset + limit)) {
        const current = await this.store.searchDocument(entry.document_id);
        evidence.push({ ...entry, missing: !current, changed: !!current && entry.version !== current.version });
      }
      const budget = boundedInt(input.max_chars, 30000, 60000), selectedCandidates: any[] = [], selectedEvidence: any[] = [];
      const queries = theme.queries.slice(-5).map((q: any) => ({ query: q.query.slice(0, 800), layer: q.layer, snapshot: q.snapshot, time: q.time,
        returned: q.returned, query_id: q.query_id, document_ids: q.document_ids.slice(0, 5), returned_ids_truncated: q.document_ids.length > 5, query_truncated: q.query.length > 800 }));
      while (JSON.stringify(queries).length > budget / 4) queries.shift();
      let used = JSON.stringify(queries).length + 1000;
      for (const candidate of candidates) { const size = JSON.stringify(candidate).length; if (used + size > budget / 2 && selectedCandidates.length) break; if (used + size > budget) break; selectedCandidates.push(candidate); used += size; }
      for (const entry of evidence) { const size = JSON.stringify(entry).length; if (used + size > budget) break; selectedEvidence.push(entry); used += size; }
      return { workspace_id: workspace.id, theme_id: theme.id, title: theme.title, candidates: selectedCandidates, evidence: selectedEvidence, queries,
        total: theme.candidates.length, next_offset: offset + selectedCandidates.length < theme.candidates.length ? offset + selectedCandidates.length : null,
        evidence_total: theme.evidence.length, next_evidence_offset: evidenceOffset + selectedEvidence.length < theme.evidence.length ? evidenceOffset + selectedEvidence.length : null,
        truncated: selectedCandidates.length < candidates.length || selectedEvidence.length < evidence.length };
    }
    let theme = workspace.themes.find((t: any) => t.id === input.theme_id);
    if (input.action === 'upsert_theme') {
      const id = text(input.theme_id, 100, 'theme_id'), title = text(input.title, 300, 'title');
      if (theme) theme.title = title;
      else { if (workspace.themes.length >= 30) throw Error('每个工作区最多 30 个主题。'); theme = { id, title, candidates: [], evidence: [], queries: [] }; workspace.themes.push(theme); }
    } else {
      if (!theme) throw Error('主题不存在，请先 upsert_theme。');
      if (input.action === 'update_candidates') {
        if (!Array.isArray(input.candidates) || input.candidates.length > 200) throw Error('每次最多更新 200 篇候选文献。');
        for (const entry of input.candidates) {
          const doc = await this.store.searchDocument(text(entry.document_id, 200, 'document_id'));
          if (!doc) throw Error('候选文献不存在。');
          const previous = theme.candidates.find((c: any) => c.document_id === doc.id);
          const status = entry.status || previous?.status || 'unreviewed'; if (!STATUSES.includes(status)) throw Error('无效筛选状态。');
          if (entry.reason !== undefined && (typeof entry.reason !== 'string' || entry.reason.length > 1500)) throw Error('reason 最多 1500 字符。');
          const candidate = { document_id: doc.id, status, reason: entry.reason ?? previous?.reason ?? '', version: doc.version,
            read_layers: Array.isArray(entry.read_layers) ? entry.read_layers.filter((l: any) => ['metadata', 'abstract', 'outline', 'fulltext'].includes(l)) : previous?.read_layers || [], updated_at: new Date().toISOString() };
          if (previous) Object.assign(previous, candidate); else theme.candidates.push(candidate);
        }
        if (theme.candidates.length > 3000) throw Error('每个主题最多保存 3000 篇候选文献。');
      } else if (input.action === 'save_evidence') {
        const doc = await this.store.document(text(input.document_id, 200, 'document_id'));
        if (!doc) throw Error('文献不存在。');
        const chunk = doc.chunks.find(c => c.id === input.chunk_id && c.layer === 'fulltext');
        if (!chunk) throw Error('请提供真实的全文 chunk_id。');
        if (!['supports', 'contradicts', 'limits', 'context', 'uncertain'].includes(input.stance)) throw Error('请标注证据立场。');
        const section = doc.sections.find(s => s.id === chunk.sectionId), current = await this.store.searchDocument(doc.id);
        if (input.version && input.version !== current?.version) throw new AppError({ code: 'EVIDENCE_CHANGED', message: '文献版本已变化，请重新读取证据。', retryable: false });
        const entry = { id: this.uuid(), document_id: doc.id, chunk_id: chunk.id, section_id: chunk.sectionId,
          page: chunk.page, role: section?.kind === 'references' ? 'references' : sectionRole(section?.heading || ''),
          claim: text(input.claim, 1500, 'claim'), stance: input.stance, interpretation_source: 'agent',
          excerpt: chunk.text.slice(0, 2000), version: current?.version, saved_at: new Date().toISOString() };
        if (theme.evidence.length >= 200) throw Error('每个主题最多保存 200 条证据。');
        theme.evidence.push(entry);
      } else if (input.action === 'remove_evidence') theme.evidence = theme.evidence.filter((e: any) => e.id !== input.evidence_id);
      else if (input.action === '_trace') { theme.queries.push(input.trace); theme.queries = theme.queries.slice(-20); }
      else throw Error('未知工作区操作。');
    }
    workspace.updated_at = new Date().toISOString();
    if (JSON.stringify(workspace).length > 2000000) throw Error('工作区已达大小上限，请拆分主题。');
    await this.store.putWorkspace(workspace);
    return { workspace_id: workspace.id, theme_id: theme.id, candidates: theme.candidates.length, evidence: theme.evidence.length, updated_at: workspace.updated_at };
  }
}
