// Entity type reclassification heuristics
// Pattern matching to detect likely misclassified entities

const KNOWN_TECH_NAMES = new Set([
  'react', 'docker', 'node', 'node.js', 'nodejs', 'python', 'javascript', 'typescript',
  'qdrant', 'n8n', 'postgres', 'postgresql', 'mysql', 'mariadb', 'redis',
  'kubernetes', 'k8s', 'sqlite', 'express', 'express.js', 'nginx', 'apache', 'caddy',
  'next.js', 'nextjs', 'vue', 'vue.js', 'nuxt', 'angular', 'svelte',
  'git', 'github', 'gitlab', 'baserow', 'hostinger', 'vercel', 'netlify',
  'claude', 'chatgpt', 'openai', 'anthropic', 'gemini', 'ollama', 'openclaw',
  'google', 'cloudflare', 'aws', 'azure', 'gcp',
  'shopify', 'woocommerce', 'wordpress', 'wp',
  'ahrefs', 'semrush', 'dataforseo',
  'stripe', 'twilio', 'sendgrid',
  'canva', 'figma', 'slack',
  'mongodb', 'neo4j', 'elasticsearch', 'graphql',
  'linux', 'ubuntu', 'debian',
  'polylang', 'yoast', 'acf',
  'browserless', 'firecrawl', 'langchain', 'lighthouse',
  'tailwind', 'tailwindcss', 'bootstrap', 'sass', 'less',
  'webpack', 'vite', 'rollup', 'esbuild', 'bun', 'deno',
  'jest', 'mocha', 'vitest', 'playwright', 'cypress', 'puppeteer',
  'supabase', 'firebase', 'prisma', 'drizzle',
  'google fonts', 'google maps', 'google ads', 'google search',
  'google analytics', 'google tag manager', 'search console',
  'tag manager',
]);

const AGENT_PATTERNS = [
  /^claude[- ]code$/i,
  /^claude[- ]?agent$/i,
  /^n8n$/i,
  /^morpheus$/i,
  /^neo$/i,
  /^neo[- ]?2$/i,
  /^gpt[- ]?4/i,
  /^copilot$/i,
  /^cursor$/i,
  /^agent[- ]/i,
  /^mcp[- ]/i,
];

const DOMAIN_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|ca|org|net|io|dev|app|co|fr|uk|de|ai)$/i;

const PERSON_NAME_PATTERN = /^[A-Z][a-z]{1,20}\s+[A-Z][a-z]{1,20}(?:\s+[A-Z][a-z]{1,20})?$/;

/**
 * Detect what type an entity likely should be, based on heuristic patterns.
 * @param {string} name - Entity canonical name
 * @param {string} currentType - The type currently assigned
 * @returns {{ suggestedType: string|null, confidence: number, reason: string }}
 */
export function detectEntityType(name, currentType) {
  const lower = name.toLowerCase();

  // 1. Known tech names
  if (KNOWN_TECH_NAMES.has(lower)) {
    if (currentType !== 'technology') {
      return { suggestedType: 'technology', confidence: 0.95, reason: `"${name}" is a known technology name` };
    }
    return { suggestedType: null, confidence: 0, reason: 'already correct' };
  }

  // 2. Domain patterns (*.com, *.ca, etc.)
  if (DOMAIN_PATTERN.test(name)) {
    if (currentType !== 'domain') {
      return { suggestedType: 'domain', confidence: 0.95, reason: `"${name}" matches domain name pattern` };
    }
    return { suggestedType: null, confidence: 0, reason: 'already correct' };
  }

  // 3. Agent name patterns
  for (const pattern of AGENT_PATTERNS) {
    if (pattern.test(name)) {
      if (currentType !== 'agent') {
        return { suggestedType: 'agent', confidence: 0.9, reason: `"${name}" matches agent name pattern` };
      }
      return { suggestedType: null, confidence: 0, reason: 'already correct' };
    }
  }

  // 4. Person name heuristic (Capitalized First Last)
  if (PERSON_NAME_PATTERN.test(name)) {
    // Only suggest if currently classified as something clearly wrong
    if (currentType === 'technology' || currentType === 'domain' || currentType === 'workflow') {
      return { suggestedType: 'person', confidence: 0.7, reason: `"${name}" looks like a person name (capitalized first+last)` };
    }
    return { suggestedType: null, confidence: 0, reason: 'already plausible' };
  }

  return { suggestedType: null, confidence: 0, reason: 'no heuristic match' };
}

/**
 * Given a list of entities, return those that appear misclassified.
 * @param {Array<{canonical_name: string, entity_type: string, mention_count: number}>} entities
 * @returns {Array<{name: string, current_type: string, suggested_type: string, confidence: number, reason: string, mention_count: number}>}
 */
export function findMisclassifiedEntities(entities) {
  const suggestions = [];

  for (const entity of entities) {
    const result = detectEntityType(entity.canonical_name, entity.entity_type);
    if (result.suggestedType) {
      suggestions.push({
        name: entity.canonical_name,
        current_type: entity.entity_type,
        suggested_type: result.suggestedType,
        confidence: result.confidence,
        reason: result.reason,
        mention_count: entity.mention_count || 0,
      });
    }
  }

  // Sort by confidence descending, then by mention_count descending
  suggestions.sort((a, b) => b.confidence - a.confidence || b.mention_count - a.mention_count);

  return suggestions;
}
