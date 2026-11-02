import { createPublicKey, verify, type JsonWebKey, type KeyObject } from 'node:crypto';
import axios from 'axios';
import { HttpError } from '../lib/httpError.js';

// Verifies the client's Keycloak access token that OpenHIM forwards (route option
// forwardAuthHeader). OpenHIM already checked the token and its DPoP proof at the
// edge; this hop re-checks signature, issuer and expiry so the caller's identity and
// scopes come from a signed token, never from a header any container could set.

export type Caller = { clientId: string; scopes: string[] };
type Claims = {
  iss?: string;
  exp?: number;
  nbf?: number;
  azp?: string;
  client_id?: string;
  sub?: string;
  scope?: string;
};

const b64 = (s: string) => Buffer.from(s, 'base64url');

export function createTokenVerifier({ issuer, jwksUri }: { issuer: string; jwksUri: string }) {
  let keys = new Map<string, KeyObject>();
  let fetchedAt = 0;

  async function key(kid: string) {
    // Refetch on an unknown kid (key rotation), at most every 30 s.
    if (!keys.has(kid) && Date.now() - fetchedAt > 30_000) {
      const { data } = await axios.get<{ keys: (JsonWebKey & { kid: string; use?: string })[] }>(
        jwksUri,
        { timeout: 5000 },
      );
      keys = new Map(
        data.keys
          .filter((k) => k.kty === 'RSA' && k.use !== 'enc')
          .map((k) => [k.kid, createPublicKey({ key: k, format: 'jwk' })]),
      );
      fetchedAt = Date.now();
    }
    return keys.get(kid);
  }

  return async function verifyAuthorization(header: string | undefined): Promise<Caller> {
    const match = /^(?:DPoP|Bearer) ([\w-]+\.[\w-]+\.[\w-]+)$/.exec(header ?? '');
    if (!match) throw new HttpError(401, 'login', 'Missing or malformed access token');
    const [h, p, s] = match[1].split('.');
    let head: { alg?: string; kid?: string };
    let claims: Claims;
    try {
      head = JSON.parse(b64(h).toString());
      claims = JSON.parse(b64(p).toString());
    } catch {
      throw new HttpError(401, 'login', 'Malformed access token');
    }
    if (head.alg !== 'RS256' || !head.kid) throw new HttpError(401, 'login', 'Unsupported token');
    const publicKey = await key(head.kid);
    if (!publicKey || !verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, b64(s))) {
      throw new HttpError(401, 'login', 'Invalid token signature');
    }
    const now = Date.now() / 1000;
    if (claims.iss !== issuer) throw new HttpError(401, 'login', 'Token issuer not trusted');
    if (!claims.exp || claims.exp < now - 30) throw new HttpError(401, 'login', 'Token expired');
    if (claims.nbf && claims.nbf > now + 30) throw new HttpError(401, 'login', 'Token not yet valid');
    const clientId = claims.azp ?? claims.client_id ?? claims.sub;
    if (!clientId) throw new HttpError(401, 'login', 'Token names no client');
    return { clientId, scopes: (claims.scope ?? '').split(' ').filter(Boolean) };
  };
}

// SMART App Launch v2 scopes (`system/Patient.cru`, `system/*.rs`) plus the v1 forms
// (`system/Patient.write`). Only the `system/` context applies: these are
// backend-service clients.
export function hasScope(scopes: string[], resourceType: string, action: 'c' | 'r' | 'u' | 'd' | 's') {
  return scopes.some((scope) => {
    const m = /^system\/([A-Za-z*]+)\.([a-z*]+)$/.exec(scope);
    if (!m || (m[1] !== resourceType && m[1] !== '*')) return false;
    const perms = m[2];
    if (perms === '*') return true;
    if (perms === 'read') return action === 'r' || action === 's';
    if (perms === 'write') return action === 'c' || action === 'u' || action === 'd';
    return /^c?r?u?d?s?$/.test(perms) && perms.includes(action);
  });
}
