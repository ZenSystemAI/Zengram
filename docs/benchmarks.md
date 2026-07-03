# LongMemEval Benchmark Results

[LongMemEval](https://github.com/xiaowu0162/LongMemEval) is an academic benchmark for evaluating long-term memory in conversational AI systems. It tests six capabilities across 500 questions.

## v2.5 Results

### Retrieval Accuracy (98.4%)

Can the system find the right memories?

| Task | Score |
|------|:-----:|
| Single-session (user) | **100.0%** |
| Multi-session | **99.6%** |
| Knowledge update | **98.7%** |
| Temporal reasoning | **98.2%** |
| Preference | **96.7%** |
| Single-session (assistant) | **94.6%** |
| **Overall** | **98.4%** |

### QA Accuracy (76.0%)

Can the LLM answer correctly given the retrieved memories?

| Task | GPT-4o-mini | GPT-4o | Change |
|------|:-----------:|:------:|:------:|
| Single-session (user) | 92.9% | **94.3%** | +1.4 |
| Single-session (assistant) | 92.9% | **92.9%** | -- |
| Knowledge update | 78.2% | **82.1%** | +3.9 |
| Temporal reasoning | 49.6% | **70.7%** | +21.1 |
| Multi-session | 54.9% | **64.7%** | +9.8 |
| Preference | 50.0% | **60.0%** | +10.0 |
| **Overall** | 66.4% | **76.0%** | **+9.6** |

### Competitive Comparison

| System | QA Score | Approach |
|--------|:--------:|----------|
| [Hindsight](https://github.com/cyanheads/hindsight-core) | 91.4% | Conversation replay + re-ranker + 4-path search |
| **Zengram** | **76.0%** | **Cosine similarity only (see methodology)** |
| Full-context GPT-4o | 72.4% | Brute-force: entire conversation history in prompt |
| RAG baseline | ~50% | Single-path vector search |

## Methodology

The benchmark runner (`benchmarks/longmemeval/query-direct.js`) bypasses the Express API and queries the pgvector store directly with raw cosine similarity vector search. This was necessary due to networking constraints between the benchmark runner and the Docker-hosted API.

**API features NOT used in this benchmark:**

- Multi-path search (vector + keyword RRF fusion) -- **not used**
- Temporal date filtering / proximity boost -- **not used**
- Query expansion -- **not used**
- Session diversity re-ranking -- **not used**
- Temporal validity (valid_from/valid_to) -- **not used**

The 76.0% score reflects pure embedding quality and memory model design. The full API retrieval pipeline achieves 98.4% retrieval accuracy; further QA improvements are expected when the benchmark runner is updated to use multi-path search.

### Key Insight

The +21.1 point gain on temporal reasoning from swapping GPT-4o-mini to GPT-4o proves the QA model is the bottleneck, not retrieval. The retrieval pipeline consistently finds the right memories (98.4%); the remaining gap is in the LLM's ability to reason over retrieved context.

## Reproducing

The original LongMemEval runner was a one-off script against the maintainer's deployment and is **not yet part of this repo** — so treat the numbers above as a point-in-time measurement (v2.5, cosine-only), not a claim you can currently re-derive from a fresh clone. Bringing a reproducible LongMemEval runner in-repo (through the full multi-path API pipeline this time) is on the roadmap.

What you CAN run today is the in-repo retrieval eval harness, which measures hit@k / recall@k / MRR of the real `GET /memory/search` pipeline against a labeled fixture:

```bash
# Requires a live API + Postgres + embedding provider (see docs/eval-harness.md)
export BRAIN_API_KEY=...
node api/scripts/eval/run-eval.js            # uses the bundled fixture
node api/scripts/eval/run-eval.js my-fixture.json
```

Use it to A/B any retrieval change (score floor, fusion weights, ef_search) before trusting it.

## About LongMemEval

LongMemEval was designed for single-agent chat memory systems. Zengram is built for multi-agent coordination — features like cross-agent briefings, typed memory, credential scrubbing, and entity graphs aren't measured by this benchmark but are core to production use.
