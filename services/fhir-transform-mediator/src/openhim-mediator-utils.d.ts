declare module "openhim-mediator-utils" {
  type Options = {
    apiURL: string;
    username: string;
    password: string;
    trustSelfSigned?: boolean;
    rejectUnauthorized?: boolean;
    urn: string;
  };
  export function authenticate(
    options: Options,
    callback: (error?: Error | null) => void,
  ): void;
  export function genAuthHeaders(options: Options): Record<string, string>;
  export function registerMediator(
    options: Options,
    config: object,
    callback: (error?: Error | null) => void,
  ): void;
  export function activateHeartbeat(
    options: Options,
  ): import("node:events").EventEmitter;
  export function deactivateHeartbeat(): void;
}
