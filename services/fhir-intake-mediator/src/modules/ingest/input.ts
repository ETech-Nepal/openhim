import { isRecord, type FhirInput } from '../../types.js';
const RESOURCE_PATH = new Map([
  ['Patient', '/fhir/Patient'],
  ['Encounter', '/fhir/Encounter'],
  ['Observation', '/fhir/Observation'],
  ['Organization', '/fhir/Organization'],
  ['Practitioner', '/fhir/Practitioner'],
  ['DocumentReference', '/fhir/DocumentReference'],
]);

export function validateFhirInput(
  input: unknown,
): { success: true; resource: FhirInput; path: string } | { success: false; diagnostics: string } {
  if (!isRecord(input)) {
    return { success: false, diagnostics: 'FHIR request body must be a JSON object' };
  }
  if (input.resourceType === 'Bundle') {
    if (!['transaction', 'batch'].includes(String(input.type))) {
      return { success: false, diagnostics: `Bundle.type=${String(input.type)} is not supported` };
    }
    return { success: true, resource: input as FhirInput, path: '/fhir' };
  }
  const path = RESOURCE_PATH.get(String(input.resourceType));
  if (!path)
    return {
      success: false,
      diagnostics: `resourceType=${String(input.resourceType)} is not supported`,
    };
  return { success: true, resource: input as FhirInput, path };
}
