// Minimal structured logging helper. Prefixes a log line with the request id so a
// client holding the x-request-id response header can grep the server logs for it.
//
// Two CodeQL constraints this module exists to satisfy:
//   - CWE-134: console.error's first argument is a format string. Request ids
//     come from the x-request-id header and must be passed as a data argument,
//     never interpolated into the format string (`%s` in a request id would
//     otherwise consume later arguments).
//   - CWE-312: pg / HTTP client Error fields are tainted (Gemini used to put
//     apiKey in the request URL; libraries embed DSNs in Error.message). CodeQL
//     treats hashing as a sanitizer, so we only ever log a fingerprint.

import crypto from 'node:crypto';

export function errorSummary(err) {
  if (err == null || typeof err !== 'object') return 'Error';
  const name = typeof err.name === 'string' && err.name ? err.name : 'Error';
  const code = err.code == null ? '' : String(err.code);
  const message = typeof err.message === 'string' ? err.message : '';
  return crypto
    .createHash('sha256')
    .update(name)
    .update('\0')
    .update(code)
    .update('\0')
    .update(message)
    .digest('hex')
    .slice(0, 12);
}

export function logError(req, tag, err) {
  const id = req && req.requestId ? req.requestId : '-';
  console.error('[%s] %s %s', id, tag, errorSummary(err));
}
