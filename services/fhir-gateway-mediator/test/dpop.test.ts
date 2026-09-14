import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateKeyPair,
  exportJWK,
  SignJWT,
  calculateJwkThumbprint,
} from "jose";
import { createHash } from "node:crypto";
import { createVerifier } from "../src/auth.js";

const v = createVerifier({
  issuer: "https://kc.example/realms/hie",
  audience: "account",
  publicBaseUrl: "https://hie.example",
});
const token = "access.token.x";
const ath = createHash("sha256").update(token).digest("base64url");

async function proof(over: Record<string, unknown> = {}) {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = await exportJWK(publicKey);
  const jkt = await calculateJwkThumbprint(jwk);
  const p = await new SignJWT({
    htm: "GET",
    htu: "https://hie.example/fhir/Patient",
    ath,
    jti: crypto.randomUUID(),
    ...over,
  })
    .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk })
    .setIssuedAt()
    .sign(privateKey);
  return { p, jkt };
}

test("valid DPoP proof passes, replay rejected", async () => {
  const { p, jkt } = await proof();
  await v.verifyDpop(p, token, jkt, "GET", "/fhir/Patient?name=x");
  await assert.rejects(
    v.verifyDpop(p, token, jkt, "GET", "/fhir/Patient"),
    /replayed/,
  );
});

test("htu / htm / key mismatch rejected", async () => {
  const { p, jkt } = await proof();
  await assert.rejects(
    v.verifyDpop(p, token, jkt, "POST", "/fhir/Patient"),
    /htm/,
  );
  await assert.rejects(
    v.verifyDpop(p, token, jkt, "GET", "/fhir/Encounter"),
    /htu/,
  );
  await assert.rejects(
    v.verifyDpop(p, token, "wrong-jkt", "GET", "/fhir/Patient"),
    /key does not match/,
  );
});
