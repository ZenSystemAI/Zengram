#!/usr/bin/env node
/**
 * Tier-2 Memory Compression for Shared Brain
 *
 * Purpose: Weekly compression of old event memories (7-30 days old).
 * Triggers consolidation to group related events and produce compressed summaries.
 *
 * Usage:
 *   node tier2-compression.js [--dry-run]
 *
 * Cron setup:
 *   0 1 * * 0 cd /home/steven/shared-brain/api && node scripts/tier2-compression.js >> logs/tier2-compression.log 2>&1
 */

const DRY_RUN = process.argv.includes('--dry-run');

// Brain API config
const BRAIN_API_URL = process.env.BRAIN_API_URL || 'http://localhost:8084';
const BRAIN_API_KEY = process.env.BRAIN_API_KEY;

if (!BRAIN_API_KEY) {
  console.error('ERROR: BRAIN_API_KEY environment variable not set');
  process.exit(1);
}

// Time window for compression (in days)
const MIN_AGE_DAYS = 7; // Don't compress events less than 7 days old
const MAX_AGE_DAYS = 30; // Don't compress events older than 30 days

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
 * Fetch events within the compression window (7-30 days old)
 */
async function getOldEvents() {
  try {
    // Query events using the structured query endpoint
    // Since is a timestamp for events older than X time
    const now = new Date();
    const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();

    const result = await brainRequest(`/memory/query?type=events&since=${encodeURIComponent(sevenDaysAgo)}&limit=500`, {
      method: 'GET',
    });

    const events = (result.results || []).filter(mem => {
      const createdAt = new Date(mem.created_at);
      if (!createdAt || isNaN(createdAt)) return false;

      const ageMs = now - createdAt;
      const ageDays = ageMs / (1000 * 60 * 60 * 24);

      // Keep only events in the 7-30 day window
      return ageDays >= MIN_AGE_DAYS && ageDays <= MAX_AGE_DAYS;
    });

    return events;
  } catch (err) {
    console.error('Failed to fetch old events:', err.message);
    return [];
  }
}

/**
 * Check consolidation status
 */
async function getConsolidationStatus() {
  try {
    const status = await brainRequest('/consolidate/status', {
      method: 'GET',
    });
    return status;
  } catch (err) {
    console.error('Failed to get consolidation status:', err.message);
    return null;
  }
}

/**
 * Trigger consolidation (async)
 */
async function triggerConsolidation() {
  try {
    const result = await brainRequest('/consolidate', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    return result;
  } catch (err) {
    console.error('Failed to trigger consolidation:', err.message);
    return null;
  }
}

/**
 * Poll a consolidation job until complete or timeout
 */
async function pollJobStatus(jobId, maxAttempts = 30, intervalMs = 2000) {
  let attempt = 0;
  while (attempt < maxAttempts) {
    try {
      const job = await brainRequest(`/consolidate/job/${jobId}`, {
        method: 'GET',
      });

      const status = job.status || job.job?.status;
      console.log(`  [Poll ${attempt + 1}/${maxAttempts}] Job status: ${status}`);

      if (status === 'completed') {
        return job;
      }
      if (status === 'failed') {
        throw new Error(`Consolidation job failed: ${job.error}`);
      }

      await new Promise(resolve => setTimeout(resolve, intervalMs));
      attempt++;
    } catch (err) {
      console.error(`  [Poll ${attempt + 1}] Error:`, err.message);
      throw err;
    }
  }

  throw new Error(`Consolidation job ${jobId} did not complete within timeout`);
}

/**
 * Format a date for logging
 */
function formatDate(isoDate) {
  return new Date(isoDate).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Main function
 */
async function main() {
  const startTime = new Date();
  console.log(`[${startTime.toISOString()}] Tier-2 Compression starting (DRY_RUN=${DRY_RUN})`);

  try {
    // Step 1: Check if consolidation is already running
    console.log('\n[1] Checking consolidation status...');
    const currentStatus = await getConsolidationStatus();
    if (currentStatus && currentStatus.is_running) {
      console.log('  Consolidation already running, skipping to avoid queue backlog');
      process.exit(0);
    }

    // Step 2: Fetch old events
    console.log(`\n[2] Fetching events aged 7-30 days...`);
    const oldEvents = await getOldEvents();
    console.log(`  Found ${oldEvents.length} events in compression window`);

    if (oldEvents.length === 0) {
      console.log('  No events to compress, exiting');
      process.exit(0);
    }

    // Group by client_id for context
    const byClient = {};
    for (const evt of oldEvents) {
      const clientId = evt.client_id || 'global';
      if (!byClient[clientId]) byClient[clientId] = [];
      byClient[clientId].push(evt);
    }

    console.log('\n  Breakdown by client:');
    for (const [clientId, events] of Object.entries(byClient)) {
      console.log(`    ${clientId}: ${events.length} events`);
    }

    // Step 3: Trigger consolidation
    console.log('\n[3] Triggering consolidation job...');
    if (DRY_RUN) {
      console.log('  [DRY_RUN] Would trigger consolidation (skipped)');
    } else {
      const job = await triggerConsolidation();
      if (!job) {
        throw new Error('Failed to start consolidation job');
      }

      const jobId = job.job_id;
      console.log(`  Job ID: ${jobId}`);
      console.log(`  Status: ${job.status}`);

      // Step 4: Poll job completion
      console.log('\n[4] Waiting for consolidation to complete...');
      try {
        const result = await pollJobStatus(jobId, 60, 3000); // 60 attempts × 3s = 3 min timeout
        console.log(`  ✓ Consolidation completed`);
        console.log(`    Memories processed: ${result.job?.memories_processed || 'unknown'}`);
        console.log(`    Summaries generated: ${result.job?.summaries_generated || 'unknown'}`);
      } catch (err) {
        console.error(`  ✗ Consolidation polling failed: ${err.message}`);
        // Don't exit(1) — consolidation may still run in background
      }
    }

    // Step 5: Summary
    const endTime = new Date();
    const duration = (endTime - startTime) / 1000;

    console.log(`
[5] Summary:
  Events evaluated: ${oldEvents.length}
  Duration: ${duration.toFixed(2)}s
  Mode: ${DRY_RUN ? 'DRY RUN (no consolidation)' : 'LIVE (consolidation triggered)'}
  Next consolidation time window: ${MIN_AGE_DAYS}-${MAX_AGE_DAYS} days old
`);

    process.exit(0);
  } catch (err) {
    console.error('\nFatal error:', err);
    process.exit(1);
  }
}

main();
