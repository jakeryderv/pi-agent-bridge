# pi-agent-bridge

[![CI](https://github.com/jakeryderv/pi-agent-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/jakeryderv/pi-agent-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

`pi-agent-bridge` is a [Pi](https://pi.dev) extension that lets Pi delegate work to official external coding-agent runtimes while Pi remains the primary orchestrator.

```text
Pi
└── pi-agent-bridge
    ├── codex_agent  → codex app-server → Codex / ChatGPT subscription
    └── claude_agent → Claude Agent SDK → Claude Code / Claude subscription
```

The project follows the same central idea demonstrated by T3 Code: integrate the official runtimes instead of reimplementing their agent loops, tools, authentication, or session formats.

> [!IMPORTANT]
> This repository currently provides a runnable foundation, not the complete long-term MVP. The adapter boundary, both Pi tools, native session resume, streaming, cancellation, permission mapping, fixture tests, and packaging are present. A bridge-level session catalog and richer interactive request handling remain roadmap work.

## Current capabilities

- `codex_agent` backed by `codex app-server` over JSONL RPC on stdin/stdout.
- `claude_agent` backed by `@anthropic-ai/claude-agent-sdk`.
- Existing `codex login` and `claude auth login` credentials remain owned by the official runtimes.
- Native Codex thread IDs and Claude session IDs are returned for later resume.
- Text and tool progress stream into Pi tool updates.
- Pi cancellation propagates to Codex `turn/interrupt` or the Claude SDK abort controller.
- Three explicit permission profiles: `read-only`, `workspace-write`, and `full-access`.
- TUI approval requests fail closed when Pi has no interactive UI.
- Agent working directories are restricted to Pi's current working tree by default.
- Pi tool output uses Pi's standard 2,000-line / 50 KB limit and preserves larger output in a private temporary file.
- Runtime-neutral core types are separated from Pi extension registration and rendering.

## Requirements

- Node.js 22.19 or newer (matching current Pi requirements).
- Pi 0.84.2 or newer.
- For Codex delegation: the official `codex` CLI, authenticated with `codex login`.
- For Claude delegation: Claude Agent SDK dependencies installed with this package. Existing Claude Code authentication can be established with `claude auth login`.

The current Codex contract tests target the stable stdio API exposed by Codex CLI 0.149.0. App-server schemas are version-specific; compatibility with newer versions is verified through CI fixtures and should be checked against the generated schema when protocol fields change.

## Install

### From this checkout

```bash
npm install
npm run build
pi -e .
```

To install the checkout as a persistent Pi package:

```bash
pi install ./
```

### From npm (after the first release)

```bash
pi install npm:@jakeryderv/pi-agent-bridge
```

Pi package installs use production dependencies. Pi's bundled packages are declared as peers; the Claude Agent SDK and its runtime dependencies are regular production dependencies.

## Use

Pi receives two tools after the extension loads:

```text
codex_agent({
  prompt: "Implement the parser and run its focused tests",
  permissions: "workspace-write"
})
```

```text
claude_agent({
  prompt: "Review this implementation for cancellation and cleanup bugs",
  permissions: "read-only",
  maxTurns: 12
})
```

Continue a native runtime session by passing the returned `sessionId`:

```text
codex_agent({
  sessionId: "<thread-id>",
  prompt: "Address the review findings"
})
```

Tool parameters:

| Parameter | Providers | Meaning |
| --- | --- | --- |
| `prompt` | Both | Required delegated task or follow-up. |
| `sessionId` | Both | Native Codex thread ID or Claude session ID to resume. |
| `cwd` | Both | Absolute path or path relative to Pi's cwd. Restricted to Pi's cwd unless the user opts out globally. |
| `model` | Both | Provider-native model override. |
| `permissions` | Both | `read-only`, `workspace-write` (default), or explicit `full-access`. |
| `maxTurns` | Claude | Maximum Claude agent-loop turns. |
| `maxBudgetUsd` | Claude | Maximum estimated spend for one query. |

### Permission behavior

| Bridge mode | Codex | Claude |
| --- | --- | --- |
| `read-only` | Read-only sandbox; runtime approvals remain enabled. | Only `Read`, `Glob`, and `Grep`; permission prompts are denied. |
| `workspace-write` | Workspace-write sandbox with on-request approvals. | Normal Claude permissions; read tools are pre-approved and other requests route through Pi's TUI. |
| `full-access` | Danger-full-access sandbox with approvals disabled. | `bypassPermissions` with the SDK's explicit dangerous-skip flag. |

`full-access` is never selected implicitly by the tool. Project configuration cannot elevate permissions to it.

## Configuration

Configuration is optional. Values are loaded from:

1. `~/.pi/agent/pi-agent-bridge.json`
2. `<project>/.pi/pi-agent-bridge.json`, only after Pi trusts the project
3. Tool-call overrides

Example user configuration:

```json
{
  "defaults": {
    "permissions": "workspace-write"
  },
  "security": {
    "allowOutsideCwd": false
  },
  "codex": {
    "enabled": true,
    "command": "codex",
    "args": ["app-server"],
    "model": "gpt-5.4"
  },
  "claude": {
    "enabled": true,
    "pathToClaudeCodeExecutable": "/absolute/path/to/claude",
    "model": "claude-sonnet-4-6",
    "maxTurns": 30,
    "maxBudgetUsd": 5
  }
}
```

Security-sensitive settings are user-controlled:

- A project config cannot change executable paths or Codex process arguments.
- A project config cannot enable a provider disabled by the user.
- A project config can only make permission, turn, and budget limits more restrictive.
- `security.allowOutsideCwd` is read only from user-level configuration.

Environment overrides:

```bash
PI_AGENT_BRIDGE_CODEX_COMMAND=/absolute/path/to/codex
PI_AGENT_BRIDGE_CLAUDE_PATH=/absolute/path/to/claude
```

## Architecture

The provider-independent contract is intentionally small:

```ts
interface ExternalAgent {
  start(...): Promise<ExternalAgentSession>;
  resume(...): Promise<ExternalAgentSession>;
  prompt(...): Promise<ExternalAgentResult>;
  cancel(...): Promise<void>;
  close(): Promise<void>;
}
```

```text
src/
├── core/                 provider-neutral lifecycle, events, errors, adapter pool
├── adapters/
│   ├── codex/            JSONL RPC client and app-server adapter
│   └── claude/           Claude Agent SDK adapter
├── config.ts             trusted config loading and cwd containment
├── extension.ts          Pi tools, approvals, updates, truncation, shutdown
└── index.ts              Pi package entry point and public exports
```

See [Architecture](docs/architecture.md) and [ADR 0001](docs/adr/0001-official-runtime-adapters.md).

## Development

```bash
npm install
npm run check
npm run security:audit
npm run smoke:pi
```

The smoke test loads the extension through a real `DefaultResourceLoader` and session binding, invokes both tools against controlled adapters, and confirms startup/tool execution leaves controlled version/help/manpage markers untouched. It does not require model access, credentials, or third-party network calls.

See:

- [Contributing](CONTRIBUTING.md)
- [Development lifecycle](docs/development-lifecycle.md)
- [Security policy and trust boundaries](SECURITY.md)
- [Release process](docs/releasing.md)

## Roadmap

- Durable bridge-owned session catalog and friendly session aliases.
- Explicit list, inspect, cancel, close, and archive control tools.
- Rich Codex `requestUserInput` and Claude question/dialog bridging.
- Broader normalized tool, diff, usage, and reasoning events.
- Generated/versioned Codex schema compatibility checks.
- Optional Gemini, OpenCode, Cursor, and other official-runtime adapters.

## License

[MIT](LICENSE)
