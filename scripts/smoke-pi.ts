import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import fixtureExtension from "../test/fixtures/pi-extension.js";

process.env.PI_OFFLINE = "1";
process.env.PI_SKIP_VERSION_CHECK = "1";
process.env.PI_TELEMETRY = "0";

const sandbox = await mkdtemp(join(tmpdir(), "pi-agent-bridge-smoke-"));
const cwd = join(sandbox, "project");
const agentDir = join(sandbox, "agent");
await Promise.all([mkdir(cwd, { recursive: true }), mkdir(agentDir, { recursive: true })]);

const controlledMarkers = new Map([
  [join(cwd, "VERSION"), "controlled-version\n"],
  [join(cwd, "HELP.md"), "controlled-help\n"],
  [join(cwd, "MANPAGE.md"), "controlled-manpage\n"],
]);
await Promise.all([...controlledMarkers].map(([path, content]) => writeFile(path, content)));
const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });

try {
  const productionLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
  });
  const productionBinding = await bindSession(productionLoader);
  assert.deepEqual(productionBinding.extensionsResult.errors, [], "bundled extension must load cleanly");
  assertToolNames(productionBinding.session.agent.state.tools.map((tool) => tool.name));
  productionBinding.session.dispose();

  const fixtureLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [{ name: "pi-agent-bridge-smoke-fixture", factory: fixtureExtension }],
  });
  const fixtureBinding = await bindSession(fixtureLoader);
  assert.deepEqual(fixtureBinding.extensionsResult.errors, [], "fixture extension must load cleanly");

  for (const toolName of ["codex_agent", "claude_agent"]) {
    const tool = fixtureBinding.session.agent.state.tools.find((candidate) => candidate.name === toolName);
    assert(tool, `${toolName} must be registered through DefaultResourceLoader`);
    const { execute: runTool } = tool;
    const result = await runTool(`smoke-${toolName}`, { prompt: "smoke test", cwd }, undefined, () => {});
    const text = result.content.find((part) => part.type === "text")?.text ?? "";
    assert.match(text, /fixture completed: smoke test/);
    const details = result.details as { sessionId?: string };
    assert(details.sessionId?.endsWith("-fixture-session"), `${toolName} must return a resumable session id`);
  }
  fixtureBinding.session.dispose();

  for (const [path, expected] of controlledMarkers) {
    assert.equal(
      await readFile(path, "utf8"),
      expected,
      `${path} must remain untouched during startup/tool use`,
    );
  }

  process.stdout.write(
    "Pi smoke: loaded bundled extension, invoked fixture-backed codex_agent and claude_agent, preserved controlled markers\n",
  );
} finally {
  await rm(sandbox, { recursive: true, force: true });
}

async function bindSession(loader: DefaultResourceLoader) {
  await loader.reload();
  return createAgentSession({
    cwd,
    agentDir,
    noTools: "builtin",
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
  });
}

function assertToolNames(names: string[]): void {
  assert(names.includes("codex_agent"), "bundled extension must register codex_agent");
  assert(names.includes("claude_agent"), "bundled extension must register claude_agent");
}
