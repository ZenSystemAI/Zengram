import { Router } from 'express';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dashboardHtml = readFileSync(join(__dirname, '../templates/dashboard.html'), 'utf-8');

export const dashboardRouter = Router();

// GET /dashboard — Serve dashboard (no auth — it's just HTML, API calls use x-api-key header)
dashboardRouter.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(dashboardHtml);
});
