import type {
  ExternalAgentEvent,
  ExternalAgentResult,
  ExternalAgentRunContext,
  ExternalAgentSession,
} from "../../core/types.js";
import type { JsonRpcNotification } from "./jsonl-rpc-client.js";
import type {
  CodexAgentMessageDeltaParams,
  CodexItemParams,
  CodexThreadItem,
  CodexTurn,
  CodexTurnCompletedParams,
} from "./protocol.js";

export class CodexTurnObserver {
  readonly #threadId: string;
  readonly #context: ExternalAgentRunContext;
  readonly #buffer: JsonRpcNotification[] = [];
  readonly #completion: Promise<CodexTurn>;
  #turnId: string | undefined;
  #streamedText = "";
  #transportError: Error | undefined;
  #resolveCompletion: ((turn: CodexTurn) => void) | undefined;
  #rejectCompletion: ((error: Error) => void) | undefined;

  constructor(threadId: string, context: ExternalAgentRunContext) {
    this.#threadId = threadId;
    this.#context = context;
    this.#completion = new Promise<CodexTurn>((resolve, reject) => {
      this.#resolveCompletion = resolve;
      this.#rejectCompletion = reject;
    });
  }

  accept = (notification: JsonRpcNotification): void => {
    if (!this.#turnId) {
      this.#buffer.push(notification);
      return;
    }
    this.#consume(notification);
  };

  fail = (error: Error): void => {
    this.#transportError = error;
    if (this.#turnId) this.#rejectCompletion?.(error);
  };

  start(turnId: string): void {
    this.#turnId = turnId;
    for (const notification of this.#buffer.splice(0)) this.#consume(notification);
    if (this.#transportError) throw this.#transportError;
  }

  wait(): Promise<CodexTurn> {
    return this.#completion;
  }

  partialOutput(): string {
    return this.#streamedText;
  }

  result(session: ExternalAgentSession, turn: CodexTurn): ExternalAgentResult {
    const result: ExternalAgentResult = {
      session,
      status: turnStatus(turn),
      output: finalAgentText(turn) || this.#streamedText,
    };
    if (turn.error?.message) result.error = turn.error.message;
    return result;
  }

  #consume(notification: JsonRpcNotification): void {
    if (!this.#isForActiveTurn(notification)) return;
    if (notification.method === "item/agentMessage/delta") {
      this.#consumeTextDelta(notification.params as CodexAgentMessageDeltaParams);
      return;
    }
    if (notification.method === "item/started" || notification.method === "item/completed") {
      emitItemEvent(notification.method, notification.params as CodexItemParams, this.#context.onEvent);
      return;
    }
    if (notification.method === "turn/completed") {
      this.#resolveCompletion?.((notification.params as CodexTurnCompletedParams).turn);
    }
  }

  #isForActiveTurn(notification: JsonRpcNotification): boolean {
    if (!isRecord(notification.params)) return false;
    if (notification.params.threadId !== this.#threadId) return false;
    return !("turnId" in notification.params) || notification.params.turnId === this.#turnId;
  }

  #consumeTextDelta(params: CodexAgentMessageDeltaParams): void {
    this.#streamedText += params.delta;
    this.#context.onEvent?.({ type: "text_delta", delta: params.delta });
  }
}

function emitItemEvent(
  method: "item/started" | "item/completed",
  params: CodexItemParams,
  onEvent?: (event: ExternalAgentEvent) => void,
): void {
  const status = method === "item/started" ? "started" : "completed";
  const item = params.item;
  if (isCommandExecution(item)) {
    onEvent?.({ type: "tool", name: "command", status, detail: item.command });
    return;
  }
  if (item.type === "fileChange") {
    onEvent?.({ type: "tool", name: "file_change", status });
    return;
  }
  if (isMcpToolCall(item)) {
    onEvent?.({ type: "tool", name: `${item.server}/${item.tool}`, status });
  }
}

function isCommandExecution(
  item: CodexThreadItem,
): item is CodexThreadItem & { type: "commandExecution"; command: string } {
  return item.type === "commandExecution" && "command" in item && typeof item.command === "string";
}

function isMcpToolCall(
  item: CodexThreadItem,
): item is CodexThreadItem & { type: "mcpToolCall"; server: string; tool: string } {
  return (
    item.type === "mcpToolCall" &&
    "server" in item &&
    typeof item.server === "string" &&
    "tool" in item &&
    typeof item.tool === "string"
  );
}

function finalAgentText(turn: CodexTurn): string {
  const messages: string[] = [];
  for (const item of turn.items) {
    if (item.type === "agentMessage" && "text" in item && typeof item.text === "string") {
      messages.push(item.text);
    }
  }
  return messages.join("\n");
}

function turnStatus(turn: CodexTurn): ExternalAgentResult["status"] {
  if (turn.status === "completed") return "completed";
  if (turn.status === "interrupted") return "interrupted";
  return "failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
