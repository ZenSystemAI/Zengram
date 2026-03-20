// Entity extraction and linking — fast-path (no LLM calls)
// Extracts entities from memory content at write time using regex + alias cache

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
};

const DOMAIN_REGEX = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|ca|org|net|io|dev|app|co|fr|uk|de|ai)\b/gi;
const QUOTED_NAME_REGEX = /[""`]([^"""`]{3,60})[""`]/g;
const CAPITALIZED_PHRASE_REGEX = /\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})+)\b/g;

// Known system/product names — these are NOT people
const KNOWN_SYSTEMS = {
  'agency system': 'Agency System', 'mission center': 'Mission Center',
  'shared brain': 'Shared Brain', 'antigravity studio': 'Antigravity Studio',
  'prism hub': 'Prism Hub', 'neo studio': 'Neo Studio',
  'expert local': 'Expert Local', 'site settings': 'Site Settings',
  'design director': 'Design Director', 'done gate': 'Done Gate',
  'role cards': 'Role Cards', 'points tracker': 'Points Tracker',
  'google fonts': 'Google Fonts', 'google maps': 'Google Maps',
  'google ads': 'Google Ads', 'google search': 'Google Search',
  'brand voice': 'Brand Voice', 'design system': 'Design System',
};

const SKIP_PHRASES = new Set([
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
  'January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December',
  'Error Trigger', 'Code Node', 'HTTP Request', 'The Problem',
  'What Was', 'How To', 'Set Up', 'Get Started',
  // Common non-person phrases from session logs
  'Card Foreground', 'Muted Foreground', 'Data Volume Threshold',
  'Accessibility Grade', 'Quick Wins', 'Bug Fix', 'New Feature',
  'Weekly Family', 'Morning Newsletter', 'Agent Fleet',
  'Fixed Morpheus', 'Fixed Mission', 'Fixed Docker', 'Fixed Prism', 'Fixed Gemini',
  'Added Gemini', 'Uses Node', 'Skills Merge', 'Inter Tight',
  'Pulled Fireflies', 'Curated Unsplash', 'Runs Neo',
  'Redesigned Neo', 'Infrastructure Morpheus', 'Workspace Explorer',
  'Component Library', 'Converted Credit', 'Client Onboarding',
  'Search Engine', 'Application Password', 'Niche Family',
  'Implementation Notes', 'Master Boilerplate', 'Gathering Phase',
  'Mandatory Scraping', 'Image Pipeline', 'Linter Skill',
  'Approved Conversion', 'Demo Quality', 'Point System',
  'Enhanced Done', 'Art Director', 'Website Build',
]);

// In-memory alias cache: lowercase alias -> { entityId, canonicalName, entityType }
let aliasCache = new Map();

export function loadAliasCache(entries) {
  aliasCache = new Map();
  // Pre-seed with KNOWN_TECH so tech entities always resolve, even before first consolidation
  for (const [alias, canonical] of Object.entries(KNOWN_TECH)) {
    aliasCache.set(alias.toLowerCase(), {
      entityId: null, // no DB id yet — extraction will still match by canonical name
      canonicalName: canonical,
      entityType: 'technology',
    });
  }
  // Overlay DB aliases (these take precedence — they have real entity IDs)
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

export function extractEntities(text, clientId, sourceAgent) {
  const entities = [];
  const seen = new Set();

  function add(name, type, role) {
    const key = `${name.toLowerCase()}::${role}`;
    if (seen.has(key)) return;
    seen.add(key);

    // Check alias cache for canonical resolution
    const cached = aliasCache.get(name.toLowerCase());
    if (cached) {
      entities.push({ name: cached.canonicalName, type: cached.entityType, role, entityId: cached.entityId });
      return;
    }
    entities.push({ name, type, role, entityId: null });
  }

  // 1. client_id is always an entity
  if (clientId && clientId !== 'global') {
    add(clientId, 'client', 'about');
  }

  // 2. source_agent is always an entity
  if (sourceAgent) {
    add(sourceAgent, 'agent', 'source');
  }

  // 3. Domain names
  const domains = text.match(DOMAIN_REGEX) || [];
  for (const domain of domains) {
    add(domain.toLowerCase(), 'domain', 'mentioned');
  }

  // 4. Known technology names (word-boundary)
  const lowerText = ` ${text.toLowerCase()} `;
  for (const [keyword, canonical] of Object.entries(KNOWN_TECH)) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'i');
    if (re.test(lowerText)) {
      add(canonical, 'technology', 'mentioned');
    }
  }

  // 4b. Known system/product names
  for (const [keyword, canonical] of Object.entries(KNOWN_SYSTEMS)) {
    if (lowerText.includes(keyword)) {
      add(canonical, 'system', 'mentioned');
    }
  }

  // 5. Quoted/backtick names (likely workflow or specific names)
  let match;
  QUOTED_NAME_REGEX.lastIndex = 0;
  while ((match = QUOTED_NAME_REGEX.exec(text)) !== null) {
    const name = match[1].trim();
    if (name.length >= 3 && name.length <= 60) {
      const cached = aliasCache.get(name.toLowerCase());
      add(cached?.canonicalName || name, cached?.entityType || 'workflow', 'mentioned');
    }
  }

  // 6. Capitalized multi-word phrases (proper nouns)
  CAPITALIZED_PHRASE_REGEX.lastIndex = 0;
  while ((match = CAPITALIZED_PHRASE_REGEX.exec(text)) !== null) {
    const phrase = match[1].trim();
    if (SKIP_PHRASES.has(phrase)) continue;
    // Skip if already caught by tech or systems dictionaries
    if (KNOWN_TECH[phrase.toLowerCase()]) continue;
    if (KNOWN_SYSTEMS[phrase.toLowerCase()]) continue;
    const cached = aliasCache.get(phrase.toLowerCase());
    // Default to "workflow" not "person" — most capitalized phrases in agent logs are
    // system names, features, or concepts, not actual humans
    add(cached?.canonicalName || phrase, cached?.entityType || 'workflow', 'mentioned');
  }

  return entities;
}

/**
 * Link extracted entities to a memory in the structured store.
 * Finds or creates each entity, then creates the memory link.
 * Requires: createEntity, findEntity, linkEntityToMemory from stores/interface.js
 */
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
        const created = await createEntity({ canonical_name: ent.name, entity_type: ent.type });
        entityId = created.id;
        addToAliasCache(ent.name, entityId, ent.name, ent.type);
      }
    } else {
      // Bump mention count for known entity
      await createEntity({ canonical_name: ent.name, entity_type: ent.type });
    }
    if (entityId) {
      await linkEntityToMemory(entityId, memoryId, ent.role);
      resolvedIds.push(entityId);
    }
  }

  // Track co-occurrence: create relationships between all entity pairs in this memory
  if (createRelationship && resolvedIds.length > 1) {
    const uniqueIds = [...new Set(resolvedIds)];
    for (let i = 0; i < uniqueIds.length; i++) {
      for (let j = i + 1; j < uniqueIds.length; j++) {
        try {
          await createRelationship(uniqueIds[i], uniqueIds[j], 'co_occurrence');
        } catch (e) {
          // Non-blocking — don't fail entity linking over relationship tracking
        }
      }
    }
  }
}
