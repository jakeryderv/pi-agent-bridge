import { describe, expect, it, vi } from "vitest";
import { ExternalAgentPool } from "../src/core/adapter-pool.js";
import { fixtureBridgeConfig } from "./fixtures/bridge-config.js";
import { FakeExternalAgent } from "./fixtures/fake-adapter.js";

describe("ExternalAgentPool", () => {
  it("reuses adapters for the same runtime config and closes them once", async () => {
    const close = vi.fn(async () => {});
    const pool = new ExternalAgentPool((provider) => {
      const adapter = new FakeExternalAgent(provider);
      adapter.close = close;
      return adapter;
    });

    const first = pool.get("codex", fixtureBridgeConfig);
    const second = pool.get("codex", fixtureBridgeConfig);

    expect(first).toBe(second);
    await pool.closeAll();
    await pool.closeAll();
    expect(close).toHaveBeenCalledOnce();
  });
});
