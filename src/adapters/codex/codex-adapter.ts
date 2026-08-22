import type { CodexRuntimeConfig } from "../../config.js";
import { ExternalAgentError, ExternalAgentProtocolError, errorMessage } from "../../core/errors.js";
import type {
  ExternalAgent,
  ExternalAgentApprovalRequest,
  ExternalAgentPermissionMode,
  ExternalAgentPrompt,
  ExternalAgentResult,
  ExternalAgentRunContext,
  ExternalAgentSession,
  ExternalAgentSessionOptions,
} from "../../core/types.js";
import { CodexJsonlRpcClient, type JsonRpcServerRequest } from "./jsonl-rpc-client.js";
import type { CodexApprovalParams, CodexThreadResponse, CodexTurnStartResponse } from "./protocol.js";
import { CodexTurnObserver } from "./turn-observer.js";

const PACKAGE_VERSION = "0.1.0";

type ApprovalHandler = (request: ExternalAgentApprovalRequest) => Promise<boolean>;
type ThreadMethod = "thread/start" | "thread/resume";

interface ThreadOpenParams {
  threadId?: string;
  cwd: string;
  model?: string;
  approvalPolicy: string;
  sandbox: string;
}

interface TurnStartParams {
  threadId: string;
  input: Array<{ type: "text"; text: string; text_elements: [] }>;
  cwd: string;
  model?: string;
  approvalPolicy: string;
}

export class CodexAdapter implements ExternalAgent {
  readonly provider = "codex" as const;
  readonly #config: CodexRuntimeConfig;
  readonly #client: CodexJsonlRpcClient;
  readonly #activeTurns = new Map<string, { threadId: string; turnId: string }>();
  readonly #approvalHandlers = new Map<string, ApprovalHandler>();

  constructor(config: CodexRuntimeConfig, client?: CodexJsonlRpcClient) {
    this.#config = config;
    this.#client =
      client ??
      new CodexJsonlRpcClient({
        command: config.command,
        args: config.args,
        clientVersion: PACKAGE_VERSION,
      });
    this.#client.setServerRequestHandler((request) => this.#handleServerRequest(request));
  }

  start(options: ExternalAgentSessionOptions, signal?: AbortSignal): Promise<ExternalAgentSession> {
    return this.#openThread("thread/start", options, undefined, signal);
  }

  resume(
    runtimeSessionId: string,
    options: ExternalAgentSessionOptions,
    signal?: AbortSignal,
  ): Promise<ExternalAgentSession> {
    return this.#openThread("thread/resume", options, runtimeSessionId, signal);
  }

  async prompt(
    session: ExternalAgentSession,
    prompt: ExternalAgentPrompt,
    context: ExternalAgentRunContext = {},
  ): Promise<ExternalAgentResult> {
    const threadId = this.#promptableThreadId(session);
    context.signal?.throwIfAborted();
    context.onEvent?.({ type: "status", message: "Starting Codex turn" });

    const observer = new CodexTurnObserver(threadId, context);
    const unsubscribe = this.#client.subscribe(observer.accept, observer.fail);
    let turnId: string | undefined;
    let detachAbort = () => {};

    try {
      const response = await this.#client.request<CodexTurnStartResponse>(
        "turn/start",
        this.#turnStartParams(threadId, session, prompt),
      );
      turnId = response.turn?.id;
      if (!turnId) throw new ExternalAgentProtocolError("codex", "turn/start returned no turn id");

      this.#activeTurns.set(session.id, { threadId, turnId });
      if (context.approve) this.#approvalHandlers.set(turnId, context.approve);
      observer.start(turnId);
      detachAbort = this.#bindAbort(context.signal, { threadId, turnId });
      const turn = await observer.wait();
      return observer.result(session, turn);
    } catch (error) {
      if (context.signal?.aborted) {
        return {
          session,
          status: "interrupted",
          output: observer.partialOutput(),
          error: "Codex turn was cancelled",
        };
      }
      throw new ExternalAgentError("codex", `Codex turn failed: ${errorMessage(error)}`, { cause: error });
    } finally {
      detachAbort();
      unsubscribe();
      if (turnId) this.#approvalHandlers.delete(turnId);
      this.#activeTurns.delete(session.id);
    }
  }

  async cancel(session: ExternalAgentSession): Promise<void> {
    const active = this.#activeTurns.get(session.id);
    if (active) await this.#client.request("turn/interrupt", active);
  }

  async close(): Promise<void> {
    await this.#client.close();
  }

  async #openThread(
    method: ThreadMethod,
    options: ExternalAgentSessionOptions,
    runtimeSessionId: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ExternalAgentSession> {
    this.#assertEnabled();
    const params: ThreadOpenParams = {
      cwd: options.cwd,
      approvalPolicy: approvalPolicy(options.permissions),
      sandbox: sandboxMode(options.permissions),
    };
    if (runtimeSessionId) params.threadId = runtimeSessionId;
    const model = options.model ?? this.#config.model;
    if (model) params.model = model;

    const response = await this.#client.request<CodexThreadResponse>(method, params, signal);
    if (!response.thread?.id) {
      throw new ExternalAgentProtocolError("codex", `${method} returned no thread id`);
    }
    return {
      id: response.thread.id,
      runtimeSessionId: response.thread.id,
      provider: this.provider,
      ...options,
    };
  }

  #promptableThreadId(session: ExternalAgentSession): string {
    if (!session.runtimeSessionId) {
      throw new ExternalAgentError("codex", "Codex session has no runtime thread id");
    }
    if (this.#activeTurns.has(session.id)) {
      throw new ExternalAgentError(
        "codex",
        `Codex session ${session.runtimeSessionId} already has an active turn`,
      );
    }
    return session.runtimeSessionId;
  }

  #turnStartParams(
    threadId: string,
    session: ExternalAgentSession,
    prompt: ExternalAgentPrompt,
  ): TurnStartParams {
    const params: TurnStartParams = {
      threadId,
      input: [{ type: "text", text: prompt.text, text_elements: [] }],
      cwd: session.cwd,
      approvalPolicy: approvalPolicy(session.permissions),
    };
    const model = session.model ?? this.#config.model;
    if (model) params.model = model;
    return params;
  }

  #bindAbort(signal: AbortSignal | undefined, activeTurn: { threadId: string; turnId: string }): () => void {
    if (!signal) return () => {};
    const abort = () => {
      void this.#client.request("turn/interrupt", activeTurn).catch(() => undefined);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    return () => signal.removeEventListener("abort", abort);
  }

  async #handleServerRequest(request: JsonRpcServerRequest): Promise<unknown> {
    if (!isApprovalMethod(request.method)) {
      throw new ExternalAgentProtocolError("codex", `Unsupported Codex server request: ${request.method}`);
    }

    const params = request.params as CodexApprovalParams;
    const approve = this.#approvalHandlers.get(params.turnId);
    const approvalRequest: ExternalAgentApprovalRequest = {
      provider: "codex",
      title: approvalTitle(request.method, params),
    };
    if (params.reason) approvalRequest.description = params.reason;
    if (params.command) {
      approvalRequest.toolName = "commandExecution";
      approvalRequest.input = { command: params.command };
    }
    const approved = approve ? await approve(approvalRequest) : false;
    return { decision: approved ? "accept" : "decline" };
  }

  #assertEnabled(): void {
    if (!this.#config.enabled) throw new ExternalAgentError("codex", "Codex adapter is disabled by config");
  }
}

function isApprovalMethod(method: string): boolean {
  return method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval";
}

function sandboxMode(permissions: ExternalAgentPermissionMode): string {
  if (permissions === "read-only") return "read-only";
  if (permissions === "full-access") return "danger-full-access";
  return "workspace-write";
}

function approvalPolicy(permissions: ExternalAgentPermissionMode): string {
  return permissions === "full-access" ? "never" : "on-request";
}

function approvalTitle(method: string, params: CodexApprovalParams): string {
  if (method === "item/commandExecution/requestApproval") {
    if (params.command) return `Allow Codex to run: ${params.command}`;
    return "Allow Codex command execution?";
  }
  if (params.grantRoot) return `Allow Codex to write under ${params.grantRoot}?`;
  return "Allow Codex file changes?";
}
