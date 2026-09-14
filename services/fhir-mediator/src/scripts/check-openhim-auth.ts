import 'dotenv/config';
import https from 'node:https';
import axios from 'axios';
import { authenticate, genAuthHeaders } from 'openhim-mediator-utils';
const candidates = process.argv[2];
if (!candidates || !process.env.OPENHIM_API_URL)
  throw new Error('Supply candidates and OPENHIM_API_URL');
const cands = candidates.split(',');
for (const p of cands) {
  const opts = {
    apiURL: process.env.OPENHIM_API_URL!,
    username: 'root@openhim.org',
    password: p,
    trustSelfSigned: true,
  };
  const ok = await new Promise<string>((res) =>
    authenticate(opts, async (err) => {
      if (err) return res('authfail: ' + err.message);
      const api = axios.create({
        baseURL: opts.apiURL,
        headers: genAuthHeaders(opts),
        httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      });
      try {
        const { data } = await api.get<unknown[]>('/clients');
        res('OK (' + data.length + ' clients)');
      } catch (e) {
        res('HTTP ' + (axios.isAxiosError(e) ? (e.response?.status ?? e.message) : String(e)));
      }
    }),
  );
  console.log(`Candidate ${cands.indexOf(p) + 1}:`, ok);
}
