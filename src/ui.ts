import { createIcons, icons } from 'lucide';
import { setMarkup } from './markup';
import { sortDocuments, canDeleteJob, type DocumentSortKey } from './queue';
type Bridge = any;
const app = document.getElementById('app')!;
let bridge: Bridge;
let tab = 'library';
let settingsPane = 'processing';
let status: any;
let documents: any[] = [];
let selected: string | null = null;
let selection = new Set<string>();
let selectedLayer = 'abstract';
let refreshTimer: any;
let busy = false;
const searchState: any = { query: '', layer: 'auto', mode: 'keyword', response: null };
let searchSerial = 0, detailSerial = 0, detailOffset = 0;
let detailFilter: any = {};
let visibleRows: any[] = [];
let libraryPage = 0;
let refreshRequested = false;
let renderedViewKey = '';
let jobFilter = 'all';
let jobQuery = '';
let jobQueryDraft = '';
let jobPage = 0;
let bulkRetryPending = false;
let jobActionPending = false;
const taskSelection = new Set<string>();
let contextJob: any = null;
let librarySortKey: DocumentSortKey | 'relevance' = 'title';
let librarySortDirection: 'asc' | 'desc' = 'asc';
let taskSelectionAnchor: string | null = null;
let researchSerial = 0;
let researchWorkspace = '', researchTheme = '', researchOffset = 0, researchEvidenceOffset = 0;
const LIBRARY_PAGE_SIZE = 50;
const settingDrafts: Record<string, string> = {};
function rememberSettings() {
  for (const id of ['mineru-key', 'issued-at', 'expires-at', 'embedding-api-url', 'embedding-api-model', 'embedding-api-key']) {
    const input = byId(id);
    if (input) settingDrafts[id] = input.value;
  }
}
function clearSettingDrafts(...ids: string[]) { for (const id of ids) delete settingDrafts[id]; }
const labels: Record<string, string> = { missing: '未配置', configured: '已配置 · 未验证', valid: '已验证有效',
  expired: 'Key 已过期', invalid: 'Key 无效', auth_failed: '鉴权失败', ready: '已入库', stale: '内容待更新',
  queued: '排队中', waiting_file: '等待 PDF', submitting: '提交解析', uploading: '上传中', confirming_upload: '等待上传确认', pending: '云端排队', running: '解析中',
  converting: '转换中', download: '下载结果', embedding: '向量化', done: '完成', skipped: '已跳过',
  blocked_credentials: '等待有效 Key', blocked_cloud: '等待启用上传', blocked_model: '等待模型', failed: '失败', retry: '稍后重试', metadata: '书目已存' };
const text = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const icon = (name: string, size = 17) => `<i data-lucide="${name}" width="${size}" height="${size}"></i>`;
const button = (id: string, name: string, title: string, primary = false) => `<button type="button" id="${id}" class="${primary ? 'primary' : ''}" title="${text(title)}">${icon(name)}<span>${text(title)}</span></button>`;
function layout() {
  setMarkup(app, `<aside class="sidebar"><div class="brand">${icon('library-big', 25)}<div>Literature<span>LIBRARY</span></div></div>
    <nav><button data-tab="library">${icon('library')}文献库<span id="nav-count"></span></button><button data-tab="jobs">${icon('list-checks')}任务队列<span id="job-count"></span></button><button data-tab="research">${icon('notebook-tabs')}调研主题</button><button data-tab="settings">${icon('settings-2')}设置</button></nav>
    <div class="sidebar-bottom"><span class="status-dot"></span>Zotero 本地知识库<div id="sidebar-model">Qwen · ONNX</div></div></aside>
    <main><header><div><div class="eyebrow">RESEARCH WORKSPACE</div><h1 id="view-title">文献库</h1></div><div class="header-actions">${button('refresh', 'refresh-cw', '刷新')}${button('add-selected', 'plus', '加入 Zotero 所选条目', true)}</div></header>
    <div id="notification" role="status" hidden="hidden"></div><div id="credential-warning" hidden="hidden"></div>
    <section id="summary" class="summary"></section><div id="view"></div>
    <footer><span>MinerU 解析 · 本地向量化</span><span id="footer-state"></span></footer></main>
    <menu id="task-context-menu" class="context-menu" hidden="hidden"><button type="button" id="task-context-retry">重试所选任务</button><button type="button" id="task-context-rebuild">检查后重建</button><button type="button" id="task-context-delete">删除所选任务</button></menu><dialog id="detail-dialog"><div class="dialog-head"><h2 id="detail-title"></h2><button id="close-detail" class="icon-button" title="关闭">${icon('x')}</button></div><div class="detail-tabs"><button data-layer="metadata">书目</button><button data-layer="abstract">摘要</button><button data-layer="outline">目录</button><button data-layer="fulltext">全文</button><button data-layer="notes">笔记</button></div><div id="detail-content"></div><div class="dialog-bottom"><a id="open-zotero">在 Zotero 中打开 ${icon('arrow-up-right', 14)}</a></div></dialog>`);
  document.querySelectorAll('[data-tab]').forEach(el => el.addEventListener('click', () => { hideTaskMenu(); rememberSettings(); tab = el.getAttribute('data-tab')!; render(); }));
  document.addEventListener('click', event => { if (!(event.target as Element).closest('#task-context-menu')) byId('task-context-menu').hidden = true; });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') hideTaskMenu(); });
  window.addEventListener('resize', hideTaskMenu);
  window.addEventListener('scroll', hideTaskMenu, true);
  byId('refresh').onclick = () => { if (tab === 'research') renderedViewKey = ''; return refresh(); };
  byId('add-selected').onclick = () => action(async () => {
    const jobs = await bridge.enqueueSelected(); await refresh(); return `${jobs.length} 个任务已加入队列`;
  });
  byId('close-detail').onclick = () => (byId('detail-dialog') as HTMLDialogElement).close();
  document.querySelectorAll('[data-layer]').forEach(el => el.addEventListener('click', () => {
    selectedLayer = el.getAttribute('data-layer')!; detailFilter = {}; detailOffset = 0; showDetail();
  }));
}
function byId(id: string): any { return document.getElementById(id); }
function hideTaskMenu() { if (byId('task-context-menu')) byId('task-context-menu').hidden = true; }
function runJobAction(fn: () => Promise<any>) {
  if (jobActionPending) return;
  jobActionPending = true;
  if (tab === 'jobs') renderJobs();
  return action(async () => {
    try { return await fn(); }
    finally { jobActionPending = false; if (tab === 'jobs') renderJobs(); }
  });
}
function notify(message: string, error = false) {
  const node = byId('notification'); node.hidden = false; node.className = error ? 'error' : 'success'; node.textContent = message;
}
async function action(fn: () => Promise<any>) {
  try { const result = await fn(); if (typeof result === 'string') notify(result); }
  catch (error) { notify(error instanceof Error ? error.message : String(error), true); }
}
async function refresh() {
  if (busy) { refreshRequested = true; return; }
  busy = true;
  try { [status, documents] = await Promise.all([bridge.status(), bridge.list()]); render(); }
  catch (error) { notify(error instanceof Error ? error.message : String(error), true); }
  finally {
    busy = false;
    if (refreshRequested) { refreshRequested = false; queueMicrotask(() => refresh()); }
  }
}
function render() {
  if (!status) return;
  document.querySelectorAll('[data-tab]').forEach(el => el.classList.toggle('active', el.getAttribute('data-tab') === tab));
  byId('view-title').textContent = { library: '文献库', jobs: '任务队列', research: '调研主题', settings: '设置' }[tab];
  byId('nav-count').textContent = documents.length;
  const waiting = status.queue.filter((j: any) => !['done', 'skipped'].includes(j.state)).length;
  byId('job-count').textContent = waiting || '';
  byId('sidebar-model').textContent = status.settings.embeddingProvider === 'api'
    ? `API · ${status.settings.embeddingApiModel}` : `${status.settings.model === 'qwen' ? 'Qwen3 0.6B' : 'E5-small'} · ${status.model.state}`;
  document.querySelector('main > footer > span')!.textContent = `MinerU 解析 · ${status.settings.embeddingProvider === 'api' ? 'API' : '本地'}向量化`;
  byId('footer-state').textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
  const cred = status.credentials;
  const warning = ['expired', 'invalid', 'auth_failed'].includes(cred.state) || typeof cred.daysRemaining === 'number' && cred.daysRemaining <= 7;
  byId('credential-warning').hidden = !warning;
  setMarkup(byId('credential-warning'), `${icon('key-round')}<span>${text(['expired', 'invalid', 'auth_failed'].includes(cred.state) ? labels[cred.state]
    : cred.daysRemaining <= 0 ? 'MinerU Key 预计已到期，实际调用时验证' : `MinerU Key 预计 ${cred.daysRemaining} 天后到期`)} · ${waiting} 个任务待处理</span><button id="fix-key">更新 Key ${icon('arrow-right', 14)}</button>`);
  if (warning) byId('fix-key').onclick = () => { rememberSettings(); tab = 'settings'; settingsPane = 'processing'; render(); };
  const cov = status.coverage;
  byId('summary').hidden = tab === 'settings';
  setMarkup(byId('summary'), [
    ['library', '文献条目', cov.documents], ['file-text', '摘要', cov.abstracts],
    ['file-check-2', '全文已提取', cov.fulltext], ['network', '当前模型已索引', cov.vectors]
  ].map(([symbol, label, value]) => `<div class="metric">${icon(String(symbol), 19)}<div><span>${label}</span><strong>${value}</strong></div><div class="coverage"><b style="width:${cov.documents ? Number(value) / cov.documents * 100 : 0}%"></b></div></div>`).join(''));
  const viewKey = JSON.stringify(tab === 'library' ? [tab, documents] : tab === 'jobs' ? [tab, status.queue] : tab === 'research' ? [tab, status.research_revision] : [tab, settingsPane, status.settings, status.credentials, status.model, status.embedding_credentials, status.agents, status.storage]);
  if (viewKey !== renderedViewKey) {
    renderedViewKey = viewKey;
    if (tab === 'library') renderLibrary(); else if (tab === 'jobs') renderJobs(); else if (tab === 'research') void renderResearch(); else renderSettings();
  }
  createIcons({ icons, attrs: { 'stroke-width': 1.7 } });
}
async function renderResearch() {
  const serial = ++researchSerial;
  setMarkup(byId('view'), '<div class="setup-card">正在读取调研工作区…</div>');
  try {
    const list = await bridge.workspace({ action: 'list', limit: 100 });
    let detail: any;
    if (researchWorkspace && researchTheme) detail = await bridge.workspace({ action: 'get', workspace_id: researchWorkspace,
      theme_id: researchTheme, offset: researchOffset, evidence_offset: researchEvidenceOffset, limit: 20 });
    if (serial !== researchSerial || tab !== 'research') return;
    const statuses: Record<string, string> = { unreviewed: '待筛选', included: '已纳入', excluded: '已排除', uncertain: '待核查' };
    setMarkup(byId('view'), `<div class="research-layout"><section class="setup-card"><div class="section-title"><h2>调研工作区</h2>${button('research-refresh', 'refresh-cw', '刷新主题')}</div>
      <p class="small-note">Agent 按主题保存候选文献、筛选理由和证据。这里的记录独立于 Zotero 集合与标签。</p>
      ${list.workspaces.length ? list.workspaces.map((w: any) => `<div class="research-workspace"><h3>${text(w.title)}</h3>${w.themes.map((t: any) => `<button class="section-link ${researchWorkspace === w.id && researchTheme === t.id ? 'active' : ''}" data-workspace="${text(w.id)}" data-theme="${text(t.id)}"><span>${text(t.title)}</span><span>${t.candidates} 篇 · ${t.evidence} 条证据</span></button>`).join('') || '<p class="small-note">尚未创建主题</p>'}</div>`).join('') : '<p>还没有调研工作区。让 Agent 使用 literature_workspace 创建主题，读取摘要并保存筛选结果。</p>'}
      ${list.next_offset !== null ? '<p class="small-note">仅展示前 100 个工作区；其余可通过 MCP 分页读取。</p>' : ''}</section>
      <section class="setup-card">${detail ? `<h2>${text(detail.title)}</h2><h3>候选文献 · ${detail.total}</h3>
        ${detail.candidates.map((c: any) => `<article class="research-entry"><button class="title-button" data-research-document="${text(c.document_id)}">${text(c.title || c.document_id)}</button><div class="small-note">${text(statuses[c.status] || c.status)}${c.changed ? ' · 来源版本已变化，需重新核对' : ''}${c.missing ? ' · 来源已移除' : ''}</div><p>${text(c.reason || '尚未记录筛选理由')}</p></article>`).join('') || '<p class="small-note">尚无候选文献</p>'}
        <div class="research-pagination"><button id="research-prev" ${researchOffset === 0 ? 'disabled="disabled"' : ''}>上一页文献</button><button id="research-next" ${detail.next_offset === null ? 'disabled="disabled"' : ''}>下一页文献</button></div>
        <h3>证据 · ${detail.evidence_total}</h3>${detail.evidence.map((e: any) => `<article class="research-entry"><strong>${text(e.claim)}</strong><div class="small-note">Agent 判断：${text(({ supports: '支持', contradicts: '反驳', limits: '限制', context: '背景', uncertain: '待核查' } as any)[e.stance])} · ${e.page ? `PDF ${e.page} 页` : '页码未知'}${e.changed ? ' · 来源版本已变化' : ''}${e.missing ? ' · 来源已移除' : ''}</div><p>${text(e.excerpt)}</p><button data-evidence-document="${text(e.document_id)}" data-evidence-chunk="${text(e.chunk_id)}">读取原始证据</button></article>`).join('') || '<p class="small-note">尚无已保存证据</p>'}
        <div class="research-pagination"><button id="evidence-prev" ${researchEvidenceOffset === 0 ? 'disabled="disabled"' : ''}>上一页证据</button><button id="evidence-next" ${detail.next_evidence_offset === null ? 'disabled="disabled"' : ''}>下一页证据</button></div>
        <h3>最近查询</h3>${detail.queries.map((q: any) => `<div class="small-note">${text(q.query)} · ${text(q.layer)} · 返回 ${q.returned} 条</div>`).join('') || '<p class="small-note">暂无查询轨迹</p>'}` : '<h2>摘要 → 候选 → 正文证据</h2><p>选择左侧主题，查看 Agent 的筛选结果、原始证据和查询轨迹。</p>'}</section></div>`);
    byId('research-refresh').onclick = () => { void renderResearch(); };
    document.querySelectorAll('[data-workspace]').forEach(el => el.addEventListener('click', () => {
      researchWorkspace = el.getAttribute('data-workspace')!; researchTheme = el.getAttribute('data-theme')!;
      researchOffset = 0; researchEvidenceOffset = 0; void renderResearch();
    }));
    document.querySelectorAll('[data-research-document]').forEach(el => el.addEventListener('click', () => {
      selected = el.getAttribute('data-research-document'); selectedLayer = 'abstract'; detailOffset = 0; detailFilter = {}; void showDetail();
    }));
    document.querySelectorAll('[data-evidence-document]').forEach(el => el.addEventListener('click', () => {
      selected = el.getAttribute('data-evidence-document'); selectedLayer = 'fulltext'; detailOffset = 0;
      detailFilter = { chunk_id: el.getAttribute('data-evidence-chunk'), neighbors: 1 }; void showDetail();
    }));
    if (detail) {
      byId('research-prev').onclick = () => { researchOffset = Math.max(0, researchOffset - 20); void renderResearch(); };
      byId('research-next').onclick = () => { researchOffset = detail.next_offset; void renderResearch(); };
      byId('evidence-prev').onclick = () => { researchEvidenceOffset = Math.max(0, researchEvidenceOffset - 20); void renderResearch(); };
      byId('evidence-next').onclick = () => { researchEvidenceOffset = detail.next_evidence_offset; void renderResearch(); };
    }
    createIcons({ icons });
  } catch (error: any) { if (serial === researchSerial && tab === 'research') setMarkup(byId('view'), `<div class="setup-card">${text(error.message)}<button id="research-retry">重新读取</button></div>`); byId('research-retry')?.addEventListener('click', () => { researchWorkspace = ''; researchTheme = ''; void renderResearch(); }); }
}
function renderLibrary() {
  const view = byId('view');
  if (!byId('search-form')) setMarkup(view, `<div class="toolbar"><form id="search-form"><div class="search-input">${icon('search')}<input id="search-query" aria-label="搜索文献" placeholder="先搜标题、作者和摘要；查证据请选择全文…" value="${text(searchState.query)}"/></div><select id="search-layer" aria-label="检索层"><option value="auto">书目与摘要（默认）</option><option value="metadata">书目</option><option value="abstract">摘要</option><option value="fulltext">全文</option></select><select id="search-mode" aria-label="检索模式"><option value="keyword">关键词</option><option value="hybrid">混合检索</option><option value="semantic">向量检索</option></select><button type="submit" class="primary" title="搜索">${icon('search')}搜索</button>${button('clear-search', 'x', '清除搜索')}</form><div class="selection-actions">${button('reindex-selected', 'rotate-cw', '更新索引')}${button('remove-selected', 'trash-2', '移除')}</div></div>
    <div class="library-sort"><label>排序<select id="library-sort"><option value="relevance">检索相关度</option><option value="title">标题</option><option value="creators">作者</option><option value="year">年份</option><option value="publication">期刊</option><option value="state">状态</option></select></label>${button('library-sort-direction', 'arrow-down-wide-narrow', '升序')}</div><div class="table-wrap"><table><thead><tr><th class="check-col"><input id="select-all" type="checkbox" aria-label="选择本页全部文献"/></th><th>文献</th><th class="year-col">年份</th><th>覆盖层级</th><th>状态</th><th class="end-col"></th></tr></thead><tbody id="document-rows"></tbody></table></div><div id="library-empty" class="empty" ${documents.length ? 'hidden="hidden"' : ''}>${icon('library', 40)}<h2>文献库为空</h2><button id="empty-add" class="primary">${icon('plus')}加入 Zotero 所选条目</button></div><div id="search-notice" class="small-note"></div>`);
  byId('search-layer').value = searchState.layer; byId('search-mode').value = searchState.mode;
  if (byId('search-query').value !== searchState.query) byId('search-query').value = searchState.query;
  byId('search-query').oninput = () => { searchState.query = byId('search-query').value; };
  byId('search-layer').onchange = () => { searchState.layer = byId('search-layer').value; };
  byId('search-mode').onchange = () => { searchState.mode = byId('search-mode').value; };
  byId('clear-search').onclick = () => { searchSerial++; libraryPage = 0; searchState.query = ''; searchState.response = null; if (librarySortKey === 'relevance') librarySortKey = 'title'; renderLibrary(); };
  const response = searchState.response;
  visibleRows = response ? response.results.map((hit: any) => {
    const doc = documents.find(d => d.id === hit.document_id); return doc ? { ...doc, hit } : null;
  }).filter(Boolean) : documents;
  if (librarySortKey !== 'relevance') visibleRows = sortDocuments(visibleRows, librarySortKey, librarySortDirection);
  const pageCount = Math.max(1, Math.ceil(visibleRows.length / LIBRARY_PAGE_SIZE));
  libraryPage = Math.min(libraryPage, pageCount - 1);
  const pageRows = visibleRows.slice(libraryPage * LIBRARY_PAGE_SIZE, (libraryPage + 1) * LIBRARY_PAGE_SIZE);
  fillRows(pageRows);
  byId('view').querySelectorAll('.list-pagination').forEach((node: Element) => node.remove());
  byId('library-empty').hidden = !!documents.length;
  byId('search-notice').textContent = '';
  if (response) byId('search-notice').textContent = `${visibleRows.length} 个结果 · ${response.mode === 'semantic' ? '向量检索' : response.mode === 'hybrid' ? '混合检索' : '关键词'}${response.warning ? ' · ' + response.warning.message : ''}`;
  if (pageCount > 1) {
    const pager = document.createElementNS('http://www.w3.org/1999/xhtml', 'div'); pager.className = 'list-pagination';
    setMarkup(pager, `<button type="button" id="page-previous" ${libraryPage ? '' : 'disabled="disabled"'}>上一页</button><span>${libraryPage + 1} / ${pageCount} · ${visibleRows.length} 篇</span><button type="button" id="page-next" ${libraryPage + 1 < pageCount ? '' : 'disabled="disabled"'}>下一页</button>`);
    byId('search-notice').before(pager);
    byId('page-previous').onclick = () => { libraryPage--; renderLibrary(); };
    byId('page-next').onclick = () => { libraryPage++; renderLibrary(); };
  }
  byId('select-all').onchange = (event: any) => { pageRows.forEach(d => event.target.checked ? selection.add(d.id) : selection.delete(d.id)); fillRows(pageRows); };
  byId('library-sort').value = librarySortKey;
  byId('library-sort-direction').textContent = librarySortDirection === 'asc' ? '升序' : '降序';
  byId('library-sort-direction').disabled = librarySortKey === 'relevance';
  byId('library-sort').querySelector('[value="relevance"]').disabled = !response;
  byId('library-sort').onchange = () => { librarySortKey = byId('library-sort').value; libraryPage = 0; renderLibrary(); };
  byId('library-sort-direction').onclick = () => { librarySortDirection = librarySortDirection === 'asc' ? 'desc' : 'asc'; renderLibrary(); };
  byId('empty-add')?.addEventListener('click', () => byId('add-selected').click());
  byId('reindex-selected').onclick = () => action(async () => {
    if (!selection.size) return '请先选择文献';
    for (const id of selection) await bridge.reindex(id, false); await refresh(); return '已加入更新队列；未变更 PDF 将复用解析结果';
  });
  byId('remove-selected').onclick = () => action(async () => {
    if (!selection.size) return '请先选择文献';
    if (!confirm(`从派生知识库移除 ${selection.size} 篇文献？Zotero 原条目和 PDF 会保留。`)) return;
    for (const id of selection) await bridge.remove(id); selection.clear(); await refresh(); return '已移除派生索引';
  });
  byId('search-form').onsubmit = (event: Event) => {
    event.preventDefault(); action(async () => {
      const serial = ++searchSerial;
      searchState.query = byId('search-query').value;
      const { query, layer, mode } = searchState;
      if (!query.trim()) { libraryPage = 0; searchState.response = null; if (librarySortKey === 'relevance') librarySortKey = 'title'; renderLibrary(); return; }
      byId('search-notice').textContent = '正在检索…';
      const response = await bridge.search({ query, layer, mode, top_k: 50 });
      if (serial !== searchSerial) return;
      libraryPage = 0;
      searchState.response = response;
      librarySortKey = 'relevance';
      if (tab === 'library') renderLibrary();
    });
  };
}
function fillRows(rows: any[]) {
  setMarkup(byId('document-rows'), rows.map(doc => `<tr data-id="${text(doc.id)}"><td><input class="row-check" type="checkbox" aria-label="选择 ${text(doc.title)}" ${selection.has(doc.id) ? 'checked="checked"' : ''}/></td><td><button class="title-button">${text(doc.title)}</button><div class="authors">${text(doc.creators || '作者未知')}<span>${text(doc.publication)}</span></div>${doc.hit ? `<div class="snippet">${text(doc.hit.snippet)}</div><div class="small-note">命中${text(({ metadata: '书目', abstract: '摘要', fulltext: '全文' } as Record<string, string>)[doc.hit.layer] || '')}${doc.hit.page ? ` · PDF 第 ${doc.hit.page} 页` : ''} · 点击标题查看证据</div>` : ''}</td><td class="year-col">${text(doc.year || '—')}</td><td><div class="layers"><span class="available">书目</span><span class="${doc.abstract ? 'available' : ''}">摘要</span><span class="${doc.hasFulltext ? 'available' : ''}">全文</span><span class="${doc.hasCurrentVectors ? 'available' : ''}" title="${doc.modelFingerprint && !doc.hasCurrentVectors ? '向量版本已变化，重新入库后可用' : ''}">向量</span></div></td><td><span class="badge ${doc.error ? 'warning' : doc.state === 'ready' ? 'ready' : ''}">${text(labels[doc.taskState || doc.state] || doc.state)}</span>${doc.error ? `<div class="row-error">${text(doc.error.message)}</div>` : ''}</td><td><a href="${text(doc.hit?.link || `zotero://select/${doc.libraryKey}/items/${doc.itemKey}`)}" title="在 Zotero 中打开" class="icon-button">${icon('arrow-up-right')}</a></td></tr>`).join(''));
  document.querySelectorAll('tr[data-id]').forEach(row => {
    const id = row.getAttribute('data-id')!;
    row.querySelector('.title-button')!.addEventListener('click', () => {
      const hit = rows.find(d => d.id === id)?.hit;
      selected = id; selectedLayer = hit?.layer || 'abstract'; detailOffset = 0;
      detailFilter = hit?.layer === 'fulltext' ? { section_id: hit.section_id, chunk_id: hit.chunk_id, ...(hit.page ? { page: hit.page } : {}) } : {};
      showDetail();
    });
    row.querySelector('.row-check')!.addEventListener('change', (event: any) => { event.target.checked ? selection.add(id) : selection.delete(id); syncSelection(); });
  });
  function syncSelection() {
    const count = rows.filter(doc => selection.has(doc.id)).length;
    byId('select-all').checked = !!rows.length && count === rows.length;
    byId('select-all').indeterminate = count > 0 && count < rows.length;
    byId('reindex-selected').disabled = !selection.size;
    byId('remove-selected').disabled = !selection.size;
  }
  syncSelection();
  createIcons({ icons });
}
async function showDetail() {
  const serial = ++detailSerial;
  await action(async () => {
    const data = await bridge.read({ document_id: selected, layer: selectedLayer, ...detailFilter, offset: detailOffset, max_chars: 12000 });
    if (serial !== detailSerial) return;
    byId('detail-title').textContent = data.title;
    byId('open-zotero').href = data.pdf_link || data.link;
    document.querySelectorAll('[data-layer]').forEach(el => el.classList.toggle('active', el.getAttribute('data-layer') === selectedLayer));
    setMarkup(byId('detail-content'), selectedLayer === 'outline'
      ? (data.sections || []).map((s: any) => `<button class="section-link" data-section="${text(s.id)}"><span>${text(s.heading)}</span><span>${s.page ? `PDF ${s.page}` : '页码未知'}</span></button>`).join('')
      : `${selectedLayer === 'fulltext' ? `<div class="reading-context">${text(data.sections?.map((s: any) => s.page ? `${s.heading} · PDF ${s.page}` : s.heading).join(' / ') || '未找到匹配章节或页码')}</div>` : ''}<pre>${text(data.text || (data.metadata ? JSON.stringify(data.metadata, null, 2) : data.notes ? JSON.stringify(data.notes, null, 2) : '此层内容尚未提取'))}</pre>${selectedLayer === 'fulltext' ? `<div class="reading-pagination"><button id="read-previous" ${detailOffset ? '' : 'disabled="disabled"'}>上一段</button><span>${Math.min(detailOffset + 1, data.total_chars || 0)}–${Math.min(detailOffset + 12000, data.total_chars || 0)} / ${data.total_chars || 0} 字符</span><button id="read-next" ${data.next_offset === null ? 'disabled="disabled"' : ''}>下一段</button>${detailFilter.section_id || detailFilter.page ? '<button id="read-all">阅读全文</button>' : ''}</div>` : ''}`);
    document.querySelectorAll('[data-section]').forEach(el => el.addEventListener('click', () => action(async () => {
      selectedLayer = 'fulltext'; detailFilter = { section_id: el.getAttribute('data-section') }; detailOffset = 0; await showDetail();
    })));
    if (byId('read-next')) byId('read-next').onclick = () => { detailOffset = data.next_offset; showDetail(); };
    if (byId('read-previous')) byId('read-previous').onclick = () => { detailOffset = Math.max(0, detailOffset - 12000); showDetail(); };
    if (byId('read-all')) byId('read-all').onclick = () => { detailFilter = {}; detailOffset = 0; showDetail(); };
    const dialog = byId('detail-dialog') as HTMLDialogElement;
    if (!dialog.open) dialog.showModal();
  });
}
function renderJobs() {
  hideTaskMenu();
  if (!byId('job-search-form')) {
    setMarkup(byId('view'), `<form id="job-search-form" class="job-search"><input id="job-search-query" type="search" aria-label="搜索任务" placeholder="按文献标题、错误或阶段搜索任务" value="${text(jobQueryDraft)}"/><button type="submit">搜索任务</button><button type="button" id="clear-job-search">清除</button></form><div id="jobs-content"></div>`);
  }
  byId('job-search-query').oninput = () => { jobQueryDraft = byId('job-search-query').value; byId('clear-job-search').disabled = !jobQueryDraft && !jobQuery; };
  byId('job-search-form').onsubmit = (event: Event) => {
    event.preventDefault(); jobQuery = jobQueryDraft; jobPage = 0; renderJobs();
  };
  byId('clear-job-search').disabled = !jobQueryDraft && !jobQuery;
  byId('clear-job-search').onclick = () => { jobQueryDraft = jobQuery = ''; byId('job-search-query').value = ''; jobPage = 0; renderJobs(); };
  const allJobs = status.queue;
  const jobIDs = new Set(allJobs.map((job: any) => job.id));
  for (const id of taskSelection) if (!jobIDs.has(id)) taskSelection.delete(id);
  const activeJobs = allJobs.filter((job: any) => !['done', 'skipped'].includes(job.state));
  const retryable = activeJobs.filter((job: any) => job.can_bulk_resume).length;
  const filteredJobs = (jobFilter === 'completed' ? allJobs.filter((job: any) => ['done', 'skipped'].includes(job.state)) : activeJobs)
    .filter((job: any) => jobFilter === 'all' || jobFilter === 'completed' || (jobFilter === 'retryable' ? job.can_bulk_resume
      : jobFilter === 'attention' ? job.error || job.retry_exclusion : !job.error && !job.retry_exclusion))
    .filter((job: any) => !jobQuery.trim() || `${job.documentTitle || documents.find((d: any) => d.id === job.documentID)?.title || ''} ${job.error?.message || ''} ${job.progress?.message || ''} ${labels[job.displayState || job.state] || job.state}`.toLocaleLowerCase().includes(jobQuery.trim().toLocaleLowerCase()));
  const pageCount = Math.max(1, Math.ceil(filteredJobs.length / LIBRARY_PAGE_SIZE));
  jobPage = Math.min(jobPage, pageCount - 1);
  const jobs = filteredJobs.slice(jobPage * LIBRARY_PAGE_SIZE, (jobPage + 1) * LIBRARY_PAGE_SIZE);
  const selectedJobs = allJobs.filter((job: any) => taskSelection.has(job.id));
  const selectedRetryable = selectedJobs.filter((job: any) => job.can_bulk_resume).length;
  const selectedDeletable = selectedJobs.filter(canDeleteJob).length;
  setMarkup(byId('jobs-content'), `<div class="section-toolbar"><h2>任务队列 <span>${filteredJobs.length}</span></h2><div class="task-actions"><button type="button" id="retry-selected" ${selectedRetryable ? '' : 'disabled="disabled"'}>重试所选 (${selectedRetryable})</button><button type="button" id="delete-selected" ${selectedDeletable ? '' : 'disabled="disabled"'}>删除所选 (${selectedDeletable})</button><button type="button" id="clear-task-selection" ${taskSelection.size ? '' : 'disabled="disabled"'}>清除选择 (${taskSelection.size})</button><button type="button" id="clear-completed" ${allJobs.some((job: any) => ['done', 'skipped'].includes(job.state)) ? '' : 'disabled="disabled"'}>清理已完成</button>${button('resume-jobs', 'play', '一键重试')}</div></div>${jobs.length ? `<div class="table-wrap"><table class="task-table"><thead><tr><th><input type="checkbox" id="select-all-jobs" aria-label="选择本页任务"/></th><th>文献</th><th>阶段</th><th>进度</th><th>详情</th><th>操作</th></tr></thead><tbody>${jobs.map((job: any) => `<tr data-job-id="${text(job.id)}" class="${taskSelection.has(job.id) ? 'is-selected' : ''}"><td><input type="checkbox" class="task-check" data-task-check="${text(job.id)}" ${taskSelection.has(job.id) ? 'checked="checked"' : ''}/></td><td>${text(job.documentTitle || documents.find((d: any) => d.id === job.documentID)?.title || job.documentID)}</td><td><span class="badge ${job.error ? 'warning' : ''}">${text(labels[job.displayState || job.state] || job.state)}</span></td><td>${job.progress?.embedded !== undefined ? `${job.progress.embedded} / ${job.progress.total} 块` : job.progress?.extracted_pages !== undefined ? `${job.progress.extracted_pages} / ${job.progress.total_pages} 页` : '—'}</td><td class="job-error">${text(job.error?.message || job.progress?.message || '')}</td><td>${job.can_resume ? `<button type="button" data-retry="${text(job.id)}">${['MINERU_UPLOAD_INCOMPLETE', 'MINERU_UPLOAD_CONFIRMATION_TIMEOUT'].includes(job.error?.code) ? '恢复查询原任务' : '重试此任务'}</button>` : ''}${job.requires_rebuild ? `<button type="button" data-rebuild="${text(job.documentID)}">检查后重建</button>` : ''}${canDeleteJob(job) ? `<button type="button" data-delete-job="${text(job.id)}">删除任务</button>` : ''}</td></tr>`).join('')}</tbody></table></div><div class="small-note">右键任务可对所选项批量重试或删除，也可检查后重建当前任务。删除只移除任务和未成功的派生数据，不影响 Zotero 条目/PDF。</div>` : `<div class="empty queue-empty"><h2>${activeJobs.length ? '此筛选下暂无任务' : '没有待办任务'}</h2><span>失败任务可多选后批量重试或删除。</span></div>`}`);
  const bulk = byId('resume-jobs');
  byId('view').querySelector('.section-toolbar h2 span').textContent = filteredJobs.length;
  const emptyHeading = byId('view').querySelector('.queue-empty h2');
  if (emptyHeading && activeJobs.length) emptyHeading.textContent = '此筛选下暂无任务';
  const taskTable = byId('view').querySelector('table');
  if (taskTable) {
    taskTable.querySelectorAll('tbody tr').forEach((row: Element, index: number) => {
      const job: any = jobs[index];
      const selectJob = (checked: boolean, shiftKey: boolean) => {
        const start = taskSelectionAnchor ? filteredJobs.findIndex((value: any) => value.id === taskSelectionAnchor) : -1;
        const end = jobPage * LIBRARY_PAGE_SIZE + index;
        const range = shiftKey && start >= 0 ? filteredJobs.slice(Math.min(start, end), Math.max(start, end) + 1) : [job];
        range.forEach((value: any) => checked ? taskSelection.add(value.id) : taskSelection.delete(value.id));
        taskSelectionAnchor = job.id; renderJobs();
      };
      row.querySelector('.task-check')!.addEventListener('click', (event: Event) => {
        const mouse = event as MouseEvent;
        selectJob((event.target as HTMLInputElement).checked, mouse.shiftKey);
      });
      row.addEventListener('click', (event: Event) => {
        if ((event.target as Element).closest('button,input,a')) return;
        const mouse = event as MouseEvent;
        if (!mouse.ctrlKey && !mouse.metaKey && !mouse.shiftKey) taskSelection.clear();
        selectJob(mouse.ctrlKey || mouse.metaKey ? !taskSelection.has(job.id) : true, mouse.shiftKey);
      });
      row.addEventListener('contextmenu', (event: Event) => {
        event.preventDefault(); contextJob = job;
        if (!taskSelection.has(job.id)) { taskSelection.clear(); taskSelection.add(job.id); }
        renderJobs();
        const menu = byId('task-context-menu'); menu.hidden = false;
        const selectedTasks = status.queue.filter((item: any) => taskSelection.has(item.id));
        byId('task-context-retry').disabled = jobActionPending || !selectedTasks.some((item: any) => item.can_bulk_resume);
        byId('task-context-rebuild').disabled = jobActionPending || !job.requires_rebuild;
        byId('task-context-delete').disabled = jobActionPending || !selectedTasks.some(canDeleteJob);
        menu.style.left = `${Math.max(8, Math.min((event as MouseEvent).clientX, innerWidth - 240))}px`;
        menu.style.top = `${Math.max(8, Math.min((event as MouseEvent).clientY, innerHeight - 130))}px`;
      });
      const exclusion = jobs[index].retry_exclusion;
      if (!exclusion) return;
      const note = document.createElementNS('http://www.w3.org/1999/xhtml', 'div'); note.className = 'small-note'; note.textContent = exclusion;
      row.querySelector('.job-error')?.append(note);
      const retry = row.querySelector('[data-retry]');
      if (retry) { retry.textContent = '修正 PDF 后重试'; retry.setAttribute('title', exclusion); }
    });
  }
  const selectAllJobs = byId('select-all-jobs');
  if (selectAllJobs) {
    const selectedOnPage = jobs.filter((job: any) => taskSelection.has(job.id)).length;
    selectAllJobs.checked = jobs.length > 0 && selectedOnPage === jobs.length;
    selectAllJobs.indeterminate = selectedOnPage > 0 && selectedOnPage < jobs.length;
    selectAllJobs.onchange = (event: any) => {
      jobs.forEach((job: any) => event.target.checked ? taskSelection.add(job.id) : taskSelection.delete(job.id)); renderJobs();
    };
  }
  bulk.textContent = bulkRetryPending ? '正在检查并重试…' : `一键重试 (${retryable})`; bulk.disabled = bulkRetryPending || !retryable;
  const controls = document.createElementNS('http://www.w3.org/1999/xhtml', 'div'); controls.className = 'queue-controls';
  setMarkup(controls, `<div class="queue-filters" role="group" aria-label="任务筛选">${[['all', '全部待办'], ['running', '处理中'], ['retryable', '可重试'], ['attention', '需处理'], ['completed', '已完成']].map(([value, label]) => `<button type="button" data-job-filter="${value}" aria-pressed="${jobFilter === value}">${label}</button>`).join('')}</div><span class="queue-count">${filteredJobs.length} 项 · 无 PDF、页数或大小超限自动跳过</span>`);
  byId('view').querySelector('.section-toolbar').after(controls);
  controls.querySelectorAll('[data-job-filter]').forEach(el => el.addEventListener('click', () => { jobFilter = el.getAttribute('data-job-filter')!; jobPage = 0; renderJobs(); }));
  if (pageCount > 1) {
    const pager = document.createElementNS('http://www.w3.org/1999/xhtml', 'div'); pager.className = 'list-pagination';
    setMarkup(pager, `<button type="button" id="jobs-previous" ${jobPage ? '' : 'disabled="disabled"'}>上一页</button><span>${jobPage + 1} / ${pageCount}</span><button type="button" id="jobs-next" ${jobPage + 1 < pageCount ? '' : 'disabled="disabled"'}>下一页</button>`);
    byId('jobs-content').append(pager);
    byId('jobs-previous').onclick = () => { jobPage--; renderJobs(); };
    byId('jobs-next').onclick = () => { jobPage++; renderJobs(); };
  }
  byId('resume-jobs').onclick = () => runJobAction(async () => {
    if (bulkRetryPending) return;
    bulkRetryPending = true;
    bulk.disabled = true; bulk.textContent = '正在检查并重试…';
    try {
      const result = await bridge.resume();
      const excluded = Object.entries(result.exclusions || {}).map(([cause, count]) => `${cause} ${count} 项`).join('；');
      await refresh();
      return `已恢复 ${result.resumed} 项${result.skipped ? `，跳过 ${result.skipped} 项：${excluded}` : ''}`;
    } finally { bulkRetryPending = false; if (tab === 'jobs') renderJobs(); }
  });
  byId('retry-selected').onclick = () => runJobAction(async () => {
    const ids = [...taskSelection].filter(id => status.queue.some((job: any) => job.id === id && job.can_bulk_resume));
    if (!ids.length) return '所选任务中没有可重试项';
    const result = await bridge.resume(ids); taskSelection.clear(); await refresh();
    return `已重试 ${result.resumed} 项${result.skipped ? `，跳过 ${result.skipped} 项` : ''}`;
  });
  const deleteTasks = async (ids: string[]) => {
    const deletable = ids.filter(id => status.queue.some((job: any) => job.id === id && canDeleteJob(job)));
    if (!deletable.length) return '没有可删除任务；正在处理中的任务需要等待结束';
    if (!confirm(`删除 ${deletable.length} 个任务？仅移除本插件的任务和未成功派生数据，不影响 Zotero 文献或 PDF。`)) return;
    const result = await bridge.deleteJobs(deletable); taskSelection.clear(); await refresh();
    return `已删除 ${result.deleted} 项${result.skipped ? `，跳过 ${result.skipped} 项处理中任务` : ''}`;
  };
  const rebuildTask = async (documentID: string) => {
    if (!confirm('已检查 MinerU 原任务并确定需要重建？此操作可能重新上传 PDF 并消耗解析额度。')) return;
    await bridge.reindex(documentID); await refresh(); return '已加入重建队列';
  };
  byId('delete-selected').onclick = () => runJobAction(() => deleteTasks([...taskSelection]));
  byId('clear-task-selection').onclick = () => { taskSelection.clear(); taskSelectionAnchor = null; renderJobs(); };
  byId('clear-completed').onclick = () => runJobAction(async () => {
    const count = allJobs.filter((job: any) => ['done', 'skipped'].includes(job.state)).length;
    if (!count) return '没有可清理的已完成任务';
    if (!confirm(`清理 ${count} 个已完成任务记录？不会删除已入库文献、Zotero 条目或 PDF。`)) return;
    const result = await bridge.clearCompletedJobs(); await refresh();
    return `已清理 ${result.deleted} 个已完成任务`;
  });
  document.querySelectorAll('[data-delete-job]').forEach(el => el.addEventListener('click', () => runJobAction(() => deleteTasks([el.getAttribute('data-delete-job')!]))));
  byId('task-context-retry').onclick = () => { byId('task-context-menu').hidden = true; byId('retry-selected').click(); };
  byId('task-context-rebuild').onclick = () => {
    byId('task-context-menu').hidden = true;
    if (contextJob?.requires_rebuild) runJobAction(() => rebuildTask(contextJob.documentID));
    else notify('该任务不需要重建；可使用重试或删除操作', true);
  };
  byId('task-context-delete').onclick = () => { byId('task-context-menu').hidden = true; runJobAction(() => deleteTasks([...taskSelection])); };
  document.querySelectorAll('[data-retry]').forEach(el => el.addEventListener('click', () => runJobAction(async () => {
    const job = status.queue.find((j: any) => j.id === el.getAttribute('data-retry'));
    const resumingUpload = ['MINERU_UPLOAD_INCOMPLETE', 'MINERU_UPLOAD_CONFIRMATION_TIMEOUT'].includes(job?.error?.code);
    const result = await bridge.resume(el.getAttribute('data-retry')); await refresh();
    if (!result.resumed) return '任务状态已变化或不可重试，已刷新队列，请查看最新详情';
    return resumingUpload ? '已恢复查询原任务，不会重新上传 PDF' : '已重新排队；若再次失败会显示新的错误原因';
  })));
  document.querySelectorAll('[data-rebuild]').forEach(el => el.addEventListener('click', () => runJobAction(async () => {
    return rebuildTask(el.getAttribute('data-rebuild')!);
  })));
  if (jobActionPending) document.querySelectorAll('#jobs-content .task-actions button:not(#clear-task-selection), #jobs-content td button').forEach(el => (el as HTMLButtonElement).disabled = true);

}
function renderSettings() {
  // Drafts stay in this window's memory, including across status refreshes and tab changes.
  rememberSettings();
  const focused = document.activeElement as HTMLInputElement | null;
  const focusID = focused?.id, cursor = focused?.selectionStart;
  const cred = status.credentials, settings = status.settings;
  const badge = status.credentials;
  const tabs = `<div class="setup-tabs"><button data-settings-pane="processing" class="${settingsPane === 'processing' ? 'active' : ''}">1 · PDF 解析</button><button data-settings-pane="embedding" class="${settingsPane === 'embedding' ? 'active' : ''}">2 · 向量模型</button><button data-settings-pane="agents" class="${settingsPane === 'agents' ? 'active' : ''}">3 · Agent 接入</button></div>`;
  const heading = `<div class="setup-heading"><div><div class="eyebrow">快速设置 · 完成一次后即可开始</div><h2>${settingsPane === 'processing' ? 'PDF 解析' : settingsPane === 'embedding' ? '向量模型' : '连接 Agent'}</h2></div></div>${tabs}`;
  let content = '';
  if (settingsPane === 'processing') {
    content = `<section class="setup-card"><div class="section-title">${icon('cloud')}<h2>MinerU PDF → Markdown</h2><span id="credential-state" class="badge ${['expired', 'invalid', 'auth_failed'].includes(badge.state) ? 'warning' : 'ready'}">${text(labels[badge.state])}</span></div>
      <div class="info-callout"><strong>解析服务固定使用 MinerU</strong><span>开始全文解析时，PDF 会上传至 MinerU 云端；Markdown、文献索引和向量保存在本机。未配置有效 Key 前，条目会等待凭据，不会悄悄跳过。</span></div>
      <form id="key-form"><label><span>MinerU API Key <span class="help-tip" tabindex="0" aria-label="如何获取 MinerU Key" title="登录 MinerU，在 API Key 管理页面创建 Token。MinerU Key 通常有效 90 天；请填写生成日期以显示预计到期日。">ⓘ<span class="tooltip">登录 MinerU 后在 API Key 管理页面创建 Token。Key 通常有效 90 天；填写生成日期可显示预计到期时间。API 返回过期时任务会暂停并明确提示。</span></span></span><input id="mineru-key" type="password" autocomplete="off" placeholder="${badge.state === 'missing' ? '粘贴 MinerU Key' : '已保存；粘贴新 Key 可替换'}"/></label>
      <div class="field-pair"><label>Key 生成日期<input id="issued-at" type="date" value="${text(badge.issuedAt)}"/></label><label>预计到期日期<input id="expires-at" type="date" value="${text(badge.expiresAt)}"/></label></div>
      <div class="status-line">${icon('calendar-clock', 15)}${badge.expiresAt ? `预计 ${text(badge.expiresAt)} 到期 · 剩余 ${badge.daysRemaining} 天` : '有效期未知'}<span>${badge.checkedAt ? '上次验证 ' + text(new Date(badge.checkedAt).toLocaleString('zh-CN')) : '等待首次 API 验证'}</span></div>
      <div class="form-actions"><button type="submit" class="primary">${icon('save')}安全保存 Key</button>${button('clear-key', 'trash-2', '清除 Key')}<a href="https://mineru.net/apiManage/token" target="_blank" rel="noreferrer">打开 MinerU Key 管理 ${icon('external-link', 14)}</a></div></form>
      <div class="setting-row"><div><strong>新条目自动加入知识库</strong><span>启用后，新加入 Zotero 的条目会自动排队解析</span></div><input id="auto-index" type="checkbox" role="switch" ${settings.autoIndex ? 'checked="checked"' : ''}/></div>
      <div class="setting-row"><div><strong>OCR 扫描件</strong><span>交由 MinerU 识别扫描版 PDF；文字型 PDF 也可保留启用</span></div><input id="ocr" type="checkbox" role="switch" ${settings.ocr ? 'checked="checked"' : ''}/></div></section>
      <section class="setup-card"><div class="section-title">${icon('hard-drive')}<h2>本机空间占用</h2><span class="badge">每分钟更新</span></div>
        <div class="storage-usage"><div><span>总计</span><strong>${text(status.storage?.formatted?.total || '统计中')}</strong></div><div><span>解析缓存（含图片）</span><strong>${text(status.storage?.formatted?.documents || '统计中')}</strong></div><div><span>向量模型</span><strong>${text(status.storage?.formatted?.models || '统计中')}</strong></div><div><span>数据库与索引</span><strong>${text(status.storage?.formatted?.database || '统计中')}</strong></div></div>
        <p class="small-note">图片保留在本机解析缓存中；MinerU 原始 result.zip 已清理，重启升级时也会清理旧版本留下的压缩包。删除解析缓存图片不会影响文献文本、检索索引或向量。</p></section>`;
  } else if (settingsPane === 'embedding') {
    const check = status.model, checkOK = check.checkedAt && check.dimension;
    content = `<section class="setup-card"><div class="section-title">${icon('cpu')}<h2>选择向量模型</h2><span class="badge ${checkOK ? 'ready' : 'warning'}">${checkOK ? `已验证 · ${check.dimension} 维` : settings.embeddingProvider === 'api' && status.embedding_credentials.state === 'missing' ? '未配置 API Key' : '尚未测试模型'}</span></div>
      <div class="setting-row provider-choice"><label class="choice"><input type="radio" name="embedding-provider" value="local" ${settings.embeddingProvider === 'local' ? 'checked="checked"' : ''}/><span><strong>本地模型</strong><small>Embedding 在这台电脑执行，PDF/文本不发送给向量 API。首次需要下载模型。</small></span></label><label class="choice"><input type="radio" name="embedding-provider" value="api" ${settings.embeddingProvider === 'api' ? 'checked="checked"' : ''}/><span><strong>兼容 OpenAI 的 Embeddings API</strong><small>不用下载本地模型；摘要和文本片段会发送给你配置的 API 服务。</small></span></label></div>
      ${settings.embeddingProvider === 'local' ? `<label>本地模型<select id="model"><option value="qwen" ${settings.model === 'qwen' ? 'selected="selected"' : ''}>Qwen3-Embedding-0.6B · 量化 · 1024 维</option><option value="e5" ${settings.model === 'e5' ? 'selected="selected"' : ''}>Multilingual E5-small · 轻量 · 384 维</option></select></label>
        <label>下载源<select id="model-source"><option value="modelscope" ${settings.modelSource === 'modelscope' ? 'selected="selected"' : ''}>ModelScope · 国内推荐</option><option value="hf-mirror" ${settings.modelSource === 'hf-mirror' ? 'selected="selected"' : ''}>hf-mirror.com · Hugging Face 镜像</option><option value="huggingface" ${settings.modelSource === 'huggingface' ? 'selected="selected"' : ''}>Hugging Face 官方 · 可能需要代理</option></select></label>
        <div class="info-callout"><strong>你不需要手动下载或管理模型文件</strong><span>点击下方测试会自动下载并运行所选模型；首次下载时间取决于网络和模型大小。下载源可随时切换。</span></div>` : `<label>API Base URL<input id="embedding-api-url" type="url" value="${text(settings.embeddingApiBaseUrl)}" placeholder="https://api.example.com/v1"/></label><label>模型名称<input id="embedding-api-model" value="${text(settings.embeddingApiModel)}" placeholder="text-embedding-3-small"/></label><form id="embedding-key-form"><label>API Key<input id="embedding-api-key" type="password" autocomplete="off" placeholder="${status.embedding_credentials.state === 'configured' ? '已安全保存；输入新 Key 可替换' : '输入 API Key'}"/></label><div class="form-actions"><button class="primary" type="submit">${icon('save')}安全保存 API Key</button>${button('clear-embedding-key', 'trash-2', '清除 API Key')}</div></form><div class="small-note">API Key 存在 Zotero 的系统凭据存储，不会写入文献库或安装包。测试模型会调用一次 API。</div>`}
      <div class="setting-row"><div><strong>对新入库内容生成向量</strong><span>关闭后仍可按书目和关键词检索</span></div><input id="embeddings-enabled" type="checkbox" role="switch" ${settings.embeddingsEnabled ? 'checked="checked"' : ''}/></div>
      <div class="form-actions">${button('test-embedding', 'circle-check', settings.embeddingProvider === 'local' ? '测试并准备模型' : '测试 API 连接', true)}${settings.embeddingProvider === 'local' && check.progress ? `<span>${text(check.progress.file || '')} ${Math.round(check.progress.progress || 0)}%</span>` : ''}</div>
      <div id="embedding-state" class="model-result ${checkOK ? 'success' : ''}">${checkOK ? `测试通过：${text(check.model)} · ${check.dimension} 维 · ${text(new Date(check.checkedAt).toLocaleString('zh-CN'))}` : text(check.message || (settings.embeddingProvider === 'local' ? '尚未下载或验证当前模型。' : '保存 API Key 后，点击“测试 API 连接”。'))}</div>
      ${checkOK && check.fingerprint !== undefined && check.provider !== settings.embeddingProvider ? '<div class="small-note">模型配置已变更，测试状态会在重新测试后更新。旧向量需用“更新索引”重建。</div>' : ''}</section>`;
  } else {
    const targets = status.agents || {};
    content = `<section class="setup-card"><div class="section-title">${icon('plug-zap')}<h2>将知识库连接到你的 Agent</h2><span class="badge ${settings.mcpEnabled ? 'ready' : ''}">${settings.mcpEnabled ? 'MCP 已启用' : 'MCP 未启用'}</span></div>
      <div class="info-callout"><strong>一台电脑只需配一次</strong><span>插件直接写入 Codex / Claude Code 的用户级 MCP 配置；令牌保存在本机配置文件。完成后重启对应 Agent。Zotero 需要保持运行。</span></div>
      <div class="agent-list"><article class="agent-card"><div><strong>Codex</strong><span>${targets.codex?.configured ? '已配置' : '尚未配置'} · ${text(targets.codex?.path || '')}</span></div><button id="install-codex" class="primary">${targets.codex?.configured ? '更新 Codex 配置' : '一键配置 Codex'}</button></article>
      <article class="agent-card"><div><strong>Claude Code</strong><span>${targets.claudeCode?.configured ? '已配置' : '尚未配置'} · ${text(targets.claudeCode?.path || '')}</span></div><button id="install-claude" class="primary">${targets.claudeCode?.configured ? '更新 Claude Code 配置' : '一键配置 Claude Code'}</button></article></div>
      <div class="form-actions">${button('copy-config', 'copy', '复制通用 MCP JSON 配置', true)}${button('rotate-token', 'refresh-cw', '重置本地访问令牌')}</div>
      <div class="small-note">将复制标准 <code>mcpServers</code> JSON 配置，适用于支持 HTTP MCP 与 Bearer Authorization Header 的客户端（包括 DeepSeek Harness）。在目标客户端的 MCP 设置中粘贴；若客户端采用其他格式，可照着服务地址和请求头手动填写。完成后重启 Agent。</div>
      <label>服务地址<input readonly="readonly" value="${text(status.endpoint)}"/></label>
      <details class="security-details"><summary>本机令牌与权限说明</summary><p>令牌仅访问本机 Zotero 文库 MCP，包括搜索、读取、入库和引用工具。重置令牌后，所有 Agent 配置都需重新更新。连接配置含 Bearer Token，请勿公开分享。</p></details></section>`;
  }
  setMarkup(byId('view'), `<div class="settings-layout">${heading}${content}<div class="setup-footer"><span>MinerU 云解析 ${badge.state === 'missing' ? '待配置' : labels[badge.state]}</span><span>${checkStatusLabel(status)}</span></div></div>`);
  for (const [id, value] of Object.entries(settingDrafts)) if (byId(id)) byId(id).value = value;
  if (focusID && byId(focusID)) {
    byId(focusID).focus();
    if (cursor !== null && cursor !== undefined) try { byId(focusID).setSelectionRange(cursor, cursor); } catch {}
  }
  document.querySelectorAll('[data-settings-pane]').forEach(el => el.addEventListener('click', () => {
    rememberSettings(); settingsPane = el.getAttribute('data-settings-pane')!; renderSettings(); createIcons({ icons });
  }));
  if (settingsPane === 'processing') {
    byId('key-form').onsubmit = (event: Event) => { event.preventDefault(); action(async () => {
      const field = byId('mineru-key');
      await bridge.saveCredentials({ key: field.value, issuedAt: byId('issued-at').value, expiresAt: byId('expires-at').value });
      field.value = ''; clearSettingDrafts('mineru-key', 'issued-at', 'expires-at'); await refresh(); return 'MinerU Key 已安全保存；首次 API 请求会验证有效性';
    }); };
    byId('clear-key').onclick = () => action(async () => { const fields = ['mineru-key', 'issued-at', 'expires-at'].map(byId); await bridge.saveCredentials({ clear: true }); fields.forEach(field => { field.value = ''; }); clearSettingDrafts('mineru-key', 'issued-at', 'expires-at'); await refresh(); return 'MinerU Key 已清除'; });
    for (const [id, key] of [['auto-index', 'autoIndex'], ['ocr', 'ocr']]) byId(id).onchange = () => action(async () => { await bridge.saveSettings({ [key]: byId(id).checked }); });
  }
  if (settingsPane === 'embedding') {
    document.querySelectorAll('[name="embedding-provider"]').forEach(el => el.addEventListener('change', () => action(async () => {
      rememberSettings(); await bridge.saveSettings({ embeddingProvider: (el as HTMLInputElement).value }); await refresh();
    })));
    if (byId('model')) byId('model').onchange = () => action(async () => { await bridge.saveSettings({ model: byId('model').value }); await refresh(); });
    if (byId('model-source')) byId('model-source').onchange = () => action(async () => { await bridge.saveSettings({ modelSource: byId('model-source').value }); await refresh(); });
    byId('embeddings-enabled').onchange = () => action(async () => { await bridge.saveSettings({ embeddingsEnabled: byId('embeddings-enabled').checked }); });
    if (byId('embedding-key-form')) byId('embedding-key-form').onsubmit = (event: Event) => { event.preventDefault(); action(async () => {
      const field = byId('embedding-api-key'), key = field.value;
      await bridge.saveSettings({ embeddingApiBaseUrl: byId('embedding-api-url').value, embeddingApiModel: byId('embedding-api-model').value });
      await bridge.saveEmbeddingCredentials({ key }); field.value = '';
      clearSettingDrafts('embedding-api-key'); await refresh(); return '向量 API 配置已保存，Key 保存在本机凭据存储';
    }); };
    if (byId('clear-embedding-key')) byId('clear-embedding-key').onclick = () => action(async () => {
      const field = byId('embedding-api-key');
      await bridge.saveEmbeddingCredentials({ clear: true }); field.value = ''; clearSettingDrafts('embedding-api-key'); await refresh(); return '向量 API Key 已清除';
    });
    byId('test-embedding').onclick = () => action(async () => {
      const resultNode = byId('embedding-state'), field = byId('embedding-api-key');
      const key = field?.value.trim();
      if (settings.embeddingProvider === 'api') {
        await bridge.saveSettings({ embeddingApiBaseUrl: byId('embedding-api-url').value, embeddingApiModel: byId('embedding-api-model').value });
        if (key) { await bridge.saveEmbeddingCredentials({ key }); field.value = ''; clearSettingDrafts('embedding-api-key'); }
      }
      resultNode.textContent = settings.embeddingProvider === 'local' ? '正在准备和测试本地模型…' : '正在请求向量 API…';
      const result = await bridge.testEmbeddingModel(); await refresh();
      return `模型测试通过：${result.dimension} 维`;
    });
  }
  if (settingsPane === 'agents') {
    const install = (target: string) => action(async () => {
      await bridge.saveSettings({ mcpEnabled: true });
      const result = await bridge.installAgent(target); await refresh();
      return `${target === 'codex' ? 'Codex' : 'Claude Code'} MCP 配置已写入。请重启 Agent${result.backup ? `；配置备份：${result.backup}` : '；已新建配置文件'}`;
    });
    byId('install-codex').onclick = () => install('codex');
    byId('install-claude').onclick = () => install('claude-code');
    byId('copy-config').onclick = () => action(async () => {
      await bridge.saveSettings({ mcpEnabled: true });
      const config = await bridge.connectionConfig();
      const payload = JSON.stringify(config, null, 2);
      if (bridge.copyText) bridge.copyText(payload); else await navigator.clipboard.writeText(payload);
      await refresh(); return '通用 MCP JSON 配置已复制；粘贴到 Agent 的 MCP 设置中，并重启 Agent';
    });
    byId('rotate-token').onclick = () => action(async () => {
      if (!confirm('重置后已配置的所有 Agent 将暂时无法连接，必须逐个更新配置。继续重置？')) return;
      await bridge.rotateToken(); await refresh(); return '本地访问令牌已重置；请更新每个 Agent 的连接配置';
    });
  }
}

function checkStatusLabel(value: any) {
  if (value.settings.embeddingProvider === 'api') return value.embedding_credentials.state === 'configured' ? '向量 API Key 已保存' : '向量 API Key 待配置';
  if (value.model.dimension) return `向量模型已测试 · ${value.model.dimension} 维`;
  return value.model.progress ? `模型下载中 · ${Math.round(value.model.progress.progress || 0)}%` : '向量模型待测试';
}
async function init() {
  const args = window.arguments?.[0];
  if (args?.library) {
    const lib = args.library;
    bridge = {
      status: () => lib.status(), list: () => lib.list(), enqueueSelected: () => lib.enqueueSelected(),
      workspace: (a: any) => lib.workspace(a), search: (a: any) => lib.search(a), read: (a: any) => lib.read(a), resume: (id?: string | string[]) => lib.resume('manual', id),
      deleteJobs: (ids: string[]) => lib.deleteJobs(ids), clearCompletedJobs: () => lib.clearCompletedJobs(),
      saveSettings: (a: any) => lib.saveSettings(a), saveCredentials: async (a: any) => { await lib.credentials.save(a); if (!a.clear) await lib.resume('credentials'); },
      saveEmbeddingCredentials: (a: any) => lib.embeddingCredentials.save(a),
      reindex: async (id: string, force = true) => { const doc = await lib.store.document(id); return lib.enqueueItem(await lib.resolve(doc.libraryID, doc.itemKey), force); },
      remove: (id: string) => lib.store.removeDocument(id),
      testEmbeddingModel: async () => { const result = await lib.testEmbeddingModel(); await lib.resume('model'); return result; },
      testCredentials: async () => {
        const jobs = await lib.store.jobs(); const job = jobs.find((j: any) => j.batchID);
        if (!job) return { message: '暂无可用于只读验证的 MinerU 任务；下一次解析请求将确认 Key 状态。' };
        await lib.credentials.allowRecheck(); await lib.mineru.poll(job.batchID, job.dataID);
        await lib.resume('credentials'); return { message: 'MinerU 鉴权成功' };
      },
      connectionConfig: async () => ({ mcpServers: { zotero_literature_library: { type: 'http', url: (await lib.status()).endpoint,
        headers: { Authorization: `Bearer ${await lib.store.get('mcpToken', '')}` } } } }),
      installAgent: (target: any) => lib.agentInstaller.install(target),
      rotateToken: () => lib.store.set('mcpToken', crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '')),
      copyText: (value: string) => (window.opener?.Zotero || window.Zotero).Utilities.Internal.copyTextToClipboard(value)
    };
  } else {
    const response = await fetch('/preview-data.json');
    const fixture = await response.json();
    bridge = (await import('./preview-bridge')).previewBridge(fixture);
  }
  layout(); await refresh();
  window.addEventListener('literature-library-change', () => {
    clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 500);
  });
  window.addEventListener('unload', () => clearTimeout(refreshTimer));
}
init().catch(error => { app.textContent = `无法打开管理器：${error.message}`; });
