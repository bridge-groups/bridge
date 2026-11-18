import { cells, isTableRow, isTableSeparator, plain, width } from './markdown.ts';

/** Wider than this (in monospace columns) and a table would wrap on a phone, so rows become records. */
const MAX_TABLE_WIDTH = 60;

/**
 * Standard Markdown (what agents write) → Discord markdown.
 * Discord renders bold, italic, strike, code, quotes, lists, `[text](url)` and headings `#` to `###`, but not
 * tables, deeper headings, rules or task boxes: tables become a monospace grid (or "column: value" records when
 * wide), `####`+ headings become `###`, rules a line of box characters, task boxes ☐ / ☑.
 */
export function toDiscordMarkdown(md: string): string {
  const out: string[] = [];
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      out.push(line);
      i++;
      while (i < lines.length && !lines[i]!.trimStart().startsWith(fence[1]!)) out.push(lines[i++]!);
      if (i < lines.length) out.push(lines[i]!);
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

    const deep = /^\s{0,3}#{4,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (deep) {
      out.push(`### ${deep[1]}`);
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push('──────────');
      continue;
    }
    out.push(line.replace(/^(\s*[-*+]\s+)\[([ xX])\]\s+/, (_m, bullet: string, box: string) => `${bullet}${box === ' ' ? '☐' : '☑'} `));
  }
  return out.join('\n');
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
  return ['```', fmt(rows[0]!), widths.map((w) => '─'.repeat(w)).join('  '), ...rows.slice(1).map(fmt), '```'].join('\n');
}

/** One block per row: the first cell as a bold title, the rest as "header: value" bullets. */
function renderRecords(rows: string[][]): string {
  const [header, ...body] = rows;
  const head = header!.map(plain);
  return body
    .map((r) => {
      const items = r.slice(1).flatMap((cell, c) => {
        const parts = cell.split(/<br\s*\/?>/i).map((p) => p.trim()).filter(Boolean);
        const label = head[c + 1] ? `${head[c + 1]}: ` : '';
        if (parts.length <= 1) return [`- ${label}${parts[0] ?? '—'}`];
        return [`- ${label}`, ...parts.map((p) => `  - ${p}`)];
      });
      return [`**${plain(r[0] ?? '')}**`, ...items].join('\n');
    })
    .join('\n\n');
}

/** Cut to at most `max` characters, at a line break when one is in reach, closing a code fence left open; "…" marks the cut. */
export function truncateDiscord(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = max - '\n```\n…'.length;
  let cut = text.slice(0, room).replace(/[\uD800-\uDBFF]$/, '');
  const nl = cut.lastIndexOf('\n');
  if (nl > room / 2) cut = cut.slice(0, nl);
  const open = (cut.match(/```/g) ?? []).length % 2 === 1;
  return `${cut}${open ? '\n```' : ''}\n…`;
}
