import { Router } from 'express';
import { runConsolidation, startConsolidationJob, getJob, getConsolidationStatus } from '../services/consolidation.js';

export const consolidationRouter = Router();

// POST /consolidate — Trigger consolidation (async by default, ?sync=true for blocking)
consolidationRouter.post('/', async (req, res) => {
  try {
    if (req.query.sync === 'true') {
      // Legacy blocking mode
      const result = await runConsolidation();
      return res.json(result);
    }
    // Async mode — return job ID immediately
    const job = startConsolidationJob();
    if (job.status === 'skipped') {
      return res.status(409).json(job);
    }
    res.status(202).json(job);
  } catch (err) {
    console.error('[consolidation]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /consolidate/job/:id — Poll job status
consolidationRouter.get('/job/:id', async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Job not found or expired' });
  }
  res.json({ job_id: req.params.id, ...job });
});

// GET /consolidate/status — Current consolidation status
consolidationRouter.get('/status', async (req, res) => {
  try {
    res.json(getConsolidationStatus());
  } catch (err) {
    console.error('[consolidation:status]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});
