#!/usr/bin/env node
/**
 * Status Staleness Monitor for Shared Brain
 *
 * Purpose: Daily check for stale statuses. Marks statuses not updated in 14+ days
 * with a warning, auto-archives statuses not updated in 30+ days.
 *
 * Usage:
 *   node status-staleness.js [--dry-run]
 *
 * Cron setup:
 *   0 2 * * * cd /home/steven/shared-brain/api && node scripts/status-staleness.js >> logs/status-staleness.log 2>&1
 */

const DRY_RUN = process.argv.includes('--dry-run');

// Brain API config
const BRAIN_API_URL = process.env.BRAIN_API_URL || 'http://localhost:8084';
const BRAIN_API_KEY = process.env.BRAIN_API_KEY;

if (!BRAIN_API_KEY) {
  console.error('ERROR: BRAIN_API_KEY environment variable not set');
  process.exit(1);
}

// Threshold constants (in days)
const WARN_DAYS = 14;
const ARCHIVE_DAYS = 30;

/**
 * Make authenticated request to Brain API
 */
async function brainRequest(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': BRAIN_API_KEY,
    ...options.headers,
  };

  const url = `${BRAIN_API_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${path}: ${res.status} ${text}`);
  }

  return res.json();
}

/**
 * Fetch all active statuses from the Brain API
 */
async function getAllStatuses() {
  try {
    // Query all active statuses using the structured query endpoint
    const result = await brainRequest('/memory/query?type=statuses&limit=1000', {
      method: 'GET',
    });

    return result.results || [];
  } catch (err) {
    console.error('Failed to fetch statuses:', err.message);
    return [];
  }
}

/**
 * Check if a date is older than N days
 */
function isOlderThan(isoDate, days) {
  const date = new Date(isoDate);
  const now = new Date();
  const age = (now - date) / (1000 * 60 * 60 * 24); // Convert to days
  return age > days;
}

/**
 * Format a date for logging
 */
function formatDate(isoDate) {
  return new Date(isoDate).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Archive a status by setting its valid_to field
 */
async function archiveStatus(statusId, subject) {
  try {
    const now = new Date().toISOString();
    await brainRequest(`/memory/${statusId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        // The API allows updating metadata to mark as archived
        metadata: {
          archived_at: now,
          archive_reason: 'auto_archived_by_staleness_monitor',
        },
      }),
    });
    return true;
  } catch (err) {
    console.error(`Failed to archive status ${statusId} (${subject}):`, err.message);
    return false;
  }
}

/**
 * Main function
 */
async function main() {
  const startTime = new Date();
  console.log(`[${startTime.toISOString()}] Status Staleness Monitor starting (DRY_RUN=${DRY_RUN})`);

  try {
    const statuses = await getAllStatuses();
    console.log(`Found ${statuses.length} active statuses to evaluate`);

    let warnCount = 0;
    let archiveCount = 0;

    for (const status of statuses) {
      const id = status.id;
      const subject = status.subject || 'unknown';
      const statusValue = status.status || 'unknown';
      const updatedAt = status.updated_at || status.created_at;

      if (!updatedAt) {
        console.log(`  [SKIP] ${subject}: no updated_at or created_at timestamp`);
        continue;
      }

      const isOld14 = isOlderThan(updatedAt, WARN_DAYS);
      const isOld30 = isOlderThan(updatedAt, ARCHIVE_DAYS);

      if (isOld30) {
        console.log(
          `  [ARCHIVE] ${subject}: last updated ${formatDate(updatedAt)} (${Math.floor(
            (new Date() - new Date(updatedAt)) / (1000 * 60 * 60 * 24),
          )} days ago) → value: "${statusValue}"`
        );

        if (!DRY_RUN) {
          const success = await archiveStatus(id, subject);
          if (success) archiveCount++;
        } else {
          archiveCount++;
        }
      } else if (isOld14) {
        console.log(
          `  [WARN] ${subject}: last updated ${formatDate(updatedAt)} (${Math.floor(
            (new Date() - new Date(updatedAt)) / (1000 * 60 * 60 * 24),
          )} days ago) → value: "${statusValue}"`
        );
        warnCount++;
      }
    }

    const endTime = new Date();
    const duration = (endTime - startTime) / 1000;

    console.log(`
Summary:
  Warnings (14+ days): ${warnCount}
  Archived (30+ days): ${archiveCount}
  Duration: ${duration.toFixed(2)}s
  Mode: ${DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE'}
`);

    process.exit(0);
  } catch (err) {
    console.error('Fatal error:', err);
    process.exit(1);
  }
}

main();
