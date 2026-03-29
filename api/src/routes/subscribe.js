import { Router } from 'express';
import eventBus from '../services/event-bus.js';

export const subscribeRouter = Router();

const KEEPALIVE_INTERVAL_MS = 30_000;

/**
 * GET /subscribe?events=memory:stored,memory:superseded&client_id=acme
 *
 * SSE endpoint. Streams events matching the filters.
 * Requires x-api-key auth (mounted after authMiddleware in index.js).
 *
 * Supports Last-Event-ID for reconnection — the client can resume
 * from where it left off (best-effort; no replay buffer).
 */
subscribeRouter.get('/', (req, res) => {
  // Check capacity before accepting the connection
  if (eventBus.subscriberCount >= eventBus.maxSubscribers) {
    return res.status(503).json({
      error: 'Maximum SSE subscriber limit reached. Try again later.',
      active_subscribers: eventBus.subscriberCount,
      max_subscribers: eventBus.maxSubscribers,
    });
  }

  // Parse filters
  const eventsParam = req.query.events;
  const clientId = req.query.client_id;

  const filters = {};
  if (eventsParam) {
    filters.events = eventsParam.split(',').map(e => e.trim()).filter(Boolean);
  }
  if (clientId) {
    filters.client_id = clientId;
  }

  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // nginx buffering bypass
  });

  // Send initial comment so the client knows the connection is live
  res.write(':connected\n\n');

  // Subscribe to events
  const subId = eventBus.subscribe((envelope) => {
    // SSE format: event: <type>\ndata: <JSON>\nid: <uuid>\n\n
    const sseMessage = [
      `event: ${envelope.event}`,
      `data: ${JSON.stringify(envelope.payload)}`,
      `id: ${envelope.id}`,
      '',
      '',
    ].join('\n');

    try {
      res.write(sseMessage);
    } catch (err) {
      // Connection probably closed; cleanup will happen via 'close' event
      console.warn(`[subscribe] Write failed for subscriber ${subId}:`, err.message);
    }
  }, filters);

  if (!subId) {
    // Shouldn't happen since we checked capacity above, but guard anyway
    res.write('event: error\ndata: {"error":"Subscriber limit reached"}\n\n');
    res.end();
    return;
  }

  console.log(`[subscribe] New SSE connection: sub=${subId} agent=${req.authenticatedAgent || 'admin'} filters=${JSON.stringify(filters)} active=${eventBus.subscriberCount}`);

  // Keepalive: send a comment every 30s to prevent proxy/client timeouts
  const keepalive = setInterval(() => {
    try {
      res.write(':keepalive\n\n');
    } catch {
      // Connection dead; cleanup via 'close'
    }
  }, KEEPALIVE_INTERVAL_MS);

  // Cleanup on connection close
  req.on('close', () => {
    clearInterval(keepalive);
    eventBus.unsubscribe(subId);
    console.log(`[subscribe] SSE disconnected: sub=${subId} active=${eventBus.subscriberCount}`);
  });
});
