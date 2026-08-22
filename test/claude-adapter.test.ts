import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { ClaudeAdapter, type ClaudeQueryFactory } from "../src/adapters/claude/claude-adapter.js";

const config = {
  enabled: true,
  maxTurns: 5,
};

const sessionOptions = {
  cwd: process.cwd(),
  permissions: "workspace-write" as const,
};

describe("ClaudeAdapter", () => {
  it("captures the SDK session id and final result", async () => {
    const close = vi.fn();
    const queryFactory = fakeQueryFactory(
      [
        {
          type: "assistant",
          session_id: "claude-session-1",
          message: { content: [{ type: "text", text: "working" }] },
        },
        {
          type: "result",
          subtype: "success",
          session_id: "claude-session-1",
          is_error: false,
          result: "review complete",
          usage: { input_tokens: 10, output_tokens: 5 },
          total_cost_usd: 0.01,
        },
      ],
      close,
    );
    const adapter = new ClaudeAdapter(config, queryFactory);
    const session = await adapter.start(sessionOptions);

    const result = await adapter.prompt(session, { text: "review" });

    expect(result.status).toBe("completed");
    expect(result.output).toBe("review complete");
    expect(result.session.runtimeSessionId).toBe("claude-session-1");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, costUsd: 0.01 });
    expect(close).toHaveBeenCalledOnce();
  });

  it("passes a prior session id back to the SDK", async () => {
    let resume: string | undefined;
    const queryFactory: ClaudeQueryFactory = (params) => {
      resume = params.options?.resume;
      return fakeQuery(
        [
          {
            type: "result",
            subtype: "success",
            session_id: "claude-session-1",
            is_error: false,
            result: "continued",
            usage: { input_tokens: 1, output_tokens: 1 },
            total_cost_usd: 0,
          },
        ],
        vi.fn(),
      );
    };
    const adapter = new ClaudeAdapter(config, queryFactory);
    const session = await adapter.resume("claude-session-1", sessionOptions);

    await adapter.prompt(session, { text: "continue" });

    expect(resume).toBe("claude-session-1");
  });
});

function fakeQueryFactory(messages: unknown[], close: () => void): ClaudeQueryFactory {
  return () => fakeQuery(messages, close);
}

function fakeQuery(messages: unknown[], close: () => void): Query {
  async function* stream(): AsyncGenerator<SDKMessage, void> {
    for (const message of messages) {
      // SAFETY: fixtures intentionally provide only fields consumed by ClaudeAdapter.
      yield message as SDKMessage;
    }
  }

  const generator = stream();
  Object.assign(generator, { close });
  // SAFETY: ClaudeAdapter calls only AsyncGenerator methods and close() in these contract tests.
  return generator as Query;
}
