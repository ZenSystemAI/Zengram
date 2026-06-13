export function embeddingDimensions(envName, fallback) {
  const raw = process.env[envName];
  if (raw == null || raw === '') return fallback;

  const dimensions = Number(raw);
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error(`${envName} must be a positive integer`);
  }

  return dimensions;
}
