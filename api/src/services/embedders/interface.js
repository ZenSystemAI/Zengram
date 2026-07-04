// Embedding provider interface
// Each provider must implement: embed(text, purpose?) → number[], getDimensions() → number
// purpose: 'store' | 'search' — providers that support task-specific embeddings (e.g. Gemini) use this

const PROVIDER = process.env.EMBEDDING_PROVIDER || 'openai';

// Asymmetric instruction prefixes. Many modern encoders (Qwen3-Embedding, e5,
// gte-Qwen, bge-multilingual-gemma) expect a short instruction on the QUERY
// side and the raw text on the DOCUMENT side. Verbatim + opt-in (empty by
// default) so the format stays model-agnostic and providers with native
// asymmetric handling (Gemini taskType) are unaffected unless explicitly set.
// Env files (docker-compose --env-file, .env) cannot carry real newlines, but
// instruction prefixes like Qwen3's `Instruct: …\nQuery: ` need one. Decode the
// common backslash escapes so the env value `Instruct: …\nQuery: ` yields a true
// newline at runtime, matching what the model expects.
export function decodeEnvEscapes(s) {
  let v = s || '';
  // Instruction prefixes often end in a significant trailing space
  // ("...\nQuery: ") that secret managers and env tooling trim from bare
  // values. Wrapping the value in double quotes preserves it — strip one
  // surrounding pair here before decoding escapes.
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
  return v.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
}
const QUERY_PREFIX = decodeEnvEscapes(process.env.EMBED_QUERY_PREFIX);
const DOC_PREFIX = decodeEnvEscapes(process.env.EMBED_DOC_PREFIX);

let provider = null;

export async function initEmbeddings() {
  switch (PROVIDER) {
    case 'openai': {
      const { OpenAIEmbedder } = await import('./openai.js');
      provider = new OpenAIEmbedder();
      // Auto-detect dimensions when OPENAI_EMBEDDING_DIMS is not set (e.g. a
      // local Qwen3-Embedding server with native dims).
      if (typeof provider.init === 'function') await provider.init();
      break;
    }
    case 'gemini': {
      const { GeminiEmbedder } = await import('./gemini.js');
      provider = new GeminiEmbedder();
      break;
    }
    case 'ollama': {
      const { OllamaEmbedder } = await import('./ollama.js');
      provider = new OllamaEmbedder();
      // Auto-detect dimensions from model
      await provider.init();
      break;
    }
    default:
      throw new Error(`Unknown embedding provider: ${PROVIDER}. Use: openai, gemini, ollama`);
  }

  // Validate with a test embed
  try {
    const test = await provider.embed('test');
    if (!Array.isArray(test) || test.length === 0) {
      throw new Error('Embed returned invalid result');
    }
    console.log(`[embeddings] Provider: ${PROVIDER}, dimensions: ${provider.getDimensions()}`);
  } catch (e) {
    throw new Error(`Embedding provider "${PROVIDER}" validation failed: ${e.message}`);
  }
}

export async function embed(text, purpose) {
  if (!provider) throw new Error('Embedding provider not initialized. Call initEmbeddings() first.');
  let input = text;
  if (purpose === 'search' && QUERY_PREFIX) input = QUERY_PREFIX + text;
  else if (purpose === 'store' && DOC_PREFIX) input = DOC_PREFIX + text;
  return provider.embed(input, purpose);
}

export function getEmbeddingDimensions() {
  if (!provider) throw new Error('Embedding provider not initialized.');
  return provider.getDimensions();
}
