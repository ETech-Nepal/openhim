import { upstreamError } from './lib/errors.js';
import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  MEDIATOR_PORT: z.coerce.number().default(4000),
  MEDIATOR_URN: z.string().min(1),
  // Host OpenHIM uses to reach this mediator. In Docker this is the container/service
  // name (`mediator`); when running on the host it would be `host.docker.internal`.
  MEDIATOR_ROUTE_HOST: z.string().default('mediator'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  OPENHIM_API_URL: z.string().url(),
  OPENHIM_USERNAME: z.string().min(1),
  OPENHIM_PASSWORD: z.string().min(1),
  OPENHIM_TRUST_SELF_SIGNED: z.coerce.boolean().default(false),
  OPENHIM_CHANNEL_ROLE: z.string().default('np-fhir-clients'),

  HAPI_FHIR_BASE_URL: z.string().url(),
  HAPI_TIMEOUT_MS: z.coerce.number().default(15000),

  JEMPI_BASE_URL: z.string().url(),
  JEMPI_REGISTER_ROUTE: z.string().min(1),
  JEMPI_FIND_ROUTE: z.string().min(1),
  // Used to resolve the golden UID when crRegister reports a deterministic
  // duplicate (its `exists` response carries no UID).
  JEMPI_CANDIDATES_ROUTE: z.string().default('/crCandidates'),
  JEMPI_GOLDEN_GET_ROUTE: z.string().min(1),
  JEMPI_TIMEOUT_MS: z.coerce.number().default(10000),
  // crRegister dedup confidence: an existing golden record must score >= this for
  // the registration to link to it synchronously; otherwise a new record is made.
  JEMPI_CANDIDATE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.9),
  // Fallback facility when the authenticated client has no FACILITY_REGISTRY entry.
  JEMPI_DEFAULT_FACILITY: z.string().default('UNKNOWN'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid env config:', parsed.error.format());
  process.exit(1);
}
export const config = parsed.data;

let facilityRegistry: Record<string, string> = {};
try {
  facilityRegistry = JSON.parse(process.env.FACILITY_REGISTRY_JSON || '{}');
} catch (caught) {
  const err = upstreamError(caught);
  console.error('Invalid FACILITY_REGISTRY_JSON:', err.message);
  process.exit(1);
}
export { facilityRegistry };
