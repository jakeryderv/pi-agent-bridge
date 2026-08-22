import type { ExternalAgentProvider } from "./types.js";

export class ExternalAgentError extends Error {
  readonly provider: ExternalAgentProvider;
  override readonly cause?: unknown;

  constructor(provider: ExternalAgentProvider, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "ExternalAgentError";
    this.provider = provider;
    if (options && "cause" in options) this.cause = options.cause;
  }
}

export class ExternalAgentProtocolError extends ExternalAgentError {
  constructor(provider: ExternalAgentProvider, message: string, options?: { cause?: unknown }) {
    super(provider, message, options);
    this.name = "ExternalAgentProtocolError";
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
