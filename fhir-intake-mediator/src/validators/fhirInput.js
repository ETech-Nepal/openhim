const RESOURCE_PATH = new Map([
  ['Patient', '/fhir/Patient'],
  ['Encounter', '/fhir/Encounter'],
  ['Observation', '/fhir/Observation'],
  ['Organization', '/fhir/Organization'],
  ['Practitioner', '/fhir/Practitioner'],
  ['DocumentReference', '/fhir/DocumentReference'],
]);

export function validateFhirInput(input) {
  if (!input || Array.isArray(input) || typeof input !== 'object') {
    return { success: false, diagnostics: 'FHIR request body must be a JSON object' };
  }
  if (input.resourceType === 'Bundle') {
    if (!['transaction', 'batch'].includes(input.type)) {
      return { success: false, diagnostics: `Bundle.type=${String(input.type)} is not supported` };
    }
    return { success: true, resource: input, path: '/fhir' };
  }
  const path = RESOURCE_PATH.get(input.resourceType);
  if (!path) return { success: false, diagnostics: `resourceType=${String(input.resourceType)} is not supported` };
  return { success: true, resource: input, path };
}
