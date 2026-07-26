#!/usr/bin/env node
/**
 * Reproducible benchmark.
 *
 * Measures two things that matter and are easy to conflate:
 *
 *   1. **Latency** — how long each tool takes, cold and warm. Cold is the first
 *      index of a repository; warm is a restart with the parse cache present,
 *      which is what a real session almost always is.
 *
 *   2. **Token cost** — what a tool returns, against the baseline an agent
 *      without these tools would pay. The baseline is measured, not assumed:
 *      for orientation it is reading every file; for finding a concept it is
 *      grep-then-read-the-matching-files, which is what an agent actually does.
 *
 * Usage:
 *   node scripts/benchmark.mjs <repo> [<repo>...]
 *   node scripts/benchmark.mjs --markdown <repo>   # emit a README table
 */

import { readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(projectRoot, 'dist');

const load = async (relative) => import(new URL(`file://${join(dist, relative).replace(/\\/g, '/')}`).href);

const { parseArgs } = await load('config.js');
const { CodeIndex } = await load('core/code-index.js');
const { HandleStore } = await load('core/handles.js');
const { NotesStore } = await load('core/notes.js');
const { Workspace } = await load('core/workspace.js');
const { estimateTokens } = await load('core/tokens.js');
const { runMap } = await load('tools/map.js');
const { runOutline } = await load('tools/outline.js');
const { runSearch } = await load('tools/search.js');
const { runRead } = await load('tools/read.js');
const { runTrace } = await load('tools/trace.js');

const argv = process.argv.slice(2);
const markdown = argv.includes('--markdown');
const targets = argv.filter((a) => !a.startsWith('--'));

if (targets.length === 0) {
  process.stderr.write('usage: node scripts/benchmark.mjs [--markdown] <repo> [<repo>...]\n');
  process.exit(1);
}

/** Where the parse cache for a root lives, so a cold run can remove it. */
function cachePath(root) {
  const base = process.env['XDG_CACHE_HOME'] ?? join(homedir(), '.cache');
  return join(base, 'jellybean', `${createHash('sha1').update(root).digest('hex').slice(0, 16)}.json`);
}

function makeContext(root) {
  const { config } = parseArgs([root]);
  const workspace = new Workspace(config.root, config.ignore);
  return {
    config,
    workspace,
    index: new CodeIndex(workspace, config),
    handles: new HandleStore(),
    notes: NotesStore.forWorkspace(config.root, config.notesPath),
  };
}

async function timed(fn) {
  const started = performance.now();
  const value = await fn();
  return { ms: performance.now() - started, value };
}

const results = [];

for (const target of targets) {
  const root = resolve(target);
  const label = root.split('/').filter(Boolean).pop();

  // --- cold: no cache, nothing warmed -------------------------------------
  await rm(cachePath(root), { force: true });
  const cold = await timed(() => {
    const ctx = makeContext(root);
    return ctx.index.ensureFresh(true).then(() => ctx);
  });

  const fileCount = cold.value.index.fileCount;
  if (fileCount === 0) {
    process.stderr.write(`${label}: nothing indexed; skipping\n`);
    continue;
  }

  // --- warm: cache present, fresh index ------------------------------------
  const warm = await timed(() => {
    const ctx = makeContext(root);
    return ctx.index.ensureFresh(true).then(() => ctx);
  });
  const ctx = warm.value;
  ctx.index.startWatching();

  // Pick subjects from the repository itself rather than hard-coding names.
  const parsed = ctx.index.all().filter((f) => !f.skipped && f.symbols.length > 2);
  const byImportance = [...parsed].sort((a, b) => ctx.index.importance(b) - ctx.index.importance(a));
  const subject = byImportance.find((f) => f.lineCount >= 120) ?? byImportance[0];
  const biggest = [...parsed].sort((a, b) => b.lineCount - a.lineCount)[0];
  const topic = subject.symbols.find((s) => s.depth === 0 && s.name.length > 4)?.name ?? 'error';

  const calls = {
    map: await timed(() => runMap({ tokenBudget: 2000 }, ctx)),
    mapTree: await timed(() => runMap({ depth: 'tree', tokenBudget: 2000 }, ctx)),
    outline: await timed(() => runOutline({ path: subject.path, tokenBudget: 2000 }, ctx)),
    outlineBiggest: await timed(() => runOutline({ path: biggest.path, tokenBudget: 2000 }, ctx)),
    search: await timed(() => runSearch({ query: topic, tokenBudget: 2000 }, ctx)),
    searchSymbol: await timed(() => runSearch({ query: topic, mode: 'symbol', tokenBudget: 2000 }, ctx)),
    trace: await timed(() => runTrace({ path: subject.path, tokenBudget: 2000 }, ctx)),
    skeleton: await timed(() => runRead({ path: subject.path, mode: 'skeleton', tokenBudget: 4000 }, ctx)),
  };

  // --- baselines: what the same questions cost without these tools ---------
  let wholeRepoTokens = 0;
  for (const file of ctx.index.all()) {
    wholeRepoTokens += estimateTokens(await readFile(join(root, file.path), 'utf8').catch(() => ''));
  }

  const subjectSource = await readFile(join(root, subject.path), 'utf8').catch(() => '');
  const subjectTokens = estimateTokens(subjectSource);

  // The grep baseline: an agent greps, then reads every file that matched,
  // because a match alone does not tell it whether the file is relevant.
  const grepHits = ctx.index
    .searchFiles(topic, 500)
    .map((hit) => hit.file)
    .filter((f) => !f.skipped);
  let grepBaselineTokens = 0;
  for (const file of grepHits.slice(0, 20)) {
    grepBaselineTokens += estimateTokens(await readFile(join(root, file.path), 'utf8').catch(() => ''));
  }

  ctx.index.stopWatching();

  results.push({
    label,
    fileCount,
    coldMs: cold.ms,
    warmMs: warm.ms,
    heapMb: process.memoryUsage().heapUsed / 1048576,
    calls,
    subject: subject.path,
    subjectLines: subject.lineCount,
    subjectTokens,
    biggestLines: biggest.lineCount,
    topic,
    wholeRepoTokens,
    grepFiles: Math.min(grepHits.length, 20),
    grepBaselineTokens,
  });
}

// ---------------------------------------------------------------------------

const ms = (v) => `${v.toFixed(0)}ms`;
const tok = (v) => v.toLocaleString();

/**
 * A saving of 99.94% must not print as "100%": rounding a number up to a value
 * it never reached is the kind of small dishonesty that makes a whole benchmark
 * table suspect. Keep a decimal once the figure passes 99.5.
 */
const pct = (used, baseline) => {
  if (baseline <= 0) return '—';
  const saved = (1 - used / baseline) * 100;
  if (saved >= 99.95) return '99.9%';
  return saved >= 99.5 ? `${saved.toFixed(1)}%` : `${Math.round(saved)}%`;
};

if (markdown) {
  process.stdout.write('\n#### Latency\n\n');
  process.stdout.write('| Repository | Files | Cold index | Warm start | `jb_map` | `jb_outline` | `jb_search` | `jb_trace` |\n');
  process.stdout.write('|---|---|---|---|---|---|---|---|\n');
  for (const r of results) {
    process.stdout.write(
      `| ${r.label} | ${r.fileCount.toLocaleString()} | ${ms(r.coldMs)} | ${ms(r.warmMs)} | ${ms(r.calls.map.ms)} | ${ms(r.calls.outline.ms)} | ${ms(r.calls.search.ms)} | ${ms(r.calls.trace.ms)} |\n`,
    );
  }

  process.stdout.write('\n#### Token cost against the baseline\n\n');
  process.stdout.write('| Repository | Question | Baseline | Jelly Bean | Saved |\n');
  process.stdout.write('|---|---|---|---|---|\n');
  for (const r of results) {
    const mapTokens = estimateTokens(r.calls.map.value);
    const treeTokens = estimateTokens(r.calls.mapTree.value);
    const outlineTokens = estimateTokens(r.calls.outline.value);
    const searchTokens = estimateTokens(r.calls.search.value);
    process.stdout.write(
      `| ${r.label} | Orient in the repo | ${tok(r.wholeRepoTokens)} (read all ${r.fileCount.toLocaleString()} files) | ${tok(treeTokens)} \`jb_map\` tree | **${pct(treeTokens, r.wholeRepoTokens)}** |\n`,
    );
    process.stdout.write(
      `| | Rank what matters | ${tok(r.wholeRepoTokens)} | ${tok(mapTokens)} \`jb_map\` files | **${pct(mapTokens, r.wholeRepoTokens)}** |\n`,
    );
    process.stdout.write(
      `| | What is in \`${r.subject}\`? | ${tok(r.subjectTokens)} (read it) | ${tok(outlineTokens)} \`jb_outline\` | **${pct(outlineTokens, r.subjectTokens)}** |\n`,
    );
    process.stdout.write(
      `| | Where is \`${r.topic}\`? | ${tok(r.grepBaselineTokens)} (grep → read ${r.grepFiles} files) | ${tok(searchTokens)} \`jb_search\` | **${pct(searchTokens, r.grepBaselineTokens)}** |\n`,
    );
  }
  process.stdout.write('\n');
} else {
  for (const r of results) {
    process.stdout.write(`\n=== ${r.label} — ${r.fileCount.toLocaleString()} files ===\n`);
    process.stdout.write(`  cold index          ${ms(r.coldMs).padStart(9)}\n`);
    process.stdout.write(`  warm start          ${ms(r.warmMs).padStart(9)}   (parse cache present)\n`);
    process.stdout.write(`  heap                ${r.heapMb.toFixed(0).padStart(6)} MB\n`);
    process.stdout.write('  --- tool latency ---\n');
    for (const [name, call] of Object.entries(r.calls)) {
      process.stdout.write(`  ${name.padEnd(18)}  ${ms(call.ms).padStart(9)}   ${estimateTokens(call.value)} tok\n`);
    }
    process.stdout.write('  --- token cost vs baseline ---\n');
    const treeTokens = estimateTokens(r.calls.mapTree.value);
    const outlineTokens = estimateTokens(r.calls.outline.value);
    const searchTokens = estimateTokens(r.calls.search.value);
    process.stdout.write(
      `  orient:   ${tok(r.wholeRepoTokens)} → ${tok(treeTokens)}   (${pct(treeTokens, r.wholeRepoTokens)} less)\n`,
    );
    process.stdout.write(
      `  outline:  ${tok(r.subjectTokens)} → ${tok(outlineTokens)}   (${pct(outlineTokens, r.subjectTokens)} less)  ${r.subject}\n`,
    );
    process.stdout.write(
      `  search:   ${tok(r.grepBaselineTokens)} → ${tok(searchTokens)}   (${pct(searchTokens, r.grepBaselineTokens)} less)  "${r.topic}" over ${r.grepFiles} matching files\n`,
    );
  }
  process.stdout.write('\n');
}
