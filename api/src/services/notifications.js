import fetchWithTimeout from './fetch-with-timeout.js';
import eventBus from './event-bus.js';

const WEBHOOK_URLS = (process.env.WEBHOOK_NOTIFY_URLS || '')
  .split(',')
  .map(u => u.trim())
  .filter(u => u.length > 0);

// Map legacy underscore event names to SSE colon-delimited names
const EVENT_NAME_MAP = {
  memory_stored: 'memory:stored',
  memory_superseded: 'memory:superseded',
  memory_deleted: 'memory:deleted',
  memory_consolidated: 'memory:consolidated',
  entity_created: 'entity:created',
  entity_linked: 'entity:linked',
};

function toSseEventName(event) {
  return EVENT_NAME_MAP[event] || event.replace(/_/g, ':');
}

export function buildNotificationPayload(event, memory) {
  return {
    event,
    memory: {
      id: memory.id,
      type: memory.type,
      client_id: memory.client_id || 'global',
      knowledge_category: memory.knowledge_category || 'general',
      content_preview: (memory.content || memory.text || '').slice(0, 200),
      source_agent: memory.source_agent,
      importance: memory.importance || 'medium',
      created_at: memory.created_at,
    },
  };
}

/**
 * Build a lightweight SSE payload — content preview capped at 100 chars.
 */
function buildSsePayload(event, memory) {
  return {
    event,
    memory: {
      id: memory.id,
      type: memory.type,
      client_id: memory.client_id || 'global',
      knowledge_category: memory.knowledge_category || 'general',
      content_preview: (memory.content || memory.text || '').slice(0, 100),
      source_agent: memory.source_agent,
      importance: memory.importance || 'medium',
      created_at: memory.created_at,
    },
  };
}

export function dispatchNotification(event, memory) {
  // Always emit to event bus (SSE subscribers) — even when no webhooks configured
  const sseEvent = toSseEventName(event);
  const ssePayload = buildSsePayload(sseEvent, memory);
  eventBus.emit(sseEvent, ssePayload);

  // Webhooks (if configured)
  if (WEBHOOK_URLS.length === 0) return;
  const payload = buildNotificationPayload(event, memory);

  for (const url of WEBHOOK_URLS) {
    fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, 10000).catch(err => {
      console.warn(`[notifications] Webhook failed for ${url}: ${err.message}`);
    });
  }
}
