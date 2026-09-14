import { z } from "zod";

const core = "http://fhir.digitalhealth.gov.np/core";
const identifierTypeSystem = `${core}/CodeSystem/np-core-identifier-type`;
const locationSystem = `${core}/CodeSystem/nepal-administrative-location`;

export const nagarikAppOptions = z.object({}).strict();

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

const responseSchema = z.object({
  resourceType: z.literal("Patient"),
  id: z.string().regex(/^[A-Za-z0-9\-.]{1,64}$/),
  identifier: z.array(
    z.object({ system: z.string(), value: z.string().min(1) }),
  ),
});

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

export function fromFhir(
  input: unknown,
  _options: Record<string, string>,
): Record<string, unknown> {
  const value = responseSchema.parse(input);
  const healthIds = value.identifier.filter(
    (item) => item.system === `${core}/NamingSystem/nepal-health-id`,
  );
  if (healthIds.length !== 1)
    throw new Error("Expected exactly one Nepal Health ID");
  return {
    patientReference: `Patient/${value.id}`,
    healthId: healthIds[0].value,
  };
}
