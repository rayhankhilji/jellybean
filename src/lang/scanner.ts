/**
 * Source masking.
 *
 * Structural parsing (brace depth, indentation, symbol regexes) is only correct
 * if it never sees a brace inside a string or a `def` inside a comment. Rather
 * than making every language module defend itself, we run one pass up front
 * that blanks out string and comment *contents* while preserving every byte
 * offset, line number, and line length.
 *
 * The result is a "masked" copy of the file that lines up 1:1 with the original
 * — so a regex can match on the masked text and slice the real text.
 */

export interface SyntaxProfile {
  /** Sequences that begin a comment running to end of line. */
  lineComment: readonly string[];
  /** Delimiters for block comments, if the language has them. */
  blockComment?: readonly [string, string];
  /** Whether block comments may nest (Rust, Swift, Kotlin). */
  nestedBlockComment?: boolean;
  /** Quote characters that begin a single-line string. */
  quotes: readonly string[];
  /** Whether backtick template literals with `${}` interpolation exist. */
  templates?: boolean;
  /** Whether Python-style triple-quoted strings exist. */
  tripleQuotes?: boolean;
  /** Whether `/.../` regex literals exist and must be skipped. */
  regexLiterals?: boolean;
}

export const SYNTAX_C_LIKE: SyntaxProfile = {
  lineComment: ['//'],
  blockComment: ['/*', '*/'],
  quotes: ['"', "'"],
};

export const SYNTAX_JS: SyntaxProfile = {
  lineComment: ['//'],
  blockComment: ['/*', '*/'],
  quotes: ['"', "'"],
  templates: true,
  regexLiterals: true,
};

export const SYNTAX_PYTHON: SyntaxProfile = {
  lineComment: ['#'],
  quotes: ['"', "'"],
  tripleQuotes: true,
};

export const SYNTAX_HASH: SyntaxProfile = {
  lineComment: ['#'],
  quotes: ['"', "'"],
};

export const SYNTAX_RUST: SyntaxProfile = {
  lineComment: ['//'],
  blockComment: ['/*', '*/'],
  nestedBlockComment: true,
  quotes: ['"'],
};

/**
 * Characters that, when they are the last meaningful character before a `/`,
 * mean the `/` opens a regex literal rather than being division.
 */
const REGEX_PRECEDERS = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>',
]);

const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'case', 'do', 'else', 'yield', 'await',
]);

/** Result of scanning one literal chunk of a template string. */
interface TemplateChunk {
  /** Index to resume the main scan from. */
  next: number;
  /** True when the chunk ended at `${`, meaning real code follows. */
  interpolating: boolean;
}

/**
 * Replace string and comment contents with spaces, preserving length and line
 * breaks. Delimiters themselves are also blanked, so `"abc"` becomes five
 * spaces — this prevents a stray quote from being mistaken for an identifier.
 */
export function maskSource(source: string, profile: SyntaxProfile): string {
  const n = source.length;
  const out: string[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = source[i]!;

  /** Blank a half-open range, leaving newlines intact so lines still align. */
  const blank = (from: number, to: number): void => {
    for (let i = Math.max(0, from); i < to && i < n; i++) {
      if (out[i] !== '\n') out[i] = ' ';
    }
  };

  /**
   * Depths at which each open `${` sat. When a `}` brings us back to a recorded
   * depth we know it closes an interpolation, not an ordinary block.
   */
  const templateStack: number[] = [];
  let braceDepth = 0;
  let lastMeaningful = '';
  let lastWord = '';

  /** Scan the literal text of a template starting just after a backtick or `}`. */
  const maskTemplateChunk = (from: number): TemplateChunk => {
    let j = from;
    while (j < n) {
      const c = source[j]!;
      if (c === '\\') {
        blank(j, j + 2);
        j += 2;
        continue;
      }
      if (c === '`') {
        blank(j, j + 1);
        return { next: j + 1, interpolating: false };
      }
      if (c === '$' && source[j + 1] === '{') {
        blank(j, j + 2);
        return { next: j + 2, interpolating: true };
      }
      blank(j, j + 1);
      j++;
    }
    return { next: n, interpolating: false };
  };

  /** Shared bookkeeping for entering a template chunk from `` ` `` or from `}`. */
  const enterTemplate = (from: number): number => {
    const chunk = maskTemplateChunk(from);
    if (chunk.interpolating) {
      templateStack.push(braceDepth);
      braceDepth++;
    }
    lastMeaningful = '`';
    lastWord = '';
    return chunk.next;
  };

  let i = 0;
  while (i < n) {
    const ch = source[i]!;

    // --- comments -----------------------------------------------------------
    if (matchAny(source, i, profile.lineComment) > 0) {
      let end = source.indexOf('\n', i);
      if (end === -1) end = n;
      blank(i, end);
      i = end;
      continue;
    }

    if (profile.blockComment && source.startsWith(profile.blockComment[0], i)) {
      const [open, close] = profile.blockComment;
      let depth = 1;
      let j = i + open.length;
      while (j < n && depth > 0) {
        if (profile.nestedBlockComment && source.startsWith(open, j)) {
          depth++;
          j += open.length;
        } else if (source.startsWith(close, j)) {
          depth--;
          j += close.length;
        } else {
          j++;
        }
      }
      blank(i, j);
      i = j;
      lastMeaningful = ';'; // a comment cannot make the next `/` a division
      lastWord = '';
      continue;
    }

    // --- triple-quoted strings (Python docstrings) --------------------------
    if (profile.tripleQuotes && (source.startsWith('"""', i) || source.startsWith("'''", i))) {
      const delim = source.slice(i, i + 3);
      let j = i + 3;
      while (j < n) {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source.startsWith(delim, j)) {
          j += 3;
          break;
        }
        j++;
      }
      const end = Math.min(j, n);
      blank(i, end);
      i = end;
      continue;
    }

    // --- template literals --------------------------------------------------
    if (profile.templates && ch === '`') {
      blank(i, i + 1);
      i = enterTemplate(i + 1);
      continue;
    }

    // --- plain strings ------------------------------------------------------
    if (profile.quotes.includes(ch)) {
      let j = i + 1;
      while (j < n) {
        const c = source[j]!;
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (c === ch) {
          j++;
          break;
        }
        // These languages have no multi-line plain strings. Stopping at the
        // newline keeps one unbalanced quote from swallowing the whole file.
        if (c === '\n') break;
        j++;
      }
      const end = Math.min(j, n);
      blank(i, end);
      i = end;
      lastMeaningful = '"';
      lastWord = '';
      continue;
    }

    // --- regex literals -----------------------------------------------------
    if (profile.regexLiterals && ch === '/' && isRegexStart(lastMeaningful, lastWord)) {
      let j = i + 1;
      let inClass = false;
      let terminated = false;
      while (j < n) {
        const c = source[j]!;
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (c === '\n') break;
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) {
          j++;
          terminated = true;
          break;
        }
        j++;
      }
      if (terminated) {
        blank(i, j);
        i = j;
        lastMeaningful = '/';
        lastWord = '';
        continue;
      }
      // Unterminated — it was division after all. Fall through.
    }

    // --- ordinary code ------------------------------------------------------
    if (ch === '{') {
      braceDepth++;
    } else if (ch === '}') {
      braceDepth--;
      if (templateStack.length > 0 && templateStack[templateStack.length - 1] === braceDepth) {
        templateStack.pop();
        blank(i, i + 1);
        i = enterTemplate(i + 1);
        continue;
      }
    }

    if (ch.trim() !== '') {
      lastMeaningful = ch;
      lastWord = /[A-Za-z_$]/.test(ch) ? lastWord + ch : '';
    }
    i++;
  }

  return out.join('');
}

function matchAny(source: string, at: number, needles: readonly string[]): number {
  for (const needle of needles) {
    if (source.startsWith(needle, at)) return needle.length;
  }
  return 0;
}

function isRegexStart(lastMeaningful: string, lastWord: string): boolean {
  if (lastMeaningful === '') return true;
  if (REGEX_PRECEDING_KEYWORDS.has(lastWord)) return true;
  return REGEX_PRECEDERS.has(lastMeaningful);
}
