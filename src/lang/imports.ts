/**
 * Import extraction.
 *
 * Unlike symbol extraction, this runs against the *original* source: the thing
 * we need — the module specifier — lives inside a string literal, which the
 * mask deliberately erases. We still consult the mask to skip commented-out
 * imports, which are otherwise a common source of phantom graph edges.
 */

import { maskSource } from './scanner.js';
import { syntaxFor } from './registry.js';
import { toLines } from '../util/text.js';
import type { ImportRef, LanguageId } from './types.js';

/** Import statements past this point are almost certainly generated noise. */
const MAX_IMPORTS = 400;

export function extractImports(source: string, language: LanguageId, masked?: string): ImportRef[] {
  const lines = toLines(source);
  const mlines = toLines(masked ?? maskSource(source, syntaxFor(language)));
  const refs: ImportRef[] = [];

  /** Go groups imports in a parenthesised block; track whether we are inside one. */
  let inGoBlock = false;

  for (let i = 0; i < lines.length && refs.length < MAX_IMPORTS; i++) {
    const line = lines[i]!;
    const masked = mlines[i] ?? '';

    // Blank in the mask but not in the source means the line is entirely a
    // comment (or a string continuation) — never a live import.
    if (masked.trim() === '' && line.trim() !== '') continue;
    if (line.trim() === '') continue;

    switch (language) {
      case 'typescript':
      case 'javascript':
        collectJs(line, i + 1, refs);
        break;
      case 'python':
        collectPython(line, i + 1, refs);
        break;
      case 'go':
        inGoBlock = collectGo(line, i + 1, refs, inGoBlock);
        break;
      case 'rust':
        collectSimple(line, i + 1, refs, /^\s*(?:pub\s+)?use\s+(?<spec>[\w:{}*,\s]+?)\s*;/, ':');
        break;
      case 'java':
      case 'kotlin':
        collectSimple(line, i + 1, refs, /^\s*import\s+(?:static\s+)?(?<spec>[\w.*]+)/, '.');
        break;
      case 'csharp':
        collectSimple(line, i + 1, refs, /^\s*using\s+(?:static\s+)?(?<spec>[\w.]+)\s*;/, '.');
        break;
      case 'swift':
        collectSimple(line, i + 1, refs, /^\s*import\s+(?<spec>[\w.]+)/, '.');
        break;
      case 'c':
      case 'cpp':
        collectSimple(line, i + 1, refs, /^\s*#\s*include\s*[<"](?<spec>[^">]+)[">]/, '/');
        break;
      case 'ruby':
        collectSimple(line, i + 1, refs, /^\s*require(?:_relative)?\s*\(?\s*['"](?<spec>[^'"]+)['"]/, '/');
        break;
      case 'php':
        collectSimple(line, i + 1, refs, /^\s*(?:use\s+(?<spec>[\w\\]+)|(?:require|include)(?:_once)?\s*\(?\s*['"](?<spec2>[^'"]+)['"])/, '\\');
        break;
      case 'shell':
        collectSimple(line, i + 1, refs, /^\s*(?:source|\.)\s+(?<spec>[^\s;#]+)/, '/');
        break;
      default:
        break;
    }
  }

  return dedupe(refs);
}

const JS_IMPORT_RE =
  /(?:^|\W)(?:import|export)\s+(?<clause>[^'"]*?)\s*from\s*['"](?<spec>[^'"]+)['"]|(?:^|\W)import\s*['"](?<bare>[^'"]+)['"]|(?:^|\W)(?:require|import)\s*\(\s*['"](?<dyn>[^'"]+)['"]\s*\)/g;

function collectJs(line: string, lineNo: number, out: ImportRef[]): void {
  JS_IMPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = JS_IMPORT_RE.exec(line)) !== null) {
    const g = m.groups!;
    const specifier = g['spec'] ?? g['bare'] ?? g['dyn'];
    if (!specifier) continue;
    out.push({ specifier, line: lineNo, names: parseJsClause(g['clause'] ?? '') });
  }
}

/** Pull binding names out of `{ a, b as c }`, `X`, or `* as ns`. */
function parseJsClause(clause: string): string[] {
  const names: string[] = [];
  const braced = /\{([^}]*)\}/.exec(clause);
  if (braced) {
    for (const part of braced[1]!.split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) names.push(name.replace(/^type\s+/, ''));
    }
  }
  const outside = clause.replace(/\{[^}]*\}/g, '').replace(/\btype\b/g, '');
  for (const part of outside.split(',')) {
    const cleaned = part.trim().replace(/^\*\s*as\s+/, '');
    if (/^[A-Za-z_$][\w$]*$/.test(cleaned)) names.push(cleaned);
  }
  return names;
}

function collectPython(line: string, lineNo: number, out: ImportRef[]): void {
  const from = /^\s*from\s+(?<spec>[.\w]+)\s+import\s+(?<names>.+)$/.exec(line);
  if (from) {
    const names = from
      .groups!['names']!.replace(/[()\\]/g, '')
      .split(',')
      .map((p) => p.trim().split(/\s+as\s+/).pop()!.trim())
      .filter((p) => /^[A-Za-z_*]\w*$/.test(p));
    out.push({ specifier: from.groups!['spec']!, line: lineNo, names });
    return;
  }

  const plain = /^\s*import\s+(?<specs>[.\w,\s]+)$/.exec(line);
  if (plain) {
    for (const spec of plain.groups!['specs']!.split(',')) {
      const name = spec.trim().split(/\s+as\s+/)[0]!.trim();
      if (name) out.push({ specifier: name, line: lineNo, names: [] });
    }
  }
}

/** Returns the updated "inside `import (…)`" state. */
function collectGo(line: string, lineNo: number, out: ImportRef[], inBlock: boolean): boolean {
  if (/^\s*import\s*\(/.test(line)) return true;
  if (inBlock) {
    if (/^\s*\)/.test(line)) return false;
    const m = /^\s*(?:[\w.]+\s+)?"(?<spec>[^"]+)"/.exec(line);
    if (m) out.push({ specifier: m.groups!['spec']!, line: lineNo, names: [] });
    return true;
  }
  const single = /^\s*import\s+(?:[\w.]+\s+)?"(?<spec>[^"]+)"/.exec(line);
  if (single) out.push({ specifier: single.groups!['spec']!, line: lineNo, names: [] });
  return false;
}

function collectSimple(line: string, lineNo: number, out: ImportRef[], re: RegExp, sep: string): void {
  const m = re.exec(line);
  if (!m) return;
  const raw = (m.groups!['spec'] ?? m.groups!['spec2'] ?? '').trim();
  if (!raw) return;

  // `use a::{b, c};` — record the module path, and the leaf names alongside it.
  const braced = /\{([^}]*)\}/.exec(raw);
  if (braced) {
    const base = raw.slice(0, braced.index).replace(new RegExp(`\\${sep}*$`), '');
    const names = braced[1]!
      .split(',')
      .map((p) => p.trim().split(sep).pop()!.trim())
      .filter(Boolean);
    out.push({ specifier: base, line: lineNo, names });
    return;
  }

  const leaf = raw.split(sep).pop() ?? '';
  out.push({ specifier: raw, line: lineNo, names: leaf && leaf !== '*' ? [leaf] : [] });
}

function dedupe(refs: readonly ImportRef[]): ImportRef[] {
  const byKey = new Map<string, ImportRef>();
  for (const ref of refs) {
    const existing = byKey.get(ref.specifier);
    if (existing) {
      for (const name of ref.names) if (!existing.names.includes(name)) existing.names.push(name);
    } else {
      byKey.set(ref.specifier, { ...ref, names: [...ref.names] });
    }
  }
  return [...byKey.values()];
}

/**
 * Names a file publishes. Combines declarations marked exported with explicit
 * `export { … }` lists, which have no declaration of their own.
 */
export function extractExportList(source: string, language: LanguageId): string[] {
  if (language !== 'typescript' && language !== 'javascript') return [];

  const names = new Set<string>();
  const re = /export\s*\{(?<body>[^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    for (const part of m.groups!['body']!.split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim().replace(/^type\s+/, '');
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  return [...names];
}
