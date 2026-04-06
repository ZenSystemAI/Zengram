"use strict";
/**
 * Core HTTP client for Zengram API
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrainClient = void 0;
const crypto_1 = require("crypto");
const errors_1 = require("./errors");
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
class BrainClient {
    url;
    apiKey;
    timeout;
    maxRetries;
    defaultSourceAgent;
    /**
     * Create a new BrainClient instance
     */
    constructor(options = {}) {
        this.url = options.url?.replace(/\/$/, '') || 'http://localhost:8084';
        this.apiKey = options.apiKey || '';
        this.timeout = (options.timeout || 15) * 1000; // Convert seconds to ms
        this.maxRetries = options.maxRetries ?? 3;
        this.defaultSourceAgent = options.defaultSourceAgent;
    }
    /**
     * Make an HTTP request with retry logic and error handling
     */
    async _request(method, path, options) {
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
        let lastError = null;
        let responseBody = '';
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            try {
                const controller = new AbortController();
                const timeoutHandle = setTimeout(() => controller.abort(), timeout);
                const headers = {
                    'x-api-key': this.apiKey,
                    'Content-Type': 'application/json',
                    'x-request-id': (0, crypto_1.randomUUID)(),
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
                    throw new errors_1.RateLimitError(`Rate limit exceeded: ${responseBody}`, retryAfter, 429, responseBody);
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
                        throw new errors_1.AuthenticationError(`Unauthorized: ${responseBody}`, responseBody);
                    }
                    else if (response.status === 403) {
                        throw new errors_1.PermissionError(`Forbidden: ${responseBody}`, responseBody);
                    }
                    else if (response.status === 404) {
                        throw new errors_1.NotFoundError(`Not found: ${responseBody}`, responseBody);
                    }
                    else if (response.status === 400) {
                        throw new errors_1.ValidationError(`Invalid request: ${responseBody}`, responseBody);
                    }
                    else {
                        throw new errors_1.BrainError(`API error ${response.status}: ${responseBody}`, response.status, responseBody);
                    }
                }
                // Parse and return response
                return JSON.parse(responseBody);
            }
            catch (error) {
                // Handle AbortError (timeout)
                if (error instanceof Error && error.name === 'AbortError') {
                    lastError = new errors_1.TimeoutError(`Request timed out after ${timeout}ms: ${method} ${path}`);
                    if (attempt < this.maxRetries) {
                        const backoff = RETRY_BACKOFF_BASE * Math.pow(2, attempt);
                        await this._sleep(backoff);
                        continue;
                    }
                    throw lastError;
                }
                // Handle TypeError (network errors)
                if (error instanceof TypeError) {
                    lastError = new errors_1.ConnectionError(`Connection failed: ${this.url}${path}`);
                    if (attempt < this.maxRetries) {
                        const backoff = RETRY_BACKOFF_BASE * Math.pow(2, attempt);
                        await this._sleep(backoff);
                        continue;
                    }
                    throw lastError;
                }
                // Re-throw known error types
                if (error instanceof errors_1.BrainError) {
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
        throw lastError || new errors_1.BrainError(`Request failed after ${this.maxRetries + 1} attempts`);
    }
    /**
     * Sleep for a given number of milliseconds
     */
    _sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
    /* ========================================================================
     * Memory Operations
     * ======================================================================== */
    /**
     * Store a memory in the Shared Brain
     */
    async store(input) {
        const sourceAgent = input.sourceAgent || this.defaultSourceAgent;
        if (!sourceAgent) {
            throw new errors_1.ValidationError('source_agent is required (pass it in input or set defaultSourceAgent)');
        }
        const body = {
            type: input.type,
            content: input.content,
            source_agent: sourceAgent,
        };
        if (input.clientId !== undefined)
            body.client_id = input.clientId;
        if (input.category !== undefined)
            body.category = input.category;
        if (input.importance !== undefined)
            body.importance = input.importance;
        if (input.key !== undefined)
            body.key = input.key;
        if (input.subject !== undefined)
            body.subject = input.subject;
        if (input.statusValue !== undefined)
            body.status_value = input.statusValue;
        if (input.knowledgeCategory !== undefined)
            body.knowledge_category = input.knowledgeCategory;
        if (input.validFrom !== undefined)
            body.valid_from = input.validFrom;
        if (input.validTo !== undefined)
            body.valid_to = input.validTo;
        if (input.metadata !== undefined)
            body.metadata = input.metadata;
        const data = await this._request('POST', '/memory', {
            json: body,
        });
        return this._parseStoreResult(data);
    }
    /**
     * Store multiple memories in a single batch request
     */
    async batchStore(inputs) {
        if (inputs.length === 0) {
            return { total: 0, stored: 0, deduplicated: 0, failed: 0, results: [] };
        }
        const memories = inputs.map((input) => {
            const sourceAgent = input.sourceAgent || this.defaultSourceAgent;
            if (!sourceAgent) {
                throw new errors_1.ValidationError('source_agent is required for all memories in batch');
            }
            const body = {
                type: input.type,
                content: input.content,
                source_agent: sourceAgent,
            };
            if (input.clientId !== undefined)
                body.client_id = input.clientId;
            if (input.category !== undefined)
                body.category = input.category;
            if (input.importance !== undefined)
                body.importance = input.importance;
            if (input.key !== undefined)
                body.key = input.key;
            if (input.subject !== undefined)
                body.subject = input.subject;
            if (input.statusValue !== undefined)
                body.status_value = input.statusValue;
            if (input.knowledgeCategory !== undefined)
                body.knowledge_category = input.knowledgeCategory;
            if (input.validFrom !== undefined)
                body.valid_from = input.validFrom;
            if (input.validTo !== undefined)
                body.valid_to = input.validTo;
            if (input.metadata !== undefined)
                body.metadata = input.metadata;
            return body;
        });
        const data = await this._request('POST', '/memory/batch', {
            json: { memories },
        });
        return this._parseBatchResult(data);
    }
    /**
     * Search memories using multi-path retrieval (vector + keyword + graph)
     */
    async search(query, options) {
        const params = { q: query };
        if (options?.type !== undefined)
            params.type = options.type;
        if (options?.sourceAgent !== undefined)
            params.source_agent = options.sourceAgent;
        if (options?.clientId !== undefined)
            params.client_id = options.clientId;
        if (options?.category !== undefined)
            params.category = options.category;
        if (options?.limit !== undefined)
            params.limit = options.limit;
        if (options?.format !== undefined)
            params.format = options.format;
        if (options?.includeSuperseded)
            params.include_superseded = 'true';
        if (options?.knowledgeCategory !== undefined)
            params.knowledge_category = options.knowledgeCategory;
        if (options?.atTime !== undefined)
            params.at_time = options.atTime;
        if (options?.entity !== undefined)
            params.entity = options.entity;
        const data = await this._request('GET', '/memory/search', {
            params,
        });
        return this._parseSearchResponse(data);
    }
    /**
     * Structured query (facts by key, statuses by subject, events by time)
     */
    async query(options) {
        const params = { type: options.type };
        if (options.sourceAgent !== undefined)
            params.source_agent = options.sourceAgent;
        if (options.category !== undefined)
            params.category = options.category;
        if (options.clientId !== undefined)
            params.client_id = options.clientId;
        if (options.since !== undefined)
            params.since = options.since;
        if (options.key !== undefined)
            params.key = options.key;
        if (options.subject !== undefined)
            params.subject = options.subject;
        return this._request('GET', '/memory/query', { params });
    }
    /**
     * Update an existing memory
     */
    async update(memoryId, input) {
        const body = {};
        if (input.content !== undefined)
            body.content = input.content;
        if (input.importance !== undefined)
            body.importance = input.importance;
        if (input.knowledgeCategory !== undefined)
            body.knowledge_category = input.knowledgeCategory;
        if (input.metadata !== undefined)
            body.metadata = input.metadata;
        if (Object.keys(body).length === 0) {
            throw new errors_1.ValidationError('Must provide at least one field to update');
        }
        const data = await this._request('PATCH', `/memory/${memoryId}`, {
            json: body,
        });
        return this._parseUpdateResult(data);
    }
    /**
     * Soft-delete a memory (mark as inactive)
     */
    async delete(memoryId, reason) {
        const body = {};
        if (reason !== undefined)
            body.reason = reason;
        try {
            await this._request('DELETE', `/memory/${memoryId}`, { json: body });
        }
        catch (error) {
            if (error instanceof errors_1.NotFoundError || error instanceof errors_1.PermissionError) {
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
    async briefing(since, options) {
        const params = { since };
        if (options?.agent !== undefined)
            params.agent = options.agent;
        if (options?.include !== undefined)
            params.include = options.include;
        if (options?.format !== undefined)
            params.format = options.format;
        if (options?.limit !== undefined)
            params.limit = options.limit;
        const data = await this._request('GET', '/briefing', { params });
        return this._parseBriefing(data);
    }
    /**
     * Reflect on a topic by synthesizing patterns across memories
     */
    async reflect(topic, options) {
        const body = { topic };
        if (options?.clientId !== undefined)
            body.client_id = options.clientId;
        if (options?.limit !== undefined)
            body.limit = options.limit;
        const data = await this._request('POST', '/reflect', {
            json: body,
            timeout: CONSOLIDATION_TIMEOUT,
        });
        return this._parseReflectResponse(data);
    }
    /**
     * Get complete context about a client
     */
    async clientBriefing(clientId) {
        const data = await this._request('GET', `/client/${clientId}`);
        return this._parseClientBriefing(data);
    }
    /* ========================================================================
     * System Operations
     * ======================================================================== */
    /**
     * Get memory health statistics
     */
    async stats() {
        const data = await this._request('GET', '/stats');
        return this._parseStats(data);
    }
    /**
     * Query the entity graph
     */
    async entities(options) {
        const action = options?.action || 'list';
        const name = options?.name;
        if (action === 'stats') {
            return this._request('GET', '/entities/stats');
        }
        else if (action === 'get') {
            if (!name)
                throw new errors_1.ValidationError('name is required for action=get');
            return this._request('GET', `/entities/${name}`);
        }
        else if (action === 'memories') {
            if (!name)
                throw new errors_1.ValidationError('name is required for action=memories');
            const params = {};
            if (options?.limit !== undefined)
                params.limit = options.limit;
            return this._request('GET', `/entities/${name}/memories`, { params });
        }
        else {
            const params = {};
            if (options?.type !== undefined)
                params.type = options.type;
            if (options?.limit !== undefined)
                params.limit = options.limit;
            const data = await this._request('GET', '/entities', { params });
            return this._parseEntityList(data);
        }
    }
    /**
     * Explore entity relationships in the knowledge graph
     */
    async graph(entity, options) {
        const params = {};
        if (options?.depth !== undefined)
            params.depth = options.depth;
        if (options?.minStrength !== undefined)
            params.min_strength = options.minStrength;
        const data = await this._request('GET', `/graph/${entity}`, { params });
        return this._parseGraphData(data);
    }
    /**
     * Trigger a consolidation run
     */
    async consolidate(options) {
        const params = {};
        if (options?.sync)
            params.sync = 'true';
        const data = await this._request('POST', '/consolidate', {
            params,
            timeout: options?.sync ? CONSOLIDATION_TIMEOUT : this.timeout,
        });
        return this._parseConsolidationResponse(data);
    }
    /**
     * Get consolidation engine status
     */
    async consolidationStatus() {
        const data = await this._request('GET', '/consolidate/status');
        return this._parseConsolidationStatus(data);
    }
    /**
     * Poll a consolidation job
     */
    async consolidationJob(jobId) {
        const data = await this._request('GET', `/consolidate/job/${jobId}`);
        return this._parseConsolidationJob(data);
    }
    /* ========================================================================
     * Bulk Operations
     * ======================================================================== */
    /**
     * Export memories as JSON
     */
    async export(options) {
        const params = {};
        if (options?.clientId !== undefined)
            params.client_id = options.clientId;
        if (options?.type !== undefined)
            params.type = options.type;
        if (options?.since !== undefined)
            params.since = options.since;
        if (options?.limit !== undefined)
            params.limit = options.limit;
        const data = await this._request('GET', '/export', { params });
        return this._parseExportData(data);
    }
    /**
     * Import memories from JSON
     */
    async import(data) {
        const body = { data: data.data };
        const result = await this._request('POST', '/export/import', {
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
    async health() {
        const url = `${this.url}/health`;
        try {
            const response = await fetch(url);
            const data = (await response.json());
            return this._parseHealthStatus(data);
        }
        catch (error) {
            throw new errors_1.ConnectionError(`Failed to check health: ${String(error)}`);
        }
    }
    /* ========================================================================
     * Response Parsers
     * ======================================================================== */
    _parseStoreResult(data) {
        return {
            id: String(data.id || ''),
            type: String(data.type || ''),
            contentHash: String(data.content_hash || ''),
            deduplicated: Boolean(data.deduplicated),
            corroborated: Boolean(data.corroborated),
            supersedes: data.supersedes ? String(data.supersedes) : undefined,
            observedBy: Array.isArray(data.observed_by) ? data.observed_by : [],
            observationCount: Number(data.observation_count || 1),
            warning: data.warning ? String(data.warning) : undefined,
        };
    }
    _parseSearchResponse(data) {
        const results = Array.isArray(data.results)
            ? data.results.map((r) => ({
                id: String(r.id || ''),
                score: Number(r.score || 0),
                effectiveScore: Number(r.effective_score || 0),
                type: String(r.type || ''),
                content: String(r.text || r.content || ''),
                sourceAgent: String(r.source_agent || ''),
                clientId: String(r.client_id || 'global'),
                importance: String(r.importance || 'medium'),
                createdAt: String(r.created_at || ''),
                confidence: Number(r.confidence || 1),
                retrievalSources: Array.isArray(r.retrieval_sources)
                    ? r.retrieval_sources
                    : undefined,
                entities: Array.isArray(r.entities) ? r.entities : [],
            }))
            : [];
        return {
            query: String(data.query || ''),
            count: Number(data.count || 0),
            results,
            retrieval: data.retrieval ? data.retrieval : undefined,
        };
    }
    _parseBriefing(data) {
        const parseBriefingEntries = (key) => {
            const entries = data[key] || data[`top_${key === 'events' ? 'events' : key}`];
            if (!Array.isArray(entries))
                return [];
            return entries.map((e) => ({
                id: String(e.id || ''),
                content: String(e.content || e.headline || ''),
                sourceAgent: String(e.source_agent || ''),
                clientId: String(e.client_id || 'global'),
                importance: String(e.importance || 'medium'),
                createdAt: String(e.created_at || ''),
                confidence: Number(e.confidence || 1),
                truncated: Boolean(e.truncated),
            }));
        };
        const summary = data.summary || {
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
            format: String(data.format || 'compact'),
            requestingAgent: String(data.requesting_agent || ''),
            generatedAt: String(data.generated_at || ''),
            summary: summary,
            events: parseBriefingEntries('events'),
            factsUpdated: parseBriefingEntries('facts_updated'),
            statusChanges: parseBriefingEntries('status_changes'),
            decisions: parseBriefingEntries('decisions'),
        };
    }
    _parseStats(data) {
        return {
            totalMemories: Number(data.total_memories || 0),
            vectorsCount: Number(data.vectors_count || 0),
            active: Number(data.active || 0),
            superseded: Number(data.superseded || 0),
            consolidated: Number(data.consolidated || 0),
            decayedBelow50Pct: Number(data.decayed_below_50pct || 0),
            byType: data.by_type || {},
            entities: data.entities,
            retrieval: data.retrieval,
        };
    }
    _parseEntityList(data) {
        const results = data.results || data.entities;
        if (!Array.isArray(results))
            return [];
        return results.map((e) => ({
            id: Number(e.id || 0),
            canonicalName: String(e.canonical_name || ''),
            entityType: String(e.entity_type || ''),
            mentionCount: Number(e.mention_count || 0),
            aliases: Array.isArray(e.aliases) ? e.aliases : [],
        }));
    }
    _parseGraphData(data) {
        return {
            center: String(data.center || ''),
            nodes: (Array.isArray(data.nodes)
                ? data.nodes.map((n) => ({
                    id: String(n.id || ''),
                    type: String(n.type || ''),
                    mentionCount: Number(n.mention_count || 0),
                }))
                : []),
            edges: (Array.isArray(data.edges)
                ? data.edges.map((e) => ({
                    source: String(e.source || ''),
                    target: String(e.target || ''),
                    type: String(e.type || 'co_occurrence'),
                    strength: Number(e.strength || 1),
                }))
                : []),
        };
    }
    _parseConsolidationResponse(data) {
        if (data.job_id) {
            return this._parseConsolidationJob(data);
        }
        return this._parseConsolidationStatus(data);
    }
    _parseConsolidationJob(data) {
        return {
            jobId: String(data.job_id || ''),
            status: String(data.status || 'pending'),
            startedAt: data.started_at ? String(data.started_at) : undefined,
            completedAt: data.completed_at ? String(data.completed_at) : undefined,
            error: data.error ? String(data.error) : undefined,
            processed: data.processed ? Number(data.processed) : undefined,
        };
    }
    _parseConsolidationStatus(data) {
        return {
            isRunning: Boolean(data.is_running),
            lastRunAt: data.last_run_at ? String(data.last_run_at) : undefined,
            enabled: Boolean(data.enabled),
            interval: data.interval ? String(data.interval) : undefined,
            llm: data.llm,
        };
    }
    _parseExportData(data) {
        const memoryList = data.data || data.memories;
        return {
            data: (Array.isArray(memoryList) ? memoryList : []),
            count: Number(data.count || 0),
            hasMore: Boolean(data.has_more),
        };
    }
    _parseImportResult(data) {
        return {
            imported: Number(data.imported || 0),
            deduplicated: Number(data.deduplicated || 0),
            failed: Number(data.failed || 0),
            errors: Array.isArray(data.errors) ? data.errors : undefined,
        };
    }
    _parseUpdateResult(data) {
        return {
            id: String(data.id || ''),
            updated: Boolean(data.updated),
            updatedAt: String(data.updated_at || ''),
            updatedFields: (Array.isArray(data.updated_fields)
                ? data.updated_fields
                : []),
        };
    }
    _parseBatchResult(data) {
        return {
            total: Number(data.total || 0),
            stored: Number(data.stored || 0),
            deduplicated: Number(data.deduplicated || 0),
            failed: Number(data.failed || 0),
            results: (Array.isArray(data.results) ? data.results : []),
        };
    }
    _parseReflectResponse(data) {
        return {
            topic: String(data.topic || ''),
            clientId: data.client_id ? String(data.client_id) : undefined,
            memoriesAnalyzed: Number(data.memories_analyzed || 0),
            reflection: data.reflection || {
                summary: '',
                patterns: [],
                timeline: [],
                contradictions: [],
                gaps: [],
            },
            llm: data.llm,
        };
    }
    _parseClientBriefing(data) {
        return {
            clientId: String(data.client_id || ''),
            byCategory: data.by_category || {},
            totalMemories: Number(data.total_memories || 0),
            generatedAt: String(data.generated_at || ''),
        };
    }
    _parseHealthStatus(data) {
        return {
            status: String(data.status || 'error'),
            service: String(data.service || ''),
            timestamp: String(data.timestamp || ''),
        };
    }
}
exports.BrainClient = BrainClient;
//# sourceMappingURL=client.js.map