// Zotero's native add-on manager has no plugin settings-link registration API.
// Add a reversible button only to this plugin's card in that privileged document.
export function registerManagerLink(pluginID: string, openManager: () => void) {
  const watched = new Map<Document, { observer: MutationObserver; buttons: Element[] }>();
  function attach(doc: Document) {
    if (!doc || watched.has(doc) || !/^(about:addons(?:[?#]|$)|chrome:\/\/mozapps\/content\/extensions\/)/.test(doc.documentURI)) return;
    const buttons: Element[] = [];
    function update() {
      const cards = Array.from(doc.querySelectorAll('addon-card')).filter((card: any) =>
        card.getAttribute('addon-id') === pluginID || card.addon?.id === pluginID);
      for (const card of cards) {
        if (card.querySelector('[data-literature-manager]')) continue;
        const button = doc.createElementNS('http://www.w3.org/1999/xhtml', 'button');
        button.setAttribute('data-literature-manager', 'true'); button.textContent = '打开知识库 / MinerU 设置';
        button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); openManager(); });
        (card.querySelector('.addon-detail-card') || card.querySelector('.card') || card).append(button);
        buttons.push(button);
      }
    }
    const Observer = doc.defaultView!.MutationObserver;
    const observer = new Observer(update); observer.observe(doc, { childList: true, subtree: true });
    watched.set(doc, { observer, buttons }); update();
    doc.defaultView?.addEventListener('unload', () => { observer.disconnect(); watched.delete(doc); }, { once: true });
  }
  const listener = { observe(doc: Document) { attach(doc); } };
  Services.obs.addObserver(listener, 'document-element-inserted');
  function scan(doc: Document) {
    attach(doc);
    for (const frame of Array.from(doc.querySelectorAll('browser,iframe'))) {
      try { const child = (frame as any).contentDocument; if (child && child !== doc) scan(child); } catch {}
    }
  }
  for (const win of Services.wm.getEnumerator(null)) { try { scan(win.document); } catch {} }
  return () => {
    Services.obs.removeObserver(listener, 'document-element-inserted');
    for (const { observer, buttons } of watched.values()) { observer.disconnect(); buttons.forEach(b => b.remove()); }
    watched.clear();
  };
}
