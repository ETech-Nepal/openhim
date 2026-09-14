import axios from 'axios';
import { orch } from '../lib/orchestration.js';
import {
  isRecord,
  type DownstreamResult,
  type FhirClient,
  type Headers,
  type OrganizationResult,
} from '../types.js';

type HttpClient = {
  get(
    path: string,
    options: { params: Record<string, string | number>; headers: Headers },
  ): Promise<{ data: unknown }>;
  post(path: string, resource: unknown, options: { headers: Headers }): Promise<{ data: unknown }>;
};

// The deployed NHFR NamingSystem (NP Core's canonical is https://nhfr.mohp.gov.np;
// the running stack uses this form — keep them aligned).
const NHFR_SYSTEM = 'http://mohp.gov.np/fhir/NamingSystem/nhfr';

export class DownstreamEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DownstreamEnvelopeError';
  }
}

export function unwrapOpenHimEnvelope(data: unknown): DownstreamResult {
  const response = isRecord(data) ? data.response : undefined;
  if (
    !isRecord(response) ||
    typeof response.status !== 'number' ||
    !Number.isInteger(response.status) ||
    typeof response.body !== 'string'
  ) {
    throw new DownstreamEnvelopeError(
      'FHIR orchestrator returned an invalid OpenHIM response envelope',
    );
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
    orchestrations: isRecord(data) && Array.isArray(data.orchestrations) ? data.orchestrations : [],
  };
}

function decodeWithDirectOrchestration(
  { data }: { data: unknown },
  {
    name,
    method,
    path,
    requestBody,
  }: { name: string; method: string; path: string; requestBody: unknown },
) {
  const decoded = unwrapOpenHimEnvelope(data);
  return {
    ...decoded,
    orchestrations: [
      orch(name, method, path, requestBody, decoded.status, decoded.body),
      ...decoded.orchestrations,
    ],
  };
}

export function createFhirOrchestratorClient({
  baseURL,
  timeoutMs,
  http = axios.create({
    baseURL,
    timeout: timeoutMs,
    validateStatus: () => true,
    headers: {
      Accept: 'application/fhir+json',
      'Content-Type': 'application/fhir+json',
    },
  }),
}: {
  baseURL: string;
  timeoutMs: number;
  http?: HttpClient;
}): FhirClient {
  return {
    // Resolve exactly one Organization by the authenticated facility NHFR identifier.
    async findOrganizationByNhfr(nhfrId, headers): Promise<OrganizationResult> {
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
      const entries =
        isRecord(decoded.body) && Array.isArray(decoded.body.entry) ? decoded.body.entry : [];
      const orgs = entries
        .map((entry: unknown) => (isRecord(entry) ? entry.resource : undefined))
        .filter(
          (resource): resource is Record<string, unknown> =>
            isRecord(resource) && resource.resourceType === 'Organization',
        );
      if (orgs.length !== 1) {
        return {
          ...decoded,
          organization: null,
          lookupError: orgs.length === 0 ? 'missing' : 'ambiguous',
        };
      }
      const organization = orgs[0];
      if (
        typeof organization.id !== 'string' ||
        (organization.name !== undefined && typeof organization.name !== 'string')
      ) {
        throw new DownstreamEnvelopeError('FHIR orchestrator returned an invalid Organization');
      }
      return {
        ...decoded,
        organization: { id: organization.id, name: organization.name },
        lookupError: null,
      };
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
