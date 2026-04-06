/**
 * TypeScript type definitions for Zengram SDK
 */

/**
 * Memory type discriminator
 */
export type MemoryType = 'event' | 'fact' | 'decision' | 'status';

/**
 * Memory category (psychological storage classification)
 */
export type MemoryCategory = 'semantic' | 'episodic' | 'procedural';

/**
 * Importance level for prioritization
 */
export type ImportanceLevel = 'critical' | 'high' | 'medium' | 'low';

/**
 * Knowledge domain category
 */
export type KnowledgeCategory =
  | 'brand'
  | 'strategy'
  | 'meeting'
  | 'content'
  | 'technical'
  | 'relationship'
  | 'general';

/**
 * Format for search and briefing responses
 */
export type ResponseFormat = 'compact' | 'full' | 'summary' | 'index';

/**
 * Entity type classification
 */
export type EntityType =
  | 'client'
  | 'person'
  | 'system'
  | 'service'
  | 'domain'
  | 'technology'
  | 'workflow'
  | 'agent';

/**
 * Consolidation action type
 */
export type ConsolidateAction = 'run' | 'status' | 'job';

/**
 * Entity action type
 */
export type EntityAction = 'list' | 'get' | 'memories' | 'stats';

/* ============================================================================
 * Input Types
 * ============================================================================ */

/**
 * Options for BrainClient constructor
 */
export interface BrainClientOptions {
  /** Base URL for Zengram API (e.g., http://localhost:8084) */
  url?: string;
  /** API key for authentication */
  apiKey?: string;
  /** Default timeout in seconds (default: 15) */
  timeout?: number;
  /** Maximum number of retries for failed requests (default: 3) */
  maxRetries?: number;
  /** Default source_agent for store operations */
  defaultSourceAgent?: string;
}

/**
 * Input for storing a memory
 */
export interface StoreMemoryInput {
  /** Memory type: event, fact, decision, or status */
  type: MemoryType;
  /** Memory content text (max 10,000 chars) */
  content: string;
  /** Agent identifier (required unless defaultSourceAgent set) */
  sourceAgent?: string;
  /** Client/project slug or "global" */
  clientId?: string;
  /** Memory category for psychological classification */
  category?: MemoryCategory;
  /** Importance level for prioritization */
  importance?: ImportanceLevel;
  /** For facts: unique key for upsert/supersede (max 128 chars) */
  key?: string;
  /** For statuses: what system this status is about (max 256 chars) */
  subject?: string;
  /** For statuses: the current status value (max 256 chars) */
  statusValue?: string;
  /** Domain category for the memory */
  knowledgeCategory?: KnowledgeCategory;
  /** ISO 8601 timestamp when this fact became true */
  validFrom?: string;
  /** ISO 8601 timestamp when this fact stopped being true */
  validTo?: string;
  /** Arbitrary metadata (max 10KB, max 3 levels deep) */
  metadata?: Record<string, unknown>;
}

/**
 * Options for search queries
 */
export interface SearchOptions {
  /** Filter by memory type */
  type?: MemoryType;
  /** Filter by source agent */
  sourceAgent?: string;
  /** Filter by client */
  clientId?: string;
  /** Filter by memory category */
  category?: MemoryCategory;
  /** Maximum results (default 10, max 100) */
  limit?: number;
  /** Response format (default: compact) */
  format?: Exclude<ResponseFormat, 'summary' | 'index'>;
  /** Include superseded memories in results */
  includeSuperseded?: boolean;
  /** Filter by knowledge domain */
  knowledgeCategory?: KnowledgeCategory;
  /** ISO 8601 timestamp for temporal queries */
  atTime?: string;
  /** Filter by entity name */
  entity?: string;
}

/**
 * Options for structured queries
 */
export interface QueryOptions {
  /** Query type: events, facts, or statuses */
  type: 'events' | 'facts' | 'statuses';
  /** Filter by source agent */
  sourceAgent?: string;
  /** Filter by memory category */
  category?: MemoryCategory;
  /** Filter by client */
  clientId?: string;
  /** For events: ISO 8601 timestamp to filter by */
  since?: string;
  /** For facts: search by key */
  key?: string;
  /** For statuses: search by subject */
  subject?: string;
}

/**
 * Options for update operations
 */
export interface UpdateMemoryInput {
  /** New content (triggers re-embed) */
  content?: string;
  /** New importance level */
  importance?: ImportanceLevel;
  /** New knowledge category */
  knowledgeCategory?: KnowledgeCategory;
  /** New metadata (replaces existing) */
  metadata?: Record<string, unknown>;
}

/**
 * Options for briefing queries
 */
export interface BriefingOptions {
  /** Requesting agent (entries from this agent excluded unless include=all) */
  agent?: string;
  /** Set to "all" to include own entries */
  include?: 'all';
  /** Response format: compact, summary, or full */
  format?: Exclude<ResponseFormat, 'index'>;
  /** Maximum memories to retrieve (default 100, max 500) */
  limit?: number;
}

/**
 * Options for reflect queries
 */
export interface ReflectOptions {
  /** Scope reflection to a specific client */
  clientId?: string;
  /** Maximum memories to analyze (default 20, max 50) */
  limit?: number;
}

/**
 * Options for entity queries
 */
export interface EntityOptions {
  /** Action to perform: list, get, memories, or stats */
  action?: EntityAction;
  /** Entity name (required for get/memories actions) */
  name?: string;
  /** Filter by entity type (for list action) */
  type?: EntityType;
  /** Maximum results */
  limit?: number;
}

/**
 * Options for graph queries
 */
export interface GraphOptions {
  /** Traversal depth (default 1, max 3) */
  depth?: number;
  /** Minimum relationship strength */
  minStrength?: number;
}

/**
 * Options for consolidation
 */
export interface ConsolidateOptions {
  /** Block until consolidation completes */
  sync?: boolean;
}

/**
 * Options for export
 */
export interface ExportOptions {
  /** Filter by client */
  clientId?: string;
  /** Filter by memory type */
  type?: MemoryType;
  /** ISO 8601 timestamp: only memories after this */
  since?: string;
  /** Maximum memories to export (default 500, max 5000) */
  limit?: number;
}

/**
 * Data for importing memories
 */
export interface ImportData {
  /** Array of memory objects (same format as export output) */
  data: Array<Record<string, unknown>>;
}

/* ============================================================================
 * Response Types
 * ============================================================================ */

/**
 * A single memory from the Shared Brain
 */
export interface Memory {
  /** Unique memory ID */
  id: string;
  /** Memory type: event, fact, decision, or status */
  type: MemoryType;
  /** Memory content text */
  content: string;
  /** Agent that created/updated this memory */
  sourceAgent: string;
  /** Client/project slug (default: global) */
  clientId: string;
  /** Psychological storage category */
  category: MemoryCategory;
  /** Importance level */
  importance: ImportanceLevel;
  /** Knowledge domain category */
  knowledgeCategory: KnowledgeCategory;
  /** Confidence score (0-1) */
  confidence: number;
  /** Number of times accessed */
  accessCount: number;
  /** Whether this memory is active */
  active: boolean;
  /** ISO 8601 creation timestamp */
  createdAt: string;
  /** ISO 8601 last access timestamp */
  lastAccessedAt: string;
  /** Content hash for deduplication */
  contentHash: string;
  /** Extracted entities */
  entities: Array<{ name: string; type: string }>;
  /** Agents that have observed this memory */
  observedBy: string[];
  /** Number of observations */
  observationCount: number;
  /** UUID of memory this supersedes (if any) */
  supersedes?: string;
  /** UUID of memory that supersedes this (if any) */
  supersededBy?: string;
  /** For facts: unique key for upsert */
  key?: string;
  /** For statuses: what system this is about */
  subject?: string;
  /** For statuses: current status value */
  statusValue?: string;
  /** ISO 8601: when this fact became true */
  validFrom?: string;
  /** ISO 8601: when this fact stopped being true */
  validTo?: string;
  /** Arbitrary metadata */
  metadata?: Record<string, unknown>;
}

/**
 * A search result with scoring metadata
 */
export interface SearchResult {
  /** Unique memory ID */
  id: string;
  /** Raw retrieval score */
  score: number;
  /** Effective score after boosting */
  effectiveScore: number;
  /** Memory type */
  type: MemoryType;
  /** Memory content */
  content: string;
  /** Source agent */
  sourceAgent: string;
  /** Client/project slug */
  clientId: string;
  /** Importance level */
  importance: ImportanceLevel;
  /** ISO 8601 creation timestamp */
  createdAt: string;
  /** Confidence score */
  confidence: number;
  /** Retrieval sources (vector, keyword, graph) */
  retrievalSources?: string[];
  /** Extracted entities */
  entities: Array<{ name: string; type: string }>;
}

/**
 * Response from a search query
 */
export interface SearchResponse {
  /** The search query */
  query: string;
  /** Number of results */
  count: number;
  /** Search results */
  results: SearchResult[];
  /** Retrieval metadata (for format=full) */
  retrieval?: {
    multiPath: boolean;
    paths: Record<string, number>;
  };
}

/**
 * Response from storing a memory
 */
export interface StoreResult {
  /** Unique memory ID */
  id: string;
  /** Memory type */
  type: MemoryType;
  /** Content hash for deduplication */
  contentHash: string;
  /** True if exact duplicate from same agent */
  deduplicated?: boolean;
  /** True if cross-agent corroboration recorded */
  corroborated?: boolean;
  /** UUID of memory this supersedes (if any) */
  supersedes?: string;
  /** Agents observing this memory */
  observedBy: string[];
  /** Number of observations */
  observationCount: number;
  /** Optional warning message */
  warning?: string;
}

/**
 * A single briefing entry
 */
export interface BriefingEntry {
  /** Memory ID */
  id: string;
  /** Memory content */
  content: string;
  /** Source agent */
  sourceAgent: string;
  /** Client/project slug */
  clientId: string;
  /** Importance level */
  importance: ImportanceLevel;
  /** ISO 8601 creation timestamp */
  createdAt: string;
  /** Confidence score */
  confidence: number;
  /** Content was truncated in response */
  truncated: boolean;
}

/**
 * Session briefing response
 */
export interface Briefing {
  /** ISO 8601 timestamp of briefing start */
  since: string;
  /** Response format used */
  format: ResponseFormat;
  /** Requesting agent */
  requestingAgent: string;
  /** ISO 8601 generation timestamp */
  generatedAt: string;
  /** Summary statistics */
  summary: {
    totalMemories: number;
    activeAgents: string[];
    mentionedClients: string[];
    topEntities: string[];
    eventCount: number;
    factCount: number;
    statusCount: number;
    decisionCount: number;
  };
  /** Event entries */
  events: BriefingEntry[];
  /** Updated facts */
  factsUpdated: BriefingEntry[];
  /** Status changes */
  statusChanges: BriefingEntry[];
  /** Decisions */
  decisions: BriefingEntry[];
}

/**
 * Memory health statistics
 */
export interface Stats {
  /** Total memories in system */
  totalMemories: number;
  /** Memories with vectors */
  vectorsCount: number;
  /** Active memories */
  active: number;
  /** Superseded memories */
  superseded: number;
  /** Consolidated memories */
  consolidated: number;
  /** Memories with confidence below 50% */
  decayedBelow50Pct: number;
  /** Memory count by type */
  byType: Record<MemoryType, number>;
  /** Entity statistics */
  entities?: {
    total: number;
    byType: Record<EntityType, number>;
    topMentioned: string[];
  };
  /** Retrieval system status */
  retrieval?: {
    multiPath: boolean;
    keywordSearch: boolean;
    keywordIndexCount: number;
    graphSearch: boolean;
  };
}

/**
 * An entity from the knowledge graph
 */
export interface Entity {
  /** Entity database ID */
  id: number;
  /** Canonical entity name */
  canonicalName: string;
  /** Entity type classification */
  entityType: EntityType;
  /** Number of mentions in memories */
  mentionCount: number;
  /** Alternate names for this entity */
  aliases: string[];
}

/**
 * A node in the entity graph
 */
export interface GraphNode {
  /** Entity name */
  id: string;
  /** Entity type */
  type: EntityType;
  /** Number of mentions */
  mentionCount: number;
}

/**
 * An edge in the entity graph
 */
export interface GraphEdge {
  /** Source entity name */
  source: string;
  /** Target entity name */
  target: string;
  /** Edge type (e.g., co_occurrence) */
  type: string;
  /** Relationship strength (1+) */
  strength: number;
}

/**
 * Entity relationship graph data
 */
export interface GraphData {
  /** Center entity name */
  center: string;
  /** Graph nodes */
  nodes: GraphNode[];
  /** Graph edges */
  edges: GraphEdge[];
}

/**
 * Client briefing response
 */
export interface ClientBriefing {
  /** Client ID */
  clientId: string;
  /** Memories organized by knowledge category */
  byCategory: Record<KnowledgeCategory, Memory[]>;
  /** Total memory count */
  totalMemories: number;
  /** ISO 8601 generation timestamp */
  generatedAt: string;
}

/**
 * Consolidation job status
 */
export interface ConsolidationJob {
  /** Job ID */
  jobId: string;
  /** Job status: started, pending, running, completed, failed */
  status: 'started' | 'pending' | 'running' | 'completed' | 'failed';
  /** ISO 8601 start timestamp */
  startedAt?: string;
  /** ISO 8601 completion timestamp */
  completedAt?: string;
  /** Error message if status=failed */
  error?: string;
  /** Number of memories processed */
  processed?: number;
}

/**
 * Consolidation status
 */
export interface ConsolidationStatus {
  /** Engine is currently running */
  isRunning: boolean;
  /** ISO 8601 last run timestamp */
  lastRunAt?: string;
  /** Consolidation is enabled */
  enabled: boolean;
  /** Cron interval for automatic consolidation */
  interval?: string;
  /** LLM configuration */
  llm?: {
    provider: string;
    model: string;
  };
}

/**
 * Export response
 */
export interface ExportData {
  /** Array of exported memories */
  data: Memory[];
  /** Total exported */
  count: number;
  /** More records exist beyond this export */
  hasMore: boolean;
}

/**
 * Import result
 */
export interface ImportResult {
  /** Number of memories imported */
  imported: number;
  /** Number of memories deduplicated */
  deduplicated: number;
  /** Number of memories that failed */
  failed: number;
  /** Error details for failed imports */
  errors?: Array<{ index: number; reason: string }>;
}

/**
 * Update result
 */
export interface UpdateResult {
  /** Memory ID */
  id: string;
  /** Update was successful */
  updated: boolean;
  /** ISO 8601 update timestamp */
  updatedAt: string;
  /** Fields that were updated */
  updatedFields: (keyof UpdateMemoryInput)[];
}

/**
 * Batch store result
 */
export interface BatchResult {
  /** Total memories in batch */
  total: number;
  /** Successfully stored */
  stored: number;
  /** Deduplicated */
  deduplicated: number;
  /** Failed */
  failed: number;
  /** Results for each memory */
  results: Array<{ index: number; result: StoreResult; error?: string }>;
}

/**
 * Reflection synthesis result
 */
export interface ReflectResponse {
  /** The topic reflected on */
  topic: string;
  /** Client ID (if scoped) */
  clientId?: string;
  /** Number of memories analyzed */
  memoriesAnalyzed: number;
  /** Reflection synthesis */
  reflection: {
    /** Summary of patterns found */
    summary: string;
    /** Key patterns identified */
    patterns: string[];
    /** Timeline of events/changes */
    timeline: string[];
    /** Contradictions or inconsistencies */
    contradictions: string[];
    /** Knowledge gaps */
    gaps: string[];
  };
  /** LLM configuration used */
  llm?: {
    provider: string;
    model: string;
  };
}

/**
 * API health status
 */
export interface HealthStatus {
  /** Health status: ok or error */
  status: 'ok' | 'error';
  /** Service name */
  service: string;
  /** ISO 8601 timestamp */
  timestamp: string;
}

/**
 * Generic API response error
 */
export interface ErrorResponse {
  error: string;
  statusCode?: number;
}
