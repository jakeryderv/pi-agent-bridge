import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Parse } from "typebox/value";
import type { ExternalAgentPermissionMode } from "./core/types.js";

export interface CodexRuntimeConfig {
  enabled: boolean;
  command: string;
  args: string[];
  model?: string;
}

export interface ClaudeRuntimeConfig {
  enabled: boolean;
  pathToClaudeCodeExecutable?: string;
  model?: string;
  maxTurns: number;
  maxBudgetUsd?: number;
}

export type ProviderRuntimeConfig = CodexRuntimeConfig | ClaudeRuntimeConfig;

export interface BridgeConfig {
  defaults: {
    permissions: ExternalAgentPermissionMode;
  };
  security: {
    allowOutsideCwd: boolean;
  };
  codex: CodexRuntimeConfig;
  claude: ClaudeRuntimeConfig;
}

const PermissionConfigSchema = Type.Union([
  Type.Literal("read-only"),
  Type.Literal("workspace-write"),
  Type.Literal("full-access"),
]);

const PartialBridgeConfigSchema = Type.Object(
  {
    defaults: Type.Optional(
      Type.Object({ permissions: Type.Optional(PermissionConfigSchema) }, { additionalProperties: true }),
    ),
    security: Type.Optional(
      Type.Object({ allowOutsideCwd: Type.Optional(Type.Boolean()) }, { additionalProperties: true }),
    ),
    codex: Type.Optional(
      Type.Object(
        {
          enabled: Type.Optional(Type.Boolean()),
          command: Type.Optional(Type.String()),
          args: Type.Optional(Type.Array(Type.String())),
          model: Type.Optional(Type.String()),
        },
        { additionalProperties: true },
      ),
    ),
    claude: Type.Optional(
      Type.Object(
        {
          enabled: Type.Optional(Type.Boolean()),
          pathToClaudeCodeExecutable: Type.Optional(Type.String()),
          model: Type.Optional(Type.String()),
          maxTurns: Type.Optional(Type.Integer({ minimum: 1 })),
          maxBudgetUsd: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
        },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
);

type PartialBridgeConfig = Static<typeof PartialBridgeConfigSchema>;

const DEFAULT_CONFIG: BridgeConfig = {
  defaults: {
    permissions: "workspace-write",
  },
  security: {
    allowOutsideCwd: false,
  },
  codex: {
    enabled: true,
    command: "codex",
    args: ["app-server"],
  },
  claude: {
    enabled: true,
    maxTurns: 30,
  },
};

export async function loadBridgeConfig(options: {
  cwd: string;
  isProjectTrusted: boolean;
}): Promise<BridgeConfig> {
  const globalPath = join(getAgentDir(), "pi-agent-bridge.json");
  const projectPath = join(options.cwd, CONFIG_DIR_NAME, "pi-agent-bridge.json");

  const globalConfig = await readOptionalConfig(globalPath);
  const projectConfig = options.isProjectTrusted ? await readOptionalConfig(projectPath) : {};
  const config = mergeConfig(DEFAULT_CONFIG, globalConfig, projectConfig);

  if (process.env.PI_AGENT_BRIDGE_CODEX_COMMAND) {
    config.codex.command = process.env.PI_AGENT_BRIDGE_CODEX_COMMAND;
  }
  if (process.env.PI_AGENT_BRIDGE_CLAUDE_PATH) {
    config.claude.pathToClaudeCodeExecutable = process.env.PI_AGENT_BRIDGE_CLAUDE_PATH;
  }

  validateConfig(config);
  return config;
}

export async function resolveAgentCwd(options: {
  requestedCwd?: string;
  piCwd: string;
  allowOutsideCwd: boolean;
}): Promise<string> {
  const raw = options.requestedCwd?.replace(/^@/, "") ?? options.piCwd;
  const candidate = isAbsolute(raw) ? raw : resolve(options.piCwd, raw);
  let isDirectory: boolean;
  try {
    const candidateStats = await stat(candidate);
    isDirectory = candidateStats.isDirectory();
  } catch {
    throw new Error(`Agent cwd is not a directory: ${candidate}`);
  }
  if (!isDirectory) throw new Error(`Agent cwd is not a directory: ${candidate}`);

  const [baseRealPath, candidateRealPath] = await Promise.all([realpath(options.piCwd), realpath(candidate)]);
  const pathFromBase = relative(baseRealPath, candidateRealPath);
  const isWithinBase = pathFromBase === "" || (!pathFromBase.startsWith("..") && !isAbsolute(pathFromBase));
  if (!options.allowOutsideCwd && !isWithinBase) {
    throw new Error(
      `Agent cwd must stay within Pi's cwd (${baseRealPath}). Set security.allowOutsideCwd in the global config to opt in.`,
    );
  }
  return candidateRealPath;
}

async function readOptionalConfig(path: string): Promise<PartialBridgeConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return {};
    throw new Error(`Could not read ${path}`, { cause: error });
  }

  try {
    return Parse(PartialBridgeConfigSchema, JSON.parse(text));
  } catch (error) {
    throw new Error(`Invalid pi-agent-bridge config at ${path}: ${errorMessage(error)}`, { cause: error });
  }
}

function mergeConfig(
  defaults: BridgeConfig,
  globalConfig: PartialBridgeConfig,
  projectConfig: PartialBridgeConfig,
): BridgeConfig {
  const globalDefaults = { ...defaults.defaults, ...globalConfig.defaults };
  const globalCodex: CodexRuntimeConfig = { ...defaults.codex, ...globalConfig.codex };
  const globalClaude: ClaudeRuntimeConfig = { ...defaults.claude, ...globalConfig.claude };
  const projectCodex = projectConfig.codex;
  const projectClaude = projectConfig.claude;

  const codex: CodexRuntimeConfig = {
    ...globalCodex,
    enabled: globalCodex.enabled && projectCodex?.enabled !== false,
  };
  if (projectCodex?.model) codex.model = projectCodex.model;

  const claude: ClaudeRuntimeConfig = {
    ...globalClaude,
    enabled: globalClaude.enabled && projectClaude?.enabled !== false,
    maxTurns: Math.min(globalClaude.maxTurns, projectClaude?.maxTurns ?? globalClaude.maxTurns),
  };
  if (projectClaude?.model) claude.model = projectClaude.model;
  const maxBudgetUsd = minimumBudget(globalClaude.maxBudgetUsd, projectClaude?.maxBudgetUsd);
  if (maxBudgetUsd !== undefined) claude.maxBudgetUsd = maxBudgetUsd;

  return {
    defaults: {
      permissions: mostRestrictivePermission(globalDefaults.permissions, projectConfig.defaults?.permissions),
    },
    // Executable selection and filesystem expansion are user-level decisions. A repository cannot opt itself in.
    security: { ...defaults.security, ...globalConfig.security },
    codex,
    claude,
  };
}

function validateConfig(config: BridgeConfig): void {
  if (!config.codex.command.trim()) throw new Error("codex.command must not be empty");
  if (config.codex.model !== undefined && !config.codex.model.trim()) {
    throw new Error("codex.model must not be empty");
  }
  if (config.claude.pathToClaudeCodeExecutable !== undefined) {
    if (!config.claude.pathToClaudeCodeExecutable.trim()) {
      throw new Error("claude.pathToClaudeCodeExecutable must not be empty");
    }
  }
  if (config.claude.model !== undefined && !config.claude.model.trim()) {
    throw new Error("claude.model must not be empty");
  }
}

function mostRestrictivePermission(
  userPermission: ExternalAgentPermissionMode,
  projectPermission: ExternalAgentPermissionMode | undefined,
): ExternalAgentPermissionMode {
  if (!projectPermission) return userPermission;
  const rank = {
    "read-only": 0,
    "workspace-write": 1,
    "full-access": 2,
  } satisfies Record<ExternalAgentPermissionMode, number>;
  return rank[projectPermission] < rank[userPermission] ? projectPermission : userPermission;
}

function minimumBudget(
  userBudget: number | undefined,
  projectBudget: number | undefined,
): number | undefined {
  if (userBudget === undefined) return projectBudget;
  if (projectBudget === undefined) return userBudget;
  return Math.min(userBudget, projectBudget);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
