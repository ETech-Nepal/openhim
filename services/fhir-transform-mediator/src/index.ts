import "dotenv/config";
import { createApp } from "./app.js";
import { loadCatalog, parseConfig } from "./config.js";
import { registerOpenHim } from "./openhim.js";

async function start() {
  const config = parseConfig(process.env);
  // An invalid catalog throws here, before any OpenHIM registration or listening.
  const { apps } = loadCatalog(config, process.env);
  // Fail startup if configured registration fails; avoid advertising an unregistered service.
  const stopHeartbeat = config.OPENHIM_REGISTER
    ? await registerOpenHim(config, apps)
    : () => {};
  const server = createApp(config, apps).listen(
    config.MEDIATOR_PORT,
    "0.0.0.0",
    () => {
      console.info(
        `FHIR Transform mediator listening on port ${config.MEDIATOR_PORT}`,
      );
    },
  );
  server.on("error", () => {
    stopHeartbeat();
    console.error("Mediator listener failed");
    process.exitCode = 1;
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      stopHeartbeat();
      server.close(() => {
        process.exitCode = 0;
      });
      setTimeout(() => server.closeAllConnections(), 10000).unref();
    });
}

start().catch(() => {
  // Configuration and HTTP error objects can contain credentials or patient payloads.
  console.error(
    "Mediator startup failed. Check integration configuration and OpenHIM connectivity.",
  );
  process.exitCode = 1;
});
