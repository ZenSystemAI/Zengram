import { Router } from 'express';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  isEntityStoreAvailable, findEntity, listEntities, getEntityMemories, getEntityStats, _getStoreInstance,
} from '../services/stores/interface.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const graphTemplate = readFileSync(join(__dirname, '../templates/graph.html'), 'utf-8');
const indexTemplatePath = join(__dirname, '../templates/graph-index.html');
const indexTemplate = existsSync(indexTemplatePath) ? readFileSync(indexTemplatePath, 'utf-8') : null;

export const graphRouter = Router();

// --- Routes ---

// GET /graph/html — Index page: browse all entities, link into individual graphs
graphRouter.get('/html', async (req, res) => {
  try {
    if (!isEntityStoreAvailable()) {
      return res.status(400).send(
        '<h1>Entity store not available</h1><p>Graph visualization requires sqlite or postgres backend.</p>'
      );
    }

    const stats = await getEntityStats();
    const allEntities = await listEntities({ limit: 500 });
    const apiKey = req.query.key || '';

    // Group entities by type
    const grouped = {};
    for (const e of allEntities.results) {
      if (!grouped[e.entity_type]) grouped[e.entity_type] = [];
      grouped[e.entity_type].push(e);
    }
    // Sort each group by mention_count desc
    for (const type of Object.keys(grouped)) {
      grouped[type].sort((a, b) => (b.mention_count || 0) - (a.mention_count || 0));
    }

    if (indexTemplate) {
      const html = indexTemplate
        .replace('{{ENTITIES_DATA}}', JSON.stringify(grouped))
        .replace('{{STATS_DATA}}', JSON.stringify(stats))
        .replace(/\{\{API_KEY\}\}/g, escapeHtml(apiKey));
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(html);
    }

    // Fallback: simple HTML if template doesn't exist yet
    let html = buildFallbackIndex(grouped, stats, apiKey);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error('[graph:index]', err.message);
    res.status(500).send('<h1>Error</h1><p>Internal server error</p>');
  }
});

// GET /graph/full/html — Full brain graph (all entities)
graphRouter.get('/full/html', async (req, res) => {
  try {
    if (!isEntityStoreAvailable()) {
      return res.status(400).send(
        '<h1>Entity store not available</h1><p>Graph visualization requires sqlite or postgres backend.</p>'
      );
    }

    const graphData = await buildFullGraphData(80);

    const html = graphTemplate
      .replace(/\{\{ENTITY_NAME\}\}/g, 'Full Brain')
      .replace('{{GRAPH_DATA}}', JSON.stringify(graphData));

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error('[graph:full]', err.message);
    res.status(500).send('<h1>Error</h1><p>Internal server error</p>');
  }
});

// GET /graph/:entity/html — Interactive D3.js visualization
graphRouter.get('/:entity/html', async (req, res) => {
  try {
    if (!isEntityStoreAvailable()) {
      return res.status(400).send(
        '<h1>Entity store not available</h1><p>Graph visualization requires sqlite or postgres backend.</p>'
      );
    }

    const entityName = decodeURIComponent(req.params.entity);
    const depth = Math.min(parseInt(req.query.depth) || 2, 4);

    // Verify entity exists
    const entity = await findEntity(entityName);
    if (!entity) {
      return res.status(404).send(
        `<h1>Entity not found</h1><p>"${escapeHtml(entityName)}" was not found in the knowledge graph.</p>`
      );
    }

    const displayName = entity.canonical_name;
    const graphData = await buildGraphData(displayName, depth);

    // Render template
    const html = graphTemplate
      .replace(/\{\{ENTITY_NAME\}\}/g, escapeHtml(displayName))
      .replace('{{GRAPH_DATA}}', JSON.stringify(graphData));

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error('[graph:html]', err.message);
    res.status(500).send('<h1>Error</h1><p>Internal server error</p>');
  }
});

// GET /graph/:entity — JSON graph data
graphRouter.get('/:entity', async (req, res) => {
  try {
    if (!isEntityStoreAvailable()) {
      return res.status(400).json({
        error: 'Entity queries require sqlite or postgres backend.',
      });
    }

    const entityName = decodeURIComponent(req.params.entity);
    const depth = Math.min(parseInt(req.query.depth) || 2, 4);

    const entity = await findEntity(entityName);
    if (!entity) {
      return res.status(404).json({ error: 'Entity not found' });
    }

    const graphData = await buildGraphData(entity.canonical_name, depth);
    res.json(graphData);
  } catch (err) {
    console.error('[graph]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- Graph building ---

/**
 * Build graph data using co-occurrence from entity_memory_links.
 * Entities that share memory_ids are considered connected.
 * BFS traversal up to `depth` levels from the center entity.
 */
async function buildGraphData(centerName, depth) {
  const visited = new Map();  // lowercase name -> node object
  const edgeMap = new Map();  // "A||B" -> edge object
  const queue = [{ name: centerName, currentDepth: 0 }];

  while (queue.length > 0) {
    const { name, currentDepth } = queue.shift();
    const lowerName = name.toLowerCase();

    if (visited.has(lowerName)) continue;

    const entity = await findEntity(name);
    if (!entity) continue;

    const node = {
      id: entity.canonical_name,
      type: entity.entity_type,
      mention_count: entity.mention_count || 1,
    };
    visited.set(entity.canonical_name.toLowerCase(), node);

    // Stop expanding at max depth
    if (currentDepth >= depth) continue;

    // Find co-occurring entities via shared memory_ids
    const coEntities = await findCoOccurringEntities(entity.id, 40);

    for (const co of coEntities) {
      // Create or update edge
      const edgeKey = [entity.canonical_name, co.canonical_name].sort().join('||');
      if (edgeMap.has(edgeKey)) {
        edgeMap.get(edgeKey).strength = Math.max(edgeMap.get(edgeKey).strength, co.shared_count);
      } else {
        edgeMap.set(edgeKey, {
          source: entity.canonical_name,
          target: co.canonical_name,
          type: 'co_occurrence',
          strength: co.shared_count,
        });
      }

      // Enqueue for BFS expansion
      if (!visited.has(co.canonical_name.toLowerCase())) {
        queue.push({ name: co.canonical_name, currentDepth: currentDepth + 1 });
      }
    }
  }

  return {
    nodes: Array.from(visited.values()),
    edges: Array.from(edgeMap.values()),
    center: centerName,
  };
}

/**
 * Find entities that co-occur with the given entity (share memory_ids).
 * Uses direct DB access for efficient batch queries.
 * Falls back to interface-level queries if direct access unavailable.
 */
async function findCoOccurringEntities(entityId, limit = 40) {
  try {
    const store = _getStoreInstance();

    // Postgres path
    if (store?.pool) {
      return findCoOccurringPostgres(store.pool, entityId, limit);
    }

    // SQLite path
    if (store?.db) {
      return findCoOccurringDirect(store.db, entityId, limit);
    }

    return [];
  } catch (err) {
    console.error('[graph] findCoOccurringEntities error:', err.message);
    return [];
  }
}

/**
 * Postgres query for co-occurring entities.
 */
async function findCoOccurringPostgres(pool, entityId, limit) {
  const result = await pool.query(`
    SELECT eml2.entity_id, e.canonical_name, e.entity_type, e.mention_count,
           COUNT(DISTINCT eml2.memory_id) as shared_count
    FROM entity_memory_links eml1
    JOIN entity_memory_links eml2 ON eml1.memory_id = eml2.memory_id AND eml2.entity_id != $1
    JOIN entities e ON e.id = eml2.entity_id
    WHERE eml1.entity_id = $1
    GROUP BY eml2.entity_id, e.canonical_name, e.entity_type, e.mention_count
    ORDER BY shared_count DESC
    LIMIT $2
  `, [entityId, limit]);

  return result.rows.map(r => ({
    entity_id: r.entity_id,
    canonical_name: r.canonical_name,
    entity_type: r.entity_type,
    mention_count: r.mention_count || 1,
    shared_count: parseInt(r.shared_count),
  }));
}

/**
 * Direct DB query for co-occurring entities (SQLite).
 */
function findCoOccurringDirect(db, entityId, limit) {
  // Get memory_ids for this entity
  const links = db.prepare(
    'SELECT memory_id FROM entity_memory_links WHERE entity_id = ?'
  ).all(entityId);

  if (links.length === 0) return [];

  const memoryIds = links.map(l => l.memory_id);

  // Batch to avoid SQLite variable limits
  const batchSize = 200;
  const coMap = new Map();

  for (let i = 0; i < memoryIds.length; i += batchSize) {
    const batch = memoryIds.slice(i, i + batchSize);
    const placeholders = batch.map(() => '?').join(',');

    const rows = db.prepare(`
      SELECT eml.entity_id, e.canonical_name, e.entity_type, e.mention_count,
             COUNT(DISTINCT eml.memory_id) as shared_count
      FROM entity_memory_links eml
      JOIN entities e ON e.id = eml.entity_id
      WHERE eml.memory_id IN (${placeholders})
        AND eml.entity_id != ?
      GROUP BY eml.entity_id
      ORDER BY shared_count DESC
      LIMIT ?
    `).all(...batch, entityId, limit);

    for (const row of rows) {
      if (coMap.has(row.entity_id)) {
        coMap.get(row.entity_id).shared_count += row.shared_count;
      } else {
        coMap.set(row.entity_id, row);
      }
    }
  }

  return Array.from(coMap.values())
    .sort((a, b) => b.shared_count - a.shared_count)
    .slice(0, limit);
}

/**
 * Fallback: find co-occurring entities via the store interface.
 * Less efficient but works with any backend.
 */
async function findCoOccurringViaInterface(entityId, limit) {
  const memLinks = await getEntityMemories(entityId, 500);
  const memoryIds = memLinks.results.map(l => l.memory_id);
  if (memoryIds.length === 0) return [];

  const store = _getStoreInstance();
  if (!store?.db) return []; // Can't proceed without direct access

  return findCoOccurringDirect(store.db, entityId, limit);
}

/**
 * Build full brain graph — top N entities by mention count with their connections.
 */
async function buildFullGraphData(limit = 80) {
  const store = _getStoreInstance();
  if (!store) return { nodes: [], edges: [], center: 'Brain' };

  let topEntities;
  if (store.pool) {
    // Postgres
    const result = await store.pool.query(
      `SELECT id, canonical_name, entity_type, mention_count
       FROM entities ORDER BY mention_count DESC LIMIT $1`, [limit]
    );
    topEntities = result.rows;
  } else if (store.db) {
    // SQLite
    topEntities = store.db.prepare(
      `SELECT id, canonical_name, entity_type, mention_count
       FROM entities ORDER BY mention_count DESC LIMIT ?`
    ).all(limit);
  } else {
    return { nodes: [], edges: [], center: 'Brain' };
  }

  const entityIds = topEntities.map(e => e.id);
  const entityIdSet = new Set(entityIds);

  const nodes = topEntities.map(e => ({
    id: e.canonical_name,
    type: e.entity_type,
    mention_count: e.mention_count || 1,
  }));

  // Get edges between these entities
  const edgeMap = new Map();

  if (store.pool) {
    // Postgres: find co-occurrences between top entities
    const result = await store.pool.query(`
      SELECT e1.canonical_name as source_name, e2.canonical_name as target_name,
             COUNT(DISTINCT eml1.memory_id) as strength
      FROM entity_memory_links eml1
      JOIN entity_memory_links eml2 ON eml1.memory_id = eml2.memory_id AND eml1.entity_id < eml2.entity_id
      JOIN entities e1 ON e1.id = eml1.entity_id
      JOIN entities e2 ON e2.id = eml2.entity_id
      WHERE eml1.entity_id = ANY($1) AND eml2.entity_id = ANY($1)
      GROUP BY e1.canonical_name, e2.canonical_name
      HAVING COUNT(DISTINCT eml1.memory_id) >= 2
      ORDER BY strength DESC
      LIMIT 300
    `, [entityIds]);

    for (const row of result.rows) {
      edgeMap.set(`${row.source_name}||${row.target_name}`, {
        source: row.source_name,
        target: row.target_name,
        type: 'co_occurrence',
        strength: parseInt(row.strength),
      });
    }
  }

  // Find the highest mention entity as center
  const center = topEntities.length > 0 ? topEntities[0].canonical_name : 'Brain';

  return {
    nodes,
    edges: Array.from(edgeMap.values()),
    center,
  };
}

/**
 * Fallback index HTML (used if graph-index.html template doesn't exist).
 */
function buildFallbackIndex(grouped, stats, apiKey) {
  const typeColors = {
    client: '#4ECDB8', person: '#F59E0B', technology: '#3B82F6',
    workflow: '#8B5CF6', agent: '#EF4444', domain: '#10B981',
    service: '#EC4899', system: '#6366F1',
  };

  const keyParam = apiKey ? `?key=${encodeURIComponent(apiKey)}` : '';

  let entityRows = '';
  const typeOrder = ['agent', 'client', 'technology', 'system', 'domain', 'workflow', 'service', 'person'];

  for (const type of typeOrder) {
    const entities = grouped[type];
    if (!entities || entities.length === 0) continue;
    const color = typeColors[type] || '#94a3b8';

    entityRows += `<div class="type-section">
      <h2 style="color:${color}"><span class="type-dot" style="background:${color}"></span>${type} <span class="count">(${entities.length})</span></h2>
      <div class="entity-grid">`;

    for (const e of entities.slice(0, 30)) {
      entityRows += `
        <a href="/graph/${encodeURIComponent(e.canonical_name)}/html${keyParam}" class="entity-card">
          <span class="name">${escapeHtml(e.canonical_name)}</span>
          <span class="mentions">${e.mention_count || 0}</span>
        </a>`;
    }
    if (entities.length > 30) {
      entityRows += `<span class="more">+${entities.length - 30} more</span>`;
    }
    entityRows += `</div></div>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Knowledge Graph — Entity Browser</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');
  * { margin: 0; padding: 0; box-sizing: border-box; }
  :root {
    --bg: #0a0a0f; --surface: rgba(255,255,255,0.04); --surface-hover: rgba(255,255,255,0.08);
    --border: rgba(255,255,255,0.08); --text: #e2e8f0; --text-muted: #94a3b8; --text-dim: #64748b;
  }
  body { font-family: 'Inter', system-ui, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; }

  .header {
    padding: 40px 40px 32px;
    border-bottom: 1px solid var(--border);
    background: linear-gradient(180deg, rgba(78,205,184,0.04) 0%, transparent 100%);
  }
  .header h1 { font-size: 28px; font-weight: 700; letter-spacing: -0.03em; margin-bottom: 8px; }
  .header p { color: var(--text-muted); font-size: 14px; }

  .stats-row {
    display: flex; gap: 24px; margin-top: 20px; flex-wrap: wrap;
  }
  .stat-card {
    padding: 16px 24px; background: var(--surface); border: 1px solid var(--border);
    border-radius: 12px; min-width: 120px;
  }
  .stat-card .stat-value { font-size: 24px; font-weight: 700; }
  .stat-card .stat-label { font-size: 11px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.06em; margin-top: 4px; }

  .actions { display: flex; gap: 12px; margin-top: 20px; }
  .action-btn {
    padding: 10px 20px; background: rgba(78,205,184,0.1); border: 1px solid rgba(78,205,184,0.3);
    border-radius: 10px; color: #4ECDB8; font-family: inherit; font-size: 13px; font-weight: 600;
    cursor: pointer; text-decoration: none; transition: all 0.2s ease;
  }
  .action-btn:hover { background: rgba(78,205,184,0.2); border-color: rgba(78,205,184,0.5); }
  .action-btn.secondary { background: var(--surface); border-color: var(--border); color: var(--text-muted); }
  .action-btn.secondary:hover { background: var(--surface-hover); color: var(--text); }

  .content { padding: 32px 40px; }

  .search-box {
    width: 100%; max-width: 400px; padding: 12px 16px 12px 40px;
    background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
    color: var(--text); font-family: inherit; font-size: 14px; outline: none;
    margin-bottom: 32px; transition: all 0.3s ease;
  }
  .search-box:focus { border-color: rgba(78,205,184,0.4); box-shadow: 0 0 20px rgba(78,205,184,0.08); }
  .search-box::placeholder { color: var(--text-dim); }

  .type-section { margin-bottom: 32px; }
  .type-section h2 {
    font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em;
    margin-bottom: 12px; display: flex; align-items: center; gap: 8px;
  }
  .type-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
  .count { font-weight: 400; color: var(--text-dim); font-size: 12px; }

  .entity-grid { display: flex; flex-wrap: wrap; gap: 8px; }
  .entity-card {
    display: flex; align-items: center; gap: 10px;
    padding: 8px 14px; background: var(--surface); border: 1px solid var(--border);
    border-radius: 8px; text-decoration: none; color: var(--text); font-size: 13px;
    transition: all 0.2s ease; cursor: pointer;
  }
  .entity-card:hover { background: var(--surface-hover); border-color: rgba(255,255,255,0.15); transform: translateY(-1px); }
  .entity-card .name { font-weight: 500; }
  .entity-card .mentions {
    font-size: 10px; background: rgba(255,255,255,0.08); padding: 2px 8px;
    border-radius: 10px; color: var(--text-dim); font-weight: 600;
  }
  .more { font-size: 12px; color: var(--text-dim); padding: 8px 14px; }

  .footer {
    padding: 32px 40px; border-top: 1px solid var(--border); text-align: center;
    font-size: 11px; color: var(--text-dim);
  }
</style>
</head>
<body>
<div class="header">
  <h1>Knowledge Graph</h1>
  <p>Browse and explore entity relationships in the Shared Brain</p>
  <div class="stats-row">
    <div class="stat-card"><div class="stat-value">${stats.total || 0}</div><div class="stat-label">Entities</div></div>
    <div class="stat-card"><div class="stat-value">${Object.keys(grouped).length}</div><div class="stat-label">Types</div></div>
  </div>
  <div class="actions">
    <a href="/graph/full/html${keyParam}" class="action-btn">View Full Brain Graph</a>
  </div>
</div>
<div class="content">
  <input type="text" class="search-box" placeholder="Search entities..." id="search" autocomplete="off">
  ${entityRows}
</div>
<div class="footer">Powered by Shared Brain &mdash; Multi-Agent Memory</div>
<script>
  document.getElementById('search').addEventListener('input', function() {
    const q = this.value.toLowerCase();
    document.querySelectorAll('.entity-card').forEach(card => {
      const name = card.querySelector('.name').textContent.toLowerCase();
      card.style.display = name.includes(q) ? '' : 'none';
    });
  });
</script>
</body>
</html>`;
}

// --- Utilities ---

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
