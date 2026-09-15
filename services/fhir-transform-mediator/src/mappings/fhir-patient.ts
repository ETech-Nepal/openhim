import { z } from "zod";

export const fhirPatientOptions = z.object({}).strict();

const patient = z.object({ resourceType: z.literal("Patient") }).passthrough();

export function toFhir(
  input: unknown,
  _options: Record<string, string>,
): Record<string, unknown> {
  return patient.parse(input);
}
