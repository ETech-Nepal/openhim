import 'dotenv/config';
import https from 'node:https';
import axios from 'axios';
import { authenticate, genAuthHeaders } from 'openhim-mediator-utils';
const cands = process.argv[2].split(',');
for (const p of cands) {
  const opts = { apiURL: process.env.OPENHIM_API_URL, username: 'root@openhim.org', password: p, trustSelfSigned: true };
  const ok = await new Promise((res) => authenticate(opts, async (err) => {
    if (err) return res('authfail: ' + err.message);
    const api = axios.create({ baseURL: opts.apiURL, headers: genAuthHeaders(opts), httpsAgent: new https.Agent({ rejectUnauthorized: false }) });
    try { const { data } = await api.get('/clients'); res('OK (' + data.length + ' clients)'); }
    catch (e) { res('HTTP ' + (e.response?.status || e.message)); }
  }));
  console.log(p.padEnd(24), ok);
}
