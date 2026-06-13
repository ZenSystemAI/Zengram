import express from 'express';
import crypto from 'crypto';
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
import { initEmbeddings } from './services/embedders/interface.js';
import { initStore, isEntityStoreAvailable, loadAllAliases, _getStoreInstance } from './services/stores/interface.js';
import { initKeywordSearch, getKeywordIndexCount } from './services/keyword-search.js';
import { initLLM } from './services/llm/interface.js';
import { runConsolidation } from './services/consolidation.js';
import { loadAliasCache } from './services/entities.js';

process.on('unhandledRejection', (reason) => {
  console.error('[unhandled-rejection]', reason);
});

// Validate required environment variables
if (!process.env.BRAIN_API_KEY) {
  console.error('[zengram] FATAL: BRAIN_API_KEY is required. Set it in .env or environment.');
  process.exit(1);
}

if (!process.env.POSTGRES_URL) {
  console.error('[zengram] FATAL: POSTGRES_URL is required. Set it in .env or environment.');
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
  res.json({ status: 'ok', service: 'zengram', timestamp: new Date().toISOString() });
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
