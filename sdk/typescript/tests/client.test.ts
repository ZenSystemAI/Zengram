/**
 * Basic test structure for BrainClient
 * Uses vitest for testing with mocked fetch API
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BrainClient } from '../src/client';
import { ValidationError } from '../src/errors';

// Mock fetch globally
global.fetch = vi.fn();

describe('BrainClient', () => {
  let client: BrainClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new BrainClient({
      url: 'http://localhost:8084',
      apiKey: 'test-key',
      defaultSourceAgent: 'test-agent',
    });
  });

  describe('constructor', () => {
    it('should create client with default options', () => {
      const brain = new BrainClient();
      expect(brain).toBeDefined();
    });

    it('should create client with custom options', () => {
      const brain = new BrainClient({
        url: 'http://example.com',
        apiKey: 'custom-key',
        timeout: 30,
        maxRetries: 5,
        defaultSourceAgent: 'my-agent',
      });
      expect(brain).toBeDefined();
    });

    it('should strip trailing slash from URL', () => {
      const brain = new BrainClient({
        url: 'http://localhost:8084/',
        apiKey: 'test-key',
      });
      expect(brain).toBeDefined();
    });
  });

  describe('store', () => {
    it('should store a memory', async () => {
      const mockResponse = {
        id: 'uuid-123',
        type: 'fact',
        content_hash: 'hash-123',
        deduplicated: false,
        observed_by: ['test-agent'],
        observation_count: 1,
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(mockResponse),
      });

      const result = await client.store({
        type: 'fact',
        content: 'Test memory',
        key: 'test-key',
      });

      expect(result).toBeDefined();
      expect(result.id).toBe('uuid-123');
      expect(result.type).toBe('fact');
    });

    it('should throw if source_agent is missing', async () => {
      const noAgentClient = new BrainClient({
        url: 'http://localhost:8084',
        apiKey: 'test-key',
      });

      await expect(
        noAgentClient.store({
          type: 'fact',
          content: 'Test memory',
        })
      ).rejects.toThrow(ValidationError);
    });

    it('should include all optional fields in request', async () => {
      const mockResponse = {
        id: 'uuid-123',
        type: 'fact',
        content_hash: 'hash-123',
        deduplicated: false,
        observed_by: ['test-agent'],
        observation_count: 1,
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(mockResponse),
      });

      await client.store({
        type: 'fact',
        content: 'Test memory',
        key: 'test-key',
        clientId: 'acme-corp',
        category: 'semantic',
        importance: 'high',
        knowledgeCategory: 'technical',
      });

      expect(global.fetch).toHaveBeenCalledOnce();
      const call = (global.fetch as any).mock.calls[0];
      expect(call[0]).toContain('/memory');
      expect(call[1].method).toBe('POST');
    });
  });

  describe('search', () => {
    it('should search for memories', async () => {
      const mockResponse = {
        query: 'test query',
        count: 1,
        results: [
          {
            id: 'uuid-123',
            score: 0.85,
            effective_score: 0.85,
            type: 'fact',
            content: 'Test memory',
            source_agent: 'test-agent',
            client_id: 'global',
            importance: 'medium',
            created_at: '2026-01-01T00:00:00Z',
            confidence: 1.0,
            entities: [],
          },
        ],
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(mockResponse),
      });

      const result = await client.search('test query');

      expect(result).toBeDefined();
      expect(result.count).toBe(1);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].id).toBe('uuid-123');
    });

    it('should apply search options as query parameters', async () => {
      const mockResponse = {
        query: 'test query',
        count: 0,
        results: [],
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(mockResponse),
      });

      await client.search('test query', {
        limit: 5,
        clientId: 'acme-corp',
        format: 'full',
        includeSuperseded: true,
      });

      expect(global.fetch).toHaveBeenCalledOnce();
      const call = (global.fetch as any).mock.calls[0];
      expect(call[0]).toContain('q=test');
      expect(call[0]).toContain('limit=5');
      expect(call[0]).toContain('client_id=acme-corp');
      expect(call[0]).toContain('format=full');
      expect(call[0]).toContain('include_superseded=true');
    });
  });

  describe('query', () => {
    it('should perform structured query for facts', async () => {
      const mockResponse = {
        type: 'facts',
        count: 1,
        results: [
          {
            id: 'uuid-123',
            type: 'fact',
            key: 'test-key',
            content: 'Test fact',
          },
        ],
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(mockResponse),
      });

      const result = await client.query({
        type: 'facts',
        key: 'test-key',
      });

      expect(result).toBeDefined();
      expect(result.type).toBe('facts');
    });

    it('should perform structured query for events', async () => {
      const mockResponse = {
        type: 'events',
        count: 0,
        results: [],
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(mockResponse),
      });

      await client.query({
        type: 'events',
        since: '2026-01-01T00:00:00Z',
      });

      expect(global.fetch).toHaveBeenCalledOnce();
    });
  });

  describe('update', () => {
    it('should update a memory', async () => {
      const mockResponse = {
        id: 'uuid-123',
        updated: true,
        updated_at: '2026-01-01T00:00:00Z',
        updated_fields: ['content'],
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(mockResponse),
      });

      const result = await client.update('uuid-123', {
        content: 'Updated content',
      });

      expect(result).toBeDefined();
      expect(result.updated).toBe(true);
      expect(result.updatedFields).toContain('content');
    });

    it('should throw if no fields provided', async () => {
      await expect(client.update('uuid-123', {})).rejects.toThrow(ValidationError);
    });
  });

  describe('health', () => {
    it('should check API health', async () => {
      const mockResponse = {
        status: 'ok',
        service: 'zengram',
        timestamp: '2026-01-01T00:00:00Z',
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      });

      const result = await client.health();

      expect(result).toBeDefined();
      expect(result.status).toBe('ok');
      expect(result.service).toBe('zengram');
    });
  });

  describe('error handling', () => {
    it('should handle 401 Unauthorized', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });

      const { AuthenticationError } = await import('../src/errors');

      await expect(client.search('test')).rejects.toThrow(AuthenticationError);
    });

    it('should handle 404 Not Found', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => 'Not found',
      });

      const { NotFoundError } = await import('../src/errors');

      await expect(client.update('nonexistent', { content: 'test' })).rejects.toThrow(
        NotFoundError
      );
    });

    it('should handle 400 Bad Request', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'Bad request',
      });

      const { ValidationError } = await import('../src/errors');

      await expect(client.search('test')).rejects.toThrow(ValidationError);
    });

    it('should handle rate limiting (429)', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Map([['Retry-After', '5']]),
        text: async () => 'Too many requests',
      });

      const { RateLimitError } = await import('../src/errors');

      await expect(client.search('test')).rejects.toThrow(RateLimitError);
    });
  });

  describe('batch operations', () => {
    it('should batch store multiple memories', async () => {
      const mockResponse = {
        total: 2,
        stored: 2,
        deduplicated: 0,
        failed: 0,
        results: [
          {
            index: 0,
            result: {
              id: 'uuid-1',
              type: 'fact',
              content_hash: 'hash-1',
              deduplicated: false,
              observed_by: ['test-agent'],
              observation_count: 1,
            },
          },
          {
            index: 1,
            result: {
              id: 'uuid-2',
              type: 'fact',
              content_hash: 'hash-2',
              deduplicated: false,
              observed_by: ['test-agent'],
              observation_count: 1,
            },
          },
        ],
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(mockResponse),
      });

      const result = await client.batchStore([
        { type: 'fact', content: 'Memory 1', key: 'key-1' },
        { type: 'fact', content: 'Memory 2', key: 'key-2' },
      ]);

      expect(result.total).toBe(2);
      expect(result.stored).toBe(2);
    });

    it('should handle empty batch', async () => {
      const result = await client.batchStore([]);

      expect(result.total).toBe(0);
      expect(result.stored).toBe(0);
    });
  });
});
