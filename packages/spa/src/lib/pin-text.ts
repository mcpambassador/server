/**
 * Plain-text helpers for the tool-review screen (ADR-021 D5).
 * Definition text is untrusted: it is only ever rendered as text, with invisible
 * characters made visible. Never feed it to markdown or innerHTML.
 */

/** Characters shown as ⟨U+XXXX⟩: format (Cf: zero-width, bidi, tags), control (Cc, except \n \t), line/para separators. */
const INVISIBLE = new RegExp('[\\p{Cf}\\p{Cc}\\u2028\\u2029]', 'gu');

export function visibleText(input: string): string {
  return input.replace(INVISIBLE, ch => {
    if (ch === '\n' || ch === '\t') return ch;
    const hex = (ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0');
    return `⟨U+${hex}⟩`;
  });
}

/** Agent-visible description cap (ADR-021 D1'): first 500 code points. */
export const AGENT_DESCRIPTION_CODEPOINTS = 500;

export function splitAtCodePoints(text: string, n: number): { head: string; tail: string } {
  const cps = Array.from(text);
  if (cps.length <= n) return { head: text, tail: '' };
  return { head: cps.slice(0, n).join(''), tail: cps.slice(n).join('') };
}

export function codePointLength(text: string): number {
  return Array.from(text).length;
}

export type DiffOp = { kind: 'same' | 'add' | 'del'; line: string };

/** Line diff (LCS). Inputs are capped so a hostile 64 KB definition cannot stall the UI. */
export function lineDiff(a: string, b: string, maxLines = 400): DiffOp[] {
  const x = a.split('\n').slice(0, maxLines);
  const y = b.split('\n').slice(0, maxLines);
  const dp: number[][] = Array.from({ length: x.length + 1 }, () =>
    new Array(y.length + 1).fill(0)
  );
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      dp[i]![j] = x[i] === y[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      out.push({ kind: 'same', line: x[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ kind: 'del', line: x[i++]! });
    } else {
      out.push({ kind: 'add', line: y[j++]! });
    }
  }
  while (i < x.length) out.push({ kind: 'del', line: x[i++]! });
  while (j < y.length) out.push({ kind: 'add', line: y[j++]! });
  return out;
}
