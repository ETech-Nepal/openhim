import { postResource } from '../fhir/hapiClient.js';
import { buildOpenHIMResponse, orch } from '../lib/orchestration.js';
import { config } from '../config.js';

export async function organizationHandler(req, res) {
  const org = req.body;
  const result = await postResource('Organization', org);
  res.status(result.status).json(buildOpenHIMResponse({
    status: result.status, body: result.data,
    orchestrations: [orch('POST HAPI Organization', 'POST', '/Organization', org, result.status, result.data)],
    urn: config.MEDIATOR_URN,
  }));
}
