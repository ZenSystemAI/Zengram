// Entity extraction and linking — fast-path (no LLM calls)
// v3.0 — Confidence-gated extraction. Removed CAPITALIZED_PHRASE_REGEX (60% FP rate).
// Quoted names only match alias cache. Entity staging via confidence field.

const KNOWN_TECH = {
  'postgres': 'PostgreSQL', 'postgresql': 'PostgreSQL', 'psql': 'PostgreSQL',
  'mysql': 'MySQL', 'mariadb': 'MariaDB',
  'redis': 'Redis', 'docker': 'Docker', 'kubernetes': 'Kubernetes', 'k8s': 'Kubernetes',
  'n8n': 'n8n', 'qdrant': 'Qdrant', 'sqlite': 'SQLite',
  'express': 'Express.js', 'nginx': 'Nginx', 'apache': 'Apache', 'caddy': 'Caddy',
  'nodejs': 'Node.js', 'node.js': 'Node.js',
  'react': 'React', 'nextjs': 'Next.js', 'next.js': 'Next.js', 'vue': 'Vue.js', 'nuxt': 'Nuxt',
  'python': 'Python', 'javascript': 'JavaScript', 'typescript': 'TypeScript',
  'git': 'Git', 'github': 'GitHub', 'gitlab': 'GitLab',
  'baserow': 'Baserow', 'hostinger': 'Hostinger', 'vercel': 'Vercel', 'netlify': 'Netlify',
  'claude': 'Claude', 'chatgpt': 'ChatGPT', 'openai': 'OpenAI', 'anthropic': 'Anthropic',
  'gemini': 'Gemini', 'ollama': 'Ollama', 'openclaw': 'OpenClaw',
  'google': 'Google', 'cloudflare': 'Cloudflare', 'aws': 'AWS', 'azure': 'Azure',
  'shopify': 'Shopify', 'woocommerce': 'WooCommerce', 'wordpress': 'WordPress', 'wp': 'WordPress',
  'ahrefs': 'Ahrefs', 'semrush': 'SEMrush', 'dataforseo': 'DataForSEO',
  'stripe': 'Stripe', 'twilio': 'Twilio', 'sendgrid': 'SendGrid',
  'canva': 'Canva', 'figma': 'Figma', 'slack': 'Slack',
  'mongodb': 'MongoDB', 'neo4j': 'Neo4j', 'elasticsearch': 'Elasticsearch',
  'graphql': 'GraphQL',
  'linux': 'Linux', 'ubuntu': 'Ubuntu', 'debian': 'Debian',
  'polylang': 'Polylang', 'yoast': 'Yoast', 'acf': 'ACF',
  'browserless': 'Browserless', 'firecrawl': 'Firecrawl',
  'langchain': 'LangChain', 'lighthouse': 'Lighthouse',
  'codex': 'Codex', 'plex': 'Plex', 'samba': 'Samba',
};

// Pre-compiled regex patterns for KNOWN_TECH
const KNOWN_TECH_PATTERNS = new Map(
  Object.entries(KNOWN_TECH).map(([keyword, canonical]) => {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return [keyword, { pattern: new RegExp(`\\b${escaped}\\b`, 'i'), label: canonical }];
  })
);

const DOMAIN_REGEX = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|ca|org|net|io|dev|app|co|fr|uk|de|ai)\b/gi;
const QUOTED_NAME_REGEX = /[""\u201C\u201D`]([^""\u201C\u201D`]{3,60})[""\u201C\u201D`]/g;
// REMOVED: CAPITALIZED_PHRASE_REGEX — 60% false positive rate, primary source of entity drift

// Known system/product names — maps to correct entity type
const KNOWN_SYSTEMS = {
  'agency system': 'system', 'mission center': 'system',
  'shared brain': 'system', 'zengram': 'system',
  'antigravity studio': 'system',
  'prism hub': 'system', 'neo studio': 'system',
  'site settings': 'system',
  'design director': 'system', 'done gate': 'system',
  'points tracker': 'system', 'knowledge base': 'system',
  'knowledge wiki': 'system',
  'google fonts': 'technology', 'google maps': 'technology',
  'google ads': 'technology', 'google search': 'technology',
  'google analytics': 'technology', 'google tag manager': 'technology',
  'brand voice': 'system', 'design system': 'system',
  'prospect pipeline': 'system', 'prospect demos': 'system',
  'agency brain': 'system', 'dispatch protocol': 'system',
  'neo reports': 'system', 'quebec city': 'domain',
  'search console': 'technology', 'claude code': 'agent',
  'tag manager': 'technology',
  'client pulse': 'system', 'tandem hub': 'system',
  'tandem prism': 'system', 'demo scorer': 'system',
  'zenprizm': 'system', 'zencrm': 'system', 'zenseo': 'system',
  'zenvox': 'system', 'zensms': 'system', 'zensign': 'system',
  'zenstudio': 'system', 'zenkit': 'system', 'zengate': 'system',
  'expert local': 'client', 'dermka clinik': 'client',
  'la canardiere': 'client', 'credit instant': 'client',
};

// In-memory alias cache
let aliasCache = new Map();

export function loadAliasCache(entries) {
  aliasCache = new Map();
  for (const [alias, canonical] of Object.entries(KNOWN_TECH)) {
    aliasCache.set(alias.toLowerCase(), {
      entityId: null,
      canonicalName: canonical,
      entityType: 'technology',
    });
  }
  for (const e of entries) {
    aliasCache.set(e.alias.toLowerCase(), {
      entityId: e.entity_id,
      canonicalName: e.canonical_name,
      entityType: e.entity_type,
    });
  }
  console.log(`[entities] Alias cache loaded: ${aliasCache.size} entries (${entries.length} from DB, ${Object.keys(KNOWN_TECH).length} built-in)`);
}

export function addToAliasCache(alias, entityId, canonicalName, entityType) {
  aliasCache.set(alias.toLowerCase(), { entityId, canonicalName, entityType });
}

// Confidence levels for entity extraction sources
const CONFIDENCE = {
  CLIENT_ID: 0.98,      // Explicit client_id field
  SOURCE_AGENT: 0.98,   // Explicit source_agent field
  KNOWN_TECH: 0.95,     // Dictionary match
  KNOWN_SYSTEM: 0.95,   // Dictionary match
  ALIAS_CACHE: 0.90,    // Known entity from DB
  DOMAIN_REGEX: 0.85,   // Domain name pattern
  QUOTED_CACHED: 0.85,  // Quoted text matching alias cache
};

// Minimum confidence to create an entity (below this, skip)
const MIN_CONFIDENCE = parseFloat(process.env.ENTITY_MIN_CONFIDENCE) || 0.80;

export function extractEntities(text, clientId, sourceAgent) {
  const entities = [];
  const seen = new Set();

  function add(name, type, role, confidence = 0.5) {
    // Confidence gate — skip low-confidence extractions
    if (confidence < MIN_CONFIDENCE) return;

    const key = `${name.toLowerCase()}::${role}`;
    if (seen.has(key)) return;
    seen.add(key);

    const cached = aliasCache.get(name.toLowerCase());
    if (cached) {
      entities.push({
        name: cached.canonicalName,
        type: cached.entityType,
        role,
        entityId: cached.entityId,
        confidence: Math.max(confidence, CONFIDENCE.ALIAS_CACHE),
      });
      return;
    }
    entities.push({ name, type, role, entityId: null, confidence });
  }

  // 1. client_id — highest confidence (explicit field)
  if (clientId && clientId !== 'global') {
    add(clientId, 'client', 'about', CONFIDENCE.CLIENT_ID);
  }

  // 2. source_agent — highest confidence (explicit field)
  if (sourceAgent) {
    add(sourceAgent, 'agent', 'source', CONFIDENCE.SOURCE_AGENT);
  }

  // 3. Domain names — high confidence (regex pattern is specific)
  const domains = text.match(DOMAIN_REGEX) || [];
  for (const domain of domains) {
    add(domain.toLowerCase(), 'domain', 'mentioned', CONFIDENCE.DOMAIN_REGEX);
  }

  // 4. Known technology names (pre-compiled regex patterns)
  const lowerText = ` ${text.toLowerCase()} `;
  for (const [, { pattern, label }] of KNOWN_TECH_PATTERNS) {
    if (pattern.test(lowerText)) {
      add(label, 'technology', 'mentioned', CONFIDENCE.KNOWN_TECH);
    }
  }

  // 4b. Known system/product names
  for (const [keyword, type] of Object.entries(KNOWN_SYSTEMS)) {
    if (lowerText.includes(keyword)) {
      const canonical = keyword.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
      add(canonical, type, 'mentioned', CONFIDENCE.KNOWN_SYSTEM);
    }
  }

  // 5. Quoted/backtick names — ONLY if they match an existing entity in alias cache
  // v3.0: No longer creates new entities from unknown quoted text (was primary junk source)
  let match;
  QUOTED_NAME_REGEX.lastIndex = 0;
  while ((match = QUOTED_NAME_REGEX.exec(text)) !== null) {
    const name = match[1].trim();
    const cached = aliasCache.get(name.toLowerCase());
    if (cached) {
      add(cached.canonicalName, cached.entityType, 'mentioned', CONFIDENCE.QUOTED_CACHED);
    }
    // If not in cache, skip — don't create from unknown quoted text
  }

  // REMOVED: Step 6 (Capitalized multi-word phrases)
  // This regex had ~60% false positive rate, extracting prose fragments,
  // n8n workflow node names, and English phrases as entities.
  // Novel entities are now discovered only through:
  // - KNOWN_TECH / KNOWN_SYSTEMS dictionaries (add new entries as needed)
  // - Explicit client_id / source_agent fields
  // - Domain name regex
  // - Alias cache matches (entities previously created by any path)

  return entities;
}

/**
 * Reclassify an entity's type in the structured store (Postgres or SQLite).
 */
export async function reclassifyEntity(entityName, newType, storeFns) {
  const { findEntity, _getStoreInstance } = storeFns;
  const entity = await findEntity(entityName);
  if (!entity) {
    return { updated: false, entity_id: null, memories_affected: 0, error: 'Entity not found' };
  }

  const store = _getStoreInstance();
  if (!store || (!store.db && !store.pool)) {
    return { updated: false, entity_id: entity.id, memories_affected: 0, error: 'No writable store' };
  }

  const oldType = entity.entity_type;
  let memoriesAffected = 0;

  if (store.pool) {
    // Postgres path
    await store.pool.query('UPDATE entities SET entity_type = $1 WHERE id = $2', [newType, entity.id]);
    const linkResult = await store.pool.query(
      'SELECT COUNT(*) as count FROM entity_memory_links WHERE entity_id = $1', [entity.id]
    );
    memoriesAffected = parseInt(linkResult.rows[0]?.count) || 0;
  } else if (store.db) {
    // SQLite path
    store.db.prepare('UPDATE entities SET entity_type = @newType WHERE id = @id').run({
      newType, id: entity.id,
    });
    const linkCount = store.db.prepare(
      'SELECT COUNT(*) as count FROM entity_memory_links WHERE entity_id = @id'
    ).get({ id: entity.id });
    memoriesAffected = linkCount?.count || 0;
  }

  // Update alias cache entry
  addToAliasCache(entityName, entity.id, entity.canonical_name, newType);

  return {
    updated: true,
    entity_id: entity.id,
    old_type: oldType,
    new_type: newType,
    memories_affected: memoriesAffected,
  };
}

export async function linkExtractedEntities(entities, memoryId, storeFns) {
  const { createEntity, findEntity, linkEntityToMemory, createRelationship } = storeFns;
  const resolvedIds = [];

  for (const ent of entities) {
    let entityId = ent.entityId;
    if (!entityId) {
      const found = await findEntity(ent.name);
      if (found) {
        entityId = found.id;
      } else {
        // Only create new entities if confidence is high enough
        if ((ent.confidence || 0) < MIN_CONFIDENCE) continue;
        const created = await createEntity({ canonical_name: ent.name, entity_type: ent.type });
        entityId = created.id;
        addToAliasCache(ent.name, entityId, ent.name, ent.type);
      }
    } else {
      await createEntity({ canonical_name: ent.name, entity_type: ent.type });
    }
    if (entityId) {
      await linkEntityToMemory(entityId, memoryId, ent.role);
      resolvedIds.push(entityId);
    }
  }

  if (createRelationship && resolvedIds.length > 1) {
    const uniqueIds = [...new Set(resolvedIds)];
    for (let i = 0; i < uniqueIds.length; i++) {
      for (let j = i + 1; j < uniqueIds.length; j++) {
        try {
          await createRelationship(uniqueIds[i], uniqueIds[j], 'co_occurrence');
        } catch (e) {}
      }
    }
  }
}
