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
 * Character codes, because this scanner runs over every byte of every file.
 *
 * The obvious implementation — index the string, compare characters, build an
 * array of one-character strings and join it — costs a string allocation per
 * byte. Over a large repository that is the single most expensive thing the
 * indexer does. Working in code points and writing into a typed array is the
 * same algorithm at a fraction of the price.
 */
const enum Ch {
  Tab = 9,
  Newline = 10,
  Return = 13,
  Space = 32,
  Bang = 33,
  Quote = 34,
  Hash = 35,
  Dollar = 36,
  Percent = 37,
  Amp = 38,
  Apostrophe = 39,
  LParen = 40,
  Star = 42,
  Plus = 43,
  Comma = 44,
  Minus = 45,
  Slash = 47,
  Colon = 58,
  Semicolon = 59,
  Lt = 60,
  Eq = 61,
  Gt = 62,
  Question = 63,
  LBracket = 91,
  Backslash = 92,
  RBracket = 93,
  Caret = 94,
  Underscore = 95,
  Backtick = 96,
  LBrace = 123,
  Pipe = 124,
  RBrace = 125,
  Tilde = 126,
}

/**
 * Characters that, when they are the last meaningful character before a `/`,
 * mean the `/` opens a regex literal rather than being division.
 */
const REGEX_PRECEDERS = new Set<number>([
  Ch.LParen, Ch.Comma, Ch.Eq, Ch.Colon, Ch.LBracket, Ch.Bang, Ch.Amp, Ch.Pipe, Ch.Question,
  Ch.LBrace, Ch.RBrace, Ch.Semicolon, Ch.Plus, Ch.Minus, Ch.Star, Ch.Percent, Ch.Tilde,
  Ch.Caret, Ch.Lt, Ch.Gt,
]);

const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'case', 'do', 'else', 'yield', 'await',
]);

/** Longest keyword above; a word longer than this cannot be one. */
const LONGEST_KEYWORD = 10;

function isWordChar(code: number): boolean {
  return (
    (code >= 97 && code <= 122) || // a-z
    (code >= 65 && code <= 90) || // A-Z
    code === Ch.Underscore ||
    code === Ch.Dollar
  );
}

function isSpace(code: number): boolean {
  return code === Ch.Space || code === Ch.Tab || code === Ch.Newline || code === Ch.Return;
}

/** Result of scanning one literal chunk of a template string. */
interface TemplateChunk {
  /** Index to resume the main scan from. */
  next: number;
  /** True when the chunk ended at `${`, meaning real code follows. */
  interpolating: boolean;
}

/**
 * Turn code points back into a string.
 *
 * `String.fromCharCode` is applied in chunks because spreading a few hundred
 * thousand arguments overflows the call stack.
 */
const MATERIALIZE_CHUNK = 8192;

function materialize(codes: Uint16Array, n: number): string {
  if (n <= MATERIALIZE_CHUNK) return String.fromCharCode.apply(null, codes.subarray(0, n) as unknown as number[]);

  let out = '';
  for (let i = 0; i < n; i += MATERIALIZE_CHUNK) {
    const end = Math.min(i + MATERIALIZE_CHUNK, n);
    out += String.fromCharCode.apply(null, codes.subarray(i, end) as unknown as number[]);
  }
  return out;
}

/**
 * Replace string and comment contents with spaces, preserving length and line
 * breaks. Delimiters themselves are also blanked, so `"abc"` becomes five
 * spaces — this prevents a stray quote from being mistaken for an identifier.
 */
export function maskSource(source: string, profile: SyntaxProfile): string {
  const n = source.length;
  const out = new Uint16Array(n);
  for (let i = 0; i < n; i++) out[i] = source.charCodeAt(i);

  /** Blank a half-open range, leaving newlines intact so lines still align. */
  const blank = (from: number, to: number): void => {
    const start = from < 0 ? 0 : from;
    const end = to > n ? n : to;
    for (let i = start; i < end; i++) {
      if (out[i] !== Ch.Newline) out[i] = Ch.Space;
    }
  };

  // Profile fields are read once rather than per character: the property lookups
  // and array iteration were a measurable share of the loop.
  const lineComments = profile.lineComment;
  const blockOpen = profile.blockComment?.[0];
  const blockClose = profile.blockComment?.[1];
  const nestedBlocks = profile.nestedBlockComment === true;
  const templates = profile.templates === true;
  const tripleQuotes = profile.tripleQuotes === true;
  const regexLiterals = profile.regexLiterals === true;
  const quoteCodes = profile.quotes.map((q) => q.charCodeAt(0));
  const lineCommentStarts = lineComments.map((c) => c.charCodeAt(0));
  const blockOpenFirst = blockOpen === undefined ? -1 : blockOpen.charCodeAt(0);

  /**
   * Depths at which each open `${` sat. When a `}` brings us back to a recorded
   * depth we know it closes an interpolation, not an ordinary block.
   */
  const templateStack: number[] = [];
  let braceDepth = 0;
  let lastMeaningful = -1;
  /** Start of the identifier run ending at the last meaningful character, or -1. */
  let wordStart = -1;

  /** Scan the literal text of a template starting just after a backtick or `}`. */
  const maskTemplateChunk = (from: number): TemplateChunk => {
    let j = from;
    while (j < n) {
      const c = source.charCodeAt(j);
      if (c === Ch.Backslash) {
        blank(j, j + 2);
        j += 2;
        continue;
      }
      if (c === Ch.Backtick) {
        blank(j, j + 1);
        return { next: j + 1, interpolating: false };
      }
      if (c === Ch.Dollar && source.charCodeAt(j + 1) === Ch.LBrace) {
        blank(j, j + 2);
        return { next: j + 2, interpolating: true };
      }
      blank(j, j + 1);
      j++;
    }
    return { next: n, interpolating: false };
  };

  /** Shared bookkeeping for entering a template chunk from a backtick or from `}`. */
  const enterTemplate = (from: number): number => {
    const chunk = maskTemplateChunk(from);
    if (chunk.interpolating) {
      templateStack.push(braceDepth);
      braceDepth++;
    }
    lastMeaningful = Ch.Backtick;
    wordStart = -1;
    return chunk.next;
  };

  let i = 0;
  while (i < n) {
    const ch = out[i]!;

    // --- comments -----------------------------------------------------------
    if (lineCommentStarts.includes(ch) && matchAny(source, i, lineComments) > 0) {
      let end = source.indexOf('\n', i);
      if (end === -1) end = n;
      blank(i, end);
      i = end;
      continue;
    }

    if (ch === blockOpenFirst && blockOpen !== undefined && blockClose !== undefined && source.startsWith(blockOpen, i)) {
      let depth = 1;
      let j = i + blockOpen.length;
      while (j < n && depth > 0) {
        if (nestedBlocks && source.startsWith(blockOpen, j)) {
          depth++;
          j += blockOpen.length;
        } else if (source.startsWith(blockClose, j)) {
          depth--;
          j += blockClose.length;
        } else {
          j++;
        }
      }
      blank(i, j);
      i = j;
      lastMeaningful = Ch.Semicolon; // a comment cannot make the next `/` a division
      wordStart = -1;
      continue;
    }

    // --- triple-quoted strings (Python docstrings) --------------------------
    if (tripleQuotes && (ch === Ch.Quote || ch === Ch.Apostrophe) && source.charCodeAt(i + 1) === ch && source.charCodeAt(i + 2) === ch) {
      let j = i + 3;
      while (j < n) {
        const c = source.charCodeAt(j);
        if (c === Ch.Backslash) {
          j += 2;
          continue;
        }
        if (c === ch && source.charCodeAt(j + 1) === ch && source.charCodeAt(j + 2) === ch) {
          j += 3;
          break;
        }
        j++;
      }
      const end = j > n ? n : j;
      blank(i, end);
      i = end;
      continue;
    }

    // --- template literals --------------------------------------------------
    if (templates && ch === Ch.Backtick) {
      blank(i, i + 1);
      i = enterTemplate(i + 1);
      continue;
    }

    // --- plain strings ------------------------------------------------------
    if (quoteCodes.includes(ch)) {
      let j = i + 1;
      while (j < n) {
        const c = source.charCodeAt(j);
        if (c === Ch.Backslash) {
          j += 2;
          continue;
        }
        if (c === ch) {
          j++;
          break;
        }
        // These languages have no multi-line plain strings. Stopping at the
        // newline keeps one unbalanced quote from swallowing the whole file.
        if (c === Ch.Newline) break;
        j++;
      }
      const end = j > n ? n : j;
      blank(i, end);
      i = end;
      lastMeaningful = Ch.Quote;
      wordStart = -1;
      continue;
    }

    // --- regex literals -----------------------------------------------------
    if (regexLiterals && ch === Ch.Slash && isRegexStart(lastMeaningful, source, wordStart, i)) {
      let j = i + 1;
      let inClass = false;
      let terminated = false;
      while (j < n) {
        const c = source.charCodeAt(j);
        if (c === Ch.Backslash) {
          j += 2;
          continue;
        }
        if (c === Ch.Newline) break;
        if (c === Ch.LBracket) inClass = true;
        else if (c === Ch.RBracket) inClass = false;
        else if (c === Ch.Slash && !inClass) {
          j++;
          terminated = true;
          break;
        }
        j++;
      }
      if (terminated) {
        blank(i, j);
        i = j;
        lastMeaningful = Ch.Slash;
        wordStart = -1;
        continue;
      }
      // Unterminated — it was division after all. Fall through.
    }

    // --- ordinary code ------------------------------------------------------
    if (ch === Ch.LBrace) {
      braceDepth++;
    } else if (ch === Ch.RBrace) {
      braceDepth--;
      if (templateStack.length > 0 && templateStack[templateStack.length - 1] === braceDepth) {
        templateStack.pop();
        blank(i, i + 1);
        i = enterTemplate(i + 1);
        continue;
      }
    }

    if (!isSpace(ch)) {
      lastMeaningful = ch;
      // The word is remembered as a position rather than accumulated into a
      // string: only a `/` ever asks what it was, and that is rare.
      if (isWordChar(ch)) {
        if (wordStart === -1) wordStart = i;
      } else {
        wordStart = -1;
      }
    }
    i++;
  }

  return materialize(out, n);
}

function matchAny(source: string, at: number, needles: readonly string[]): number {
  for (const needle of needles) {
    if (source.startsWith(needle, at)) return needle.length;
  }
  return 0;
}

/**
 * Whether a `/` at `at` opens a regex literal rather than dividing.
 *
 * `wordStart` locates the identifier run that ended at the last meaningful
 * character, so the keyword check costs one slice on the rare occasions a `/`
 * follows a word at all.
 */
function isRegexStart(lastMeaningful: number, source: string, wordStart: number, at: number): boolean {
  if (lastMeaningful === -1) return true;
  if (wordStart !== -1) {
    let end = at;
    while (end > wordStart && !isWordChar(source.charCodeAt(end - 1))) end--;
    if (end - wordStart <= LONGEST_KEYWORD && REGEX_PRECEDING_KEYWORDS.has(source.slice(wordStart, end))) return true;
  }
  return REGEX_PRECEDERS.has(lastMeaningful);
}
