// Resolve the Postgres text-search configuration used for BM25 (tsvector)
// indexing + querying.
//
// The default is 'english' — the historical behavior, preserved so existing
// deployments and English corpora are byte-identical. English stemming and
// stopword removal are the right call for an English corpus.
//
// For a mixed/multilingual corpus, set BM25_TSCONFIG='zengram_multi': a managed
// config (unaccent + simple) created at store init. It is lossless and
// accent-folding ("déployé" matches "deploye") and language-agnostic, at the
// cost of losing language-specific stemming — the right trade when the corpus
// spans languages the 'english' config would stem incorrectly. Any other value
// (e.g. 'french', 'simple', or an operator-provisioned config) is honored as-is.
//
// Only identifier-safe values are accepted so the name can be interpolated into
// SQL (text-search config names cannot be passed as bind parameters).

export const DEFAULT_TSCONFIG = 'english';

// The config this codebase creates/manages when explicitly selected.
export const MANAGED_TSCONFIG = 'zengram_multi';

export function bm25TsConfig() {
  const raw = (process.env.BM25_TSCONFIG || DEFAULT_TSCONFIG).trim();
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(raw)) {
    throw new Error(`Invalid BM25_TSCONFIG "${raw}" — must be a Postgres identifier (letters, digits, underscore)`);
  }
  return raw;
}

// True when the resolved config is the managed multilingual one this codebase
// creates. Everything else (including the 'english' default) is assumed to be
// provided by Postgres or the operator.
export function isManagedTsConfig(cfg = bm25TsConfig()) {
  return cfg === MANAGED_TSCONFIG;
}
