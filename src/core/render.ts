/**
 * Output grammar.
 *
 * Every tool speaks the same compact, line-oriented dialect. It is not JSON:
 * braces, quotes, and repeated key names would roughly double the token cost of
 * a result for no gain in machine-readability — an LLM parses aligned prose
 * just as reliably.
 *
 * The grammar:
 *
 *   line 1     a header naming the tool and the shape of the result
 *   rows       `handle  path:lines  kind  detail`, densest field first
 *   indented   sub-rows belonging to the row above (symbols, matched lines)
 *   footer     what was omitted, and the single next call that would reveal it
 *
 * Keeping this in one module means output stays consistent as tools are added.
 */

import { BudgetWriter } from './tokens.js';

/** Symbols used to mark row types. Single characters keep the cost at one token. */
export const GLYPH = {
  file: '▸',
  symbol: '·',
  match: '→',
  warn: '!',
  edge: '⇒',
} as const;

/**
 * Tokens every tool holds back for its footer.
 *
 * The footer is what tells the caller that rows were omitted and which call
 * would reveal them. Losing it to a full budget would turn a truncated result
 * into an apparently complete one, which is the worst possible failure here.
 */
export const FOOTER_RESERVE = 70;

/** Build the standard first line of a result. */
export function header(tool: string, summary: string): string {
  return `${tool} — ${summary}`;
}

/**
 * Build the standard last line: what got cut, and how to see it.
 * Omitting this is what makes truncated tool output feel like a dead end.
 */
export function footer(writer: BudgetWriter, budget: number, hint?: string): string[] {
  const lines: string[] = [];
  const parts = [`${writer.spent}/${budget} tok`];
  if (writer.omitted > 0) parts.push(`${writer.omitted} rows omitted`);
  lines.push('');
  lines.push(`[${parts.join(' · ')}]`);
  if (hint) lines.push(`next: ${hint}`);
  return lines;
}

/** Render a line range the way every tool refers to one: `path:12-48`. */
export function span(path: string, startLine: number, endLine: number): string {
  return startLine === endLine ? `${path}:${startLine}` : `${path}:${startLine}-${endLine}`;
}

/** Join non-empty fields with the standard separator. */
export function fields(...parts: (string | number | undefined | null | false)[]): string {
  return parts.filter((p) => p !== undefined && p !== null && p !== false && p !== '').join('  ');
}

/** Indent a sub-row to the standard depth. */
export function indent(depth: number, text: string): string {
  return '  '.repeat(Math.max(0, depth)) + text;
}

/**
 * Render source lines with line numbers, using the narrowest gutter that fits.
 * A 4-digit gutter on a 30-line excerpt wastes tokens on every single line.
 */
export function numberedLines(lines: readonly string[], firstLineNumber: number): string[] {
  const width = String(firstLineNumber + lines.length - 1).length;
  return lines.map((line, i) => `${String(firstLineNumber + i).padStart(width)}| ${line}`);
}

/** Format a count with its noun, pluralised. */
export function plural(count: number, singular: string, pluralForm = singular + 's'): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** Compact "ts×180 py×12" style tallies, most common first. */
export function tally(counts: ReadonlyMap<string, number>, limit = 6): string {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => `${name}×${count}`)
    .join(' ');
}
