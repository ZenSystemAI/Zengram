// Startup configuration validation. Kept pure (takes an env object, returns a
// list of human-readable issues) so index.js owns the process.exit and this
// stays unit-testable. A weak or placeholder BRAIN_API_KEY is a silent security
// hole — reject it at boot with an actionable message rather than serving.

const PLACEHOLDER_API_KEYS = new Set([
  'your-admin-api-key-here',
  'your-api-key',
  'your-key',
  'replace-with-a-generated-secret',
  'change-me',
  'changeme',
  'secret',
  'password',
]);

export function startupConfigIssues(env = process.env) {
  const issues = [];
  const apiKey = env.BRAIN_API_KEY;

  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    issues.push('BRAIN_API_KEY is required. Set it in .env or environment.');
  } else {
    const trimmed = apiKey.trim();
    if (trimmed !== apiKey) {
      issues.push('BRAIN_API_KEY must not have leading or trailing whitespace.');
    }
    if (PLACEHOLDER_API_KEYS.has(trimmed.toLowerCase())) {
      issues.push('BRAIN_API_KEY still has a placeholder value. Generate a unique secret before starting the API.');
    }
    if (trimmed.length < 16) {
      issues.push('BRAIN_API_KEY must be at least 16 characters.');
    }
  }

  return issues;
}
