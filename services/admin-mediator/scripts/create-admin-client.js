// Idempotently create/update the OpenHIM `admin-portal` system client that the admin
// portal BFF uses to reach this mediator's channel.
//
// Basic-auth path (dev): this OpenHIM build authenticates a client by
//   passwordAlgorithm='bcrypt' + bcrypt.compare(password, passwordHash).
// (If passwordAlgorithm is a crypto hash name like 'sha512' it instead does
//  sha512(pass+salt) === passwordHash — we deliberately use bcrypt.)
//
// Run inside the container (it has the deps + OpenHIM root creds in .env):
//   docker exec -e ADMIN_CLIENT_PASSWORD=<same-as-BFF> \
//     admin-mediator node scripts/create-admin-client.js
import 'dotenv/config';
import https from 'node:https';
import axios from 'axios';
import bcrypt from 'bcryptjs';
import { authenticate, genAuthHeaders } from 'openhim-mediator-utils';

const CLIENT_ID = process.env.ADMIN_CLIENT_ID || 'admin-portal';
const CLIENT_NAME = 'Patient Admin Portal BFF';
const ROLE = process.env.OPENHIM_CHANNEL_ROLE || 'np-admin-clients';
const PASSWORD = process.env.ADMIN_CLIENT_PASSWORD;

if (!PASSWORD) {
  console.error('Set ADMIN_CLIENT_PASSWORD (must match the BFF OPENHIM_CLIENT_PASSWORD).');
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
