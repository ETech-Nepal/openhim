#!/usr/bin/env node
// Local helper so Postman never has to sign a JWT itself (no CDN fetch, no
// jsrsasign, no fragile sandbox JS). Run this once:
//   node keycloak/token-server.mjs
// Then in Postman, pre-request script for any request needing auth:
//   pm.sendRequest('http://localhost:4099/token/' + pm.environment.get('CLIENT_ID'),
//     (err, res) => { if (!err) pm.environment.set('access_token', res.json().access_token); });
// and use {{access_token}} as the Bearer token. Nothing else needed.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEYDIR = path.join(__dirname, 'keys');
const REALM = 'openhie';
const TOKEN_URL = `http://localhost:8083/realms/${REALM}/protocol/openid-connect/token`;
const PORT = 4099;

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function buildAssertion(clientId, privPem) {
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(Buffer.from(JSON.stringify({
    iss: clientId, sub: clientId, aud: TOKEN_URL,
    iat: now, nbf: now, exp: now + 300, jti: crypto.randomUUID(),
  })));
  const signingInput = `${header}.${payload}`;
  const signature = b64url(crypto.sign('RSA-SHA256', Buffer.from(signingInput), privPem));
  return `${signingInput}.${signature}`;
}

async function mintToken(clientId) {
  const keyPath = path.join(KEYDIR, `${clientId}.key.pem`);
  if (!fs.existsSync(keyPath)) throw { status: 404, message: `no key for client '${clientId}' at ${keyPath}` };
  const privPem = fs.readFileSync(keyPath, 'utf8');
  const assertion = buildAssertion(clientId, privPem);

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: assertion,
  }).toString();

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json();
  if (!res.ok) throw { status: res.status, message: data.error_description || data.error || 'token request failed' };
  return data;
}

const server = http.createServer(async (req, res) => {
  const m = req.url.match(/^\/token\/([^/?]+)/);
  if (!m) { res.writeHead(404); res.end('use GET /token/<client-id>'); return; }
  try {
    const data = await mintToken(decodeURIComponent(m[1]));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  } catch (err) {
    res.writeHead(err.status || 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message || String(err) }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Token helper listening on http://localhost:${PORT} — GET /token/<client-id>`);
});
