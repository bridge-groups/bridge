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

/** Display width in a monospace font: CJK and full-width characters take two columns. */
export function width(s: string): number {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    n +=
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff) ||
      (cp >= 0x20000 && cp <= 0x3fffd)
        ? 2
        : 1;
  }
  return n;
}
