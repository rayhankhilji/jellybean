/**
 * Server assembly: shared state, tool registration, resources, and prompts.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { JellyBeanConfig } from './config.js';
import { CodeIndex } from './core/code-index.js';
import { HandleStore } from './core/handles.js';
import { NotesStore } from './core/notes.js';
import { Workspace } from './core/workspace.js';
import { discoverChecks } from './diagnostics/runner.js';
import { guard, type ToolContext } from './tools/context.js';
import { mapSchema, runMap } from './tools/map.js';
import { outlineSchema, runOutline } from './tools/outline.js';
import { runSearch, searchSchema } from './tools/search.js';
import { readSchema, runRead } from './tools/read.js';
import { runTrace, traceSchema } from './tools/trace.js';
import { diagnoseSchema, runDiagnose } from './tools/diagnose.js';
import { notesSchema, runNotes } from './tools/notes.js';

export const SERVER_NAME = 'jellybean';
export const SERVER_VERSION = '1.0.0';

/**
 * Guidance sent to the client at initialization.
 *
 * Worth its length: a model that knows the intended call order makes two cheap
 * calls where it would otherwise make eight expensive ones. The whole design
 * only pays off if the client understands the handle-then-expand rhythm.
 */
const INSTRUCTIONS = `Jelly Bean gives you structural access to a codebase under an explicit token budget.

Work outside-in:
  1. jb_map      — what is in this repository, ranked by importance. Start here.
  2. jb_outline  — one file's declarations without their bodies (~10x cheaper than reading it).
  3. jb_search   — ranked search returning matched lines, not whole files.
  4. jb_read     — read a specific region, usually via a handle from step 1–3.
  5. jb_trace    — what depends on this symbol or file, and what it depends on.
  6. jb_diagnose — run a project check; get parsed problems instead of a raw log.
  7. jb_notes    — record and recall findings across sessions.

Handles: results contain ids like jb_3f9a21c4 that address an exact region. Pass one to
jb_read instead of a path when you can — it is precise and already scoped to the symbol.

Budgets: every tool takes tokenBudget and will fit inside it, telling you in the footer what
it omitted and which call would reveal it. Prefer a small budget and a follow-up call over a
large budget spent on output you will not read.

Before reading a whole file, try jb_outline on it, or jb_read with mode:"skeleton".`;

export interface JellyBean {
  server: McpServer;
  context: ToolContext;
}

export function createServer(config: JellyBeanConfig): JellyBean {
  const workspace = new Workspace(config.root, config.ignore);
  const context: ToolContext = {
    config,
    workspace,
    index: new CodeIndex(workspace, config),
    handles: new HandleStore(),
    notes: NotesStore.forWorkspace(config.root, config.notesPath),
  };

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, resources: {}, prompts: {} }, instructions: INSTRUCTIONS },
  );

  registerTools(server, context);
  registerResources(server, context);
  registerPrompts(server);

  return { server, context };
}

function registerTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'jb_map',
    {
      title: 'Map the repository',
      description:
        'Orient yourself in a codebase. Returns files ranked by structural importance — what other files import — with languages, sizes, and optionally their top-level symbols. Use focus to rank by topic instead. Start here in an unfamiliar repository.',
      inputSchema: mapSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guard(runMap, ctx),
  );

  server.registerTool(
    'jb_outline',
    {
      title: 'Outline a file or directory',
      description:
        "A file's declarations — classes, functions, methods, types — with signatures and line ranges, but without bodies. Roughly a tenth the cost of reading the file and usually enough to decide what to read next. Every symbol comes with a handle.",
      inputSchema: outlineSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guard(runOutline, ctx),
  );

  server.registerTool(
    'jb_search',
    {
      title: 'Search the codebase',
      description:
        'Relevance-ranked search that returns matching lines with their enclosing symbol, not a list of files to open. Natural words work — "retry backoff" finds retryWithBackoff. Use mode:"symbol" for declaration names only, or mode:"regex" for an exact pattern.',
      inputSchema: searchSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guard(runSearch, ctx),
  );

  server.registerTool(
    'jb_read',
    {
      title: 'Read a region of code',
      description:
        'Read exactly one region: a handle from an earlier result, a named symbol, or a line range. Prefer this over reading whole files. mode:"skeleton" returns a full file with function bodies elided when you want structure rather than implementation.',
      inputSchema: readSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guard(runRead, ctx),
  );

  server.registerTool(
    'jb_trace',
    {
      title: 'Trace dependencies and references',
      description:
        'Answer "what breaks if I change this?". Walks the import graph in either direction and, for a symbol, finds its actual reference sites — labelling which are tests, examples, or entrypoints. Call before editing anything shared.',
      inputSchema: traceSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guard(runTrace, ctx),
  );

  server.registerTool(
    'jb_diagnose',
    {
      title: 'Run a check and parse its problems',
      description:
        "Run one of the project's own checks (tests, typecheck, lint, build) and get back deduplicated problems with file, line, and surrounding source — instead of thousands of log lines. Call with no arguments to list what this project offers. Never invokes a shell.",
      inputSchema: diagnoseSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guard(runDiagnose, ctx),
  );

  server.registerTool(
    'jb_notes',
    {
      title: 'Record and recall findings',
      description:
        'Persist a conclusion about this codebase so a later session does not have to re-derive it. Notes anchored to paths surface automatically in jb_trace. Stored as JSON inside the workspace, so humans can read and commit them.',
      inputSchema: notesSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guard(runNotes, ctx),
  );
}

/**
 * Resources mirror the cheapest tool calls.
 *
 * A client that can attach resources directly gets the repository map without
 * spending a tool call and a round of reasoning on deciding to ask for it.
 */
function registerResources(server: McpServer, ctx: ToolContext): void {
  server.registerResource(
    'repository-map',
    'jellybean://map',
    {
      title: 'Repository map',
      description: 'Files ranked by structural importance, with languages and symbol counts.',
      mimeType: 'text/plain',
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/plain', text: await runMap({ depth: 'files' }, ctx) }],
    }),
  );

  server.registerResource(
    'project-checks',
    'jellybean://checks',
    {
      title: 'Available checks',
      description: 'Test, lint, build, and typecheck commands discovered from this project.',
      mimeType: 'text/plain',
    },
    async (uri) => {
      const checks = await discoverChecks(ctx.workspace);
      const text =
        checks.length === 0
          ? 'No checks discovered.'
          : checks.map((check) => `${check.name}  →  ${check.argv.join(' ')}  (${check.origin})`).join('\n');
      return { contents: [{ uri: uri.href, mimeType: 'text/plain', text }] };
    },
  );

  server.registerResource(
    'findings',
    'jellybean://notes',
    {
      title: 'Recorded findings',
      description: 'Notes previous sessions saved about this codebase.',
      mimeType: 'text/plain',
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/plain', text: await runNotes({ action: 'list' }, ctx) }],
    }),
  );
}

function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'onboard',
    {
      title: 'Get oriented in this codebase',
      description: 'A token-efficient tour: the map, then the most important files, then recorded findings.',
    },
    () => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              'Get oriented in this codebase using Jelly Bean, spending as few tokens as possible.',
              '',
              '1. jb_map with depth:"tree" to see the layout.',
              '2. jb_map with depth:"symbols" on the one or two directories that look like the core.',
              '3. jb_notes with action:"list" to pick up what earlier sessions already worked out.',
              '4. jb_outline on the two or three highest-ranked files only.',
              '',
              'Then summarise: what this project does, how it is organised, and where the entrypoints are.',
              'Do not read whole files — use outlines and skeletons.',
            ].join('\n'),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'fix-failures',
    {
      title: 'Run the checks and fix what fails',
      description: 'Diagnose, locate, fix, and re-verify — the autonomous debugging loop.',
    },
    () => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              'Find and fix what is currently broken in this project.',
              '',
              '1. jb_diagnose with no arguments to see which checks exist.',
              '2. Run the most relevant one and read the parsed problems.',
              '3. For each problem, jb_read the handle it came with to see the real code.',
              '4. Before editing anything shared, jb_trace it to see what else would be affected.',
              '5. Fix, then re-run jb_diagnose to confirm.',
              '',
              'Record anything non-obvious you learn with jb_notes so the next session starts ahead.',
            ].join('\n'),
          },
        },
      ],
    }),
  );
}
