export const EXTERNAL_AGENT_PROVIDERS = ["codex", "claude"] as const;

export type ExternalAgentProvider = (typeof EXTERNAL_AGENT_PROVIDERS)[number];

export const PERMISSION_MODES = ["read-only", "workspace-write", "full-access"] as const;

export type ExternalAgentPermissionMode = (typeof PERMISSION_MODES)[number];

export interface ExternalAgentSessionOptions {
  cwd: string;
  model?: string;
  permissions: ExternalAgentPermissionMode;
}

export interface ExternalAgentSession extends ExternalAgentSessionOptions {
  /** Bridge-local identity used while a runtime session is being created. */
  id: string;
  provider: ExternalAgentProvider;
  /** Native thread/session identity used to resume work across processes. */
  runtimeSessionId?: string;
}

export interface ExternalAgentPrompt {
  text: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
}

export type ExternalAgentEvent =
  | { type: "status"; message: string }
  | { type: "text_delta"; delta: string }
  | { type: "tool"; name: string; status: "started" | "progress" | "completed"; detail?: string }
  | { type: "approval"; title: string; approved: boolean };

export interface ExternalAgentApprovalRequest {
  provider: ExternalAgentProvider;
  title: string;
  description?: string;
  toolName?: string;
  input?: Record<string, unknown>;
}

export interface ExternalAgentRunContext {
  signal?: AbortSignal;
  onEvent?: (event: ExternalAgentEvent) => void;
  approve?: (request: ExternalAgentApprovalRequest) => Promise<boolean>;
}

export interface ExternalAgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface ExternalAgentResult {
  session: ExternalAgentSession;
  status: "completed" | "interrupted" | "failed";
  output: string;
  usage?: ExternalAgentUsage;
  error?: string;
}

/**
 * Provider-independent lifecycle for an official coding-agent runtime.
 *
 * Some runtimes (currently Claude) do not allocate a native session until the
 * first prompt. In that case start() returns a bridge-local session and
 * prompt() fills runtimeSessionId in the returned result.
 */
export interface ExternalAgent {
  readonly provider: ExternalAgentProvider;

  start(options: ExternalAgentSessionOptions, signal?: AbortSignal): Promise<ExternalAgentSession>;
  resume(
    runtimeSessionId: string,
    options: ExternalAgentSessionOptions,
    signal?: AbortSignal,
  ): Promise<ExternalAgentSession>;
  prompt(
    session: ExternalAgentSession,
    prompt: ExternalAgentPrompt,
    context?: ExternalAgentRunContext,
  ): Promise<ExternalAgentResult>;
  cancel(session: ExternalAgentSession): Promise<void>;
  close(): Promise<void>;
}
