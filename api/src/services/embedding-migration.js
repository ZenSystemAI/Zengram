// Pure helpers for the staged dual-column embedding migration (scripts/reembed.js).
// SQL generation and validation live here, out of the CLI, so they are
// unit-testable without a live Postgres.
//
// Columns on `memories`:
//   vector                    the active column the API searches; never nulled
//                             or overwritten while staging
//   vector_next               staged replacement at the target dims
//   vector_next_generation    embedding generation each staged row was built with
//   vector_next_content_hash  content_hash each staged row was built from
//   vector_prev               one-generation snapshot of the vectors replaced
//                             by the last activation

import { halfvecMode } from './pgvector.js';

export { halfvecMode };

export const STAGE_COLUMN = 'vector_next';
export const STAGE_GENERATION_COLUMN = 'vector_next_generation';
export const STAGE_CONTENT_HASH_COLUMN = 'vector_next_content_hash';
export const PREV_COLUMN = 'vector_prev';
// Migration provenance lives in the same key/value table the structured store
// already keeps (stores/postgres.js), as JSON text.
export const META_TABLE = 'zengram_meta';
export const META_KEY_TARGET = 'embedding_migration_target';
// Identity of the vectors currently in vector_prev; written only by activation.
export const META_KEY_PREVIOUS = 'embedding_migration_previous';
// Identity of the active vectors, captured when staging starts; it becomes
// META_KEY_PREVIOUS only when activation copies those vectors into vector_prev.
export const META_KEY_PENDING_PREVIOUS = 'embedding_migration_pending_previous';
export const ADVISORY_LOCK_KEY1 = 0x5a47524d; // 'ZGRM'
export const ADVISORY_LOCK_KEY2 = 0x4d494752; // 'MIGR'

// A refusal the migration raises itself (coverage gap, provenance mismatch,
// unsafe flags). Its message is built from counts and column names only, so the
// CLI prints it verbatim; any other error is logged as a fingerprint
// (lib/log.js errorSummary) because driver errors can carry a DSN.
export class MigrationRefusedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MigrationRefusedError';
  }
}

// Embeddable text: the first non-empty payload text field (text, content, note,
// title). hasEmbeddableText() applies the same rule to rows read by the CLI.
// Whitespace-only text counts, because the API accepts and embeds it as stored.
const EMBEDDABLE_TEXT_SQL = `COALESCE(NULLIF(payload->>'text',''), NULLIF(payload->>'content',''), NULLIF(payload->>'note',''), NULLIF(payload->>'title','')) IS NOT NULL`;

export function parseCliArgs(argv = process.argv.slice(2)) {
  const flags = new Set();
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith('--')) continue;
    const eq = tok.indexOf('=');
    if (eq > 0) {
      const key = tok.slice(2, eq);
      values[key] = tok.slice(eq + 1);
      flags.add(key);
      continue;
    }
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next != null && !next.startsWith('--')) {
      values[key] = next;
      flags.add(key);
      i++;
    } else {
      flags.add(key);
      values[key] = true;
    }
  }

  const has = (name) => flags.has(name);
  const intOr = (name, dflt) => {
    if (!(name in values) || values[name] === true) return dflt;
    const n = parseInt(String(values[name]), 10);
    return Number.isFinite(n) ? n : dflt;
  };

  // Modes: dry-run (default), stage, activate. --apply (or legacy --commit)
  // turns the selected mode into a write. Bare --commit with no mode ≡ stage --apply
  // is intentionally NOT supported for activation; activate requires explicit --activate.
  let mode = 'dry-run';
  if (has('activate')) mode = 'activate';
  else if (has('stage')) mode = 'stage';
  else if (has('commit') || has('apply')) mode = 'stage';

  const apply = has('apply') || has('commit');
  // dry-run stays non-writing even if someone passes --stage without --apply
  if (mode === 'dry-run') {
    // no-op
  } else if (!apply && (has('stage') || has('activate'))) {
    // explicit mode without --apply → still dry (preview that mode)
  }

  // Malformed scope values are errors, never silent defaults: a dropped
  // --limit or --collection would otherwise turn a scoped run into a full one.
  const errors = [];
  if (has('limit') && !/^\d+$/.test(String(values.limit))) {
    errors.push('--limit needs a non-negative integer');
  }
  if (has('collection') && (values.collection === true || String(values.collection).trim() === '')) {
    errors.push('--collection needs a collection name');
  }

  const concurrency = Math.max(1, intOr('concurrency', 4));
  const limit = Math.max(0, intOr('limit', 0));
  const collection = (values.collection && values.collection !== true)
    ? String(values.collection)
    : null;

  return {
    mode, // 'dry-run' | 'stage' | 'activate'
    apply: mode === 'dry-run' ? false : apply,
    concurrency,
    limit,
    collection,
    limitSupplied: has('limit'),
    collectionSupplied: has('collection'),
    errors,
    raw: { flags: [...flags], values },
  };
}

// Activation must cover the full corpus of rows that have embeddable text.
// Scoped --limit / --collection are fine for stage previews, never for cutover;
// supplying either flag at all (even malformed or empty) refuses activation.
/**
 * @param {{ limit?: number, collection?: string|null, mode?: string,
 *   limitSupplied?: boolean, collectionSupplied?: boolean }} [opts]
 */
export function assertActivationScope({
  limit = 0,
  collection = null,
  mode,
  limitSupplied = false,
  collectionSupplied = false,
} = {}) {
  if (mode !== 'activate') return { ok: true };
  const problems = [];
  if (limitSupplied || (limit && Number(limit) > 0)) {
    problems.push('--limit is not allowed with --activate (partial cutover is unsafe)');
  }
  if (collectionSupplied || collection) {
    problems.push('--collection is not allowed with --activate (partial cutover is unsafe)');
  }
  if (problems.length) {
    return { ok: false, error: problems.join('; '), problems };
  }
  return { ok: true };
}

export function textOf(payload) {
  return (payload && (payload.text || payload.content || payload.note || payload.title)) || '';
}

// Same rule as EMBEDDABLE_TEXT_SQL, so staging embeds exactly the rows that
// coverage requires.
export function hasEmbeddableText(payload) {
  return String(textOf(payload)) !== '';
}

export function vecLiteral(arr) {
  return `[${arr.join(',')}]`;
}

export function isCurrentStagedRow(row, generation) {
  const expectedGeneration = String(generation || '').trim();
  return Boolean(
    expectedGeneration
    && row?.has_stage_vector
    && row.stage_generation === expectedGeneration
    && row.stage_content_hash != null
    && row.content_hash != null
    && row.stage_content_hash === row.content_hash
  );
}

export function buildEnsureStageColumnSql(dims) {
  const n = Number(dims);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`invalid dims for stage column: ${dims}`);
  // ADD COLUMN IF NOT EXISTS never touches the active `vector` column.
  return `ALTER TABLE memories ADD COLUMN IF NOT EXISTS ${STAGE_COLUMN} vector(${n})`;
}

// Bounded per-row stage identity columns. TEXT fingerprints only — no vectors/raw text.
export function buildEnsureStageMetaColumnsSql() {
  return [
    `ALTER TABLE memories ADD COLUMN IF NOT EXISTS ${STAGE_GENERATION_COLUMN} TEXT`,
    `ALTER TABLE memories ADD COLUMN IF NOT EXISTS ${STAGE_CONTENT_HASH_COLUMN} TEXT`,
  ];
}

export function buildEnsurePrevColumnSql(dims) {
  const n = Number(dims);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`invalid dims for prev column: ${dims}`);
  return `ALTER TABLE memories ADD COLUMN IF NOT EXISTS ${PREV_COLUMN} vector(${n})`;
}

// Staging writes vector_next + generation + content_hash atomically.
// Never SET vector = NULL / overwrite active.
// Params: $1 vector literal, $2 generation, $3 content_hash, $4 id
export function buildStageUpdateSql() {
  return (
    `UPDATE memories SET ${STAGE_COLUMN} = $1::vector, ` +
    `${STAGE_GENERATION_COLUMN} = $2, ` +
    `${STAGE_CONTENT_HASH_COLUMN} = $3 ` +
    `WHERE id = $4`
  );
}

/** @param {{ collection?: string|null, limit?: number, includeStageMetadata?: boolean }} [opts] */
export function buildStageSelectSql({
  collection = null,
  limit = 0,
  includeStageMetadata = true,
} = {}) {
  const where = ['1=1'];
  const params = [];
  if (collection) {
    params.push(collection);
    where.push(`collection = $${params.length}`);
  }
  const stageColumns = includeStageMetadata
    ? (
      `, vector IS NOT NULL AS has_active_vector` +
      `, ${STAGE_COLUMN} IS NOT NULL AS has_stage_vector` +
      `, ${STAGE_GENERATION_COLUMN} AS stage_generation` +
      `, ${STAGE_CONTENT_HASH_COLUMN} AS stage_content_hash`
    )
    : '';
  let sql = (
    `SELECT id, payload, content_hash${stageColumns} ` +
    `FROM memories WHERE ${where.join(' AND ')} ORDER BY created_at DESC`
  );
  if (limit && Number(limit) > 0) {
    sql += ` LIMIT ${Number(limit)}`;
  }
  return { sql, params };
}

// Valid staged row: non-null vector_next, generation matches current target,
// and staged content_hash equals the row's current content_hash (both non-null).
// Stale generation or post-stage content edits count as missing.
// Also blocks rows with an active vector but no embeddable text — a dim-change
// retype USING vector_next would otherwise silently NULL them.
/** @param {{ collection?: string|null, generation?: string }} [opts] */
export function buildCoverageSql({ collection = null, generation } = {}) {
  if (generation == null || String(generation).trim() === '') {
    throw new Error('buildCoverageSql requires generation');
  }
  const params = [String(generation)];
  let collectionClause = '';
  if (collection) {
    params.push(collection);
    collectionClause = ` AND collection = $${params.length}`;
  }

  const validStage = (
    `${STAGE_COLUMN} IS NOT NULL` +
    ` AND ${STAGE_GENERATION_COLUMN} IS NOT NULL` +
    ` AND ${STAGE_GENERATION_COLUMN} = $1` +
    ` AND ${STAGE_CONTENT_HASH_COLUMN} IS NOT NULL` +
    ` AND content_hash IS NOT NULL` +
    ` AND ${STAGE_CONTENT_HASH_COLUMN} = content_hash`
  );

  const staleOrMismatch = (
    `${STAGE_COLUMN} IS NOT NULL` +
    ` AND NOT (${validStage})`
  );

  // Active vector with nothing to re-embed cannot survive a dim-change retype.
  const activeNoText = (
    `vector IS NOT NULL AND NOT (${EMBEDDABLE_TEXT_SQL})`
  );

  const sql = `
    SELECT
      COUNT(*) FILTER (
        WHERE ${EMBEDDABLE_TEXT_SQL}
      ) AS required_count,
      COUNT(*) FILTER (
        WHERE ${EMBEDDABLE_TEXT_SQL}
          AND ${validStage}
      ) AS staged_count,
      COUNT(*) FILTER (
        WHERE ${EMBEDDABLE_TEXT_SQL}
          AND NOT (${validStage})
      ) AS missing_count,
      COUNT(*) FILTER (
        WHERE ${EMBEDDABLE_TEXT_SQL}
          AND ${STAGE_COLUMN} IS NULL
      ) AS missing_null_stage_count,
      COUNT(*) FILTER (
        WHERE ${EMBEDDABLE_TEXT_SQL}
          AND ${staleOrMismatch}
      ) AS stale_or_mismatch_count,
      COUNT(*) FILTER (
        WHERE ${EMBEDDABLE_TEXT_SQL}
          AND ${STAGE_COLUMN} IS NOT NULL
          AND (${STAGE_GENERATION_COLUMN} IS NULL OR ${STAGE_GENERATION_COLUMN} IS DISTINCT FROM $1)
      ) AS stale_generation_count,
      COUNT(*) FILTER (
        WHERE ${EMBEDDABLE_TEXT_SQL}
          AND ${STAGE_COLUMN} IS NOT NULL
          AND ${STAGE_GENERATION_COLUMN} = $1
          AND (
            ${STAGE_CONTENT_HASH_COLUMN} IS NULL
            OR content_hash IS NULL
            OR ${STAGE_CONTENT_HASH_COLUMN} IS DISTINCT FROM content_hash
          )
      ) AS content_hash_mismatch_count,
      COUNT(*) FILTER (
        WHERE ${activeNoText}
      ) AS active_vector_without_text_count,
      COUNT(*) FILTER (WHERE vector IS NOT NULL) AS active_nonnull_count
    FROM memories
    WHERE 1=1${collectionClause}
  `;
  return { sql, params };
}

export function validateCoverage(row = {}) {
  const required = Number(row.required_count) || 0;
  const staged = Number(row.staged_count) || 0;
  const missing = Number(row.missing_count) || 0;
  const staleOrMismatch = Number(row.stale_or_mismatch_count) || 0;
  const staleGeneration = Number(row.stale_generation_count) || 0;
  const hashMismatch = Number(row.content_hash_mismatch_count) || 0;
  const missingNull = Number(row.missing_null_stage_count) || 0;
  const activeNoText = Number(row.active_vector_without_text_count) || 0;
  const embeddableComplete = required > 0 ? missing === 0 && staged === required : missing === 0;
  const complete = embeddableComplete && activeNoText === 0;
  let error = null;
  if (!complete) {
    const parts = [];
    if (!embeddableComplete) {
      parts.push(
        `incomplete staging coverage: ${missing} of ${required} embeddable rows not valid for current generation`,
      );
      if (staleGeneration > 0) parts.push(`${staleGeneration} stale generation`);
      if (hashMismatch > 0) parts.push(`${hashMismatch} content_hash mismatch`);
      if (missingNull > 0) parts.push(`${missingNull} missing ${STAGE_COLUMN}`);
    }
    if (activeNoText > 0) {
      parts.push(
        `${activeNoText} row(s) have active vector but no embeddable text ` +
        `(dim-change retype would NULL them)`,
      );
    }
    error = parts.join('; ');
  }
  return {
    ok: complete,
    required,
    staged,
    missing,
    stale_or_mismatch_count: staleOrMismatch,
    stale_generation_count: staleGeneration,
    content_hash_mismatch_count: hashMismatch,
    missing_null_stage_count: missingNull,
    active_vector_without_text_count: activeNoText,
    active_nonnull_count: Number(row.active_nonnull_count) || 0,
    error,
  };
}

// Global META_KEY_TARGET must describe the same embedding identity we are about
// to activate — prevents mislabeling a prior same-dim stage from another model.
export function assertTargetMetaMatchesProvenance(meta, provenance) {
  if (!provenance || typeof provenance !== 'object') {
    return { ok: false, error: 'current provenance is required' };
  }
  if (!meta || typeof meta !== 'object') {
    return { ok: false, error: `${META_KEY_TARGET} missing — run --stage --apply before --activate` };
  }
  const fields = ['generation', 'provider', 'model', 'dimensions', 'query_prefix_fp', 'document_prefix_fp', 'normalization'];
  const mismatches = [];
  for (const field of fields) {
    const left = meta[field];
    const right = provenance[field];
    // null/undefined dimensions both mean unknown — treat as equal only if both nullish
    if (field === 'dimensions') {
      const l = left == null ? null : Number(left);
      const r = right == null ? null : Number(right);
      if (l !== r) mismatches.push(field);
      continue;
    }
    if (String(left ?? '') !== String(right ?? '')) mismatches.push(field);
  }
  if (mismatches.length) {
    return {
      ok: false,
      error: `${META_KEY_TARGET} does not match current provenance (${mismatches.join(', ')}); re-run --stage --apply under the target embedding env`,
      mismatches,
    };
  }
  return { ok: true };
}

// Staged rows are reused when their generation and content_hash still match.
// With EMBEDDING_GENERATION pinned, a provider/model/dims/prefix change keeps
// the same generation, so vectors staged under the old identity would be reused
// and later promoted under the new one. Refuse that before any write.
export function assertStageTargetCompatible(targetMeta, provenance) {
  if (!targetMeta || typeof targetMeta !== 'object' || targetMeta.status !== 'staging') {
    return { ok: true };
  }
  if (String(targetMeta.generation ?? '') !== String(provenance?.generation ?? '')) {
    return { ok: true };
  }
  const match = assertTargetMetaMatchesProvenance(targetMeta, provenance);
  if (match.ok) return { ok: true };
  return {
    ok: false,
    error: (
      `generation ${provenance.generation} is already staged under a different embedding identity ` +
      `(${(match.mismatches || []).join(', ') || match.error}); set a new EMBEDDING_GENERATION to restage`
    ),
    mismatches: match.mismatches || [],
  };
}

// Capture the currently active generation before META_KEY_TARGET is reused for
// a staged target (stored under META_KEY_PENDING_PREVIOUS until activation). If
// staging is resumed/switched, previousMeta (the pending capture) remains the
// source of truth; a target whose status is "staging" is never mislabeled active.
/**
 * @param {{ activeMeta?: Record<string, any>|null, previousMeta?: Record<string, any>|null, retainedDims?: number,
 *   nextGeneration?: string, retainedAt?: string }} [opts]
 */
export function buildPreviousProvenance({
  activeMeta = null,
  previousMeta = null,
  retainedDims,
  nextGeneration,
  retainedAt = new Date().toISOString(),
} = {}) {
  const dims = Number(retainedDims);
  if (!Number.isInteger(dims) || dims <= 0) {
    throw new Error(`invalid retained dims: ${retainedDims}`);
  }
  const generation = String(nextGeneration || '').trim();
  if (!generation) {
    throw new Error('nextGeneration is required');
  }

  const active = activeMeta
    && typeof activeMeta === 'object'
    && !Array.isArray(activeMeta)
    && activeMeta.status === 'active'
    ? activeMeta
    : null;
  const previous = previousMeta
    && typeof previousMeta === 'object'
    && !Array.isArray(previousMeta)
    ? previousMeta
    : null;
  const source = active || previous || {};
  const provenanceKnown = ['generation', 'provider', 'model']
    .every((field) => source[field] != null && String(source[field]).trim() !== '');

  return {
    ...source,
    status: 'retained',
    provenance_known: provenanceKnown,
    retained_at: retainedAt,
    retained_dims: dims,
    retained_for_generation: generation,
  };
}

// Decide how to make vector_next ready for targetDims without manual cleanup.
// existingDims null → column missing (ADD). Same dims → noop. Different dims
// only safe when every stage value + stage metadata row is NULL (then DROP+ADD
// or retype-empty); any residual stage data blocks.
/**
 * @param {{ existingDims?: number|null, targetDims?: number, stageNonNullCount?: number,
 *   stageGenerationNonNullCount?: number, stageHashNonNullCount?: number }} [opts]
 */
export function planStageColumnForTargetDims({
  existingDims = null,
  targetDims,
  stageNonNullCount = 0,
  stageGenerationNonNullCount = 0,
  stageHashNonNullCount = 0,
} = {}) {
  const target = Number(targetDims);
  if (!Number.isInteger(target) || target <= 0) {
    return { ok: false, action: 'error', error: `invalid target dims: ${targetDims}` };
  }
  if (existingDims == null) {
    return { ok: true, action: 'add', targetDims: target };
  }
  const existing = Number(existingDims);
  if (!Number.isInteger(existing) || existing <= 0) {
    return { ok: false, action: 'error', error: `invalid existing stage dims: ${existingDims}` };
  }
  if (existing === target) {
    return { ok: true, action: 'noop', targetDims: target, existingDims: existing };
  }
  const residual = Number(stageNonNullCount) + Number(stageGenerationNonNullCount) + Number(stageHashNonNullCount);
  if (residual > 0) {
    return {
      ok: false,
      action: 'blocked',
      error: (
        `${STAGE_COLUMN} is vector(${existing}) but target is ${target} and ` +
        `${residual} residual stage value(s)/metadata remain; finish or clear the prior stage before changing dims`
      ),
      existingDims: existing,
      targetDims: target,
      residual,
    };
  }
  // Empty stage column at wrong dims: drop+add is the normal safe path.
  return {
    ok: true,
    action: 'drop_add',
    existingDims: existing,
    targetDims: target,
  };
}

// vector_prev is a one-generation rollback snapshot. A later migration may
// start from different active dimensions, so replace (not silently reuse) a
// mismatched prior snapshot column before copying the current active vectors.
/** @param {{ exists?: boolean, existingDims?: number|null, activeDims?: number }} [opts] */
export function planPreviousColumnForActiveDims({
  exists = false,
  existingDims = null,
  activeDims,
} = {}) {
  const active = Number(activeDims);
  if (!Number.isInteger(active) || active <= 0) {
    return { ok: false, action: 'error', error: `invalid active dims: ${activeDims}` };
  }
  if (!exists) {
    return { ok: true, action: 'add', activeDims: active };
  }
  const existing = Number(existingDims);
  if (Number.isInteger(existing) && existing > 0 && existing === active) {
    return { ok: true, action: 'reuse', activeDims: active, existingDims: existing };
  }
  return {
    ok: true,
    action: 'replace',
    activeDims: active,
    existingDims: Number.isInteger(existing) && existing > 0 ? existing : null,
  };
}

export function buildDropPreviousColumnSql() {
  return `ALTER TABLE memories DROP COLUMN IF EXISTS ${PREV_COLUMN}`;
}

export function buildStageColumnEmptyCheckSql() {
  return (
    `SELECT ` +
    `COUNT(*) FILTER (WHERE ${STAGE_COLUMN} IS NOT NULL) AS stage_nonnull, ` +
    `COUNT(*) FILTER (WHERE ${STAGE_GENERATION_COLUMN} IS NOT NULL) AS stage_generation_nonnull, ` +
    `COUNT(*) FILTER (WHERE ${STAGE_CONTENT_HASH_COLUMN} IS NOT NULL) AS stage_hash_nonnull ` +
    `FROM memories`
  );
}

export function buildDropStageColumnSql() {
  // DROP COLUMN removes vector_next only. vector_prev rollback retention is untouched.
  // Stage metadata columns stay (TEXT) and are nulled separately.
  return `ALTER TABLE memories DROP COLUMN IF EXISTS ${STAGE_COLUMN}`;
}

export function buildHnswIndexSql(column, dims, indexName = 'idx_memories_vector_hnsw') {
  const mode = halfvecMode(dims);
  const n = Number(dims);
  if (mode === 'halfvec') {
    return {
      mode,
      sql: `CREATE INDEX IF NOT EXISTS ${indexName} ON memories USING hnsw ((${column}::halfvec(${n})) halfvec_cosine_ops)`,
    };
  }
  return {
    mode,
    sql: `CREATE INDEX IF NOT EXISTS ${indexName} ON memories USING hnsw (${column} vector_cosine_ops)`,
  };
}

// Atomic cutover steps (caller runs inside one transaction with locks held):
// 1) copy active vector → vector_prev (rollback retain)
// 2) promote vector_next → vector only for matching generation+hash
// 3) clear vector_next + stage metadata; drop empty stage column so a later
//    different-dim stage can ADD cleanly (no manual schema cleanup).
// Never nulls active without a replacement when coverage has passed.
/**
 * @param {number} targetDims
 * @param {{ generation?: string }} [opts]
 */
export function buildActivationSql(targetDims, { generation } = {}) {
  const n = Number(targetDims);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`invalid target dims: ${targetDims}`);
  if (generation == null || String(generation).trim() === '') {
    throw new Error('buildActivationSql requires generation');
  }
  // Parameterized match for UPDATE paths; literal form only used inside USING
  // expressions where bind params are unavailable.
  const genLiteral = String(generation).replace(/'/g, "''");
  const matchPredicate = (
    `${STAGE_COLUMN} IS NOT NULL` +
    ` AND ${STAGE_GENERATION_COLUMN} = '${genLiteral}'` +
    ` AND ${STAGE_CONTENT_HASH_COLUMN} IS NOT NULL` +
    ` AND content_hash IS NOT NULL` +
    ` AND ${STAGE_CONTENT_HASH_COLUMN} = content_hash`
  );
  return {
    copyPrev: `UPDATE memories SET ${PREV_COLUMN} = vector`,
    // Dim-change retype: coverage must have blocked active-without-text rows.
    // Matched rows take vector_next; remaining rows are no-text with NULL active.
    retypeActive: (
      `ALTER TABLE memories ALTER COLUMN vector TYPE vector(${n}) USING (` +
      `CASE WHEN ${matchPredicate} THEN ${STAGE_COLUMN} ELSE NULL END` +
      `)`
    ),
    // Same-dim promote (parameterized generation). Params: $1 = generation
    promoteSameDims: (
      `UPDATE memories SET vector = ${STAGE_COLUMN} ` +
      `WHERE ${STAGE_COLUMN} IS NOT NULL` +
      ` AND ${STAGE_GENERATION_COLUMN} = $1` +
      ` AND ${STAGE_CONTENT_HASH_COLUMN} IS NOT NULL` +
      ` AND content_hash IS NOT NULL` +
      ` AND ${STAGE_CONTENT_HASH_COLUMN} = content_hash`
    ),
    // Drop stage contents + identity metadata after promotion.
    nullStage: (
      `UPDATE memories SET ${STAGE_COLUMN} = NULL, ` +
      `${STAGE_GENERATION_COLUMN} = NULL, ` +
      `${STAGE_CONTENT_HASH_COLUMN} = NULL`
    ),
    // After nulling, drop the stage vector column so the next dim migration
    // can ADD vector(N) without manual DROP. vector_prev is retained.
    dropStageColumn: buildDropStageColumnSql(),
    dropActiveIndex: `DROP INDEX IF EXISTS idx_memories_vector_hnsw`,
    dropStageIndex: `DROP INDEX IF EXISTS idx_memories_vector_next_hnsw`,
    matchPredicate,
  };
}

// SQL statements that would null/wipe the active vector column — forbidden in stage path.
const FORBIDDEN_ACTIVE_WIPE = [
  /ALTER\s+TABLE\s+memories\s+ALTER\s+COLUMN\s+vector\s+TYPE[\s\S]*USING\s+NULL/i,
  /UPDATE\s+memories\s+SET\s+vector\s*=\s*NULL/i,
  /UPDATE\s+memories\s+SET\s+vector\s*=\s*\$\d+::vector/i, // direct overwrite of active during stage
];

export function assertNoActiveVectorWipe(sql) {
  const text = String(sql || '');
  for (const re of FORBIDDEN_ACTIVE_WIPE) {
    if (re.test(text)) {
      return {
        ok: false,
        error: `refusing SQL that nulls or overwrites active vector during migration: ${text.slice(0, 120)}`,
      };
    }
  }
  // Stage updates must target vector_next only.
  if (/UPDATE\s+memories\s+SET\s+vector\s*=/i.test(text) && !/vector_next|vector_prev/i.test(text)) {
    return {
      ok: false,
      error: 'stage path must not UPDATE memories.vector directly',
    };
  }
  return { ok: true };
}

export function buildStageIndexSql(dims) {
  return buildHnswIndexSql(STAGE_COLUMN, dims, 'idx_memories_vector_next_hnsw');
}

export function buildActiveIndexSql(dims) {
  return buildHnswIndexSql('vector', dims, 'idx_memories_vector_hnsw');
}

/**
 * @param {{ mode?: string, apply?: boolean, provenance?: object|null, existingDims?: number|null,
 *   targetDims?: number|null, selected?: number, embeddable?: number, staged?: number,
 *   failed?: number, skipped?: number, coverage?: { ok?: boolean }|null,
 *   indexMode?: string|null, error?: string|null }} [opts]
 */
export function migrationSummary({
  mode,
  apply,
  provenance,
  existingDims = null,
  targetDims,
  selected = 0,
  embeddable = 0,
  staged = 0,
  failed = 0,
  skipped = 0,
  coverage = null,
  indexMode = null,
  error = null,
} = {}) {
  return {
    ok: !error && failed === 0 && (coverage ? coverage.ok !== false : true),
    mode,
    apply: Boolean(apply),
    provenance: provenance || null,
    existing_dims: existingDims,
    target_dims: targetDims,
    index_mode: indexMode || halfvecMode(targetDims),
    counts: {
      selected,
      embeddable,
      staged,
      failed,
      skipped_no_text: skipped,
    },
    coverage,
    error,
  };
}
