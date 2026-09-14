// Provision an OpenHIM client only when explicitly invoked.
import { z } from 'zod';
import 'dotenv/config';
import https from 'node:https';
import axios from 'axios';
import { authenticate, genAuthHeaders } from 'openhim-mediator-utils';

const CLIENT_ID = process.env.HIP_CLIENT_SUB;
const CLIENT_NAME = process.env.HIP_CLIENT_NAME || 'CDRS Health Information Provider';
const ROLE = process.env.OPENHIM_CHANNEL_ROLE || 'np-fhir-clients';

if (!CLIENT_ID) {
  console.error("Set HIP_CLIENT_SUB to the Keycloak service-account user id (the token's `sub`).");
  process.exit(1);
}

const env = z
  .object({
    OPENHIM_API_URL: z.string().url(),
    OPENHIM_USERNAME: z.string().min(1),
    OPENHIM_PASSWORD: z.string().min(1),
  })
  .parse(process.env);

const opts = {
  apiURL: env.OPENHIM_API_URL,
  username: env.OPENHIM_USERNAME,
  password: env.OPENHIM_PASSWORD,
  trustSelfSigned: String(process.env.OPENHIM_TRUST_SELF_SIGNED) === 'true',
};

const client = { clientID: CLIENT_ID, name: CLIENT_NAME, roles: [ROLE] };

function authHeaders() {
  return new Promise<Record<string, string>>((resolve, reject) => {
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

  const { data: existing } = await api.get<{ clientID: string; _id: string }[]>('/clients');
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
