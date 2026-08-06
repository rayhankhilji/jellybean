#!/usr/bin/env node
/**
 * Jelly Bean — entrypoint.
 *
 * Speaks MCP over stdio, which means stdout belongs to the protocol. Anything
 * we want a human to see goes to stderr; a stray `console.log` here would
 * corrupt the JSON-RPC stream and break the connection in a way that is
 * genuinely unpleasant to debug.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { parseArgs, type JellyBeanConfig } from './config.js';
import { createServer, SERVER_NAME, SERVER_VERSION } from './server.js';
import { runDoctor } from './doctor.js';

const USAGE = `jellybean — a token-frugal MCP server for understanding codebases

USAGE
  jellybean [path] [options]

ARGUMENTS
  path                     Workspace to index. Defaults to the current directory.

OPTIONS
  -r, --root <path>        Same as the positional argument.
      --token-budget <n>   Default token budget per tool call (default 2000).
      --max-file-bytes <n> Skip files larger than this (default 524288).
      --max-files <n>      Stop indexing after this many files (default 20000).
      --ignore <globs>     Extra comma-separated ignore patterns.
      --allow-command <c>  Permit jb_diagnose to run this command. Repeatable.
      --unsafe-commands    Permit jb_diagnose to run any command. Off by default.
      --command-timeout <s> Seconds before a check is killed (default 120).
      --doctor             Check the setup and exit, without starting the server.
  -h, --help               Show this message.
  -v, --version            Print the version.

ENVIRONMENT
  JELLYBEAN_ROOT, JELLYBEAN_TOKEN_BUDGET, JELLYBEAN_MAX_FILE_BYTES,
  JELLYBEAN_MAX_FILES, JELLYBEAN_IGNORE, JELLYBEAN_ALLOW_COMMANDS,
  JELLYBEAN_UNSAFE_COMMANDS

EXAMPLE
  {
    "mcpServers": {
      "jellybean": { "command": "npx", "args": ["-y", "jellybean-mcp", "/path/to/repo"] }
    }
  }`;

async function main(): Promise<void> {
  let config: JellyBeanConfig;
  try {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed.action === 'help') {
      process.stderr.write(USAGE + '\n');
      return;
    }
    if (parsed.action === 'version') {
      process.stderr.write(`${SERVER_NAME} ${SERVER_VERSION}\n`);
      return;
    }
    if (parsed.action === 'doctor') {
      // A person is reading this, not a protocol — stdout is the right place,
      // and no transport is ever connected to compete for it.
      process.exitCode = await runDoctor(parsed.config, process.stdout);
      return;
    }
    config = parsed.config;
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}\n`);
    process.exitCode = 2;
    return;
  }

  const { server, context } = createServer(config);

  // Start indexing, but do not wait for it before connecting.
  //
  // On a large repository the first scan takes tens of seconds, and waiting for
  // it here means the client sees nothing at all for that time — no handshake,
  // no tool list, and on some clients a connection timeout and a server that
  // appears simply broken. Connecting first costs nothing: every tool awaits
  // `ensureFresh` anyway, so the first call joins the scan already in flight and
  // the rest are answered instantly.
  const indexed = context.index
    .ensureFresh(true)
    .then(() => {
      // Watching starts only once the tree has been walked. Before that there is
      // nothing for a change notification to be relative to, and every tool call
      // would still pay for a full walk.
      const watching = context.index.startWatching();
      process.stderr.write(
        `${SERVER_NAME} ${SERVER_VERSION} — indexed ${context.index.fileCount} files in ${config.root}` +
          `${watching ? '' : ' (filesystem watching unavailable; falling back to periodic rescans)'}\n`,
      );
    })
    .catch((error: unknown) => {
      // A failed first scan must not become an unhandled rejection that takes
      // the process down. Tools will report an empty index, which is wrong but
      // recoverable; a dead server is neither.
      process.stderr.write(`${SERVER_NAME}: initial index failed: ${describe(error)}\n`);
    });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`${SERVER_NAME} ${SERVER_VERSION} — connected, indexing ${config.root}\n`);

  let closing = false;
  const shutdown = (): void => {
    if (closing) return; // a second Ctrl-C should not race the first
    closing = true;
    void (async () => {
      // Let a first scan finish rather than killing it midway: it holds the
      // parse cache for the whole repository, and abandoning it means the next
      // start does all of that work again.
      await indexed;
      await context.index.close();
      await server.close().catch(() => undefined);
      process.exit(0);
    })();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function describe(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

main().catch((error: unknown) => {
  process.stderr.write(`${SERVER_NAME}: fatal: ${describe(error)}\n`);
  process.exit(1);
});
