// Query expansion: infers topic domains from vague queries and generates broader search terms.
// Addresses the "semantic gap" where questions like "recommend a show" don't match
// memories about "John Mulaney stand-up specials on Netflix."

const DOMAIN_MAP = {
  entertainment: {
    triggers: ['show', 'movie', 'series', 'film', 'watch', 'tv', 'netflix', 'hulu', 'streaming', 'binge', 'episode', 'season', 'comedy', 'drama', 'documentary', 'anime', 'cartoon', 'stand-up'],
    expansions: ['show movie series film watch streaming netflix entertainment tv recommend'],
  },
  music: {
    triggers: ['song', 'music', 'album', 'artist', 'band', 'playlist', 'concert', 'listen', 'spotify', 'genre', 'singer'],
    expansions: ['song music album artist band listen playlist concert'],
  },
  food: {
    triggers: ['restaurant', 'food', 'eat', 'dinner', 'lunch', 'breakfast', 'cook', 'recipe', 'cuisine', 'meal', 'dish', 'cafe', 'bar'],
    expansions: ['restaurant food eat dinner meal recipe cuisine cooking'],
  },
  reading: {
    triggers: ['book', 'read', 'author', 'novel', 'story', 'chapter', 'library', 'kindle', 'audiobook', 'fiction', 'nonfiction'],
    expansions: ['book read author novel story fiction recommend'],
  },
  travel: {
    triggers: ['travel', 'trip', 'vacation', 'flight', 'hotel', 'destination', 'visit', 'explore', 'tour', 'country', 'city'],
    expansions: ['travel trip vacation destination visit flight hotel'],
  },
  fitness: {
    triggers: ['exercise', 'workout', 'gym', 'run', 'yoga', 'fitness', 'health', 'weight', 'training', 'sport', 'hiking', 'bike', 'cycling'],
    expansions: ['exercise workout gym fitness health training sport'],
  },
  tech: {
    triggers: ['app', 'software', 'phone', 'laptop', 'computer', 'gadget', 'device', 'tool', 'setup', 'build'],
    expansions: ['app software tool device setup technology recommend'],
  },
  shopping: {
    triggers: ['buy', 'purchase', 'shop', 'gift', 'product', 'brand', 'price', 'deal', 'amazon', 'store'],
    expansions: ['buy purchase shop product brand gift recommend'],
  },
  hobby: {
    triggers: ['hobby', 'craft', 'paint', 'draw', 'garden', 'photography', 'game', 'gaming', 'board game', 'puzzle', 'diy'],
    expansions: ['hobby activity interest game craft enjoy'],
  },
};

// Pre-compute a trigger→domain lookup
const triggerIndex = new Map();
for (const [domain, config] of Object.entries(DOMAIN_MAP)) {
  for (const trigger of config.triggers) {
    triggerIndex.set(trigger, domain);
  }
}

/**
 * Detect if a query is vague/preference-style and infer its domain.
 * @param {string} query
 * @returns {{ isVague: boolean, domain?: string, expansions?: string[], originalQuery: string }}
 */
export function analyzeQuery(query) {
  const q = query.toLowerCase().replace(/[?!.,;:'"]/g, '');
  const words = q.split(/\s+/);

  // Check if the query is preference-style (asking for recommendations/suggestions)
  const isPreference = /\b(recommend|suggest|tips|advice|should i|would you|what .* (good|best|favorite|like)|can you .* recommend|looking for|interested in)\b/i.test(query);

  // Find matching domains
  const domainHits = {};
  for (const word of words) {
    const domain = triggerIndex.get(word);
    if (domain) {
      domainHits[domain] = (domainHits[domain] || 0) + 1;
    }
    // Also check 2-word phrases
    const idx = words.indexOf(word);
    if (idx < words.length - 1) {
      const phrase = word + ' ' + words[idx + 1];
      const phraseDomain = triggerIndex.get(phrase);
      if (phraseDomain) domainHits[phraseDomain] = (domainHits[phraseDomain] || 0) + 2;
    }
  }

  if (Object.keys(domainHits).length === 0) {
    return { isVague: isPreference, originalQuery: query };
  }

  // Pick the highest-scoring domain
  const topDomain = Object.entries(domainHits).sort((a, b) => b[1] - a[1])[0][0];

  return {
    isVague: isPreference,
    domain: topDomain,
    expansions: DOMAIN_MAP[topDomain].expansions,
    originalQuery: query,
  };
}

/**
 * Generate an expanded query by appending domain terms.
 * @param {string} originalQuery
 * @param {string[]} expansions
 * @returns {string}
 */
export function expandQuery(originalQuery, expansions) {
  if (!expansions || expansions.length === 0) return originalQuery;
  // Append the expansion terms to broaden semantic coverage
  return originalQuery + ' ' + expansions[0];
}

/**
 * Extract key noun phrases from a query for broader search fallback.
 * Strips question words, verbs, and filler to get topic terms.
 */
export function extractSearchTerms(questionText) {
  const stopWords = new Set([
    'i', 'me', 'my', 'we', 'our', 'you', 'your', 'the', 'a', 'an', 'is', 'are', 'was', 'were',
    'do', 'did', 'does', 'have', 'has', 'had', 'can', 'could', 'would', 'should', 'will',
    'what', 'when', 'where', 'which', 'who', 'how', 'why', 'that', 'this', 'these', 'those',
    'to', 'for', 'in', 'on', 'at', 'of', 'with', 'from', 'by', 'about', 'into', 'any', 'some',
    'much', 'many', 'most', 'more', 'very', 'just', 'also', 'been', 'being', 'get', 'got',
    'suggest', 'recommend', 'think', 'know', 'tell', 'give', 'make', 'take',
  ]);
  return questionText
    .toLowerCase()
    .replace(/[?!.,;:'"]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w))
    .join(' ');
}
