import "dotenv/config";
import { z } from "zod";

const csv = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

const envSchema = z.object({
  MEDIATOR_PORT: z.coerce.number().int().positive().default(4004),
  MEDIATOR_URN: z.string().min(1).default("urn:mediator:np-fhir-gateway"),
  MEDIATOR_ROUTE_HOST: z.string().min(1).default("fhir-gateway-mediator"),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  OPENHIM_API_URL: z.string().url(),
  OPENHIM_USERNAME: z.string().min(1),
  OPENHIM_PASSWORD: z.string().min(1),
  OPENHIM_TRUST_SELF_SIGNED: z.coerce.boolean().default(false),
  KEYCLOAK_ISSUER: z.string().url(),
  KEYCLOAK_AUDIENCE: z.string().min(1).default("account"),
  // Override when the issuer URL in tokens is not reachable from the container (local dev).
  KEYCLOAK_JWKS_URI: z.string().url().optional(),
  PUBLIC_BASE_URL: z.string().url(),
  HAPI_BASE_URL: z.string().url(),
  // true  => upstream HAPI enforces roles itself (hie-fhir-server style): register one
  //          broad /fhir channel and forward realm role as X-Role via ROLE_MAPPINGS.
  // false => stock HAPI: register per-role channels (src/channels.ts), no header.
  UPSTREAM_ROLE_HEADER: z.coerce.boolean().default(false),
  OPENHIM_CHANNEL_ROLES: z
    .string()
    .default("fhir-read,fhir-write")
    .transform(csv),
  ROLE_MAPPINGS: z
    .string()
    .default("hip=ehr,hiu=patient")
    .transform((s) =>
      Object.fromEntries(csv(s).map((p) => p.split("=") as [string, string])),
    ),
});

export function parseConfig(env: Record<string, unknown>) {
  return Object.freeze(envSchema.parse(env));
}

export type Config = ReturnType<typeof parseConfig>;
