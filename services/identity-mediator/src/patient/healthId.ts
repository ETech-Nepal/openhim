import { randomInt } from 'node:crypto';

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

export const LEGACY_BASE_DIGITS = 10;
export const SERIES_LETTERS = 2;
export const RANDOM_DIGITS = 6;
const NEW_BODY_RE = /^[A-Z]{2}\d{6}$/;
const NEW_HEALTH_ID_RE = /^[A-Z]{2}\d{7}$/;
const LEGACY_HEALTH_ID_RE = new RegExp(`^\\d{${LEGACY_BASE_DIGITS + 1}}$`);

export function encodeHealthIdBody(body: unknown) {
  if (typeof body !== 'string' || !NEW_BODY_RE.test(body)) {
    throw new TypeError('Health ID body must be two uppercase letters followed by six digits');
  }
  const series = body.slice(0, SERIES_LETTERS);
  const digits = body.slice(SERIES_LETTERS);
  const encodedSeries = [...series]
    .map((letter) => String(letter.charCodeAt(0) - 65).padStart(2, '0'))
    .join('');
  return encodedSeries + digits;
}

export function dammCheck(body: string) {
  let interim = 0;
  for (const ch of String(body)) {
    interim = T[interim][Number(ch)];
  }
  return interim;
}

export function dammValid(num: string) {
  let interim = 0;
  for (const ch of String(num)) {
    interim = T[interim][Number(ch)];
  }
  return interim === 0;
}

export function isValidHealthId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (NEW_HEALTH_ID_RE.test(value)) {
    const body = value.slice(0, -1);
    return dammValid(encodeHealthIdBody(body) + value.at(-1));
  }
  return LEGACY_HEALTH_ID_RE.test(value) && dammValid(value);
}

function randomSeries() {
  return Array.from({ length: SERIES_LETTERS }, () => String.fromCharCode(65 + randomInt(26))).join(
    '',
  );
}

function randomDigits() {
  let value = '';
  for (let i = 0; i < RANDOM_DIGITS; i++) value += randomInt(10);
  return value;
}

export function generateHealthId() {
  const body = randomSeries() + randomDigits();
  return body + String(dammCheck(encodeHealthIdBody(body)));
}
