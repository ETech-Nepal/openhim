// @ts-nocheck
import 'dotenv/config';
import { z } from 'zod';

// Dedicated read-only mediator for the patient portal. It exposes /patient-portal
// /resolve and /summary through its own OpenHIM channel, verifies the forwarded
// patient token, and reads HAPI with its own read-only client token. It never writes
// and never touches JeMPI.
const schema = z.object({
  MEDIATOR_PORT: z.coerce.number().default(4001),
  MEDIATOR_URN: z.string().min(1),
  // Host OpenHIM uses to reach this mediator. In Docker this is the service name.
  MEDIATOR_ROUTE_HOST: z.string().default('patient-portal-mediator'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  OPENHIM_API_URL: z.string().url(),
  OPENHIM_USERNAME: z.string().min(1),
  OPENHIM_PASSWORD: z.string().min(1),
  OPENHIM_TRUST_SELF_SIGNED: z.coerce.boolean().default(false),
  // Role bound to the read-only patient-portal channel (portal BFF system client holds it).
  OPENHIM_PORTAL_CHANNEL_ROLE: z.string().default('patient-portal-clients'),

  HAPI_FHIR_BASE_URL: z.string().url(),
  HAPI_TIMEOUT_MS: z.coerce.number().default(15000),

  // This mediator's own Keycloak client for its HAPI reads (private_key_jwt + DPoP;
  // single_stack: onboard-client.sh patient-portal-mediator ... patient-portal-mediator).
  KEYCLOAK_TOKEN_URL: z.string().url(),
  KEYCLOAK_ISSUER: z.string().url(),
  PORTAL_CLIENT_ID: z.string().default('patient-portal-mediator'),
  PORTAL_CLIENT_KEY_PATH: z.string().default('/run/secrets/patient-portal-mediator.key.pem'),

  // ── Verify the forwarded X-Patient-Token ─────────────────────────────────────
  // Production: verify Keycloak-issued RS256 tokens via JWKS.
  PORTAL_PATIENT_JWKS_URL: z.string().url().optional(),      // …/realms/<realm>/protocol/openid-connect/certs
  PORTAL_PATIENT_TOKEN_ISSUER: z.string().optional(),
  // Dev fallback: HS256 verification with the BFF's SESSION_JWT_SECRET.
  PORTAL_PATIENT_SHARED_SECRET: z.string().optional(),
  // Claim carrying the JeMPI golden UID inside the patient token.
  PORTAL_GID_CLAIM: z.string().default('gid'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid env config:', parsed.error.format());
  process.exit(1);
}
export const config = parsed.data;
// @ts-nocheck
