/** Pieces of standard Markdown (what agents write) that the IM renderers share. */

/** A line of a pipe table. */
export function isTableRow(line: string) {
  const t = line.trim();
  return t.startsWith('|') && t.length > 1;
}

/** The `|---|:--:|` line under a table's header. */
export function isTableSeparator(line: string) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
}

/** A table row's cells (`\|` is a literal pipe). */
export function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'));
}

/** A table cell as plain text, for places where markdown would show literally (code blocks, card titles). */
export function plain(s: string): string {
  return s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/<br\s*\/?>/gi, ' ');
}

/** The text of a `#` heading line, without bold markers (the IMs show the whole heading bold); else undefined. */
export function headingText(line: string): string | undefined {
  return /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)?.[1]!.replace(/\*\*|__/g, '');
}
