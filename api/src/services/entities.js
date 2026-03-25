// Entity extraction and linking — fast-path (no LLM calls)
// Extracts entities from memory content at write time using regex + alias cache
// v2.1 — pattern-based filtering replaces blocklist, smarter type defaults

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
};

const DOMAIN_REGEX = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|ca|org|net|io|dev|app|co|fr|uk|de|ai)\b/gi;
const QUOTED_NAME_REGEX = /[""\u201C\u201D`]([^""\u201C\u201D`]{3,60})[""\u201C\u201D`]/g;
const CAPITALIZED_PHRASE_REGEX = /\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})+)\b/g;

// Known system/product names — maps to correct entity type
const KNOWN_SYSTEMS = {
  'agency system': 'system', 'mission center': 'system',
  'shared brain': 'system', 'antigravity studio': 'system',
  'prism hub': 'system', 'neo studio': 'system',
  'site settings': 'system',
  'design director': 'system', 'done gate': 'system',
  'points tracker': 'system', 'knowledge base': 'system',
  'google fonts': 'technology', 'google maps': 'technology',
  'google ads': 'technology', 'google search': 'technology',
  'google analytics': 'technology', 'google tag manager': 'technology',
  'brand voice': 'system', 'design system': 'system',
  'prospect pipeline': 'system', 'prospect demos': 'system',
  'agency brain': 'system', 'dispatch protocol': 'system',
  'neo reports': 'system', 'quebec city': 'domain',
  'search console': 'technology', 'claude code': 'agent',
  'quick wins': 'system', 'search engine': 'technology',
  'tag manager': 'technology',
};

// Pattern-based filters — replaces SKIP_PHRASES blocklist
const ACTION_VERB_PREFIXES = new Set([
  'Fixed', 'Added', 'Updated', 'Removed', 'Switched', 'Converted',
  'Pulled', 'Pushed', 'Created', 'Deleted', 'Merged', 'Deployed',
  'Enhanced', 'Resolved', 'Approved', 'Redesigned', 'Renamed',
  'Installed', 'Configured', 'Migrated', 'Implemented', 'Refactored',
  'Infrastructure', 'Gathered', 'Mandatory', 'Curated', 'Replaced',
  'Built', 'Moved', 'Changed', 'Cleaned', 'Tested', 'Verified',
  'Confirmed', 'Completed', 'Started', 'Finished', 'Enabled', 'Disabled',
]);

const NOISE_WORDS = new Set([
  'The', 'This', 'That', 'These', 'Those', 'What', 'When', 'Where',
  'How', 'Why', 'Which', 'Each', 'Every', 'Some', 'Any', 'All',
  'New', 'Old', 'Set', 'Get', 'Run', 'Use', 'Has', 'Was',
  'Not', 'But', 'And', 'For', 'With', 'From', 'Into', 'Over',
  'Also', 'Just', 'Only', 'Still', 'Now', 'Then', 'Here', 'There',
]);

const TIME_WORDS = new Set([
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
  'January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December',
]);

const CSS_LIKE_WORDS = new Set([
  'Foreground', 'Background', 'Border', 'Shadow', 'Radius', 'Margin',
  'Padding', 'Width', 'Height', 'Color', 'Font', 'Weight', 'Size',
  'Opacity', 'Gradient', 'Threshold', 'Grade', 'Index', 'Offset',
  'Scale', 'Transform', 'Transition', 'Animation', 'Display',
  'Overflow', 'Position', 'Cursor', 'Outline', 'Spacing', 'Align',
]);

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

/**
 * Returns true if the capitalized phrase is junk and should be skipped.
 */
function isJunkPhrase(phrase) {
  const words = phrase.split(/\s+/);

  if (words.length < 2) return true;
  if (words.some(w => TIME_WORDS.has(w))) return true;
  if (NOISE_WORDS.has(words[0])) return true;
  if (ACTION_VERB_PREFIXES.has(words[0])) return true;

  // Skip CSS-like patterns
  if (/[:{};]/.test(phrase)) return true;
  if (words.some(w => CSS_LIKE_WORDS.has(w))) return true;

  // Skip file paths, HTML
  if (/[/\\~.<>]/.test(phrase)) return true;

  // Skip very short 2-word phrases where both words are <= 4 chars
  if (words.length === 2 && words.every(w => w.length <= 4)) return true;

  // Skip 2-word phrases where second word is a generic noun
  const GENERIC_TAIL = new Set([
    'Node', 'Fix', 'Issue', 'Error', 'Check', 'Test', 'Pass', 'Fail',
    'Mode', 'Type', 'Data', 'Item', 'List', 'View', 'Page', 'File',
    'Phase', 'Step', 'Task', 'Flow', 'Loop', 'Gate', 'Rule', 'Note',
    'Model', 'Level', 'Class', 'Style', 'State', 'Value', 'Field',
    'Port', 'Path', 'Host', 'Name', 'Code', 'Part', 'Line', 'Text',
    'Info', 'Link', 'Flag', 'Sign', 'Icon', 'Form', 'Case', 'Tier',
    'Plan', 'Rate', 'Tool', 'Work', 'Time', 'Size', 'Side', 'Body',
    'Base', 'Card', 'Grid', 'Slot', 'Band', 'Ring', 'Call', 'Send',
    'Load', 'Save', 'Menu', 'Hash', 'Sort', 'Swap', 'Pull', 'Push',
  ]);
  if (words.length === 2 && GENERIC_TAIL.has(words[1])) return true;

  // Skip 2-word phrases where first word is a generic adjective
  const GENERIC_HEAD = new Set([
    'New', 'Old', 'Big', 'Raw', 'Hot', 'Top', 'Low', 'Bad', 'Red',
    'Full', 'Next', 'Last', 'Main', 'Real', 'Live', 'Dead', 'Deep',
    'High', 'Long', 'Dark', 'Fast', 'Slow', 'Hard', 'Soft', 'Good',
    'True', 'Auto', 'Open', 'Free', 'Pure', 'Safe', 'Dual', 'Half',
    'Audited', 'Exposed', 'Persistent', 'Electric', 'Curated',
  ]);
  if (words.length === 2 && GENERIC_HEAD.has(words[0])) return true;

  // Skip phrases that are too long (5+ words are almost always prose)
  if (words.length >= 5) return true;

  // Skip phrases containing lowercase connecting words (likely prose)
  if (words.some(w => /^(and|or|the|a|an|of|in|on|at|to|for|with|by|from|is|are|was|not|but)$/i.test(w) && w[0] === w[0].toLowerCase())) return true;

  return false;
}

/**
 * Returns true if a quoted name is junk.
 */
function isJunkQuotedName(name) {
  if (/^[a-z-]+:\s/.test(name)) return true;    // CSS property
  if (/^[:.]/.test(name)) return true;           // :root, .class
  if (/^--/.test(name)) return true;             // CSS variable
  if (/^</.test(name)) return true;              // HTML tag
  if (/[/\\%~]/.test(name)) return true;         // file path or env var
  if (/[{}();=\[\]|&$@]/.test(name)) return true; // code / shell
  if (/^#[0-9a-fA-F]+$/.test(name)) return true; // hex color
  if (/^[\d\s.,!?-]+$/.test(name)) return true;  // numbers/punctuation
  if (name.length < 3) return true;

  // Hyphenated lowercase — CSS properties, HTML data attrs, CLI flags
  if (/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(name)) return true;

  // camelCase or snake_case identifiers
  if (/^[a-z][a-zA-Z0-9]*[A-Z]/.test(name)) return true;   // camelCase
  if (/^[a-z_]+_[a-z_]+$/.test(name)) return true;          // snake_case

  // Shell commands (starts with common commands)
  if (/^(docker|git|npm|ssh|curl|cd|ls|rm|cp|mv|mkdir|chmod|sudo|pip|node|bun)\s/i.test(name)) return true;

  // Error codes, log messages
  if (/^(ERROR|WARN|INFO|DEBUG|FAIL|OK|TRUE|FALSE)/.test(name)) return true;
  if (/^(Prompt|Failed|Ignored|Should)\s/i.test(name)) return true;

  // Very short single words (not in alias cache — checked later)
  if (!/\s/.test(name) && name.length < 5) return true;

  // Sentence fragments — contains lowercase words that indicate prose, not names
  const words = name.split(/\s+/);
  const PROSE_WORDS = new Set([
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare',
    'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as',
    'into', 'through', 'during', 'before', 'after', 'above', 'below',
    'between', 'under', 'not', 'no', 'nor', 'but', 'or', 'and', 'if',
    'then', 'than', 'so', 'that', 'this', 'these', 'those', 'it', 'its',
    'my', 'your', 'his', 'her', 'our', 'their', 'what', 'which', 'who',
    'whom', 'how', 'when', 'where', 'why', 'all', 'each', 'every',
    // French prose words
    'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'au', 'aux',
    'et', 'ou', 'en', 'est', 'sont', 'par', 'pour', 'sur', 'avec',
    'dans', 'sans', 'pas', 'plus', 'très', 'aussi', 'bien', 'tout',
  ]);
  // If more than 40% of words are prose words, it's a sentence fragment
  const proseCount = words.filter(w => PROSE_WORDS.has(w.toLowerCase())).length;
  if (words.length >= 3 && proseCount / words.length > 0.4) return true;

  // Single lowercase word (not a known entity)
  if (words.length === 1 && /^[a-z]/.test(name)) return true;

  return false;
}

export function extractEntities(text, clientId, sourceAgent) {
  const entities = [];
  const seen = new Set();

  function add(name, type, role) {
    const key = `${name.toLowerCase()}::${role}`;
    if (seen.has(key)) return;
    seen.add(key);

    const cached = aliasCache.get(name.toLowerCase());
    if (cached) {
      entities.push({ name: cached.canonicalName, type: cached.entityType, role, entityId: cached.entityId });
      return;
    }
    entities.push({ name, type, role, entityId: null });
  }

  // 1. client_id
  if (clientId && clientId !== 'global') {
    add(clientId, 'client', 'about');
  }

  // 2. source_agent
  if (sourceAgent) {
    add(sourceAgent, 'agent', 'source');
  }

  // 3. Domain names
  const domains = text.match(DOMAIN_REGEX) || [];
  for (const domain of domains) {
    add(domain.toLowerCase(), 'domain', 'mentioned');
  }

  // 4. Known technology names
  const lowerText = ` ${text.toLowerCase()} `;
  for (const [keyword, canonical] of Object.entries(KNOWN_TECH)) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'i');
    if (re.test(lowerText)) {
      add(canonical, 'technology', 'mentioned');
    }
  }

  // 4b. Known system/product names — with correct type from dict
  for (const [keyword, type] of Object.entries(KNOWN_SYSTEMS)) {
    if (lowerText.includes(keyword)) {
      const canonical = keyword.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
      add(canonical, type, 'mentioned');
    }
  }

  // 5. Quoted/backtick names
  let match;
  QUOTED_NAME_REGEX.lastIndex = 0;
  while ((match = QUOTED_NAME_REGEX.exec(text)) !== null) {
    const name = match[1].trim();
    if (isJunkQuotedName(name)) continue;
    const cached = aliasCache.get(name.toLowerCase());
    add(cached?.canonicalName || name, cached?.entityType || 'workflow', 'mentioned');
  }

  // 6. Capitalized multi-word phrases
  CAPITALIZED_PHRASE_REGEX.lastIndex = 0;
  while ((match = CAPITALIZED_PHRASE_REGEX.exec(text)) !== null) {
    const phrase = match[1].trim();
    if (isJunkPhrase(phrase)) continue;
    if (KNOWN_TECH[phrase.toLowerCase()]) continue;
    if (KNOWN_SYSTEMS[phrase.toLowerCase()]) continue;
    const cached = aliasCache.get(phrase.toLowerCase());
    // Default to "system" — most capitalized phrases in agent logs are
    // system names, features, or concepts, not people
    add(cached?.canonicalName || phrase, cached?.entityType || 'system', 'mentioned');
  }

  return entities;
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
