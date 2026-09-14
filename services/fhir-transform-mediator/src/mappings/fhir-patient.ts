import { z } from "zod";

export const fhirPatientOptions = z.object({}).strict();

const patient = z.object({ resourceType: z.literal("Patient") }).passthrough();

export function toFhir(
  input: unknown,
  _options: Record<string, string>,
): Record<string, unknown> {
  return patient.parse(input);
}

export function fromFhir(
  input: unknown,
  _options: Record<string, string>,
): Record<string, unknown> {
  const value = patient
    .extend({
      id: z.string().regex(/^[A-Za-z0-9\-.]{1,64}$/),
      identifier: z.array(
        z.object({ system: z.string(), value: z.string().min(1) }),
      ),
    })
    .parse(input);
  const healthIds = value.identifier.filter(
    (item) =>
      item.system ===
      "http://fhir.digitalhealth.gov.np/core/NamingSystem/nepal-health-id",
  );
  if (healthIds.length !== 1)
    throw new Error("Expected exactly one Nepal Health ID");
  return {
    patientReference: `Patient/${value.id}`,
    healthId: healthIds[0].value,
  };
}
