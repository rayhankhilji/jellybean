#!/usr/bin/env node
/**
 * Render tool output as SVG "terminal screenshots" for the README.
 *
 * SVG rather than PNG for three reasons: it stays diffable in git, it needs no
 * image hosting, and it is *generated from real output* — so it cannot quietly
 * drift away from what the tool actually prints the way a hand-taken screenshot
 * does. Regenerate with `npm run render` after changing any output format.
 *
 * The chrome is deliberately dark in both GitHub themes. An SVG loaded through
 * `<img>` is rendered in an isolated context, so inheriting the page's theme is
 * unreliable; committing to one look is the honest way to get a predictable
 * result.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(projectRoot, 'dist');
const outDir = join(projectRoot, 'docs');

const load = async (relative) => import(new URL(`file://${join(dist, relative).replace(/\\/g, '/')}`).href);

const { parseArgs } = await load('config.js');
const { CodeIndex } = await load('core/code-index.js');
const { HandleStore } = await load('core/handles.js');
const { NotesStore } = await load('core/notes.js');
const { Workspace } = await load('core/workspace.js');
const { runMap } = await load('tools/map.js');
const { runOutline } = await load('tools/outline.js');
const { runSearch } = await load('tools/search.js');
const { runDefine } = await load('tools/define.js');
const { runTrace } = await load('tools/trace.js');

// --- theme ------------------------------------------------------------------

const THEME = {
  chrome: '#1b1f2a',
  body: '#12151d',
  border: '#2b3040',
  dot: ['#ff5f57', '#febc2e', '#28c840'],
  title: '#8b93a7',
  text: '#d6dae4',
  dim: '#6c7488',
  handle: '#c792ea',
  path: '#82aaff',
  accent: '#7fd1b9',
  warn: '#ffcb6b',
  prompt: '#28c840',
};

const CHAR_WIDTH = 7.35;
const LINE_HEIGHT = 19;
const PADDING = 18;
const TITLE_BAR = 34;

/** XML-escape text destined for an SVG text node. */
const escapeXml = (text) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Split a line into coloured runs.
 *
 * Deliberately shallow: handles, paths, line references and the footer are what
 * a reader's eye needs to pick out. Attempting real syntax highlighting of
 * arbitrary tool output would be guesswork dressed up as precision.
 */
function colourize(line) {
  const runs = [];
  const pattern = /(jb_[0-9a-f]{8})|(\[[^\]]*tok[^\]]*\])|(^next:|^jb_\w+ —)|(:\d+(?:-\d+)?\b)|([\w./-]+\.(?:ts|js|tsx|py|go|rs|json|md)\b)/g;

  let index = 0;
  let match;
  while ((match = pattern.exec(line)) !== null) {
    if (match.index > index) runs.push({ text: line.slice(index, match.index), fill: THEME.text });
    const [whole, handle, footer, heading, lineRef, path] = match;
    if (handle) runs.push({ text: whole, fill: THEME.handle });
    else if (footer) runs.push({ text: whole, fill: THEME.dim });
    else if (heading) runs.push({ text: whole, fill: THEME.accent, weight: 'bold' });
    else if (lineRef) runs.push({ text: whole, fill: THEME.dim });
    else if (path) runs.push({ text: whole, fill: THEME.path });
    index = match.index + whole.length;
  }
  if (index < line.length) runs.push({ text: line.slice(index), fill: THEME.text });
  return runs.length > 0 ? runs : [{ text: line, fill: THEME.text }];
}

function render({ title, command, body }) {
  const lines = body.replace(/\s+$/, '').split('\n');
  const rows = lines.length + 2; // the command line plus a blank
  const widest = Math.max(command.length + 2, ...lines.map((l) => l.length), title.length + 10);

  const width = Math.ceil(widest * CHAR_WIDTH + PADDING * 2);
  const height = Math.ceil(rows * LINE_HEIGHT + PADDING * 2 + TITLE_BAR);

  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(title)}">`,
    `<rect width="${width}" height="${height}" rx="10" fill="${THEME.body}" stroke="${THEME.border}"/>`,
    `<path d="M0 10a10 10 0 0 1 10-10h${width - 20}a10 10 0 0 1 10 10v${TITLE_BAR - 10}H0z" fill="${THEME.chrome}"/>`,
    `<line x1="0" y1="${TITLE_BAR}" x2="${width}" y2="${TITLE_BAR}" stroke="${THEME.border}"/>`,
  ];

  THEME.dot.forEach((fill, i) => {
    parts.push(`<circle cx="${18 + i * 17}" cy="${TITLE_BAR / 2}" r="5.5" fill="${fill}"/>`);
  });

  parts.push(
    `<text x="${width / 2}" y="${TITLE_BAR / 2 + 4}" text-anchor="middle" fill="${THEME.title}" ` +
      `font-family="ui-sans-serif,-apple-system,Segoe UI,sans-serif" font-size="12">${escapeXml(title)}</text>`,
  );

  const font = 'font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="12.5"';
  let y = TITLE_BAR + PADDING + 12;

  parts.push(
    `<text x="${PADDING}" y="${y}" ${font} xml:space="preserve">` +
      `<tspan fill="${THEME.prompt}">› </tspan><tspan fill="${THEME.text}" font-weight="bold">${escapeXml(command)}</tspan>` +
      `</text>`,
  );
  y += LINE_HEIGHT * 2;

  for (const line of lines) {
    if (line.trim() !== '') {
      const spans = colourize(line)
        .map(
          (run) =>
            `<tspan fill="${run.fill}"${run.weight ? ` font-weight="${run.weight}"` : ''}>${escapeXml(run.text)}</tspan>`,
        )
        .join('');
      parts.push(`<text x="${PADDING}" y="${y}" ${font} xml:space="preserve">${spans}</text>`);
    }
    y += LINE_HEIGHT;
  }

  parts.push('</svg>');
  return parts.join('\n');
}

// --- capture real output ----------------------------------------------------

const { config } = parseArgs([projectRoot]);
const workspace = new Workspace(config.root, config.ignore);
const ctx = {
  config,
  workspace,
  index: new CodeIndex(workspace, config),
  handles: new HandleStore(),
  notes: NotesStore.forWorkspace(config.root, config.notesPath),
};
await ctx.index.ensureFresh(true);

const shots = [
  {
    file: 'map.svg',
    title: 'jb_map — orient in a repository',
    command: 'jb_map {depth:"tree"}',
    body: await runMap({ depth: 'tree', tokenBudget: 800 }, ctx),
  },
  {
    file: 'outline.svg',
    title: 'jb_outline — structure without bodies',
    command: 'jb_outline {path:"src/core/handles.ts"}',
    body: await runOutline({ path: 'src/core/handles.ts', tokenBudget: 800 }, ctx),
  },
  {
    file: 'search.svg',
    title: 'jb_search — ranked lines, not a list of files',
    command: 'jb_search {query:"least recently used"}',
    body: await runSearch({ query: 'least recently used', maxFiles: 3, tokenBudget: 400 }, ctx),
  },
  {
    file: 'define.svg',
    title: 'jb_define — resolve, do not guess',
    command: 'jb_define {symbol:"BudgetWriter", from:"src/tools/map.ts"}',
    body: await runDefine({ symbol: 'BudgetWriter', from: 'src/tools/map.ts', tokenBudget: 500 }, ctx),
  },
  {
    file: 'trace.svg',
    title: 'jb_trace — what breaks if I change this',
    command: 'jb_trace {path:"src/core/tokens.ts"}',
    body: await runTrace({ path: 'src/core/tokens.ts', tokenBudget: 600 }, ctx),
  },
];

await mkdir(outDir, { recursive: true });
for (const shot of shots) {
  await writeFile(join(outDir, shot.file), render(shot) + '\n', 'utf8');
  process.stdout.write(`docs/${shot.file}\n`);
}
process.stdout.write(`\n${shots.length} renders written from live tool output.\n`);
