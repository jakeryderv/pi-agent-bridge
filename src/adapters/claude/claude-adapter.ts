import { randomUUID } from "node:crypto";
import {
  query,
  type Options as ClaudeOptions,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeRuntimeConfig } from "../../config.js";
import { ExternalAgentError, errorMessage } from "../../core/errors.js";
import type {
  ExternalAgent,
  ExternalAgentPermissionMode,
  ExternalAgentPrompt,
  ExternalAgentResult,
  ExternalAgentRunContext,
  ExternalAgentSession,
  ExternalAgentSessionOptions,
  ExternalAgentUsage,
} from "../../core/types.js";

export type ClaudeQueryFactory = (params: { prompt: string; options?: ClaudeOptions }) => Query;

interface ActiveClaudeQuery {
  controller: AbortController;
  query: Query;
}

export class ClaudeAdapter implements ExternalAgent {
  readonly provider = "claude" as const;
  readonly #config: ClaudeRuntimeConfig;
  readonly #queryFactory: ClaudeQueryFactory;
  readonly #active = new Map<string, ActiveClaudeQuery>();

  constructor(config: ClaudeRuntimeConfig, queryFactory: ClaudeQueryFactory = query) {
    this.#config = config;
    this.#queryFactory = queryFactory;
  }

  async start(options: ExternalAgentSessionOptions, signal?: AbortSignal): Promise<ExternalAgentSession> {
    this.#assertEnabled();
    signal?.throwIfAborted();
    return {
      id: randomUUID(),
      provider: this.provider,
      ...options,
    };
  }

  async resume(
    runtimeSessionId: string,
    options: ExternalAgentSessionOptions,
    signal?: AbortSignal,
  ): Promise<ExternalAgentSession> {
    this.#assertEnabled();
    signal?.throwIfAborted();
    return {
      id: randomUUID(),
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
    this.#assertSessionIdle(session);
    const abortBinding = createAbortBinding(context.signal);
    const options = buildClaudeOptions({
      config: this.#config,
      session,
      prompt,
      context,
      controller: abortBinding.controller,
    });
    const runningQuery = this.#startQuery(prompt.text, options, abortBinding.detach);
    this.#active.set(session.id, { controller: abortBinding.controller, query: runningQuery });
    context.onEvent?.({ type: "status", message: "Starting Claude query" });

    let run: ClaudeRunState;
    try {
      run = await consumeClaudeQuery(runningQuery, session.runtimeSessionId, context);
    } finally {
      abortBinding.detach();
      runningQuery.close();
      this.#active.delete(session.id);
    }

    return buildClaudeResult(
      session,
      run,
      abortBinding.controller.signal.aborted || Boolean(context.signal?.aborted),
    );
  }

  #assertSessionIdle(session: ExternalAgentSession): void {
    if (!this.#active.has(session.id)) return;
    throw new ExternalAgentError(
      "claude",
      `Claude session ${session.runtimeSessionId ?? session.id} already has an active query`,
    );
  }

  #startQuery(prompt: string, options: ClaudeOptions, detachAbort: () => void): Query {
    try {
      return this.#queryFactory({ prompt, options });
    } catch (error) {
      detachAbort();
      throw new ExternalAgentError("claude", `Could not start Claude query: ${errorMessage(error)}`, {
        cause: error,
      });
    }
  }

  async cancel(session: ExternalAgentSession): Promise<void> {
    const active = this.#active.get(session.id);
    if (!active) return;
    active.controller.abort(new DOMException("Cancelled by Pi", "AbortError"));
    active.query.close();
  }

  async close(): Promise<void> {
    for (const active of this.#active.values()) {
      active.controller.abort(new DOMException("Pi session is shutting down", "AbortError"));
      active.query.close();
    }
    this.#active.clear();
  }

  #assertEnabled(): void {
    if (!this.#config.enabled) throw new ExternalAgentError("claude", "Claude adapter is disabled by config");
  }
}

interface AbortBinding {
  controller: AbortController;
  detach: () => void;
}

interface ClaudeRunState {
  runtimeSessionId: string | undefined;
  streamedText: string;
  assistantText: string;
  resultMessage: SDKResultMessage | undefined;
  thrown: unknown;
}

function createAbortBinding(signal?: AbortSignal): AbortBinding {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  return {
    controller,
    detach: () => signal?.removeEventListener("abort", abort),
  };
}

interface BuildClaudeOptionsInput {
  config: ClaudeRuntimeConfig;
  session: ExternalAgentSession;
  prompt: ExternalAgentPrompt;
  context: ExternalAgentRunContext;
  controller: AbortController;
}

function buildClaudeOptions(input: BuildClaudeOptionsInput): ClaudeOptions {
  const options: ClaudeOptions = {
    abortController: input.controller,
    cwd: input.session.cwd,
    includePartialMessages: true,
    persistSession: true,
    maxTurns: input.prompt.maxTurns ?? input.config.maxTurns,
    env: {
      ...process.env,
      CLAUDE_AGENT_SDK_CLIENT_APP: "pi-agent-bridge/0.1.0",
    },
  };
  const selectedModel = input.session.model ?? input.config.model;
  const maxBudgetUsd = input.prompt.maxBudgetUsd ?? input.config.maxBudgetUsd;
  if (selectedModel) options.model = selectedModel;
  if (maxBudgetUsd !== undefined) options.maxBudgetUsd = maxBudgetUsd;
  if (input.session.runtimeSessionId) options.resume = input.session.runtimeSessionId;
  if (input.config.pathToClaudeCodeExecutable) {
    options.pathToClaudeCodeExecutable = input.config.pathToClaudeCodeExecutable;
  }
  Object.assign(options, permissionOptions(input.session.permissions, input.context));
  return options;
}

async function consumeClaudeQuery(
  runningQuery: Query,
  initialSessionId: string | undefined,
  context: ExternalAgentRunContext,
): Promise<ClaudeRunState> {
  const state: ClaudeRunState = {
    runtimeSessionId: initialSessionId,
    streamedText: "",
    assistantText: "",
    resultMessage: undefined,
    thrown: undefined,
  };
  try {
    for await (const message of runningQuery) {
      state.runtimeSessionId = message.session_id || state.runtimeSessionId;
      const handled = consumeClaudeMessage(message, context);
      state.streamedText += handled.delta;
      state.assistantText += handled.assistantText;
      if (message.type === "result") state.resultMessage = message;
    }
  } catch (error) {
    state.thrown = error;
  }
  return state;
}

function buildClaudeResult(
  session: ExternalAgentSession,
  run: ClaudeRunState,
  aborted: boolean,
): ExternalAgentResult {
  const updatedSession: ExternalAgentSession = { ...session };
  if (run.runtimeSessionId) updatedSession.runtimeSessionId = run.runtimeSessionId;

  if (aborted) {
    return {
      session: updatedSession,
      status: "interrupted",
      output: run.streamedText || run.assistantText,
      error: "Claude query was cancelled",
    };
  }

  if (!run.resultMessage) {
    throw new ExternalAgentError("claude", `Claude query failed: ${errorMessage(run.thrown)}`, {
      cause: run.thrown,
    });
  }

  if (run.resultMessage.subtype === "success" && !run.resultMessage.is_error) {
    return {
      session: updatedSession,
      status: "completed",
      output: run.resultMessage.result || run.assistantText || run.streamedText,
      usage: usageFromResult(run.resultMessage),
    };
  }

  let failureOutput = run.assistantText || run.streamedText;
  if (run.resultMessage.subtype === "success") failureOutput = run.resultMessage.result;
  else if (run.resultMessage.errors.length > 0) failureOutput = run.resultMessage.errors.join("\n");
  const failureReason = failureOutput || (run.thrown ? errorMessage(run.thrown) : "Claude query failed");
  return {
    session: updatedSession,
    status: "failed",
    output: failureOutput,
    usage: usageFromResult(run.resultMessage),
    error: failureReason,
  };
}

function consumeClaudeMessage(
  message: SDKMessage,
  context: ExternalAgentRunContext,
): { delta: string; assistantText: string } {
  if (message.type === "stream_event") {
    const event = message.event;
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      context.onEvent?.({ type: "text_delta", delta: event.delta.text });
      return { delta: event.delta.text, assistantText: "" };
    }
  }

  if (message.type === "assistant") {
    let text = "";
    for (const block of message.message.content) {
      if (block.type === "text") text += block.text;
      if (block.type === "tool_use") {
        context.onEvent?.({ type: "tool", name: block.name, status: "started" });
      }
    }
    return { delta: "", assistantText: text };
  }

  if (message.type === "tool_progress") {
    context.onEvent?.({
      type: "tool",
      name: message.tool_name,
      status: "progress",
      detail: `${message.elapsed_time_seconds}s`,
    });
  } else if (message.type === "result") {
    context.onEvent?.({ type: "status", message: `Claude query ${message.subtype}` });
  }

  return { delta: "", assistantText: "" };
}

function permissionOptions(
  permissions: ExternalAgentPermissionMode,
  context: ExternalAgentRunContext,
): Partial<ClaudeOptions> {
  if (permissions === "read-only") {
    return {
      tools: ["Read", "Glob", "Grep"],
      allowedTools: ["Read", "Glob", "Grep"],
      permissionMode: "dontAsk",
    };
  }

  if (permissions === "full-access") {
    return {
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      disallowedTools: ["AskUserQuestion"],
    };
  }

  return {
    permissionMode: "default",
    allowedTools: ["Read", "Glob", "Grep"],
    disallowedTools: ["AskUserQuestion"],
    canUseTool: (toolName, input, options) =>
      approveClaudeTool({
        context,
        toolName,
        toolInput: input,
        suggestedTitle: options.title,
        description: options.description,
      }),
  };
}

interface ClaudeApprovalInput {
  context: ExternalAgentRunContext;
  toolName: string;
  toolInput: Record<string, unknown>;
  suggestedTitle: string | undefined;
  description: string | undefined;
}

async function approveClaudeTool(input: ClaudeApprovalInput): Promise<PermissionResult> {
  const title = input.suggestedTitle ?? `Allow Claude to use ${input.toolName}?`;
  let approved = false;
  if (input.context.approve) {
    const request = {
      provider: "claude" as const,
      title,
      toolName: input.toolName,
      input: input.toolInput,
    };
    if (input.description) Object.assign(request, { description: input.description });
    approved = await input.context.approve(request);
  }
  input.context.onEvent?.({ type: "approval", title, approved });
  if (approved) return { behavior: "allow", updatedInput: input.toolInput };
  return { behavior: "deny", message: "Pi did not approve this tool call." };
}

function usageFromResult(result: SDKResultMessage): ExternalAgentUsage {
  return {
    inputTokens: result.usage.input_tokens,
    outputTokens: result.usage.output_tokens,
    costUsd: result.total_cost_usd,
  };
}
