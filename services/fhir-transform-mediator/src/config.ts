import { z } from "zod";
import { mappings } from "./mappings/index.js";

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
const endpoint = z
  .object({
    urlEnv: envKey,
    authorizationEnv: envKey.optional(),
    timeoutMs: z.number().int().min(10).max(120000).default(15000),
  })
  .strict();
const integrationSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
    channelPath: z.string().regex(/^\/[a-z0-9/-]*[a-z0-9]$/),
    mapping: z
      .string()
      .refine((name) => Object.hasOwn(mappings, name), "Unknown mapping"),
    role: z.string().min(1),
    options: z.record(z.string()),
    validation: endpoint
      .extend({
        requestProfile: z.string().url().optional(),
      })
      .optional(),
    nhidGenerator: endpoint.optional(),
  })
  .strict();

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
        INTEGRATIONS_FILE: z.string().min(1).default("integrations.json"),
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

export function parseIntegrations(
  raw: unknown,
  env: Record<string, string | undefined>,
) {
  const definitions = z.array(integrationSchema).min(1).parse(raw);
  if (new Set(definitions.map((value) => value.id)).size !== definitions.length)
    throw new Error("Duplicate integration ID");
  if (
    new Set(definitions.map((value) => value.channelPath)).size !==
    definitions.length
  )
    throw new Error("Duplicate integration channel path");
  const resolve = (value: z.infer<typeof endpoint>) => {
    const url = httpUrl.parse(env[value.urlEnv]);
    const authorization = value.authorizationEnv
      ? z
          .string()
          .min(1)
          .regex(/^[\x20-\x7e]+$/)
          .parse(env[value.authorizationEnv])
      : undefined;
    return { url, authorization, timeoutMs: value.timeoutMs };
  };
  return definitions.map((value) => ({
    ...value,
    options: mappings[value.mapping].options.parse(value.options),
    validation: value.validation
      ? {
          ...resolve(value.validation),
          requestProfile: value.validation.requestProfile,
        }
      : undefined,
    nhidGenerator: value.nhidGenerator
      ? resolve(value.nhidGenerator)
      : undefined,
  }));
}
export type Integration = ReturnType<typeof parseIntegrations>[number];
