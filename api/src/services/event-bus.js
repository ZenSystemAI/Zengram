import { EventEmitter } from 'events';
import crypto from 'crypto';

const MAX_SUBSCRIBERS = 50;

/**
 * In-process event bus for SSE subscriptions.
 *
 * Events:
 *   memory:stored, memory:superseded, memory:deleted,
 *   memory:consolidated, entity:created, entity:linked
 *
 * Each subscriber gets a unique id, an optional filter (event types, client_id),
 * and a callback invoked with { event, payload, id }.
 */
class EventBus {
  constructor() {
    this._emitter = new EventEmitter();
    this._emitter.setMaxListeners(MAX_SUBSCRIBERS + 10); // headroom for internal listeners
    /** @type {Map<string, { callback: Function, filters: { events?: string[], client_id?: string } }>} */
    this._subscribers = new Map();
  }

  /**
   * Emit an event to all matching subscribers.
   * @param {string} event - e.g. 'memory:stored'
   * @param {object} payload - event data (kept small — content_preview, not full text)
   */
  emit(event, payload) {
    const envelope = {
      event,
      payload,
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
    };
    this._emitter.emit('event', envelope);
  }

  /**
   * Subscribe to events. Returns a subscriber id for later unsubscribe.
   * @param {Function} callback - called with envelope { event, payload, id, timestamp }
   * @param {{ events?: string[], client_id?: string }} [filters]
   * @returns {string|null} subscriber id, or null if at capacity
   */
  subscribe(callback, filters = {}) {
    if (this._subscribers.size >= MAX_SUBSCRIBERS) {
      return null;
    }

    const subId = crypto.randomUUID();

    const handler = (envelope) => {
      // Filter by event type
      if (filters.events && filters.events.length > 0) {
        if (!filters.events.includes(envelope.event)) return;
      }
      // Filter by client_id
      if (filters.client_id) {
        const payloadClientId = envelope.payload?.client_id || envelope.payload?.memory?.client_id;
        if (payloadClientId && payloadClientId !== filters.client_id) return;
      }
      try {
        callback(envelope);
      } catch (err) {
        console.error(`[event-bus] Subscriber ${subId} callback error:`, err.message);
      }
    };

    this._subscribers.set(subId, { callback: handler, filters });
    this._emitter.on('event', handler);
    return subId;
  }

  /**
   * Remove a subscriber.
   * @param {string} subId
   */
  unsubscribe(subId) {
    const sub = this._subscribers.get(subId);
    if (!sub) return;
    this._emitter.removeListener('event', sub.callback);
    this._subscribers.delete(subId);
  }

  /** Current number of active subscribers. */
  get subscriberCount() {
    return this._subscribers.size;
  }

  /** Maximum allowed subscribers. */
  get maxSubscribers() {
    return MAX_SUBSCRIBERS;
  }
}

// Singleton
const eventBus = new EventBus();
export default eventBus;
