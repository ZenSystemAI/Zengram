/**
 * Core HTTP client for Zengram API
 */

import { randomUUID } from 'crypto';

import {
  BrainClientOptions,
  StoreMemoryInput,
  SearchOptions,
  QueryOptions,
  UpdateMemoryInput,
  BriefingOptions,
  ReflectOptions,
  EntityOptions,
  GraphOptions,
  ConsolidateOptions,
  ExportOptions,
  ImportData,
  ImportanceLevel,
  ResponseFormat,
  // Response types
  StoreResult,
  SearchResponse,
  Memory,
  Briefing,
  Stats,
  Entity,
  GraphData,
  ClientBriefing,
  ConsolidationJob,
  ConsolidationStatus,
  ExportData,
  ImportResult,
  UpdateResult,
  ReflectResponse,
  HealthStatus,
  BatchResult,
} from './types';

import {
  BrainError,
  RateLimitError,
  AuthenticationError,
  NotFoundError,
  ValidationError,
  PermissionError,
  TimeoutError,
  ConnectionError,
} from './errors';

const CONSOLIDATION_TIMEOUT = 120000; // 120 seconds in ms
const RETRY_BACKOFF_BASE = 1000; // 1 second in ms
const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504]);

/**
 * Synchronous client for the Zengram API
 *
 * @example
 * ```typescript
 * import { BrainClient } from '@zensystemai/zengram-sdk';
 *
 * const brain = new BrainClient({
 *   url: 'http://localhost:8084',
 *   apiKey: 'your-api-key',
 *   defaultSourceAgent: 'my-agent'
 * });
 *
 * // Store a memory
 * const result = await brain.store({
 *   type: 'fact',
 *   content: 'The sky is blue',
 *   key: 'sky-color'
 * });
 *
 * // Search memories
 * const results = await brain.search('sky color');
 * ```
 */
export class BrainClient {
  private readonly url: string;
  private readonly apiKey: string;
  private readonly timeout: number;
  private readonly maxRetries: number;
  private readonly defaultSourceAgent?: string;

  /**
   * Create a new BrainClient instance
   */
  constructor(options: BrainClientOptions = {}) {
    this.url = options.url?.replace(/\/$/, '') || 'http://localhost:8084';
    this.apiKey = options.apiKey || '';
    this.timeout = (options.timeout || 15) * 1000; // Convert seconds to ms
    this.maxRetries = options.maxRetries ?? 3;
    this.defaultSourceAgent = options.defaultSourceAgent;
  }

  /**
   * Make an HTTP request with retry logic and error handling
   */
  private async _request<T>(
    method: string,
    path: string,
    options?: {
      json?: Record<string, unknown>;
      params?: Record<string, unknown>;
      timeout?: number;
    }
  ): Promise<T> {
    const { json, params, timeout = this.timeout } = options || {};

    // Build URL with query parameters
    const url = new URL(this.url + path);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== null && value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    let lastError: Error | null = null;
    let responseBody = '';

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutHandle = setTimeout(() => controller.abort(), timeout);

        const headers: Record<string, string> = {
          'x-api-key': this.apiKey,
          'Content-Type': 'application/json',
          'x-request-id': randomUUID(),
        };

        const response = await fetch(url.toString(), {
          method,
          headers,
          body: json ? JSON.stringify(json) : undefined,
          signal: controller.signal,
        });

        clearTimeout(timeoutHandle);
        responseBody = await response.text();

        // Handle rate limiting
        if (response.status === 429) {
          const retryAfter = parseInt(response.headers.get('Retry-After') || '5', 10);
          if (attempt < this.maxRetries) {
            await this._sleep(retryAfter * 1000);
            continue;
          }
          throw new RateLimitError(
            `Rate limit exceeded: ${responseBody}`,
            retryAfter,
            429,
            responseBody
          );
        }

        // Handle retryable errors
        if (RETRYABLE_STATUS_CODES.has(response.status) && attempt < this.maxRetries) {
          const backoff = RETRY_BACKOFF_BASE * Math.pow(2, attempt);
          await this._sleep(backoff);
          continue;
        }

        // Handle client errors
        if (!response.ok) {
          if (response.status === 401) {
            throw new AuthenticationError(`Unauthorized: ${responseBody}`, responseBody);
          } else if (response.status === 403) {
            throw new PermissionError(`Forbidden: ${responseBody}`, responseBody);
          } else if (response.status === 404) {
            throw new NotFoundError(`Not found: ${responseBody}`, responseBody);
          } else if (response.status === 400) {
            throw new ValidationError(`Invalid request: ${responseBody}`, responseBody);
          } else {
            throw new BrainError(
              `API error ${response.status}: ${responseBody}`,
              response.status,
              responseBody
            );
          }
        }

        // Parse and return response
        return JSON.parse(responseBody) as T;
      } catch (error) {
        // Handle AbortError (timeout)
        if (error instanceof Error && error.name === 'AbortError') {
          lastError = new TimeoutError(
            `Request timed out after ${timeout}ms: ${method} ${path}`
          );
          if (attempt < this.maxRetries) {
            const backoff = RETRY_BACKOFF_BASE * Math.pow(2, attempt);
            await this._sleep(backoff);
            continue;
          }
          throw lastError;
        }

        // Handle TypeError (network errors)
        if (error instanceof TypeError) {
          lastError = new ConnectionError(`Connection failed: ${this.url}${path}`);
          if (attempt < this.maxRetries) {
            const backoff = RETRY_BACKOFF_BASE * Math.pow(2, attempt);
            await this._sleep(backoff);
            continue;
          }
          throw lastError;
        }

        // Re-throw known error types
        if (error instanceof BrainError) {
          throw error;
        }

        // Unknown error
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < this.maxRetries) {
          const backoff = RETRY_BACKOFF_BASE * Math.pow(2, attempt);
          await this._sleep(backoff);
          continue;
        }
        throw lastError;
      }
    }

    throw lastError || new BrainError(`Request failed after ${this.maxRetries + 1} attempts`);
  }

  /**
   * Sleep for a given number of milliseconds
   */
  private _sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /* ========================================================================
   * Memory Operations
   * ======================================================================== */

  /**
   * Store a memory in the Shared Brain
   */
  async store(input: StoreMemoryInput): Promise<StoreResult> {
    const sourceAgent = input.sourceAgent || this.defaultSourceAgent;
    if (!sourceAgent) {
      throw new ValidationError('source_agent is required (pass it in input or set defaultSourceAgent)');
    }

    const body: Record<string, unknown> = {
      type: input.type,
      content: input.content,
      source_agent: sourceAgent,
    };

    if (input.clientId !== undefined) body.client_id = input.clientId;
    if (input.category !== undefined) body.category = input.category;
    if (input.importance !== undefined) body.importance = input.importance;
    if (input.key !== undefined) body.key = input.key;
    if (input.subject !== undefined) body.subject = input.subject;
    if (input.statusValue !== undefined) body.status_value = input.statusValue;
    if (input.knowledgeCategory !== undefined) body.knowledge_category = input.knowledgeCategory;
    if (input.validFrom !== undefined) body.valid_from = input.validFrom;
    if (input.validTo !== undefined) body.valid_to = input.validTo;
    if (input.metadata !== undefined) body.metadata = input.metadata;

    const data = await this._request<Record<string, unknown>>('POST', '/memory', {
      json: body,
    });

    return this._parseStoreResult(data);
  }

  /**
   * Store multiple memories in a single batch request
   */
  async batchStore(inputs: StoreMemoryInput[]): Promise<BatchResult> {
    if (inputs.length === 0) {
      return { total: 0, stored: 0, deduplicated: 0, failed: 0, results: [] };
    }

    const memories = inputs.map((input) => {
      const sourceAgent = input.sourceAgent || this.defaultSourceAgent;
      if (!sourceAgent) {
        throw new ValidationError('source_agent is required for all memories in batch');
      }

      const body: Record<string, unknown> = {
        type: input.type,
        content: input.content,
        source_agent: sourceAgent,
      };

      if (input.clientId !== undefined) body.client_id = input.clientId;
      if (input.category !== undefined) body.category = input.category;
      if (input.importance !== undefined) body.importance = input.importance;
      if (input.key !== undefined) body.key = input.key;
      if (input.subject !== undefined) body.subject = input.subject;
      if (input.statusValue !== undefined) body.status_value = input.statusValue;
      if (input.knowledgeCategory !== undefined) body.knowledge_category = input.knowledgeCategory;
      if (input.validFrom !== undefined) body.valid_from = input.validFrom;
      if (input.validTo !== undefined) body.valid_to = input.validTo;
      if (input.metadata !== undefined) body.metadata = input.metadata;

      return body;
    });

    const data = await this._request<Record<string, unknown>>('POST', '/memory/batch', {
      json: { memories },
    });

    return this._parseBatchResult(data);
  }

  /**
   * Search memories using multi-path retrieval (vector + keyword + graph)
   */
  async search(query: string, options?: SearchOptions): Promise<SearchResponse> {
    const params: Record<string, unknown> = { q: query };

    if (options?.type !== undefined) params.type = options.type;
    if (options?.sourceAgent !== undefined) params.source_agent = options.sourceAgent;
    if (options?.clientId !== undefined) params.client_id = options.clientId;
    if (options?.category !== undefined) params.category = options.category;
    if (options?.limit !== undefined) params.limit = options.limit;
    if (options?.format !== undefined) params.format = options.format;
    if (options?.includeSuperseded) params.include_superseded = 'true';
    if (options?.knowledgeCategory !== undefined) params.knowledge_category = options.knowledgeCategory;
    if (options?.atTime !== undefined) params.at_time = options.atTime;
    if (options?.entity !== undefined) params.entity = options.entity;

    const data = await this._request<Record<string, unknown>>('GET', '/memory/search', {
      params,
    });

    return this._parseSearchResponse(data);
  }

  /**
   * Structured query (facts by key, statuses by subject, events by time)
   */
  async query(options: QueryOptions): Promise<Record<string, unknown>> {
    const params: Record<string, unknown> = { type: options.type };

    if (options.sourceAgent !== undefined) params.source_agent = options.sourceAgent;
    if (options.category !== undefined) params.category = options.category;
    if (options.clientId !== undefined) params.client_id = options.clientId;
    if (options.since !== undefined) params.since = options.since;
    if (options.key !== undefined) params.key = options.key;
    if (options.subject !== undefined) params.subject = options.subject;

    return this._request<Record<string, unknown>>('GET', '/memory/query', { params });
  }

  /**
   * Update an existing memory
   */
  async update(memoryId: string, input: UpdateMemoryInput): Promise<UpdateResult> {
    const body: Record<string, unknown> = {};

    if (input.content !== undefined) body.content = input.content;
    if (input.importance !== undefined) body.importance = input.importance;
    if (input.knowledgeCategory !== undefined) body.knowledge_category = input.knowledgeCategory;
    if (input.metadata !== undefined) body.metadata = input.metadata;

    if (Object.keys(body).length === 0) {
      throw new ValidationError('Must provide at least one field to update');
    }

    const data = await this._request<Record<string, unknown>>('PATCH', `/memory/${memoryId}`, {
      json: body,
    });

    return this._parseUpdateResult(data);
  }

  /**
   * Soft-delete a memory (mark as inactive)
   */
  async delete(memoryId: string, reason?: string): Promise<void> {
    const body: Record<string, unknown> = {};
    if (reason !== undefined) body.reason = reason;

    try {
      await this._request<void>('DELETE', `/memory/${memoryId}`, { json: body });
    } catch (error) {
      if (error instanceof NotFoundError || error instanceof PermissionError) {
        throw error;
      }
      throw error;
    }
  }

  /* ========================================================================
   * Intelligence Operations
   * ======================================================================== */

  /**
   * Get a session briefing of what happened since a given time
   */
  async briefing(since: string, options?: BriefingOptions): Promise<Briefing> {
    const params: Record<string, unknown> = { since };

    if (options?.agent !== undefined) params.agent = options.agent;
    if (options?.include !== undefined) params.include = options.include;
    if (options?.format !== undefined) params.format = options.format;
    if (options?.limit !== undefined) params.limit = options.limit;

    const data = await this._request<Record<string, unknown>>('GET', '/briefing', { params });
    return this._parseBriefing(data);
  }

  /**
   * Reflect on a topic by synthesizing patterns across memories
   */
  async reflect(topic: string, options?: ReflectOptions): Promise<ReflectResponse> {
    const body: Record<string, unknown> = { topic };

    if (options?.clientId !== undefined) body.client_id = options.clientId;
    if (options?.limit !== undefined) body.limit = options.limit;

    const data = await this._request<Record<string, unknown>>('POST', '/reflect', {
      json: body,
      timeout: CONSOLIDATION_TIMEOUT,
    });

    return this._parseReflectResponse(data);
  }

  /**
   * Get complete context about a client
   */
  async clientBriefing(clientId: string): Promise<ClientBriefing> {
    const data = await this._request<Record<string, unknown>>('GET', `/client/${clientId}`);
    return this._parseClientBriefing(data);
  }

  /* ========================================================================
   * System Operations
   * ======================================================================== */

  /**
   * Get memory health statistics
   */
  async stats(): Promise<Stats> {
    const data = await this._request<Record<string, unknown>>('GET', '/stats');
    return this._parseStats(data);
  }

  /**
   * Query the entity graph
   */
  async entities(options?: EntityOptions): Promise<Entity[] | Record<string, unknown>> {
    const action = options?.action || 'list';
    const name = options?.name;

    if (action === 'stats') {
      return this._request<Record<string, unknown>>('GET', '/entities/stats');
    } else if (action === 'get') {
      if (!name) throw new ValidationError('name is required for action=get');
      return this._request<Record<string, unknown>>('GET', `/entities/${name}`);
    } else if (action === 'memories') {
      if (!name) throw new ValidationError('name is required for action=memories');
      const params: Record<string, unknown> = {};
      if (options?.limit !== undefined) params.limit = options.limit;
      return this._request<Record<string, unknown>>('GET', `/entities/${name}/memories`, { params });
    } else {
      const params: Record<string, unknown> = {};
      if (options?.type !== undefined) params.type = options.type;
      if (options?.limit !== undefined) params.limit = options.limit;
      const data = await this._request<Record<string, unknown>>('GET', '/entities', { params });
      return this._parseEntityList(data);
    }
  }

  /**
   * Explore entity relationships in the knowledge graph
   */
  async graph(entity: string, options?: GraphOptions): Promise<GraphData> {
    const params: Record<string, unknown> = {};
    if (options?.depth !== undefined) params.depth = options.depth;
    if (options?.minStrength !== undefined) params.min_strength = options.minStrength;

    const data = await this._request<Record<string, unknown>>('GET', `/graph/${entity}`, { params });
    return this._parseGraphData(data);
  }

  /**
   * Trigger a consolidation run
   */
  async consolidate(options?: ConsolidateOptions): Promise<ConsolidationJob | ConsolidationStatus> {
    const params: Record<string, unknown> = {};
    if (options?.sync) params.sync = 'true';

    const data = await this._request<Record<string, unknown>>('POST', '/consolidate', {
      params,
      timeout: options?.sync ? CONSOLIDATION_TIMEOUT : this.timeout,
    });

    return this._parseConsolidationResponse(data);
  }

  /**
   * Get consolidation engine status
   */
  async consolidationStatus(): Promise<ConsolidationStatus> {
    const data = await this._request<Record<string, unknown>>('GET', '/consolidate/status');
    return this._parseConsolidationStatus(data);
  }

  /**
   * Poll a consolidation job
   */
  async consolidationJob(jobId: string): Promise<ConsolidationJob> {
    const data = await this._request<Record<string, unknown>>('GET', `/consolidate/job/${jobId}`);
    return this._parseConsolidationJob(data);
  }

  /* ========================================================================
   * Bulk Operations
   * ======================================================================== */

  /**
   * Export memories as JSON
   */
  async export(options?: ExportOptions): Promise<ExportData> {
    const params: Record<string, unknown> = {};
    if (options?.clientId !== undefined) params.client_id = options.clientId;
    if (options?.type !== undefined) params.type = options.type;
    if (options?.since !== undefined) params.since = options.since;
    if (options?.limit !== undefined) params.limit = options.limit;

    const data = await this._request<Record<string, unknown>>('GET', '/export', { params });
    return this._parseExportData(data);
  }

  /**
   * Import memories from JSON
   */
  async import(data: ImportData): Promise<ImportResult> {
    const body = { data: data.data };

    const result = await this._request<Record<string, unknown>>('POST', '/export/import', {
      json: body,
    });

    return this._parseImportResult(result);
  }

  /* ========================================================================
   * Health Check
   * ======================================================================== */

  /**
   * Check API health (no authentication required)
   */
  async health(): Promise<HealthStatus> {
    const url = `${this.url}/health`;

    try {
      const response = await fetch(url);
      const data = (await response.json()) as Record<string, unknown>;
      return this._parseHealthStatus(data);
    } catch (error) {
      throw new ConnectionError(`Failed to check health: ${String(error)}`);
    }
  }

  /* ========================================================================
   * Response Parsers
   * ======================================================================== */

  private _parseStoreResult(data: Record<string, unknown>): StoreResult {
    return {
      id: String(data.id || ''),
      type: String(data.type || '') as any,
      contentHash: String(data.content_hash || ''),
      deduplicated: Boolean(data.deduplicated),
      corroborated: Boolean(data.corroborated),
      supersedes: data.supersedes ? String(data.supersedes) : undefined,
      observedBy: Array.isArray(data.observed_by) ? (data.observed_by as string[]) : [],
      observationCount: Number(data.observation_count || 1),
      warning: data.warning ? String(data.warning) : undefined,
    };
  }

  private _parseSearchResponse(data: Record<string, unknown>): SearchResponse {
    const results = Array.isArray(data.results)
      ? (data.results as Array<Record<string, unknown>>).map((r) => ({
          id: String(r.id || ''),
          score: Number(r.score || 0),
          effectiveScore: Number(r.effective_score || 0),
          type: String(r.type || '') as any,
          content: String(r.text || r.content || ''),
          sourceAgent: String(r.source_agent || ''),
          clientId: String(r.client_id || 'global'),
          importance: String(r.importance || 'medium') as any,
          createdAt: String(r.created_at || ''),
          confidence: Number(r.confidence || 1),
          retrievalSources: Array.isArray(r.retrieval_sources)
            ? (r.retrieval_sources as string[])
            : undefined,
          entities: Array.isArray(r.entities) ? (r.entities as Array<{ name: string; type: string }>) : [],
        }))
      : [];

    return {
      query: String(data.query || ''),
      count: Number(data.count || 0),
      results,
      retrieval: data.retrieval ? (data.retrieval as any) : undefined,
    };
  }

  private _parseBriefing(data: Record<string, unknown>): Briefing {
    const parseBriefingEntries = (key: string) => {
      const entries = data[key] || data[`top_${key === 'events' ? 'events' : key}`];
      if (!Array.isArray(entries)) return [];
      return (entries as Array<Record<string, unknown>>).map((e) => ({
        id: String(e.id || ''),
        content: String(e.content || e.headline || ''),
        sourceAgent: String(e.source_agent || ''),
        clientId: String(e.client_id || 'global'),
        importance: String(e.importance || 'medium') as ImportanceLevel,
        createdAt: String(e.created_at || ''),
        confidence: Number(e.confidence || 1),
        truncated: Boolean(e.truncated),
      }));
    };

    const summary = (data.summary as Record<string, unknown> | undefined) || {
      totalMemories: 0,
      activeAgents: [],
      mentionedClients: [],
      topEntities: [],
      eventCount: 0,
      factCount: 0,
      statusCount: 0,
      decisionCount: 0,
    };

    return {
      since: String(data.since || ''),
      format: String(data.format || 'compact') as ResponseFormat,
      requestingAgent: String(data.requesting_agent || ''),
      generatedAt: String(data.generated_at || ''),
      summary: summary as any,
      events: parseBriefingEntries('events'),
      factsUpdated: parseBriefingEntries('facts_updated'),
      statusChanges: parseBriefingEntries('status_changes'),
      decisions: parseBriefingEntries('decisions'),
    };
  }

  private _parseStats(data: Record<string, unknown>): Stats {
    return {
      totalMemories: Number(data.total_memories || 0),
      vectorsCount: Number(data.vectors_count || 0),
      active: Number(data.active || 0),
      superseded: Number(data.superseded || 0),
      consolidated: Number(data.consolidated || 0),
      decayedBelow50Pct: Number(data.decayed_below_50pct || 0),
      byType: (data.by_type as Record<string, number>) || {},
      entities: data.entities as any,
      retrieval: data.retrieval as any,
    };
  }

  private _parseEntityList(data: Record<string, unknown>): Entity[] {
    const results = data.results || data.entities;
    if (!Array.isArray(results)) return [];
    return (results as Array<Record<string, unknown>>).map((e) => ({
      id: Number(e.id || 0),
      canonicalName: String(e.canonical_name || ''),
      entityType: String(e.entity_type || '') as any,
      mentionCount: Number(e.mention_count || 0),
      aliases: Array.isArray(e.aliases) ? (e.aliases as string[]) : [],
    }));
  }

  private _parseGraphData(data: Record<string, unknown>): GraphData {
    return {
      center: String(data.center || ''),
      nodes: (Array.isArray(data.nodes)
        ? (data.nodes as Array<Record<string, unknown>>).map((n) => ({
            id: String(n.id || ''),
            type: String(n.type || '') as any,
            mentionCount: Number(n.mention_count || 0),
          }))
        : []) as any,
      edges: (Array.isArray(data.edges)
        ? (data.edges as Array<Record<string, unknown>>).map((e) => ({
            source: String(e.source || ''),
            target: String(e.target || ''),
            type: String(e.type || 'co_occurrence'),
            strength: Number(e.strength || 1),
          }))
        : []) as any,
    };
  }

  private _parseConsolidationResponse(
    data: Record<string, unknown>
  ): ConsolidationJob | ConsolidationStatus {
    if (data.job_id) {
      return this._parseConsolidationJob(data);
    }
    return this._parseConsolidationStatus(data);
  }

  private _parseConsolidationJob(data: Record<string, unknown>): ConsolidationJob {
    return {
      jobId: String(data.job_id || ''),
      status: String(data.status || 'pending') as any,
      startedAt: data.started_at ? String(data.started_at) : undefined,
      completedAt: data.completed_at ? String(data.completed_at) : undefined,
      error: data.error ? String(data.error) : undefined,
      processed: data.processed ? Number(data.processed) : undefined,
    };
  }

  private _parseConsolidationStatus(data: Record<string, unknown>): ConsolidationStatus {
    return {
      isRunning: Boolean(data.is_running),
      lastRunAt: data.last_run_at ? String(data.last_run_at) : undefined,
      enabled: Boolean(data.enabled),
      interval: data.interval ? String(data.interval) : undefined,
      llm: data.llm as any,
    };
  }

  private _parseExportData(data: Record<string, unknown>): ExportData {
    const memoryList = data.data || data.memories;
    return {
      data: (Array.isArray(memoryList) ? (memoryList as unknown[]) : []) as Memory[],
      count: Number(data.count || 0),
      hasMore: Boolean(data.has_more),
    };
  }

  private _parseImportResult(data: Record<string, unknown>): ImportResult {
    return {
      imported: Number(data.imported || 0),
      deduplicated: Number(data.deduplicated || 0),
      failed: Number(data.failed || 0),
      errors: Array.isArray(data.errors) ? (data.errors as any) : undefined,
    };
  }

  private _parseUpdateResult(data: Record<string, unknown>): UpdateResult {
    return {
      id: String(data.id || ''),
      updated: Boolean(data.updated),
      updatedAt: String(data.updated_at || ''),
      updatedFields: (Array.isArray(data.updated_fields)
        ? (data.updated_fields as string[])
        : []) as any,
    };
  }

  private _parseBatchResult(data: Record<string, unknown>): BatchResult {
    return {
      total: Number(data.total || 0),
      stored: Number(data.stored || 0),
      deduplicated: Number(data.deduplicated || 0),
      failed: Number(data.failed || 0),
      results: (Array.isArray(data.results) ? (data.results as any[]) : []) as any,
    };
  }

  private _parseReflectResponse(data: Record<string, unknown>): ReflectResponse {
    return {
      topic: String(data.topic || ''),
      clientId: data.client_id ? String(data.client_id) : undefined,
      memoriesAnalyzed: Number(data.memories_analyzed || 0),
      reflection: (data.reflection as any) || {
        summary: '',
        patterns: [],
        timeline: [],
        contradictions: [],
        gaps: [],
      },
      llm: data.llm as any,
    };
  }

  private _parseClientBriefing(data: Record<string, unknown>): ClientBriefing {
    return {
      clientId: String(data.client_id || ''),
      byCategory: (data.by_category as Record<string, Memory[]>) || {},
      totalMemories: Number(data.total_memories || 0),
      generatedAt: String(data.generated_at || ''),
    };
  }

  private _parseHealthStatus(data: Record<string, unknown>): HealthStatus {
    return {
      status: String(data.status || 'error') as 'ok' | 'error',
      service: String(data.service || ''),
      timestamp: String(data.timestamp || ''),
    };
  }
}
