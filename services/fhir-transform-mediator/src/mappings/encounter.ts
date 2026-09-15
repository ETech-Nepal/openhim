import { z } from "zod";

export const encounterOptions = z
  .object({ encounterIdentifierSystem: z.string().url() })
  .strict();
const statuses = z.enum([
  "planned",
  "arrived",
  "triaged",
  "in-progress",
  "onleave",
  "finished",
  "cancelled",
  "entered-in-error",
  "unknown",
]);
const inputSchema = z
  .object({
    encounterId: z.string().trim().min(1).max(100),
    patientReference: z.string().regex(/^Patient\/[A-Za-z0-9\-.]{1,64}$/),
    status: statuses,
    classCode: z.enum([
      "AMB",
      "EMER",
      "IMP",
      "ACUTE",
      "NONAC",
      "OBSENC",
      "PRENC",
      "SS",
      "VR",
      "HH",
    ]),
    start: z.string().datetime({ offset: true }),
  })
  .strict();

export function toFhir(
  input: unknown,
  options: Record<string, string>,
): Record<string, unknown> {
  const value = inputSchema.parse(input);
  const settings = encounterOptions.parse(options);
  return {
    resourceType: "Encounter",
    identifier: [
      { system: settings.encounterIdentifierSystem, value: value.encounterId },
    ],
    status: value.status,
    class: {
      system: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
      code: value.classCode,
    },
    subject: { reference: value.patientReference },
    period: { start: value.start },
  };
}
