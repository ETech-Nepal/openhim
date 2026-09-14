import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';

Object.assign(process.env, {
  DOTENV_CONFIG_PATH: '/dev/null',
  NODE_ENV: 'test',
  MEDIATOR_URN: 'urn:test:fhir',
  OPENHIM_API_URL: 'http://openhim.invalid',
  OPENHIM_USERNAME: 'test',
  OPENHIM_PASSWORD: 'test',
  HAPI_FHIR_BASE_URL: 'http://hapi.invalid',
  JEMPI_BASE_URL: 'http://jempi.invalid',
  JEMPI_REGISTER_ROUTE: '/crRegister',
  JEMPI_FIND_ROUTE: '/find',
  JEMPI_GOLDEN_GET_ROUTE: '/expandedGoldenRecord',
  FACILITY_REGISTRY_JSON: '{}',
});

let respond;
const calls = [];
axios.defaults.adapter = async (config) => {
  const call = {
    host: config.baseURL,
    method: config.method,
    url: new URL(config.url, config.baseURL),
    body: config.data ? JSON.parse(config.data) : null,
  };
  calls.push(call);
  const { status = 200, data } = respond(call);
  const response = { status, data, headers: {}, statusText: '', config };
  if (status >= 400)
    throw new axios.AxiosError(
      'synthetic upstream failure',
      'ERR_BAD_RESPONSE',
      config,
      null,
      response,
    );
  return response;
};

const { resolvePatientIdentity } = await import('../src/modules/patient/identity.js');
const { patientHandler } = await import('../src/modules/patient/handler.js');
const { bundleHandler } = await import('../src/modules/bundle/handler.js');
const { SYS } = await import('../src/fhir/identifiers.js');

const healthId = 'AA4812423';
const identifier = (system, value) => ({ system, value });
const patient = () => ({
  resourceType: 'Patient',
  id: 'untrusted-id',
  identifier: [identifier(SYS.NEPAL_HEALTH_ID, healthId), identifier(SYS.HOSPITAL_MRN, 'new-mrn')],
  managingOrganization: { reference: 'Organization/forged-facility' },
});
const existing = {
  resourceType: 'Patient',
  id: 'opaque-patient',
  identifier: [identifier(SYS.HOSPITAL_MRN, 'old-mrn'), identifier(SYS.NATIONAL_ID, 'old-nid')],
};

function upstream(call) {
  if (call.host === 'http://jempi.invalid' && call.url.pathname === '/crRegister') {
    return { data: { goldenUID: '0x1', interactionUID: '0xa' } };
  }
  if (call.host === 'http://jempi.invalid' && call.url.pathname === '/crCandidates') {
    return {
      data: { goldenRecords: [{ uid: '0x1', uniqueGoldenRecordData: { auxId: healthId } }] },
    };
  }
  if (
    call.host === 'http://hapi.invalid' &&
    call.method === 'get' &&
    call.url.pathname === '/Patient'
  ) {
    return {
      data: {
        resourceType: 'Bundle',
        type: 'searchset',
        entry: [{ resource: structuredClone(existing) }],
      },
    };
  }
  if (
    call.host === 'http://hapi.invalid' &&
    call.method === 'put' &&
    call.url.pathname === '/Patient'
  ) {
    return { status: 201, data: { ...call.body, id: 'opaque-patient' } };
  }
  if (call.host === 'http://hapi.invalid' && call.method === 'post' && call.url.pathname === '/') {
    return { data: { resourceType: 'Bundle', type: 'transaction-response', entry: [] } };
  }
  assert.fail(`Unexpected upstream request: ${call.method} ${call.url}`);
}

function response() {
  return {
    status(value) {
      this.statusCode = value;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
  };
}

test.beforeEach(() => {
  calls.length = 0;
  respond = upstream;
});

test('identity keeps facility MRNs while replacing stale authoritative identifiers', async () => {
  const input = patient();
  input.identifier.push(
    identifier(SYS.NATIONAL_ID, 'new-nid'),
    identifier(SYS.JEMPI_GOLDEN_UID, 'forged-gid'),
  );
  const result = await resolvePatientIdentity(input, [], 'facility-a');
  assert.equal(result.ok, true);
  assert.equal(input.id, undefined);
  assert.deepEqual(input.identifier, [
    identifier(SYS.HOSPITAL_MRN, 'new-mrn'),
    identifier(SYS.NATIONAL_ID, 'new-nid'),
    identifier(SYS.JEMPI_GOLDEN_UID, '0x1'),
    identifier(SYS.NEPAL_HEALTH_ID, healthId),
    identifier(SYS.HOSPITAL_MRN, 'old-mrn'),
  ]);
  assert.equal(calls[0].body.sourceId.facility, 'facility-a');
  assert.ok(
    input.meta.tag.some((tag) => tag.system === SYS.SOURCE_FACILITY && tag.code === 'facility-a'),
  );
});

test('Patient handler conditionally writes the resolved identity and returns an envelope', async () => {
  const res = response();
  await patientHandler({ body: patient(), headers: { 'x-openhim-clientid': 'facility-a' } }, res);
  const write = calls.find((call) => call.method === 'put');
  assert.equal(write.url.searchParams.get('identifier'), `${SYS.NEPAL_HEALTH_ID}|${healthId}`);
  assert.equal(write.body.id, undefined);
  assert.ok(write.body.identifier.some((id) => id.value === 'old-mrn'));
  assert.equal(res.statusCode, 201);
  assert.equal(res.body['x-mediator-urn'], 'urn:test:fhir');
  assert.equal(res.body.response.status, 201);
  assert.equal(JSON.parse(res.body.response.body).id, 'opaque-patient');
});

test('Bundle handler preserves fullUrl references and applies the same identity resolution', async () => {
  const input = {
    resourceType: 'Bundle',
    type: 'transaction',
    entry: [
      {
        fullUrl: 'urn:uuid:patient',
        resource: patient(),
        request: { method: 'POST', url: 'Patient' },
      },
      {
        resource: { resourceType: 'Encounter', subject: { reference: 'urn:uuid:patient' } },
        request: { method: 'POST', url: 'Encounter' },
      },
    ],
  };
  const res = response();
  await bundleHandler({ body: input, headers: { 'x-openhim-clientid': 'facility-a' } }, res);
  const write = calls.find((call) => call.host === 'http://hapi.invalid' && call.method === 'post');
  assert.deepEqual(write.body.entry[0].request, {
    method: 'PUT',
    url: `Patient?identifier=${SYS.NEPAL_HEALTH_ID}|${healthId}`,
  });
  assert.equal(write.body.entry[0].resource.id, undefined);
  assert.ok(write.body.entry[0].resource.identifier.some((id) => id.value === 'old-mrn'));
  assert.equal(write.body.entry[1].resource.subject.reference, 'urn:uuid:patient');
  assert.ok(write.body.entry[1].resource.meta.tag.some((tag) => tag.code === 'facility-a'));
  assert.equal(res.body.response.status, 200);
  assert.equal(JSON.parse(res.body.response.body).type, 'transaction-response');
});

for (const kind of ['Patient', 'Bundle']) {
  test(`${kind} retry after JeMPI success and HAPI failure reuses the stored Health ID`, async () => {
    let writes = 0;
    respond = (call) => {
      if (
        call.host === 'http://hapi.invalid' &&
        ['put', 'post'].includes(call.method) &&
        ++writes === 1
      ) {
        return { status: 503, data: { resourceType: 'OperationOutcome', issue: [] } };
      }
      if (call.url.pathname === '/crRegister' && writes > 0)
        return { status: 409, data: { exists: ['synthetic-interaction'] } };
      return upstream(call);
    };
    const invoke = async () => {
      const res = response();
      const input = patient();
      const body =
        kind === 'Patient'
          ? input
          : { resourceType: 'Bundle', type: 'transaction', entry: [{ resource: input }] };
      await (kind === 'Patient' ? patientHandler : bundleHandler)(
        { body, headers: { 'x-openhim-clientid': 'facility-a' } },
        res,
      );
      return res;
    };
    assert.equal((await invoke()).statusCode, kind === 'Patient' ? 502 : 503);
    assert.equal((await invoke()).statusCode, kind === 'Patient' ? 201 : 200);
    const attempts = calls.filter(
      (call) => call.host === 'http://hapi.invalid' && ['put', 'post'].includes(call.method),
    );
    assert.equal(attempts.length, 2);
    for (const attempt of attempts) {
      const writtenPatient = kind === 'Patient' ? attempt.body : attempt.body.entry[0].resource;
      assert.deepEqual(
        writtenPatient.identifier.filter((id) => id.system === SYS.NEPAL_HEALTH_ID),
        [identifier(SYS.NEPAL_HEALTH_ID, healthId)],
      );
    }
    assert.equal(calls.filter((call) => call.url.pathname === '/crRegister').length, 2);
  });
}

test('JeMPI rejection prevents a Patient write', async () => {
  respond = (call) =>
    call.url.pathname === '/crRegister' ? { status: 503, data: {} } : upstream(call);
  const res = response();
  await patientHandler({ body: patient(), headers: {} }, res);
  assert.equal(res.statusCode, 502);
  assert.equal(
    calls.some((call) => call.host === 'http://hapi.invalid' && call.method === 'put'),
    false,
  );
});
