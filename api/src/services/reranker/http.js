import fetchWithTimeout from '../fetch-with-timeout.js';

// Generic HTTP reranker client. Speaks the two request/response shapes that
// cover essentially every self-hosted reranker server:
//
//   - "cohere" flavour (default): Cohere/Jina/Infinity/vLLM-compatible
//       POST { model?, query, documents:[...], top_n? }
//       → { results: [ { index, relevance_score } ] }
//     Works with: Infinity (michaelf34/infinity), vLLM /v1/rerank or /rerank,
//     Jina AI API, Cohere API, text-embeddings-router rerank.
//
//   - "tei" flavour: HuggingFace text-embeddings-inference
//       POST { query, texts:[...], raw_scores? }
//       → [ { index, score } ]
//
// Configure with:
//   RERANK_URL    full endpoint (e.g. http://localhost:8090/rerank)
//   RERANK_API    cohere | tei            (default: cohere)
//   RERANK_MODEL  model id (sent only in cohere flavour; many servers ignore it)
//   RERANK_API_KEY  optional bearer token
//   RERANK_TIMEOUT_MS  default 20000
//
// Response parsing is defensive: it accepts a top-level array OR a {results:[...]}
// wrapper, and reads either `score` or `relevance_score`, so a server that
// doesn't exactly match the configured flavour still works.

export class HttpReranker {
  constructor() {
    this.url = process.env.RERANK_URL;
    this.api = (process.env.RERANK_API || 'cohere').toLowerCase();
    this.model = process.env.RERANK_MODEL || '';
    this.apiKey = process.env.RERANK_API_KEY || '';
    this.timeout = parseInt(process.env.RERANK_TIMEOUT_MS) || 20000;
    // Server-side client-batch caps (e.g. TEI's default 32) must not silently
    // drop reranking for larger candidate pools. Chunk to this size and merge —
    // a cross-encoder scores each (query, doc) pair independently, so splitting
    // the document list and offsetting indices is exactly equivalent.
    this.maxBatch = parseInt(process.env.RERANK_MAX_BATCH) || 32;
    if (!this.url) {
      throw new Error('RERANK_URL is required when RERANK_ENABLED=true');
    }
  }

  info() {
    return `http(${this.api}) ${this.url}${this.model ? ` model=${this.model}` : ''} maxBatch=${this.maxBatch}`;
  }

  async rerank(query, documents, topN) {
    if (documents.length <= this.maxBatch) {
      return this._rerankChunk(query, documents, 0);
    }
    // Chunk, score each sub-batch, merge with offset indices.
    const all = [];
    for (let start = 0; start < documents.length; start += this.maxBatch) {
      const chunk = documents.slice(start, start + this.maxBatch);
      const scored = await this._rerankChunk(query, chunk, start);
      all.push(...scored);
    }
    all.sort((a, b) => b.score - a.score);
    return typeof topN === 'number' ? all.slice(0, topN) : all;
  }

  async _rerankChunk(query, documents, indexOffset) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

    let body;
    if (this.api === 'tei') {
      body = { query, texts: documents, raw_scores: false };
    } else {
      body = { query, documents };
      if (this.model) body.model = this.model;
      body.return_documents = false;
    }

    const response = await fetchWithTimeout(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }, this.timeout);

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`reranker HTTP ${response.status}: ${errText.slice(0, 200)}`);
    }

    const data = await response.json();
    const scored = parseRerankResponse(data);
    // Offset indices back into the full document list.
    return indexOffset ? scored.map(s => ({ index: s.index + indexOffset, score: s.score })) : scored;
  }
}

// Normalize the many server response shapes into [{index, score}].
export function parseRerankResponse(data) {
  // {results: [...]} wrapper (Cohere/Jina/Infinity/vLLM) or bare array (TEI)
  const rows = Array.isArray(data) ? data : (Array.isArray(data?.results) ? data.results : null);
  if (!rows) {
    throw new Error(`reranker returned unexpected shape: ${JSON.stringify(data).slice(0, 200)}`);
  }
  const out = [];
  for (const r of rows) {
    if (r == null || typeof r !== 'object') continue;
    const index = typeof r.index === 'number' ? r.index
      : (typeof r.document?.index === 'number' ? r.document.index : null);
    const score = typeof r.relevance_score === 'number' ? r.relevance_score
      : (typeof r.score === 'number' ? r.score : null);
    if (index == null || score == null) continue;
    out.push({ index, score });
  }
  if (out.length === 0) {
    throw new Error(`reranker returned no usable {index,score} rows: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return out;
}
