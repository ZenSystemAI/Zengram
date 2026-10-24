#!/usr/bin/env node
// Staged embedding migration: swap the embedding model (and dimensionality)
// without taking search down while the corpus is re-embedded.
//
// Dual-column workflow. The active `memories.vector` column keeps serving search
// and is never nulled or overwritten while staging:
//   1) dry-run (default)  report what would happen; no writes
//   2) --stage [--apply]  embed every memory's text with the CURRENTLY CONFIGURED
//                         embedding env into memories.vector_next and record the
//                         target provenance; resumable (rows already staged for
//                         the same generation and content_hash are skipped)
//   3) --activate --apply validate full coverage under an advisory lock and an
//                         ACCESS EXCLUSIVE table lock, copy the current vectors
//                         to vector_prev, promote vector_next -> vector in one
//                         transaction, and rebuild the HNSW index (halfvec cast
//                         above 2000 dims)
//
// Run with the same POSTGRES_URL the API uses and the TARGET embedding env:
//   node api/scripts/reembed.js                       # dry-run overview
//   node api/scripts/reembed.js --stage --apply       # stage (repeat to catch up)
//   node api/scripts/reembed.js --activate            # preview the cutover
//   node api/scripts/reembed.js --activate --apply    # cut over
// then restart the API with the target embedding env. See docs/operations.md.
//
// Flags:
//   --stage             stage mode (writes vector_next with --apply)
//   --activate          cutover mode (writes only with --apply; rejects --limit/--collection)
//   --apply / --commit  perform writes (default: preview). A bare --commit or
//                       --apply means --stage --apply
//   --concurrency N     parallel embed calls (default: 4)
//   --collection NAME   only stage one collection (forbidden with --activate)
//   --limit N           cap rows staged (testing; forbidden with --activate)
//
// Payloads, the BM25 index and entities are untouched. A machine-readable summary
// is printed as a final line prefixed with `[reembed-summary]`. Exit code is
// nonzero on stage failures, a refused or failed activation, or bad flags.

import { pathToFileURL } from 'node:url';
import pg from 'pg';
import {
  initEmbeddings,
  embed,
  getEmbeddingDimensions,
  getEmbeddingProvenance,
} from '../src/services/embedders/interface.js';
import { errorSummary } from '../src/lib/log.js';
import {
  ADVISORY_LOCK_KEY1,
  ADVISORY_LOCK_KEY2,
  META_KEY_PREVIOUS,
  META_KEY_TARGET,
  META_TABLE,
  MigrationRefusedError,
  PREV_COLUMN,
  STAGE_COLUMN,
  STAGE_CONTENT_HASH_COLUMN,
  STAGE_GENERATION_COLUMN,
  assertActivationScope,
  assertNoActiveVectorWipe,
  assertTargetMetaMatchesProvenance,
  buildActiveIndexSql,
  buildActivationSql,
  buildCoverageSql,
  buildDropPreviousColumnSql,
  buildDropStageColumnSql,
  buildPreviousProvenance,
  buildEnsurePrevColumnSql,
  buildEnsureStageColumnSql,
  buildEnsureStageMetaColumnsSql,
  buildStageColumnEmptyCheckSql,
  buildStageSelectSql,
  buildStageUpdateSql,
  halfvecMode,
  isCurrentStagedRow,
  migrationSummary,
  parseCliArgs,
  planStageColumnForTargetDims,
  planPreviousColumnForActiveDims,
  textOf,
  validateCoverage,
  vecLiteral,
} from '../src/services/embedding-migration.js';

const POSTGRES_URL_MISSING = 'POSTGRES_URL is not set — refusing to run without an explicit DSN';

// Printable form of an error: a migration refusal verbatim, anything else as a
// fingerprint (driver and HTTP errors can embed a DSN or an API key).
export function describeError(e) {
  if (e instanceof MigrationRefusedError) return e.message;
  return `Error ${errorSummary(e)}`;
}

export async function currentColumnDims(pool, column = 'vector') {
  // Prefer atttypmod (declared vector(N)); fall back to sampling a non-null value.
  const meta = await pool.query(
    `SELECT a.atttypmod AS dims
       FROM pg_attribute a
       JOIN pg_class c ON a.attrelid = c.oid
       JOIN pg_namespace n ON c.relnamespace = n.oid
      WHERE c.relname = 'memories'
        AND n.nspname = 'public'
        AND a.attname = $1
        AND a.attnum > 0
        AND NOT a.attisdropped`,
    [column],
  );
  if (meta.rows.length === 0) return null;
  const declared = meta.rows[0]?.dims;
  if (declared != null && declared > 0) return declared;

  const { rows } = await pool.query(
    `SELECT ${column}::text AS v FROM memories WHERE ${column} IS NOT NULL LIMIT 1`,
  );
  if (!rows.length || !rows[0].v) return null;
  return rows[0].v.slice(1, -1).split(',').length;
}

async function columnExists(pool, column) {
  const { rows } = await pool.query(
    `SELECT 1
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'memories'
        AND column_name = $1
      LIMIT 1`,
    [column],
  );
  return rows.length > 0;
}

// Same definition the structured store creates at API startup (stores/postgres.js).
async function ensureMetaTable(client) {
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${META_TABLE} (key TEXT PRIMARY KEY, value TEXT, updated_at TIMESTAMPTZ DEFAULT NOW())`,
  );
}

export async function writeMeta(client, key, value) {
  await ensureMetaTable(client);
  await client.query(
    `INSERT INTO ${META_TABLE} (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, JSON.stringify(value)],
  );
}

// Read-only: a missing meta table means no migration has been recorded yet.
export async function readMeta(client, key) {
  let rows;
  try {
    ({ rows } = await client.query(`SELECT value FROM ${META_TABLE} WHERE key = $1`, [key]));
  } catch (e) {
    if (e?.code === '42P01') return null; // undefined_table
    throw e;
  }
  const value = rows[0]?.value ?? null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new MigrationRefusedError(`${META_TABLE} ${key} contains invalid JSON`);
  }
}

function printSummary(summary) {
  console.log(`[reembed-summary] ${JSON.stringify(summary)}`);
}

async function ensureStageSchema(pool, targetDims) {
  // Stage identity columns always exist (TEXT, dim-independent).
  for (const sql of buildEnsureStageMetaColumnsSql()) {
    await pool.query(sql);
  }

  const stageExists = await columnExists(pool, STAGE_COLUMN);
  const existingDims = stageExists ? await currentColumnDims(pool, STAGE_COLUMN) : null;
  let stageNonNull = 0;
  let stageGenNonNull = 0;
  let stageHashNonNull = 0;
  if (stageExists) {
    const { rows } = await pool.query(buildStageColumnEmptyCheckSql());
    stageNonNull = Number(rows[0]?.stage_nonnull) || 0;
    stageGenNonNull = Number(rows[0]?.stage_generation_nonnull) || 0;
    stageHashNonNull = Number(rows[0]?.stage_hash_nonnull) || 0;
  }

  const plan = planStageColumnForTargetDims({
    existingDims,
    targetDims,
    stageNonNullCount: stageNonNull,
    stageGenerationNonNullCount: stageGenNonNull,
    stageHashNonNullCount: stageHashNonNull,
  });
  if (!plan.ok) throw new MigrationRefusedError(plan.error);

  if (plan.action === 'add' || plan.action === 'drop_add') {
    if (plan.action === 'drop_add') {
      await pool.query(`DROP INDEX IF EXISTS idx_memories_vector_next_hnsw`);
      await pool.query(buildDropStageColumnSql());
    }
    const addSql = buildEnsureStageColumnSql(targetDims);
    const guard = assertNoActiveVectorWipe(addSql);
    if (!guard.ok) throw new MigrationRefusedError(guard.error);
    await pool.query(addSql);
  }
  // action === 'noop': already the target dims
  return plan;
}

async function runStage(pool, {
  apply,
  concurrency,
  collection,
  limit,
  targetDims,
  provenance,
  existingDims,
}) {
  const generation = provenance.generation;
  if (!generation) throw new MigrationRefusedError('provenance.generation is required for staging');

  const { sql, params } = buildStageSelectSql({
    collection,
    limit,
    includeStageMetadata: apply,
  });
  const stageUpdateSql = buildStageUpdateSql();
  for (const s of [sql, stageUpdateSql, buildEnsureStageColumnSql(targetDims)]) {
    const guard = assertNoActiveVectorWipe(s);
    if (!guard.ok) throw new MigrationRefusedError(guard.error);
  }

  if (apply) {
    await ensureStageSchema(pool, targetDims);
    const [activeMeta, previousMeta] = await Promise.all([
      readMeta(pool, META_KEY_TARGET),
      readMeta(pool, META_KEY_PREVIOUS),
    ]);
    await writeMeta(pool, META_KEY_PREVIOUS, buildPreviousProvenance({
      activeMeta,
      previousMeta,
      retainedDims: existingDims || targetDims,
      nextGeneration: generation,
    }));
    await writeMeta(pool, META_KEY_TARGET, {
      ...provenance,
      staged_at: new Date().toISOString(),
      target_dims: targetDims,
      existing_dims: existingDims,
      status: 'staging',
    });
  }

  const { rows } = await pool.query(sql, params);

  const withText = rows.filter((r) => textOf(r.payload).trim());
  const skipped = rows.length - withText.length;

  if (!apply) {
    const summary = migrationSummary({
      mode: 'stage',
      apply: false,
      provenance,
      existingDims,
      targetDims,
      selected: rows.length,
      embeddable: withText.length,
      skipped,
      indexMode: halfvecMode(targetDims),
    });
    console.log(`[reembed] DRY-RUN stage: would embed ${withText.length} rows into ${STAGE_COLUMN} at ${targetDims} dims (${halfvecMode(targetDims)} index) with generation=${generation}.`);
    printSummary(summary);
    return summary;
  }

  const pending = withText.filter((row) => !isCurrentStagedRow(row, generation));
  const reused = withText.length - pending.length;

  let done = 0;
  let failed = 0;
  const failures = [];
  let cursor = 0;

  async function worker() {
    while (cursor < pending.length) {
      const idx = cursor++;
      const row = pending[idx];
      try {
        const contentHash = row.content_hash;
        if (!contentHash) {
          throw new MigrationRefusedError('row missing content_hash — cannot stage without content identity');
        }
        const vector = await embed(textOf(row.payload), 'store');
        if (!Array.isArray(vector) || vector.length !== targetDims) {
          throw new MigrationRefusedError(`embed returned ${Array.isArray(vector) ? vector.length : typeof vector} dims, expected ${targetDims}`);
        }
        // One statement: vector_next + generation + content_hash. Never the active vector.
        await pool.query(stageUpdateSql, [vecLiteral(vector), generation, contentHash, row.id]);
        done++;
        if (done % 50 === 0) console.log(`[reembed] staged ${done}/${pending.length} pending (${reused} already current)…`);
      } catch (e) {
        failed++;
        failures.push({ id: row.id, error: describeError(e) });
        console.error('[reembed] FAILED %s: %s', row.id, describeError(e));
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const coverageQuery = buildCoverageSql({ collection, generation });
  const coverageRes = await pool.query(coverageQuery.sql, coverageQuery.params);
  const coverage = validateCoverage(coverageRes.rows[0] || {});

  const summary = migrationSummary({
    mode: 'stage',
    apply: true,
    provenance,
    existingDims,
    targetDims,
    selected: rows.length,
    embeddable: withText.length,
    staged: done + reused,
    failed,
    skipped,
    coverage,
    indexMode: halfvecMode(targetDims),
    error: failed > 0 ? `${failed} stage embed(s) failed` : null,
  });

  console.log(`[reembed] Stage complete: ${done} written, ${reused} already current, ${failed} failed, ${skipped} skipped (no text).`);
  if (failures.length) console.log(`[reembed] failures: ${JSON.stringify(failures.slice(0, 20))}`);
  printSummary(summary);
  return summary;
}

async function evaluateCoverage(clientOrPool, generation, { ensureMetaColumns }) {
  if (!(await columnExists(clientOrPool, STAGE_COLUMN))) {
    return {
      ok: false,
      error: `${STAGE_COLUMN} column missing — run --stage --apply first`,
      required: 0,
      staged: 0,
      missing: 0,
    };
  }
  if (ensureMetaColumns) {
    for (const sql of buildEnsureStageMetaColumnsSql()) {
      await clientOrPool.query(sql);
    }
  } else {
    // Preview: no DDL. Stage creates these columns before vector_next.
    for (const column of [STAGE_GENERATION_COLUMN, STAGE_CONTENT_HASH_COLUMN]) {
      if (!(await columnExists(clientOrPool, column))) {
        return {
          ok: false,
          error: `${column} column missing — run --stage --apply first`,
          required: 0,
          staged: 0,
          missing: 0,
        };
      }
    }
  }
  const coverageQuery = buildCoverageSql({ generation });
  const coverageRes = await clientOrPool.query(coverageQuery.sql, coverageQuery.params);
  return validateCoverage(coverageRes.rows[0] || {});
}

async function runActivate(pool, {
  apply,
  limit,
  collection,
  targetDims,
  provenance,
  existingDims,
}) {
  const generation = provenance?.generation;
  const scope = assertActivationScope({ mode: 'activate', limit, collection });
  const precheckError = !scope.ok
    ? scope.error
    : (!generation ? 'provenance.generation is required for activation' : null);
  if (precheckError) {
    const summary = migrationSummary({
      mode: 'activate',
      apply: false,
      provenance,
      existingDims,
      targetDims,
      error: precheckError,
    });
    printSummary(summary);
    return summary;
  }

  if (!apply) {
    const targetMeta = await readMeta(pool, META_KEY_TARGET);
    const metaCheck = assertTargetMetaMatchesProvenance(targetMeta, provenance);
    const coverage = await evaluateCoverage(pool, generation, { ensureMetaColumns: false });
    const error = !metaCheck.ok ? metaCheck.error : (coverage.ok ? null : coverage.error);
    const summary = migrationSummary({
      mode: 'activate',
      apply: false,
      provenance,
      existingDims,
      targetDims,
      coverage,
      indexMode: halfvecMode(targetDims),
      error,
    });
    console.log(`[reembed] DRY-RUN activate: meta_ok=${metaCheck.ok} coverage_ok=${coverage.ok}, would promote matching ${STAGE_COLUMN} → vector (${targetDims}, ${halfvecMode(targetDims)}), retain ${PREV_COLUMN}.`);
    if (error) console.log(`[reembed] activation would be refused: ${error}`);
    printSummary(summary);
    return summary;
  }

  // Apply the cutover inside one transaction holding an advisory lock (one
  // migration at a time) and an ACCESS EXCLUSIVE table lock (no API write can
  // land between the coverage check and the promotion).
  const client = await pool.connect();
  let summary;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [ADVISORY_LOCK_KEY1, ADVISORY_LOCK_KEY2]);
    await client.query('LOCK TABLE memories IN ACCESS EXCLUSIVE MODE');

    if (!(await columnExists(client, STAGE_COLUMN))) {
      throw new MigrationRefusedError(`${STAGE_COLUMN} missing — run --stage --apply before --activate`);
    }

    for (const sql of buildEnsureStageMetaColumnsSql()) {
      await client.query(sql);
    }

    const stageDims = await currentColumnDims(client, STAGE_COLUMN);
    if (stageDims != null && stageDims !== targetDims) {
      throw new MigrationRefusedError(`${STAGE_COLUMN} dims ${stageDims} != target ${targetDims}`);
    }

    // The recorded target must match the current embedding env before cutover.
    const targetMeta = await readMeta(client, META_KEY_TARGET);
    const metaCheck = assertTargetMetaMatchesProvenance(targetMeta, provenance);
    if (!metaCheck.ok) throw new MigrationRefusedError(metaCheck.error);

    const coverage = await evaluateCoverage(client, generation, { ensureMetaColumns: true });
    if (!coverage.ok) {
      throw new MigrationRefusedError(coverage.error || 'incomplete staging coverage');
    }

    // Stage mode captured the active generation before META_KEY_TARGET became
    // the incoming target. Finalize that rollback metadata without ever
    // copying the staged target identity onto vector_prev.
    const activeDimsBefore = await currentColumnDims(client, 'vector')
      || existingDims
      || targetDims;
    const previousMeta = await readMeta(client, META_KEY_PREVIOUS);
    await writeMeta(client, META_KEY_PREVIOUS, buildPreviousProvenance({
      previousMeta,
      retainedDims: activeDimsBefore,
      nextGeneration: generation,
    }));

    // vector_prev is a one-generation snapshot. Replace a mismatched column
    // from an older migration before copying the current active generation.
    const previousExists = await columnExists(client, PREV_COLUMN);
    const previousDims = previousExists
      ? await currentColumnDims(client, PREV_COLUMN)
      : null;
    const previousPlan = planPreviousColumnForActiveDims({
      exists: previousExists,
      existingDims: previousDims,
      activeDims: activeDimsBefore,
    });
    if (!previousPlan.ok) throw new MigrationRefusedError(previousPlan.error);
    if (previousPlan.action === 'replace') {
      await client.query(buildDropPreviousColumnSql());
    }
    if (previousPlan.action === 'add' || previousPlan.action === 'replace') {
      await client.query(buildEnsurePrevColumnSql(activeDimsBefore));
    }

    const act = buildActivationSql(targetDims, { generation });

    // Drop indexes before a column type change.
    await client.query(act.dropActiveIndex);
    await client.query(act.dropStageIndex);

    // Retain the current vectors, then promote only generation+hash matched rows.
    await client.query(act.copyPrev);

    const activeDimsNow = await currentColumnDims(client, 'vector');
    if (activeDimsNow != null && activeDimsNow === targetDims) {
      await client.query(act.promoteSameDims, [generation]);
    } else {
      await client.query(act.retypeActive);
    }

    // Clear the stage vector + identity metadata, then drop the empty stage
    // column so a later different-dim migration can ADD it cleanly.
    await client.query(act.nullStage);
    await client.query(act.dropStageColumn);

    // Rebuild the active HNSW index with the right vector/halfvec ops.
    const index = buildActiveIndexSql(targetDims);
    await client.query(index.sql);
    await client.query('ANALYZE memories');

    await writeMeta(client, META_KEY_TARGET, {
      ...provenance,
      activated_at: new Date().toISOString(),
      target_dims: targetDims,
      index_mode: index.mode,
      status: 'active',
    });

    await client.query('COMMIT');

    summary = migrationSummary({
      mode: 'activate',
      apply: true,
      provenance,
      existingDims,
      targetDims,
      staged: coverage.staged,
      embeddable: coverage.required,
      coverage,
      indexMode: index.mode,
    });
    console.log(`[reembed] Activate complete: promoted ${coverage.staged} vectors, index mode=${index.mode}, previous retained in ${PREV_COLUMN}, stage column dropped for next migration.`);
    console.log('[reembed] Restart the API with the target embedding env now; until then it embeds queries with the old model.');
    printSummary(summary);
    return summary;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    const error = describeError(e);
    summary = migrationSummary({
      mode: 'activate',
      apply: true,
      provenance,
      existingDims,
      targetDims,
      error,
    });
    console.error('[reembed] Activate refused or failed (rolled back, active vectors unchanged): %s', error);
    printSummary(summary);
    return summary;
  } finally {
    client.release();
  }
}

// Close every resource; a cleanup failure never replaces the migration error.
export async function closeReembedResources(primaryError = null, {
  closers = [],
  logError = console.error,
} = {}) {
  const settlements = await Promise.allSettled(
    closers.map((close) => Promise.resolve().then(() => close())),
  );
  const failures = settlements
    .filter(result => result.status === 'rejected')
    .map(result => result.reason);

  if (primaryError) {
    for (const failure of failures) {
      try {
        logError('[reembed] resource shutdown failed while preserving primary error: %s', describeError(failure));
      } catch {
        // Cleanup reporting must never replace the migration failure.
      }
    }
    throw primaryError;
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, 'reembed resource shutdown failed');
  }
}

async function main(args) {
  const { mode, apply, concurrency, collection, limit } = args;
  const postgresUrl = process.env.POSTGRES_URL;
  if (!postgresUrl) {
    console.error(`[reembed] ${POSTGRES_URL_MISSING}.`);
    printSummary(migrationSummary({ mode, apply: false, targetDims: null, error: POSTGRES_URL_MISSING }));
    process.exit(1);
  }

  console.log(`[reembed] mode=${mode} apply=${apply} concurrency=${concurrency}` +
    `${collection ? ` collection=${collection}` : ''}${limit ? ` limit=${limit}` : ''}`);

  // Reject unsafe activate flags early (also re-checked inside runActivate).
  if (mode === 'activate') {
    const scope = assertActivationScope({ mode, limit, collection });
    if (!scope.ok) {
      console.error('[reembed] %s', scope.error);
      printSummary(migrationSummary({ mode, apply: false, targetDims: null, error: scope.error }));
      process.exit(2);
    }
  }

  const pool = new pg.Pool({ connectionString: postgresUrl });
  pool.on('error', (e) => console.error('[reembed] idle client error: %s', errorSummary(e)));

  let primaryError = null;
  try {
    await initEmbeddings();
    const targetDims = getEmbeddingDimensions();
    const provenance = getEmbeddingProvenance({ dimensions: targetDims });
    console.log(`[reembed] target provenance: ${JSON.stringify(provenance)}`);

    const existingDims = await currentColumnDims(pool, 'vector');
    console.log(`[reembed] Existing active dims: ${existingDims ?? 'unknown/empty'} → target ${targetDims} (${halfvecMode(targetDims)})`);

    let summary;
    if (mode === 'activate') {
      summary = await runActivate(pool, {
        apply, limit, collection, targetDims, provenance, existingDims,
      });
    } else if (mode === 'stage') {
      summary = await runStage(pool, {
        apply, concurrency, collection, limit, targetDims, provenance, existingDims,
      });
    } else {
      // Default dry-run overview (no writes).
      const { sql, params } = buildStageSelectSql({
        collection,
        limit,
        includeStageMetadata: false,
      });
      const { rows } = await pool.query(sql, params);
      const withText = rows.filter((r) => textOf(r.payload).trim());
      summary = migrationSummary({
        mode: 'dry-run',
        apply: false,
        provenance,
        existingDims,
        targetDims,
        selected: rows.length,
        embeddable: withText.length,
        skipped: rows.length - withText.length,
        indexMode: halfvecMode(targetDims),
      });
      console.log(`[reembed] DRY-RUN: ${withText.length} embeddable / ${rows.length} selected. Next: --stage --apply, then --activate --apply.`);
      printSummary(summary);
    }

    if (!summary.ok) process.exitCode = 1;
  } catch (error) {
    primaryError = error;
  }
  await closeReembedResources(primaryError, { closers: [() => pool.end()] });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseCliArgs(process.argv.slice(2));
  main(args).catch((e) => {
    const error = describeError(e);
    console.error('[reembed] fatal: %s', error);
    printSummary(migrationSummary({ mode: args.mode, apply: args.apply, targetDims: null, error }));
    process.exit(1);
  });
}
