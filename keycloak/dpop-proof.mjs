#!/usr/bin/env node
// Build a DPoP proof (RFC 9449) signed with a client's private key.
//   node keycloak/dpop-proof.mjs <key.pem> <METHOD> <URL> [access_token]
// Pass the access token for resource requests (adds `ath`); omit it for the token endpoint.
import crypto from 'node:crypto';
import fs from 'node:fs';

const [keyFile, htm, htu, token] = process.argv.slice(2);
if (!keyFile || !htm || !htu) {
  console.error('usage: dpop-proof.mjs <key.pem> <METHOD> <URL> [access_token]');
  process.exit(1);
}
const b64url = (b) => Buffer.from(b).toString('base64url');
const priv = crypto.createPrivateKey(fs.readFileSync(keyFile));
const { kty, n, e } = crypto.createPublicKey(priv).export({ format: 'jwk' });
const header = b64url(JSON.stringify({ typ: 'dpop+jwt', alg: 'RS256', jwk: { kty, n, e } }));
const payload = b64url(JSON.stringify({
  htm, htu: htu.split('?')[0], jti: crypto.randomUUID(), iat: Math.floor(Date.now() / 1000),
  ...(token ? { ath: crypto.createHash('sha256').update(token).digest('base64url') } : {}),
}));
const sig = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), priv);
process.stdout.write(`${header}.${payload}.${b64url(sig)}`);
