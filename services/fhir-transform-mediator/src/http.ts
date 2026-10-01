import http from "node:http";
import https from "node:https";
import axios from "axios";

export type JsonRequest = {
  url: string;
  method?: "GET" | "POST";
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs: number;
};
export type JsonResponse = { status: number; body: unknown };
export type Transport = (request: JsonRequest) => Promise<JsonResponse>;

// `timeout` means the server may have received the request: it timed out after the
// connection (and TLS handshake) was up. A DNS failure, refused or slow connection
// never reached the server, so it is a plain failure.
export class TransportError extends Error {
  constructor(readonly timeout: boolean) {
    super(timeout ? "External request timed out" : "External request failed");
  }
}

// Fresh agents per request so a socket's readiness belongs to this request only.
function connectionAgents(onReady: () => void) {
  const httpAgent = new http.Agent();
  const httpsAgent = new https.Agent();
  const track = (agent: http.Agent, event: string) => {
    const create = agent.createConnection.bind(agent);
    agent.createConnection = (options, callback) => {
      const socket = create(options, callback);
      socket?.once(event, onReady);
      return socket;
    };
  };
  track(httpAgent, "connect");
  track(httpsAgent, "secureConnect");
  return { httpAgent, httpsAgent };
}

export const postJson: Transport = async (request) => {
  let connected = false;
  const agents = connectionAgents(() => {
    connected = true;
  });
  try {
    const response = await axios.request<string>({
      method: request.method ?? "POST",
      url: request.url,
      ...(request.body !== undefined && { data: request.body }),
      headers: {
        Accept: "application/fhir+json",
        "Content-Type": "application/fhir+json",
        ...request.headers,
      },
      timeout: request.timeoutMs,
      signal: AbortSignal.timeout(request.timeoutMs),
      maxRedirects: 0,
      maxBodyLength: 1048576,
      maxContentLength: 1048576,
      responseType: "text",
      transformResponse: [(value) => value],
      validateStatus: () => true,
      // Explicit endpoints must not inherit a process-wide forward proxy.
      proxy: false,
      ...agents,
    });
    let body: unknown;
    try {
      body = JSON.parse(response.data);
    } catch {
      body = null;
    }
    return { status: response.status, body };
  } catch (error) {
    throw new TransportError(
      connected &&
        axios.isAxiosError(error) &&
        ["ECONNABORTED", "ETIMEDOUT", "ERR_CANCELED"].includes(
          error.code ?? "",
        ),
    );
  }
};
