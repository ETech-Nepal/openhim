import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ConfigError, parseSelector, type Segment } from "./mapping/select.js";
import { templateFields, type ResourceMapping } from "./mapping/template.js";

const boolean = (fallback: "true" | "false") =>
  z
    .enum(["true", "false"])
    .default(fallback)
    .transform((value) => value === "true");
const httpUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  }, "Expected an HTTP(S) URL without embedded credentials or fragment");
const envKey = z.string().regex(/^[A-Z][A-Z0-9_]*$/);
const id = z.string().regex(/^[a-z][a-z0-9-]{0,79}$/);
const fieldName = z.string().regex(/^[a-z][a-z0-9_]{0,79}$/);

export function parseConfig(env: Record<string, unknown>) {
  return Object.freeze(
    z
      .object({
        MEDIATOR_PORT: z.coerce.number().int().min(1).max(65535).default(4005),
        MEDIATOR_URN: z.string().min(1).default("urn:mediator:fhir-transform"),
        MEDIATOR_ROUTE_HOST: z
          .string()
          .regex(/^[A-Za-z0-9.-]+$/)
          .default("fhir-transform-mediator"),
        CONFIG_DIR: z.string().min(1).default("config"),
        OPENHIM_REGISTER: boolean("true"),
        OPENHIM_API_URL: httpUrl.default("https://openhim-core:8080"),
        OPENHIM_USERNAME: z.string().default(""),
        OPENHIM_PASSWORD: z.string().default(""),
        OPENHIM_TRUST_SELF_SIGNED: boolean("false"),
        MAX_BODY_BYTES: z.coerce
          .number()
          .int()
          .min(1024)
          .max(10485760)
          .default(1048576),
      })
      .refine(
        (value) =>
          !value.OPENHIM_REGISTER ||
          (value.OPENHIM_USERNAME && value.OPENHIM_PASSWORD),
        "OpenHIM registration requires credentials",
      )
      .parse(env),
  );
}
export type Config = ReturnType<typeof parseConfig>;

const registrySchema = z
  .array(z.object({ id, config: z.string().min(1) }).strict())
  .min(1);
const channelSchema = z
  .object({
    urlEnv: envKey,
    authorizationEnv: envKey.optional(),
    timeoutMs: z.number().int().min(10).max(120000).default(15000),
  })
  .strict();
const mappingSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*\.v\d+$/),
    resourceType: z.string().regex(/^[A-Z][A-Za-z]+$/),
    fields: z.record(fieldName, z.enum(["required", "optional"])),
    template: z.record(z.unknown()),
  })
  .strict();
const inputFieldSchema = z
  .object({
    path: z.string().optional(),
    // A fixed app-level value, such as the app's own identifier system, instead of a path.
    value: z.union([z.string().min(1), z.number()]).optional(),
    type: z.enum(["string", "integer"]).default("string"),
    required: z.boolean().default(false),
    // Only an echo field may appear in an error response; it must not be patient data.
    echo: z.boolean().default(false),
    maxLength: z.number().int().min(1).optional(),
    pattern: z.string().min(1).optional(),
    format: z.enum(["date", "email"]).optional(),
    enum: z.array(z.string()).min(1).optional(),
    minimum: z.number().int().optional(),
    maximum: z.number().int().optional(),
    // Fixed text shown when the value is invalid. It never contains the submitted value.
    rule: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    (spec) => (spec.path === undefined) !== (spec.value === undefined),
    "Set exactly one of path or value",
  );
const appSchema = z
  .object({
    route: z.string().regex(/^\/[a-z0-9/-]*[a-z0-9]$/),
    role: z.string().min(1),
    input: z
      .object({
        strict: z.boolean().default(false),
        fields: z.record(fieldName, inputFieldSchema),
      })
      .strict(),
    resources: z
      .array(
        z
          .object({
            key: id,
            mapping: z.string(),
            refs: z.record(fieldName, id).default({}),
            request: z
              .object({
                method: z.enum(["POST", "PUT"]),
                url: z.string().min(1),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .min(1),
    bundleType: z.enum(["collection", "transaction"]).optional(),
    validation: z
      .object({
        channel: id,
        profile: z.string().url().optional(),
        // Error text fragments to ignore, such as a slice the downstream service fills in.
        ignore: z.array(z.string().min(1)).default([]),
        // Rule text after the field name, by validator issue code, e.g. "is not a valid NP Core code".
        messages: z
          .object({
            "code-invalid": z.string().min(1).default("is not a valid code"),
            required: z.string().min(1).default("is required by the profile"),
            default: z.string().min(1).default("failed FHIR validation"),
          })
          .strict()
          .default({}),
      })
      .strict(),
    delivery: z
      .object({
        channel: id,
        successStatuses: z.array(z.number().int().min(200).max(299)).min(1),
        // Return a 4xx/5xx JSON error body from the channel to the caller as it is.
        relayErrors: z.boolean().default(false),
      })
      .strict()
      .optional(),
    errors: z
      .object({
        messages: z.record(z.string()).default({}),
        template: z.record(z.unknown()).optional(),
      })
      .strict()
      .optional(),
    // What the caller gets once the delivery channel accepts. It never carries downstream data.
    acknowledgement: z
      .object({
        message: z.string().min(1),
        template: z.record(z.unknown()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

// Names an acknowledgement template may read, besides the app's echo fields.
export const acknowledgementFields = [
  "ack.status",
  "ack.message",
  "ack.correlation_id",
];

// Names an error template may read, besides the app's echo fields.
export const errorFields = [
  "error.code",
  "error.stage",
  "error.message",
  "error.correlation_id",
  "error.field",
  "error.path",
  "error.issues",
];

function inputValidator(spec: z.infer<typeof inputFieldSchema>) {
  if (spec.type === "integer") {
    let schema = z.number().int();
    if (spec.minimum !== undefined) schema = schema.min(spec.minimum);
    if (spec.maximum !== undefined) schema = schema.max(spec.maximum);
    return schema;
  }
  let schema = z.string().trim().min(1);
  if (spec.maxLength) schema = schema.max(spec.maxLength);
  if (spec.pattern) schema = schema.regex(new RegExp(`^(?:${spec.pattern})$`));
  if (spec.format === "date") schema = schema.date();
  if (spec.format === "email") schema = schema.email();
  const values = spec.enum;
  return values ? schema.refine((value) => values.includes(value)) : schema;
}

function readJson(dir: string, file: string): unknown {
  const resolved = path.resolve(dir, file);
  const relative = path.relative(dir, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new ConfigError(`Config path escapes the config directory: ${file}`);
  return JSON.parse(readFileSync(resolved, "utf8"));
}

function loadMappings(dir: string) {
  const mappings = new Map<string, ResourceMapping>();
  for (const file of readdirSync(path.join(dir, "mappings")).sort()) {
    if (!file.endsWith(".json")) continue;
    const mapping = mappingSchema.parse(readJson(dir, `mappings/${file}`));
    if (`${mapping.id}.json` !== file)
      throw new ConfigError(`Mapping ${file} must declare id ${file}`);
    if (mapping.template.resourceType !== mapping.resourceType)
      throw new ConfigError(`Mapping ${mapping.id} resourceType mismatch`);
    for (const name of templateFields(mapping.template))
      if (!Object.hasOwn(mapping.fields, name))
        throw new ConfigError(`Mapping ${mapping.id} uses undeclared ${name}`);
    mappings.set(mapping.id, mapping);
  }
  return mappings;
}

export function loadCatalog(
  config: Pick<Config, "CONFIG_DIR">,
  env: Record<string, string | undefined>,
) {
  const dir = path.resolve(config.CONFIG_DIR);
  const registry = registrySchema.parse(readJson(dir, "apps.json"));
  const channels = z
    .record(id, channelSchema)
    .parse(readJson(dir, "channels.json"));
  const mappings = loadMappings(dir);

  // Only channels an app uses must be set in the environment.
  const channel = (name: string) => {
    const value = channels[name];
    if (!value) throw new ConfigError(`Unknown channel ${name}`);
    return {
      url: httpUrl.parse(env[value.urlEnv]),
      authorization: value.authorizationEnv
        ? z
            .string()
            .min(1)
            .regex(/^[\x20-\x7e]+$/)
            .parse(env[value.authorizationEnv])
        : undefined,
      timeoutMs: value.timeoutMs,
    };
  };

  const apps = registry.map(({ id, config: file }) => {
    const app = appSchema.parse(readJson(dir, file));
    const fields = Object.entries(app.input.fields).map(([name, spec]) => {
      const segments: Segment[] =
        spec.path === undefined ? [] : parseSelector(spec.path);
      return {
        name,
        segments,
        value: spec.value,
        field: segments.join("."),
        required: spec.required,
        echo: spec.echo,
        rule: spec.rule,
        schema: inputValidator(spec),
      };
    });
    const keys = new Set(app.resources.map((resource) => resource.key));
    if (keys.size !== app.resources.length)
      throw new ConfigError(`App ${id} has duplicate resource keys`);
    if (app.resources.length > 1 !== (app.bundleType !== undefined))
      throw new ConfigError(
        `App ${id} needs bundleType only for resources > 1`,
      );
    const resources = app.resources.map((resource) => {
      const mapping = mappings.get(resource.mapping);
      if (!mapping)
        throw new ConfigError(`App ${id} uses unknown ${resource.mapping}`);
      if (resource.request && app.bundleType !== "transaction")
        throw new ConfigError(`App ${id} request needs a transaction Bundle`);
      for (const [name, target] of Object.entries(resource.refs))
        if (
          target === resource.key ||
          !keys.has(target) ||
          !Object.hasOwn(mapping.fields, name) ||
          Object.hasOwn(app.input.fields, name)
        )
          throw new ConfigError(`App ${id} has an invalid ref ${name}`);
      for (const [name, need] of Object.entries(mapping.fields))
        if (
          need === "required" &&
          !Object.hasOwn(app.input.fields, name) &&
          !Object.hasOwn(resource.refs, name)
        )
          throw new ConfigError(`App ${id} does not provide ${name}`);
      return { ...resource, mapping };
    });
    const echo = fields.filter((f) => f.echo).map((f) => f.name);
    for (const name of templateFields(app.errors?.template ?? {}))
      if (!errorFields.includes(name) && !echo.includes(name))
        throw new ConfigError(`App ${id} error template reads ${name}`);
    if (app.acknowledgement && !app.delivery)
      throw new ConfigError(`App ${id} acknowledgement needs a delivery`);
    for (const name of templateFields(app.acknowledgement?.template ?? {}))
      if (!acknowledgementFields.includes(name) && !echo.includes(name))
        throw new ConfigError(`App ${id} acknowledgement reads ${name}`);
    return {
      id,
      route: app.route,
      role: app.role,
      strict: app.input.strict,
      fields,
      resources,
      bundleType: app.bundleType,
      validation: {
        ...channel(app.validation.channel),
        profile: app.validation.profile,
        ignore: app.validation.ignore,
        messages: app.validation.messages,
      },
      delivery: app.delivery && {
        ...channel(app.delivery.channel),
        successStatuses: app.delivery.successStatuses,
        relayErrors: app.delivery.relayErrors,
      },
      errors: app.errors,
      acknowledgement: app.acknowledgement,
    };
  });
  if (new Set(apps.map((app) => app.id)).size !== apps.length)
    throw new ConfigError("Duplicate app ID");
  if (new Set(apps.map((app) => app.route)).size !== apps.length)
    throw new ConfigError("Duplicate app route");
  return { apps };
}
export type Catalog = ReturnType<typeof loadCatalog>;
export type AppDefinition = Catalog["apps"][number];
