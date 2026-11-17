import { parseHTML } from 'linkedom';

export interface ReadableSource {
  format: 'html-text' | 'json' | 'text';
  title?: string;
  text: string;
}

/** Parse inert HTML and retain article text, headings and table row boundaries. */
export function readableSource(raw: string, contentType: string): ReadableSource {
  if (!/\bhtml\b/i.test(contentType) && !/^\s*(?:<!doctype\s+html|<html\b)/i.test(raw)) {
    return { format: /\bjson\b/i.test(contentType) ? 'json' : 'text', text: raw };
  }
  const { document } = parseHTML(raw);
  const title = document.querySelector('title')?.textContent?.trim() ?? '';
  // MediaWiki article content comes before generic landmark fallbacks.
  // linkedom's body getter assumes a document element and creates a body for
  // fragments. Query instead, retaining all fragment siblings and empty input.
  const root = document.querySelector('.mw-parser-output') ?? document.querySelector('main') ?? document.querySelector('article') ?? document.querySelector('body') ?? document;
  for (const node of root.querySelectorAll('head,title,script,style,noscript,svg,nav,aside,iframe,form,template,[hidden],[aria-hidden="true"],.mw-editsection,.noprint,.toc,.navbox')) node.remove();
  function render(node: Node): string {
    if (node.nodeType === 3) return (node.textContent ?? '').replace(/\s+/g, ' ');
    if (node.nodeType === 9) return [...node.childNodes].map(render).join('');
    if (node.nodeType !== 1) return '';
    const tag = node.nodeName.toLowerCase();
    const children = [...node.childNodes].map(render).join('');
    if (/^h[1-6]$/.test(tag)) return `\n${'#'.repeat(Number(tag[1]))} ${children.trim()}\n`;
    if (tag === 'br') return '\n';
    if (tag === 'td' || tag === 'th') return `${children.trim()} | `;
    if (tag === 'tr') return `\n| ${children.trim()}\n`;
    if (tag === 'li') return `\n- ${children.trim()}\n`;
    if (['p', 'div', 'section', 'article', 'main', 'table', 'ul', 'ol', 'dl', 'dt', 'dd', 'blockquote', 'pre'].includes(tag)) return `\n${children.trim()}\n`;
    return children;
  }
  const text = render(root).replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { format: 'html-text', ...(title ? { title } : {}), text };
}
