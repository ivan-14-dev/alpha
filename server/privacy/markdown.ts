/**
 * Tiny, safe Markdown subset used for the legal templates. It produces a JSON AST (never HTML): the browser
 * renders it with React elements, so any markup in the source or in substituted settings stays plain text.
 * Supported: front matter, headings (#..####), paragraphs, unordered/ordered lists, block quotes, rules,
 * pipe tables, **bold**, *italic*, `code`, [links](/same-site | #anchor | https://... | mailto:...), backslash escapes.
 */
export type Inline =
  | { type: 'text'; text: string }
  | { type: 'strong'; children: Inline[] }
  | { type: 'em'; children: Inline[] }
  | { type: 'code'; text: string }
  | { type: 'link'; href: string; children: Inline[] };

export type Block =
  | { type: 'heading'; level: 1 | 2 | 3 | 4; id: string; children: Inline[] }
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'list'; ordered: boolean; items: Inline[][] }
  | { type: 'quote'; paragraphs: Inline[][] }
  | { type: 'rule' }
  | { type: 'table'; header: Inline[][]; rows: Inline[][][] };

const punctuation = /[\\`*_{}[\]()#+\-.!|<>~"'&:]/;

/** Accepts same-site paths, in-page anchors, HTTPS URLs and mailto: addresses only. */
export function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (/^#[a-z0-9-]{1,80}$/i.test(href)) return href;
  if (/^\/(?![/\\])[^\s<>"']*$/.test(href)) return href;
  if (/^mailto:[^\s@<>"']+@[^\s@<>"']+$/i.test(href)) return href;
  if (/^https:\/\//i.test(href) && URL.canParse(href)) {
    const url = new URL(href);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
  }
  return null;
}

/** Escapes Markdown control characters so substituted values (settings) are always rendered literally. */
export function escapeMarkdown(value: string): string {
  return value.replace(/\r?\n|\r/g, ', ').replace(/[\\`*_[\]()#|<>!~]/g, '\\$&');
}

function mergeText(nodes: Inline[]): Inline[] {
  const merged: Inline[] = [];
  for (const node of nodes) {
    const last = merged[merged.length - 1];
    if (node.type === 'text' && last?.type === 'text') last.text += node.text;
    else if (node.type !== 'text' || node.text) merged.push(node);
  }
  return merged;
}

function findClosing(source: string, marker: string, from: number): number {
  for (let index = from; index < source.length; index += 1) {
    if (source[index] === '\\') { index += 1; continue; }
    if (source.startsWith(marker, index)) return index;
  }
  return -1;
}

export function parseInline(source: string, allowLinks = true, depth = 0): Inline[] {
  if (depth > 6) return [{ type: 'text', text: source.replace(/\\(.)/g, '$1') }];
  const nodes: Inline[] = [];
  let text = '';
  const flush = () => { if (text) { nodes.push({ type: 'text', text }); text = ''; } };
  for (let index = 0; index < source.length;) {
    const char = source[index];
    if (char === '\\' && index + 1 < source.length && punctuation.test(source[index + 1])) {
      text += source[index + 1];
      index += 2;
      continue;
    }
    if (char === '`') {
      const end = source.indexOf('`', index + 1);
      if (end > index) { flush(); nodes.push({ type: 'code', text: source.slice(index + 1, end) }); index = end + 1; continue; }
    }
    if (source.startsWith('**', index)) {
      const end = findClosing(source, '**', index + 2);
      if (end > index + 2) {
        flush();
        nodes.push({ type: 'strong', children: parseInline(source.slice(index + 2, end), allowLinks, depth + 1) });
        index = end + 2;
        continue;
      }
    }
    if ((char === '*' || char === '_') && source[index + 1] && source[index + 1] !== ' ') {
      const end = findClosing(source, char, index + 1);
      const boundary = char === '*' || !/[\p{L}\p{N}]/u.test(source[end + 1] ?? '');
      if (end > index + 1 && source[end - 1] !== ' ' && boundary && (char === '*' || !/[\p{L}\p{N}]/u.test(source[index - 1] ?? ''))) {
        flush();
        nodes.push({ type: 'em', children: parseInline(source.slice(index + 1, end), allowLinks, depth + 1) });
        index = end + 1;
        continue;
      }
    }
    if (char === '[' && allowLinks) {
      const close = findClosing(source, ']', index + 1);
      if (close > index && source[close + 1] === '(') {
        const end = source.indexOf(')', close + 2);
        if (end > close) {
          const label = parseInline(source.slice(index + 1, close), false, depth + 1);
          const href = safeHref(source.slice(close + 2, end));
          flush();
          if (href) nodes.push({ type: 'link', href, children: label });
          else nodes.push(...label);
          index = end + 1;
          continue;
        }
      }
    }
    text += char;
    index += 1;
  }
  flush();
  return mergeText(nodes);
}

export function slugify(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'section';
}

const plain = (nodes: Inline[]): string => nodes.map((node) => node.type === 'text' || node.type === 'code' ? node.text : plain(node.children)).join('');

export interface ParsedDocument { meta: Record<string, string>; blocks: Block[] }

const isTableSeparator = (line: string) => /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);
const splitRow = (line: string) => {
  const cells: string[] = [];
  let current = '';
  const body = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === '\\' && body[index + 1] === '|') { current += '\\|'; index += 1; continue; }
    if (body[index] === '|') { cells.push(current.trim()); current = ''; continue; }
    current += body[index];
  }
  cells.push(current.trim());
  return cells;
};

export function parseMarkdown(source: string): ParsedDocument {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const meta: Record<string, string> = {};
  let index = 0;
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, position) => position > 0 && line.trim() === '---');
    if (end > 0) {
      for (const line of lines.slice(1, end)) {
        const match = /^([a-z_]+):\s*(.*)$/i.exec(line.trim());
        if (match) meta[match[1]] = match[2].trim();
      }
      index = end + 1;
    }
  }
  const blocks: Block[] = [];
  const ids = new Map<string, number>();
  const uniqueId = (text: string) => {
    const base = slugify(text);
    const seen = ids.get(base) ?? 0;
    ids.set(base, seen + 1);
    return seen ? `${base}-${seen + 1}` : base;
  };
  const listItem = /^\s{0,3}([-*+]|\d{1,3}[.)])\s+(.*)$/;
  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed || /^<!--.*-->$/.test(trimmed)) { index += 1; continue; }
    const heading = /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(trimmed);
    if (heading) {
      const children = parseInline(heading[2]);
      blocks.push({ type: 'heading', level: heading[1].length as 1 | 2 | 3 | 4, id: uniqueId(plain(children)), children });
      index += 1;
      continue;
    }
    if (/^([-*_])(\s*\1){2,}$/.test(trimmed)) { blocks.push({ type: 'rule' }); index += 1; continue; }
    if (trimmed.startsWith('>')) {
      const paragraphs: string[][] = [[]];
      while (index < lines.length && lines[index].trim().startsWith('>')) {
        const content = lines[index].trim().replace(/^>\s?/, '');
        if (!content.trim()) paragraphs.push([]);
        else paragraphs[paragraphs.length - 1].push(content.trim());
        index += 1;
      }
      blocks.push({ type: 'quote', paragraphs: paragraphs.filter((paragraph) => paragraph.length).map((paragraph) => parseInline(paragraph.join(' '))) });
      continue;
    }
    if (trimmed.startsWith('|') && index + 1 < lines.length && isTableSeparator(lines[index + 1].trim())) {
      const header = splitRow(trimmed).map((cell) => parseInline(cell));
      const rows: Inline[][][] = [];
      index += 2;
      while (index < lines.length && lines[index].trim().startsWith('|')) {
        const cells = splitRow(lines[index]);
        rows.push(header.map((_cell, position) => parseInline(cells[position] ?? '')));
        index += 1;
      }
      blocks.push({ type: 'table', header, rows });
      continue;
    }
    const item = listItem.exec(line);
    if (item) {
      const ordered = /\d/.test(item[1]);
      const items: string[] = [];
      while (index < lines.length) {
        const current = listItem.exec(lines[index]);
        if (current && /\d/.test(current[1]) === ordered) { items.push(current[2].trim()); index += 1; continue; }
        if (lines[index].trim() && /^\s{2,}\S/.test(lines[index]) && items.length) { items[items.length - 1] += ` ${lines[index].trim()}`; index += 1; continue; }
        break;
      }
      blocks.push({ type: 'list', ordered, items: items.map((entry) => parseInline(entry)) });
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index].trim();
      if (!current || /^#{1,4}\s/.test(current) || current.startsWith('>') || listItem.test(lines[index])
        || (current.startsWith('|') && index + 1 < lines.length && isTableSeparator(lines[index + 1].trim()))
        || /^([-*_])(\s*\1){2,}$/.test(current)) break;
      paragraph.push(current);
      index += 1;
    }
    blocks.push({ type: 'paragraph', children: parseInline(paragraph.join(' ')) });
  }
  return { meta, blocks };
}

export function headingsOf(blocks: Block[], maxLevel = 2) {
  return blocks.filter((block): block is Extract<Block, { type: 'heading' }> => block.type === 'heading' && block.level <= maxLevel && block.level >= 2)
    .map((block) => ({ id: block.id, level: block.level, text: plain(block.children) }));
}
