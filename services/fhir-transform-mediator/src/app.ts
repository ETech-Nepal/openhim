import express, { type ErrorRequestHandler, type Response } from "express";
import { randomUUID } from "node:crypto";
import type { Config, Integration } from "./config.js";
import { execute, failure, type Context, type Result } from "./execute.js";
import type { Transport } from "./http.js";

export function createApp(
  config: Config,
  integrations: Integration[],
  transport?: Transport,
) {
  const app = express();
  app.disable("x-powered-by");
  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  function send(
    res: Response,
    result: Result,
    integration?: Integration,
    contentType = "application/json",
  ) {
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
            "Content-Type": contentType,
            "X-Correlation-ID": context.correlationId,
          },
          body: JSON.stringify(result.body),
          timestamp: new Date().toISOString(),
        },
        orchestrations: result.orchestrations,
        properties: {
          correlationId: context.correlationId,
          ...(integration && {
            integration: integration.id,
            mapping: integration.mapping,
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

  // Check the integration and trusted client before parsing patient data.
  app.use(
    [...integrations.map((item) => item.channelPath)],
    (req, res, next) => {
      const context: Context = res.locals.context;
      const integration = integrations.find(
        (item) => item.channelPath === req.baseUrl,
      );
      if (!integration)
        return send(
          res,
          failure(404, "unknown_integration", context, "routing"),
        );
      res.locals.integration = integration;
      if (!req.is(["application/json", "application/fhir+json"]))
        return send(
          res,
          failure(415, "unsupported_content_type", context, "input"),
          integration,
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

  for (const configured of integrations)
    app.post(configured.channelPath, (req, res, next) => {
      const integration: Integration = res.locals.integration;
      execute(integration, req.body, res.locals.context, transport)
        .then((result) => send(res, result, integration))
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
    send(
      res,
      failure(
        status,
        status === 500 ? "internal_error" : "invalid_request_body",
        res.locals.context,
        "input",
      ),
    );
  };
  app.use(errors);
  return app;
}
