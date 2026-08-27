import axios from 'axios';
import { orch } from '../lib/orchestration.js';

// The deployed NHFR NamingSystem (NP Core's canonical is https://nhfr.mohp.gov.np;
// the running stack uses this form — keep them aligned).
const NHFR_SYSTEM = 'http://mohp.gov.np/fhir/NamingSystem/nhfr';

export class DownstreamEnvelopeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DownstreamEnvelopeError';
  }
}

export function unwrapOpenHimEnvelope(data) {
  const response = data?.response;
  if (!response || !Number.isInteger(response.status) || typeof response.body !== 'string') {
    throw new DownstreamEnvelopeError('FHIR orchestrator returned an invalid OpenHIM response envelope');
  }

  let body;
  try {
    body = JSON.parse(response.body);
  } catch {
    throw new DownstreamEnvelopeError('FHIR orchestrator returned a non-JSON application body');
  }

  return {
    status: response.status,
    body,
    orchestrations: Array.isArray(data.orchestrations) ? data.orchestrations : [],
  };
}

function decodeWithDirectOrchestration({ data }, { name, method, path, requestBody }) {
  const decoded = unwrapOpenHimEnvelope(data);
  return {
    ...decoded,
    orchestrations: [
      orch(name, method, path, requestBody, decoded.status, decoded.body),
      ...decoded.orchestrations,
    ],
  };
}

export function createFhirOrchestratorClient({ baseURL, timeoutMs, http = axios.create({
  baseURL,
  timeout: timeoutMs,
  validateStatus: () => true,
  headers: {
    Accept: 'application/fhir+json',
    'Content-Type': 'application/fhir+json',
  },
}) }) {
  return {
    // Resolve the facility by its NHFR identifier (the trusted clientID is the
    // NHFR code). Organization.id is a server UUID we don't know up front.
    // Require exactly one match — 0 or 2+ is a configuration error, not a write.
    async findOrganizationByNhfr(nhfrId, headers) {
      const params = {
        identifier: `${NHFR_SYSTEM}|${nhfrId}`,
        _count: 2,
      };
      const response = await http.get('/fhir/Organization', { params, headers });
      const decoded = decodeWithDirectOrchestration(response, {
        name: 'GET FHIR orchestrator Organization search',
        method: 'GET',
        path: '/fhir/Organization',
        requestBody: params,
      });

      if (decoded.status < 200 || decoded.status >= 300) {
        return { ...decoded, organization: null, lookupError: 'downstream' };
      }
      const orgs = (decoded.body?.entry || [])
        .map((entry) => entry.resource)
        .filter((resource) => resource?.resourceType === 'Organization');
      if (orgs.length !== 1) {
        return {
          ...decoded,
          organization: null,
          lookupError: orgs.length === 0 ? 'missing' : 'ambiguous',
        };
      }
      return { ...decoded, organization: orgs[0], lookupError: null };
    },

    async forward(resource, path, headers) {
      const response = await http.post(path, resource, { headers });
      return decodeWithDirectOrchestration(response, {
        name: `POST FHIR orchestrator ${resource.resourceType}`,
        method: 'POST',
        path,
        requestBody: resource,
      });
    },
  };
}
