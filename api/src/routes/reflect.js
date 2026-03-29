import { Router } from 'express';
import { embed } from '../services/embedders/interface.js';
import { searchPoints } from '../services/qdrant.js';
import { complete, getLLMInfo } from '../services/llm/interface.js';
import { isKeywordSearchAvailable, keywordSearch } from '../services/keyword-search.js';
import { isGraphSearchAvailable, graphSearch } from '../services/graph-search.js';
import { reciprocalRankFusion } from '../services/rrf.js';
import { getPoints } from '../services/qdrant.js';

export const reflectRouter = Router();

const MULTI_PATH_SEARCH = process.env.MULTI_PATH_SEARCH !== 'false';

const REFLECT_PROMPT = `You are analyzing a set of agent memories about a specific topic. Your job is to synthesize patterns, track evolution over time, identify contradictions, and spot gaps.

Analyze the memories below and return a JSON response:

{
  "summary": "A concise 2-3 sentence synthesis of what these memories collectively say about the topic",
  "patterns": ["Pattern or theme you noticed across multiple memories"],
  "timeline": ["Key events or changes in chronological order"],
  "contradictions": ["Any conflicting information found between memories"],
  "gaps": ["What's missing — questions that the memories don't answer but should"]
}

Rules:
- Patterns should be non-obvious insights from combining multiple memories, not restating individual ones
- Timeline entries should include approximate dates if available
- Only flag real contradictions, not just different aspects of the same thing
- Gaps should be actionable — things worth investigating or recording
- If a section has no entries, return an empty array
- Return valid JSON only, no markdown fences

TOPIC: `;

// POST /reflect — On-demand LLM synthesis across memories
reflectRouter.post('/', async (req, res) => {
  try {
    const { topic, client_id, limit: limitParam } = req.body;

    if (!topic || typeof topic !== 'string' || !topic.trim()) {
      return res.status(400).json({ error: 'topic is required (non-empty string)' });
    }

    const maxMemories = Math.min(Math.max(parseInt(limitParam) || 20, 1), 50);

    // Multi-path search for relevant memories
    const filter = { active: true };
    if (client_id) filter.client_id = client_id;

    const fetchLimit = MULTI_PATH_SEARCH ? Math.min(maxMemories * 2, 50) : maxMemories;

    const vectorPromise = embed(topic, 'search').then(vector =>
      searchPoints(vector, filter, fetchLimit)
    );

    const keywordPromise = (MULTI_PATH_SEARCH && isKeywordSearchAvailable())
      ? keywordSearch(topic, filter, fetchLimit).catch(() => [])
      : Promise.resolve([]);

    const graphPromise = (MULTI_PATH_SEARCH && isGraphSearchAvailable())
      ? graphSearch(topic, filter, Math.min(maxMemories, 20)).catch(() => [])
      : Promise.resolve([]);

    const [vectorResults, keywordResults, graphResults] = await Promise.all([
      vectorPromise, keywordPromise, graphPromise,
    ]);

    // Fuse results
    let memories;
    if (MULTI_PATH_SEARCH && (keywordResults.length > 0 || graphResults.length > 0)) {
      const rankedLists = [
        vectorResults.map(r => ({ id: r.id, source: 'vector' })),
      ];
      if (keywordResults.length > 0) {
        rankedLists.push(keywordResults.map(r => ({ id: r.memory_id, source: 'keyword' })));
      }
      if (graphResults.length > 0) {
        rankedLists.push(graphResults.map(r => ({ id: r.memory_id, source: 'graph' })));
      }

      const fused = reciprocalRankFusion(rankedLists).slice(0, maxMemories);
      const payloadMap = new Map(vectorResults.map(r => [r.id, r]));

      const missingIds = fused.map(f => f.id).filter(id => !payloadMap.has(id));
      if (missingIds.length > 0) {
        try {
          const fetched = await getPoints(missingIds);
          for (const pt of fetched) {
            payloadMap.set(pt.id, { id: pt.id, score: 0, payload: pt.payload });
          }
        } catch (e) { /* non-critical */ }
      }

      memories = fused.map(f => payloadMap.get(f.id)).filter(Boolean);
    } else {
      memories = vectorResults.slice(0, maxMemories);
    }

    if (memories.length === 0) {
      return res.json({
        topic,
        client_id: client_id || null,
        memories_analyzed: 0,
        reflection: {
          summary: 'No relevant memories found for this topic.',
          patterns: [],
          timeline: [],
          contradictions: [],
          gaps: ['No memories exist about this topic — consider storing foundational context.'],
        },
        llm: null,
      });
    }

    // Format memories for the LLM
    const escapeXml = (str) => str
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

    const memoriesText = memories.map(m => {
      const p = m.payload;
      return `<memory id="${m.id}" type="${p.type}" agent="${escapeXml(p.source_agent || '')}" client="${escapeXml(p.client_id || '')}" created="${p.created_at}">\n${escapeXml(p.text || '')}\n</memory>`;
    }).join('\n\n');

    const prompt = REFLECT_PROMPT + escapeXml(topic) + '\n\nMEMORIES:\n' + memoriesText;
    const responseText = await complete(prompt);

    // Parse LLM response
    let reflection;
    try {
      let jsonText = responseText.trim();
      const fenceMatch = jsonText.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
      if (fenceMatch) jsonText = fenceMatch[1].trim();
      reflection = JSON.parse(jsonText);
    } catch (e) {
      console.error('[reflect] LLM returned invalid JSON:', responseText.slice(0, 300));
      return res.status(502).json({ error: 'LLM returned invalid JSON response' });
    }

    // Validate structure
    const ensureArray = (val) => Array.isArray(val) ? val : [];
    reflection = {
      summary: typeof reflection.summary === 'string' ? reflection.summary : '',
      patterns: ensureArray(reflection.patterns),
      timeline: ensureArray(reflection.timeline),
      contradictions: ensureArray(reflection.contradictions),
      gaps: ensureArray(reflection.gaps),
    };

    res.json({
      topic,
      client_id: client_id || null,
      memories_analyzed: memories.length,
      reflection,
      llm: getLLMInfo(),
    });
  } catch (err) {
    console.error('[reflect]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});
