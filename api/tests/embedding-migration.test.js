// Staged embedding migration (scripts/reembed.js + services/embedding-migration.js).
// Pure SQL builders and validators, plus the script helpers with a stub pool;
// no live Postgres or embedding provider needed.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  getEmbeddingProvenance,
  decodeEnvEscapes,
} from '../src/services/embedders/interface.js';
import {
  MigrationRefusedError,
  META_KEY_PENDING_PREVIOUS,
  META_KEY_PREVIOUS,
  META_TABLE,
  assertActivationScope,
  assertNoActiveVectorWipe,
  assertStageTargetCompatible,
  assertTargetMetaMatchesProvenance,
  buildActiveIndexSql,
  buildActivationSql,
  buildCoverageSql,
  buildDropPreviousColumnSql,
  buildDropStageColumnSql,
  buildPreviousProvenance,
  buildEnsureStageColumnSql,
  buildEnsureStageMetaColumnsSql,
  buildStageColumnEmptyCheckSql,
  buildStageIndexSql,
  buildStageUpdateSql,
  buildStageSelectSql,
  halfvecMode,
  hasEmbeddableText,
  isCurrentStagedRow,
  migrationSummary,
  parseCliArgs,
  planStageColumnForTargetDims,
  planPreviousColumnForActiveDims,
  validateCoverage,
} from '../src/services/embedding-migration.js';
import { halfvecMode as pgvectorHalfvecMode } from '../src/services/pgvector.js';
import {
  closeReembedResources,
  currentColumnDims,
  deleteMeta,
  describeError,
  readMeta,
  writeMeta,
} from '../scripts/reembed.js';

describe('getEmbeddingProvenance', () => {
  it('returns deterministic generation from provider/model/dims/prefix fps/normalization', () => {
    const a = getEmbeddingProvenance({
      providerName: 'openai',
      dimensions: 1536,
      queryPrefix: '',
      documentPrefix: '',
      generationOverride: '',
    });
    const b = getEmbeddingProvenance({
      providerName: 'openai',
      dimensions: 1536,
      queryPrefix: '',
      documentPrefix: '',
      generationOverride: '',
    });

    assert.equal(a.provider, 'openai');
    assert.equal(a.model, process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small');
    assert.equal(a.dimensions, 1536);
    assert.equal(a.normalization, 'none');
    assert.equal(typeof a.generation, 'string');
    assert.equal(a.generation.length, 16);
    assert.equal(a.query_prefix_fp, b.query_prefix_fp);
    assert.equal(a.document_prefix_fp, b.document_prefix_fp);
    assert.equal(a.generation, b.generation);
    // Never store raw instruction text.
    assert.equal('query_prefix' in a, false);
    assert.equal('document_prefix' in a, false);
  });

  it('honors EMBEDDING_GENERATION / generationOverride', () => {
    const p = getEmbeddingProvenance({
      providerName: 'openai',
      dimensions: 1536,
      queryPrefix: '',
      documentPrefix: '',
      generationOverride: 'gen-override-v1',
    });
    assert.equal(p.generation, 'gen-override-v1');
  });

  it('changes prefix fingerprints when decoded prefixes change', () => {
    const empty = getEmbeddingProvenance({
      providerName: 'openai',
      dimensions: 1024,
      queryPrefix: '',
      documentPrefix: '',
      generationOverride: '',
    });
    const withQuery = getEmbeddingProvenance({
      providerName: 'openai',
      dimensions: 1024,
      queryPrefix: decodeEnvEscapes('Instruct: task\\nQuery: '),
      documentPrefix: '',
      generationOverride: '',
    });
    const withDoc = getEmbeddingProvenance({
      providerName: 'openai',
      dimensions: 1024,
      queryPrefix: '',
      documentPrefix: 'passage: ',
      generationOverride: '',
    });

    assert.notEqual(empty.query_prefix_fp, withQuery.query_prefix_fp);
    assert.equal(empty.document_prefix_fp, withQuery.document_prefix_fp);
    assert.notEqual(empty.document_prefix_fp, withDoc.document_prefix_fp);
    assert.notEqual(empty.generation, withQuery.generation);
    assert.notEqual(empty.generation, withDoc.generation);
  });

  it('resolves provider-specific models and gemini l2 normalization', () => {
    const gemini = getEmbeddingProvenance({
      providerName: 'gemini',
      dimensions: 1536,
      queryPrefix: '',
      documentPrefix: '',
      generationOverride: '',
    });
    assert.equal(gemini.provider, 'gemini');
    assert.equal(gemini.model, process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-2-preview');
    assert.equal(gemini.normalization, 'l2');

    const geminiFull = getEmbeddingProvenance({
      providerName: 'gemini',
      dimensions: 3072,
      queryPrefix: '',
      documentPrefix: '',
      generationOverride: '',
    });
    assert.equal(geminiFull.normalization, 'provider');

    const ollama = getEmbeddingProvenance({
      providerName: 'ollama',
      dimensions: 768,
      queryPrefix: '',
      documentPrefix: '',
      generationOverride: '',
    });
    assert.equal(ollama.provider, 'ollama');
    assert.equal(ollama.model, process.env.OLLAMA_MODEL || 'nomic-embed-text');
    assert.equal(ollama.normalization, 'none');
  });
});

describe('reembed CLI stage vs activate safety', () => {
  it('defaults to dry-run and maps --stage/--activate/--apply', () => {
    assert.deepEqual(parseCliArgs([]).mode, 'dry-run');
    assert.equal(parseCliArgs([]).apply, false);

    const stagePreview = parseCliArgs(['--stage']);
    assert.equal(stagePreview.mode, 'stage');
    assert.equal(stagePreview.apply, false);

    const stageApply = parseCliArgs(['--stage', '--apply']);
    assert.equal(stageApply.mode, 'stage');
    assert.equal(stageApply.apply, true);

    const activate = parseCliArgs(['--activate', '--apply']);
    assert.equal(activate.mode, 'activate');
    assert.equal(activate.apply, true);

    const legacy = parseCliArgs(['--commit', '--limit', '10', '--collection', 'c1']);
    assert.equal(legacy.mode, 'stage');
    assert.equal(legacy.apply, true);
    assert.equal(legacy.limit, 10);
    assert.equal(legacy.collection, 'c1');
  });

  it('rejects --limit and --collection on activate', () => {
    const lim = assertActivationScope({ mode: 'activate', limit: 5, collection: null });
    assert.equal(lim.ok, false);
    assert.match(lim.error, /--limit/);

    const col = assertActivationScope({ mode: 'activate', limit: 0, collection: 'tenant' });
    assert.equal(col.ok, false);
    assert.match(col.error, /--collection/);

    const ok = assertActivationScope({ mode: 'activate', limit: 0, collection: null });
    assert.equal(ok.ok, true);

    const stageOk = assertActivationScope({ mode: 'stage', limit: 5, collection: 'x' });
    assert.equal(stageOk.ok, true);
  });

  it('refuses activation when --limit or --collection is supplied at all, even malformed', () => {
    const badLimit = parseCliArgs(['--activate', '--apply', '--limit', 'nope']);
    assert.equal(badLimit.limitSupplied, true);
    assert.equal(badLimit.limit, 0);
    assert.match(badLimit.errors.join(';'), /--limit needs a non-negative integer/);
    assert.equal(assertActivationScope(badLimit).ok, false);

    const zeroLimit = parseCliArgs(['--activate', '--apply', '--limit', '0']);
    assert.deepEqual(zeroLimit.errors, []);
    assert.match(assertActivationScope(zeroLimit).error, /--limit/);

    const bareCollection = parseCliArgs(['--activate', '--apply', '--collection']);
    assert.equal(bareCollection.collectionSupplied, true);
    assert.equal(bareCollection.collection, null);
    assert.match(bareCollection.errors.join(';'), /--collection needs a collection name/);
    assert.match(assertActivationScope(bareCollection).error, /--collection/);

    const emptyCollection = parseCliArgs(['--activate', '--apply', '--collection=']);
    assert.equal(emptyCollection.collectionSupplied, true);
    assert.equal(assertActivationScope(emptyCollection).ok, false);

    const clean = parseCliArgs(['--activate', '--apply']);
    assert.deepEqual(clean.errors, []);
    assert.equal(assertActivationScope(clean).ok, true);

    const stage = parseCliArgs(['--stage', '--apply', '--limit', '5', '--collection', 'c1']);
    assert.deepEqual(stage.errors, []);
    assert.equal(assertActivationScope(stage).ok, true);
  });

  it('builds a first-run dry-run select without migration columns', () => {
    const preview = buildStageSelectSql({
      collection: 'tenant-a',
      limit: 5,
      includeStageMetadata: false,
    });
    assert.match(preview.sql, /^SELECT id, payload, content_hash FROM memories/);
    assert.doesNotMatch(preview.sql, /vector_next|has_active_vector/);
    assert.match(preview.sql, /collection = \$1/);
    assert.match(preview.sql, /LIMIT 5$/);
    assert.deepEqual(preview.params, ['tenant-a']);

    const staged = buildStageSelectSql();
    assert.match(staged.sql, /vector_next_generation/);
    assert.match(staged.sql, /has_active_vector/);
  });
});

describe('resumable vector staging', () => {
  const current = {
    has_stage_vector: true,
    stage_generation: 'bge-generation',
    stage_content_hash: 'sha256:current',
    content_hash: 'sha256:current',
  };

  it('reuses only stage rows whose vector generation and content hash still match', () => {
    assert.equal(isCurrentStagedRow(current, 'bge-generation'), true);
    assert.equal(isCurrentStagedRow({ ...current, has_stage_vector: false }, 'bge-generation'), false);
    assert.equal(isCurrentStagedRow({ ...current, stage_generation: 'old' }, 'bge-generation'), false);
    assert.equal(isCurrentStagedRow({ ...current, content_hash: 'sha256:edited' }, 'bge-generation'), false);
    assert.equal(isCurrentStagedRow(current, ''), false);
  });
});

describe('embeddable text rule', () => {
  it('matches the coverage SQL: first non-empty field, whitespace-only text included', () => {
    assert.equal(hasEmbeddableText({ text: 'hello' }), true);
    assert.equal(hasEmbeddableText({ text: '   ' }), true);
    assert.equal(hasEmbeddableText({ text: '\t\n' }), true);
    assert.equal(hasEmbeddableText({ text: '', content: 'fallback' }), true);
    assert.equal(hasEmbeddableText({ title: 'only a title' }), true);
    assert.equal(hasEmbeddableText({ text: '' }), false);
    assert.equal(hasEmbeddableText({}), false);
    assert.equal(hasEmbeddableText(null), false);

    // The SQL side selects with NULLIF(field, '') and never trims.
    const { sql } = buildCoverageSql({ generation: 'g' });
    assert.match(sql, /NULLIF\(payload->>'text',''\)/);
    assert.doesNotMatch(sql, /trim\(/i);
  });
});

describe('coverage validation', () => {
  it('requires full staged coverage before activate', () => {
    const incomplete = validateCoverage({
      required_count: '10',
      staged_count: '7',
      missing_count: '3',
      active_nonnull_count: '10',
      active_vector_without_text_count: '0',
    });
    assert.equal(incomplete.ok, false);
    assert.equal(incomplete.missing, 3);
    assert.match(incomplete.error, /incomplete staging coverage/);

    const complete = validateCoverage({
      required_count: 10,
      staged_count: 10,
      missing_count: 0,
      active_nonnull_count: 10,
      active_vector_without_text_count: 0,
    });
    assert.equal(complete.ok, true);
    assert.equal(complete.error, null);
  });

  it('counts stale generation and content_hash mismatch as missing', () => {
    const stale = validateCoverage({
      required_count: 5,
      staged_count: 2,
      missing_count: 3,
      stale_generation_count: 2,
      content_hash_mismatch_count: 1,
      missing_null_stage_count: 0,
      active_vector_without_text_count: 0,
    });
    assert.equal(stale.ok, false);
    assert.match(stale.error, /stale generation/);
    assert.match(stale.error, /content_hash mismatch/);
  });

  it('blocks active vectors without embeddable text', () => {
    const blocked = validateCoverage({
      required_count: 4,
      staged_count: 4,
      missing_count: 0,
      active_vector_without_text_count: 2,
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.active_vector_without_text_count, 2);
    assert.match(blocked.error, /active vector but no embeddable text/);
  });

  it('coverage SQL requires generation and matches stage identity columns', () => {
    assert.throws(() => buildCoverageSql({}), /generation/);
    const { sql, params } = buildCoverageSql({ generation: 'gen-abc' });
    assert.equal(params[0], 'gen-abc');
    assert.match(sql, /vector_next_generation/);
    assert.match(sql, /vector_next_content_hash/);
    assert.match(sql, /content_hash/);
    assert.match(sql, /active_vector_without_text_count/);
    assert.match(sql, /stale_generation_count/);
  });
});

describe('target meta vs provenance', () => {
  const provenance = {
    generation: 'gen-1',
    provider: 'openai',
    model: 'text-embedding-3-small',
    dimensions: 1536,
    query_prefix_fp: 'aaa',
    document_prefix_fp: 'bbb',
    normalization: 'none',
  };

  it('accepts matching META_KEY_TARGET', () => {
    assert.equal(assertTargetMetaMatchesProvenance({ ...provenance, staged_at: 'x' }, provenance).ok, true);
  });

  it('rejects missing or mismatched generation/model', () => {
    assert.equal(assertTargetMetaMatchesProvenance(null, provenance).ok, false);
    const badGen = assertTargetMetaMatchesProvenance({ ...provenance, generation: 'other' }, provenance);
    assert.equal(badGen.ok, false);
    assert.match(badGen.error, /generation/);
    const badModel = assertTargetMetaMatchesProvenance({ ...provenance, model: 'other-model' }, provenance);
    assert.equal(badModel.ok, false);
    assert.ok(badModel.mismatches.includes('model'));
  });
});

describe('stage target compatibility', () => {
  const identity = {
    generation: 'pinned-gen',
    provider: 'openai',
    model: 'model-a',
    dimensions: 1024,
    query_prefix_fp: 'aaa',
    document_prefix_fp: 'bbb',
    normalization: 'none',
  };

  it('refuses to reuse a pinned generation staged under another identity', () => {
    const staged = { ...identity, status: 'staging', staged_at: 'x' };
    const result = assertStageTargetCompatible(staged, { ...identity, model: 'model-b' });
    assert.equal(result.ok, false);
    assert.deepEqual(result.mismatches, ['model']);
    assert.match(result.error, /already staged under a different embedding identity \(model\)/);
    assert.match(result.error, /EMBEDDING_GENERATION/);
  });

  it('allows resuming the same identity, a new generation, or a fresh start', () => {
    const staged = { ...identity, status: 'staging' };
    assert.equal(assertStageTargetCompatible(staged, identity).ok, true);
    assert.equal(
      assertStageTargetCompatible(staged, { ...identity, generation: 'new-gen', model: 'model-b' }).ok,
      true,
    );
    // After activation the stage column is dropped, so nothing can be reused.
    assert.equal(
      assertStageTargetCompatible({ ...identity, status: 'active' }, { ...identity, model: 'model-b' }).ok,
      true,
    );
    assert.equal(assertStageTargetCompatible(null, identity).ok, true);
  });
});

describe('previous embedding provenance', () => {
  const active = {
    status: 'active',
    generation: 'old-gen',
    provider: 'ollama',
    model: 'old-model',
    dimensions: 768,
  };

  it('captures active identity before target metadata becomes staging', () => {
    const previous = buildPreviousProvenance({
      activeMeta: active,
      retainedDims: 768,
      nextGeneration: 'new-gen',
      retainedAt: '2026-07-21T00:00:00.000Z',
    });
    assert.equal(previous.generation, 'old-gen');
    assert.equal(previous.model, 'old-model');
    assert.equal(previous.status, 'retained');
    assert.equal(previous.provenance_known, true);
    assert.equal(previous.retained_dims, 768);
    assert.equal(previous.retained_for_generation, 'new-gen');
  });

  it('preserves prior active identity when a staging run is resumed or switched', () => {
    const first = buildPreviousProvenance({
      activeMeta: active,
      retainedDims: 768,
      nextGeneration: 'new-gen',
      retainedAt: '2026-07-21T00:00:00.000Z',
    });
    const resumed = buildPreviousProvenance({
      activeMeta: { status: 'staging', generation: 'new-gen', model: 'new-model' },
      previousMeta: first,
      retainedDims: 768,
      nextGeneration: 'newer-gen',
      retainedAt: '2026-07-21T00:01:00.000Z',
    });
    assert.equal(resumed.generation, 'old-gen');
    assert.equal(resumed.model, 'old-model');
    assert.equal(resumed.retained_for_generation, 'newer-gen');
  });

  it('records unknown provenance honestly when no active identity exists', () => {
    const previous = buildPreviousProvenance({
      activeMeta: { status: 'staging', generation: 'incoming' },
      retainedDims: 1024,
      nextGeneration: 'incoming',
      retainedAt: '2026-07-21T00:00:00.000Z',
    });
    assert.equal(previous.provenance_known, false);
    assert.equal('model' in previous, false);
    assert.equal(previous.retained_dims, 1024);
  });

  it('rejects missing generation or invalid retained dimensions', () => {
    assert.throws(
      () => buildPreviousProvenance({ retainedDims: 0, nextGeneration: 'new' }),
      /retained dims/,
    );
    assert.throws(
      () => buildPreviousProvenance({ retainedDims: 768, nextGeneration: '' }),
      /nextGeneration/,
    );
  });
});

describe('stage column dim plan', () => {
  it('adds missing column, noops same dims, drop_adds empty wrong dims, blocks residual', () => {
    assert.equal(planStageColumnForTargetDims({ existingDims: null, targetDims: 1024 }).action, 'add');
    assert.equal(planStageColumnForTargetDims({ existingDims: 1024, targetDims: 1024 }).action, 'noop');
    assert.equal(
      planStageColumnForTargetDims({
        existingDims: 768,
        targetDims: 1024,
        stageNonNullCount: 0,
        stageGenerationNonNullCount: 0,
        stageHashNonNullCount: 0,
      }).action,
      'drop_add',
    );
    const blocked = planStageColumnForTargetDims({
      existingDims: 768,
      targetDims: 1024,
      stageNonNullCount: 3,
      stageGenerationNonNullCount: 0,
      stageHashNonNullCount: 0,
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.action, 'blocked');
    assert.match(blocked.error, /residual/);
  });

  it('drop stage column SQL does not touch vector_prev', () => {
    const sql = buildDropStageColumnSql();
    assert.match(sql, /DROP COLUMN IF EXISTS vector_next/i);
    assert.doesNotMatch(sql, /vector_prev/);
    assert.match(buildStageColumnEmptyCheckSql(), /vector_next_generation/);
    assert.equal(buildEnsureStageMetaColumnsSql().length, 2);
  });
});

describe('reembed column dimension lookup', () => {
  it('does not sample a catalog-proven missing column', async () => {
    const queries = [];
    const pool = {
      async query(sql, params) {
        queries.push({ sql, params });
        return { rows: [] };
      },
    };

    assert.equal(await currentColumnDims(pool, 'vector_next'), null);
    assert.equal(queries.length, 1);
    assert.deepEqual(queries[0].params, ['vector_next']);
  });

  it('writes migration metadata as JSON text into zengram_meta', async () => {
    const queries = [];
    const pool = {
      async query(sql, params) {
        queries.push({ sql: String(sql), params });
        return { rows: [] };
      },
    };

    await writeMeta(pool, 'embedding_migration_target', {
      generation: 'bge-generation',
      dimensions: 1024,
    });

    assert.equal(META_TABLE, 'zengram_meta');
    assert.match(queries[0].sql, /CREATE TABLE IF NOT EXISTS zengram_meta/);
    assert.match(queries[1].sql, /INSERT INTO zengram_meta/);
    assert.doesNotMatch(queries[1].sql, /jsonb/i);
    assert.deepEqual(queries[1].params, [
      'embedding_migration_target',
      '{"generation":"bge-generation","dimensions":1024}',
    ]);
  });

  it('creates zengram_meta with the same definition as the structured store', async () => {
    const queries = [];
    const pool = {
      async query(sql) {
        queries.push(String(sql));
        return { rows: [] };
      },
    };
    await writeMeta(pool, 'k', 1);
    const storeSource = readFileSync(new URL('../src/services/stores/postgres.js', import.meta.url), 'utf8');
    assert.ok(
      storeSource.includes(queries[0]),
      `structured store should create zengram_meta with: ${queries[0]}`,
    );
  });

  it('parses JSON metadata stored in the TEXT column', async () => {
    const pool = {
      async query() {
        return { rows: [{ value: '{"generation":"bge-generation","dimensions":1024}' }] };
      },
    };

    assert.deepEqual(await readMeta(pool, 'embedding_migration_target'), {
      generation: 'bge-generation',
      dimensions: 1024,
    });
  });

  it('reads without DDL and treats a missing meta table as no metadata', async () => {
    const queries = [];
    const pool = {
      async query(sql) {
        queries.push(String(sql));
        const err = new Error('relation "zengram_meta" does not exist');
        err.code = '42P01';
        throw err;
      },
    };
    assert.equal(await readMeta(pool, 'embedding_migration_target'), null);
    assert.equal(queries.length, 1);
    assert.match(queries[0], /^SELECT value FROM zengram_meta/);

    const broken = {
      async query() {
        const err = new Error('connection reset');
        err.code = 'ECONNRESET';
        throw err;
      },
    };
    await assert.rejects(readMeta(broken, 'embedding_migration_target'), /connection reset/);
  });

  it('keeps vector_prev metadata and the pending capture under separate keys', async () => {
    assert.notEqual(META_KEY_PENDING_PREVIOUS, META_KEY_PREVIOUS);
    const queries = [];
    const pool = {
      async query(sql, params) {
        queries.push({ sql: String(sql), params });
        return { rows: [] };
      },
    };
    await deleteMeta(pool, META_KEY_PENDING_PREVIOUS);
    assert.match(queries[0].sql, /^DELETE FROM zengram_meta WHERE key = \$1$/);
    assert.deepEqual(queries[0].params, ['embedding_migration_pending_previous']);
  });

  it('rejects malformed migration metadata instead of treating it as absent', async () => {
    const pool = {
      async query() {
        return { rows: [{ value: '{invalid' }] };
      },
    };

    await assert.rejects(
      readMeta(pool, 'embedding_migration_target'),
      (e) => e instanceof MigrationRefusedError && /contains invalid JSON/.test(e.message),
    );
  });
});

describe('reembed error reporting', () => {
  it('prints migration refusals verbatim and fingerprints everything else', () => {
    const refusal = new MigrationRefusedError('incomplete staging coverage: 3 of 10 embeddable rows not valid for current generation');
    assert.equal(describeError(refusal), refusal.message);

    const driver = new Error('connect ECONNREFUSED postgresql://user:hunter2@db.example.test:5432/zengram');
    const printed = describeError(driver);
    assert.match(printed, /^Error [0-9a-f]{12}$/);
    assert.equal(printed.includes('hunter2'), false);
    assert.equal(printed.includes('db.example.test'), false);
  });
});

describe('reembed resource cleanup', () => {
  it('preserves the migration error after awaiting and reporting cleanup failures', async () => {
    const primaryError = new Error('migration failed');
    const cleanupCalls = [];
    const logged = [];

    await assert.rejects(
      closeReembedResources(primaryError, {
        closers: [
          async () => {
            cleanupCalls.push('pool');
            throw new Error('pool cleanup failed for postgresql://user:hunter2@db.example.test/zengram');
          },
          async () => {
            cleanupCalls.push('other');
            throw new Error('other cleanup failed');
          },
        ],
        logError: (...args) => logged.push(args),
      }),
      error => error === primaryError,
    );

    assert.deepEqual(cleanupCalls, ['pool', 'other']);
    assert.equal(logged.length, 2);
    assert.match(String(logged[0][0]), /resource shutdown failed while preserving primary error/);
    assert.match(String(logged[0][1]), /^Error [0-9a-f]{12}$/);
    assert.equal(String(logged[0]).includes('hunter2'), false);
    assert.equal(String(logged[1]).includes('other cleanup failed'), false);
  });

  it('surfaces a cleanup failure when the migration itself succeeded', async () => {
    const cleanupError = new Error('pool end failed');
    await assert.rejects(
      closeReembedResources(null, { closers: [async () => { throw cleanupError; }] }),
      error => error === cleanupError,
    );
    await closeReembedResources(null, { closers: [async () => {}] });
  });
});

describe('previous vector column dim plan', () => {
  it('adds, reuses, or replaces the one-generation rollback column', () => {
    assert.equal(
      planPreviousColumnForActiveDims({ exists: false, activeDims: 768 }).action,
      'add',
    );
    assert.equal(
      planPreviousColumnForActiveDims({
        exists: true,
        existingDims: 768,
        activeDims: 768,
      }).action,
      'reuse',
    );
    assert.equal(
      planPreviousColumnForActiveDims({
        exists: true,
        existingDims: 1536,
        activeDims: 768,
      }).action,
      'replace',
    );
    assert.equal(
      planPreviousColumnForActiveDims({
        exists: true,
        existingDims: null,
        activeDims: 768,
      }).action,
      'replace',
    );
  });

  it('rejects invalid active dimensions and drops only vector_prev', () => {
    assert.equal(
      planPreviousColumnForActiveDims({ exists: true, activeDims: null }).ok,
      false,
    );
    const sql = buildDropPreviousColumnSql();
    assert.match(sql, /DROP COLUMN IF EXISTS vector_prev/);
    assert.doesNotMatch(sql, /vector_next/);
  });
});

describe('vector / halfvec index selection', () => {
  it('selects plain vector HNSW at or below 2000 dims', () => {
    assert.equal(halfvecMode(1536), 'vector');
    const idx = buildActiveIndexSql(1536);
    assert.equal(idx.mode, 'vector');
    assert.match(idx.sql, /USING hnsw \(vector vector_cosine_ops\)/);
    assert.doesNotMatch(idx.sql, /halfvec/);

    const stageIdx = buildStageIndexSql(1024);
    assert.equal(stageIdx.mode, 'vector');
    assert.match(stageIdx.sql, /vector_next vector_cosine_ops/);
  });

  it('reuses the pgvector service mode helper and matches its startup index SQL', () => {
    assert.equal(halfvecMode, pgvectorHalfvecMode);
    const pgvectorSource = readFileSync(new URL('../src/services/pgvector.js', import.meta.url), 'utf8');
    assert.ok(pgvectorSource.includes(buildActiveIndexSql(1536).sql));
    assert.ok(pgvectorSource.includes(
      buildActiveIndexSql(3072).sql.replace('halfvec(3072)', 'halfvec(${dims})'),
    ));
  });

  it('selects halfvec HNSW above 2000 dims', () => {
    assert.equal(halfvecMode(3072), 'halfvec');
    const idx = buildActiveIndexSql(3072);
    assert.equal(idx.mode, 'halfvec');
    assert.match(idx.sql, /vector::halfvec\(3072\)/);
    assert.match(idx.sql, /halfvec_cosine_ops/);
  });
});

describe('no SQL path nulls the active vector during staging', () => {
  it('stage update writes vector_next + generation + content_hash atomically', () => {
    const sql = buildStageUpdateSql();
    assert.match(sql, /SET\s+vector_next\s*=\s*\$1::vector/i);
    assert.match(sql, /vector_next_generation\s*=\s*\$2/i);
    assert.match(sql, /vector_next_content_hash\s*=\s*\$3/i);
    assert.match(sql, /WHERE id = \$4/i);
    assert.doesNotMatch(sql, /SET\s+vector\s*=/i);
    assert.equal(assertNoActiveVectorWipe(sql).ok, true);
  });

  it('ensure stage column is ADD COLUMN IF NOT EXISTS', () => {
    const sql = buildEnsureStageColumnSql(1536);
    assert.match(sql, /ADD COLUMN IF NOT EXISTS vector_next vector\(1536\)/i);
    assert.equal(assertNoActiveVectorWipe(sql).ok, true);
  });

  it('rejects USING NULL retype and direct vector nulling', () => {
    const wipe = 'ALTER TABLE memories ALTER COLUMN vector TYPE vector(768) USING NULL::vector(768)';
    assert.equal(assertNoActiveVectorWipe(wipe).ok, false);

    const nullUpdate = 'UPDATE memories SET vector = NULL WHERE id = $1';
    assert.equal(assertNoActiveVectorWipe(nullUpdate).ok, false);

    const directStageOverwrite = 'UPDATE memories SET vector = $1::vector WHERE id = $2';
    assert.equal(assertNoActiveVectorWipe(directStageOverwrite).ok, false);
  });

  it('activation promotes only matching generation+hash and clears stage metadata', () => {
    const act = buildActivationSql(1024, { generation: 'gen-xyz' });
    assert.match(act.retypeActive, /CASE WHEN/i);
    assert.match(act.retypeActive, /vector_next_generation = 'gen-xyz'/);
    assert.match(act.retypeActive, /vector_next_content_hash = content_hash/);
    assert.match(act.promoteSameDims, /vector_next_generation = \$1/);
    assert.match(act.nullStage, /vector_next_generation = NULL/);
    assert.match(act.nullStage, /vector_next_content_hash = NULL/);
    assert.match(act.dropStageColumn, /DROP COLUMN IF EXISTS vector_next/);
    assert.match(act.copyPrev, /SET\s+vector_prev\s*=\s*vector/i);
    assert.throws(() => buildActivationSql(1024), /generation/);
    assert.doesNotMatch(act.copyPrev, /WHERE/i);
  });
});

describe('migrationSummary machine-readable contract', () => {
  it('marks ok false on failures or coverage gaps', () => {
    const bad = migrationSummary({
      mode: 'stage',
      apply: true,
      targetDims: 1024,
      failed: 2,
      coverage: { ok: true },
    });
    assert.equal(bad.ok, false);

    const gap = migrationSummary({
      mode: 'activate',
      apply: true,
      targetDims: 1024,
      failed: 0,
      coverage: { ok: false },
    });
    assert.equal(gap.ok, false);

    const good = migrationSummary({
      mode: 'stage',
      apply: true,
      targetDims: 1024,
      failed: 0,
      staged: 5,
      coverage: { ok: true },
    });
    assert.equal(good.ok, true);
    assert.equal(good.index_mode, 'vector');
  });
});
