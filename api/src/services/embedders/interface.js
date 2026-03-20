// Embedding provider interface
// Each provider must implement: embed(text, purpose?) → number[], getDimensions() → number
// purpose: 'store' | 'search' — providers that support task-specific embeddings (e.g. Gemini) use this

const PROVIDER = process.env.EMBEDDING_PROVIDER || 'openai';

let provider = null;

export async function initEmbeddings() {
  switch (PROVIDER) {
    case 'openai': {
      const { OpenAIEmbedder } = await import('./openai.js');
      provider = new OpenAIEmbedder();
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
  return provider.embed(text, purpose);
}

export function getEmbeddingDimensions() {
  if (!provider) throw new Error('Embedding provider not initialized.');
  return provider.getDimensions();
}

export function getEmbeddingInfo() {
  return {
    provider: PROVIDER,
    model: provider?.model || 'not initialized',
    dimensions: provider?.getDimensions() || 0,
  };
}

// Backwards compatibility export
export const EMBEDDING_DIMS = null; // Will be set dynamically after init
