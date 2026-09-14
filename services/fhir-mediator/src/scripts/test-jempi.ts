import { registerInteraction } from '../clients/jempi.js';
import { SYS } from '../fhir/identifiers.js';

const sample = {
  resourceType: 'Patient',
  identifier: [{ system: SYS.NEPAL_HEALTH_ID, value: '747128126' }],
  name: [{ use: 'official', family: 'SHRESTHA', given: ['KAMANA'] }],
  gender: 'female',
  birthDate: '2001-06-25',
};

const result = await registerInteraction(sample);
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
