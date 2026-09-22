// @ts-nocheck
import { jwtVerify, createRemoteJWKSet } from 'jose';
import { config } from '../config.js';

// Verify the forwarded patient token and return its golden UID.
//   - Keycloak (prod): RS256 verified against the realm JWKS.
//   - Dev fallback: HS256 verified with the shared secret (BFF SESSION_JWT_SECRET).
// This is the mediator's independent check — it does NOT trust a plain header or
// the OpenHIM system auth to tell it which patient the request is for.
let jwks;
function getJwks() {
  if (!jwks) jwks = createRemoteJWKSet(new URL(config.PORTAL_PATIENT_JWKS_URL));
  return jwks;
}

export async function verifyPatientToken(token) {
  const opts = config.PORTAL_PATIENT_TOKEN_ISSUER ? { issuer: config.PORTAL_PATIENT_TOKEN_ISSUER } : {};
  let payload;
  if (config.PORTAL_PATIENT_JWKS_URL) {
    ({ payload } = await jwtVerify(token, getJwks(), opts));
  } else if (config.PORTAL_PATIENT_SHARED_SECRET) {
    const key = new TextEncoder().encode(config.PORTAL_PATIENT_SHARED_SECRET);
    ({ payload } = await jwtVerify(token, key, opts));
  } else {
    throw new Error('patient-token verification not configured (set PORTAL_PATIENT_JWKS_URL or PORTAL_PATIENT_SHARED_SECRET)');
  }

  const goldenUid = payload[config.PORTAL_GID_CLAIM];
  if (!goldenUid) throw new Error(`patient token missing '${config.PORTAL_GID_CLAIM}' claim`);
  return { goldenUid: String(goldenUid), claims: payload };
}
// @ts-nocheck
