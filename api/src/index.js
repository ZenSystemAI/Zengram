import express from 'express';
import crypto from 'crypto';
import { authMiddleware } from './middleware/auth.js';
import { rateLimitMiddleware } from './middleware/ratelimit.js';
import { memoryRouter } from './routes/memory.js';
import { briefingRouter } from './routes/briefing.js';
import { webhookRouter } from './routes/webhook.js';
import { statsRouter } from './routes/stats.js';
import { consolidationRouter } from './routes/consolidation.js';
import { entitiesRouter } from './routes/entities.js';
import { clientRouter } from './routes/client.js';
import { exportRouter } from './routes/export.js';
import { graphRouter } from './routes/graph.js';
import { initQdrant, ensureEntityIndex } from './services/qdrant.js';
import { initEmbeddings } from './services/embedders/interface.js';
import { initStore, isEntityStoreAvailable, loadAllAliases, _getStoreInstance, getBackendType } from './services/stores/interface.js';
import { initKeywordSearch } from './services/keyword-search.js';
import { initClientResolver } from './services/client-resolver.js';
import { initLLM } from './services/llm/interface.js';
import { runConsolidation } from './services/consolidation.js';
import { loadAliasCache } from './services/entities.js';

// Validate required environment variables
if (!process.env.BRAIN_API_KEY) {
  console.error('[shared-brain] FATAL: BRAIN_API_KEY is required. Set it in .env or environment.');
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 8084;
const HOST = process.env.HOST || '127.0.0.1';

app.use(express.json({ limit: '1mb' }));

// Request correlation ID
app.use((req, res, next) => {
  req.requestId = req.headers['x-request-id'] || crypto.randomUUID();
  res.setHeader('x-request-id', req.requestId);
  next();
});

// Health check (no auth)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'shared-brain', timestamp: new Date().toISOString() });
});

// All other routes require API key + rate limiting
app.use(authMiddleware);
app.use(rateLimitMiddleware);

app.use('/stats', statsRouter);
app.use('/memory', memoryRouter);
app.use('/briefing', briefingRouter);
app.use('/webhook', webhookRouter);
app.use('/consolidate', consolidationRouter);
app.use('/entities', entitiesRouter);
app.use('/client', clientRouter);
app.use('/export', exportRouter);
app.use('/graph', graphRouter);

async function start() {
  try {
    // Initialize embedding provider first (Qdrant needs dimensions)
    await initEmbeddings();

    await initQdrant();
    await ensureEntityIndex();
    console.log('[shared-brain] Qdrant collection ready');

    // Initialize structured storage backend
    await initStore();

    // Initialize keyword search (BM25 via Postgres tsvector or SQLite FTS5)
    initKeywordSearch(_getStoreInstance(), getBackendType());

    // Initialize client fingerprint resolver (Baserow → fuzzy matcher)
    await initClientResolver();

    // Load entity alias cache for fast-path extraction
    if (isEntityStoreAvailable()) {
      try {
        const aliases = await loadAllAliases();
        loadAliasCache(aliases);
      } catch (e) {
        console.log('[shared-brain] Entity alias cache: starting empty (first run)');
      }
    }

    // Initialize consolidation LLM (optional — only if enabled)
    if (process.env.CONSOLIDATION_ENABLED !== 'false') {
      try {
        await initLLM();
        console.log('[shared-brain] Consolidation LLM ready');

        // Set up consolidation schedule
        const interval = process.env.CONSOLIDATION_INTERVAL || '0 */6 * * *';
        const { default: cron } = await import('node-cron');
        cron.schedule(interval, async () => {
          console.log('[consolidation] Scheduled run starting...');
          try {
            const result = await runConsolidation();
            console.log(`[consolidation] Complete: ${result.memories_processed} memories processed`);
          } catch (err) {
            console.error('[consolidation] Scheduled run failed:', err.message);
          }
        });
        console.log(`[shared-brain] Consolidation scheduled: ${interval}`);
      } catch (llmErr) {
        console.warn(`[shared-brain] Consolidation LLM init failed (consolidation disabled): ${llmErr.message}`);
      }
    } else {
      console.log('[shared-brain] Consolidation disabled (CONSOLIDATION_ENABLED=false)');
    }

    const server = app.listen(PORT, HOST, () => {
      console.log(`[shared-brain] Memory API running on ${HOST}:${PORT}`);
    });

    // Graceful shutdown
    const shutdown = (signal) => {
      console.log(`[shared-brain] ${signal} received — shutting down gracefully...`);
      server.close(() => {
        console.log('[shared-brain] HTTP server closed');
        process.exit(0);
      });
      // Force exit after 10s if connections don't drain
      setTimeout(() => {
        console.error('[shared-brain] Forced exit after timeout');
        process.exit(1);
      }, 10_000).unref();
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    console.error('[shared-brain] Failed to start:', err.message);
    process.exit(1);
  }
}

start();
