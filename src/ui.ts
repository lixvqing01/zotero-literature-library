import { createIcons, icons } from 'lucide';
import { setMarkup } from './markup';
type Bridge = any;
const app = document.getElementById('app')!;
let bridge: Bridge;
let tab = 'library';
let status: any;
let documents: any[] = [];
let selected: string | null = null;
let selection = new Set<string>();
let selectedLayer = 'abstract';
let refreshTimer: any;
let busy = false;
const labels: Record<string, string> = { missing: '未配置', configured: '已配置 · 未验证', valid: '已验证有效',
  expired: 'Key 已过期', invalid: 'Key 无效', auth_failed: '鉴权失败', ready: '已入库', stale: '内容待更新',
  queued: '排队中', waiting_file: '等待 PDF', submitting: '提交解析', uploading: '上传中', pending: '云端排队', running: '解析中',
  converting: '转换中', download: '下载结果', embedding: '向量化', done: '完成', skipped: '已跳过',
  blocked_credentials: '等待有效 Key', blocked_cloud: '等待启用上传', blocked_model: '等待模型', failed: '失败', retry: '稍后重试', metadata: '书目已存' };
const text = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const icon = (name: string, size = 17) => `<i data-lucide="${name}" width="${size}" height="${size}"></i>`;
const button = (id: string, name: string, title: string, primary = false) => `<button id="${id}" class="${primary ? 'primary' : ''}" title="${text(title)}">${icon(name)}<span>${text(title)}</span></button>`;
function layout() {
  setMarkup(app, `<aside class="sidebar"><div class="brand">${icon('library-big', 25)}<div>Literature<span>LIBRARY</span></div></div>
    <nav><button data-tab="library">${icon('library')}文献库<span id="nav-count"></span></button><button data-tab="jobs">${icon('list-checks')}任务队列<span id="job-count"></span></button><button data-tab="settings">${icon('settings-2')}设置</button></nav>
    <div class="sidebar-bottom"><span class="status-dot"></span>Zotero 本地知识库<div id="sidebar-model">Qwen · ONNX</div></div></aside>
    <main><header><div><div class="eyebrow">RESEARCH WORKSPACE</div><h1 id="view-title">文献库</h1></div><div class="header-actions">${button('refresh', 'refresh-cw', '刷新')}${button('add-selected', 'plus', '加入 Zotero 所选条目', true)}</div></header>
    <div id="notification" role="status" hidden="hidden"></div><div id="credential-warning" hidden="hidden"></div>
    <section id="summary" class="summary"></section><div id="view"></div>
    <footer><span>MinerU 解析 · 本地向量化</span><span id="footer-state"></span></footer></main>
    <dialog id="detail-dialog"><div class="dialog-head"><h2 id="detail-title"></h2><button id="close-detail" class="icon-button" title="关闭">${icon('x')}</button></div><div class="detail-tabs"><button data-layer="metadata">书目</button><button data-layer="abstract">摘要</button><button data-layer="outline">目录</button><button data-layer="fulltext">全文</button><button data-layer="notes">笔记</button></div><div id="detail-content"></div><div class="dialog-bottom"><a id="open-zotero">在 Zotero 中打开 ${icon('arrow-up-right', 14)}</a></div></dialog>`);
  document.querySelectorAll('[data-tab]').forEach(el => el.addEventListener('click', () => { tab = el.getAttribute('data-tab')!; render(); }));
  byId('refresh').onclick = () => refresh();
  byId('add-selected').onclick = () => action(async () => {
    const jobs = await bridge.enqueueSelected(); await refresh(); return `${jobs.length} 个任务已加入队列`;
  });
  byId('close-detail').onclick = () => (byId('detail-dialog') as HTMLDialogElement).close();
  document.querySelectorAll('[data-layer]').forEach(el => el.addEventListener('click', () => { selectedLayer = el.getAttribute('data-layer')!; showDetail(); }));
}
function byId(id: string): any { return document.getElementById(id); }
function notify(message: string, error = false) {
  const node = byId('notification'); node.hidden = false; node.className = error ? 'error' : 'success'; node.textContent = message;
}
async function action(fn: () => Promise<any>) {
  try { const result = await fn(); if (typeof result === 'string') notify(result); }
  catch (error) { notify(error instanceof Error ? error.message : String(error), true); }
}
async function refresh() {
  if (busy) return;
  busy = true;
  try { [status, documents] = await Promise.all([bridge.status(), bridge.list()]); render(); }
  catch (error) { notify(error instanceof Error ? error.message : String(error), true); }
  finally { busy = false; }
}
function render() {
  if (!status) return;
  document.querySelectorAll('[data-tab]').forEach(el => el.classList.toggle('active', el.getAttribute('data-tab') === tab));
  byId('view-title').textContent = { library: '文献库', jobs: '任务队列', settings: '设置' }[tab];
  byId('nav-count').textContent = documents.length;
  const waiting = status.queue.filter((j: any) => !['done', 'skipped'].includes(j.state)).length;
  byId('job-count').textContent = waiting || '';
  byId('sidebar-model').textContent = `${status.settings.model === 'qwen' ? 'Qwen3 0.6B' : 'E5-small'} · ${status.model.state}`;
  byId('footer-state').textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
  const cred = status.credentials;
  const warning = ['expired', 'invalid', 'auth_failed'].includes(cred.state) || typeof cred.daysRemaining === 'number' && cred.daysRemaining <= 7;
  byId('credential-warning').hidden = !warning;
  setMarkup(byId('credential-warning'), `${icon('key-round')}<span>${text(['expired', 'invalid', 'auth_failed'].includes(cred.state) ? labels[cred.state]
    : cred.daysRemaining <= 0 ? 'MinerU Key 预计已到期，实际调用时验证' : `MinerU Key 预计 ${cred.daysRemaining} 天后到期`)} · ${waiting} 个任务待处理</span><button id="fix-key">更新 Key ${icon('arrow-right', 14)}</button>`);
  if (warning) byId('fix-key').onclick = () => { tab = 'settings'; render(); };
  const cov = status.coverage;
  byId('summary').hidden = tab === 'settings';
  setMarkup(byId('summary'), [
    ['library', '文献条目', cov.documents], ['file-text', '摘要', cov.abstracts],
    ['file-check-2', '全文已提取', cov.fulltext], ['network', '当前模型已索引', cov.vectors]
  ].map(([symbol, label, value]) => `<div class="metric">${icon(String(symbol), 19)}<div><span>${label}</span><strong>${value}</strong></div><div class="coverage"><b style="width:${cov.documents ? Number(value) / cov.documents * 100 : 0}%"></b></div></div>`).join(''));
  if (tab === 'library') renderLibrary(); else if (tab === 'jobs') renderJobs(); else renderSettings();
  createIcons({ icons, attrs: { 'stroke-width': 1.7 } });
}
function renderLibrary() {
  const view = byId('view');
  const oldQuery = byId('search-query')?.value || '';
  setMarkup(view, `<div class="toolbar"><form id="search-form"><div class="search-input">${icon('search')}<input id="search-query" placeholder="搜索标题、作者、关键词或正文…" value="${text(oldQuery)}"/></div><select id="search-layer" aria-label="检索层"><option value="auto">所有层级</option><option value="metadata">书目</option><option value="abstract">摘要</option><option value="fulltext">全文</option></select><select id="search-mode" aria-label="检索模式"><option value="keyword">关键词</option><option value="hybrid">混合检索</option><option value="semantic">向量检索</option></select><button type="submit" class="icon-button" title="搜索">${icon('arrow-right')}</button></form><div class="selection-actions">${button('reindex-selected', 'rotate-cw', '重建')}${button('remove-selected', 'trash-2', '移除')}</div></div>
    <div class="table-wrap"><table><thead><tr><th class="check-col"><input id="select-all" type="checkbox" aria-label="全选"/></th><th>文献</th><th class="year-col">年份</th><th>覆盖层级</th><th>状态</th><th class="end-col"></th></tr></thead><tbody id="document-rows"></tbody></table></div><div id="library-empty" class="empty" ${documents.length ? 'hidden="hidden"' : ''}>${icon('library', 40)}<h2>文献库为空</h2><button id="empty-add" class="primary">${icon('plus')}加入 Zotero 所选条目</button></div><div id="search-notice" class="small-note"></div>`);
  fillRows(documents);
  byId('select-all').onchange = (event: any) => { selection = event.target.checked ? new Set(documents.map(d => d.id)) : new Set(); fillRows(documents); };
  byId('empty-add')?.addEventListener('click', () => byId('add-selected').click());
  byId('reindex-selected').onclick = () => action(async () => {
    for (const id of selection) await bridge.reindex(id); await refresh(); return '已加入重建队列';
  });
  byId('remove-selected').onclick = () => action(async () => {
    if (!selection.size) return '请先选择文献';
    if (!confirm(`从派生知识库移除 ${selection.size} 篇文献？Zotero 原条目和 PDF 会保留。`)) return;
    for (const id of selection) await bridge.remove(id); selection.clear(); await refresh(); return '已移除派生索引';
  });
  byId('search-form').onsubmit = (event: Event) => {
    event.preventDefault(); action(async () => {
      const query = byId('search-query').value;
      if (!query.trim()) { fillRows(documents); return; }
      const response = await bridge.search({ query, layer: byId('search-layer').value, mode: byId('search-mode').value, top_k: 50 });
      fillRows(response.results.map((hit: any) => ({ ...documents.find(d => d.id === hit.document_id), hit })));
      byId('search-notice').textContent = `${response.results.length} 个结果${response.warning ? ' · 向量不可用，已使用关键词：' + response.warning.message : ''}`;
    });
  };
}
function fillRows(rows: any[]) {
  setMarkup(byId('document-rows'), rows.map(doc => `<tr data-id="${text(doc.id)}"><td><input class="row-check" type="checkbox" aria-label="选择 ${text(doc.title)}" ${selection.has(doc.id) ? 'checked="checked"' : ''}/></td><td><button class="title-button">${text(doc.title)}</button><div class="authors">${text(doc.creators || '作者未知')}<span>${text(doc.publication)}</span></div>${doc.hit ? `<div class="snippet">${text(doc.hit.snippet)}</div>` : ''}</td><td class="year-col">${text(doc.year || '—')}</td><td><div class="layers"><span class="available">书目</span><span class="${doc.abstract ? 'available' : ''}">摘要</span><span class="${doc.hasFulltext ? 'available' : ''}">全文</span><span class="${doc.modelFingerprint ? 'available' : ''}">向量</span></div></td><td><span class="badge ${doc.error ? 'warning' : doc.state === 'ready' ? 'ready' : ''}">${text(labels[doc.state] || doc.state)}</span>${doc.error ? `<div class="row-error">${text(doc.error.message)}</div>` : ''}</td><td><a href="zotero://select/${text(doc.libraryKey)}/items/${text(doc.itemKey)}" title="在 Zotero 中打开" class="icon-button">${icon('arrow-up-right')}</a></td></tr>`).join(''));
  document.querySelectorAll('tr[data-id]').forEach(row => {
    const id = row.getAttribute('data-id')!;
    row.querySelector('.title-button')!.addEventListener('click', () => { selected = id; showDetail(); });
    row.querySelector('.row-check')!.addEventListener('change', (event: any) => { event.target.checked ? selection.add(id) : selection.delete(id); });
  });
  createIcons({ icons });
}
async function showDetail() {
  await action(async () => {
    const data = await bridge.read({ document_id: selected, layer: selectedLayer, max_chars: 60000 });
    byId('detail-title').textContent = data.title;
    byId('open-zotero').href = data.link;
    document.querySelectorAll('[data-layer]').forEach(el => el.classList.toggle('active', el.getAttribute('data-layer') === selectedLayer));
    setMarkup(byId('detail-content'), selectedLayer === 'outline'
      ? (data.sections || []).map((s: any) => `<button class="section-link" data-section="${text(s.id)}"><span>${text(s.heading)}</span><span>${s.page ? `PDF ${s.page}` : '页码未知'}</span></button>`).join('')
      : `<pre>${text(data.text || (data.metadata ? JSON.stringify(data.metadata, null, 2) : data.notes ? JSON.stringify(data.notes, null, 2) : '此层内容尚未提取'))}</pre>${data.truncated ? '<div class="small-note">结果已截断，可通过 MCP 分页读取。</div>' : ''}`);
    document.querySelectorAll('[data-section]').forEach(el => el.addEventListener('click', () => action(async () => {
      const section = await bridge.read({ document_id: selected, layer: 'fulltext', section_id: el.getAttribute('data-section'), max_chars: 60000 });
      setMarkup(byId('detail-content'), `<pre>${text(section.text)}</pre>`);
    })));
    const dialog = byId('detail-dialog') as HTMLDialogElement;
    if (!dialog.open) dialog.showModal();
  });
}
function renderJobs() {
  setMarkup(byId('view'), `<div class="section-toolbar"><h2>解析与入库任务 <span>${status.queue.length}</span></h2>${button('resume-jobs', 'play', '恢复 / 重试')}</div><div class="table-wrap"><table><thead><tr><th>文献</th><th>阶段</th><th>进度</th><th>详情</th></tr></thead><tbody>${status.queue.map((job: any) => `<tr><td>${text(documents.find(d => d.id === job.documentID)?.title || job.documentID)}</td><td><span class="badge ${job.error ? 'warning' : ''}">${text(labels[job.state] || job.state)}</span></td><td>${job.progress?.embedded !== undefined ? `${job.progress.embedded} / ${job.progress.total} 块` : job.progress?.extracted_pages !== undefined ? `${job.progress.extracted_pages} / ${job.progress.total_pages} 页` : '—'}</td><td class="job-error">${text(job.error?.message || '')}</td></tr>`).join('')}</tbody></table></div>`);
  byId('resume-jobs').onclick = () => action(async () => { await bridge.resume(); await refresh(); return '可恢复任务已重新排队'; });
}
function renderSettings() {
  // Keep a user-entered secret only in the form until it is submitted; never refresh it from storage.
  if (byId('mineru-key') && (byId('mineru-key').value || document.activeElement?.closest('#view'))) {
    if (byId('model-progress')) byId('model-progress').textContent = status.model.progress
      ? `${status.model.progress.file || ''} ${Math.round(status.model.progress.progress || 0)}%` : status.model.message || '';
    return;
  }
  const cred = status.credentials, settings = status.settings;
  setMarkup(byId('view'), `<div class="settings-layout"><section class="settings-section"><div class="section-title">${icon('key-round')}<h2>MinerU</h2><span class="badge ${['expired', 'invalid', 'auth_failed'].includes(cred.state) ? 'warning' : ''}">${text(labels[cred.state])}</span></div>
    <form id="key-form"><label>API Key<input id="mineru-key" type="password" autocomplete="off" placeholder="${cred.state === 'missing' ? '输入 MinerU Key' : '已保存；输入新 Key 以替换'}"/></label><div class="field-pair"><label>生成日期<input id="issued-at" type="date" value="${text(cred.issuedAt)}"/></label><label>预计到期日期<input id="expires-at" type="date" value="${text(cred.expiresAt)}"/></label></div><div class="status-line">${icon('calendar-clock', 15)}${cred.expiresAt ? `预计到期：${text(cred.expiresAt)} · 剩余 ${cred.daysRemaining} 天` : '有效期未知'}<span>${cred.checkedAt ? '上次验证 ' + text(new Date(cred.checkedAt).toLocaleString('zh-CN')) : '尚未验证'}</span></div><div class="form-actions"><button type="submit" class="primary">${icon('save')}保存 / 替换</button>${button('clear-key', 'trash-2', '清除')}${button('test-key', 'shield-check', '验证状态')}<a href="https://mineru.net/apiManage/token" target="_blank" rel="noreferrer">管理 Key ${icon('external-link', 14)}</a></div></form>
    <div class="setting-row"><div><strong>启用 MinerU 云端解析</strong><span>PDF 将上传至 MinerU，Markdown 和索引保存在本机</span></div><input id="cloud-enabled" type="checkbox" role="switch" ${settings.cloudEnabled ? 'checked="checked"' : ''}/></div><div class="setting-row"><div><strong>新加入的条目自动入库</strong></div><input id="auto-index" type="checkbox" role="switch" ${settings.autoIndex ? 'checked="checked"' : ''}/></div><div class="setting-row"><div><strong>OCR</strong></div><input id="ocr" type="checkbox" role="switch" ${settings.ocr ? 'checked="checked"' : ''}/></div></section>
    <section class="settings-section"><div class="section-title">${icon('cpu')}<h2>本地向量化</h2><span class="badge">${text(status.model.state)}</span></div><label>嵌入模型<select id="model"><option value="qwen" ${settings.model === 'qwen' ? 'selected="selected"' : ''}>Qwen3-Embedding-0.6B · Q8 · 1024 维</option><option value="e5" ${settings.model === 'e5' ? 'selected="selected"' : ''}>Multilingual E5-small · Q8 · 384 维</option></select></label><div class="setting-row"><div><strong>提取后生成向量</strong></div><input id="embeddings-enabled" type="checkbox" role="switch" ${settings.embeddingsEnabled ? 'checked="checked"' : ''}/></div><div class="form-actions">${button('load-model', 'download', '加载 / 下载模型')}</div><div id="model-progress" class="status-line">${text(status.model.progress ? `${status.model.progress.file || ''} ${Math.round(status.model.progress.progress || 0)}%` : status.model.message || '')}</div></section>
    <section class="settings-section"><div class="section-title">${icon('plug-zap')}<h2>Agent 接入</h2></div><div class="setting-row"><div><strong>启用本地 MCP / JSON API</strong></div><input id="mcp-enabled" type="checkbox" role="switch" ${settings.mcpEnabled ? 'checked="checked"' : ''}/></div><label>Streamable HTTP<input readonly="readonly" value="${text(status.endpoint)}"/></label><div class="form-actions">${button('copy-config', 'copy', '复制连接配置')}${button('rotate-token', 'refresh-cw', '重置访问令牌')}</div></section></div>`);
  byId('key-form').onsubmit = (event: Event) => { event.preventDefault(); action(async () => {
    await bridge.saveCredentials({ key: byId('mineru-key').value, issuedAt: byId('issued-at').value, expiresAt: byId('expires-at').value });
    byId('mineru-key').value = ''; (document.activeElement as HTMLElement)?.blur(); await refresh(); return '已安全保存；有效性由实际 API 响应确认';
  }); };
  byId('clear-key').onclick = () => action(async () => { await bridge.saveCredentials({ clear: true }); await refresh(); return 'MinerU Key 已清除'; });
  byId('test-key').onclick = () => action(async () => { const result = await bridge.testCredentials(); await refresh(); return result.message; });
  const switches: Record<string, string> = { 'cloud-enabled': 'cloudEnabled', 'auto-index': 'autoIndex', ocr: 'ocr', 'embeddings-enabled': 'embeddingsEnabled', 'mcp-enabled': 'mcpEnabled' };
  for (const [id, key] of Object.entries(switches)) byId(id).onchange = () => action(async () => { await bridge.saveSettings({ [key]: byId(id).checked }); });
  byId('model').onchange = () => action(async () => { await bridge.saveSettings({ model: byId('model').value }); });
  byId('load-model').onclick = () => action(async () => { await bridge.loadModel(); await refresh(); return '模型已就绪'; });
  byId('copy-config').onclick = () => action(async () => { const config = await bridge.connectionConfig();
    if (bridge.copyText) bridge.copyText(JSON.stringify(config, null, 2)); else await navigator.clipboard.writeText(JSON.stringify(config, null, 2)); return '连接配置已复制（包含本地访问令牌）'; });
  byId('rotate-token').onclick = () => action(async () => { await bridge.rotateToken(); return '本地访问令牌已重置，请更新 Agent 配置'; });
}
async function init() {
  const args = window.arguments?.[0];
  if (args?.library) {
    const lib = args.library;
    bridge = {
      status: () => lib.status(), list: () => lib.list(), enqueueSelected: () => lib.enqueueSelected(),
      search: (a: any) => lib.search(a), read: (a: any) => lib.read(a), resume: () => lib.resume(),
      saveSettings: (a: any) => lib.saveSettings(a), saveCredentials: async (a: any) => { await lib.credentials.save(a); await lib.resume(); },
      reindex: async (id: string) => { const doc = await lib.store.document(id); return lib.enqueueItem(await lib.resolve(doc.libraryID, doc.itemKey), true); },
      remove: (id: string) => lib.store.removeDocument(id),
      loadModel: () => lib.inference.embed(lib.settings.model, ['Local model readiness check']),
      testCredentials: async () => {
        const jobs = await lib.store.jobs(); const job = jobs.find((j: any) => j.batchID);
        if (!job) return { message: '暂无可用于只读验证的 MinerU 任务；下一次解析请求将确认 Key 状态。' };
        await lib.credentials.allowRecheck(); await lib.mineru.poll(job.batchID, job.dataID);
        await lib.resume(); return { message: 'MinerU 鉴权成功' };
      },
      connectionConfig: async () => ({ mcpServers: { literature: { type: 'http', url: (await lib.status()).endpoint,
        headers: { Authorization: `Bearer ${await lib.store.get('mcpToken', '')}` } } } }),
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
