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
    config = parsed.config;
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}\n`);
    process.exitCode = 2;
    return;
  }

  const { server, context } = createServer(config);

  // Warm the index before accepting traffic, so the first tool call is fast
  // rather than paying for a full scan while the client waits.
  await context.index.ensureFresh(true);

  // Watch after the first scan, so tool calls do not re-walk the tree. Without
  // this every call that lands outside the freshness window pays for a full
  // walk — seconds, on a repository of any size.
  const watching = context.index.startWatching();
  process.stderr.write(
    `${SERVER_NAME} ${SERVER_VERSION} — indexed ${context.index.fileCount} files in ${config.root}` +
      `${watching ? '' : ' (filesystem watching unavailable; falling back to periodic rescans)'}\n`,
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = (): void => {
    context.index.stopWatching();
    void server.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  process.stderr.write(`${SERVER_NAME}: fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
