# Zengram TypeScript SDK

A complete TypeScript client library for the Zengram multi-agent memory system. Interact with the Shared Brain API from Node.js applications with full type safety and error handling.

## Installation

```bash
npm install @zensystemai/zengram-sdk
```

### Requirements

- Node.js >= 18
- No external runtime dependencies (uses native `fetch` API)

## Quick Start

```typescript
import { BrainClient } from '@zensystemai/zengram-sdk';

// Initialize the client
const brain = new BrainClient({
  url: 'http://localhost:8084',
  apiKey: 'your-api-key',
  defaultSourceAgent: 'my-agent'
});

// Store a memory
const result = await brain.store({
  type: 'fact',
  content: 'Next.js is a React framework for production',
  key: 'nextjs-definition',
  importance: 'high',
  knowledgeCategory: 'technical'
});

console.log(result.id); // UUID of stored memory

// Search for memories
const searchResults = await brain.search('React framework', {
  limit: 10,
  format: 'full'
});

console.log(searchResults.results); // Array of SearchResult

// Update a memory
await brain.update(result.id, {
  content: 'Updated content',
  importance: 'critical'
});

// Query structured data
const facts = await brain.query({
  type: 'facts',
  key: 'nextjs-definition'
});
```

## Core Methods

### Memory Operations

#### `store(input: StoreMemoryInput): Promise<StoreResult>`

Store a memory in the Shared Brain.

```typescript
const result = await brain.store({
  type: 'fact',                    // 'event', 'fact', 'decision', 'status'
  content: 'Memory content text',  // Max 10,000 chars
  sourceAgent: 'my-agent',         // Can use defaultSourceAgent
  clientId: 'acme-corp',           // Optional, default: 'global'
  category: 'semantic',            // 'semantic', 'episodic', 'procedural'
  importance: 'high',              // 'critical', 'high', 'medium', 'low'
  knowledgeCategory: 'technical',  // 'brand', 'strategy', 'technical', etc.
  key: 'unique-key',               // For facts only
  subject: 'deploy-status',        // For statuses only
  statusValue: 'running',          // For statuses only
  metadata: { custom: 'data' }
});

// Returns: { id, type, contentHash, deduplicated, observed_by, ... }
```

#### `batchStore(inputs: StoreMemoryInput[]): Promise<BatchResult>`

Store multiple memories in a single request.

```typescript
const result = await brain.batchStore([
  {
    type: 'fact',
    content: 'First memory',
    key: 'key-1'
  },
  {
    type: 'fact',
    content: 'Second memory',
    key: 'key-2'
  }
]);

console.log(result.stored);      // Number stored
console.log(result.failed);      // Number failed
```

#### `search(query: string, options?: SearchOptions): Promise<SearchResponse>`

Multi-path semantic search across all memories (vector + keyword + graph).

```typescript
const results = await brain.search('deployment pipeline', {
  limit: 20,
  clientId: 'acme-corp',
  type: 'fact',
  format: 'full',
  includeSuperseded: false,
  atTime: '2026-03-28T00:00:00Z'
});

results.results.forEach(result => {
  console.log(`${result.content} (score: ${result.effectiveScore})`);
});
```

#### `query(options: QueryOptions): Promise<Record<string, unknown>>`

Structured query: facts by key, statuses by subject, events by time.

```typescript
// Query facts by key
const facts = await brain.query({
  type: 'facts',
  key: 'my-fact-key'
});

// Query statuses by subject
const statuses = await brain.query({
  type: 'statuses',
  subject: 'deploy-pipeline'
});

// Query events since timestamp
const events = await brain.query({
  type: 'events',
  since: '2026-03-28T00:00:00Z',
  clientId: 'acme-corp'
});
```

#### `update(memoryId: string, input: UpdateMemoryInput): Promise<UpdateResult>`

Update an existing memory in place.

```typescript
const result = await brain.update('memory-uuid', {
  content: 'Updated content',
  importance: 'critical',
  knowledgeCategory: 'strategy',
  metadata: { version: 2 }
});

console.log(result.updatedFields); // ['content', 'importance']
```

#### `delete(memoryId: string, reason?: string): Promise<void>`

Soft-delete a memory (marks as inactive, not permanently removed).

```typescript
await brain.delete('memory-uuid', 'Incorrect information');
```

### Intelligence Operations

#### `briefing(since: string, options?: BriefingOptions): Promise<Briefing>`

Get a session briefing of what happened since a given time.

```typescript
const briefing = await brain.briefing('2026-03-28T00:00:00Z', {
  agent: 'claude-code',
  format: 'compact',
  limit: 100
});

console.log(briefing.summary);        // Statistics
console.log(briefing.events);         // Recent events
console.log(briefing.factsUpdated);   // Updated facts
console.log(briefing.statusChanges);  // Status changes
```

#### `reflect(topic: string, options?: ReflectOptions): Promise<ReflectResponse>`

LLM-powered synthesis of patterns across memories on a topic.

```typescript
const reflection = await brain.reflect('deployment pipeline', {
  clientId: 'acme-corp',
  limit: 20
});

console.log(reflection.reflection.summary);      // Summary
console.log(reflection.reflection.patterns);     // Identified patterns
console.log(reflection.reflection.timeline);     // Timeline of events
console.log(reflection.reflection.contradictions); // Inconsistencies
console.log(reflection.reflection.gaps);         // Knowledge gaps
```

#### `clientBriefing(clientId: string): Promise<ClientBriefing>`

Get complete context about a client/project.

```typescript
const context = await brain.clientBriefing('acme-corp');

context.byCategory.technical;   // Technical memories
context.byCategory.strategy;    // Strategy memories
context.byCategory.meeting;     // Meeting notes
```

### System Operations

#### `stats(): Promise<Stats>`

Get memory health statistics.

```typescript
const stats = await brain.stats();

console.log(stats.totalMemories);     // Total count
console.log(stats.active);            // Active memories
console.log(stats.byType);            // Count by type
console.log(stats.entities);          // Entity statistics
console.log(stats.retrieval);         // Retrieval system status
```

#### `entities(options?: EntityOptions): Promise<Entity[] | Record<string, unknown>>`

Query the entity graph (people, technologies, clients, etc.).

```typescript
// List all entities
const entities = await brain.entities({ action: 'list', limit: 50 });

// Get single entity
const entity = await brain.entities({
  action: 'get',
  name: 'Next.js'
});

// Get memories linked to entity
const memories = await brain.entities({
  action: 'memories',
  name: 'React',
  limit: 20
});

// Get entity statistics
const stats = await brain.entities({ action: 'stats' });
```

#### `graph(entity: string, options?: GraphOptions): Promise<GraphData>`

Explore entity relationships in the knowledge graph.

```typescript
const graph = await brain.graph('Next.js', {
  depth: 2,
  minStrength: 1
});

console.log(graph.nodes);    // Related entities
console.log(graph.edges);    // Relationships
```

#### `consolidate(options?: ConsolidateOptions): Promise<ConsolidationJob | ConsolidationStatus>`

Trigger a memory consolidation run.

```typescript
// Async consolidation (returns job ID)
const job = await brain.consolidate();
console.log(job.jobId);

// Sync consolidation (blocks until complete)
const result = await brain.consolidate({ sync: true });

// Check consolidation status
const status = await brain.consolidationStatus();
console.log(status.isRunning);

// Poll job status
const jobStatus = await brain.consolidationJob(job.jobId);
```

### Bulk Operations

#### `export(options?: ExportOptions): Promise<ExportData>`

Export memories as JSON.

```typescript
const exported = await brain.export({
  clientId: 'acme-corp',
  type: 'fact',
  limit: 1000
});

console.log(exported.data);      // Array of memories
console.log(exported.hasMore);   // More records available
```

#### `import(data: ImportData): Promise<ImportResult>`

Import memories from JSON.

```typescript
const result = await brain.import({
  data: [
    {
      type: 'fact',
      content: 'Imported memory',
      source_agent: 'import-tool',
      client_id: 'acme-corp'
    }
  ]
});

console.log(result.imported);      // Newly imported
console.log(result.deduplicated);  // Already existed
```

### Health Check

#### `health(): Promise<HealthStatus>`

Check API health (no authentication required).

```typescript
const health = await brain.health();
console.log(health.status);   // 'ok' or 'error'
```

## Error Handling

The SDK provides typed error classes for different error scenarios:

```typescript
import {
  BrainError,
  AuthenticationError,
  NotFoundError,
  ValidationError,
  RateLimitError,
  PermissionError,
  TimeoutError,
  ConnectionError
} from '@zensystemai/zengram-sdk';

try {
  await brain.search('query');
} catch (error) {
  if (error instanceof AuthenticationError) {
    console.error('Invalid API key');
  } else if (error instanceof RateLimitError) {
    console.error(`Rate limited. Retry after ${error.retryAfter}s`);
  } else if (error instanceof NotFoundError) {
    console.error('Memory not found');
  } else if (error instanceof ValidationError) {
    console.error('Invalid request');
  } else if (error instanceof BrainError) {
    console.error(`API error ${error.statusCode}: ${error.message}`);
  }
}
```

## Type-Safe Usage

The SDK exports all TypeScript types for full IDE support:

```typescript
import type {
  MemoryType,
  ImportanceLevel,
  SearchOptions,
  StoreResult,
  Briefing,
  ReflectResponse
} from '@zensystemai/zengram-sdk';

// Use types in your code
const storeResult: StoreResult = await brain.store({...});
const briefing: Briefing = await brain.briefing('...');
```

## Configuration

### Constructor Options

```typescript
interface BrainClientOptions {
  /** Base URL for Zengram API (default: http://localhost:8084) */
  url?: string;
  
  /** API key for authentication */
  apiKey?: string;
  
  /** Default timeout in seconds (default: 15) */
  timeout?: number;
  
  /** Maximum number of retries (default: 3) */
  maxRetries?: number;
  
  /** Default source_agent for store operations */
  defaultSourceAgent?: string;
}
```

### Environment Variables

```bash
# .env file
ZENGRAM_URL=http://localhost:8084
ZENGRAM_API_KEY=your-api-key
ZENGRAM_DEFAULT_AGENT=my-agent
```

```typescript
const brain = new BrainClient({
  url: process.env.ZENGRAM_URL,
  apiKey: process.env.ZENGRAM_API_KEY,
  defaultSourceAgent: process.env.ZENGRAM_DEFAULT_AGENT
});
```

## Advanced Examples

### Batch Operations

```typescript
// Store multiple memories efficiently
const memories = [
  { type: 'fact' as const, content: 'Memory 1', key: 'key-1' },
  { type: 'fact' as const, content: 'Memory 2', key: 'key-2' },
  { type: 'fact' as const, content: 'Memory 3', key: 'key-3' }
];

const result = await brain.batchStore(memories);
console.log(`Stored: ${result.stored}, Failed: ${result.failed}`);
```

### Temporal Queries

```typescript
// Query memories valid at a specific time
const pastResults = await brain.search('deployment', {
  atTime: '2026-03-15T00:00:00Z'
});
```

### Cross-Agent Collaboration

```typescript
// Store from multiple agents (with appropriate API keys)
await brain.store({
  type: 'fact',
  content: 'Observed by multiple agents',
  sourceAgent: 'agent-1'
});

// Same memory observed by different agent
await brain.store({
  type: 'fact',
  content: 'Observed by multiple agents',
  sourceAgent: 'agent-2'  // Creates corroboration
});
```

## Contributing

Issues and pull requests welcome on [GitHub](https://github.com/ZenSystemAI/zengram).

## License

MIT - See LICENSE file for details.

## Related

- [Python SDK](../python/) - Python client library
- [MCP Server](../../mcp-server/) - MCP tool implementations
- [API Reference](../../docs/api-reference.md) - Full API documentation
- [Architecture](../../docs/architecture.md) - System design and data flow
