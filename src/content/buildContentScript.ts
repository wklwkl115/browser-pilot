import { BROWSER_NOISE_SELECTORS } from "../scan/noiseRules.ts";

export type BrowserContentOptions = {
	selector?: string;
	maxChars?: number;
	includeLinks?: boolean;
};

export function buildContentScript(options: BrowserContentOptions = {}): string {
	const payload = JSON.stringify({
		selector: options.selector || "",
		maxChars: Math.max(1, Math.floor(Number(options.maxChars || 200_000))),
		includeLinks: options.includeLinks !== false,
		dropSelector: `script,style,noscript,template,svg,canvas,iframe,object,embed,nav,header,footer,aside,[hidden],[aria-hidden="true"],${BROWSER_NOISE_SELECTORS.join(",")}`,
	});
	return String.raw`(() => {
  const options = ${payload};
  const BLOCK_TAGS = new Set(['ADDRESS','ARTICLE','ASIDE','BLOCKQUOTE','DETAILS','DIALOG','DD','DIV','DL','DT','FIELDSET','FIGCAPTION','FIGURE','FOOTER','FORM','H1','H2','H3','H4','H5','H6','HEADER','HR','LI','MAIN','NAV','OL','P','PRE','SECTION','TABLE','UL']);
  const DROP_SELECTOR = options.dropSelector;
  function clean(text) { return String(text || '').replace(/\u00a0/g, ' ').replace(/[ \t\f\v]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim(); }
  function cloneDocument() {
    const clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll(DROP_SELECTOR).forEach((el) => el.remove());
    return clone;
  }
  function textLen(el) { return clean(el && el.textContent).length; }
  function linkTextLen(el) { return Array.from(el.querySelectorAll('a')).reduce((n, a) => n + textLen(a), 0); }
  function scoreCandidate(el) {
    const len = textLen(el);
    if (len < 80) return -1;
    const paragraphs = el.querySelectorAll('p').length;
    const headings = el.querySelectorAll('h1,h2,h3').length;
    const links = linkTextLen(el);
    const tag = el.tagName;
    const semantic = tag === 'ARTICLE' ? 500 : tag === 'MAIN' ? 400 : el.getAttribute('role') === 'main' ? 350 : 0;
    const classBoost = /content|article|post|entry|story|markdown|main/i.test(el.id + ' ' + el.className) ? 200 : 0;
    return len + paragraphs * 80 + headings * 60 + semantic + classBoost - links * 0.6;
  }
  function pickRoot(docClone) {
    if (options.selector) {
      const selected = docClone.querySelector(options.selector);
      if (!selected) throw new Error('browser_content selector not found: ' + options.selector);
      return selected;
    }
    const direct = docClone.querySelector('article, main, [role="main"], #content, .content, .entry-content, .post-content, .article-content, .markdown-body');
    const directLen = textLen(direct);
    const candidates = Array.from(docClone.querySelectorAll('article, main, [role="main"], section, div'));
    let best = direct;
    let bestScore = directLen > 100 ? scoreCandidate(direct) : -1;
    for (const el of candidates) {
      const score = scoreCandidate(el);
      if (score > bestScore) { best = el; bestScore = score; }
    }
    return best || docClone.querySelector('body') || docClone;
  }
  function absoluteUrl(href) { try { return new URL(href, location.href).href; } catch (_) { return String(href || ''); } }
  const MD_TICK = String.fromCharCode(96);
  const MD_SLASH = String.fromCharCode(92);
  function escapeMd(text) { return clean(text).replace(/\\/g, '\\\\').replace(/\*/g, '\\*').replace(/_/g, '\\_').split(MD_TICK).join(MD_SLASH + MD_TICK); }
  function inline(el) {
    if (!el) return '';
    if (el.nodeType === Node.TEXT_NODE) return escapeMd(el.nodeValue || '');
    if (el.nodeType !== Node.ELEMENT_NODE) return '';
    const tag = el.tagName;
    if (tag === 'BR') return '\n';
    if (tag === 'IMG') return el.getAttribute('alt') ? '![' + escapeMd(el.getAttribute('alt')) + '](' + absoluteUrl(el.getAttribute('src') || '') + ')' : '';
    const content = clean(Array.from(el.childNodes).map(inline).join(' '));
    if (!content) return '';
    if (tag === 'A') {
      const href = el.getAttribute('href');
      return options.includeLinks && href ? '[' + content + '](' + absoluteUrl(href) + ')' : content;
    }
    if (tag === 'STRONG' || tag === 'B') return '**' + content + '**';
    if (tag === 'EM' || tag === 'I') return '*' + content + '*';
    if (tag === 'CODE') return MD_TICK + content.split(MD_TICK).join(MD_SLASH + MD_TICK) + MD_TICK;
    return content;
  }
  function renderTable(table) {
    const rows = Array.from(table.querySelectorAll('tr')).slice(0, 80).map((tr) => Array.from(tr.children).map((cell) => clean(inline(cell)).replace(/\|/g, '\\|'))).filter((row) => row.length);
    if (!rows.length) return '';
    const width = Math.max(...rows.map((row) => row.length));
    const normalized = rows.map((row) => Array.from({ length: width }, (_, i) => row[i] || ''));
    const header = normalized[0];
    const sep = header.map(() => '---');
    return [header, sep, ...normalized.slice(1)].map((row) => '| ' + row.join(' | ') + ' |').join('\n');
  }
  function block(el, depth) {
    if (!el) return '';
    if (el.nodeType === Node.TEXT_NODE) return clean(el.nodeValue || '');
    if (el.nodeType !== Node.ELEMENT_NODE) return '';
    const tag = el.tagName;
    if (tag === 'H1' || tag === 'H2' || tag === 'H3' || tag === 'H4' || tag === 'H5' || tag === 'H6') return '#'.repeat(Number(tag.slice(1))) + ' ' + clean(inline(el));
    if (tag === 'P') return clean(inline(el));
    if (tag === 'PRE') return MD_TICK.repeat(3) + '\n' + String(el.textContent || '').trim() + '\n' + MD_TICK.repeat(3);
    if (tag === 'BLOCKQUOTE') return blockChildren(el, depth + 1).split('\n').map((line) => line ? '> ' + line : '>').join('\n');
    if (tag === 'UL' || tag === 'OL') {
      return Array.from(el.children).filter((child) => child.tagName === 'LI').map((li, i) => {
        const marker = tag === 'OL' ? String(i + 1) + '. ' : '- ';
        const text = blockChildren(li, depth + 1) || clean(inline(li));
        return marker + text.replace(/\n/g, '\n  ');
      }).join('\n');
    }
    if (tag === 'TABLE') return renderTable(el);
    if (!BLOCK_TAGS.has(tag)) return clean(inline(el));
    return blockChildren(el, depth + 1);
  }
  function blockChildren(el, depth) {
    return clean(Array.from(el.childNodes).map((child) => block(child, depth)).filter(Boolean).join('\n\n'));
  }
  const cloned = cloneDocument();
  const root = pickRoot(cloned);
  const originalMarkdown = block(root, 0) || clean(root.textContent || '');
  const originalChars = originalMarkdown.length;
  let markdown = originalMarkdown;
  let truncated = false;
  if (markdown.length > options.maxChars) { markdown = markdown.slice(0, options.maxChars) + '\n\n[content truncated]'; truncated = true; }
  const rootText = clean(root.textContent || '');
  const headings = Array.from(root.querySelectorAll('h1,h2,h3')).map((h) => clean(h.textContent)).filter(Boolean).slice(0, 20);
  return {
    url: location.href,
    title: document.title || '',
    selector: options.selector || null,
    rootTag: root.tagName ? root.tagName.toLowerCase() : '',
    rootId: root.id || '',
    rootClass: String(root.className || '').slice(0, 200),
    markdown,
    textPreview: rootText.slice(0, 1000),
    headings,
    stats: {
      markdownChars: markdown.length,
      originalMarkdownChars: originalChars,
      textChars: rootText.length,
      links: root.querySelectorAll('a').length,
      images: root.querySelectorAll('img').length,
      paragraphs: root.querySelectorAll('p').length,
      headings: headings.length,
      truncated
    }
  };
})()`;
}
