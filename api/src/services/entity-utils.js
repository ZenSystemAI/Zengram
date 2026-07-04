export const ENTITY_TYPE_VALUES = ['client', 'person', 'system', 'service', 'domain', 'technology', 'workflow', 'agent'];

export function normalizeEntityType(value) {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return ENTITY_TYPE_VALUES.includes(normalized) ? normalized : undefined;
}
