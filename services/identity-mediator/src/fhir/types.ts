import type { Request, Response } from 'express';

export type Reference = { reference?: string; identifier?: Identifier; display?: string };
export type Identifier = {
  system?: string;
  value?: string;
  assigner?: Reference;
  [key: string]: unknown;
};
export type Resource = {
  resourceType: string;
  id?: string;
  identifier?: Identifier[];
  name?: { use?: string; given?: string[]; family?: string }[];
  gender?: string;
  birthDate?: string;
  telecom?: { system?: string; value?: string }[];
  address?: { city?: string }[];
  managingOrganization?: Reference;
  subject?: Reference;
  patient?: Reference;
  meta?: { tag?: { system?: string; code?: string }[]; [key: string]: unknown };
  content?: { attachment?: { contentType?: string; data?: string; url?: string } }[];
  type?: string;
  entry?: {
    fullUrl?: string;
    resource?: Resource;
    request?: { method: string; url: string; ifNoneExist?: string };
  }[];
  [key: string]: unknown;
};
export type FhirRequest = Request<
  Record<string, string>,
  unknown,
  Resource,
  Record<string, string>
>;
export type FhirResponse = Response<unknown>;

export type GoldenRecord = { uid?: string; uniqueGoldenRecordData?: { auxId?: string } };
export type JempiResponse = {
  linkInfo?: { goldenUID?: string; interactionUID?: string; interactionID?: string };
  goldenUID?: string;
  goldenUid?: string;
  interactionUID?: string;
  interactionUid?: string;
  exists?: unknown[];
  goldenRecords?: GoldenRecord[];
  candidates?: unknown[];
};
