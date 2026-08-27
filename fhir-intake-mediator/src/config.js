import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  MEDIATOR_PORT: z.coerce.number().int().positive().default(4003),
  MEDIATOR_URN: z.string().min(1),
  MEDIATOR_ROUTE_HOST: z.string().min(1).default('fhir-intake-mediator'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  OPENHIM_API_URL: z.string().url(),
  OPENHIM_USERNAME: z.string().min(1),
  OPENHIM_PASSWORD: z.string().min(1),
  OPENHIM_TRUST_SELF_SIGNED: z.coerce.boolean().default(false),
  OPENHIM_CHANNEL_ROLE: z.string().min(1).default('np-fhir-intake-clients'),
  FHIR_ORCHESTRATOR_BASE_URL: z.string().url(),
  FHIR_ORCHESTRATOR_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
});

// Facility identity model: the authenticated OpenHIM client's `clientID`
// (from `X-OpenHIM-ClientID`, which equals the Keycloak token `sub`) IS the
// FHIR `Organization.id`. No registry, no NHFR lookup — the mediator references
// `Organization/<clientID>` directly and lets the FHIR store confirm it exists.
export function parseConfig(env) {
  return Object.freeze(envSchema.parse(env));
}
