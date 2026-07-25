/** Shared plumbing for tool handlers. */

import { z } from 'zod';
import { MAX_TOKEN_BUDGET, type JellyBeanConfig } from '../config.js';
import type { CodeIndex } from '../core/code-index.js';
import type { HandleStore } from '../core/handles.js';
import type { NotesStore } from '../core/notes.js';
import type { Workspace } from '../core/workspace.js';

export interface ToolContext {
  config: JellyBeanConfig;
  workspace: Workspace;
  index: CodeIndex;
  handles: HandleStore;
  notes: NotesStore;
}

/** The token budget argument, shared verbatim by every tool that produces rows. */
export const tokenBudgetArg = z
  .number()
  .int()
  .min(100)
  .max(MAX_TOKEN_BUDGET)
  .optional()
  .describe(
    `Maximum tokens the result may occupy (default 2000, ceiling ${MAX_TOKEN_BUDGET}). The tool degrades detail to fit rather than truncating mid-row.`,
  );

/** Clamp a requested budget to what this server is configured to allow. */
export function resolveBudget(ctx: ToolContext, requested: number | undefined): number {
  if (requested === undefined) return ctx.config.defaultTokenBudget;
  return Math.min(Math.max(requested, 100), ctx.config.maxTokenBudget);
}

/** MCP tool results are a content array; every Jelly Bean tool returns one text block. */
export function textResult(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] };
}

/**
 * Wrap a handler so a thrown error becomes a readable message instead of a
 * transport-level failure. An agent can act on "no such file"; it cannot act on
 * a dropped connection.
 */
export function guard<Args>(
  handler: (args: Args, ctx: ToolContext) => Promise<string>,
  ctx: ToolContext,
): (args: Args) => Promise<ReturnType<typeof textResult> & { isError?: boolean }> {
  return async (args: Args) => {
    try {
      return textResult(await handler(args, ctx));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ...textResult(`error: ${message}`), isError: true };
    }
  };
}
