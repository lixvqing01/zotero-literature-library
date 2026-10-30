import { parseFragment } from 'parse5';

// Build escaped application templates with DOM methods: privileged Gecko innerHTML
// strips form controls. No downloaded Markdown/HTML is passed to this function.
export function setMarkup(target: Element, html: string) {
  const parsed = parseFragment(html);
  const doc = target.ownerDocument;
  function materialize(node: any): Node | null {
    if (node.nodeName === '#text') return doc.createTextNode(node.value);
    if (!node.tagName || ['script', 'iframe', 'object', 'embed'].includes(node.tagName)) return null;
    const element = doc.createElementNS(node.namespaceURI || 'http://www.w3.org/1999/xhtml', node.tagName);
    for (const attr of node.attrs || []) {
      if (/^on/i.test(attr.name) || /^(href|src)$/i.test(attr.name) && /^\s*(javascript|data):/i.test(attr.value)) continue;
      element.setAttribute(attr.name, attr.value);
    }
    for (const child of node.childNodes || []) { const created = materialize(child); if (created) element.appendChild(created); }
    return element;
  }
  target.replaceChildren(...parsed.childNodes.map(materialize).filter((node): node is Node => !!node));
}
