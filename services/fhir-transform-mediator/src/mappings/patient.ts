import { z } from "zod";

export const patientOptions = z
  .object({
    nationalIdSystem: z.string().url(),
    healthIdSystem: z.string().url(),
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

const responseSchema = z.object({
  resourceType: z.literal("Patient"),
  id: z.string().regex(/^[A-Za-z0-9\-.]{1,64}$/),
  identifier: z.array(
    z.object({ system: z.string(), value: z.string().min(1) }),
  ),
});

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

export function fromFhir(
  input: unknown,
  options: Record<string, string>,
): Record<string, unknown> {
  const value = responseSchema.parse(input);
  const settings = patientOptions.parse(options);
  const identifiers = value.identifier.filter(
    (item) => item.system === settings.healthIdSystem,
  );
  if (identifiers.length !== 1)
    throw new Error("Expected exactly one health identifier");
  return {
    patientReference: `Patient/${value.id}`,
    healthId: identifiers[0].value,
  };
}
