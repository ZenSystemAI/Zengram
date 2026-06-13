// Minimal structured logging helper. Prefixes a log line with the request id so a
// client holding the x-request-id response header can grep the server logs for it.
export function logError(req, tag, message) {
  const id = req && req.requestId ? req.requestId : '-';
  console.error(`[${id}] ${tag}`, message);
}
