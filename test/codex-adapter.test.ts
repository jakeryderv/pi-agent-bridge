import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAdapter } from "../src/adapters/codex/codex-adapter.js";
import type { ExternalAgentEvent } from "../src/core/types.js";

const fixture = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/codex-app-server.mjs");
const adapters: CodexAdapter[] = [];

const runtimeConfig = {
  enabled: true,
  command: process.execPath,
  args: [fixture],
};

const sessionOptions = {
  cwd: process.cwd(),
  permissions: "workspace-write" as const,
};

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
});

describe("CodexAdapter", () => {
  it("starts a thread and streams a completed turn", async () => {
    const adapter = new CodexAdapter(runtimeConfig);
    adapters.push(adapter);
    const events: ExternalAgentEvent[] = [];
    const session = await adapter.start(sessionOptions);

    const result = await adapter.prompt(
      session,
      { text: "hello" },
      { onEvent: (event) => events.push(event) },
    );

    expect(result.status).toBe("completed");
    expect(result.output).toBe("fixture: hello");
    expect(result.session.runtimeSessionId).toMatch(/^thread-/);
    expect(events).toContainEqual({ type: "text_delta", delta: "fixture: hello" });
  });

  it("routes app-server approval requests through the bridge callback", async () => {
    const adapter = new CodexAdapter(runtimeConfig);
    adapters.push(adapter);
    const session = await adapter.start(sessionOptions);

    const result = await adapter.prompt(session, { text: "needs-approval" }, { approve: async () => true });

    expect(result.output).toBe("approval accepted");
  });

  it("rejects instead of hanging when app-server exits during a turn", async () => {
    const adapter = new CodexAdapter(runtimeConfig);
    adapters.push(adapter);
    const session = await adapter.start(sessionOptions);

    await expect(adapter.prompt(session, { text: "exit-mid-turn" })).rejects.toThrow("exited unexpectedly");
  });

  it("interrupts an active turn when Pi aborts", async () => {
    const adapter = new CodexAdapter(runtimeConfig);
    adapters.push(adapter);
    const session = await adapter.start(sessionOptions);
    const controller = new AbortController();

    const resultPromise = adapter.prompt(session, { text: "wait-for-cancel" }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 25);
    const result = await resultPromise;

    expect(result.status).toBe("interrupted");
  });
});
