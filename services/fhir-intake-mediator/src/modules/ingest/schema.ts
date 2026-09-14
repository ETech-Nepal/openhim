import { z } from 'zod';
import { optionalString } from '../../lib/sentinels.js';

const DATE_ONLY = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/;
const SQLITE_DATE_TIME =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2}) (?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})\.(?<millisecond>\d{3})$/;
const INVALID_SOURCE_SCALAR = Symbol('invalid source scalar');

function hasMatchingUtcComponents(date: Date, components: Record<string, string>) {
  return (
    date.getUTCFullYear() === Number(components.year) &&
    date.getUTCMonth() + 1 === Number(components.month) &&
    date.getUTCDate() === Number(components.day) &&
    date.getUTCHours() === Number(components.hour ?? 0) &&
    date.getUTCMinutes() === Number(components.minute ?? 0) &&
    date.getUTCSeconds() === Number(components.second ?? 0) &&
    date.getUTCMilliseconds() === Number(components.millisecond ?? 0)
  );
}

function isDateOnly(value: string) {
  const match = DATE_ONLY.exec(value);
  if (!match?.groups) return false;
  const { year, month, day } = match.groups;
  return hasMatchingUtcComponents(
    new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))),
    { year, month, day },
  );
}

function isSqliteDateTime(value: string) {
  const match = SQLITE_DATE_TIME.exec(value);
  if (!match?.groups) return false;
  const { year, month, day, hour, minute, second, millisecond } = match.groups;
  return hasMatchingUtcComponents(
    new Date(
      Date.UTC(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
        Number(millisecond),
      ),
    ),
    { year, month, day, hour, minute, second, millisecond },
  );
}

function requiredString() {
  return z.preprocess(optionalSourceString, z.string().min(1));
}

function optionalValue<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(optionalSourceString, schema.optional());
}

function optionalSourceString(value: unknown) {
  if (
    value !== null &&
    value !== undefined &&
    typeof value !== 'string' &&
    typeof value !== 'number'
  ) {
    return INVALID_SOURCE_SCALAR;
  }
  return optionalString(value);
}

const cdrsEncounterSchema = z
  .object({
    imis_id: z.preprocess(
      (value) => {
        const normalized = optionalSourceString(value);
        return normalized === '0' ? undefined : normalized;
      },
      z
        .string()
        .regex(/^(?!0{9}$)\d{9}$/)
        .optional(),
    ),
    hospital_patient_number: requiredString(),
    encounter_number: requiredString(),
    first_name: optionalValue(z.string()),
    last_name: optionalValue(z.string()),
    sex: z.preprocess(
      optionalSourceString,
      z
        .string()
        .transform((value) => value.toLowerCase())
        .pipe(z.enum(['male', 'female', 'other', 'unknown'])),
    ),
    dob: optionalValue(z.string().refine(isDateOnly, 'must be a valid YYYY-MM-DD date')),
    phone_number: optionalValue(z.string().regex(/^\d{10}$/)),
    department_type: z.preprocess(optionalSourceString, z.enum(['C', 'E', 'N'])),
    department_id: requiredString(),
    department_name: requiredString(),
    visit_date_ad_time: z.preprocess(
      optionalSourceString,
      z.string().refine(isSqliteDateTime, 'must be a valid SQLite timestamp'),
    ),
    is_consultant: optionalValue(z.enum(['0', '1']).transform(Number)),
    is_doctor: optionalValue(z.enum(['0', '1']).transform(Number)),
  })
  .passthrough()
  .refine((row) => row.first_name !== undefined || row.last_name !== undefined, {
    path: ['first_name'],
    message: 'first_name or last_name is required',
  });

export function parseCdrsEncounter(input: unknown) {
  const result = cdrsEncounterSchema.safeParse(input);
  if (result.success) return { success: true as const, data: result.data };
  return {
    success: false as const,
    issues: result.error.issues.map(({ path, message }) => ({ path, message })),
  };
}

export type CdrsEncounter = z.infer<typeof cdrsEncounterSchema>;
