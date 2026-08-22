import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { ClaudeAdapter } from "./adapters/claude/claude-adapter.js";
import { CodexAdapter } from "./adapters/codex/codex-adapter.js";
import { type BridgeConfig, loadBridgeConfig, resolveAgentCwd } from "./config.js";
import { ExternalAgentPool, type ExternalAgentFactory } from "./core/adapter-pool.js";
import { ExternalAgentError } from "./core/errors.js";
import type {
  ExternalAgent,
  ExternalAgentEvent,
  ExternalAgentPermissionMode,
  ExternalAgentPrompt,
  ExternalAgentProvider,
  ExternalAgentResult,
  ExternalAgentRunContext,
  ExternalAgentSession,
  ExternalAgentSessionOptions,
} from "./core/types.js";

const PermissionSchema = StringEnum(["read-only", "workspace-write", "full-access"] as const, {
  description:
    "Runtime permission boundary. full-access bypasses the external runtime's permission checks and must be chosen explicitly.",
});

const BaseAgentParams = {
  prompt: Type.String({ description: "Task or follow-up prompt for the external coding agent" }),
  sessionId: Type.Optional(
    Type.String({
      description: "Native session/thread ID from an earlier result; omit to start a new session",
    }),
  ),
  cwd: Type.Optional(
    Type.String({ description: "Working directory, relative to Pi's cwd by default; must stay within it" }),
  ),
  model: Type.Optional(Type.String({ description: "Provider-native model override" })),
  permissions: Type.Optional(PermissionSchema),
};

const CodexAgentParams = Type.Object(BaseAgentParams, { additionalProperties: false });
const ClaudeAgentParams = Type.Object(
  {
    ...BaseAgentParams,
    maxTurns: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum Claude agent-loop turns" })),
    maxBudgetUsd: Type.Optional(
      Type.Number({ exclusiveMinimum: 0, description: "Maximum estimated Claude query spend in USD" }),
    ),
  },
  { additionalProperties: false },
);

type CodexAgentInput = Static<typeof CodexAgentParams>;
type ClaudeAgentInput = Static<typeof ClaudeAgentParams>;
type AgentToolInput = CodexAgentInput | ClaudeAgentInput;
type AgentToolUpdate = (result: {
  content: [{ type: "text"; text: string }];
  details: AgentBridgeToolDetails;
}) => void;

export interface AgentBridgeToolDetails {
  provider: ExternalAgentProvider;
  status: "running" | ExternalAgentResult["status"];
  bridgeSessionId?: string;
  sessionId?: string;
  cwd: string;
  model?: string;
  permissions: ExternalAgentPermissionMode;
  usage?: ExternalAgentResult["usage"];
  fullOutputPath?: string;
  truncated?: boolean;
  lastEvent?: ExternalAgentEvent;
}

export interface PiAgentBridgeDependencies {
  adapterFactory?: ExternalAgentFactory;
  configLoader?: typeof loadBridgeConfig;
}

interface ExecuteAgentOptions {
  provider: ExternalAgentProvider;
  params: AgentToolInput;
  signal?: AbortSignal | undefined;
  onUpdate?: AgentToolUpdate | undefined;
  ctx: ExtensionContext;
  pool: ExternalAgentPool;
  configLoader: typeof loadBridgeConfig;
}

interface PreparedInvocation {
  provider: ExternalAgentProvider;
  params: AgentToolInput;
  signal?: AbortSignal | undefined;
  onUpdate?: AgentToolUpdate | undefined;
  ctx: ExtensionContext;
  adapter: ExternalAgent;
  session: ExternalAgentSession;
  cwd: string;
  permissions: ExternalAgentPermissionMode;
  model?: string;
}

interface ProgressReporter {
  onEvent: (event: ExternalAgentEvent) => void;
  flush: () => void;
  lastEvent: () => ExternalAgentEvent | undefined;
}

export function createPiAgentBridgeExtension(dependencies: PiAgentBridgeDependencies = {}): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    const configLoader = dependencies.configLoader ?? loadBridgeConfig;
    const pool = new ExternalAgentPool(dependencies.adapterFactory ?? createDefaultAdapter);

    pi.registerTool({
      name: "codex_agent",
      label: "Codex Agent",
      description: [
        "Delegate a coding task to the official Codex app-server runtime.",
        "Returns the native thread ID for follow-ups through sessionId.",
        `Output is limited to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; full truncated output is saved to a temporary file.`,
      ].join(" "),
      promptSnippet: "Delegate an isolated coding task to Codex and optionally resume its native thread",
      promptGuidelines: [
        "Use codex_agent for bounded delegated coding work when the user asks for Codex or an external implementation agent.",
        "Reuse codex_agent sessionId for follow-up work that needs the prior Codex context.",
        "Do not select codex_agent full-access unless the user explicitly requests unrestricted external-agent execution.",
      ],
      parameters: CodexAgentParams,
      execute: async (_toolCallId, params, signal, onUpdate, ctx) =>
        executeAgent({ provider: "codex", params, signal, onUpdate, ctx, pool, configLoader }),
    });

    pi.registerTool({
      name: "claude_agent",
      label: "Claude Agent",
      description: [
        "Delegate a coding task to the official Claude Agent SDK / Claude Code runtime.",
        "Returns the native session ID for follow-ups through sessionId.",
        `Output is limited to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; full truncated output is saved to a temporary file.`,
      ].join(" "),
      promptSnippet:
        "Delegate an isolated coding task to Claude Code and optionally resume its native session",
      promptGuidelines: [
        "Use claude_agent for bounded delegated coding work when the user asks for Claude Code or an external review agent.",
        "Reuse claude_agent sessionId for follow-up work that needs the prior Claude context.",
        "Do not select claude_agent full-access unless the user explicitly requests unrestricted external-agent execution.",
      ],
      parameters: ClaudeAgentParams,
      execute: async (_toolCallId, params, signal, onUpdate, ctx) =>
        executeAgent({ provider: "claude", params, signal, onUpdate, ctx, pool, configLoader }),
    });

    pi.on("session_shutdown", async () => {
      await pool.closeAll();
    });
  };
}

async function executeAgent(options: ExecuteAgentOptions) {
  const invocation = await prepareInvocation(options);
  const progress = createProgressReporter(invocation);
  const result = await invocation.adapter.prompt(
    invocation.session,
    buildExternalPrompt(invocation.params),
    createRunContext(invocation, progress),
  );
  progress.flush();
  assertSuccessfulResult(invocation.provider, result);

  const formatted = await formatFinalOutput(invocation.provider, result.output);
  const detailOptions: DetailOptions = {
    provider: invocation.provider,
    status: result.status,
    session: result.session,
    cwd: invocation.cwd,
    permissions: invocation.permissions,
    truncated: formatted.truncated,
  };
  if (invocation.model) detailOptions.model = invocation.model;
  if (result.usage) detailOptions.usage = result.usage;
  if (formatted.fullOutputPath) detailOptions.fullOutputPath = formatted.fullOutputPath;
  const lastEvent = progress.lastEvent();
  if (lastEvent) detailOptions.lastEvent = lastEvent;

  return {
    content: [{ type: "text" as const, text: formatted.text }],
    details: makeDetails(detailOptions),
  };
}

async function prepareInvocation(options: ExecuteAgentOptions): Promise<PreparedInvocation> {
  const config = await options.configLoader({
    cwd: options.ctx.cwd,
    isProjectTrusted: options.ctx.isProjectTrusted(),
  });
  if (!config[options.provider].enabled) {
    throw new ExternalAgentError(options.provider, `${options.provider} is disabled by config`);
  }

  const cwdOptions: Parameters<typeof resolveAgentCwd>[0] = {
    piCwd: options.ctx.cwd,
    allowOutsideCwd: config.security.allowOutsideCwd,
  };
  if (options.params.cwd) cwdOptions.requestedCwd = options.params.cwd;
  const cwd = await resolveAgentCwd(cwdOptions);
  const permissions = options.params.permissions ?? config.defaults.permissions;
  const model = options.params.model ?? config[options.provider].model;
  const sessionOptions: ExternalAgentSessionOptions = { cwd, permissions };
  if (model) sessionOptions.model = model;

  const adapter = options.pool.get(options.provider, config);
  const session = options.params.sessionId
    ? await adapter.resume(options.params.sessionId, sessionOptions, options.signal)
    : await adapter.start(sessionOptions, options.signal);
  const invocation: PreparedInvocation = {
    provider: options.provider,
    params: options.params,
    ctx: options.ctx,
    adapter,
    session,
    cwd,
    permissions,
  };
  if (options.signal) invocation.signal = options.signal;
  if (options.onUpdate) invocation.onUpdate = options.onUpdate;
  if (model) invocation.model = model;
  return invocation;
}

function buildExternalPrompt(params: AgentToolInput): ExternalAgentPrompt {
  const prompt: ExternalAgentPrompt = { text: params.prompt };
  if ("maxTurns" in params && params.maxTurns !== undefined) prompt.maxTurns = params.maxTurns;
  if ("maxBudgetUsd" in params && params.maxBudgetUsd !== undefined) {
    prompt.maxBudgetUsd = params.maxBudgetUsd;
  }
  return prompt;
}

function createRunContext(
  invocation: PreparedInvocation,
  progress: ProgressReporter,
): ExternalAgentRunContext {
  const context: ExternalAgentRunContext = {
    onEvent: progress.onEvent,
    approve: (request) => {
      if (!invocation.ctx.hasUI) return Promise.resolve(false);
      const message = [request.title, request.description].filter(Boolean).join("\n\n");
      return invocation.ctx.ui.confirm(
        "External agent permission",
        message,
        invocation.signal ? { signal: invocation.signal } : undefined,
      );
    },
  };
  if (invocation.signal) context.signal = invocation.signal;
  return context;
}

function createProgressReporter(invocation: PreparedInvocation): ProgressReporter {
  let streamedText = "";
  let currentEvent: ExternalAgentEvent | undefined;
  let lastUpdateAt = 0;

  const emit = (force: boolean) => {
    if (!invocation.onUpdate) return;
    const now = Date.now();
    if (!force && now - lastUpdateAt < 100) return;
    lastUpdateAt = now;
    const preview = truncateHead(streamedText || progressText(currentEvent), {
      maxLines: 100,
      maxBytes: 8 * 1024,
    }).content;
    const detailOptions: DetailOptions = {
      provider: invocation.provider,
      status: "running",
      session: invocation.session,
      cwd: invocation.cwd,
      permissions: invocation.permissions,
    };
    if (invocation.model) detailOptions.model = invocation.model;
    if (currentEvent) detailOptions.lastEvent = currentEvent;
    invocation.onUpdate({
      content: [{ type: "text", text: preview || `${invocation.provider} is running...` }],
      details: makeDetails(detailOptions),
    });
  };

  return {
    onEvent: (event) => {
      currentEvent = event;
      if (event.type === "text_delta") streamedText += event.delta;
      emit(event.type !== "text_delta");
    },
    flush: () => emit(true),
    lastEvent: () => currentEvent,
  };
}

function assertSuccessfulResult(provider: ExternalAgentProvider, result: ExternalAgentResult): void {
  if (result.status === "completed") return;
  const sessionId = result.session.runtimeSessionId ?? result.session.id;
  const output = truncateHead(result.error || result.output || "No error details returned", {
    maxLines: 100,
    maxBytes: 8 * 1024,
  }).content;
  throw new ExternalAgentError(provider, `${provider} ${result.status} (session ${sessionId}): ${output}`);
}

function createDefaultAdapter(provider: ExternalAgentProvider, config: BridgeConfig) {
  return provider === "codex" ? new CodexAdapter(config.codex) : new ClaudeAdapter(config.claude);
}

interface DetailOptions {
  provider: ExternalAgentProvider;
  status: AgentBridgeToolDetails["status"];
  session: { id: string; runtimeSessionId?: string };
  cwd: string;
  permissions: ExternalAgentPermissionMode;
  model?: string;
  usage?: ExternalAgentResult["usage"];
  fullOutputPath?: string;
  truncated?: boolean;
  lastEvent?: ExternalAgentEvent;
}

function makeDetails(options: DetailOptions): AgentBridgeToolDetails {
  const details: AgentBridgeToolDetails = {
    provider: options.provider,
    status: options.status,
    bridgeSessionId: options.session.id,
    cwd: options.cwd,
    permissions: options.permissions,
  };
  if (options.session.runtimeSessionId) details.sessionId = options.session.runtimeSessionId;
  if (options.model) details.model = options.model;
  if (options.usage) details.usage = options.usage;
  if (options.fullOutputPath) details.fullOutputPath = options.fullOutputPath;
  if (options.truncated !== undefined) details.truncated = options.truncated;
  if (options.lastEvent) details.lastEvent = options.lastEvent;
  return details;
}

async function formatFinalOutput(
  provider: ExternalAgentProvider,
  output: string,
): Promise<{ text: string; truncated: boolean; fullOutputPath?: string }> {
  const normalized = output || "(external agent returned no text output)";
  const truncation = truncateHead(normalized, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  if (!truncation.truncated) return { text: truncation.content, truncated: false };

  const directory = await mkdtemp(join(tmpdir(), `pi-agent-bridge-${provider}-`));
  const fullOutputPath = join(directory, "output.txt");
  await withFileMutationQueue(fullOutputPath, () => writeFile(fullOutputPath, normalized, { mode: 0o600 }));
  const text = `${truncation.content}\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${fullOutputPath}]`;
  return { text, truncated: true, fullOutputPath };
}

function progressText(event: ExternalAgentEvent | undefined): string {
  if (!event) return "External agent is starting...";
  if (event.type === "status") return event.message;
  if (event.type === "tool") {
    return `${event.name}: ${event.status}${event.detail ? ` (${event.detail})` : ""}`;
  }
  if (event.type === "approval") return `${event.approved ? "Approved" : "Denied"}: ${event.title}`;
  return event.delta;
}
