// Nepal Health ID generation.
//
// The Health ID is a human-facing number a patient carries for life. It is
// generated *separately* from JeMPI's golden UID and mapped 1:1 to it (see
// patient handler): the golden UID resolves *who* the person is, the Health ID
// is the readable label. It deliberately encodes **no** patient data — it is an
// opaque number + a Damm check digit so a mistyped ID can be rejected without a
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

// Number of digits in the random base, before the check digit is appended.
// Total Health ID length = BASE_DIGITS + 1.
export const BASE_DIGITS = 10;

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

/** True when `value` is an all-digit string of the expected length with a valid Damm digit. */
export function isValidHealthId(value) {
  if (typeof value !== 'string') return false;
  if (!new RegExp(`^\\d{${BASE_DIGITS + 1}}$`).test(value)) return false;
  return dammValid(value);
}

// Random base whose first digit is 1-9 (fixed length, no leading zero).
function randomBase() {
  let s = String(1 + Math.floor(Math.random() * 9)); // first digit 1-9
  for (let i = 1; i < BASE_DIGITS; i++) {
    s += String(Math.floor(Math.random() * 10));
  }
  return s;
}

/**
 * Mint a fresh Nepal Health ID: a random opaque base + Damm check digit.
 * @returns {string} an (BASE_DIGITS + 1)-digit numeric string
 */
export function generateHealthId() {
  const base = randomBase();
  return base + String(dammCheck(base));
}
