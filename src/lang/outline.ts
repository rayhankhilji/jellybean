/**
 * Symbol extraction.
 *
 * Three strategies cover every language we support:
 *
 *   • brace   — extent is the matching `}` (C-family, Go, Rust, JVM, Swift…)
 *   • indent  — extent is the last line indented deeper (Python, Ruby)
 *   • line    — extent runs to the next peer heading (Markdown, YAML, TOML)
 *
 * A symbol that is *not* a container has its body skipped entirely, so the
 * outline shows a file's shape rather than every closure inside every function.
 * That distinction is what makes an outline ~10× cheaper than the source.
 */

import {
  CONTAINER_KINDS,
  BRACE_LANGUAGES,
  INDENT_LANGUAGES,
  patternsFor,
  RESERVED_NAMES,
  type DeclPattern,
} from './patterns.js';
import { maskSource } from './scanner.js';
import { syntaxFor } from './registry.js';
import { squish, toLines, truncate } from '../util/text.js';
import type { CodeSymbol, LanguageId, SymbolKind } from './types.js';

/** Guard against pathological files; also the point past which outlines stop being useful. */
const MAX_SYMBOLS = 2000;
/** How far a declaration's header may span before we give up looking for its body. */
const MAX_HEADER_LOOKAHEAD = 40;

interface OpenContainer {
  kind: SymbolKind;
  endLine: number;
  exported: boolean;
  /** The container's own declaration line, needed to judge member visibility. */
  declaration: string;
}

/**
 * Extract the symbol outline of a source file.
 *
 * `masked` may be supplied by a caller that has already masked this source —
 * masking is the single most expensive step in indexing, and doing it once for
 * both symbols and imports rather than twice halves it.
 */
export function extractSymbols(source: string, language: LanguageId, masked?: string): CodeSymbol[] {
  const patterns = patternsFor(language);

  if (language === 'markdown') return extractMarkdown(source);
  if (language === 'yaml' || language === 'toml') return extractConfigKeys(source, language);
  if (patterns.length === 0) return [];

  masked ??= maskSource(source, syntaxFor(language));

  if (language === 'typescript' || language === 'javascript') {
    // A barrel file declares nothing and is nonetheless entirely meaningful.
    // Without this, `jb_outline` on one of the commonest files in any JS
    // monorepo answers "no symbols found", which is true and useless.
    return [...extractBraced(source, masked, language), ...extractReExports(source, masked)].sort(
      (a, b) => a.startLine - b.startLine,
    );
  }

  if (BRACE_LANGUAGES.has(language)) return extractBraced(source, masked, language);
  if (INDENT_LANGUAGES.has(language)) return extractIndented(source, masked, language);
  return extractFlat(source, masked, language);
}

/**
 * Re-export statements, as symbols.
 *
 * `export * from './packet.interface'` declares nothing, so no declaration
 * pattern matches it and a barrel file outlines as empty. But the statement *is*
 * the file's content, and an agent asking what is in the file needs to be told
 * where to look next.
 *
 * Each statement becomes one symbol named for its specifier — not for the names
 * it forwards, which are unknowable without following it. Claiming those names
 * are declared here would be a lie the agent would then act on.
 *
 * Runs against the original source, because the specifier lives in a string
 * literal that masking has erased. The mask is still consulted to skip lines
 * that are entirely commented out.
 */
function extractReExports(source: string, masked: string): CodeSymbol[] {
  const lines = toLines(source);
  const mlines = toLines(masked);
  const pattern = /^\s*export\s+(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/;

  const symbols: CodeSymbol[] = [];
  for (let i = 0; i < lines.length && symbols.length < MAX_SYMBOLS; i++) {
    // Blank in the mask but not in the source means the line is a comment.
    if ((mlines[i] ?? '').trim() === '' && lines[i]!.trim() !== '') continue;

    const specifier = pattern.exec(lines[i]!)?.[1];
    if (!specifier) continue;

    symbols.push({
      name: specifier,
      kind: 'module',
      startLine: i + 1,
      endLine: i + 1,
      depth: 0,
      // The statement itself is the clearest possible description of itself.
      signature: truncate(squish(lines[i]!.replace(/;\s*$/, '')), 200),
      exported: true,
    });
  }
  return symbols;
}

// ---------------------------------------------------------------------------
// Brace-delimited languages
// ---------------------------------------------------------------------------

function extractBraced(source: string, masked: string, language: LanguageId): CodeSymbol[] {
  const lines = toLines(source);
  const mlines = toLines(masked);
  const patterns = patternsFor(language);
  const n = mlines.length;

  // Two depth metrics, computed in one pass.
  //
  //   brace — only `{}`. Decides what nests inside what, because only braces
  //           open a scope that can hold declarations.
  //   any   — `{}`, `[]`, and `()`. Decides where a declaration *ends*, so that
  //           `const X = [` … `];` and a parameter list split across lines both
  //           get their true extent instead of collapsing to one line.
  const braceBefore = new Array<number>(n).fill(0);
  const braceMax = new Array<number>(n).fill(0);
  const anyBefore = new Array<number>(n).fill(0);
  const anyAfter = new Array<number>(n).fill(0);
  const anyMax = new Array<number>(n).fill(0);

  let brace = 0;
  let any = 0;
  for (let i = 0; i < n; i++) {
    braceBefore[i] = brace;
    anyBefore[i] = any;
    let bracePeak = brace;
    let anyPeak = any;

    const line = mlines[i]!;
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (ch === '{') {
        brace++;
        any++;
        if (brace > bracePeak) bracePeak = brace;
        if (any > anyPeak) anyPeak = any;
      } else if (ch === '}') {
        brace--;
        any--;
      } else if (ch === '[' || ch === '(') {
        any++;
        if (any > anyPeak) anyPeak = any;
      } else if (ch === ']' || ch === ')') {
        any--;
      }
    }
    braceMax[i] = bracePeak;
    anyMax[i] = anyPeak;
    anyAfter[i] = any;
  }

  const symbols: CodeSymbol[] = [];
  const stack: OpenContainer[] = [];

  for (let i = 0; i < n && symbols.length < MAX_SYMBOLS; i++) {
    while (stack.length > 0 && stack[stack.length - 1]!.endLine < i + 1) stack.pop();

    const mline = mlines[i]!;
    if (mline.trim() === '') continue;

    const top = stack[stack.length - 1];
    const insideContainer = top !== undefined && CONTAINER_KINDS.has(top.kind);

    // Members are only recognised inside a container; top-level declarations are
    // only recognised at depth 0 or directly inside one. Everything else is a
    // local detail we deliberately omit.
    if (!insideContainer && braceBefore[i]! > 0) continue;

    const match = matchDeclaration(mline, patterns, insideContainer);
    if (!match) continue;

    const end = braceExtent(mlines, anyBefore, anyAfter, anyMax, i);
    const headerEnd = braceHeaderEnd(braceBefore, braceMax, i, end);
    const signature = buildSignature(lines, i, headerEnd);
    const exported = isExported(lines[i]!, match.name, language, top);

    const symbol: CodeSymbol = {
      name: match.name,
      kind: match.kind,
      startLine: i + 1,
      endLine: end + 1,
      depth: stack.length,
      signature,
      exported,
    };
    const doc = findDoc(lines, mlines, i);
    if (doc) symbol.doc = doc;
    symbols.push(symbol);

    if (CONTAINER_KINDS.has(match.kind) && end > i) {
      stack.push({ kind: match.kind, endLine: end + 1, exported, declaration: lines[i]! });
    } else if (end > i) {
      // Not a container: skip its body so inner closures never reach the outline.
      i = end;
    }
  }

  return symbols;
}

/**
 * Find the 0-based line where a declaration ends.
 *
 * Walks forward looking for whichever comes first: a delimiter that opens
 * (follow it to its match) or a `;` (the declaration was a statement). The
 * lookahead limit applies only to finding that first signal — once something is
 * open we follow it however far it runs.
 *
 * Uses the *all-delimiter* depth, so `const IGNORES = [` … `];` and a parameter
 * list split across lines both get their real extent.
 */
function braceExtent(
  mlines: readonly string[],
  depthBefore: readonly number[],
  depthAfter: readonly number[],
  depthMax: readonly number[],
  start: number,
): number {
  const d = depthBefore[start]!;
  const limit = Math.min(mlines.length - 1, start + MAX_HEADER_LOOKAHEAD);

  for (let j = start; j <= limit; j++) {
    if (depthMax[j]! > d) {
      // Opened and closed on the same line: `fn f() { 1 }`.
      if (depthAfter[j]! <= d) return j;

      for (let k = j + 1; k < mlines.length; k++) {
        if (depthAfter[k]! <= d) return k;
      }
      return mlines.length - 1;
    }

    // A statement-form declaration: `type Id = string;`
    if (mlines[j]!.trimEnd().endsWith(';')) return j;

    // Depth fell below where we started — the enclosing block ended.
    if (depthAfter[j]! < d) return j;
  }

  return start;
}

/**
 * Find the last line of a declaration's header — the line opening its body.
 *
 * This deliberately tracks *braces only*. A signature whose parameters wrap
 * across several lines still has its body opened by `{`, so brace depth is what
 * separates "still reading the signature" from "into the body".
 */
function braceHeaderEnd(
  braceBefore: readonly number[],
  braceMax: readonly number[],
  start: number,
  end: number,
): number {
  const d = braceBefore[start]!;
  const limit = Math.min(end, start + MAX_HEADER_LOOKAHEAD);
  for (let j = start; j <= limit; j++) {
    if (braceMax[j]! > d) return j;
  }
  return start;
}

// ---------------------------------------------------------------------------
// Indentation-delimited languages
// ---------------------------------------------------------------------------

function extractIndented(source: string, masked: string, language: LanguageId): CodeSymbol[] {
  const lines = toLines(source);
  const mlines = toLines(masked);
  const patterns = patternsFor(language);
  const n = lines.length;

  const symbols: CodeSymbol[] = [];
  const stack: Array<OpenContainer & { indent: number }> = [];

  for (let i = 0; i < n && symbols.length < MAX_SYMBOLS; i++) {
    const mline = mlines[i]!;
    if (mline.trim() === '') continue;

    const indent = indentWidth(mline);
    while (stack.length > 0 && indent <= stack[stack.length - 1]!.indent) stack.pop();

    const top = stack[stack.length - 1];
    const insideContainer = top !== undefined && CONTAINER_KINDS.has(top.kind);

    // Only top-level code and container members are outlined.
    if (!insideContainer && indent > 0) continue;

    const match = matchDeclaration(mline, patterns, insideContainer);
    if (!match) continue;

    const end = indentExtent(mlines, i, indent, language);
    const headerEnd = headerEndIndented(mlines, i, end);
    const kind = match.kind === 'function' && insideContainer ? 'method' : match.kind;

    const symbol: CodeSymbol = {
      name: match.name,
      kind,
      startLine: i + 1,
      endLine: end + 1,
      depth: stack.length,
      signature: buildSignature(lines, i, headerEnd),
      exported: isExported(lines[i]!, match.name, language, top),
    };
    const doc = findDoc(lines, mlines, i);
    if (doc) symbol.doc = doc;
    symbols.push(symbol);

    if (CONTAINER_KINDS.has(kind)) {
      stack.push({ kind, endLine: end + 1, exported: symbol.exported, declaration: lines[i]!, indent });
    } else if (end > i) {
      i = end;
    }
  }

  return symbols;
}

function indentExtent(mlines: readonly string[], start: number, indent: number, language: LanguageId): number {
  let end = start;
  for (let j = start + 1; j < mlines.length; j++) {
    const line = mlines[j]!;
    if (line.trim() === '') continue;
    if (indentWidth(line) > indent) {
      end = j;
      continue;
    }
    // Ruby closes blocks with a peer-indented `end`, which belongs to the symbol.
    if (language === 'ruby' && line.trim() === 'end') end = j;
    break;
  }
  return end;
}

/** The header of an indented declaration ends at the line closing its parameter list. */
function headerEndIndented(mlines: readonly string[], start: number, end: number): number {
  const limit = Math.min(end, start + MAX_HEADER_LOOKAHEAD);
  for (let j = start; j <= limit; j++) {
    const t = mlines[j]!.trimEnd();
    if (t.endsWith(':') || t.endsWith('|') || (j > start && t.endsWith(')'))) return j;
  }
  return start;
}

function indentWidth(line: string): number {
  let width = 0;
  for (const ch of line) {
    if (ch === ' ') width++;
    else if (ch === '\t') width += 4;
    else break;
  }
  return width;
}

// ---------------------------------------------------------------------------
// Flat languages (shell, sql) — declarations without tracked nesting
// ---------------------------------------------------------------------------

function extractFlat(source: string, masked: string, language: LanguageId): CodeSymbol[] {
  const lines = toLines(source);
  const mlines = toLines(masked);
  const patterns = patternsFor(language);
  const symbols: CodeSymbol[] = [];

  for (let i = 0; i < mlines.length && symbols.length < MAX_SYMBOLS; i++) {
    const match = matchDeclaration(mlines[i]!, patterns, false);
    if (!match) continue;
    symbols.push({
      name: match.name,
      kind: match.kind,
      startLine: i + 1,
      endLine: i + 1,
      depth: 0,
      signature: buildSignature(lines, i, i),
      exported: true,
    });
  }

  // A flat declaration runs until the next one starts.
  for (let s = 0; s < symbols.length; s++) {
    const next = symbols[s + 1];
    symbols[s]!.endLine = next ? next.startLine - 1 : mlines.length;
  }
  return symbols;
}

// ---------------------------------------------------------------------------
// Markdown and config files
// ---------------------------------------------------------------------------

function extractMarkdown(source: string): CodeSymbol[] {
  const lines = toLines(source);
  const symbols: CodeSymbol[] = [];
  let inFence = false;

  for (let i = 0; i < lines.length && symbols.length < MAX_SYMBOLS; i++) {
    const line = lines[i]!;
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    symbols.push({
      name: truncate(squish(m[2]!), 100),
      kind: 'section',
      startLine: i + 1,
      endLine: i + 1,
      depth: m[1]!.length - 1,
      signature: truncate(squish(line), 120),
      exported: true,
    });
  }

  // A heading owns everything up to the next heading at the same or higher level.
  for (let s = 0; s < symbols.length; s++) {
    const self = symbols[s]!;
    let end = lines.length;
    for (let t = s + 1; t < symbols.length; t++) {
      if (symbols[t]!.depth <= self.depth) {
        end = symbols[t]!.startLine - 1;
        break;
      }
    }
    self.endLine = Math.max(self.startLine, end);
  }
  return symbols;
}

function extractConfigKeys(source: string, language: LanguageId): CodeSymbol[] {
  const lines = toLines(source);
  const symbols: CodeSymbol[] = [];

  for (let i = 0; i < lines.length && symbols.length < MAX_SYMBOLS; i++) {
    const line = lines[i]!;
    const m =
      language === 'toml'
        ? /^\s*\[+(?<name>[^\]]+)\]+/.exec(line)
        : /^(?<name>[A-Za-z_][\w.-]*)\s*:/.exec(line);
    const name = m?.groups?.['name'];
    if (!name) continue;
    symbols.push({
      name: name.trim(),
      kind: 'section',
      startLine: i + 1,
      endLine: i + 1,
      depth: 0,
      signature: truncate(squish(line), 120),
      exported: true,
    });
  }

  for (let s = 0; s < symbols.length; s++) {
    const next = symbols[s + 1];
    symbols[s]!.endLine = next ? next.startLine - 1 : lines.length;
  }
  return symbols;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function matchDeclaration(
  mline: string,
  patterns: readonly DeclPattern[],
  insideContainer: boolean,
): { name: string; kind: SymbolKind } | null {
  for (const pattern of patterns) {
    if (pattern.memberOnly && !insideContainer) continue;
    const m = pattern.re.exec(mline);
    const name = m?.groups?.['name'];
    if (!name) continue;
    // Only loose patterns can mistake control flow for a declaration, so only
    // they are filtered — `fn new()` must survive.
    if (pattern.loose && RESERVED_NAMES.has(name)) continue;
    return { name: (pattern.namePrefix ?? '') + name, kind: pattern.kind };
  }
  return null;
}

function buildSignature(lines: readonly string[], start: number, headerEnd: number): string {
  const span = lines.slice(start, Math.min(headerEnd, start + 4) + 1);
  let text = squish(span.join(' '));

  // Drop the brace that opens the body. Only a *trailing* brace qualifies: an
  // inline object type such as `patterns: readonly { kind: Kind }[]` contains
  // braces that are part of the signature, and cutting at the first one would
  // truncate it mid-parameter.
  text = text.replace(/\s*\{\s*$/, '');

  return truncate(text.replace(/[\s;:,]+$/, '').trim(), 200);
}

function isExported(
  line: string,
  name: string,
  language: LanguageId,
  container: OpenContainer | undefined,
): boolean {
  if (container && !container.exported) return false;

  switch (language) {
    case 'typescript':
    case 'javascript':
      return /^\s*export\b/.test(line) || (container !== undefined && !/^\s*(private|#)/.test(line));
    case 'go':
      return /^[A-Z]/.test(name);
    case 'rust':
      return isExportedRust(line, container);
    case 'python':
      // Dunder methods are part of a class's public protocol, not private
      // details — `__init__` is the most-called method most classes have.
      if (/^__.*__$/.test(name)) return true;
      return !name.startsWith('_');
    case 'ruby':
      return !name.startsWith('_');
    case 'java':
    case 'kotlin':
    case 'csharp':
    case 'swift':
    case 'php':
      return !/^\s*(?:private|internal|fileprivate)\b/.test(line);
    default:
      return true;
  }
}

/**
 * Rust visibility, which depends on what encloses the item.
 *
 *   `impl Foo { fn helper() }`        — private; inherent impls need `pub`
 *   `impl Trait for Foo { fn run() }` — public; a trait impl is as visible as the trait
 *   `trait Loader { fn load() }`      — public; trait items follow the trait
 *
 * Getting this wrong is worse than omitting it: an agent that believes a trait
 * method is private will not consider it part of the file's surface.
 */
function isExportedRust(line: string, container: OpenContainer | undefined): boolean {
  if (/^\s*pub\b/.test(line)) return true;
  // An `impl` block itself has no visibility — it is as reachable as its type.
  if (/^\s*impl\b/.test(line)) return true;

  if (container) {
    const declaration = container.declaration;
    if (/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?trait\b/.test(declaration)) return container.exported;
    if (/^\s*impl\b.*\bfor\b/.test(declaration)) return true;
  }
  return false;
}

/**
 * Find a doc comment directly above a declaration.
 *
 * A line is a comment when its masked form is blank but its source form is not
 * — the mask has already done the hard work of deciding what is a comment.
 */
function findDoc(lines: readonly string[], mlines: readonly string[], start: number): string | undefined {
  const collected: string[] = [];
  for (let i = start - 1; i >= 0 && start - i <= 12; i--) {
    const raw = lines[i]!;
    const masked = mlines[i]!;
    if (raw.trim() === '') break;
    // Decorators and attributes sit between the doc and the declaration.
    if (/^\s*[@#[]/.test(raw) && masked.trim() !== '') continue;
    if (masked.trim() !== '') break;
    collected.unshift(raw);
  }
  if (collected.length === 0) return undefined;

  for (const raw of collected) {
    const text = raw.replace(/^\s*(?:\/\*\*?|\*\/|\*|\/\/\/?|#+|--|"""|''')\s?/, '').replace(/\*\/\s*$/, '').trim();
    if (text.length > 2 && !/^[-=*_]{3,}$/.test(text)) return truncate(squish(text), 160);
  }
  return undefined;
}
