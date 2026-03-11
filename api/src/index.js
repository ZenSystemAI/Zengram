import express from 'express';
import { authMiddleware } from './middleware/auth.js';
import { memoryRouter } from './routes/memory.js';
import { briefingRouter } from './routes/briefing.js';
import { webhookRouter } from './routes/webhook.js';
import { statsRouter } from './routes/stats.js';
import { consolidationRouter } from './routes/consolidation.js';
import { initQdrant } from './services/qdrant.js';
import { initEmbeddings } from './services/embedders/interface.js';
import { initStore } from './services/stores/interface.js';
import { initLLM } from './services/llm/interface.js';
import { runConsolidation } from './services/consolidation.js';

// Validate required environment variables
if (!process.env.BRAIN_API_KEY) {
  console.error('[shared-brain] FATAL: BRAIN_API_KEY is required. Set it in .env or environment.');
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 8084;
const HOST = process.env.HOST || '127.0.0.1';

app.use(express.json({ limit: '1mb' }));

// Health check (no auth)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'shared-brain', timestamp: new Date().toISOString() });
});

// All other routes require API key
app.use(authMiddleware);

app.use('/stats', statsRouter);
app.use('/memory', memoryRouter);
app.use('/briefing', briefingRouter);
app.use('/webhook', webhookRouter);
app.use('/consolidate', consolidationRouter);

async function start() {
  try {
    // Initialize embedding provider first (Qdrant needs dimensions)
    await initEmbeddings();

    await initQdrant();
    console.log('[shared-brain] Qdrant collection ready');

    // Initialize structured storage backend
    await initStore();

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

    app.listen(PORT, HOST, () => {
      console.log(`[shared-brain] Memory API running on ${HOST}:${PORT}`);
    });
  } catch (err) {
    console.error('[shared-brain] Failed to start:', err.message);
    process.exit(1);
  }
}

start();
