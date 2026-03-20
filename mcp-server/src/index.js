#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const API_URL = process.env.BRAIN_API_URL || 'http://localhost:8084';
const API_KEY = process.env.BRAIN_API_KEY;
const DEFAULT_TIMEOUT = parseInt(process.env.BRAIN_MCP_TIMEOUT) || 15000;
const CONSOLIDATION_TIMEOUT = parseInt(process.env.BRAIN_MCP_CONSOLIDATION_TIMEOUT) || 120000;

if (!API_KEY) {
  console.error('[mcp] BRAIN_API_KEY environment variable is required');
  process.exit(1);
}

async function apiRequest(path, options = {}) {
  const url = `${API_URL}${path}`;
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': API_KEY,
    ...options.headers,
  };

  const isConsolidation = path.startsWith('/consolidate') && options.method === 'POST';
  const timeoutMs = options.timeout || (isConsolidation ? CONSOLIDATION_TIMEOUT : DEFAULT_TIMEOUT);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, headers, signal: controller.signal });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API ${options.method || 'GET'} ${path}: ${res.status} ${text}`);
    }
    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

const server = new Server(
  { name: 'shared-brain', version: '1.4.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'brain_store',
      description: 'Store a memory in the Shared Brain. Use this to record events (something happened), facts (persistent knowledge), decisions (choices made and why), or status updates (current state of systems/workflows). All agents share this memory. Duplicate content is automatically detected and deduplicated. Facts and statuses with matching keys/subjects automatically supersede older versions.',
      inputSchema: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['event', 'fact', 'decision', 'status'],
            description: 'Memory type. event=something happened (append-only), fact=persistent knowledge (upsertable by key), decision=choice made and why (append-only), status=current state (update in place by subject)',
          },
          content: {
            type: 'string',
            description: 'The memory content. Be specific and include context.',
          },
          source_agent: {
            type: 'string',
            description: 'Identifier for the agent storing this memory (e.g. "claude-code", "my-agent", "n8n")',
          },
          client_id: {
            type: 'string',
            description: 'Project or client slug (e.g. "acme-corp") or "global" for system-wide memories. Default: global',
          },
          category: {
            type: 'string',
            enum: ['semantic', 'episodic', 'procedural'],
            description: 'semantic=concepts/knowledge, episodic=events/experiences, procedural=how-to/processes',
          },
          importance: {
            type: 'string',
            enum: ['critical', 'high', 'medium', 'low'],
            description: 'How important is this memory. Default: medium',
          },
          key: {
            type: 'string',
            description: 'For facts only: unique key for upsert (e.g. "acme-api-status"). When a fact with this key exists, the new one supersedes it.',
          },
          subject: {
            type: 'string',
            description: 'For status only: what system/workflow this status is about. When a status with this subject exists, the new one supersedes it.',
          },
          status_value: {
            type: 'string',
            description: 'For status only: the current status value',
          },
          knowledge_category: {
            type: 'string',
            enum: ['brand', 'strategy', 'meeting', 'content', 'technical', 'relationship', 'general'],
            description: 'Domain category: brand=voice/identity, strategy=plans/positioning, meeting=call takeaways, content=published work, technical=hosting/CMS/SEO issues, relationship=contacts/preferences, general=default',
          },
        },
        required: ['type', 'content', 'source_agent'],
      },
    },
    {
      name: 'brain_search',
      description: 'Semantic search across all shared memories from all agents. Results are ranked by similarity * confidence. Returns compact format (truncated content) by default to save tokens.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Natural language search query',
          },
          type: {
            type: 'string',
            enum: ['event', 'fact', 'decision', 'status'],
            description: 'Filter by memory type (optional)',
          },
          source_agent: {
            type: 'string',
            description: 'Filter by agent (optional)',
          },
          client_id: {
            type: 'string',
            description: 'Filter by client (optional)',
          },
          limit: {
            type: 'number',
            description: 'Max results (default 10)',
          },
          format: {
            type: 'string',
            enum: ['compact', 'full'],
            description: 'compact (default): truncated to 200 chars, essential fields only. full: complete content + all metadata.',
          },
          include_superseded: {
            type: 'boolean',
            description: 'Set to true to include superseded memories in results (default: false)',
          },
          knowledge_category: {
            type: 'string',
            enum: ['brand', 'strategy', 'meeting', 'content', 'technical', 'relationship', 'general'],
            description: 'Filter by knowledge category (optional)',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'brain_briefing',
      description: 'Get a session briefing: what happened since a given time across all agents. Excludes entries from the requesting agent by default. Returns compact format (truncated content) to save tokens — use format="full" only when you need complete content.',
      inputSchema: {
        type: 'object',
        properties: {
          since: {
            type: 'string',
            description: 'ISO 8601 timestamp. Get events since this time. Example: 2026-03-09T00:00:00Z',
          },
          agent: {
            type: 'string',
            description: 'The requesting agent (entries from this agent are excluded). Default: claude-code',
          },
          include: {
            type: 'string',
            enum: ['all'],
            description: 'Set to "all" to include own entries in briefing',
          },
          format: {
            type: 'string',
            enum: ['compact', 'summary', 'full'],
            description: 'Response detail level. compact (default): truncated to 200 chars, skips low-importance events. summary: counts + one-line headlines only (minimal tokens). full: complete content.',
          },
          limit: {
            type: 'number',
            description: 'Max memories to retrieve (default 100, max 500)',
          },
        },
        required: ['since'],
      },
    },
    {
      name: 'brain_query',
      description: 'Structured query of shared memories via the database. Query facts by key, statuses by subject, or events by time range. Use brain_search for semantic queries instead.',
      inputSchema: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['events', 'facts', 'statuses'],
            description: 'What to query',
          },
          source_agent: { type: 'string', description: 'Filter by agent' },
          category: { type: 'string', description: 'Filter by category' },
          client_id: { type: 'string', description: 'Filter by client' },
          since: { type: 'string', description: 'For events: ISO timestamp' },
          key: { type: 'string', description: 'For facts: search by key' },
          subject: { type: 'string', description: 'For statuses: search by subject' },
        },
        required: ['type'],
      },
    },
    {
      name: 'brain_stats',
      description: 'Get memory health stats: total memories, active vs superseded, consolidated, decayed, breakdown by type. Use this to understand the state of the shared brain.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'brain_consolidate',
      description: 'Trigger a memory consolidation run. An LLM analyzes unconsolidated memories to find duplicates to merge, contradictions to flag, connections between memories, and cross-memory insights. Runs automatically on a schedule, but can be triggered manually.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['run', 'status', 'job'],
            description: 'run=trigger consolidation now (sync), status=check consolidation status, job=poll async job by job_id. Default: run',
          },
          job_id: {
            type: 'string',
            description: 'For action=job: the job ID returned by an async consolidation trigger',
          },
        },
      },
    },
    {
      name: 'brain_entities',
      description: 'Query the entity graph. Entities are automatically extracted from memories — clients, people, technologies, workflows, domains, agents. Use this to find all entities, get details about one, or list all memories linked to an entity.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'get', 'memories', 'stats'],
            description: 'list=all entities, get=single entity details, memories=memories linked to entity, stats=entity counts',
          },
          name: {
            type: 'string',
            description: 'Entity name (for get/memories actions). Can be canonical name or any known alias.',
          },
          type: {
            type: 'string',
            enum: ['client', 'person', 'system', 'service', 'domain', 'technology', 'workflow', 'agent'],
            description: 'Filter by entity type (for list action)',
          },
          limit: {
            type: 'number',
            description: 'Max results (default 50)',
          },
        },
        required: ['action'],
      },
    },
    {
      name: 'brain_delete',
      description: 'Soft-delete a memory by ID (marks it inactive). The memory remains in storage but is excluded from search results. Agent-scoped keys can only delete their own memories. Use this for compliance or to remove incorrect/sensitive memories.',
      inputSchema: {
        type: 'object',
        properties: {
          memory_id: {
            type: 'string',
            description: 'The UUID of the memory to delete',
          },
          reason: {
            type: 'string',
            description: 'Optional reason for deletion (logged for audit)',
          },
        },
        required: ['memory_id'],
      },
    },
    {
      name: 'brain_client',
      description: 'Get everything known about a client — brand, strategy, meetings, content, technical details, relationships. Can also do semantic search within a client\'s memories. Accepts fuzzy names (e.g. "JL" resolves to "jetloans").',
      inputSchema: {
        type: 'object',
        properties: {
          client: { type: 'string', description: 'Client ID or fuzzy name (resolved via fingerprints)' },
          category: { type: 'string', enum: ['brand', 'strategy', 'meeting', 'content', 'technical', 'relationship'], description: 'Filter by knowledge category (optional)' },
          query: { type: 'string', description: 'Semantic search within this client\'s memories (optional — omit for full briefing)' },
          format: { type: 'string', enum: ['compact', 'full'], description: 'compact (default) or full' },
        },
        required: ['client'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result;

    switch (name) {
      case 'brain_store':
        result = await apiRequest('/memory', {
          method: 'POST',
          body: JSON.stringify({
            type: args.type,
            content: args.content,
            source_agent: args.source_agent || 'claude-code',
            client_id: args.client_id,
            category: args.category,
            importance: args.importance,
            key: args.key,
            subject: args.subject,
            status_value: args.status_value,
            knowledge_category: args.knowledge_category,
          }),
        });
        break;

      case 'brain_search': {
        const params = new URLSearchParams({ q: args.query });
        if (args.type) params.append('type', args.type);
        if (args.source_agent) params.append('source_agent', args.source_agent);
        if (args.client_id) params.append('client_id', args.client_id);
        if (args.limit) params.append('limit', String(args.limit));
        params.append('format', args.format || 'compact');
        if (args.include_superseded) params.append('include_superseded', 'true');
        if (args.knowledge_category) params.append('knowledge_category', args.knowledge_category);
        result = await apiRequest(`/memory/search?${params}`);
        break;
      }

      case 'brain_briefing': {
        const params = new URLSearchParams({ since: args.since });
        if (args.agent) params.append('agent', args.agent);
        if (args.include) params.append('include', args.include);
        params.append('format', args.format || 'compact');
        if (args.limit) params.append('limit', String(args.limit));
        result = await apiRequest(`/briefing?${params}`);
        break;
      }

      case 'brain_query': {
        const params = new URLSearchParams({ type: args.type });
        if (args.source_agent) params.append('source_agent', args.source_agent);
        if (args.category) params.append('category', args.category);
        if (args.client_id) params.append('client_id', args.client_id);
        if (args.since) params.append('since', args.since);
        if (args.key) params.append('key', args.key);
        if (args.subject) params.append('subject', args.subject);
        result = await apiRequest(`/memory/query?${params}`);
        break;
      }

      case 'brain_stats':
        result = await apiRequest('/stats');
        break;

      case 'brain_consolidate':
        if (args.action === 'status') {
          result = await apiRequest('/consolidate/status');
        } else if (args.action === 'job' && args.job_id) {
          result = await apiRequest(`/consolidate/job/${encodeURIComponent(args.job_id)}`);
        } else {
          // Default: async mode (returns job_id); use ?sync=true for blocking
          result = await apiRequest('/consolidate?sync=true', { method: 'POST' });
        }
        break;

      case 'brain_delete':
        if (!args.memory_id) {
          return { content: [{ type: 'text', text: 'Error: memory_id is required' }], isError: true };
        }
        result = await apiRequest(`/memory/${encodeURIComponent(args.memory_id)}`, {
          method: 'DELETE',
          body: JSON.stringify({ reason: args.reason }),
        });
        break;

      case 'brain_entities': {
        const action = args.action || 'list';
        if ((action === 'get' || action === 'memories') && !args.name) {
          return { content: [{ type: 'text', text: 'Error: name is required for get/memories actions' }], isError: true };
        }
        if (action === 'stats') {
          result = await apiRequest('/entities/stats');
        } else if (action === 'get') {
          result = await apiRequest(`/entities/${encodeURIComponent(args.name)}`);
        } else if (action === 'memories') {
          const params = new URLSearchParams();
          if (args.limit) params.append('limit', String(args.limit));
          result = await apiRequest(`/entities/${encodeURIComponent(args.name)}/memories?${params}`);
        } else {
          const params = new URLSearchParams();
          if (args.type) params.append('type', args.type);
          if (args.limit) params.append('limit', String(args.limit));
          result = await apiRequest(`/entities?${params}`);
        }
        break;
      }

      case 'brain_client': {
        const { client, category, query, format } = args;
        const params = new URLSearchParams();
        if (category) params.set('category', category);
        if (query) params.set('query', query);
        if (format) params.set('format', format);
        const qs = params.toString() ? `?${params.toString()}` : '';
        result = await apiRequest(`/client/${encodeURIComponent(client)}${qs}`);
        break;
      }

      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[shared-brain-mcp] Connected');
}

main().catch(console.error);
