#!/usr/bin/env node
/**
 * A guided tour of every tool, run against a real repository.
 *
 * This exists because "an MCP server" is hard to evaluate: normally the only way
 * to see what it does is to wire it into an agent and hope the agent chooses to
 * call it. This drives the tools directly and prints exactly what a model would
 * receive, so you can judge the output yourself.
 *
 *   node scripts/demo.mjs                 # tour this repository
 *   node scripts/demo.mjs /path/to/repo   # tour any repository
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
const dist = join(projectRoot, 'dist');

let modules;
try {
  modules = {
    config: await import(pathToUrl(join(dist, 'config.js'))),
    index: await import(pathToUrl(join(dist, 'core/code-index.js'))),
    handles: await import(pathToUrl(join(dist, 'core/handles.js'))),
    notes: await import(pathToUrl(join(dist, 'core/notes.js'))),
    workspace: await import(pathToUrl(join(dist, 'core/workspace.js'))),
    tokens: await import(pathToUrl(join(dist, 'core/tokens.js'))),
    map: await import(pathToUrl(join(dist, 'tools/map.js'))),
    outline: await import(pathToUrl(join(dist, 'tools/outline.js'))),
    search: await import(pathToUrl(join(dist, 'tools/search.js'))),
    read: await import(pathToUrl(join(dist, 'tools/read.js'))),
    trace: await import(pathToUrl(join(dist, 'tools/trace.js'))),
    diagnose: await import(pathToUrl(join(dist, 'tools/diagnose.js'))),
    notesTool: await import(pathToUrl(join(dist, 'tools/notes.js'))),
    changes: await import(pathToUrl(join(dist, 'tools/changes.js'))),
    define: await import(pathToUrl(join(dist, 'tools/define.js'))),
  };
} catch (error) {
  process.stderr.write(`Could not load the build. Run "npm run build" first.\n\n${error.message}\n`);
  process.exit(1);
}

function pathToUrl(absolute) {
  return new URL(`file://${absolute.replace(/\\/g, '/')}`).href;
}

const { estimateTokens } = modules.tokens;

// Arguments: an optional path, and an optional `--check <name>` to actually run
// one of the project's checks rather than only listing them.
const argv = process.argv.slice(2);
let requestedCheck;
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--check') requestedCheck = argv[++i];
  else positional.push(argv[i]);
}
const target = resolve(positional[0] ?? projectRoot);

// --- set up the same state the MCP server would hold ------------------------

const { config } = modules.config.parseArgs([target]);
const workspace = new modules.workspace.Workspace(config.root, config.ignore);
const ctx = {
  config,
  workspace,
  index: new modules.index.CodeIndex(workspace, config),
  handles: new modules.handles.HandleStore(),
  notes: modules.notes.NotesStore.forWorkspace(config.root, config.notesPath),
};

const BAR = '─'.repeat(76);
let totalSpent = 0;

function section(title, explanation) {
  process.stdout.write(`\n${BAR}\n  ${title}\n  ${explanation}\n${BAR}\n`);
}

function show(call, output) {
  const cost = estimateTokens(output);
  totalSpent += cost;
  process.stdout.write(`\n  › ${call}\n\n`);
  process.stdout.write(
    output
      .split('\n')
      .map((line) => `    ${line}`)
      .join('\n'),
  );
  process.stdout.write(`\n\n    ~${cost} tokens\n`);
}

// --- the tour ---------------------------------------------------------------

process.stdout.write(`\n🍬  Jelly Bean — tour of ${config.root}\n`);
const started = Date.now();
await ctx.index.ensureFresh(true);
process.stdout.write(`    indexed ${ctx.index.fileCount} files in ${Date.now() - started}ms\n`);

if (ctx.index.fileCount === 0) {
  process.stdout.write('\n    Nothing indexed. Is that path a source repository?\n');
  process.exit(1);
}

section('1. jb_map — "what is in this repository?"', 'The layout, then the files that matter most, ranked by what imports them.');
show('jb_map {depth:"tree"}', await modules.map.runMap({ depth: 'tree', tokenBudget: 700 }, ctx));
show('jb_map {depth:"files", tokenBudget:600}', await modules.map.runMap({ tokenBudget: 600 }, ctx));

// Pick a file for the rest of the tour: the most structurally important one that
// is also substantial. A 40-line type module would understate what an outline
// saves; a fair demo wants a file of the size people actually complain about.
const candidates = ctx.index.all().filter((file) => !file.skipped && file.symbols.length > 2);
const byImportance = (a, b) => ctx.index.importance(b) - ctx.index.importance(a);
const substantial = candidates.filter((file) => file.lineCount >= 120).sort(byImportance);
const star = substantial[0] ?? candidates.sort(byImportance)[0];

if (!star) {
  process.stdout.write('\n    No files with extractable symbols; stopping the tour here.\n');
  process.exit(0);
}

section('2. jb_outline — "what is inside this file?"', `Every declaration in ${star.path}, with no function bodies at all.`);
const outline = await modules.outline.runOutline({ path: star.path, tokenBudget: 900 }, ctx);
show(`jb_outline {path:"${star.path}"}`, outline);

const rawFile = await readFile(join(config.root, star.path), 'utf8').catch(() => '');
if (rawFile) {
  const full = estimateTokens(rawFile);
  const cheap = estimateTokens(outline);
  process.stdout.write(
    `\n    Reading the whole file costs ~${full} tokens. The outline above cost ~${cheap} — ` +
      `${Math.round((1 - cheap / full) * 100)}% less, and it still names everything in there.\n`,
  );
}

section('3. jb_search — "where is this idea implemented?"', 'Ranked matching lines with the symbol enclosing each — not a list of files to open.');
const topic = star.symbols.find((s) => s.depth === 0 && s.name.length > 4)?.name ?? star.path;
show(`jb_search {query:"${topic}"}`, await modules.search.runSearch({ query: topic, tokenBudget: 700 }, ctx));

section('4. jb_read — "show me just that one thing"', 'Handles from any earlier result address an exact region. No whole-file reads.');
const handle = /jb_[0-9a-f]{8}/.exec(outline)?.[0];
if (handle) {
  show(`jb_read {handle:"${handle}"}   ← a handle copied from the outline above`, await modules.read.runRead({ handle, tokenBudget: 700 }, ctx));
}
show(
  `jb_read {path:"${star.path}", mode:"skeleton"}   ← the whole file, bodies elided`,
  await modules.read.runRead({ path: star.path, mode: 'skeleton', tokenBudget: 900 }, ctx),
);

section('5. jb_define — "where is this actually defined?"', "Follows the importing file's own imports, so it resolves rather than guesses.");
{
  const user = ctx.index.all().find((f) => f.imports.some((i) => i.names.length > 0));
  const ref = user?.imports.find((i) => i.names.length > 0);
  if (user && ref) {
    show(
      `jb_define {symbol:"${ref.names[0]}", from:"${user.path}"}`,
      await modules.define.runDefine({ symbol: ref.names[0], from: user.path, tokenBudget: 500 }, ctx),
    );
  }
}

section('6. jb_trace — "what breaks if I change this?"', 'The import graph in both directions, with tests and entrypoints labelled.');
show(`jb_trace {path:"${star.path}", direction:"both"}`, await modules.trace.runTrace({ path: star.path, direction: 'both', tokenBudget: 700 }, ctx));

section('7. jb_changes — "what did I change, and what might it break?"', 'Your edits mapped onto the symbols they touched, plus what depends on them.');
show('jb_changes {}', await modules.changes.runChanges({ tokenBudget: 900 }, ctx));

section('8. jb_diagnose — "what is broken right now?"', 'Runs a check the project itself declares and returns problems, not log output.');
show('jb_diagnose {}   ← no arguments lists what it is willing to run', await modules.diagnose.runDiagnose({ tokenBudget: 700 }, ctx));

if (requestedCheck) {
  process.stdout.write(`\n    Running "${requestedCheck}" for real — this may take a moment.\n`);
  show(
    `jb_diagnose {check:"${requestedCheck}"}`,
    await modules.diagnose.runDiagnose({ check: requestedCheck, tokenBudget: 1500 }, ctx),
  );
} else {
  process.stdout.write(
    '\n    To actually run one, pass its name:\n' +
      `      node scripts/demo.mjs ${positional[0] ?? ''} --check <name>\n`.replace(/\s+--check/, ' --check') +
      '    It never uses a shell, and only runs checks this project declares.\n',
  );
}

section('9. jb_notes — "remember this for next time"', 'Findings persist in .jellybean/notes.json and resurface in jb_trace.');
show('jb_notes {action:"list"}', await modules.notesTool.runNotes({ action: 'list', tokenBudget: 400 }, ctx));

// --- the point --------------------------------------------------------------

let everything = 0;
for (const file of ctx.index.all()) {
  everything += estimateTokens(await readFile(join(config.root, file.path), 'utf8').catch(() => ''));
}

process.stdout.write(`\n${BAR}\n  The point\n${BAR}\n\n`);
process.stdout.write(`    Reading every file in this repository:  ~${everything.toLocaleString()} tokens\n`);
process.stdout.write(`    Everything printed above, in total:     ~${totalSpent.toLocaleString()} tokens\n`);
if (everything > 0) {
  process.stdout.write(`    That is ${Math.round((1 - totalSpent / everything) * 100)}% less, for a tour of the entire codebase.\n`);
}
process.stdout.write('\n    An agent would spend a fraction of even that, because it only\n');
process.stdout.write('    follows the handles it actually needs.\n\n');
