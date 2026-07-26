/**
 * Protocol test.
 *
 * Drives the built server over stdio with a real MCP client. Unit tests can pass
 * while the server fails to speak the protocol at all — a schema the SDK rejects,
 * a stray write to stdout — so this exercises the actual wire.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = dirname(fileURLToPath(import.meta.url));
/** Tests run from dist-test/test, so the project root is two levels up. */
const projectRoot = join(here, '..', '..');
const entrypoint = join(projectRoot, 'dist', 'index.js');

async function connect(): Promise<Client> {
  const client = new Client({ name: 'jellybean-test-client', version: '1.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [entrypoint, projectRoot],
      stderr: 'ignore',
    }),
  );
  return client;
}

/** Extract the text of a tool result. */
function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
  assert.ok(Array.isArray(content) && content.length > 0, 'the tool returned no content');
  assert.equal(content[0]!.type, 'text');
  return content[0]!.text ?? '';
}

/** Whether the server flagged a result as an error. */
function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

test('the server completes a handshake and advertises its instructions', async () => {
  const client = await connect();
  try {
    const info = client.getServerVersion();
    assert.equal(info?.name, 'jellybean');

    const instructions = client.getInstructions();
    assert.ok(instructions && instructions.includes('jb_map'), 'no usage instructions were sent');
  } finally {
    await client.close();
  }
});

test('all nine tools are listed with descriptions and schemas', async () => {
  const client = await connect();
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();

    assert.deepEqual(names, [
      'jb_changes',
      'jb_define',
      'jb_diagnose',
      'jb_map',
      'jb_notes',
      'jb_outline',
      'jb_read',
      'jb_search',
      'jb_trace',
    ]);

    for (const tool of tools) {
      assert.ok(tool.description && tool.description.length > 40, `${tool.name} has a thin description`);
      assert.equal(tool.inputSchema.type, 'object', `${tool.name} has no object input schema`);
    }
  } finally {
    await client.close();
  }
});

test('every tool exposes tokenBudget so a client can bound its cost', async () => {
  const client = await connect();
  try {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const properties = tool.inputSchema.properties as Record<string, unknown> | undefined;
      assert.ok(properties?.['tokenBudget'], `${tool.name} does not accept a token budget`);
    }
  } finally {
    await client.close();
  }
});

test('jb_map returns a usable map over the wire', async () => {
  const client = await connect();
  try {
    const text = textOf(await client.callTool({ name: 'jb_map', arguments: { depth: 'tree', tokenBudget: 600 } }));
    assert.ok(text.startsWith('jb_map —'), text.slice(0, 120));
    assert.ok(text.includes('src/'), 'the map did not include the source tree');
  } finally {
    await client.close();
  }
});

test('a handle minted by one call is readable by the next', async () => {
  const client = await connect();
  try {
    const outline = textOf(
      await client.callTool({ name: 'jb_outline', arguments: { path: 'src/core/tokens.ts', tokenBudget: 800 } }),
    );
    const handle = /jb_[0-9a-f]{8}/.exec(outline)?.[0];
    assert.ok(handle, `no handle in the outline:\n${outline}`);

    const read = textOf(await client.callTool({ name: 'jb_read', arguments: { handle, tokenBudget: 800 } }));
    assert.ok(read.startsWith('jb_read —'), read.slice(0, 120));
    assert.ok(/^\s*\d+\|/m.test(read), 'the read result was not line-numbered');
  } finally {
    await client.close();
  }
});

test('a bad argument is reported as a tool error, not a crash', async () => {
  const client = await connect();
  try {
    // A path that does not exist is ordinary output, not a protocol failure: the
    // agent needs to read the explanation and try something else.
    const missing = await client.callTool({ name: 'jb_read', arguments: { path: 'does/not/exist.ts' } });
    assert.ok(textOf(missing).includes('cannot read'), textOf(missing));

    // A schema violation is surfaced as an error result rather than a thrown
    // transport failure, so the session survives it.
    const invalid = await client.callTool({ name: 'jb_search', arguments: { query: '' } });
    assert.ok(isError(invalid), 'an empty query was accepted');

    // The connection is still alive afterwards.
    const stillWorks = textOf(await client.callTool({ name: 'jb_map', arguments: { depth: 'tree', tokenBudget: 300 } }));
    assert.ok(stillWorks.includes('jb_map'));
  } finally {
    await client.close();
  }
});

test('resources are listed and readable', async () => {
  const client = await connect();
  try {
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri).sort();
    assert.deepEqual(uris, ['jellybean://checks', 'jellybean://map', 'jellybean://notes']);

    const read = await client.readResource({ uri: 'jellybean://checks' });
    const contents = read.contents as Array<{ text?: string }>;
    assert.ok(contents[0]?.text?.includes('npm run'), 'the checks resource listed nothing runnable');
  } finally {
    await client.close();
  }
});

test('prompts are listed and render a usable message', async () => {
  const client = await connect();
  try {
    const { prompts } = await client.listPrompts();
    assert.deepEqual(prompts.map((p) => p.name).sort(), ['fix-failures', 'onboard']);

    const prompt = await client.getPrompt({ name: 'onboard' });
    const first = prompt.messages[0]?.content as { type: string; text?: string } | undefined;
    assert.equal(first?.type, 'text');
    assert.ok(first?.text?.includes('jb_map'), 'the prompt does not reference the tools');
  } finally {
    await client.close();
  }
});
