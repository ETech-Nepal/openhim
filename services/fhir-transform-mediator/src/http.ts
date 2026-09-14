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

export class TransportError extends Error {
  constructor(readonly timeout: boolean) {
    super(timeout ? "External request timed out" : "External request failed");
  }
}

export const postJson: Transport = async (request) => {
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
      axios.isAxiosError(error) &&
        ["ECONNABORTED", "ETIMEDOUT", "ERR_CANCELED"].includes(
          error.code ?? "",
        ),
    );
  }
};
