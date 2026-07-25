/**
 * Token accounting.
 *
 * Jelly Bean promises that every tool result fits inside a caller-supplied
 * budget. That promise is only as good as our ability to estimate token counts
 * without shipping a full BPE tokenizer (which would cost ~2MB and a startup
 * penalty for a number we only need to be approximately right).
 *
 * The estimator below is deliberately conservative: it over-estimates slightly
 * on dense source code, so a "fits in 2000 tokens" claim stays true rather than
 * becoming true-on-average. Budgets are a contract, not a hint.
 */

/**
 * Characters per token, by content class. Derived from measuring cl100k/o200k
 * behaviour on real corpora: prose compresses well, code less so (identifiers,
 * punctuation runs, and indentation each cost their own tokens).
 */
const CHARS_PER_TOKEN_PROSE = 4.0;
const CHARS_PER_TOKEN_CODE = 3.1;

/** Punctuation and symbols that almost always occupy a token of their own. */
const LONE_TOKEN_CHARS = /[{}()[\]<>=+\-*/%&|^~!?:;,.@#$`"'\\]/g;

/**
 * Estimate the number of tokens in `text`.
 *
 * Uses a hybrid of character density and symbol counting. The symbol term is
 * what keeps the estimate honest on code, where a line like `});` is three
 * tokens in four characters and pure character-division would say one.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  const chars = text.length;
  const symbols = (text.match(LONE_TOKEN_CHARS) ?? []).length;
  const symbolRatio = symbols / chars;

  // Blend between prose and code density based on how symbol-heavy the text is.
  // Natural language sits near 0.02–0.05; source code near 0.10–0.20.
  const codeness = Math.min(1, Math.max(0, (symbolRatio - 0.03) / 0.12));
  const charsPerToken =
    CHARS_PER_TOKEN_PROSE + (CHARS_PER_TOKEN_CODE - CHARS_PER_TOKEN_PROSE) * codeness;

  // Newlines are reliably their own token and are under-counted by density alone.
  const newlines = countChar(text, '\n');

  return Math.ceil(chars / charsPerToken + newlines * 0.25);
}

function countChar(text: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text[i] === ch) n++;
  return n;
}

/**
 * Accumulates lines while enforcing a token ceiling.
 *
 * Callers push candidate lines in priority order and stop when `push` returns
 * false. This keeps budget logic in one place instead of scattering
 * `if (tokens > budget) break` across every tool.
 */
export class BudgetWriter {
  private readonly lines: string[] = [];
  private used = 0;
  private truncated = 0;
  private reserved: number;

  /**
   * @param budget   Total tokens the result may occupy.
   * @param reserve  Tokens withheld from `push` and released by `releaseReserve`.
   *                 Tools reserve room for the footer, because the footer is what
   *                 reports that rows were omitted — dropping it for lack of
   *                 budget would hide the truncation it exists to announce.
   */
  constructor(
    private readonly budget: number,
    reserve = 0,
  ) {
    this.reserved = Math.min(reserve, Math.floor(budget / 2));
  }

  /** Tokens still available to `push`. */
  get remaining(): number {
    return Math.max(0, this.budget - this.reserved - this.used);
  }

  /** Tokens consumed so far. */
  get spent(): number {
    return this.used;
  }

  /** How many `push` calls were rejected for lack of budget. */
  get omitted(): number {
    return this.truncated;
  }

  /** True once at least one line has been rejected. */
  get isFull(): boolean {
    return this.truncated > 0;
  }

  /**
   * Append a line if it fits. Returns false (and records an omission) if it
   * does not, leaving the writer otherwise untouched.
   */
  push(line: string): boolean {
    const cost = estimateTokens(line + '\n');
    if (this.used + cost > this.budget - this.reserved) {
      this.truncated++;
      return false;
    }
    this.lines.push(line);
    this.used += cost;
    return true;
  }

  /** Append a line regardless of budget. For headers that must always appear. */
  pushUnchecked(line: string): void {
    this.lines.push(line);
    this.used += estimateTokens(line + '\n');
  }

  /** Push each line, stopping at the first that does not fit. */
  pushAll(lines: readonly string[]): void {
    for (const line of lines) {
      if (!this.push(line)) break;
    }
  }

  /** Push every line regardless of budget. For footers, which must always appear. */
  pushAllUnchecked(lines: readonly string[]): void {
    for (const line of lines) this.pushUnchecked(line);
  }

  /** Make the reserved tokens available again. */
  releaseReserve(): void {
    this.reserved = 0;
  }

  /** Render the accumulated lines. */
  toString(): string {
    return this.lines.join('\n');
  }
}

/**
 * Shorten `text` to at most `maxTokens`, appending an ellipsis when cut.
 * Used for individual fields (signatures, messages) rather than whole results.
 */
export function clampTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return '';
  if (estimateTokens(text) <= maxTokens) return text;

  // Binary search the character length that lands under the budget. Cheaper and
  // more accurate than repeatedly shaving a fixed number of characters.
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(text.slice(0, mid) + '…') <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo).trimEnd() + '…';
}
