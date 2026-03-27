import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildNotificationPayload } from '../src/services/notifications.js';

describe('notifications', () => {
  it('should build memory_stored payload with correct structure', () => {
    const payload = buildNotificationPayload('memory_stored', {
      id: 'test-id', type: 'fact', client_id: 'acme-loans',
      knowledge_category: 'strategy', content: 'x'.repeat(300),
      source_agent: 'claude-code', importance: 'high', created_at: '2026-03-20T00:00:00Z',
    });
    assert.strictEqual(payload.event, 'memory_stored');
    assert.strictEqual(payload.memory.id, 'test-id');
    assert.strictEqual(payload.memory.type, 'fact');
    assert.ok(payload.memory.content_preview.length <= 200);
    assert.strictEqual(payload.memory.client_id, 'acme-loans');
  });

  it('should default missing fields', () => {
    const payload = buildNotificationPayload('memory_deleted', { id: 'x', type: 'event' });
    assert.strictEqual(payload.memory.client_id, 'global');
    assert.strictEqual(payload.memory.knowledge_category, 'general');
    assert.strictEqual(payload.memory.importance, 'medium');
  });

  it('should handle text field fallback', () => {
    const payload = buildNotificationPayload('memory_stored', { id: 'x', type: 'event', text: 'hello world' });
    assert.strictEqual(payload.memory.content_preview, 'hello world');
  });
});
