import fetchWithTimeout from './fetch-with-timeout.js';

// Client fingerprint resolver — identifies which client a piece of text is about
// Uses alias/people/domain/keyword matching with accent normalization

const MIN_THRESHOLD = 2;

// Score weights for each pattern type
const SCORES = {
  alias: 3,    // strong identifier — unique name or abbreviation
  client_id: 3, // direct reference to client ID
  domain: 3,   // strong identifier — website URL
  person: 1,   // may be shared across clients
  keyword: 1,  // contextual hint
};

export class ClientResolver {
  constructor() {
    this.clients = [];
  }

  /**
   * Normalize text: lowercase, strip accents (NFD + remove combining marks),
   * replace non-alphanumeric with spaces, collapse whitespace.
   */
  normalize(text) {
    return text
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')   // remove combining marks (accents)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, ' ')        // non-alphanumeric → space
      .replace(/\s+/g, ' ')              // collapse whitespace
      .trim();
  }

  /**
   * Load client fingerprints.
   * @param {Array<{client_id: string, fingerprints: {aliases: string[], people: string[], domains: string[], keywords: string[]}}>} clients
   */
  loadFingerprints(clients) {
    this.clients = clients.map(c => {
      const fp = c.fingerprints || {};
      return {
        client_id: c.client_id,
        // Normalize all patterns for matching
        aliases: (fp.aliases || []).map(a => this.normalize(a)),
        people: (fp.people || []).map(p => this.normalize(p)),
        domains: (fp.domains || []).map(d => d.toLowerCase()),
        keywords: (fp.keywords || []).map(k => this.normalize(k)),
        // Also add client_id itself as a matchable pattern
        client_id_normalized: this.normalize(c.client_id),
      };
    });
  }

  /**
   * Score a normalized text against a single client's patterns.
   * Returns the total score.
   */
  _scoreClient(normalizedText, paddedText, rawTextLower, client) {
    let score = 0;

    // Check client_id match (word boundary)
    if (client.client_id_normalized && this._wordMatch(paddedText, client.client_id_normalized)) {
      score += SCORES.client_id;
    }

    // Check aliases (word boundary)
    for (const alias of client.aliases) {
      if (alias && this._wordMatch(paddedText, alias)) {
        score += SCORES.alias;
        break; // one alias match is enough
      }
    }

    // Check domains (substring in raw lowercase text — domains have dots)
    for (const domain of client.domains) {
      if (domain && rawTextLower.includes(domain)) {
        score += SCORES.domain;
        break;
      }
    }

    // Check people (word boundary)
    for (const person of client.people) {
      if (person && this._wordMatch(paddedText, person)) {
        score += SCORES.person;
        break;
      }
    }

    // Check keywords (word boundary)
    for (const keyword of client.keywords) {
      if (keyword && this._wordMatch(paddedText, keyword)) {
        score += SCORES.keyword;
      }
    }

    return score;
  }

  /**
   * Word-boundary match check: the pattern must appear as a standalone
   * word or phrase within the padded text.
   */
  _wordMatch(paddedText, pattern) {
    // paddedText is already ` ${normalizedText} ` so we can check ` pattern `
    // for multi-word patterns and also single-word patterns
    return paddedText.includes(` ${pattern} `);
  }

  /**
   * Resolve which client(s) a text is about.
   * @param {string} text — raw text input
   * @returns {null|string|string[]} null if no match, string if one, array if multiple
   */
  resolve(text) {
    if (!text || this.clients.length === 0) return null;

    const normalizedText = this.normalize(text);
    const paddedText = ` ${normalizedText} `; // pad for word-boundary matching
    const rawTextLower = text.toLowerCase();

    // Score each client
    const scored = [];
    for (const client of this.clients) {
      const score = this._scoreClient(normalizedText, paddedText, rawTextLower, client);
      if (score >= MIN_THRESHOLD) {
        scored.push({ client_id: client.client_id, score });
      }
    }

    if (scored.length === 0) return null;
    if (scored.length === 1) return scored[0].client_id;

    // Multiple matches — sort by score descending
    scored.sort((a, b) => b.score - a.score);
    return scored.map(s => s.client_id);
  }
}

// --- Singleton pattern ---

let _instance = null;

/**
 * Get the singleton ClientResolver instance.
 * @returns {ClientResolver}
 */
export function getClientResolver() {
  if (!_instance) {
    _instance = new ClientResolver();
  }
  return _instance;
}

/**
 * Initialize the client resolver by fetching fingerprints from Baserow.
 * If Baserow is not configured, logs a warning and continues with an empty resolver.
 */
export async function initClientResolver() {
  const resolver = getClientResolver();

  const baserowUrl = process.env.BASEROW_URL;
  const token = process.env.BASEROW_CLIENT_TOKEN || process.env.BASEROW_API_KEY;
  const tableId = process.env.BASEROW_CLIENTS_TABLE_ID || '734';

  if (!baserowUrl || !token) {
    console.warn('[client-resolver] Baserow not configured (missing BASEROW_URL or token) — resolver will be empty');
    return resolver;
  }

  try {
    const url = `${baserowUrl}/api/database/rows/table/${tableId}/?user_field_names=true&size=100`;
    const response = await fetchWithTimeout(url, {
      headers: { Authorization: `Token ${token}` },
    }, 15000);

    if (!response.ok) {
      console.warn(`[client-resolver] Baserow returned ${response.status} — resolver will be empty`);
      return resolver;
    }

    const data = await response.json();
    const rows = data.results || [];

    // Filter: rows where client_id exists and active is true
    const activeClients = rows.filter(row => {
      const hasClientId = row.client_id && String(row.client_id).trim() !== '';
      const isActive = row.active === true || row.active === 'true' || row.active === 1 || (row.status && (row.status.value === 'active' || row.status === 'active'));
      return hasClientId && isActive;
    });

    // Map to fingerprint format
    const clients = activeClients.map(row => {
      let fingerprints = null;

      // Try to parse existing fingerprints field (Baserow field: client_fingerprints)
      const rawFp = row.client_fingerprints || row.fingerprints;
      if (rawFp) {
        try {
          fingerprints = typeof rawFp === 'string'
            ? JSON.parse(rawFp)
            : rawFp;
        } catch {
          // Invalid JSON — will auto-populate below
        }
      }

      // Auto-populate from Name/website_url if fingerprints field is empty
      if (!fingerprints || !fingerprints.aliases) {
        fingerprints = {
          aliases: row.Name ? [row.Name] : [],
          people: [],
          domains: row.website_url ? [row.website_url.replace(/^https?:\/\//, '').replace(/\/.*$/, '')] : [],
          keywords: [],
        };
      }

      return {
        client_id: String(row.client_id).trim(),
        fingerprints,
      };
    });

    resolver.loadFingerprints(clients);
    console.log(`[client-resolver] Loaded ${clients.length} client fingerprints from Baserow`);
  } catch (err) {
    console.warn(`[client-resolver] Failed to fetch from Baserow: ${err.message} — resolver will be empty`);
  }

  return resolver;
}
