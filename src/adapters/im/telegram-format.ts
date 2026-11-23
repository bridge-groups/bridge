import { cells, headingText, isTableRow, isTableSeparator, plain, width } from './markdown.ts';

/** Wider than this (in monospace columns) and a table would wrap on a phone, so rows become records. */
const MAX_TABLE_WIDTH = 40;

/**
 * Standard Markdown (what agents write) → Telegram HTML (`parse_mode: 'HTML'`).
 * Telegram renders <b>, <i>, <s>, <code>, <pre>, <a> and <blockquote>, but no headings, lists or tables: headings
 * become bold lines, bullets •, task boxes ☐ / ☑, rules a line of box characters, tables a monospace grid (or
 * "column: value" records when wide). `&`, `<` and `>` are escaped everywhere, code included.
 */
export function toTelegramHtml(md: string): string {
  const out: string[] = [];
  const quote: string[] = [];
  const flushQuote = () => {
    if (quote.length) out.push(`<blockquote>${quote.splice(0).join('\n')}</blockquote>`);
  };
  const lines = md.replace(/\r\n/g, '\n').split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const quoted = /^\s*>+\s?(.*)$/.exec(line);
    if (quoted) {
      quote.push(inline(quoted[1]!));
      continue;
    }
    flushQuote();

    const fence = /^\s*(```|~~~)\s*([\w+-]*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trimStart().startsWith(fence[1]!)) body.push(escape(lines[i++]!));
      const lang = fence[2] ? ` class="language-${fence[2]}"` : '';
      out.push(`<pre><code${lang}>${body.join('\n')}</code></pre>`);
      continue;
    }

    if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1]!)) {
      const rows = [cells(line)];
      i += 2;
      while (i < lines.length && isTableRow(lines[i]!)) rows.push(cells(lines[i++]!));
      i--;
      out.push(renderTable(rows));
      continue;
    }

    const heading = headingText(line);
    if (heading !== undefined) {
      out.push(`<b>${inline(heading)}</b>`);
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push('──────────');
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(\[[ xX]\]\s+)?(.*)$/.exec(line);
    if (bullet) {
      const indent = ' '.repeat(Math.floor(bullet[1]!.length / 2) * 4);
      const box = bullet[2] ? (/x/i.test(bullet[2]) ? '☑ ' : '☐ ') : '';
      out.push(`${indent}• ${box}${inline(bullet[3]!)}`);
      continue;
    }
    out.push(inline(line));
  }
  flushQuote();
  return out.join('\n');
}

/** The three characters Telegram's HTML needs as entities. */
function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Inline spans, with `code` protected from every other rule (but still escaped). */
function inline(text: string): string {
  return text
    .split(/(`[^`\n]+`)/)
    .map((part, idx) => (idx % 2 === 1 ? `<code>${escape(part.slice(1, -1))}</code>` : spans(part)))
    .join('');
}

function spans(s: string): string {
  // Links first, into placeholders, so their URLs are not touched by the emphasis rules.
  const links: string[] = [];
  s = s.replace(/!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, label: string, url: string) => {
    links.push(`<a href="${escape(url).replace(/"/g, '&quot;')}">${escape(label || url)}</a>`);
    return `\u0000${links.length - 1}\u0000`;
  });
  s = escape(s);
  s = s.replace(/\*\*(?=\S)([^*]+?)(?<=\S)\*\*/g, '<b>$1</b>');
  s = s.replace(/__(?=\S)([^_]+?)(?<=\S)__/g, '<b>$1</b>');
  s = s.replace(/(^|[^\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?!\w)/g, '$1<i>$2</i>');
  s = s.replace(/(^|[^\w_])_(?=\S)([^_\n]+?)(?<=\S)_(?!\w)/g, '$1<i>$2</i>');
  s = s.replace(/~~(?=\S)([^~]+?)(?<=\S)~~/g, '<s>$1</s>');
  return s.replace(/\u0000(\d+)\u0000/g, (_m, n: string) => links[Number(n)]!);
}

function renderTable(raw: string[][]): string {
  const rows = raw.map((r) => r.map(plain));
  const cols = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, c) => Math.max(...rows.map((r) => width(r[c] ?? ''))));
  if (widths.reduce((a, b) => a + b + 2, 0) > MAX_TABLE_WIDTH) return renderRecords(raw);
  const fmt = (r: string[]) =>
    widths
      .map((w, c) => (r[c] ?? '') + ' '.repeat(Math.max(0, w - width(r[c] ?? ''))))
      .join('  ')
      .trimEnd();
  // Padded on the plain text (escaping changes lengths, not what is shown), then escaped.
  const grid = [fmt(rows[0]!), widths.map((w) => '─'.repeat(w)).join('  '), ...rows.slice(1).map(fmt)].map(escape);
  return `<pre>${grid.join('\n')}</pre>`;
}

/** One block per row: the first cell as a bold title, the rest as "header: value" bullets. */
function renderRecords(rows: string[][]): string {
  const [header, ...body] = rows;
  const head = header!.map((h) => plain(h));
  return body
    .map((r) => {
      const title = `<b>${escape(plain(r[0] ?? ''))}</b>`;
      const items = r.slice(1).flatMap((cell, i) => {
        const parts = cell.split(/<br\s*\/?>/i).map((p) => inline(p.trim())).filter(Boolean);
        const label = head[i + 1] ? `${escape(head[i + 1]!)}: ` : '';
        if (parts.length <= 1) return [`• ${label}${parts[0] ?? '—'}`];
        return [`• ${label}`, ...parts.map((p) => `    ◦ ${p}`)];
      });
      return [title, ...items].join('\n');
    })
    .join('\n\n');
}
