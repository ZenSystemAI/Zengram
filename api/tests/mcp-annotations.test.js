// Cluster E — MCP tool annotations + engines contract.
// Pure/unit: imports the MCP module (side-effect-free unless run directly) and
// reads package.json from disk. No Postgres, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TOOLS } from '../../mcp-server/src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t.annotations]));

const READ_ONLY = ['brain_search', 'brain_query', 'brain_briefing', 'brain_stats', 'brain_entities', 'brain_export', 'brain_reflect', 'brain_research'];
const WRITERS = ['brain_store', 'brain_update', 'brain_delete', 'brain_import', 'brain_consolidate'];

test('all 13 MCP tools carry well-formed annotations', () => {
  assert.equal(TOOLS.length, 13);
  for (const tool of TOOLS) {
    const a = tool.annotations;
    assert.ok(a, `${tool.name} is missing annotations`);
    assert.equal(typeof a.title, 'string');
    assert.equal(typeof a.readOnlyHint, 'boolean');
    assert.equal(typeof a.destructiveHint, 'boolean');
    assert.equal(typeof a.idempotentHint, 'boolean');
    assert.equal(a.openWorldHint, false, `${tool.name} openWorldHint must be false`);
  }
});

test('read-only tools are marked readOnlyHint, writers are not', () => {
  for (const n of READ_ONLY) assert.equal(byName[n].readOnlyHint, true, `${n} should be read-only`);
  for (const n of WRITERS) assert.equal(byName[n].readOnlyHint, false, `${n} should not be read-only`);
});

test('destructive + idempotency hints match tool semantics', () => {
  assert.equal(byName.brain_delete.destructiveHint, true);
  assert.equal(byName.brain_import.destructiveHint, true);
  assert.equal(byName.brain_store.destructiveHint, false);
  assert.equal(byName.brain_consolidate.destructiveHint, false);
  assert.equal(byName.brain_consolidate.idempotentHint, false, 'consolidate is non-idempotent');
});

test('brain_store no longer requires source_agent (handler defaults it)', () => {
  const store = TOOLS.find((t) => t.name === 'brain_store');
  assert.deepEqual(store.inputSchema.required, ['type', 'content']);
});

test('mcp-server engines.node floor is >=20.10.0 for JSON import attributes', () => {
  const pkg = JSON.parse(readFileSync(join(here, '../../mcp-server/package.json'), 'utf8'));
  assert.equal(pkg.engines.node, '>=20.10.0');
});
