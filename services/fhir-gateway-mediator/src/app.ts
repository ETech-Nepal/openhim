import express from "express";
import type { Logger } from "pino";
import { pinoHttp } from "pino-http";
import type { Config } from "./config.js";
import { AuthError, createVerifier } from "./auth.js";

const HOP = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "authorization",
  "dpop",
  "x-role",
]);

export function createApp(config: Config, logger: Logger) {
  const verifier = createVerifier({
    issuer: config.KEYCLOAK_ISSUER,
    audience: config.KEYCLOAK_AUDIENCE,
    publicBaseUrl: config.PUBLIC_BASE_URL,
    jwksUri: config.KEYCLOAK_JWKS_URI,
  });
  const app = express();
  app.use(pinoHttp({ logger }));
  app.use(express.raw({ type: () => true, limit: "50mb" }));

  // Which client may hit which URL/method is decided by the OpenHIM channels
  // (src/channels.ts). Here: prove the token is genuine and, if DPoP-bound, that the
  // caller holds the key. Then proxy.
  app.all("/fhir*", async (req, res) => {
    const fhirPath = req.originalUrl.slice("/fhir".length) || "/";
    let xRole: string | undefined;
    if (fhirPath.split("?")[0] !== "/metadata") {
      try {
        const { roles } = await verifier.verify(
          {
            authorization: req.header("authorization"),
            dpop: req.header("dpop"),
          },
          req.method,
          req.originalUrl,
        );
        if (config.UPSTREAM_ROLE_HEADER) {
          xRole = roles.map((r) => config.ROLE_MAPPINGS[r]).find(Boolean);
          if (!xRole)
            throw new AuthError(
              403,
              "Token has no realm role mapped by ROLE_MAPPINGS",
            );
        }
      } catch (e) {
        const status = e instanceof AuthError ? e.status : 401;
        const diagnostics =
          e instanceof AuthError ? e.message : "Authentication failed";
        req.log.warn({ status, diagnostics }, "rejected");
        return res
          .status(status)
          .type("application/fhir+json")
          .json({
            resourceType: "OperationOutcome",
            issue: [
              {
                severity: "error",
                code: status === 403 ? "forbidden" : "login",
                diagnostics,
              },
            ],
          });
      }
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers))
      if (!HOP.has(k) && typeof v === "string") headers[k] = v;
    if (xRole) headers["x-role"] = xRole;
    const upstream = await fetch(config.HAPI_BASE_URL + fhirPath, {
      method: req.method,
      headers,
      body: req.body?.length ? req.body : undefined,
      redirect: "manual",
    });
    res.status(upstream.status);
    upstream.headers.forEach((v, k) => {
      if (!HOP.has(k) && k !== "content-encoding") res.setHeader(k, v);
    });
    res.send(Buffer.from(await upstream.arrayBuffer()));
  });

  return app;
}
