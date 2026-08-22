import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadBridgeConfig, resolveAgentCwd } from "../src/config.js";

const temporaryPaths: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(async () => {
  delete process.env.PI_AGENT_BRIDGE_CODEX_COMMAND;
  delete process.env.PI_AGENT_BRIDGE_CLAUDE_PATH;
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("bridge config", () => {
  it("merges trusted project defaults without allowing project config to expand cwd access", async () => {
    const cwd = await temporaryDirectory();
    process.env.PI_CODING_AGENT_DIR = await temporaryDirectory();
    await mkdir(join(cwd, ".pi"));
    await writeFile(
      join(cwd, ".pi/pi-agent-bridge.json"),
      JSON.stringify({
        defaults: { permissions: "read-only" },
        security: { allowOutsideCwd: true },
        codex: { command: "/tmp/untrusted-codex", args: ["malicious"], model: "gpt-test" },
        claude: {
          pathToClaudeCodeExecutable: "/tmp/untrusted-claude",
          maxTurns: 100,
          maxBudgetUsd: 5,
        },
      }),
    );

    const config = await loadBridgeConfig({ cwd, isProjectTrusted: true });

    expect(config.defaults.permissions).toBe("read-only");
    expect(config.codex.model).toBe("gpt-test");
    expect(config.codex.command).toBe("codex");
    expect(config.codex.args).toEqual(["app-server"]);
    expect(config.claude.pathToClaudeCodeExecutable).toBeUndefined();
    expect(config.claude.maxTurns).toBe(30);
    expect(config.claude.maxBudgetUsd).toBe(5);
    expect(config.security.allowOutsideCwd).toBe(false);
  });

  it("rejects invalid config value types at the file boundary", async () => {
    const cwd = await temporaryDirectory();
    process.env.PI_CODING_AGENT_DIR = await temporaryDirectory();
    await mkdir(join(cwd, ".pi"));
    await writeFile(join(cwd, ".pi/pi-agent-bridge.json"), JSON.stringify({ claude: { maxTurns: "many" } }));

    await expect(loadBridgeConfig({ cwd, isProjectTrusted: true })).rejects.toThrow(
      "Invalid pi-agent-bridge config",
    );
  });

  it("resolves subdirectories and rejects cwd escapes by default", async () => {
    const cwd = await temporaryDirectory();
    const child = join(cwd, "child");
    const outside = await temporaryDirectory();
    await mkdir(child);

    await expect(
      resolveAgentCwd({ requestedCwd: "child", piCwd: cwd, allowOutsideCwd: false }),
    ).resolves.toBe(await realpath(child));
    await expect(
      resolveAgentCwd({ requestedCwd: outside, piCwd: cwd, allowOutsideCwd: false }),
    ).rejects.toThrow("must stay within Pi's cwd");
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pi-agent-bridge-test-"));
  temporaryPaths.push(path);
  return path;
}
