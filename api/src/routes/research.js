import { Router } from 'express';
import { complete, getLLMInfo } from '../services/llm/interface.js';
import { retrieveAndFuse, formatMemoriesXml } from '../services/research-retrieval.js';
import {
  parseResearchJson,
  normalizeSufficiency,
  runResearchLoop,
  groundResearchSynthesis,
} from '../services/research-utils.js';
import { boundedIntegerParam, isInvalidIntegerParam, requestBodyObject } from '../services/request-utils.js';
import { validateNoToolCallControlMarkup } from '../middleware/validate.js';

export const researchRouter = Router();

// Opt-in: agentic iterate-until-sufficient retrieval is heavyweight (several LLM
// calls). It stays OFF by default and the hot path (GET /memory/search) is never
// touched. Enable explicitly once measured against single-shot /reflect.
const RESEARCH_ENABLED = process.env.RESEARCH_ENABLED === 'true';
const DEFAULT_MAX_ITERS = Math.max(1, Math.min(4, parseInt(process.env.MAX_RESEARCH_ITERS) || 2));
const FETCH_PER_ITER = Math.max(1, parseInt(process.env.RESEARCH_FETCH_PER_ITER) || 15);
const MAX_CONTEXT = Math.max(1, parseInt(process.env.RESEARCH_MAX_CONTEXT) || 40);

// Combined rough-draft + sufficiency gate (Google's "Sufficient Context Agent").
// One call produces a best-effort draft AND judges whether the gathered memories
// can actually answer the question, naming the exact missing pieces.
const GATE_PROMPT = `You are the sufficiency gate of a memory-research loop. Given a QUESTION and a set of agent MEMORIES, decide whether the memories contain enough to fully and correctly answer the question.

Return JSON only (no markdown fences):
{
  "draft": "the best answer you can give from these memories right now",
  "status": "SUFFICIENT" | "INSUFFICIENT",
  "reason": "one sentence on why it is or isn't sufficient",
  "missing": ["specific fact or sub-question still needed to fully answer; empty if SUFFICIENT"]
}

Rules:
- SUFFICIENT only if the memories actually contain the answer. Do not guess to fill gaps.
- For a multi-hop question, INSUFFICIENT until every hop is grounded in a memory.
- "missing" must name concrete, searchable facts (e.g. "the deploy date of service X"), not vague gaps.

QUESTION: `;

// Final grounded synthesis with per-claim [mem:<id>] citations.
const SYNTHESIS_PROMPT = `You are writing the final answer of a memory-research loop. Using ONLY the agent MEMORIES below, answer the QUESTION. Ground every claim in the memory it comes from.

Return JSON only (no markdown fences):
{
  "answer": "a complete answer. After each claim, cite its source memory id(s) copied exactly from the <memory id=\\"...\\"> tag, as [mem:<id>].",
  "key_findings": ["the most important grounded facts, each ending with its [mem:<id>] citation"],
  "unresolved": ["anything the memories could not answer"]
}

Rules:
- Cite only ids that appear in the MEMORIES. Never invent an id.
- If the memories don't fully answer, say so in "answer" and list the gap in "unresolved" — do not fabricate.
- Return valid JSON only.

QUESTION: `;

const escapeXml = (str) => String(str ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

function isLLMUninitialized(err) {
  return typeof err?.message === 'string' && err.message.includes('not initialized');
}

// POST /research — agentic, iterate-until-sufficient retrieval + grounded synthesis
researchRouter.post('/', async (req, res) => {
  if (!RESEARCH_ENABLED) {
    return res.status(503).json({
      error: 'research_disabled',
      message: 'POST /research is disabled. Set RESEARCH_ENABLED=true to enable the agentic retrieval loop.',
    });
  }

  try {
    const { topic, client_id, max_iterations } = requestBodyObject(req);

    if (!topic || typeof topic !== 'string' || !topic.trim()) {
      return res.status(400).json({ error: 'topic is required (non-empty string)' });
    }
    if (client_id !== undefined && client_id !== null && typeof client_id !== 'string') {
      return res.status(400).json({ error: 'client_id must be a string when provided' });
    }
    for (const [name, value] of Object.entries({ topic, client_id, max_iterations })) {
      const error = validateNoToolCallControlMarkup(value, name);
      if (error) return res.status(400).json({ error });
    }
    if (isInvalidIntegerParam(max_iterations)) {
      return res.status(400).json({ error: 'max_iterations must be an integer' });
    }

    const topicText = topic.trim();
    const clientId = typeof client_id === 'string' && client_id.trim() ? client_id.trim() : null;
    const maxIters = boundedIntegerParam(max_iterations, { defaultValue: DEFAULT_MAX_ITERS, min: 1, max: 4 });

    const filter = { active: true };
    if (clientId) filter.client_id = clientId;

    // Retrieve and judge are injected so the loop control flow is unit-testable
    // (see research-utils.js#runResearchLoop). retrieve = multi-path search;
    // judge = the sufficiency-gate LLM call.
    const retrieve = (query) => retrieveAndFuse({ queryText: query, filter, maxMemories: FETCH_PER_ITER });
    const judge = async (memArr) => {
      const contextMems = memArr.slice(0, MAX_CONTEXT);
      const gateRaw = await complete(
        GATE_PROMPT + escapeXml(topicText) + '\n\nMEMORIES:\n' + formatMemoriesXml(contextMems),
        { temperature: 0.2 }
      );
      try {
        return normalizeSufficiency(parseResearchJson(gateRaw));
      } catch (e) {
        // A malformed gate must not crash or loop — stop and synthesize what we have.
        console.warn('[research] gate JSON unparseable; stopping loop:', e.message);
        return { status: 'INSUFFICIENT', reason: 'gate_unparseable', missing: [], stop: true };
      }
    };

    const { memories: accumulated, iterations, queryTrace, lastGate, anyVectorError } =
      await runResearchLoop({ question: topicText, maxIters, retrieve, judge });

    if (accumulated.length === 0) {
      if (anyVectorError) {
        return res.status(503).json({
          error: 'research_retrieval_unavailable',
          message: 'Vector and keyword retrieval both returned nothing (vector path failed).',
          topic: topicText,
        });
      }
      return res.json({
        topic: topicText,
        client_id: clientId,
        status: 'no_memories',
        answer: 'No memories were found for this topic.',
        key_findings: [],
        unresolved: ['No stored memories matched this topic — consider recording foundational context.'],
        cited_memory_ids: [],
        partial: true,
        iterations,
        memories_analyzed: 0,
        query_trace: queryTrace,
        llm: getLLMInfo(),
      });
    }

    // Final grounded synthesis over everything gathered.
    const contextMems = accumulated.slice(0, MAX_CONTEXT);
    const synthRaw = await complete(
      SYNTHESIS_PROMPT + escapeXml(topicText) + '\n\nMEMORIES:\n' + formatMemoriesXml(contextMems),
      { temperature: 0.3 }
    );

    let grounded;
    try {
      grounded = groundResearchSynthesis(parseResearchJson(synthRaw), contextMems.map(m => m.id));
    } catch (e) {
      console.error('[research] synthesis JSON invalid:', synthRaw.slice(0, 300));
      return res.status(502).json({ error: 'LLM returned invalid JSON synthesis' });
    }

    const partial = lastGate ? lastGate.status !== 'SUFFICIENT' : true;

    const response = {
      topic: topicText,
      client_id: clientId,
      answer: grounded.answer,
      key_findings: grounded.key_findings,
      unresolved: grounded.unresolved,
      cited_memory_ids: grounded.cited_memory_ids,
      partial,
      iterations,
      memories_analyzed: accumulated.length,
      query_trace: queryTrace,
      sufficiency: lastGate
        ? { status: lastGate.status, reason: lastGate.reason, missing: lastGate.missing }
        : null,
      llm: getLLMInfo(),
    };
    if (anyVectorError) response.warning = 'vector_search_unavailable_keyword_fallback_used';

    res.json(response);
  } catch (err) {
    if (isLLMUninitialized(err)) {
      return res.status(503).json({
        error: 'llm_unavailable',
        message: 'Research requires an initialized LLM provider. Ensure CONSOLIDATION_ENABLED or RESEARCH_ENABLED is set so initLLM() runs at startup.',
      });
    }
    console.error('[research]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});
