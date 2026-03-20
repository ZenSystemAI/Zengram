import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

export class SQLiteStore {
  constructor() {
    this.dbPath = process.env.SQLITE_PATH || './data/brain.db';
    this.db = null;
  }

  async init() {
    // Ensure directory exists
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    // Create tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        type TEXT DEFAULT 'event',
        source_agent TEXT,
        client_id TEXT DEFAULT 'global',
        category TEXT DEFAULT 'episodic',
        importance TEXT DEFAULT 'medium',
        content_hash TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT UNIQUE NOT NULL,
        value TEXT NOT NULL,
        content TEXT,
        source_agent TEXT,
        client_id TEXT DEFAULT 'global',
        category TEXT DEFAULT 'semantic',
        importance TEXT DEFAULT 'medium',
        content_hash TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS statuses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subject TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL,
        source_agent TEXT,
        client_id TEXT DEFAULT 'global',
        category TEXT DEFAULT 'episodic',
        importance TEXT DEFAULT 'medium',
        content_hash TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_events_source ON events(source_agent);
      CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
      CREATE INDEX IF NOT EXISTS idx_events_client ON events(client_id);
      CREATE INDEX IF NOT EXISTS idx_facts_key ON facts(key);
      CREATE INDEX IF NOT EXISTS idx_facts_client ON facts(client_id);
      CREATE INDEX IF NOT EXISTS idx_statuses_subject ON statuses(subject);

      CREATE TABLE IF NOT EXISTS entities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        canonical_name TEXT UNIQUE NOT NULL,
        entity_type TEXT NOT NULL,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        mention_count INTEGER DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS entity_aliases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        alias TEXT UNIQUE NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS entity_memory_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        memory_id TEXT NOT NULL,
        role TEXT DEFAULT 'mentioned',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entity_type);
      CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(canonical_name);
      CREATE INDEX IF NOT EXISTS idx_ea_alias ON entity_aliases(alias);
      CREATE INDEX IF NOT EXISTS idx_ea_entity ON entity_aliases(entity_id);
      CREATE INDEX IF NOT EXISTS idx_eml_entity ON entity_memory_links(entity_id);
      CREATE INDEX IF NOT EXISTS idx_eml_memory ON entity_memory_links(memory_id);
    `);

    // Entity relationships table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entity_relationships (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_entity_id INTEGER REFERENCES entities(id),
        target_entity_id INTEGER REFERENCES entities(id),
        relationship_type TEXT NOT NULL DEFAULT 'co_occurrence',
        strength INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(source_entity_id, target_entity_id, relationship_type)
      );

      CREATE INDEX IF NOT EXISTS idx_er_source ON entity_relationships(source_entity_id);
      CREATE INDEX IF NOT EXISTS idx_er_target ON entity_relationships(target_entity_id);
    `);

    // Unique index for entity_memory_links (idempotent linking)
    try {
      this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_eml_unique ON entity_memory_links(entity_id, memory_id, role)`);
    } catch (e) {
      if (!e.message.includes('already exists')) {
        console.warn('[sqlite] idx_eml_unique creation failed:', e.message);
      }
    }

    console.log(`[sqlite] Database ready at ${this.dbPath}`);
  }

  createEvent(data) {
    const stmt = this.db.prepare(`
      INSERT INTO events (content, type, source_agent, client_id, category, importance, content_hash, created_at)
      VALUES (@content, @type, @source_agent, @client_id, @category, @importance, @content_hash, @created_at)
    `);
    const result = stmt.run({
      content: data.content,
      type: data.type || 'event',
      source_agent: data.source_agent || null,
      client_id: data.client_id || 'global',
      category: data.category || 'episodic',
      importance: data.importance || 'medium',
      content_hash: data.content_hash || null,
      created_at: data.created_at || new Date().toISOString(),
    });
    return { id: result.lastInsertRowid };
  }

  listEvents(filters = {}) {
    let sql = 'SELECT * FROM events WHERE 1=1';
    const params = {};

    if (filters.source_agent) { sql += ' AND source_agent = @source_agent'; params.source_agent = filters.source_agent; }
    if (filters.category) { sql += ' AND category = @category'; params.category = filters.category; }
    if (filters.client_id) { sql += ' AND client_id = @client_id'; params.client_id = filters.client_id; }
    if (filters.since) { sql += ' AND created_at >= @since'; params.since = filters.since; }

    sql += ' ORDER BY created_at DESC LIMIT 50';
    const results = this.db.prepare(sql).all(params);
    return { results };
  }

  upsertFact(data) {
    const now = new Date().toISOString();
    const existing = this.db.prepare('SELECT id FROM facts WHERE key = @key').get({ key: data.key });

    if (existing) {
      this.db.prepare(`
        UPDATE facts SET value = @value, content = @content, source_agent = @source_agent,
        client_id = @client_id, category = @category, importance = @importance,
        content_hash = @content_hash, updated_at = @updated_at WHERE key = @key
      `).run({
        key: data.key,
        value: data.value || data.content,
        content: data.content,
        source_agent: data.source_agent || null,
        client_id: data.client_id || 'global',
        category: data.category || 'semantic',
        importance: data.importance || 'medium',
        content_hash: data.content_hash || null,
        updated_at: now,
      });
      return { id: existing.id, updated: true };
    }

    const result = this.db.prepare(`
      INSERT INTO facts (key, value, content, source_agent, client_id, category, importance, content_hash, created_at, updated_at)
      VALUES (@key, @value, @content, @source_agent, @client_id, @category, @importance, @content_hash, @created_at, @updated_at)
    `).run({
      key: data.key,
      value: data.value || data.content,
      content: data.content,
      source_agent: data.source_agent || null,
      client_id: data.client_id || 'global',
      category: data.category || 'semantic',
      importance: data.importance || 'medium',
      content_hash: data.content_hash || null,
      created_at: data.created_at || now,
      updated_at: now,
    });
    return { id: result.lastInsertRowid, created: true };
  }

  listFacts(filters = {}) {
    let sql = 'SELECT * FROM facts WHERE 1=1';
    const params = {};

    if (filters.source_agent) { sql += ' AND source_agent = @source_agent'; params.source_agent = filters.source_agent; }
    if (filters.category) { sql += ' AND category = @category'; params.category = filters.category; }
    if (filters.client_id) { sql += ' AND client_id = @client_id'; params.client_id = filters.client_id; }
    if (filters.key) { sql += ' AND key LIKE @key'; params.key = `%${filters.key}%`; }

    sql += ' ORDER BY updated_at DESC LIMIT 50';
    const results = this.db.prepare(sql).all(params);
    return { results };
  }

  upsertStatus(data) {
    const now = new Date().toISOString();
    const existing = this.db.prepare('SELECT id FROM statuses WHERE subject = @subject').get({ subject: data.subject });

    if (existing) {
      this.db.prepare(`
        UPDATE statuses SET status = @status, source_agent = @source_agent,
        client_id = @client_id, category = @category, importance = @importance,
        content_hash = @content_hash, updated_at = @updated_at WHERE subject = @subject
      `).run({
        subject: data.subject,
        status: data.status,
        source_agent: data.source_agent || null,
        client_id: data.client_id || 'global',
        category: data.category || 'episodic',
        importance: data.importance || 'medium',
        content_hash: data.content_hash || null,
        updated_at: now,
      });
      return { id: existing.id, updated: true };
    }

    const result = this.db.prepare(`
      INSERT INTO statuses (subject, status, source_agent, client_id, category, importance, content_hash, created_at, updated_at)
      VALUES (@subject, @status, @source_agent, @client_id, @category, @importance, @content_hash, @created_at, @updated_at)
    `).run({
      subject: data.subject,
      status: data.status,
      source_agent: data.source_agent || null,
      client_id: data.client_id || 'global',
      category: data.category || 'episodic',
      importance: data.importance || 'medium',
      content_hash: data.content_hash || null,
      created_at: data.created_at || now,
      updated_at: now,
    });
    return { id: result.lastInsertRowid, created: true };
  }

  listStatuses(filters = {}) {
    let sql = 'SELECT * FROM statuses WHERE 1=1';
    const params = {};

    if (filters.source_agent) { sql += ' AND source_agent = @source_agent'; params.source_agent = filters.source_agent; }
    if (filters.category) { sql += ' AND category = @category'; params.category = filters.category; }
    if (filters.subject) { sql += ' AND subject LIKE @subject'; params.subject = `%${filters.subject}%`; }

    sql += ' ORDER BY updated_at DESC LIMIT 50';
    const results = this.db.prepare(sql).all(params);
    return { results };
  }

  // --- Entity methods ---

  createEntity(data) {
    const now = new Date().toISOString();
    const existing = this.db.prepare('SELECT * FROM entities WHERE canonical_name = @name').get({ name: data.canonical_name });
    if (existing) {
      this.db.prepare('UPDATE entities SET mention_count = mention_count + 1, last_seen = @now WHERE id = @id').run({ now, id: existing.id });
      return { id: existing.id, created: false };
    }
    const result = this.db.prepare(
      'INSERT INTO entities (canonical_name, entity_type, first_seen, last_seen, mention_count) VALUES (@canonical_name, @entity_type, @first_seen, @last_seen, 1)'
    ).run({
      canonical_name: data.canonical_name,
      entity_type: data.entity_type || 'system',
      first_seen: data.first_seen || now,
      last_seen: data.last_seen || now,
    });
    const entityId = result.lastInsertRowid;
    // Auto-create alias for canonical name
    try {
      this.db.prepare('INSERT INTO entity_aliases (entity_id, alias, created_at) VALUES (@entity_id, @alias, @created_at)').run({
        entity_id: entityId, alias: data.canonical_name.toLowerCase(), created_at: now,
      });
    } catch (e) {
      if (!e.message.includes('UNIQUE constraint')) {
        console.warn('[sqlite] Alias creation failed for entity', entityId, ':', e.message);
      }
    }
    return { id: entityId, created: true };
  }

  findEntity(name) {
    const lower = name.toLowerCase();
    // Check alias table first
    const alias = this.db.prepare(
      'SELECT e.* FROM entity_aliases ea JOIN entities e ON e.id = ea.entity_id WHERE ea.alias = @alias'
    ).get({ alias: lower });
    const entity = alias || this.db.prepare('SELECT * FROM entities WHERE LOWER(canonical_name) = @name').get({ name: lower });
    if (!entity) return null;
    // Attach aliases
    const aliases = this.db.prepare('SELECT alias FROM entity_aliases WHERE entity_id = @id').all({ id: entity.id });
    entity.aliases = aliases.map(a => a.alias);
    return entity;
  }

  linkEntityToMemory(entityId, memoryId, role = 'mentioned') {
    const now = new Date().toISOString();
    try {
      this.db.prepare(
        'INSERT INTO entity_memory_links (entity_id, memory_id, role, created_at) VALUES (@entity_id, @memory_id, @role, @created_at)'
      ).run({ entity_id: entityId, memory_id: memoryId, role, created_at: now });
      return { linked: true };
    } catch (e) {
      if (e.message.includes('UNIQUE constraint')) {
        return { linked: false, duplicate: true };
      }
      console.warn('[sqlite] linkEntityToMemory failed:', e.message);
      return { linked: false, error: e.message };
    }
  }

  listEntities(filters = {}) {
    let sql = 'SELECT e.*, GROUP_CONCAT(ea.alias) as aliases FROM entities e LEFT JOIN entity_aliases ea ON ea.entity_id = e.id WHERE 1=1';
    const params = {};
    if (filters.entity_type) { sql += ' AND e.entity_type = @entity_type'; params.entity_type = filters.entity_type; }
    sql += ' GROUP BY e.id ORDER BY e.mention_count DESC';
    if (filters.limit) { sql += ' LIMIT @limit'; params.limit = parseInt(filters.limit) || 50; }
    else { sql += ' LIMIT 50'; }
    if (filters.offset) { sql += ' OFFSET @offset'; params.offset = parseInt(filters.offset) || 0; }
    const results = this.db.prepare(sql).all(params).map(r => ({
      ...r, aliases: r.aliases ? r.aliases.split(',') : [],
    }));
    return { results };
  }

  getEntityMemories(entityId, limit = 20) {
    const links = this.db.prepare(
      'SELECT memory_id, role, created_at FROM entity_memory_links WHERE entity_id = @entity_id ORDER BY created_at DESC LIMIT @limit'
    ).all({ entity_id: entityId, limit });
    return { results: links };
  }

  upsertAlias(entityId, alias) {
    const now = new Date().toISOString();
    try {
      this.db.prepare('INSERT INTO entity_aliases (entity_id, alias, created_at) VALUES (@entity_id, @alias, @created_at)')
        .run({ entity_id: entityId, alias: alias.toLowerCase(), created_at: now });
      return { created: true };
    } catch (e) {
      if (e.message.includes('UNIQUE constraint')) {
        return { created: false, duplicate: true };
      }
      console.warn('[sqlite] upsertAlias failed for entity', entityId, ':', e.message);
      return { created: false, error: e.message };
    }
  }

  loadAllAliases() {
    return this.db.prepare(
      'SELECT ea.alias, ea.entity_id, e.canonical_name, e.entity_type FROM entity_aliases ea JOIN entities e ON e.id = ea.entity_id'
    ).all();
  }

  getEntityStats() {
    const total = this.db.prepare('SELECT COUNT(*) as count FROM entities').get().count;
    const byType = this.db.prepare('SELECT entity_type, COUNT(*) as count FROM entities GROUP BY entity_type').all();
    const topMentioned = this.db.prepare('SELECT canonical_name, entity_type, mention_count FROM entities ORDER BY mention_count DESC LIMIT 10').all();
    return { total, by_type: Object.fromEntries(byType.map(r => [r.entity_type, r.count])), top_mentioned: topMentioned };
  }

  // --- Entity relationship methods ---

  createRelationship(sourceId, targetId, type = 'co_occurrence') {
    const now = new Date().toISOString();
    const existing = this.db.prepare(
      'SELECT id, strength FROM entity_relationships WHERE source_entity_id = @source AND target_entity_id = @target AND relationship_type = @type'
    ).get({ source: sourceId, target: targetId, type });

    if (existing) {
      this.db.prepare(
        'UPDATE entity_relationships SET strength = strength + 1, updated_at = @now WHERE id = @id'
      ).run({ now, id: existing.id });
      return { id: existing.id, strength: existing.strength + 1 };
    }

    const result = this.db.prepare(
      'INSERT INTO entity_relationships (source_entity_id, target_entity_id, relationship_type, strength, created_at, updated_at) VALUES (@source, @target, @type, 1, @now, @now)'
    ).run({ source: sourceId, target: targetId, type, now });
    return { id: result.lastInsertRowid, strength: 1 };
  }

  getRelationships(entityId, minStrength = 1) {
    const results = this.db.prepare(
      `SELECT
         CASE WHEN er.source_entity_id = @entityId THEN e2.id ELSE e1.id END as entity_id,
         CASE WHEN er.source_entity_id = @entityId THEN e2.canonical_name ELSE e1.canonical_name END as entity_name,
         CASE WHEN er.source_entity_id = @entityId THEN e2.entity_type ELSE e1.entity_type END as entity_type,
         er.relationship_type,
         er.strength
       FROM entity_relationships er
       JOIN entities e1 ON e1.id = er.source_entity_id
       JOIN entities e2 ON e2.id = er.target_entity_id
       WHERE (er.source_entity_id = @entityId OR er.target_entity_id = @entityId)
         AND er.strength >= @minStrength
       ORDER BY er.strength DESC`
    ).all({ entityId, minStrength });

    return results.map(r => ({
      entity: { id: r.entity_id, name: r.entity_name, type: r.entity_type },
      relationship_type: r.relationship_type,
      strength: r.strength,
    }));
  }

  listRelationships(filters = {}) {
    let sql = `SELECT
         e1.id as source_id, e1.canonical_name as source_name, e1.entity_type as source_type,
         e2.id as target_id, e2.canonical_name as target_name, e2.entity_type as target_type,
         er.relationship_type, er.strength
       FROM entity_relationships er
       JOIN entities e1 ON e1.id = er.source_entity_id
       JOIN entities e2 ON e2.id = er.target_entity_id
       WHERE 1=1`;
    const params = {};

    if (filters.type) { sql += ' AND er.relationship_type = @type'; params.type = filters.type; }
    if (filters.min_strength) { sql += ' AND er.strength >= @min_strength'; params.min_strength = parseInt(filters.min_strength); }

    sql += ' ORDER BY er.strength DESC LIMIT 100';
    const results = this.db.prepare(sql).all(params);
    return results.map(r => ({
      source: { id: r.source_id, name: r.source_name, type: r.source_type },
      target: { id: r.target_id, name: r.target_name, type: r.target_type },
      relationship_type: r.relationship_type,
      strength: r.strength,
    }));
  }
}
