// Run only against a disposable PostgreSQL database with pgvector installed.
// The deterministic provider tests migration mechanics, not retrieval quality.
import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

if (process.env.PTAH_TEST_ACTOR) {
  const { initEmbeddings, embed } = await import('../../src/services/embedders/interface.js');
  const { initPgvector, upsertPoint, supersedeAndInsert, searchPoints } = await import('../../src/services/pgvector.js');
  await initEmbeddings();
  await initPgvector();
  process.send({ ready: true });
  process.on('message', async ({ command, id, text, tenant = 'a', collection = 'shared_memories' }) => {
    try {
      const vector = await embed(text, command === 'search' ? 'search' : 'store');
      let result;
      if (command === 'search') result = await searchPoints(vector, { client_id: tenant, active: true }, 10, [], [], collection);
      else {
        const payload = { text, type: 'fact', client_id: tenant, key: 'favorite', active: true };
        if (command === 'supersede') result = await supersedeAndInsert('key', 'favorite', id, vector, payload, {}, collection);
        else await upsertPoint(id, vector, payload, collection);
      }
      process.send({ result: result ?? null });
    } catch (error) { process.send({ error: error.message }); }
  });
} else {
  assert.ok(process.env.POSTGRES_URL, 'Set POSTGRES_URL to a disposable database');
  const db = new pg.Pool({ connectionString: process.env.POSTGRES_URL });
  assert.equal((await db.query("SELECT to_regclass('public.memories') AS table")).rows[0].table, null,
    'Refusing to test against a database that already contains memories');
  const work = await mkdtemp(join(tmpdir(), 'zengram-ptah-'));
  const actors = [];
  let failProvider = false;
  let duringBackfill;
  const provider = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const { input, model, encoding_format } = JSON.parse(body);
    if (failProvider && model === 'candidate') { res.writeHead(503).end('test outage'); return; }
    if (model === 'candidate' && duringBackfill) {
      const check = duringBackfill;
      duringBackfill = null;
      await check();
    }
    const dims = model === 'candidate' ? 384 : 1536;
    const inputs = Array.isArray(input) ? input : [input];
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: inputs.map((text, index) => {
      const values = Array(dims).fill(0);
      values.splice(0, 4, text.includes('apple') ? 1 : 0.1, text.includes('pear') ? 1 : 0.1, 0.2, 0.3);
      return { index, embedding: encoding_format === 'base64'
        ? Buffer.from(new Float32Array(values).buffer).toString('base64') : values };
    }) }));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${provider.address().port}/v1`;
  const actor = async (column, model) => {
    const child = fork(new URL(import.meta.url), [], { env: { ...process.env,
      PTAH_TEST_ACTOR: '1', PGVECTOR_COLUMN: column, EMBEDDING_PROVIDER: 'openai',
      OPENAI_BASE_URL: endpoint, OPENAI_EMBEDDING_MODEL: model, OPENAI_EMBEDDING_DIMS: '',
      EMBED_DOC_PREFIX: '', EMBED_QUERY_PREFIX: '',
    }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    actors.push(child);
    await new Promise((resolve, reject) => {
      child.once('message', resolve);
      child.once('exit', code => reject(new Error(`API actor exited: ${code}`)));
    });
    return message => new Promise((resolve, reject) => {
      child.once('message', reply => reply.error ? reject(new Error(reply.error)) : resolve(reply.result));
      child.send(message);
    });
  };
  const specPath = join(work, 'candidate.json');
  const ptah = async (verb, extra = [], ok = true) => {
    const child = spawn(process.env.PTAH_BIN || 'ptah', ['inference', verb, '--spec', specPath,
      '--db-url', process.env.POSTGRES_URL, '--run-id', 'zengram-proof', ...extra]);
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const code = await new Promise((resolve, reject) => { child.on('close', resolve); child.on('error', reject); });
    console.log(`ptah ${verb} (exit ${code}):\n${output}`);
    if (ok) assert.equal(code, 0, output); else assert.notEqual(code, 0, output);
    return output;
  };
  try {
    const old = await actor('vector', 'legacy');
    for (const [id, text, tenant] of [['keep', 'apple', 'a'], ['update', 'pear', 'a'], ['delete', 'apple', 'a'], ['other', 'apple', 'b']]) {
      await old({ command: 'store', id, text, tenant });
    }
    await old({ command: 'store', id: 'private', text: 'apple', collection: 'private' });
    const before = (await db.query('SELECT id, vector::text, payload FROM memories ORDER BY id')).rows;
    const oldIndex = (await db.query("SELECT oid FROM pg_class WHERE relname = 'idx_memories_vector_hnsw'")).rows[0].oid;
    await db.query(await readFile(new URL('./source.sql', import.meta.url), 'utf8'));
    const spec = JSON.parse(await readFile(new URL('./embedding-v2.json', import.meta.url), 'utf8'));
    Object.assign(spec.model, { endpoint, identifier: 'candidate', reported_dimension: 384 });
    await writeFile(specPath, JSON.stringify(spec));
    await ptah('prepare');
    failProvider = true;
    await ptah('backfill', [], false);
    assert.deepEqual((await db.query('SELECT id, vector::text, payload FROM memories ORDER BY id')).rows, before);
    assert.ok((await old({ command: 'search', text: 'apple' })).some(r => r.id === 'keep'));
    failProvider = false;
    duringBackfill = async () => {
      assert.ok((await old({ command: 'search', text: 'apple' })).some(r => r.id === 'keep'));
    };
    await ptah('backfill');
    assert.equal(duringBackfill, null, 'old-model search must run while candidate embedding is in flight');
    assert.deepEqual((await db.query('SELECT id, vector::text, payload FROM memories ORDER BY id')).rows, before);
    await old({ command: 'store', id: 'update', text: 'apple' });
    await old({ command: 'store', id: 'late', text: 'pear' });
    await db.query("DELETE FROM memories WHERE id = 'delete'");
    await ptah('catchup');
    for (const [id, expected] of [['update', [1, 0.1, 0.2, 0.3]], ['late', [0.1, 1, 0.2, 0.3]]]) {
      const { rows } = await db.query('SELECT embedding_v2::text AS vector FROM memories WHERE id = $1', [id]);
      assert.deepEqual(JSON.parse(rows[0].vector).slice(0, 4), expected);
    }
    await ptah('index');
    await ptah('verify');
    const refusal = await ptah('cutover', [], false);
    const digest = refusal.match(/plan ([a-f0-9]{12,64})/)?.[1];
    assert.ok(digest, 'cutover must show the exact approval digest');
    await ptah('cutover', ['--approve', digest, '--approver', 'integration test']);
    assert.equal((await db.query("SELECT oid FROM pg_class WHERE relname = 'idx_memories_vector_hnsw'")).rows[0].oid, oldIndex);
    assert.equal((await db.query("SELECT vector::text FROM memories WHERE id = 'keep'")).rows[0].vector,
      before.find(r => r.id === 'keep').vector);
    const next = await actor('embedding_v2', 'candidate');
    const results = await next({ command: 'search', text: 'apple' });
    assert.ok(results.some(r => r.id === 'keep'));
    assert.ok(results.some(r => r.id === 'update'));
    assert.ok(results.some(r => r.id === 'late'));
    for (const id of ['delete', 'other', 'private']) assert.ok(!results.some(r => r.id === id));
    await next({ command: 'store', id: 'after', text: 'apple' });
    await next({ command: 'store', id: 'after', text: 'pear' });
    assert.equal((await db.query("SELECT vector_dims(embedding_v2) AS dims, vector FROM memories WHERE id = 'after'")).rows[0].dims, 384);
    assert.equal((await db.query("SELECT vector FROM memories WHERE id = 'after'")).rows[0].vector, null);
    await next({ command: 'supersede', id: 'successor', text: 'pear' });
    await next({ command: 'supersede', id: 'successor', text: 'apple' });
    assert.equal((await db.query("SELECT vector_dims(embedding_v2) AS dims FROM memories WHERE id = 'successor'")).rows[0].dims, 384);
    await ptah('catchup');
    await ptah('verify');
    console.log('PASS: failed/retried backfill, old search, live edits, catch-up, approval, dimension switch, both write paths, and tenant/collection filters');
  } finally {
    for (const child of actors) child.kill();
    await new Promise(resolve => provider.close(resolve));
    await db.end();
    await rm(work, { recursive: true, force: true });
  }
}
