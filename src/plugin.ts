import { Library } from './library';
import { VERSION } from './version';
import { registerEndpoints } from './agent';
import { publicError } from './core';
import { registerManagerLink } from './addon-manager';
let library: Library;
let unregister: (() => void) | undefined;
let unregisterManagerLink: (() => void) | undefined;
let observer: string;
let paneID: string;
let windowObserver: any;
let manager: any;
let notifyTimer: any;
const affected = new Set<number>();
const windows = new Map<any, Element[]>();
let pluginID = '';
let statusColumn: string;
let columnTimer: any;
let columnStatus = new Map<string, string>();
const stateLabels: Record<string, string> = { ready: '已入库', metadata: '书目已存', stale: '待更新', queued: '排队中',
  waiting_file: '等待 PDF', submitting: '提交解析', uploading: '上传中', confirming_upload: '等待上传确认', pending: '云端排队', running: '解析中',
  converting: '转换中', download: '下载结果', embedding: '向量化', retry: '稍后重试',
  blocked_credentials: '等待有效 Key', blocked_cloud: '等待启用上传', blocked_model: '等待模型', failed: '失败' };

function mainWindow() { return Zotero.getMainWindow(); }
function report(error: unknown) {
  const detail = publicError(error);
  Zotero.debug(`[Literature Library] ${detail.code}: ${detail.message}`);
  try { Services.prompt.alert(mainWindow(), 'Literature Library', detail.message); } catch {}
}
export async function start({ id, rootURI }: any) {
  await Zotero.initializationPromise;
  await Zotero.uiReadyPromise;
  pluginID = id;
  const win = mainWindow();
  const profile = PathUtils.profileDir || Services.dirsvc.get('ProfD', Ci.nsIFile).path;
  library = new Library(PathUtils.join(profile, 'literature-library'), win);
  await library.init();
  (Zotero as any).LiteratureLibrary = { library, openManager, version: VERSION };
  unregister = registerEndpoints(library);
  unregisterManagerLink = registerManagerLink(id, openManager);
  statusColumn = Zotero.ItemTreeManager.registerColumn({ pluginID: id, dataKey: 'literatureLibrary', label: '知识库',
    enabledTreeIDs: ['main'], width: '100', showInColumnPicker: true,
    dataProvider: (item: any) => columnStatus.get(`${item.libraryID}:${item.key}`) || '' });
  paneID = await Zotero.PreferencePanes.register({ pluginID: id,
    src: rootURI + 'content/preferences.xhtml', label: 'Literature Library',
    scripts: [rootURI + 'content/preferences.js'],
    image: rootURI + 'content/icon.svg' });
  observer = Zotero.Notifier.registerObserver({ notify(event: string, type: string, ids: number[]) {
    if (type !== 'item' || !['add', 'modify', 'trash', 'delete', 'refresh'].includes(event)) return;
    ids.forEach(id => affected.add(id));
    if (notifyTimer) win.clearTimeout(notifyTimer);
    notifyTimer = win.setTimeout(() => {
      const ids = [...affected]; affected.clear();
      library.reconcile(ids).catch(e => Zotero.debug(publicError(e).message));
    }, 3000);
  } }, ['item'], 'literature-library');
  for (const w of Zotero.getMainWindows()) attachWindow(w);
  windowObserver = { observe(subject: any, topic: string) {
    if (topic === 'domwindowopened') subject.addEventListener('load', () => {
      if (subject.ZoteroPane) attachWindow(subject);
    }, { once: true });
  } };
  Services.ww.registerNotification(windowObserver);
  library.onChange(() => {
    if (manager && !manager.closed) manager.dispatchEvent(new manager.CustomEvent('literature-library-change'));
    if (columnTimer) win.clearTimeout(columnTimer);
    columnTimer = win.setTimeout(async () => {
      const docs = await library.list();
      columnStatus = new Map(docs.flatMap(doc => {
        const label = stateLabels[doc.taskState || doc.state] || doc.state;
        return [[`${doc.libraryID}:${doc.itemKey}`, label],
          ...(doc.attachmentKey ? [[`${doc.libraryID}:${doc.attachmentKey}`, label]] : [])] as [string, string][];
      }));
      for (const w of Zotero.getMainWindows()) w.ZoteroPane?.itemsView?.tree?.invalidate?.();
    }, 800);
  });
  library.reconcile().catch(() => {});
}
function attachWindow(win: any) {
  if (windows.has(win)) return;
  const doc = win.document, elements: Element[] = [];
  const create = (id: string, label: string, parent: string, action: () => void) => {
    const container = doc.getElementById(parent); if (!container) return;
    const item = doc.createXULElement('menuitem'); item.id = id; item.setAttribute('label', label);
    item.addEventListener('command', action); container.append(item); elements.push(item);
  };
  create('literature-library-tools', 'Literature Library…', 'menu_ToolsPopup', openManager);
  create('literature-library-add', '加入 Literature Library', 'zotero-itemmenu', () => library.enqueueSelected().catch(report));
  create('literature-library-rebuild', '重建 Literature Library 索引', 'zotero-itemmenu', () => library.enqueueSelected(true).catch(report));
  create('literature-library-manage', '查看知识库', 'zotero-itemmenu', openManager);
  windows.set(win, elements);
}
export function openManager() {
  if (manager && !manager.closed) { manager.focus(); return; }
  manager = mainWindow().openDialog('chrome://literature-library/content/manager.xhtml',
    'literature-library-manager', 'chrome,centerscreen,resizable,width=1180,height=800', { library });
}
export async function stop() {
  if (columnTimer) mainWindow()?.clearTimeout(columnTimer);
  if (statusColumn) Zotero.ItemTreeManager.unregisterColumn(statusColumn);
  if (notifyTimer) mainWindow()?.clearTimeout(notifyTimer);
  if (observer) Zotero.Notifier.unregisterObserver(observer);
  if (windowObserver) Services.ww.unregisterNotification(windowObserver);
  for (const elements of windows.values()) for (const element of elements) element.remove();
  windows.clear(); unregister?.();
  unregisterManagerLink?.();
  if (paneID && Zotero.PreferencePanes.unregister) Zotero.PreferencePanes.unregister(paneID);
  if (manager && !manager.closed) manager.close();
  if (library) await library.stop();
  delete Zotero.LiteratureLibrary;
}
