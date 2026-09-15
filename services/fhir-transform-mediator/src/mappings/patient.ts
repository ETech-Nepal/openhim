import { z } from "zod";

export const patientOptions = z
  .object({
    nationalIdSystem: z.string().url(),
  })
  .strict();

const inputSchema = z
  .object({
    name: z.string().trim().min(1).max(250),
    gender: z.enum(["male", "female", "other", "unknown"]).optional(),
    dob: z.string().date().optional(),
    nationalId: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

// Example application contract. A full name is kept intact, without guessing family names.
export function toFhir(
  input: unknown,
  options: Record<string, string>,
): Record<string, unknown> {
  const value = inputSchema.parse(input);
  const settings = patientOptions.parse(options);
  return {
    resourceType: "Patient",
    name: [{ text: value.name }],
    ...(value.gender && { gender: value.gender }),
    ...(value.dob && { birthDate: value.dob }),
    ...(value.nationalId && {
      identifier: [
        { system: settings.nationalIdSystem, value: value.nationalId },
      ],
    }),
  };
}
