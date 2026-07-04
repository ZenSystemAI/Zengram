import express from 'express';
import crypto from 'crypto';
import pg from 'pg';
import { authMiddleware } from './middleware/auth.js';
import { rateLimitMiddleware } from './middleware/ratelimit.js';
import { memoryRouter } from './routes/memory.js';
import { briefingRouter } from './routes/briefing.js';
import { statsRouter } from './routes/stats.js';
import { consolidationRouter } from './routes/consolidation.js';
import { entitiesRouter } from './routes/entities.js';
import { exportRouter } from './routes/export.js';
import { reflectRouter } from './routes/reflect.js';
import { researchRouter } from './routes/research.js';
import { collectionsRouter } from './routes/collections.js';
import { initPgvector, ensureEntityIndex } from './services/pgvector.js';
import { initEmbeddings, getEmbeddingDimensions } from './services/embedders/interface.js';
import { initReranker } from './services/reranker/interface.js';
import { initStore, isEntityStoreAvailable, loadAllAliases, _getStoreInstance } from './services/stores/interface.js';
import { initKeywordSearch, getKeywordIndexCount } from './services/keyword-search.js';
import { initLLM } from './services/llm/interface.js';
import { runConsolidation } from './services/consolidation.js';
import { loadAliasCache } from './services/entities.js';
import { startupConfigIssues } from './services/config-utils.js';

process.on('unhandledRejection', (reason) => {
  console.error('[unhandled-rejection]', reason);
});

// Validate required environment variables. BRAIN_API_KEY presence + strength
// (no whitespace, not a placeholder, min length) is checked in config-utils so
// a weak key never silently gates a live API.
const configIssues = startupConfigIssues(process.env);
if (configIssues.length > 0) {
  for (const issue of configIssues) console.error(`[zengram] FATAL: ${issue}`);
  process.exit(1);
}

if (!process.env.POSTGRES_URL) {
  console.error('[zengram] FATAL: POSTGRES_URL is required. Set it in .env or environment.');
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 8084;
const HOST = process.env.HOST || '127.0.0.1';

// Trust proxy — the failed-auth throttle keys on req.ip, which is the reverse
// proxy's IP (MCP Hub / Cloudflare) unless Express is told to read
// X-Forwarded-For. Off by default (direct-bind). TRUST_PROXY accepts the forms
// Express itself accepts: 'true'/'false', a hop count, or a CSV of IPs/CIDRs
// (or a preset like 'loopback'). Only the two scalar keywords need coercing.
const trustProxy = process.env.TRUST_PROXY;
if (trustProxy !== undefined && trustProxy.trim() !== '') {
  const tp = trustProxy.trim();
  if (tp === 'true') app.set('trust proxy', true);
  else if (tp === 'false') app.set('trust proxy', false);
  else if (/^\d+$/.test(tp)) app.set('trust proxy', parseInt(tp, 10));
  else app.set('trust proxy', tp);
}

app.use(express.json({ limit: '1mb' }));

// Request correlation ID
app.use((req, res, next) => {
  req.requestId = req.headers['x-request-id'] || crypto.randomUUID();
  res.setHeader('x-request-id', req.requestId);
  next();
});

// Dedicated single-connection pool for the health probe. Kept separate from the
// vector store's pool so a saturated request pool can't mask a "DB down" signal,
// and so /health stays off the query hot path. Lazily created on first probe.
let healthPool = null;
function getHealthPool() {
  if (!healthPool) {
    healthPool = new pg.Pool({
      connectionString: process.env.POSTGRES_URL,
      max: 1,
      connectionTimeoutMillis: 500, // fail fast on a dead DB instead of hanging
      idleTimeoutMillis: 10_000,
      // Abort a hung probe at the driver level too — Promise.race alone leaves
      // the query occupying the pool's single connection, and repeated /health
      // calls would then queue on it unboundedly.
      query_timeout: 500,
    });
    // Swallow idle-client errors — the probe query is the source of truth.
    healthPool.on('error', () => {});
  }
  return healthPool;
}

// Probe Postgres with SELECT 1, capped at ~500ms so a stalled DB can't hang the
// health endpoint. connectionTimeoutMillis covers connect stalls; the race timer
// covers a hung query on an already-open connection.
async function probePostgres() {
  const pool = getHealthPool();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('postgres probe timeout')), 500);
    timer.unref();
  });
  try {
    await Promise.race([pool.query('SELECT 1'), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// getEmbeddingDimensions() throws until initEmbeddings() has completed — a clean
// "is the provider up?" flag without adding an export to the embedder interface.
function embeddingsReady() {
  try {
    return getEmbeddingDimensions() > 0;
  } catch {
    return false;
  }
}

// Deep health check (no auth) — probes real dependencies so a downed Postgres or
// an uninitialized embedder returns 503, not a misleading 200.
app.get('/health', async (req, res) => {
  const checks = { postgres: 'down', embeddings: 'down' };
  try {
    await probePostgres();
    checks.postgres = 'up';
  } catch {
    // leave postgres 'down'
  }
  checks.embeddings = embeddingsReady() ? 'up' : 'down';

  const healthy = checks.postgres === 'up' && checks.embeddings === 'up';
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    service: 'zengram',
    checks,
    timestamp: new Date().toISOString(),
  });
});

// All other routes require API key + rate limiting
app.use(authMiddleware);
app.use(rateLimitMiddleware);

app.use('/stats', statsRouter);
app.use('/memory', memoryRouter);
app.use('/briefing', briefingRouter);
app.use('/consolidate', consolidationRouter);
app.use('/entities', entitiesRouter);
app.use('/export', exportRouter);
app.use('/reflect', reflectRouter);
app.use('/research', researchRouter);
app.use('/collections', collectionsRouter);

async function start() {
  try {
    // Embedding provider must come up first — pgvector init reads the
    // dimensions when registering the vector column type.
    await initEmbeddings();

    await initPgvector();
    await ensureEntityIndex();
    console.log('[zengram] Vector store ready (pgvector)');

    await initStore();
    initKeywordSearch(_getStoreInstance());

    // Optional cross-encoder rerank stage (RERANK_ENABLED). Probes the endpoint
    // and degrades to fused order on failure — never blocks startup.
    await initReranker();

    // Load entity alias cache for fast-path extraction. A clean empty database
    // just returns []; any real error (connection, schema drift) must be loud.
    if (isEntityStoreAvailable()) {
      try {
        const aliases = await loadAllAliases();
        loadAliasCache(aliases);
      } catch (e) {
        console.warn('[zengram] Alias cache load failed:', e.message);
      }
    }

    // Initialize the LLM provider when consolidation OR research is enabled.
    // Consolidation runs on a gated schedule (skips if corpus < CONSOLIDATION_MIN_CORPUS,
    // default 1500; manual POST /consolidate always runs). /research is an on-demand
    // agentic loop (RESEARCH_ENABLED=true) that needs the same provider but no cron.
    const consolidationEnabled = process.env.CONSOLIDATION_ENABLED !== 'false';
    const researchEnabled = process.env.RESEARCH_ENABLED === 'true';
    if (consolidationEnabled || researchEnabled) {
      try {
        await initLLM();
        console.log(`[zengram] LLM provider ready${researchEnabled ? ' (research enabled)' : ''}`);

        if (consolidationEnabled) {
          const interval = process.env.CONSOLIDATION_INTERVAL || '0 */6 * * *';
          const minCorpus = parseInt(process.env.CONSOLIDATION_MIN_CORPUS) || 1500;
          const { default: cron } = await import('node-cron');
          cron.schedule(interval, async () => {
            try {
              const corpusSize = await getKeywordIndexCount();
              if (corpusSize < minCorpus) {
                console.log(`[consolidation] Skipped (corpus=${corpusSize} < threshold=${minCorpus})`);
                return;
              }
              console.log(`[consolidation] Scheduled run starting (corpus=${corpusSize})...`);
              const result = await runConsolidation();
              console.log(`[consolidation] Complete: ${result.memories_processed} memories processed`);
            } catch (err) {
              console.error('[consolidation] Scheduled run failed:', err.message);
            }
          });
          console.log(`[zengram] Consolidation scheduled: ${interval} (gated at ${minCorpus} memories)`);
        }
      } catch (llmErr) {
        console.warn(`[zengram] LLM provider init failed (consolidation/research unavailable): ${llmErr.message}`);
      }
    } else {
      console.log('[zengram] Consolidation disabled (CONSOLIDATION_ENABLED=false)');
    }

    const server = app.listen(PORT, HOST, () => {
      console.log(`[zengram] Memory API running on ${HOST}:${PORT}`);
    });

    // Graceful shutdown
    const shutdown = (signal) => {
      console.log(`[zengram] ${signal} received — shutting down gracefully...`);
      server.close(async () => {
        try {
          const store = _getStoreInstance();
          await store?.close?.();
          await healthPool?.end?.();
        } catch (e) { /* best-effort */ }
        console.log('[zengram] HTTP server closed');
        process.exit(0);
      });
      // Force exit after 10s if connections don't drain
      setTimeout(() => {
        console.error('[zengram] Forced exit after timeout');
        process.exit(1);
      }, 10_000).unref();
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    console.error('[zengram] Failed to start:', err.message);
    process.exit(1);
  }
}

start();
