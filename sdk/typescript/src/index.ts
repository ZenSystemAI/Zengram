/**
 * Zengram TypeScript SDK
 * A complete TypeScript client for the Zengram multi-agent memory system
 */

export { BrainClient } from './client';

// Error classes
export {
  BrainError,
  RateLimitError,
  AuthenticationError,
  NotFoundError,
  ValidationError,
  PermissionError,
  TimeoutError,
  ConnectionError,
} from './errors';

// Types
export type {
  // Type discriminators
  MemoryType,
  MemoryCategory,
  ImportanceLevel,
  KnowledgeCategory,
  ResponseFormat,
  EntityType,
  ConsolidateAction,
  EntityAction,
  // Input types
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
  // Response types
  Memory,
  SearchResult,
  SearchResponse,
  StoreResult,
  BriefingEntry,
  Briefing,
  Stats,
  Entity,
  GraphNode,
  GraphEdge,
  GraphData,
  ClientBriefing,
  ConsolidationJob,
  ConsolidationStatus,
  ExportData,
  ImportResult,
  UpdateResult,
  BatchResult,
  ReflectResponse,
  HealthStatus,
  ErrorResponse,
} from './types';
