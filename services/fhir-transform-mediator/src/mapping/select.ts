export class ConfigError extends Error {}

export type Segment = string | number;

// Only `$`, `.name`, and `[n]`: no wildcards, filters, or functions.
const grammar = /^\$(?:\.[A-Za-z_][A-Za-z0-9_-]*|\[\d+\])*$/;

export function parseSelector(path: string): Segment[] {
  if (!grammar.test(path)) throw new ConfigError(`Invalid selector: ${path}`);
  return [...path.matchAll(/\.([^.[]+)|\[(\d+)\]/g)].map((match) =>
    match[1] !== undefined ? match[1] : Number(match[2]),
  );
}

// Returns undefined for any path the input does not contain. Only own properties are read,
// so a selector such as `$.constructor` cannot reach the prototype chain.
export function select(input: unknown, path: string) {
  return selectSegments(input, parseSelector(path));
}

export function selectSegments(input: unknown, segments: Segment[]): unknown {
  let value = input;
  for (const segment of segments) {
    const container =
      typeof segment === "number"
        ? Array.isArray(value)
        : value !== null && typeof value === "object" && !Array.isArray(value);
    if (!container || !Object.hasOwn(value as object, segment))
      return undefined;
    value = (value as Record<Segment, unknown>)[segment];
  }
  return value;
}
