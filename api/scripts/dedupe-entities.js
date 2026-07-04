#!/usr/bin/env node
/**
 * dedupe-entities.js — Merge duplicate entities in the entities table.
 *
 * Finds rows with the same (canonical_name, entity_type), picks the row with
 * the highest mention_count as the winner, redirects entity_memory_links,
 * entity_relationships, and entity_aliases to the winner, recomputes the
 * winner's mention_count/first_seen/last_seen, then deletes the losers.
 *
 * Usage:
 *   node api/scripts/dedupe-entities.js            # dry-run (default)
 *   node api/scripts/dedupe-entities.js --apply    # actually run the merges
 *
 * Reads POSTGRES_URL from env. Wraps everything in a single transaction so
 * partial failures roll back cleanly.
 */

import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const POSTGRES_URL = process.env.POSTGRES_URL;

if (!POSTGRES_URL) {
  console.error('[dedupe] POSTGRES_URL is required. Set it in .env or environment.');
  process.exit(1);
}

function note(...args) {
  console.log('[dedupe]', ...args);
}

async function main() {
  const client = new pg.Client({ connectionString: POSTGRES_URL });
  await client.connect();
  note(`mode: ${APPLY ? 'APPLY (will commit)' : 'DRY-RUN (no writes)'}`);

  try {
    await client.query('BEGIN');

    const beforeCounts = await counts(client);
    note('before:', beforeCounts);

    const dupes = await client.query(`
      SELECT canonical_name, entity_type, array_agg(id ORDER BY mention_count DESC NULLS LAST, first_seen ASC) AS ids
      FROM entities
      GROUP BY canonical_name, entity_type
      HAVING COUNT(*) > 1
      ORDER BY canonical_name
    `);

    if (dupes.rows.length === 0) {
      note('no duplicates found — nothing to do');
      await client.query('ROLLBACK');
      return;
    }

    note(`found ${dupes.rows.length} duplicate groups`);

    let totalMerged = 0;
    let totalLinksRetargeted = 0;
    let totalLinksDeduped = 0;
    let totalRelsRetargeted = 0;
    let totalAliasesMoved = 0;

    for (const { canonical_name, entity_type, ids } of dupes.rows) {
      const winnerId = ids[0];
      const loserIds = ids.slice(1);
      note(
        `  ${entity_type}/${canonical_name}: winner=${winnerId}, losers=[${loserIds.join(',')}]`
      );

      // Migrate memory links — copy losers' links to winner where not already present,
      // then delete losers' links.
      const memMigrate = await client.query(
        `
        WITH inserted AS (
          INSERT INTO entity_memory_links (entity_id, memory_id, role, created_at)
          SELECT $1::int, l.memory_id, l.role, MIN(l.created_at)
          FROM entity_memory_links l
          WHERE l.entity_id = ANY($2::int[])
            AND NOT EXISTS (
              SELECT 1 FROM entity_memory_links e
              WHERE e.entity_id = $1::int
                AND e.memory_id = l.memory_id
                AND COALESCE(e.role, '') = COALESCE(l.role, '')
            )
          GROUP BY l.memory_id, l.role
          RETURNING 1
        ),
        deleted AS (
          DELETE FROM entity_memory_links
          WHERE entity_id = ANY($2::int[])
          RETURNING 1
        )
        SELECT
          (SELECT COUNT(*) FROM inserted) AS retargeted,
          (SELECT COUNT(*) FROM deleted) AS removed
        `,
        [winnerId, loserIds]
      );
      const linksRetargeted = parseInt(memMigrate.rows[0].retargeted, 10);
      const linksRemoved = parseInt(memMigrate.rows[0].removed, 10);
      totalLinksRetargeted += linksRetargeted;
      totalLinksDeduped += linksRemoved - linksRetargeted;

      // Migrate entity_relationships (source or target).
      const relMigrate = await client.query(
        `
        WITH src AS (
          UPDATE entity_relationships
          SET source_entity_id = $1::int
          WHERE source_entity_id = ANY($2::int[])
            AND target_entity_id != $1::int
            AND NOT EXISTS (
              SELECT 1 FROM entity_relationships e2
              WHERE e2.source_entity_id = $1::int
                AND e2.target_entity_id = entity_relationships.target_entity_id
                AND e2.relationship_type = entity_relationships.relationship_type
            )
          RETURNING 1
        ),
        tgt AS (
          UPDATE entity_relationships
          SET target_entity_id = $1::int
          WHERE target_entity_id = ANY($2::int[])
            AND source_entity_id != $1::int
            AND NOT EXISTS (
              SELECT 1 FROM entity_relationships e2
              WHERE e2.target_entity_id = $1::int
                AND e2.source_entity_id = entity_relationships.source_entity_id
                AND e2.relationship_type = entity_relationships.relationship_type
            )
          RETURNING 1
        ),
        purged AS (
          DELETE FROM entity_relationships
          WHERE source_entity_id = ANY($2::int[])
             OR target_entity_id = ANY($2::int[])
          RETURNING 1
        )
        SELECT
          (SELECT COUNT(*) FROM src) + (SELECT COUNT(*) FROM tgt) AS retargeted,
          (SELECT COUNT(*) FROM purged) AS removed
        `,
        [winnerId, loserIds]
      );
      totalRelsRetargeted += parseInt(relMigrate.rows[0].retargeted, 10);

      // Migrate aliases — move losers' aliases to winner unless an alias with
      // that text already exists (UNIQUE constraint on alias).
      const aliasMigrate = await client.query(
        `
        WITH moved AS (
          UPDATE entity_aliases
          SET entity_id = $1::int
          WHERE entity_id = ANY($2::int[])
            AND NOT EXISTS (
              SELECT 1 FROM entity_aliases e2
              WHERE e2.alias = entity_aliases.alias
                AND e2.entity_id = $1::int
            )
          RETURNING 1
        ),
        purged AS (
          DELETE FROM entity_aliases
          WHERE entity_id = ANY($2::int[])
          RETURNING 1
        )
        SELECT
          (SELECT COUNT(*) FROM moved) AS moved,
          (SELECT COUNT(*) FROM purged) AS removed
        `,
        [winnerId, loserIds]
      );
      totalAliasesMoved += parseInt(aliasMigrate.rows[0].moved, 10);

      // Recompute winner's mention_count, first_seen, last_seen using the
      // pre-merge values across all rows in the group.
      await client.query(
        `
        WITH grp AS (
          SELECT SUM(mention_count) AS sum_mc, MIN(first_seen) AS min_fs, MAX(last_seen) AS max_ls
          FROM entities
          WHERE id = ANY($1::int[])
        )
        UPDATE entities
        SET mention_count = grp.sum_mc,
            first_seen   = grp.min_fs,
            last_seen    = grp.max_ls
        FROM grp
        WHERE entities.id = $2::int
        `,
        [ids, winnerId]
      );

      // Delete the losers.
      await client.query(
        `DELETE FROM entities WHERE id = ANY($1::int[])`,
        [loserIds]
      );

      totalMerged += loserIds.length;
    }

    const afterCounts = await counts(client);
    note('after :', afterCounts);
    note(
      `summary: merged ${totalMerged} loser rows across ${dupes.rows.length} groups`
    );
    note(
      `  links: ${totalLinksRetargeted} retargeted, ${totalLinksDeduped} dropped as duplicates`
    );
    note(`  relationships: ${totalRelsRetargeted} retargeted`);
    note(`  aliases: ${totalAliasesMoved} moved`);

    if (APPLY) {
      await client.query('COMMIT');
      note('committed.');
    } else {
      await client.query('ROLLBACK');
      note('rolled back (dry-run). Rerun with --apply to commit.');
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    note('ERROR — rolled back:', err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

async function counts(client) {
  const e = await client.query(`SELECT COUNT(*)::int AS n FROM entities`);
  const ml = await client.query(`SELECT COUNT(*)::int AS n FROM entity_memory_links`);
  const r = await client.query(`SELECT COUNT(*)::int AS n FROM entity_relationships`);
  const a = await client.query(`SELECT COUNT(*)::int AS n FROM entity_aliases`);
  return {
    entities: e.rows[0].n,
    memory_links: ml.rows[0].n,
    relationships: r.rows[0].n,
    aliases: a.rows[0].n,
  };
}

main().catch((err) => {
  console.error('[dedupe] fatal:', err);
  process.exit(1);
});
