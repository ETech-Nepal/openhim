const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const QUOTED_STRING = /^"[!#$%&'*+\-.^_`|~0-9A-Za-z]+"$/;

function hasValidCharsetParameter(parameter: string) {
  const match = /^\s*charset\s*=\s*(.*?)\s*$/i.exec(parameter);
  if (!match) return false;
  return TOKEN.test(match[1]) || QUOTED_STRING.test(match[1]);
}

export function classifyContentType(value: unknown) {
  if (!value) return null;
  const [rawMediaType, ...parameters] = String(value).split(';');
  const mediaType = rawMediaType.trim().toLowerCase();
  if (
    parameters.length > 1 ||
    (parameters.length === 1 && !hasValidCharsetParameter(parameters[0]))
  ) {
    return null;
  }
  if (mediaType === 'application/json') return 'raw';
  if (mediaType === 'application/fhir+json') return 'fhir';
  return null;
}
