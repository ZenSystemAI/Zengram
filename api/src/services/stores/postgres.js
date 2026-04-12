import pg from 'pg';

export class PostgresStore {
  constructor() {
    this.url = process.env.POSTGRES_URL || 'postgresql://localhost:5432/zengram';
    this.pool = null;
  }

  async init() {
    this.pool = new pg.Pool({ connectionString: this.url });
    this.pool.on('error', (err) => console.error('[postgres] Idle client error:', err.message));

    // Create tables
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS events (
        id SERIAL PRIMARY KEY,
        content TEXT NOT NULL,
        type TEXT DEFAULT 'event',
        source_agent TEXT,
        client_id TEXT DEFAULT 'global',
        category TEXT DEFAULT 'episodic',
        importance TEXT DEFAULT 'medium',
        knowledge_category TEXT DEFAULT 'general',
        content_hash TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS facts (
        id SERIAL PRIMARY KEY,
        key TEXT UNIQUE NOT NULL,
        value TEXT NOT NULL,
        content TEXT,
        source_agent TEXT,
        client_id TEXT DEFAULT 'global',
        category TEXT DEFAULT 'semantic',
        importance TEXT DEFAULT 'medium',
        knowledge_category TEXT DEFAULT 'general',
        content_hash TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS statuses (
        id SERIAL PRIMARY KEY,
        subject TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL,
        source_agent TEXT,
        client_id TEXT DEFAULT 'global',
        category TEXT DEFAULT 'episodic',
        importance TEXT DEFAULT 'medium',
        knowledge_category TEXT DEFAULT 'general',
        content_hash TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_events_source ON events(source_agent);
      CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
      CREATE INDEX IF NOT EXISTS idx_events_client ON events(client_id);
      CREATE INDEX IF NOT EXISTS idx_facts_key ON facts(key);
      CREATE INDEX IF NOT EXISTS idx_facts_client ON facts(client_id);
      CREATE INDEX IF NOT EXISTS idx_statuses_subject ON statuses(subject);
      CREATE INDEX IF NOT EXISTS idx_statuses_client ON statuses(client_id);
    `);

    // Migrate: add knowledge_category to existing tables (safe if already exists)
    for (const table of ['events', 'facts', 'statuses']) {
      try {
        await this.pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS knowledge_category TEXT DEFAULT 'general'`);
      } catch (_) { /* column already exists */ }
    }

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS entities (
        id SERIAL PRIMARY KEY,
        canonical_name TEXT UNIQUE NOT NULL,
        entity_type TEXT NOT NULL,
        first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        mention_count INTEGER DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS entity_aliases (
        id SERIAL PRIMARY KEY,
        entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        alias TEXT UNIQUE NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS entity_memory_links (
        id SERIAL PRIMARY KEY,
        entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        memory_id TEXT NOT NULL,
        role TEXT DEFAULT 'mentioned',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS entity_relationships (
        id SERIAL PRIMARY KEY,
        source_entity_id INTEGER REFERENCES entities(id),
        target_entity_id INTEGER REFERENCES entities(id),
        relationship_type TEXT NOT NULL DEFAULT 'co_occurrence',
        strength INTEGER DEFAULT 1,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(source_entity_id, target_entity_id, relationship_type)
      );

      CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entity_type);
      CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(canonical_name);
      CREATE INDEX IF NOT EXISTS idx_ea_alias ON entity_aliases(alias);
      CREATE INDEX IF NOT EXISTS idx_ea_entity ON entity_aliases(entity_id);
      CREATE INDEX IF NOT EXISTS idx_eml_entity ON entity_memory_links(entity_id);
      CREATE INDEX IF NOT EXISTS idx_eml_memory ON entity_memory_links(memory_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_eml_unique ON entity_memory_links(entity_id, memory_id, role);
      CREATE INDEX IF NOT EXISTS idx_er_source ON entity_relationships(source_entity_id);
      CREATE INDEX IF NOT EXISTS idx_er_target ON entity_relationships(target_entity_id);
    `);

    // Keyword search table (BM25 via tsvector)
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS memory_search (
        memory_id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        content_tsv TSVECTOR,
        client_id TEXT DEFAULT 'global',
        source_agent TEXT,
        type TEXT,
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_ms_tsv ON memory_search USING GIN(content_tsv);
      CREATE INDEX IF NOT EXISTS idx_ms_client ON memory_search(client_id);
      CREATE INDEX IF NOT EXISTS idx_ms_active ON memory_search(active) WHERE active = true;
    `);

    // tsvector auto-compute trigger
    await this.pool.query(`
      CREATE OR REPLACE FUNCTION memory_search_tsv_trigger() RETURNS trigger AS $$
      BEGIN
        NEW.content_tsv := to_tsvector('english', COALESCE(NEW.content, ''));
        RETURN NEW;
      END $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_ms_tsv ON memory_search;
      CREATE TRIGGER trg_ms_tsv BEFORE INSERT OR UPDATE OF content
        ON memory_search FOR EACH ROW EXECUTE FUNCTION memory_search_tsv_trigger();
    `);

    // Co-occurrence partial indexes for graph search performance
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_er_cooccurrence_src
        ON entity_relationships(source_entity_id, strength DESC)
        WHERE relationship_type = 'co_occurrence';
      CREATE INDEX IF NOT EXISTS idx_er_cooccurrence_tgt
        ON entity_relationships(target_entity_id, strength DESC)
        WHERE relationship_type = 'co_occurrence';
    `);

    console.log(`[postgres] Database ready`);
  }

  async createEvent(data) {
    const result = await this.pool.query(
      `INSERT INTO events (content, type, source_agent, client_id, category, importance, knowledge_category, content_hash, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [data.content, data.type || 'event', data.source_agent, data.client_id || 'global',
       data.category || 'episodic', data.importance || 'medium', data.knowledge_category || 'general',
       data.content_hash, data.created_at || new Date().toISOString()]
    );
    return { id: result.rows[0].id };
  }

  async listEvents(filters = {}) {
    let sql = 'SELECT * FROM events WHERE 1=1';
    const params = [];
    let i = 1;

    if (filters.type) { sql += ` AND type = $${i++}`; params.push(filters.type); }
    if (filters.source_agent) { sql += ` AND source_agent = $${i++}`; params.push(filters.source_agent); }
    if (filters.category) { sql += ` AND category = $${i++}`; params.push(filters.category); }
    if (filters.client_id) { sql += ` AND client_id = $${i++}`; params.push(filters.client_id); }
    if (filters.since) { sql += ` AND created_at >= $${i++}`; params.push(filters.since); }

    const limit = Math.min(parseInt(filters.limit) || 50, 500);
    sql += ` ORDER BY created_at DESC LIMIT $${i++}`;
    params.push(limit);
    const result = await this.pool.query(sql, params);
    return { results: result.rows };
  }

  async upsertFact(data) {
    const now = new Date().toISOString();
    const result = await this.pool.query(
      `INSERT INTO facts (key, value, content, source_agent, client_id, category, importance, knowledge_category, content_hash, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (key) DO UPDATE SET
         value = EXCLUDED.value, content = EXCLUDED.content, source_agent = EXCLUDED.source_agent,
         client_id = EXCLUDED.client_id, category = EXCLUDED.category, importance = EXCLUDED.importance,
         knowledge_category = EXCLUDED.knowledge_category, content_hash = EXCLUDED.content_hash, updated_at = EXCLUDED.updated_at
       RETURNING id`,
      [data.key, data.value || data.content, data.content, data.source_agent,
       data.client_id || 'global', data.category || 'semantic', data.importance || 'medium',
       data.knowledge_category || 'general', data.content_hash, data.created_at || now, now]
    );
    return { id: result.rows[0].id };
  }

  async listFacts(filters = {}) {
    let sql = 'SELECT * FROM facts WHERE 1=1';
    const params = [];
    let i = 1;

    if (filters.source_agent) { sql += ` AND source_agent = $${i++}`; params.push(filters.source_agent); }
    if (filters.category) { sql += ` AND category = $${i++}`; params.push(filters.category); }
    if (filters.client_id) { sql += ` AND client_id = $${i++}`; params.push(filters.client_id); }
    if (filters.key) { sql += ` AND key ILIKE $${i++}`; params.push(`%${filters.key}%`); }

    const limit = Math.min(parseInt(filters.limit) || 50, 500);
    sql += ` ORDER BY updated_at DESC LIMIT $${i++}`;
    params.push(limit);
    const result = await this.pool.query(sql, params);
    return { results: result.rows };
  }

  async upsertStatus(data) {
    const now = new Date().toISOString();
    const result = await this.pool.query(
      `INSERT INTO statuses (subject, status, source_agent, client_id, category, importance, knowledge_category, content_hash, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (subject) DO UPDATE SET
         status = EXCLUDED.status, source_agent = EXCLUDED.source_agent,
         client_id = EXCLUDED.client_id, category = EXCLUDED.category, importance = EXCLUDED.importance,
         knowledge_category = EXCLUDED.knowledge_category, content_hash = EXCLUDED.content_hash, updated_at = EXCLUDED.updated_at
       RETURNING id`,
      [data.subject, data.status, data.source_agent, data.client_id || 'global',
       data.category || 'episodic', data.importance || 'medium', data.knowledge_category || 'general',
       data.content_hash, data.created_at || now, now]
    );
    return { id: result.rows[0].id };
  }

  async listStatuses(filters = {}) {
    let sql = 'SELECT * FROM statuses WHERE 1=1';
    const params = [];
    let i = 1;

    if (filters.source_agent) { sql += ` AND source_agent = $${i++}`; params.push(filters.source_agent); }
    if (filters.category) { sql += ` AND category = $${i++}`; params.push(filters.category); }
    if (filters.client_id) { sql += ` AND client_id = $${i++}`; params.push(filters.client_id); }
    if (filters.subject) { sql += ` AND subject ILIKE $${i++}`; params.push(`%${filters.subject}%`); }

    const limit = Math.min(parseInt(filters.limit) || 50, 500);
    sql += ` ORDER BY updated_at DESC LIMIT $${i++}`;
    params.push(limit);
    const result = await this.pool.query(sql, params);
    return { results: result.rows };
  }

  // --- Entity methods ---

  async createEntity(data) {
    const now = new Date().toISOString();
    const result = await this.pool.query(
      `INSERT INTO entities (canonical_name, entity_type, first_seen, last_seen)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (canonical_name) DO UPDATE SET
         mention_count = entities.mention_count + 1,
         last_seen = EXCLUDED.last_seen
       RETURNING id, (xmax = 0) as created`,
      [data.canonical_name, data.entity_type || 'system', data.first_seen || now, data.last_seen || now]
    );
    const entityId = result.rows[0].id;
    const created = result.rows[0].created;
    if (created) {
      try {
        await this.pool.query('INSERT INTO entity_aliases (entity_id, alias) VALUES ($1, $2)', [entityId, data.canonical_name.toLowerCase()]);
      } catch (e) { /* alias exists */ }
    }
    return { id: entityId, created };
  }

  async findEntity(name) {
    const lower = name.toLowerCase();
    const alias = await this.pool.query(
      'SELECT e.* FROM entity_aliases ea JOIN entities e ON e.id = ea.entity_id WHERE ea.alias = $1', [lower]
    );
    const entity = alias.rows[0] || (await this.pool.query('SELECT * FROM entities WHERE LOWER(canonical_name) = $1', [lower])).rows[0];
    if (!entity) return null;
    const aliases = await this.pool.query('SELECT alias FROM entity_aliases WHERE entity_id = $1', [entity.id]);
    entity.aliases = aliases.rows.map(a => a.alias);
    return entity;
  }

  async linkEntityToMemory(entityId, memoryId, role = 'mentioned') {
    try {
      await this.pool.query(
        'INSERT INTO entity_memory_links (entity_id, memory_id, role) VALUES ($1, $2, $3)', [entityId, memoryId, role]
      );
      return { linked: true };
    } catch (e) {
      return { linked: false, duplicate: true };
    }
  }

  async listEntities(filters = {}) {
    let sql = `SELECT e.*, ARRAY_AGG(ea.alias) FILTER (WHERE ea.alias IS NOT NULL) as aliases
               FROM entities e LEFT JOIN entity_aliases ea ON ea.entity_id = e.id WHERE 1=1`;
    const params = [];
    let i = 1;
    if (filters.entity_type) { sql += ` AND e.entity_type = $${i++}`; params.push(filters.entity_type); }
    sql += ' GROUP BY e.id ORDER BY e.mention_count DESC';
    sql += ` LIMIT $${i++}`; params.push(parseInt(filters.limit) || 50);
    if (filters.offset) { sql += ` OFFSET $${i++}`; params.push(parseInt(filters.offset) || 0); }
    const result = await this.pool.query(sql, params);
    return { results: result.rows.map(r => ({ ...r, aliases: r.aliases || [] })) };
  }

  async getEntityMemories(entityId, limit = 20) {
    const result = await this.pool.query(
      'SELECT memory_id, role, created_at FROM entity_memory_links WHERE entity_id = $1 ORDER BY created_at DESC LIMIT $2',
      [entityId, limit]
    );
    return { results: result.rows };
  }

  async upsertAlias(entityId, alias) {
    try {
      await this.pool.query('INSERT INTO entity_aliases (entity_id, alias) VALUES ($1, $2)', [entityId, alias.toLowerCase()]);
      return { created: true };
    } catch (e) {
      return { created: false, duplicate: true };
    }
  }

  async loadAllAliases() {
    const result = await this.pool.query(
      'SELECT ea.alias, ea.entity_id, e.canonical_name, e.entity_type FROM entity_aliases ea JOIN entities e ON e.id = ea.entity_id'
    );
    return result.rows;
  }

  async getEntityStats() {
    const total = (await this.pool.query('SELECT COUNT(*) as count FROM entities')).rows[0].count;
    const byType = (await this.pool.query('SELECT entity_type, COUNT(*) as count FROM entities GROUP BY entity_type')).rows;
    const topMentioned = (await this.pool.query('SELECT canonical_name, entity_type, mention_count FROM entities ORDER BY mention_count DESC LIMIT 10')).rows;
    return { total: parseInt(total), by_type: Object.fromEntries(byType.map(r => [r.entity_type, parseInt(r.count)])), top_mentioned: topMentioned };
  }

  // --- Entity relationship methods ---

  async createRelationship(sourceId, targetId, type = 'co_occurrence') {
    const result = await this.pool.query(
      `INSERT INTO entity_relationships (source_entity_id, target_entity_id, relationship_type)
       VALUES ($1, $2, $3)
       ON CONFLICT (source_entity_id, target_entity_id, relationship_type)
       DO UPDATE SET strength = entity_relationships.strength + 1, updated_at = NOW()
       RETURNING id, strength`,
      [sourceId, targetId, type]
    );
    return { id: result.rows[0].id, strength: result.rows[0].strength };
  }

  async getRelationships(entityId, minStrength = 1) {
    const result = await this.pool.query(
      `SELECT
         CASE WHEN er.source_entity_id = $1 THEN e2.id ELSE e1.id END as entity_id,
         CASE WHEN er.source_entity_id = $1 THEN e2.canonical_name ELSE e1.canonical_name END as entity_name,
         CASE WHEN er.source_entity_id = $1 THEN e2.entity_type ELSE e1.entity_type END as entity_type,
         er.relationship_type,
         er.strength
       FROM entity_relationships er
       JOIN entities e1 ON e1.id = er.source_entity_id
       JOIN entities e2 ON e2.id = er.target_entity_id
       WHERE (er.source_entity_id = $1 OR er.target_entity_id = $1)
         AND er.strength >= $2
       ORDER BY er.strength DESC`,
      [entityId, minStrength]
    );
    return result.rows.map(r => ({
      entity: { id: r.entity_id, name: r.entity_name, type: r.entity_type },
      relationship_type: r.relationship_type,
      strength: r.strength,
    }));
  }

  async close() {
    if (this.pool) await this.pool.end();
  }

  async listRelationships(filters = {}) {
    let sql = `SELECT
         e1.id as source_id, e1.canonical_name as source_name, e1.entity_type as source_type,
         e2.id as target_id, e2.canonical_name as target_name, e2.entity_type as target_type,
         er.relationship_type, er.strength
       FROM entity_relationships er
       JOIN entities e1 ON e1.id = er.source_entity_id
       JOIN entities e2 ON e2.id = er.target_entity_id
       WHERE 1=1`;
    const params = [];
    let i = 1;

    if (filters.type) { sql += ` AND er.relationship_type = $${i++}`; params.push(filters.type); }
    if (filters.min_strength) { sql += ` AND er.strength >= $${i++}`; params.push(parseInt(filters.min_strength)); }

    sql += ' ORDER BY er.strength DESC LIMIT 100';
    const result = await this.pool.query(sql, params);
    return result.rows.map(r => ({
      source: { id: r.source_id, name: r.source_name, type: r.source_type },
      target: { id: r.target_id, name: r.target_name, type: r.target_type },
      relationship_type: r.relationship_type,
      strength: r.strength,
    }));
  }
}
