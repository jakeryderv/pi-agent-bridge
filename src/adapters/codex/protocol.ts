interface CodexThread {
  id: string;
}

export interface CodexThreadResponse {
  thread: CodexThread;
}

export interface CodexTurn {
  id: string;
  status: "completed" | "interrupted" | "failed" | "inProgress";
  error: { message: string } | null;
  items: CodexThreadItem[];
}

export type CodexThreadItem =
  | { type: "agentMessage"; id: string; text: string }
  | { type: "commandExecution"; id: string; command: string; status: string }
  | { type: "fileChange"; id: string; status: string }
  | { type: "mcpToolCall"; id: string; server: string; tool: string; status: string }
  | { type: string; id?: string };

export interface CodexTurnStartResponse {
  turn: CodexTurn;
}

export interface CodexTurnCompletedParams {
  threadId: string;
  turn: CodexTurn;
}

export interface CodexAgentMessageDeltaParams {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

export interface CodexItemParams {
  threadId: string;
  turnId: string;
  item: CodexThreadItem;
}

export interface CodexApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  reason?: string | null;
  command?: string | null;
  cwd?: string | null;
  grantRoot?: string | null;
}
