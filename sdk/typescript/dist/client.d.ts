/**
 * Core HTTP client for Zengram API
 */
import { BrainClientOptions, StoreMemoryInput, SearchOptions, QueryOptions, UpdateMemoryInput, BriefingOptions, ReflectOptions, EntityOptions, GraphOptions, ConsolidateOptions, ExportOptions, ImportData, StoreResult, SearchResponse, Briefing, Stats, Entity, GraphData, ClientBriefing, ConsolidationJob, ConsolidationStatus, ExportData, ImportResult, UpdateResult, ReflectResponse, HealthStatus, BatchResult } from './types';
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
export declare class BrainClient {
    private readonly url;
    private readonly apiKey;
    private readonly timeout;
    private readonly maxRetries;
    private readonly defaultSourceAgent?;
    /**
     * Create a new BrainClient instance
     */
    constructor(options?: BrainClientOptions);
    /**
     * Make an HTTP request with retry logic and error handling
     */
    private _request;
    /**
     * Sleep for a given number of milliseconds
     */
    private _sleep;
    /**
     * Store a memory in the Shared Brain
     */
    store(input: StoreMemoryInput): Promise<StoreResult>;
    /**
     * Store multiple memories in a single batch request
     */
    batchStore(inputs: StoreMemoryInput[]): Promise<BatchResult>;
    /**
     * Search memories using multi-path retrieval (vector + keyword + graph)
     */
    search(query: string, options?: SearchOptions): Promise<SearchResponse>;
    /**
     * Structured query (facts by key, statuses by subject, events by time)
     */
    query(options: QueryOptions): Promise<Record<string, unknown>>;
    /**
     * Update an existing memory
     */
    update(memoryId: string, input: UpdateMemoryInput): Promise<UpdateResult>;
    /**
     * Soft-delete a memory (mark as inactive)
     */
    delete(memoryId: string, reason?: string): Promise<void>;
    /**
     * Get a session briefing of what happened since a given time
     */
    briefing(since: string, options?: BriefingOptions): Promise<Briefing>;
    /**
     * Reflect on a topic by synthesizing patterns across memories
     */
    reflect(topic: string, options?: ReflectOptions): Promise<ReflectResponse>;
    /**
     * Get complete context about a client
     */
    clientBriefing(clientId: string): Promise<ClientBriefing>;
    /**
     * Get memory health statistics
     */
    stats(): Promise<Stats>;
    /**
     * Query the entity graph
     */
    entities(options?: EntityOptions): Promise<Entity[] | Record<string, unknown>>;
    /**
     * Explore entity relationships in the knowledge graph
     */
    graph(entity: string, options?: GraphOptions): Promise<GraphData>;
    /**
     * Trigger a consolidation run
     */
    consolidate(options?: ConsolidateOptions): Promise<ConsolidationJob | ConsolidationStatus>;
    /**
     * Get consolidation engine status
     */
    consolidationStatus(): Promise<ConsolidationStatus>;
    /**
     * Poll a consolidation job
     */
    consolidationJob(jobId: string): Promise<ConsolidationJob>;
    /**
     * Export memories as JSON
     */
    export(options?: ExportOptions): Promise<ExportData>;
    /**
     * Import memories from JSON
     */
    import(data: ImportData): Promise<ImportResult>;
    /**
     * Check API health (no authentication required)
     */
    health(): Promise<HealthStatus>;
    private _parseStoreResult;
    private _parseSearchResponse;
    private _parseBriefing;
    private _parseStats;
    private _parseEntityList;
    private _parseGraphData;
    private _parseConsolidationResponse;
    private _parseConsolidationJob;
    private _parseConsolidationStatus;
    private _parseExportData;
    private _parseImportResult;
    private _parseUpdateResult;
    private _parseBatchResult;
    private _parseReflectResponse;
    private _parseClientBriefing;
    private _parseHealthStatus;
}
//# sourceMappingURL=client.d.ts.map