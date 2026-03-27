import crypto from 'crypto';

const ADMIN_KEY = process.env.BRAIN_API_KEY;
const ALLOW_QUERY_API_KEY = process.env.ALLOW_QUERY_API_KEY === 'true';

// Build agent registry from env vars: AGENT_KEY_<name>=<key>
// e.g. AGENT_KEY_claude_code=abc123 → { key: 'abc123', agent: 'claude-code' }
const agentRegistry = new Map(); // key → agent name

function loadAgentKeys() {
  for (const [envKey, envVal] of Object.entries(process.env)) {
    if (envKey.startsWith('AGENT_KEY_') && envVal) {
      // AGENT_KEY_claude_code → claude-code
      const agentName = envKey.slice('AGENT_KEY_'.length).replace(/_/g, '-').toLowerCase();
      agentRegistry.set(envVal, agentName);
    }
  }
  if (agentRegistry.size > 0) {
    console.log(`[auth] Loaded ${agentRegistry.size} agent key(s): ${[...agentRegistry.values()].join(', ')}`);
  }
}

loadAgentKeys();

// Rate limiting: track failed auth attempts per IP
const failedAttempts = new Map();
const MAX_FAILURES = 10;
const WINDOW_MS = 60_000;

function isRateLimited(ip) {
  const now = Date.now();
  const record = failedAttempts.get(ip);
  if (!record) return false;
  if (now - record.windowStart > WINDOW_MS) {
    failedAttempts.delete(ip);
    return false;
  }
  return record.count >= MAX_FAILURES;
}

function recordFailure(ip) {
  const now = Date.now();
  const record = failedAttempts.get(ip);
  if (!record || now - record.windowStart > WINDOW_MS) {
    failedAttempts.set(ip, { count: 1, windowStart: now });
  } else {
    record.count++;
  }
}

function safeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function extractKey(req) {
  const headerKey = req.headers['x-api-key'];
  if (headerKey) return { key: headerKey, source: 'header' };

  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const bearerToken = authHeader.slice('Bearer '.length).trim();
    if (bearerToken) return { key: bearerToken, source: 'bearer' };
  }

  if (ALLOW_QUERY_API_KEY && req.query?.key) {
    return { key: req.query.key, source: 'query' };
  }

  return { key: null, source: null };
}

export function authMiddleware(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress;

  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many failed attempts. Try again later.' });
  }

  const { key, source } = extractKey(req);
  if (!key) {
    recordFailure(ip);
    const queryKeyProvided = req.query?.key && !ALLOW_QUERY_API_KEY;
    if (queryKeyProvided) {
      return res.status(401).json({ error: 'Query-string API keys are disabled. Use x-api-key header.' });
    }
    return res.status(401).json({ error: 'Missing API key' });
  }

  // Check agent-specific keys first (binds identity)
  const agentName = agentRegistry.get(key);
  if (agentName) {
    req.authenticatedAgent = agentName;
    req.authSource = source;
    req.rateLimitKey = key;
    return next();
  }

  // Fall back to admin key (no agent binding — full access)
  if (safeEqual(key, ADMIN_KEY)) {
    req.authenticatedAgent = null; // admin — no agent identity enforced
    req.authSource = source;
    req.rateLimitKey = key;
    return next();
  }

  recordFailure(ip);
  return res.status(401).json({ error: 'Invalid API key' });
}
