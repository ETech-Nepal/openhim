// Idempotently create/update the OpenHIM client for the CDRS dump script
// (health-information-provider) on the `NP FHIR Orchestrator` channel.
//
// Keycloak path: the script authenticates to Keycloak with private_key_jwt and
// sends the resulting RS256 token as `Authorization: Bearer <jwt>`. OpenHIM
// verifies it against the realm public key and maps the token's `sub` claim to a
// Client's clientID — so clientID here is the Keycloak SERVICE ACCOUNT USER ID,
// not the Keycloak clientId string. There is no password: OpenHIM never does a
// basic-auth check for this client.
//
// Get the sub with:
//   docker exec <keycloak> /opt/keycloak/bin/kcadm.sh get \
//     clients/<id>/service-account-user -r openhie --fields id
//
// Run inside the container (it has the deps + OpenHIM root creds in .env):
//   docker exec -e HIP_CLIENT_SUB=<uuid> mediator node scripts/create-hip-client.js
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

const opts = {
  apiURL: process.env.OPENHIM_API_URL,
  username: process.env.OPENHIM_USERNAME,
  password: process.env.OPENHIM_PASSWORD,
  trustSelfSigned: String(process.env.OPENHIM_TRUST_SELF_SIGNED) === 'true',
};

const client = { clientID: CLIENT_ID, name: CLIENT_NAME, roles: [ROLE] };

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
