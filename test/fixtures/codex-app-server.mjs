import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let nextThread = 1;
let nextTurn = 1;
const waitingTurns = new Map();

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    write({ id: message.id, result: { userAgent: "fixture" } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/start") {
    write({ id: message.id, result: { thread: { id: `thread-${nextThread++}` } } });
    return;
  }
  if (message.method === "thread/resume") {
    write({ id: message.id, result: { thread: { id: message.params.threadId } } });
    return;
  }
  if (message.method === "turn/start") {
    const turnId = `turn-${nextTurn++}`;
    const threadId = message.params.threadId;
    const prompt = message.params.input[0]?.text ?? "";
    write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [], error: null } } });

    if (prompt === "wait-for-cancel") {
      waitingTurns.set(turnId, { threadId });
      return;
    }
    if (prompt === "exit-mid-turn") {
      setTimeout(() => process.exit(17), 5);
      return;
    }
    if (prompt === "needs-approval") {
      waitingTurns.set("approval", { threadId, turnId });
      write({
        id: `approval-${turnId}`,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId,
          turnId,
          itemId: "command-1",
          startedAtMs: Date.now(),
          command: "npm test",
          cwd: process.cwd(),
        },
      });
      return;
    }
    complete(threadId, turnId, `fixture: ${prompt}`);
    return;
  }
  if (message.method === "turn/interrupt") {
    write({ id: message.id, result: {} });
    const waiting = waitingTurns.get(message.params.turnId);
    if (waiting) {
      waitingTurns.delete(message.params.turnId);
      complete(waiting.threadId, message.params.turnId, "", "interrupted");
    }
    return;
  }
  if (typeof message.id === "string" && message.id.startsWith("approval-")) {
    const waiting = waitingTurns.get("approval");
    if (waiting) {
      waitingTurns.delete("approval");
      complete(
        waiting.threadId,
        waiting.turnId,
        message.result?.decision === "accept" ? "approval accepted" : "approval declined",
      );
    }
  }
});

function complete(threadId, turnId, text, status = "completed") {
  if (text) {
    write({
      method: "item/agentMessage/delta",
      params: { threadId, turnId, itemId: "message-1", delta: text },
    });
    write({
      method: "item/completed",
      params: { threadId, turnId, item: { type: "agentMessage", id: "message-1", text } },
    });
  }
  write({
    method: "turn/completed",
    params: {
      threadId,
      turn: {
        id: turnId,
        status,
        items: text ? [{ type: "agentMessage", id: "message-1", text }] : [],
        error: null,
      },
    },
  });
}
