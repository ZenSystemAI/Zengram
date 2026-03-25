#!/usr/bin/env node
/**
 * cleanup-garbage-entities.js
 *
 * Removes garbage entities created by the overly-aggressive v2.0/v2.1 entity extractor.
 * Applies the same filters as entities.js v2.2 retroactively.
 *
 * Safe: uses CASCADE deletes (entity_aliases, entity_memory_links, entity_relationships
 * are all cleaned automatically when an entity is deleted).
 *
 * Usage: POSTGRES_URL=... node scripts/cleanup-garbage-entities.js [--dry-run]
 */

import pg from 'pg';

const POSTGRES_URL = process.env.POSTGRES_URL || 'postgresql://localhost:5432/shared_brain';
const DRY_RUN = process.argv.includes('--dry-run');

// --- Same filters as entities.js v2.2 ---

function isGarbageEntity(name, type) {
  // Keep known tech, agents, clients, domains — only audit system/workflow types
  if (!['system', 'workflow'].includes(type)) return false;

  // Hyphenated lowercase — CSS properties, HTML data attrs
  if (/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(name)) return true;

  // camelCase or snake_case
  if (/^[a-z][a-zA-Z0-9]*[A-Z]/.test(name)) return true;
  if (/^[a-z_]+_[a-z_]+$/.test(name)) return true;

  // Shell commands
  if (/^(docker|git|npm|ssh|curl|cd|ls|rm|cp|mv|mkdir|chmod|sudo|pip|node|bun|systemctl|openclaw|ollama|head|bash)\s/i.test(name)) return true;

  // Error codes, log messages
  if (/^(ERROR|WARN|INFO|DEBUG|FAIL|OK|TRUE|FALSE)/.test(name)) return true;
  if (/^(Prompt|Failed|Ignored|Should)\s/i.test(name)) return true;

  // File paths, env vars, code fragments
  if (/[/\\%~{}();=\[\]|&$@]/.test(name)) return true;

  // Starts with action verb (past tense) — "Added X", "Fixed X", "Created X", etc.
  const ACTION_VERBS = /^(Added|Fixed|Updated|Removed|Switched|Converted|Pulled|Pushed|Created|Deleted|Merged|Deployed|Enhanced|Resolved|Approved|Redesigned|Renamed|Installed|Configured|Migrated|Implemented|Refactored|Gathered|Replaced|Built|Moved|Changed|Cleaned|Tested|Verified|Confirmed|Completed|Started|Finished|Enabled|Disabled|Stripped|Polished|Staged|Fetched|Populated|Drafted|Rebuilt|Removed|Restored|Reviewed|Wired|Rewrote|Diagnosed|Generated|Attempted|Cached|Centralized|Converted|Parses|Runs|Targets|Calls)\s/;
  if (ACTION_VERBS.test(name)) return true;

  // Starts with preposition/article/pronoun — "Both X", "For X", "The X", "Has X", "With X"
  const PREP_STARTS = /^(Both|For|The|Has|With|All|When|Saw|Keep|Check|Needs|Uses|Set|Remember)\s/;
  if (PREP_STARTS.test(name)) return true;

  // Starts with "No " or "Not " — negations
  if (/^(No|Not)\s/.test(name)) return true;

  // Quotes around the name or starts with special chars
  if (/^['"\-*#>]/.test(name)) return true;

  // Contains newlines
  if (/\n/.test(name)) return true;

  // French phrases (common French words at any position)
  const FRENCH_MARKERS = /\b(les|des|une|dans|sans|avec|pour|sur|cette|sont|fait|chez|nous|votre|notre|très|aussi|tout|tous|bien|être|avoir|plus|qui|que|pas|gratuit|gratuite|évaluation|évaluez|soumett|dépôt|prêt|pret|salutations|distinguees|stratégie|strategie|proposition|diagnostique|diagnostic)\b/i;
  if (FRENCH_MARKERS.test(name)) return true;

  // Hex colors
  if (/^#[0-9a-fA-F]+$/.test(name)) return true;

  // Single word that's all lowercase
  if (!/\s/.test(name) && /^[a-z]/.test(name)) return true;

  // Single short word (< 5 chars, no spaces)
  if (!/\s/.test(name) && name.length < 5) return true;

  // Very long phrases (5+ words) — always prose
  const words = name.split(/\s+/);
  if (words.length >= 5) return true;

  // Sentence fragments — >40% prose words
  const PROSE_WORDS = new Set([
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'must', 'shall', 'can', 'need',
    'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as',
    'into', 'through', 'during', 'before', 'after', 'above', 'below',
    'between', 'under', 'not', 'no', 'nor', 'but', 'or', 'and', 'if',
    'then', 'than', 'so', 'that', 'this', 'these', 'those', 'it', 'its',
    'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'au', 'aux',
    'et', 'ou', 'en', 'est', 'sont', 'par', 'pour', 'sur', 'avec',
    'dans', 'sans', 'pas', 'plus',
  ]);
  const proseCount = words.filter(w => PROSE_WORDS.has(w.toLowerCase())).length;
  if (words.length >= 3 && proseCount / words.length > 0.4) return true;

  // Generic adjective + noun (2-word)
  const GENERIC_HEAD = new Set([
    'New', 'Old', 'Big', 'Raw', 'Hot', 'Top', 'Low', 'Bad', 'Red',
    'Full', 'Next', 'Last', 'Main', 'Real', 'Live', 'Dead', 'Deep',
    'High', 'Long', 'Dark', 'Fast', 'Slow', 'Hard', 'Soft', 'Good',
    'True', 'Auto', 'Open', 'Free', 'Pure', 'Safe', 'Dual', 'Half',
    'Audited', 'Exposed', 'Persistent', 'Electric', 'Curated',
    'Major', 'Minor', 'Direct', 'Native', 'Known', 'Two', 'Three',
    'Complete', 'Unified', 'Mandatory', 'Classic', 'Bold', 'Social',
    'Total', 'Existing', 'Shared',
  ]);
  if (words.length === 2 && GENERIC_HEAD.has(words[0])) return true;

  // Generic noun tail (2-word)
  const GENERIC_TAIL = new Set([
    'Node', 'Fix', 'Issue', 'Error', 'Check', 'Test', 'Pass', 'Fail',
    'Mode', 'Type', 'Data', 'Item', 'List', 'View', 'Page', 'File',
    'Phase', 'Step', 'Task', 'Flow', 'Loop', 'Gate', 'Rule', 'Note',
    'Model', 'Level', 'Class', 'Style', 'State', 'Value', 'Field',
    'Port', 'Path', 'Host', 'Name', 'Code', 'Part', 'Line', 'Text',
    'Info', 'Link', 'Flag', 'Sign', 'Icon', 'Form', 'Case', 'Tier',
    'Plan', 'Rate', 'Tool', 'Work', 'Time', 'Size', 'Side', 'Body',
    'Base', 'Card', 'Grid', 'Slot', 'Band', 'Ring', 'Call', 'Send',
    'Load', 'Save', 'Menu', 'Hash', 'Sort', 'Swap', 'Pull', 'Push',
  ]);
  if (words.length === 2 && GENERIC_TAIL.has(words[1])) return true;

  // Numbers-only or punctuation-only
  if (/^[\d\s.,!?-]+$/.test(name)) return true;

  // Contains commas (truncated list fragments)
  if (name.includes(',')) return true;

  return false;
}

// --- Allowlist: known-good entities that might match garbage patterns ---
const ALLOWLIST = new Set([
  // Core systems
  'agency system', 'shared brain', 'mission center', 'knowledge base',
  'prospect pipeline', 'prospect demos', 'neo studio', 'brand voice',
  'design system', 'dispatch protocol', 'neo reports', 'tandem hub',
  'tandem agent hub', 'antigravity studio', 'antigravity', 'prism hub',
  'done gate', 'quick wins', 'citation audit', 'claude code',
  'site settings', 'agent memory', 'demo scorer', 'hub gateway',
  'persistent claude code', 'mcp hub',
  // Products/features
  'points tracker', 'scoring engine', 'setup wizard', 'task manager',
  'domain overview', 'component library optimization', 'demo gallery',
  'pro preview', 'visibility score', 'audit engine', 'indexing manager',
  // Models (keep as system entities)
  'claude sonnet', 'claude opus', 'claude haiku', 'gemini flash',
  'mistral large', 'claude desktop',
  // People
  'vitaly gariev',
  // Real businesses/names
  'boost credit newsletter', 'organic growth engine',
  'prism website formula', 'night shift protocol',
  'shared brain logger', 'fireflies daily processor',
  'seo monthly snapshot', 'client onboarding',
  'react native', 'mini-claude',
]);

async function main() {
  const pool = new pg.Pool({ connectionString: POSTGRES_URL });

  try {
    // Get all system and workflow entities
    const { rows } = await pool.query(
      `SELECT id, canonical_name, entity_type, mention_count
       FROM entities
       WHERE entity_type IN ('system', 'workflow')
       ORDER BY entity_type, canonical_name`
    );

    console.log(`Found ${rows.length} system/workflow entities to evaluate`);

    const toDelete = [];
    const toKeep = [];

    for (const row of rows) {
      if (ALLOWLIST.has(row.canonical_name.toLowerCase())) {
        toKeep.push(row);
        continue;
      }
      if (isGarbageEntity(row.canonical_name, row.entity_type)) {
        toDelete.push(row);
      } else {
        toKeep.push(row);
      }
    }

    console.log(`\nResults:`);
    console.log(`  Garbage: ${toDelete.length}`);
    console.log(`  Keeping: ${toKeep.length}`);

    if (toDelete.length > 0) {
      console.log(`\nGarbage entities (${DRY_RUN ? 'DRY RUN — not deleting' : 'DELETING'}):`);
      for (const row of toDelete.slice(0, 30)) {
        console.log(`  [${row.entity_type}] "${row.canonical_name}" (mentions: ${row.mention_count})`);
      }
      if (toDelete.length > 30) {
        console.log(`  ... and ${toDelete.length - 30} more`);
      }
    }

    if (!DRY_RUN && toDelete.length > 0) {
      const ids = toDelete.map(r => r.id);
      // Clean up relationships first (no CASCADE on this table)
      await pool.query(`DELETE FROM entity_relationships WHERE source_entity_id = ANY($1) OR target_entity_id = ANY($1)`, [ids]);
      // Then delete entities (CASCADE handles aliases and memory_links)
      await pool.query(`DELETE FROM entities WHERE id = ANY($1)`, [ids]);
      console.log(`\nDeleted ${ids.length} garbage entities (with cleanup of aliases, links, relationships)`);
    }

    console.log(`\nKept entities (${toKeep.length}):`);
    for (const row of toKeep) {
      console.log(`  [${row.entity_type}] "${row.canonical_name}" (mentions: ${row.mention_count})`);
    }
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
