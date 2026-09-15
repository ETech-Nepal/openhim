import { z } from "zod";
import * as patient from "./patient.js";
import * as encounter from "./encounter.js";
import * as nagarikApp from "./nagarik-app.js";
import * as fhirPatient from "./fhir-patient.js";

export type Mapping = {
  options: z.ZodType<Record<string, string>>;
  toFhir(
    input: unknown,
    options: Record<string, string>,
  ): Record<string, unknown>;
};

// New source contracts add a versioned mapping here; the executor stays unchanged.
export const mappings: Record<string, Mapping> = {
  "patient-registration-v1": { ...patient, options: patient.patientOptions },
  "hospital-encounter-v1": {
    ...encounter,
    options: encounter.encounterOptions,
  },
  "nagarik-app-registration-v1": {
    ...nagarikApp,
    options: nagarikApp.nagarikAppOptions,
  },
  "emr-fhir-patient-v1": {
    ...fhirPatient,
    options: fhirPatient.fhirPatientOptions,
  },
};
