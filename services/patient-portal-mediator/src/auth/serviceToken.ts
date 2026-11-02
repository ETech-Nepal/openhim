import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import axios from 'axios';

// The portal mediator's own access token for its HAPI reads: client credentials with
// a private_key_jwt assertion, bound to the same key with DPoP (the realm requires DPoP for every
// confidential client). Cached until 30 s before expiry. authHeaders() gives the
// Authorization and DPoP headers for one HAPI call.

const b64 = (v: string | Buffer) => Buffer.from(v).toString('base64url');

function jws(header: object, payload: object, key: KeyObject) {
  const input = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(payload))}`;
  return `${input}.${b64(sign('RSA-SHA256', Buffer.from(input), key))}`;
}

export function dpopProof(key: KeyObject, method: string, url: string, accessToken?: string) {
  const { n, e } = createPublicKey(key).export({ format: 'jwk' });
  const htu = url.split('?')[0].split('#')[0];
  return jws(
    { typ: 'dpop+jwt', alg: 'RS256', jwk: { kty: 'RSA', n, e } },
    {
      htm: method.toUpperCase(),
      htu,
      jti: randomUUID(),
      iat: Math.floor(Date.now() / 1000),
      ...(accessToken && { ath: b64(createHash('sha256').update(accessToken).digest()) }),
    },
    key,
  );
}

// `audience` is the realm issuer: Keycloak accepts it as the assertion audience, and
// unlike the internal token URL it is the same name Keycloak uses for itself.
export function createServiceToken({
  tokenUrl,
  audience,
  clientId,
  keyPath,
}: {
  tokenUrl: string;
  audience: string;
  clientId: string;
  keyPath: string;
}) {
  const key = createPrivateKey(readFileSync(keyPath));
  let cached: { token: string; expiresAt: number } | null = null;

  async function token() {
    if (cached && cached.expiresAt - 30_000 > Date.now()) return cached.token;
    const now = Math.floor(Date.now() / 1000);
    const assertion = jws(
      { alg: 'RS256', typ: 'JWT' },
      { iss: clientId, sub: clientId, aud: audience, jti: randomUUID(), iat: now, exp: now + 60 },
      key,
    );
    const { data } = await axios.post<{ access_token: string; expires_in: number }>(
      tokenUrl,
      new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: assertion,
      }),
      { headers: { DPoP: dpopProof(key, 'POST', tokenUrl) }, timeout: 10000 },
    );
    cached = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
    return cached.token;
  }

  return async function authHeaders(method: string, url: string) {
    const accessToken = await token();
    return { Authorization: `DPoP ${accessToken}`, DPoP: dpopProof(key, method, url, accessToken) };
  };
}
