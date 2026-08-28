// Nepal Health ID generation.
//
// The Health ID is a human-facing identifier a patient carries for life. It is
// generated *separately* from JeMPI's golden UID and mapped 1:1 to it (see
// patient handler): the golden UID resolves *who* the person is, the Health ID
// is the readable label. It deliberately encodes **no** patient data — it is an
// opaque identifier + a Damm check digit so a mistyped ID can be rejected without a
// database lookup.
//
// Damm (2004) catches every single-digit error and every adjacent
// transposition with a single 10x10 anti-symmetric quasigroup table — the
// exact errors clerks make when reading an ID aloud or keying it by hand, which
// Luhn misses (09<->90, twin errors). One table, no permutations, no inverse.

// Totally anti-symmetric quasigroup operation table (diagonal all zero).
const T = [
  [0, 3, 1, 7, 5, 9, 8, 6, 4, 2],
  [7, 0, 9, 2, 1, 5, 4, 8, 6, 3],
  [4, 2, 0, 6, 8, 7, 1, 3, 5, 9],
  [1, 7, 5, 0, 9, 8, 3, 4, 2, 6],
  [6, 1, 2, 3, 0, 4, 5, 9, 7, 8],
  [3, 6, 7, 4, 2, 0, 9, 5, 8, 1],
  [5, 8, 6, 9, 7, 2, 0, 1, 3, 4],
  [8, 9, 4, 5, 3, 6, 2, 0, 1, 7],
  [9, 4, 3, 8, 6, 1, 7, 2, 0, 5],
  [2, 5, 8, 1, 4, 3, 6, 7, 9, 0],
];

// Newly issued visible format: LLDDDDDDC (two series letters, six random
// digits, and a Damm check digit). Letters are mapped to decimal values only
// for the Damm calculation; the visible identifier retains its letters.
export const LEGACY_BASE_DIGITS = 10;
export const SERIES_LETTERS = 2;
export const RANDOM_DIGITS = 6;
const NEW_BODY_RE = /^[A-Z]{2}\d{6}$/;
const NEW_HEALTH_ID_RE = /^[A-Z]{2}\d{7}$/;
const LEGACY_HEALTH_ID_RE = new RegExp(`^\\d{${LEGACY_BASE_DIGITS + 1}}$`);

export function encodeHealthIdBody(body) {
  if (typeof body !== 'string' || !NEW_BODY_RE.test(body)) {
    throw new TypeError('Health ID body must be two uppercase letters followed by six digits');
  }
  const series = body.slice(0, SERIES_LETTERS);
  const digits = body.slice(SERIES_LETTERS);
  const encodedSeries = [...series]
    .map(letter => String(letter.charCodeAt(0) - 65).padStart(2, '0'))
    .join('');
  return encodedSeries + digits;
}

/**
 * Damm check digit for a numeric string body.
 * @param {string} body digits only
 * @returns {number} the check digit 0-9
 */
export function dammCheck(body) {
  let interim = 0;
  for (const ch of String(body)) {
    interim = T[interim][Number(ch)];
  }
  return interim;
}

/**
 * Validate a full number (body + trailing check digit).
 * @param {string} num digits only
 * @returns {boolean} true when the check digit is consistent
 */
export function dammValid(num) {
  let interim = 0;
  for (const ch of String(num)) {
    interim = T[interim][Number(ch)];
  }
  return interim === 0;
}

/** True when `value` is a valid newly issued or legacy Health ID. */
export function isValidHealthId(value) {
  if (typeof value !== 'string') return false;
  if (NEW_HEALTH_ID_RE.test(value)) {
    const body = value.slice(0, -1);
    return dammValid(encodeHealthIdBody(body) + value.at(-1));
  }
  return LEGACY_HEALTH_ID_RE.test(value) && dammValid(value);
}

function randomSeries() {
  return Array.from({ length: SERIES_LETTERS }, () =>
    String.fromCharCode(65 + Math.floor(Math.random() * 26)),
  ).join('');
}

function randomDigits() {
  let value = '';
  for (let i = 0; i < RANDOM_DIGITS; i++) value += Math.floor(Math.random() * 10);
  return value;
}

/**
 * Mint a fresh Nepal Health ID: a random visible body + Damm check digit.
 * @returns {string} an LLDDDDDDC identifier
 */
export function generateHealthId() {
  const body = randomSeries() + randomDigits();
  return body + String(dammCheck(encodeHealthIdBody(body)));
}
