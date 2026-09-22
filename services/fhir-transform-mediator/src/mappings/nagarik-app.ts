import { z } from "zod";

const core = "http://fhir.digitalhealth.gov.np/core";
const identifierTypeSystem = `${core}/CodeSystem/np-core-identifier-type`;
const locationSystem = `${core}/CodeSystem/nepal-administrative-location`;
const healthIdSystem = `${core}/NamingSystem/nepal-health-id`;

export const nagarikAppOptions = z.object({}).strict();

const errorMessages: Record<string, string> = {
  request_mapping_failed: "The submitted registration data is invalid.",
  fhir_validation_failed: "The submitted citizen data failed validation.",
  validator_failed:
    "The validation service could not validate the citizen data.",
  nhid_service_failed: "The NHID service could not complete the registration.",
  upstream_timeout: "The NHID service did not respond in time.",
  upstream_unavailable: "The NHID service is unavailable.",
  response_mapping_failed: "The NHID service returned an invalid response.",
};

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
        dobBS: z.string().date().optional(),
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
    gender: { M: "male", F: "female", O: "other", U: "unknown" }[
      citizen.gender
    ],
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

const responsePatient = z
  .object({
    resourceType: z.literal("Patient"),
    identifier: z
      .array(
        z
          .object({
            system: z.string().optional(),
            value: z.string().optional(),
            type: z
              .object({
                coding: z.array(z.object({ code: z.string().optional() })),
              })
              .optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

export function fromFhir(
  response: unknown,
  input: unknown,
  _options: Record<string, string>,
): Record<string, unknown> {
  const source = inputSchema.parse(input);
  const patient = responsePatient.parse(response);
  const healthId = patient.identifier.find(
    (identifier) =>
      identifier.system === healthIdSystem ||
      identifier.type?.coding.some((coding) => coding.code === "health-id"),
  )?.value;
  return {
    ...source,
    citizen: { ...source.citizen, healthId: healthId ?? "" },
  };
}

export function toError(
  input: unknown,
  error: string,
  issues?: unknown,
  stage?: string,
): Record<string, unknown> {
  const request = z
    .object({
      requestId: z.string().trim().min(1).max(100),
      source: z.literal("nagarik-app"),
    })
    .passthrough()
    .safeParse(input);
  return {
    ...(request.success && { requestId: request.data.requestId }),
    source: "nagarik-app",
    status: "failed",
    error: {
      code: error,
      message:
        stage === "request-validation" && error === "upstream_timeout"
          ? "The validation service did not respond in time."
          : stage === "request-validation" && error === "upstream_unavailable"
            ? "The validation service is unavailable."
            : (errorMessages[error] ??
              "The registration could not be completed."),
      ...(issues !== undefined ? { issues } : {}),
    },
  };
}
