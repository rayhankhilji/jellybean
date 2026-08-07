#!/usr/bin/env node
/**
 * Head-to-head: Jelly Bean against the MCP servers people actually install.
 *
 * Five questions an agent genuinely asks about an unfamiliar codebase. Each
 * server is given its own best tool for the job — not a like-for-like call, but
 * the call its own documentation would tell you to make.
 *
 * Tokens are counted with a real BPE tokenizer (cl100k), not Jelly Bean's own
 * estimator, because grading your own homework is not a benchmark.
 *
 * Accuracy is checked against ground truth established independently with grep,
 * so "it answered" and "it answered correctly" stay separate columns.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFileSync } from 'node:fs';

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(process.argv[2] ?? '.');
const CALL_TIMEOUT = 900_000;

if (process.argv.length < 3) {
  process.stderr.write(
    'usage: node scripts/compare.mjs <repo>\n\n' +
      'Requires, for the servers you want to compare against:\n' +
      '  uvx  (https://docs.astral.sh/uv/)  for Serena\n' +
      '  npx                                for the filesystem server\n' +
      'Any that are missing are reported as unavailable rather than skipped silently.\n\n' +
      'Serena needs a language server configured for the project. On first run it\n' +
      'writes .serena/project.yml with `language_servers: []`, which answers nothing;\n' +
      'set it to your language (e.g. ["typescript"]) or the comparison is not a\n' +
      'comparison.\n',
  );
  process.exit(2);
}

/**
 * A real BPE tokenizer, not Jelly Bean's own estimator.
 *
 * The whole claim under test is token cost, so measuring it with the estimator
 * that Jelly Bean also uses to decide what to emit would be circular. It is not
 * a dependency of the project — nothing else needs it — so it is asked for
 * rather than assumed.
 */
let encode;
try {
  ({ encode } = await import('gpt-tokenizer'));
} catch {
  process.stderr.write(
    'This needs a real tokenizer so the comparison is not measured with our own ruler:\n' +
      '  npm install --no-save gpt-tokenizer\n',
  );
  process.exit(2);
}

const tokens = (text) => encode(text).length;

const SERVERS = {
  jellybean: {
    label: 'Jelly Bean',
    command: process.execPath,
    args: [`${projectRoot}/dist/index.js`, REPO],
  },
  serena: {
    label: 'Serena',
    command: 'uvx',
    args: [
      '--from', 'git+https://github.com/oraios/serena', 'serena', 'start-mcp-server',
      '--project', REPO, '--context', 'ide-assistant', '--enable-web-dashboard', 'false',
    ],
  },
  filesystem: {
    label: 'filesystem MCP',
    command: 'npx',
    args: ['@modelcontextprotocol/server-filesystem', REPO],
  },
};

/**
 * The questions. `expect` is a predicate over the returned text — ground truth,
 * verified separately with grep before any of this was written.
 */
const TASKS = [
  {
    id: 'orient',
    question: 'What is in this repository? (orient from cold)',
    truth: 'names the packages/ layout',
    expect: (t) => /packages/.test(t),
    calls: {
      jellybean: [{ name: 'jb_map', arguments: { depth: 'tree' } }],
      serena: null, // no directory-level tool in this context
      filesystem: [{ name: 'directory_tree', arguments: { path: REPO } }],
    },
  },
  {
    id: 'define',
    question: 'Where is `NestContainer` defined?',
    truth: 'packages/core/injector/container.ts',
    expect: (t) => /injector\/container\.ts/.test(t),
    calls: {
      jellybean: [{ name: 'jb_define', arguments: { symbol: 'NestContainer' } }],
      serena: [{ name: 'find_symbol', arguments: { name_path: 'NestContainer' } }],
      filesystem: [{ name: 'search_files', arguments: { path: REPO, pattern: '**/*container*' } }],
    },
  },
  {
    id: 'outline',
    question: 'What does packages/core/injector/container.ts contain?',
    truth: 'lists NestContainer and its methods',
    expect: (t) => /NestContainer/.test(t) && /addProvider|addModule|getModules/.test(t),
    calls: {
      jellybean: [{ name: 'jb_outline', arguments: { path: 'packages/core/injector/container.ts' } }],
      serena: [{ name: 'get_symbols_overview', arguments: { relative_path: 'packages/core/injector/container.ts', depth: 1 } }],
      filesystem: [{ name: 'read_text_file', arguments: { path: `${REPO}/packages/core/injector/container.ts` } }],
    },
  },
  {
    id: 'dependents',
    question: 'What depends on injector/container.ts?',
    truth: 'names files that import it, e.g. module.ts / nest-factory.ts',
    // Must identify importers specifically. A listing of every .ts file in the
    // repository contains the right names and answers nothing, so an answer
    // naming more than 300 files is treated as the non-answer it is.
    expect: (t) => /module\.ts|nest-factory\.ts|instance-loader\.ts/.test(t) && (t.match(/\.ts/g) ?? []).length < 300,
    calls: {
      jellybean: [{ name: 'jb_trace', arguments: { path: 'packages/core/injector/container.ts', direction: 'dependents' } }],
      serena: [{
        name: 'find_referencing_symbols',
        arguments: { name_path: 'NestContainer', relative_path: 'packages/core/injector/container.ts' },
      }],
      filesystem: [{ name: 'search_files', arguments: { path: REPO, pattern: '**/*.ts' } }],
    },
  },
  {
    id: 'concept',
    question: 'Where is dependency-injection scope handled?',
    truth: 'points at scope handling in packages/core or packages/common',
    // Must point at code, not merely at filenames: a list of paths whose names
    // contain "scope" does not say where scope is handled.
    expect: (t) => /scope/i.test(t) && /packages\/(core|common)/.test(t) && /:\d+|line|"start_line"/.test(t),
    calls: {
      jellybean: [{ name: 'jb_search', arguments: { query: 'dependency injection scope' } }],
      serena: [{ name: 'find_symbol', arguments: { name_path: 'Scope', substring_matching: true } }],
      filesystem: [{ name: 'search_files', arguments: { path: REPO, pattern: '**/*scope*' } }],
    },
  },
];

function textOf(result) {
  if (!result?.content) return '';
  return result.content.map((c) => c.text ?? '').join('\n');
}

async function runServer(key) {
  const spec = SERVERS[key];
  process.stderr.write(`\n--- ${spec.label} ---\n`);

  const startedAt = performance.now();
  const client = new Client({ name: 'compare', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: spec.command, args: spec.args, stderr: 'ignore' }), {
    timeout: CALL_TIMEOUT,
  });
  const handshakeMs = performance.now() - startedAt;

  const { tools } = await client.listTools();
  // What every conversation pays before asking anything: the tool descriptions
  // and schemas are sent to the model on connection.
  const toolOverhead = tokens(JSON.stringify(tools));

  // Cost to first answer: an LSP-backed server indexes on first use, so this is
  // a different question from steady-state latency and is measured separately.
  const warmupCall = TASKS.find((t) => t.calls[key] !== null).calls[key][0];
  const warmStart = performance.now();
  try {
    await client.callTool(warmupCall, undefined, { timeout: CALL_TIMEOUT });
  } catch { /* recorded as the failure it is by the task run below */ }
  const firstAnswerMs = Math.round(performance.now() - warmStart);
  process.stderr.write(`  handshake ${Math.round(handshakeMs)} ms, first answer ${firstAnswerMs} ms\n`);

  const results = {};
  for (const task of TASKS) {
    const calls = task.calls[key];
    if (calls === null) {
      results[task.id] = { skipped: true };
      process.stderr.write(`  ${task.id.padEnd(11)} — no tool for this\n`);
      continue;
    }

    let text = '';
    let ms = 0;
    let failed = false;
    for (const call of calls) {
      const t = performance.now();
      try {
        const r = await client.callTool(call, undefined, { timeout: CALL_TIMEOUT });
        ms += performance.now() - t;
        text += `${textOf(r)}\n`;
        if (r.isError) failed = true;
      } catch (error) {
        ms += performance.now() - t;
        failed = true;
        text += `ERROR: ${error.message}\n`;
      }
    }

    results[task.id] = {
      tokens: tokens(text),
      ms: Math.round(ms),
      correct: !failed && task.expect(text),
      failed,
      sample: text.slice(0, 400),
    };
    const r = results[task.id];
    process.stderr.write(
      `  ${task.id.padEnd(11)} ${String(r.tokens).padStart(7)} tok  ${String(r.ms).padStart(6)} ms  ${r.correct ? 'correct' : failed ? 'FAILED' : 'wrong'}\n`,
    );
  }

  await client.close();
  return { label: spec.label, handshakeMs: Math.round(handshakeMs), firstAnswerMs, toolCount: tools.length, toolOverhead, results };
}

const all = {};
for (const key of Object.keys(SERVERS)) {
  try {
    all[key] = await runServer(key);
  } catch (error) {
    process.stderr.write(`  ${key} failed to start: ${error.message}\n`);
    all[key] = { label: SERVERS[key].label, error: error.message };
  }
}

writeFileSync(`${projectRoot}/compare-results.json`, JSON.stringify({ repo: REPO, tasks: TASKS.map((t) => ({ id: t.id, question: t.question, truth: t.truth })), servers: all }, null, 2));
process.stderr.write(`\nwritten to ${projectRoot}/compare-results.json\n`);

// A summary worth pasting somewhere, rather than a wall of JSON.
process.stdout.write('\n| Question | ' + Object.values(all).map((s) => s.label).join(' | ') + ' |\n');
process.stdout.write('|---|' + Object.keys(all).map(() => '---|').join('') + '\n');
for (const task of TASKS) {
  const cells = Object.values(all).map((s) => {
    const r = s.results?.[task.id];
    if (!r) return 'n/a';
    if (r.skipped) return '*no tool*';
    return `${r.tokens} ${r.correct ? '✓' : '✗'}`;
  });
  process.stdout.write(`| ${task.question} | ${cells.join(' | ')} |\n`);
}
