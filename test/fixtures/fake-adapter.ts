import type {
  ExternalAgent,
  ExternalAgentPrompt,
  ExternalAgentResult,
  ExternalAgentRunContext,
  ExternalAgentSession,
  ExternalAgentSessionOptions,
  ExternalAgentProvider,
} from "../../src/core/types.js";

export class FakeExternalAgent implements ExternalAgent {
  readonly provider: ExternalAgentProvider;

  constructor(provider: ExternalAgentProvider) {
    this.provider = provider;
  }

  async start(options: ExternalAgentSessionOptions): Promise<ExternalAgentSession> {
    return {
      id: `${this.provider}-bridge-session`,
      provider: this.provider,
      ...options,
    };
  }

  async resume(
    runtimeSessionId: string,
    options: ExternalAgentSessionOptions,
  ): Promise<ExternalAgentSession> {
    return {
      id: `${this.provider}-bridge-session`,
      runtimeSessionId,
      provider: this.provider,
      ...options,
    };
  }

  async prompt(
    session: ExternalAgentSession,
    prompt: ExternalAgentPrompt,
    context: ExternalAgentRunContext = {},
  ): Promise<ExternalAgentResult> {
    const output = `${this.provider} fixture completed: ${prompt.text}`;
    context.onEvent?.({ type: "status", message: `${this.provider} fixture started` });
    context.onEvent?.({ type: "text_delta", delta: output });
    return {
      session: {
        ...session,
        runtimeSessionId: session.runtimeSessionId ?? `${this.provider}-fixture-session`,
      },
      status: "completed",
      output,
    };
  }

  async cancel(): Promise<void> {}

  async close(): Promise<void> {}
}
