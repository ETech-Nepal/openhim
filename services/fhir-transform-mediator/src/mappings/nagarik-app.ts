import { z } from "zod";

const core = "http://fhir.digitalhealth.gov.np/core";
const identifierTypeSystem = `${core}/CodeSystem/np-core-identifier-type`;
const locationSystem = `${core}/CodeSystem/nepal-administrative-location`;
const healthIdSystem = `${core}/NamingSystem/nepal-health-id`;
const bsDateExtension = `${core}/StructureDefinition/np-core-bikram-sambat-date`;
const casteExtension = `${core}/StructureDefinition/caste-ethnicity`;
const addressExtensions = {
  province: `${core}/StructureDefinition/ext-nepal-province`,
  district: `${core}/StructureDefinition/ext-nepal-district`,
  localLevel: `${core}/StructureDefinition/ext-nepal-local-level`,
};
const identifierSystems = {
  nationalId: "http://donidcr.gov.np",
  citizenshipNumber: "http://moha.gov.np",
  healthInsuranceNumber: "http://hib.gov.np",
  healthId: healthIdSystem,
};

export const nagarikAppOptions = z.object({}).strict();

const genderCodes = { M: "male", F: "female", O: "other", U: "unknown" };

const errorMessages: Record<string, string> = {
  request_mapping_failed: "The submitted registration data is invalid.",
  fhir_validation_failed: "The submitted citizen data failed validation.",
  validator_failed:
    "The validation service could not validate the citizen data.",
  nhid_service_failed: "The NHID service could not complete the registration.",
  nhid_missing_fields:
    "The registration is missing fields the NHID service requires.",
  nhid_missing_gender_or_phone:
    "Gender and mobile number are required to generate a new Health ID.",
  nhid_rejected_resource:
    "The NHID service rejected the generated patient resource.",
  nhid_identity_mismatch:
    "A record with this national ID exists, but its details do not match this registration.",
  nhid_existing_record:
    "A record with this national ID exists without a Health ID.",
  response_mapping_failed: "The NHID service returned an invalid response.",
  upstream_timeout: "The NHID service did not respond in time.",
  upstream_unavailable: "The NHID service is unavailable.",
};

// Fixed text per field so the app can show why a request was rejected without echoing its values.
const fieldRules: Record<string, string> = {
  requestId: "must be 1-100 characters",
  source: 'must be "nagarik-app"',
  "citizen.nationalId": "must be 1-100 characters",
  "citizen.citizenshipNumber": "must be 1-100 characters",
  "citizen.healthInsuranceNumber": "must be 1-100 characters",
  "citizen.nameEn.given": "must be 1-100 characters",
  "citizen.nameEn.family": "must be 1-100 characters",
  "citizen.nameNe.given": "must be 1-100 characters",
  "citizen.nameNe.family": "must be 1-100 characters",
  "citizen.gender": "must be one of M, F, O, U",
  "citizen.dobAD": "must be a valid AD date in YYYY-MM-DD format",
  "citizen.dobBS":
    "must be a BS date in YYYY-MM-DD format (month 01-12, day 01-32)",
  "citizen.casteEthnicityCode": 'must be one of "1" to "6"',
  "citizen.mobile":
    "must be +977 followed by 10 digits, for example +9779801234567",
  "citizen.email": "must be a valid email address of at most 254 characters",
  "citizen.permanentAddress.provinceCode": "must be 1-2 digits",
  "citizen.permanentAddress.districtCode": "must be 3 digits",
  "citizen.permanentAddress.localLevelCode": "must be 5 digits",
  "citizen.permanentAddress.wardNo": "must be a whole number from 1 to 99",
  "citizen.permanentAddress.tole": "must be 1-200 characters",
  "citizen.permanentAddress.postalCode": "must be 1-20 characters",
};

const mappingIssue = z
  .object({
    code: z.string(),
    path: z.array(z.union([z.string(), z.number()])),
    received: z.string().optional(),
    keys: z.array(z.string()).optional(),
  })
  .passthrough();

function describe(issue: z.infer<typeof mappingIssue>) {
  const field = issue.path.join(".");
  const message =
    issue.code === "unrecognized_keys"
      ? `${field || "request"} has unknown field(s): ${issue.keys?.join(", ")}`
      : issue.code === "invalid_type" && issue.received === "undefined"
        ? `${field} is required`
        : `${field} ${fieldRules[field] ?? "is invalid"}`;
  return { ...issue, field, message };
}

const name = z
  .object({
    given: z.string().trim().min(1).max(100),
    family: z.string().trim().min(1).max(100),
  })
  .strict();

const inputSchema = z
  .object({
    requestId: z.string().trim().min(1).max(100),
    source: z.literal("nagarik-app"),
    citizen: z
      .object({
        nationalId: z.string().trim().min(1).max(100),
        citizenshipNumber: z.string().trim().min(1).max(100).optional(),
        healthInsuranceNumber: z.string().trim().min(1).max(100).optional(),
        nameEn: name,
        nameNe: name.optional(),
        gender: z.enum(["M", "F", "O", "U"]),
        // Bikram Sambat months run up to 32 days, so this is not a Gregorian date check.
        // ponytail: shape only; a BS calendar table would reject e.g. 2047-12-32.
        dobBS: z
          .string()
          .regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[0-2])$/)
          .optional(),
        dobAD: z.string().date(),
        casteEthnicityCode: z.enum(["1", "2", "3", "4", "5", "6"]).optional(),
        mobile: z
          .string()
          .regex(/^\+977\d{10}$/)
          .optional(),
        email: z.string().email().max(254).optional(),
        permanentAddress: z
          .object({
            provinceCode: z.string().regex(/^\d{1,2}$/),
            districtCode: z.string().regex(/^\d{3}$/),
            localLevelCode: z.string().regex(/^\d{5}$/),
            wardNo: z.number().int().min(1).max(99),
            tole: z.string().trim().min(1).max(200).optional(),
            postalCode: z.string().trim().min(1).max(20).optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict();

const identifier = (
  system: string,
  value: string,
  code: string,
  display: string,
) => ({
  use: "official",
  type: { coding: [{ system: identifierTypeSystem, code, display }] },
  system,
  value,
});

export function toFhir(
  input: unknown,
  _options: Record<string, string>,
): Record<string, unknown> {
  const { citizen } = inputSchema.parse(input);
  const address = citizen.permanentAddress;
  return {
    resourceType: "Patient",
    meta: { profile: [`${core}/StructureDefinition/np-core-patient`] },
    active: true,
    identifier: [
      {
        use: "official",
        type: {
          coding: [
            {
              system: "http://terminology.hl7.org/CodeSystem/v2-0203",
              code: "NI",
              display: "National unique individual identifier",
            },
          ],
        },
        system: "http://donidcr.gov.np",
        value: citizen.nationalId,
      },
      ...(citizen.citizenshipNumber
        ? [
            identifier(
              "http://moha.gov.np",
              citizen.citizenshipNumber,
              "citizenship-number",
              "Nepal Citizenship Certificate Number",
            ),
          ]
        : []),
      ...(citizen.healthInsuranceNumber
        ? [
            identifier(
              "http://hib.gov.np",
              citizen.healthInsuranceNumber,
              "health-insurance-id",
              "Nepal Health Insurance ID",
            ),
          ]
        : []),
    ],
    // NP Core has no language field on HumanName. The order is English, then Nepali.
    name: [
      {
        use: "official",
        family: citizen.nameEn.family,
        given: [citizen.nameEn.given],
      },
      ...(citizen.nameNe
        ? [
            {
              use: "official",
              family: citizen.nameNe.family,
              given: [citizen.nameNe.given],
            },
          ]
        : []),
    ],
    gender: genderCodes[citizen.gender],
    birthDate: citizen.dobAD,
    ...(citizen.dobBS && {
      _birthDate: {
        extension: [
          {
            url: `${core}/StructureDefinition/np-core-bikram-sambat-date`,
            valueString: citizen.dobBS,
          },
        ],
      },
    }),
    ...(citizen.casteEthnicityCode && {
      extension: [
        {
          url: `${core}/StructureDefinition/caste-ethnicity`,
          valueCoding: {
            system: `${core}/CodeSystem/nepal-caste-ethnicity`,
            code: citizen.casteEthnicityCode,
          },
        },
      ],
    }),
    ...(citizen.mobile || citizen.email
      ? {
          telecom: [
            ...(citizen.mobile
              ? [{ system: "phone", value: citizen.mobile, use: "mobile" }]
              : []),
            ...(citizen.email
              ? [{ system: "email", value: citizen.email }]
              : []),
          ],
        }
      : {}),
    ...(address && {
      address: [
        {
          use: "home",
          type: "physical",
          line: [
            `Ward ${address.wardNo}`,
            ...(address.tole ? [address.tole] : []),
          ],
          postalCode: address.postalCode,
          country: "NP",
          extension: ["province", "district", "local-level"].map((level) => ({
            url: `${core}/StructureDefinition/ext-nepal-${level}`,
            valueCoding: {
              system: locationSystem,
              code:
                level === "province"
                  ? address.provinceCode
                  : level === "district"
                    ? address.districtCode
                    : address.localLevelCode,
            },
          })),
        },
      ],
    }),
  };
}

const coding = z.object({ code: z.string().optional() }).passthrough();
const extension = z
  .object({
    url: z.string(),
    valueString: z.string().optional(),
    valueCoding: coding.optional(),
  })
  .passthrough();
const responsePatient = z
  .object({
    resourceType: z.literal("Patient"),
    identifier: z
      .array(
        z
          .object({ system: z.string().optional(), value: z.string() })
          .passthrough(),
      )
      .default([]),
    name: z
      .array(
        z
          .object({
            family: z.string().optional(),
            given: z.array(z.string()).default([]),
          })
          .passthrough(),
      )
      .default([]),
    gender: z.string().optional(),
    birthDate: z.string().optional(),
    _birthDate: z.object({ extension: z.array(extension) }).optional(),
    extension: z.array(extension).default([]),
    telecom: z
      .array(
        z
          .object({ system: z.string().optional(), value: z.string() })
          .passthrough(),
      )
      .default([]),
    address: z
      .array(
        z
          .object({
            line: z.array(z.string()).default([]),
            postalCode: z.string().optional(),
            country: z.string().optional(),
            extension: z.array(extension).default([]),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

const optional = <T>(value: T | undefined, key: string) =>
  value === undefined ? {} : { [key]: value };

// The response reads the NP Core Patient the NHID service stored: FHIR element names and
// IG codes, flattened for the app. NP Core carries no ward element, so the ward and tole
// round-trip through address.line, the way toFhir writes them.
export function fromFhir(
  response: unknown,
  input: unknown,
  _options: Record<string, string>,
): Record<string, unknown> {
  const { requestId } = z
    .object({ requestId: z.string() })
    .passthrough()
    .parse(input);
  const patient = responsePatient.parse(response);
  const identifier = (system: string) =>
    patient.identifier.find((entry) => entry.system === system)?.value;
  const contact = (system: string) =>
    patient.telecom.find((entry) => entry.system === system)?.value;
  const coded = (extensions: z.infer<typeof extension>[], url: string) =>
    extensions.find((entry) => entry.url === url)?.valueCoding?.code;
  const address = patient.address[0];
  const ward = address?.line[0]?.match(/^Ward (\d{1,2})$/)?.[1];
  return {
    requestId,
    source: "nagarik-app",
    patient: {
      ...Object.fromEntries(
        Object.entries(identifierSystems)
          .map(([key, system]) => [key, identifier(system)])
          .filter(([, value]) => value !== undefined),
      ),
      name: patient.name.map((entry) => ({
        ...optional(entry.given.length ? entry.given : undefined, "given"),
        ...optional(entry.family, "family"),
      })),
      ...optional(patient.gender, "gender"),
      ...optional(patient.birthDate, "birthDate"),
      ...optional(
        patient._birthDate?.extension.find(
          (entry) => entry.url === bsDateExtension,
        )?.valueString,
        "birthDateBS",
      ),
      ...optional(coded(patient.extension, casteExtension), "casteEthnicity"),
      telecom: {
        ...optional(contact("phone"), "phone"),
        ...optional(contact("email"), "email"),
      },
      ...(address && {
        address: {
          ...Object.fromEntries(
            Object.entries(addressExtensions)
              .map(([key, url]) => [key, coded(address.extension, url)])
              .filter(([, value]) => value !== undefined),
          ),
          ...optional(ward ? Number(ward) : undefined, "wardNo"),
          ...optional(address.line[1], "tole"),
          ...optional(address.postalCode, "postalCode"),
          ...optional(address.country, "country"),
        },
      }),
    },
  };
}

// Maps a validator FHIRPath back to the Nagarik field it was built from. It does not check
// anything; the validator decides what is wrong. Indexes are looked up in the Patient toFhir
// builds from the same input, because optional fields shift them.
const identifierFields: Record<string, string> = {
  [identifierSystems.nationalId]: "citizen.nationalId",
  [identifierSystems.citizenshipNumber]: "citizen.citizenshipNumber",
  [identifierSystems.healthInsuranceNumber]: "citizen.healthInsuranceNumber",
};
const addressFields: Record<string, string> = {
  [addressExtensions.province]: "provinceCode",
  [addressExtensions.district]: "districtCode",
  [addressExtensions.localLevel]: "localLevelCode",
};
type Built = {
  identifier?: Array<{ system?: string }>;
  extension?: Array<{ url?: string }>;
  telecom?: Array<{ system?: string }>;
  address?: Array<{ extension?: Array<{ url?: string }> }>;
};

function fieldFor(patient: Built, expression: string) {
  const [, first, second] = expression.split(".").map((segment) => {
    const [, name, index] = segment.match(/^(\w+)(?:\[(\d+)\])?$/) ?? [];
    return { name, index: index === undefined ? undefined : Number(index) };
  });
  const at = <T>(list: T[] | undefined, index?: number) =>
    index === undefined ? undefined : list?.[index];
  switch (first?.name) {
    case "identifier": {
      const system = at(patient.identifier, first.index)?.system;
      return system ? identifierFields[system] : undefined;
    }
    case "name": {
      const name = first.index === 1 ? "citizen.nameNe" : "citizen.nameEn";
      return second?.name === "given" || second?.name === "family"
        ? `${name}.${second.name}`
        : name;
    }
    case "gender":
      return "citizen.gender";
    case "birthDate":
      return second?.name === "extension" ? "citizen.dobBS" : "citizen.dobAD";
    case "_birthDate":
      return "citizen.dobBS";
    case "extension":
      return at(patient.extension, first.index)?.url === casteExtension
        ? "citizen.casteEthnicityCode"
        : undefined;
    case "telecom":
      return { phone: "citizen.mobile", email: "citizen.email" }[
        at(patient.telecom, first.index)?.system ?? ""
      ];
    case "address": {
      const address = "citizen.permanentAddress";
      if (second?.name === "extension") {
        const url = at(patient.address?.[0]?.extension, second.index)?.url;
        return url && addressFields[url]
          ? `${address}.${addressFields[url]}`
          : address;
      }
      if (second?.name === "line")
        return second.index === 1 ? `${address}.tole` : `${address}.wardNo`;
      if (second?.name === "postalCode") return `${address}.postalCode`;
      return address;
    }
  }
  return undefined;
}

const validationIssue = z
  .object({
    severity: z.string(),
    code: z.string(),
    expression: z.string().optional(),
    message: z.string().optional(),
  })
  .passthrough();

// Blocking validation issues, one per field. A mapped issue gets a short message naming the
// field and keeps the validator's text as `detail`; an unmapped one keeps the validator's text.
function validationIssues(input: unknown, issues: unknown) {
  if (!Array.isArray(issues)) return [];
  let patient: Built = {};
  try {
    patient = toFhir(input, {}) as Built;
  } catch {
    // Unreachable after a successful mapping; unmapped issues still get the validator's text.
  }
  const seen = new Set<string>();
  return issues.flatMap((issue) => {
    const parsed = validationIssue.safeParse(issue);
    if (!parsed.success || !["fatal", "error"].includes(parsed.data.severity))
      return [];
    const { message: detail, ...rest } = parsed.data;
    const field = rest.expression && fieldFor(patient, rest.expression);
    if (!field)
      return [
        { ...rest, message: detail ?? errorMessages.fhir_validation_failed },
      ];
    // The validator can report one bad value at several depths.
    if (seen.has(field)) return [];
    seen.add(field);
    const rule =
      rest.code === "code-invalid"
        ? "is not a valid NP Core code"
        : rest.code === "required"
          ? "is required by NP Core"
          : "failed NP Core validation";
    return [
      {
        ...rest,
        field,
        path: field.split("."),
        message: `${field} ${rule}`,
        ...(detail && { detail }),
      },
    ];
  });
}

// Flat error in the NHID service's style: {requestId, source, status: false, message}. `code` is
// the stable value to branch on; `field`/`path` name the first bad input field.
export function toError(
  input: unknown,
  error: string,
  issues?: unknown,
  stage?: string,
  upstreamMessage?: string,
): Record<string, unknown> {
  const request = z
    .object({
      requestId: z.string().trim().min(1).max(100),
      source: z.literal("nagarik-app"),
    })
    .passthrough()
    .safeParse(input);
  const fields =
    error === "request_mapping_failed" && Array.isArray(issues)
      ? issues.flatMap((issue) => {
          const parsed = mappingIssue.safeParse(issue);
          return parsed.success ? [describe(parsed.data)] : [];
        })
      : [];
  const validation =
    error === "fhir_validation_failed" ? validationIssues(input, issues) : [];
  const located =
    fields[0] ??
    validation.flatMap((issue) => ("field" in issue ? [issue] : []))[0];
  const message =
    upstreamMessage ??
    (validation.length
      ? validation.map((issue) => issue.message).join("; ")
      : undefined) ??
    (fields.length
      ? fields.map((field) => field.message).join("; ")
      : stage === "request-validation" && error === "upstream_timeout"
        ? "The validation service did not respond in time."
        : stage === "request-validation" && error === "upstream_unavailable"
          ? "The validation service is unavailable."
          : (errorMessages[error] ??
            "The registration could not be completed."));
  return {
    ...(request.success && { requestId: request.data.requestId }),
    source: "nagarik-app",
    status: false,
    message,
    code: error,
    ...(located && { field: located.field, path: located.path }),
    // One issue is already in message/field/path; list them only when there are several.
    ...(validation.length > 1 && { issues: validation }),
    ...(fields.length > 1 && { issues: fields }),
  };
}
