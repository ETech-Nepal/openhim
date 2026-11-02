import express, { type ErrorRequestHandler, type Response } from "express";
import { randomUUID } from "node:crypto";
import type { AppDefinition, Config } from "./config.js";
import { execute, failure, type Context, type Result } from "./execute.js";
import { executeFhir } from "./fhirDelivery.js";
import type { Transport } from "./http.js";
import { createTokenVerifier, type Verify } from "./auth.js";

export function createApp(
  config: Config,
  apps: AppDefinition[],
  transport?: Transport,
  verify: Verify | undefined = config.KEYCLOAK_ISSUER &&
  config.KEYCLOAK_JWKS_URI
    ? createTokenVerifier(config.KEYCLOAK_ISSUER, config.KEYCLOAK_JWKS_URI)
    : undefined,
) {
  const app = express();
  app.disable("x-powered-by");
  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  function send(res: Response, result: Result, definition?: AppDefinition) {
    const context: Context = res.locals.context;
    return res
      .status(result.status)
      .type("application/json+openhim")
      .send({
        "x-mediator-urn": config.MEDIATOR_URN,
        status:
          result.status >= 200 && result.status < 300 ? "Successful" : "Failed",
        response: {
          status: result.status,
          headers: {
            "Content-Type": result.contentType ?? "application/json",
            "X-Correlation-ID": context.correlationId,
          },
          body: JSON.stringify(result.body),
          timestamp: new Date().toISOString(),
        },
        orchestrations: result.orchestrations,
        properties: {
          correlationId: context.correlationId,
          ...(definition && {
            integration: definition.id,
            mapping: definition.resources
              .map((resource) => resource.mapping.id)
              .join(","),
          }),
        },
      });
  }

  app.use((_req, res, next) => {
    res.locals.context = {
      correlationId: randomUUID(),
    } satisfies Context;
    next();
  });

  // Check the app and content type before parsing patient data.
  app.use(
    apps.map((item) => item.route),
    (req, res, next) => {
      const context: Context = res.locals.context;
      const definition = apps.find((item) => item.route === req.baseUrl);
      if (!definition)
        return send(
          res,
          failure(404, "unknown_integration", context, "routing"),
        );
      res.locals.app = definition;
      next();
    },
    // The client's token, verified before any patient data is read.
    (req, res, next) => {
      const context: Context = res.locals.context;
      const definition: AppDefinition = res.locals.app;
      if (!definition.auth) return next();
      const fail = (status: number, error: string) =>
        send(
          res,
          failure(status, error, context, "auth", definition),
          definition,
        );
      if (!verify) return fail(500, "internal_error");
      verify(req.get("Authorization"))
        .then((caller) => {
          if (!caller) return fail(401, "unauthorized");
          context.caller = caller;
          next();
        })
        .catch(() => fail(503, "auth_unavailable"));
    },
    (req, res, next) => {
      const definition: AppDefinition = res.locals.app;
      if (!req.is(["application/json", "application/fhir+json"]))
        return send(
          res,
          failure(
            415,
            "unsupported_content_type",
            res.locals.context,
            "input",
            definition,
          ),
          definition,
        );
      next();
    },
  );
  app.use(
    express.json({
      limit: config.MAX_BODY_BYTES,
      type: ["application/json", "application/fhir+json"],
      inflate: false,
    }),
  );

  for (const configured of apps)
    app.post(configured.route, (req, res, next) => {
      const definition: AppDefinition = res.locals.app;
      (definition.delivery?.mode === "fhir" ? executeFhir : execute)(
        definition,
        req.body,
        res.locals.context,
        transport,
      )
        .then((result) => send(res, result, definition))
        .catch(next);
    });

  app.use((_req, res) =>
    send(res, failure(404, "not_found", res.locals.context, "routing")),
  );
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    const status =
      error?.type === "entity.too.large"
        ? 413
        : error?.type === "encoding.unsupported"
          ? 415
          : error?.type === "entity.parse.failed"
            ? 400
            : 500;
    const definition: AppDefinition | undefined = res.locals.app;
    send(
      res,
      failure(
        status,
        status === 500 ? "internal_error" : "invalid_request_body",
        res.locals.context,
        "input",
        definition,
      ),
      definition,
    );
  };
  app.use(errors);
  return app;
}
