import { ConfigError } from "./select.js";

export type CanonicalFields = Map<string, unknown>;
export type ResourceMapping = {
  id: string;
  resourceType: string;
  fields: Record<string, "required" | "optional">;
  template: Record<string, unknown>;
};

// A canonical value the template needs is absent, or has no entry in a lookup table.
export class FieldError extends Error {
  constructor(
    readonly field: string,
    readonly reason: "required" | "invalid",
  ) {
    super(`Field ${field} is ${reason}`);
  }
}

export const OMIT = Symbol("omit");
const placeholder = /\{([a-z][a-z0-9_.]*)\}/g;

type Directive =
  | { kind: "field"; name: string }
  | { kind: "literal"; value: unknown }
  | { kind: "lookup"; name: string; map: Record<string, unknown> }
  | { kind: "if"; names: string[]; then: unknown }
  | { kind: "format"; text: string; names: string[] };

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function directive(node: Record<string, unknown>): Directive | undefined {
  const keys = Object.keys(node);
  if (!keys.some((key) => key.startsWith("$"))) return undefined;
  const shape = keys.sort().join(",");
  if (shape === "$field" && typeof node.$field === "string")
    return { kind: "field", name: node.$field };
  if (shape === "$literal") return { kind: "literal", value: node.$literal };
  if (
    shape === "$lookup,map" &&
    typeof node.$lookup === "string" &&
    isObject(node.map)
  )
    return { kind: "lookup", name: node.$lookup, map: node.map };
  if (shape === "$if,then") {
    const names = typeof node.$if === "string" ? [node.$if] : node.$if;
    if (
      Array.isArray(names) &&
      names.length &&
      names.every((name) => typeof name === "string")
    )
      return { kind: "if", names, then: node.then };
  }
  if (shape === "$format" && typeof node.$format === "string")
    return {
      kind: "format",
      text: node.$format,
      names: [...node.$format.matchAll(placeholder)].map((match) => match[1]),
    };
  throw new ConfigError(`Unsupported template directive: ${shape}`);
}

// Canonical field names a template reads. Throws on an unsupported directive, so startup
// rejects a bad template before any request uses it.
export function templateFields(node: unknown, found = new Set<string>()) {
  if (Array.isArray(node)) node.forEach((item) => templateFields(item, found));
  if (!isObject(node)) return found;
  const parsed = directive(node);
  if (!parsed) {
    Object.values(node).forEach((child) => templateFields(child, found));
    return found;
  }
  if (parsed.kind === "field" || parsed.kind === "lookup")
    found.add(parsed.name);
  if (parsed.kind === "format" || parsed.kind === "if")
    parsed.names.forEach((name) => found.add(name));
  if (parsed.kind === "if") templateFields(parsed.then, found);
  return found;
}

// `provenance` records which canonical field produced each output path, such as
// `address[0].extension[1].valueCoding.code`, so validator issues can name the source field.
export function render(
  node: unknown,
  fields: CanonicalFields,
  provenance?: Map<string, string>,
  path = "",
): unknown {
  if (Array.isArray(node)) {
    const out: unknown[] = [];
    for (const item of node) {
      const value = render(item, fields, provenance, `${path}[${out.length}]`);
      if (value !== OMIT) out.push(value);
    }
    // An array whose items were all omitted is left out: FHIR forbids empty arrays.
    return out.length || !node.length ? out : OMIT;
  }
  if (!isObject(node)) return node;
  const parsed = directive(node);
  if (!parsed) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node)) {
      const value = render(
        child,
        fields,
        provenance,
        path ? `${path}.${key}` : key,
      );
      if (value !== OMIT) out[key] = value;
    }
    return out;
  }
  const get = (name: string) => {
    if (!fields.has(name)) throw new FieldError(name, "required");
    if (provenance && !provenance.has(path)) provenance.set(path, name);
    return fields.get(name);
  };
  switch (parsed.kind) {
    case "literal":
      return parsed.value;
    case "field":
      return get(parsed.name);
    case "lookup": {
      const key = String(get(parsed.name));
      if (!Object.hasOwn(parsed.map, key))
        throw new FieldError(parsed.name, "invalid");
      return parsed.map[key];
    }
    case "format":
      return parsed.text.replace(placeholder, (_, name: string) =>
        String(get(name)),
      );
    case "if":
      return parsed.names.some((name) => fields.has(name))
        ? render(parsed.then, fields, provenance, path)
        : OMIT;
  }
}

export function renderResource(
  mapping: ResourceMapping,
  fields: CanonicalFields,
  provenance?: Map<string, string>,
) {
  return render(mapping.template, fields, provenance) as Record<
    string,
    unknown
  >;
}
