// Minimal structured logging helper. Prefixes a log line with the request id so a
// client holding the x-request-id response header can grep the server logs for it.
//
// Two CodeQL constraints this module exists to satisfy:
//   - CWE-134: console.error's first argument is a format string. Request ids
//     come from the x-request-id header and must be passed as a data argument,
//     never interpolated into the format string (`%s` in a request id would
//     otherwise consume later arguments).
//   - CWE-312: pg / HTTP client Error.message values routinely embed DSNs and
//     API keys. We log only name + code, never the raw message.

export function errorSummary(err) {
  if (err == null || typeof err !== 'object') return 'Error';
  const name = typeof err.name === 'string' && err.name ? err.name : 'Error';
  if (err.code == null || err.code === '') return name;
  return `${name} ${String(err.code)}`;
}

export function logError(req, tag, err) {
  const id = req && req.requestId ? req.requestId : '-';
  console.error('[%s] %s %s', id, tag, errorSummary(err));
}
