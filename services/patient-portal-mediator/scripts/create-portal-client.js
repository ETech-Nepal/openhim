// Idempotently create/update the OpenHIM `patient-portal` system client that the
// patient-portal BFF uses to reach this mediator's channel.
//
// Basic-auth path (dev): this OpenHIM build authenticates a client by
//   passwordAlgorithm='bcrypt' + bcrypt.compare(password, passwordHash).
// (If passwordAlgorithm is a crypto hash name like 'sha512' it instead does
//  sha512(pass+salt) === passwordHash — we deliberately use bcrypt.)
//
// Run inside the container (it has the deps + OpenHIM root creds in .env):
//   docker exec -e PORTAL_CLIENT_PASSWORD=<same-as-BFF> \
//     patient-portal-mediator node scripts/create-portal-client.js
//
// Keycloak (prod) path: instead of a password, set this client's clientID to the
// `sub` of the BFF's client-credentials token and drop the password fields.
import 'dotenv/config';
import https from 'node:https';
import axios from 'axios';
import bcrypt from 'bcryptjs';
import { authenticate, genAuthHeaders } from 'openhim-mediator-utils';

const CLIENT_ID = process.env.PORTAL_CLIENT_ID || 'patient-portal';
const CLIENT_NAME = 'Patient Portal BFF';
const ROLE = process.env.OPENHIM_PORTAL_CHANNEL_ROLE || 'patient-portal-clients';
const PASSWORD = process.env.PORTAL_CLIENT_PASSWORD;

if (!PASSWORD) {
  console.error('Set PORTAL_CLIENT_PASSWORD (must match the BFF OPENHIM_CLIENT_PASSWORD).');
  process.exit(1);
}

const opts = {
  apiURL: process.env.OPENHIM_API_URL,
  username: process.env.OPENHIM_USERNAME,
  password: process.env.OPENHIM_PASSWORD,
  trustSelfSigned: String(process.env.OPENHIM_TRUST_SELF_SIGNED) === 'true',
};

const client = {
  clientID: CLIENT_ID,
  name: CLIENT_NAME,
  roles: [ROLE],
  passwordAlgorithm: 'bcrypt',
  passwordHash: bcrypt.hashSync(PASSWORD, 10),
  // Ensure the legacy sha512 path is not triggered.
  passwordSalt: null,
  passwordSha512: null,
};

function authHeaders() {
  return new Promise((resolve, reject) => {
    authenticate(opts, (err) => (err ? reject(err) : resolve(genAuthHeaders(opts))));
  });
}

async function main() {
  const headers = await authHeaders();
  const api = axios.create({
    baseURL: opts.apiURL,
    headers,
    timeout: 10000,
    httpsAgent: new https.Agent({ rejectUnauthorized: !opts.trustSelfSigned }),
  });

  const { data: existing } = await api.get('/clients');
  const match = existing.find((c) => c.clientID === CLIENT_ID);
  if (match) {
    await api.put(`/clients/${match._id}`, client);
    console.log(`✓ updated OpenHIM client '${CLIENT_ID}' (role: ${ROLE})`);
  } else {
    await api.post('/clients', client);
    console.log(`✓ created OpenHIM client '${CLIENT_ID}' (role: ${ROLE})`);
  }
}

main().catch((err) => {
  console.error('Failed:', err.response?.data || err.message);
  process.exit(1);
});
