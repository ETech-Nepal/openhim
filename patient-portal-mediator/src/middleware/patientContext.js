import { verifyPatientToken } from '../lib/patientToken.js';
import { buildOpenHIMResponse } from '../lib/orchestration.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

// Gate for /patient-portal/summary. OpenHIM has already confirmed the *system*
// caller (the portal client). Here we verify the forwarded *patient* token and
// pin the request to exactly one golden UID — so even a correctly-authenticated
// portal can only ever read the data of the patient who actually logged in.
export async function patientContext(req, res, next) {
  const token = req.headers['x-patient-token'];
  if (!token) return deny(res, 'missing X-Patient-Token');
  try {
    const { goldenUid } = await verifyPatientToken(token);
    req.patientContext = { goldenUid };
    next();
  } catch (err) {
    logger.warn({ err: err.message }, 'patient token rejected');
    return deny(res, 'invalid patient token');
  }
}

// Denials travel back through OpenHIM, so they must be envelopes like every
// other reply on this route.
function deny(res, diagnostics) {
  return res.status(401).json(buildOpenHIMResponse({
    status: 401,
    body: { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'security', diagnostics }] },
    urn: config.MEDIATOR_URN,
  }));
}
