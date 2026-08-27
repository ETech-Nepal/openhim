export function optionalString(value) {
  if (value === null || value === undefined) return undefined;
  const normalized = String(value).trim();
  if (!normalized || normalized.toLowerCase() === 'none') return undefined;
  return normalized;
}
