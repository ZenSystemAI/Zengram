#!/usr/bin/env node
/**
 * Retrieval Eval Harness (SPIKE) — Zengram / The Shared Brain
 *
 * Seeds a known corpus via POST /export/import, runs labeled queries against
 * GET /memory/search, and reports recall@k / MRR@k. This is an OPT-IN
 * integration tool, NOT a unit test: it needs a live API + Postgres + an
 * embedding provider to execute. It is never part of `npm test`.
 *
 * Usage:
 *   export BRAIN_API_URL=http://localhost:8084   # default if unset
 *   export BRAIN_API_KEY=...                       # required
 *   node scripts/eval/run-eval.js [path/to/fixture.json]
 *
 * Fixture shape: { memories: [...import-shaped...], queries: [{ q, expected_ids, k? }] }
 * See docs/eval-harness.md for the full design and open questions.
 *
 * Dependency-free: uses global fetch (Node 18+). ESM module.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Config (env, mirrors api/src/index.js:26 and scripts/status-staleness.js) ---
const BRAIN_API_URL = (process.env.BRAIN_API_URL || 'http://localhost:8084').replace(/\/+$/, '');
const BRAIN_API_KEY = process.env.BRAIN_API_KEY;

// Default k values reported side by side. A query may override via its own `k`.
const DEFAULT_KS = [5, 10];

if (!BRAIN_API_KEY) {
  console.error('[eval] FATAL: BRAIN_API_KEY is required. Export it (same key the API was started with).');
  process.exit(1);
}

// --- HTTP helper: authenticated request with friendly connection-failure guidance ---
async function brainRequest(reqPath, options = {}) {
  const url = `${BRAIN_API_URL}${reqPath}`;
  let res;
  try {
    res = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': BRAIN_API_KEY,
        ...(options.headers || {}),
      },
    });
  } catch (err) {
    // Connection refused / DNS / network: don't dump a stack trace.
    console.error(`[eval] Could not reach the API at ${url}`);
    console.error(`[eval]   ${err.code || err.name || 'NetworkError'}: ${err.message}`);
    console.error('[eval]   Is the API running? Check BRAIN_API_URL and that the stack is up.');
    process.exit(2);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`API ${reqPath} -> ${res.status} ${res.statusText} ${body}`.trim());
  }
  return res.json();
}

// --- Load + validate the fixture ---
async function loadFixture(fixturePath) {
  let raw;
  try {
    raw = await readFile(fixturePath, 'utf8');
  } catch (err) {
    console.error(`[eval] Could not read fixture at ${fixturePath}: ${err.message}`);
    process.exit(1);
  }

  let fixture;
  try {
    fixture = JSON.parse(raw);
  } catch (err) {
    console.error(`[eval] Fixture is not valid JSON (${fixturePath}): ${err.message}`);
    process.exit(1);
  }

  if (!Array.isArray(fixture.memories) || !Array.isArray(fixture.queries)) {
    console.error('[eval] Fixture must have "memories" and "queries" arrays.');
    process.exit(1);
  }
  return fixture;
}

// --- Seed the corpus. POST /export/import accepts { data: [...] } and preserves
//     a caller-supplied `id` (api/src/routes/export.js:168). Caps at 500/request,
//     so chunk for larger corpora. ---
async function seed(memories) {
  console.log(`Seeding ${memories.length} memories via POST /export/import ...`);
  const CHUNK = 500;
  let imported = 0, skipped = 0, errors = 0;

  for (let i = 0; i < memories.length; i += CHUNK) {
    const batch = memories.slice(i, i + CHUNK);
    const result = await brainRequest('/export/import', {
      method: 'POST',
      body: JSON.stringify({ data: batch }),
    });
    imported += result.imported || 0;
    skipped += result.skipped || 0;
    errors += result.errors || 0;
  }

  console.log(`  imported=${imported} skipped=${skipped} errors=${errors}`);
  if (skipped > 0) {
    console.log('  note: skipped rows already exist (content_hash dedup). Seed an empty store for clean numbers.');
  }
  return { imported, skipped, errors };
}

// --- Run one query: GET /memory/search?...&format=index, return ids in rank order ---
async function searchIds(q, k) {
  const params = new URLSearchParams({ q, limit: String(k), format: 'index' });
  const result = await brainRequest(`/memory/search?${params.toString()}`, { method: 'GET' });
  // Every search format includes `id`; index format is the cheapest.
  return (result.results || []).map(r => r.id);
}

// --- Metrics ---
// recall@k (hit form): 1 if any expected id is in the top-k, else 0.
function recallAtK(rankedIds, expectedIds, k) {
  const topK = rankedIds.slice(0, k);
  const expected = new Set(expectedIds);
  return topK.some(id => expected.has(id)) ? 1 : 0;
}

// reciprocal rank: 1 / (1-based rank of the first expected id within top-k), else 0.
function reciprocalRankAtK(rankedIds, expectedIds, k) {
  const topK = rankedIds.slice(0, k);
  const expected = new Set(expectedIds);
  for (let i = 0; i < topK.length; i++) {
    if (expected.has(topK[i])) return 1 / (i + 1);
  }
  return 0;
}

// --- Pretty-print helpers ---
function pad(str, width) {
  str = String(str);
  return str.length >= width ? str.slice(0, width) : str + ' '.repeat(width - str.length);
}

function fmt(n) {
  return n.toFixed(3);
}

async function main() {
  const fixtureArg = process.argv[2];
  const fixturePath = fixtureArg
    ? path.resolve(process.cwd(), fixtureArg)
    : path.join(__dirname, 'fixtures', 'smoke.json');

  const fixture = await loadFixture(fixturePath);
  console.log(`Fixture: ${fixturePath}`);
  console.log(`API:     ${BRAIN_API_URL}\n`);

  await seed(fixture.memories);
  console.log('');

  // Header
  const QW = 50; // query column width
  const header = pad('query', QW) +
    DEFAULT_KS.map(k => `recall@${k}`.padStart(10) + `  rr@${k}`.padStart(8)).join('  ');
  console.log(header);
  console.log('-'.repeat(header.length));

  // Accumulators per default-k
  const totals = Object.fromEntries(DEFAULT_KS.map(k => [k, { recall: 0, rr: 0 }]));
  const n = fixture.queries.length;

  for (const query of fixture.queries) {
    const q = query.q;
    const expected = query.expected_ids || [];
    // Fetch enough results to cover the largest k we report (and any per-query override).
    const maxK = Math.max(...DEFAULT_KS, query.k || 0);
    const rankedIds = await searchIds(q, maxK);

    let row = pad(q, QW);
    for (const k of DEFAULT_KS) {
      const r = recallAtK(rankedIds, expected, k);
      const rr = reciprocalRankAtK(rankedIds, expected, k);
      totals[k].recall += r;
      totals[k].rr += rr;
      row += String(r).padStart(10) + '  ' + fmt(rr).padStart(8) + '  ';
    }
    console.log(row.trimEnd());
  }

  // Aggregate
  console.log('-'.repeat(header.length));
  const aggParts = DEFAULT_KS.map(k => {
    const recall = n ? totals[k].recall / n : 0;
    const mrr = n ? totals[k].rr / n : 0;
    return `R@${k}=${fmt(recall)} MRR@${k}=${fmt(mrr)}`;
  });
  console.log(`AGGREGATE (n=${n})  ` + aggParts.join('   '));
}

main().catch(err => {
  console.error('[eval] Fatal:', err.message);
  process.exit(1);
});
