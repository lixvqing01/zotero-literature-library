import { AppError } from './core';
import type { Library } from './library';

export class CitationBridge {
  private pending: { id: string; items: any[]; titles: string[]; expiresAt: number } | null = null;
  private last: any = { state: 'idle' };
  private original: any;
  private wrapper: any;
  constructor(private library: Library) {}
  install() {
    this.original = Zotero.Integration.displayDialog;
    const bridge = this;
    this.wrapper = function (this: any, url: string, options: any, io: any, type: string) {
      const pending = bridge.pending;
      if (pending && Date.now() < pending.expiresAt && type === 'citation'
          && url === 'chrome://zotero/content/integration/citationDialog.xhtml'
          && io?.citation && !io.isCitingNotes && !io.isAddingAnnotations && !io.citation.citationItems.length) {
        io.citation.citationItems = pending.items.map(item => ({ ...item }));
        bridge.pending = null;
        bridge.last = { state: 'awaiting_native_confirmation', request_id: pending.id, titles: pending.titles };
        bridge.library.changed();
        // Accepting the native dialog is not proof that the word processor saved a field.
        io.promise.then(() => {
          bridge.last = { ...bridge.last, state: io.citation.citationItems.length ? 'native_dialog_accepted' : 'cancelled',
            note: '请在 Word/WPS 中使用 Zotero Refresh 确认字段可更新。' };
          bridge.library.changed();
        }).catch(() => {});
      }
      return bridge.original.apply(this, [url, options, io, type]);
    };
    Zotero.Integration.displayDialog = this.wrapper;
  }
  status() {
    if (this.pending && Date.now() >= this.pending.expiresAt) {
      this.last = { state: 'expired', request_id: this.pending.id }; this.pending = null;
    }
    return this.pending ? { state: 'prepared', request_id: this.pending.id, titles: this.pending.titles,
      expires_at: new Date(this.pending.expiresAt).toISOString(), inserted: false,
      next_action: '在 Word/WPS 将光标放到新的引用位置，点击 Zotero → Add/Edit Citation，在预选引用窗口确认。文档格式由 Zotero Document Preferences 管理。' } : this.last;
  }
  async prepare(input: any) {
    if (!Array.isArray(input.document_ids) || !input.document_ids.length || input.document_ids.length > 100)
      throw new Error('请选择 1–100 个 document_id。');
    if (Zotero.Integration.currentDoc) throw new AppError({ code: 'CITATION_BUSY', message: '请先完成当前 Zotero 引用操作。', retryable: false });
    if (this.pending && Date.now() < this.pending.expiresAt) throw new AppError({ code: 'CITATION_PENDING', message: '已有待确认引用，请先完成或取消。', retryable: false });
    const items: any[] = [], titles: string[] = [], seen = new Set<number>();
    for (const id of input.document_ids) {
      const doc = await this.library.store.document(String(id));
      if (!doc) throw Error('引用文献未入库。');
      const item = await this.library.resolve(doc.libraryID, doc.itemKey);
      if (!item.isRegularItem()) throw Error('附件不能作为独立引用，请选择有书目信息的父条目。');
      if (seen.has(item.id)) continue;
      seen.add(item.id); items.push({ id: item.id }); titles.push(doc.title);
    }
    this.pending = { id: Services.uuid.generateUUID().toString(), items, titles, expiresAt: Date.now() + 10 * 60000 };
    this.library.changed(); return this.status();
  }
  cancel() { this.pending = null; this.last = { state: 'cancelled' }; this.library.changed(); return this.last; }
  close() { if (Zotero.Integration.displayDialog === this.wrapper) Zotero.Integration.displayDialog = this.original; this.pending = null; }
}
