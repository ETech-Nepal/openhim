import type { Logger } from 'pino';
import type { Config } from './config.js';

export type FhirInput = { resourceType: string; [key: string]: unknown };
export type Headers = Record<string, string>;
export type DownstreamResult = { status: number; body: unknown; orchestrations: unknown[] };
export type Organization = { id: string; name?: string };
export type OrganizationResult = DownstreamResult &
  (
    | { lookupError: null; organization: Organization }
    | { lookupError: 'downstream'; organization: null }
    | { lookupError: 'missing'; organization: null }
    | { lookupError: 'ambiguous'; organization: null }
  );
export type FhirClient = {
  findOrganizationByNhfr(id: string, headers: Headers): Promise<OrganizationResult>;
  forward(resource: FhirInput, path: string, headers: Headers): Promise<DownstreamResult>;
};
export type IngestDependencies = { config: Pick<Config, 'MEDIATOR_URN'>; fhirClient: FhirClient };
export type AppDependencies = IngestDependencies & { logger: Logger };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

declare global {
  namespace Express {
    interface Request {
      inputKind?: 'raw' | 'fhir' | null;
    }
  }
}
