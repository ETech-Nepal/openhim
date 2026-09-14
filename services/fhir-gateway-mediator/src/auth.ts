import {
  createRemoteJWKSet,
  jwtVerify,
  compactVerify,
  importJWK,
  calculateJwkThumbprint,
  decodeProtectedHeader,
  type JWK,
  type JWTPayload,
} from "jose";
import { createHash } from "node:crypto";

export class AuthError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export type Verified = { payload: JWTPayload; roles: string[] };

export function createVerifier(opts: {
  issuer: string;
  audience: string;
  publicBaseUrl: string;
  jwksUri?: string;
}) {
  const jwks = createRemoteJWKSet(
    new URL(opts.jwksUri ?? `${opts.issuer}/protocol/openid-connect/certs`),
  );
  // ponytail: in-memory jti replay cache; move to shared store if the mediator is scaled out.
  const seenJti = new Map<string, number>();

  async function verifyAccessToken(
    authorization: string | undefined,
  ): Promise<{ token: string; payload: JWTPayload }> {
    const [scheme, token] = (authorization ?? "").split(" ");
    if (!token || !/^(bearer|dpop)$/i.test(scheme))
      throw new AuthError(401, "Missing bearer token");
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: opts.issuer,
        audience: opts.audience,
      });
      return { token, payload };
    } catch (e) {
      throw new AuthError(401, `Invalid token: ${(e as Error).message}`);
    }
  }

  // RFC 9449. Only enforced when the token is sender-constrained (cnf.jkt present).
  async function verifyDpop(
    proof: string | undefined,
    token: string,
    jkt: string,
    method: string,
    path: string,
  ) {
    if (!proof) throw new AuthError(401, "DPoP proof required");
    const header = decodeProtectedHeader(proof);
    if (
      header.typ !== "dpop+jwt" ||
      !header.jwk ||
      !header.alg ||
      header.alg === "none"
    )
      throw new AuthError(401, "Malformed DPoP proof");
    const key = await importJWK(header.jwk as JWK, header.alg);
    let claims: {
      htm?: string;
      htu?: string;
      ath?: string;
      jti?: string;
      iat?: number;
    };
    try {
      const { payload } = await compactVerify(proof, key);
      claims = JSON.parse(Buffer.from(payload).toString());
    } catch {
      throw new AuthError(401, "DPoP signature invalid");
    }
    if ((await calculateJwkThumbprint(header.jwk as JWK)) !== jkt)
      throw new AuthError(401, "DPoP key does not match token");
    const now = Math.floor(Date.now() / 1000);
    if (!claims.iat || Math.abs(now - claims.iat) > 300)
      throw new AuthError(401, "DPoP proof expired");
    if (claims.htm !== method) throw new AuthError(401, "DPoP htm mismatch");
    if (claims.htu !== `${opts.publicBaseUrl}${path.split("?")[0]}`)
      throw new AuthError(401, "DPoP htu mismatch");
    const ath = createHash("sha256").update(token).digest("base64url");
    if (claims.ath !== ath) throw new AuthError(401, "DPoP ath mismatch");
    if (!claims.jti || seenJti.has(claims.jti))
      throw new AuthError(401, "DPoP proof replayed");
    seenJti.set(claims.jti, now);
    if (seenJti.size > 10000)
      for (const [k, t] of seenJti) if (now - t > 300) seenJti.delete(k);
  }

  async function verify(
    h: { authorization?: string; dpop?: string },
    method: string,
    path: string,
  ): Promise<Verified> {
    const { token, payload } = await verifyAccessToken(h.authorization);
    const jkt = (payload.cnf as { jkt?: string } | undefined)?.jkt;
    if (jkt) await verifyDpop(h.dpop, token, jkt, method, path);
    const roles =
      (payload.realm_access as { roles?: string[] } | undefined)?.roles ?? [];
    return { payload, roles };
  }

  return { verify, verifyDpop };
}
