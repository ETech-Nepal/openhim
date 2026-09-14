import { fileURLToPath } from 'node:url';

Object.assign(process.env, {
  DOTENV_CONFIG_PATH: '/dev/null', NODE_ENV: 'test',
  MEDIATOR_URN: 'urn:test:admin', OPENHIM_API_URL: 'http://openhim.invalid',
  OPENHIM_USERNAME: 'test', OPENHIM_PASSWORD: 'test',
  HAPI_FHIR_BASE_URL: 'http://hapi.invalid', JEMPI_BASE_URL: 'http://jempi.invalid',
  REVIEW_DB_HOST: '127.0.0.1', REVIEW_DB_PORT: process.env.TEST_REVIEW_DB_PORT || '55439',
  REVIEW_DB_USER: 'baseline', REVIEW_DB_PASSWORD: 'synthetic-baseline', REVIEW_DB_NAME: 'mediator_baseline',
  SCORING_CONFIG_PATH: fileURLToPath(new URL('./scoring.json', import.meta.url)),
  PLACEHOLDER_PHONES: '9800000000', EXACT_MATCH_FIELDS: 'dob,national_id,phone_number',
  DISCRIMINATING_FIELDS: 'dob,national_id,phone_number', MERGE_REFERENCING_TYPES: 'Encounter,Observation,DocumentReference',
  REVIEW_LOW_THRESHOLD: '0.65', REVIEW_HIGH_THRESHOLD: '0.75', SCAN_ON_BOOT: 'false',
});
