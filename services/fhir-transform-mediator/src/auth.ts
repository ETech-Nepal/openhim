import {
  createPublicKey,
  verify,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";
import axios from "axios";

// Verifies the client's Keycloak access token that OpenHIM forwards (route option
// forwardAuthHeader) for apps with `auth: true`. OpenHIM already checked the token and
// its DPoP proof; this re-checks signature, issuer and expiry so the caller's facility
// comes from a signed token. The same token is then forwarded to the identity mediator
// and HAPI, which check it again.

export type Caller = { clientId: string; authorization: string };
export type Verify = (header: string | undefined) => Promise<Caller | null>;

const b64 = (s: string) => Buffer.from(s, "base64url");

export function createTokenVerifier(issuer: string, jwksUri: string): Verify {
  let keys = new Map<string, KeyObject>();
  let fetchedAt = 0;

  async function key(kid: string) {
    // Refetch on an unknown kid (key rotation), at most every 30 s.
    if (!keys.has(kid) && Date.now() - fetchedAt > 30_000) {
      const { data } = await axios.get<{
        keys: (JsonWebKey & { kid: string; use?: string })[];
      }>(jwksUri, { timeout: 5000, proxy: false });
      keys = new Map(
        data.keys
          .filter((k) => k.kty === "RSA" && k.use !== "enc")
          .map((k) => [k.kid, createPublicKey({ key: k, format: "jwk" })]),
      );
      fetchedAt = Date.now();
    }
    return keys.get(kid);
  }

  // null: no valid token. Throws when the realm's keys cannot be fetched.
  return async (header) => {
    const match = /^(?:DPoP|Bearer) ([\w-]+\.[\w-]+\.[\w-]+)$/.exec(
      header ?? "",
    );
    if (!match) return null;
    const [h, p, s] = match[1].split(".");
    let head: { alg?: string; kid?: unknown };
    let claims: Record<string, unknown>;
    try {
      head = JSON.parse(b64(h).toString());
      claims = JSON.parse(b64(p).toString());
    } catch {
      return null;
    }
    if (head.alg !== "RS256" || typeof head.kid !== "string") return null;
    const publicKey = await key(head.kid);
    if (
      !publicKey ||
      !verify("RSA-SHA256", Buffer.from(`${h}.${p}`), publicKey, b64(s))
    )
      return null;
    const now = Date.now() / 1000;
    const exp = Number(claims.exp);
    if (claims.iss !== issuer || !exp || exp < now - 30) return null;
    if (claims.nbf && Number(claims.nbf) > now + 30) return null;
    const clientId = claims.azp ?? claims.client_id ?? claims.sub;
    return typeof clientId === "string"
      ? { clientId, authorization: header! }
      : null;
  };
}
