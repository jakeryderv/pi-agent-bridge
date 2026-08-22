# Architecture

## Goal

`pi-agent-bridge` makes official coding-agent runtimes available as delegated Pi tools without absorbing their agent loops into Pi. Pi owns orchestration; each external runtime keeps responsibility for its authentication, prompts, model protocol, tools, native persistence, and execution semantics.

## Boundaries

```text
Pi extension boundary
├── tool schemas and descriptions
├── Pi TUI approval callback
├── progress/result conversion
├── output truncation and temporary-file preservation
└── Pi session shutdown cleanup

Provider-neutral core
├── ExternalAgent lifecycle
├── normalized sessions, events, results, and errors
└── lazy adapter pool

Provider adapters
├── CodexAdapter → CodexJsonlRpcClient → codex app-server
└── ClaudeAdapter → @anthropic-ai/claude-agent-sdk
```

Pi-specific context and rendering do not enter the provider-neutral core. Provider-native protocol objects do not leak into Pi tool contracts except for opaque native session IDs.

## Lifecycle

### Start and prompt

1. Pi invokes `codex_agent` or `claude_agent`.
2. The extension loads user configuration and, if trusted, restricted project configuration.
3. The requested cwd is resolved through real paths and checked against Pi's cwd.
4. The adapter pool lazily creates an adapter for the selected runtime configuration.
5. `start()` allocates a new bridge session. Codex eagerly starts a native thread; Claude allocates its native session on first query.
6. `prompt()` streams normalized events into Pi's `onUpdate` callback.
7. The result returns the native session ID in tool details for later resume.

### Resume

The tool accepts a provider-native `sessionId`. `CodexAdapter` sends `thread/resume`; `ClaudeAdapter` passes `resume` to the SDK. The official runtime remains the persistence authority. The bridge does not copy or reinterpret runtime transcript files.

### Cancellation and shutdown

- Pi's tool abort signal triggers Codex `turn/interrupt` or a Claude SDK `AbortController`.
- One active turn/query is allowed per bridge session object.
- Pi `session_shutdown` closes every lazily created adapter.
- Adapter factories start no processes during extension import or factory execution.

## Permission model

The normalized permission profile is intentionally small:

- `read-only`: deny mutations at the strongest provider-supported boundary.
- `workspace-write`: allow work in the selected workspace and route provider approval requests to Pi.
- `full-access`: explicitly bypass runtime permission checks.

The abstraction describes intent, not identical provider mechanics. Mapping differences are documented in the README and covered by adapter tests.

Permission requests fail closed when:

- no Pi UI is available;
- no approval handler is registered for the active turn;
- an app-server request method is not supported; or
- the request cannot be correlated to an active turn.

## Configuration trust

User and trusted-project configuration have different authority.

User configuration may select executable paths, process arguments, filesystem escape policy, defaults, and limits. Project configuration may choose models and tighten permissions/limits, but cannot:

- replace an executable;
- add process arguments;
- re-enable a provider disabled by the user;
- expand cwd access;
- elevate permission mode; or
- raise a user-defined turn or budget ceiling.

## Output handling

External agent output is untrusted and potentially large. Pi receives a normalized text result capped by Pi's standard 2,000-line / 50 KB limits. When truncated, the complete output is written to a mode-0600 file in a private temporary directory and the path is returned.

Tool progress is separately capped to 100 lines / 8 KB and throttled to avoid a Pi update for every token.

## Extension points

A new provider implements `ExternalAgent` and adds a tool registration plus configuration shape. It should preserve:

- lazy startup;
- native auth and persistence;
- abort-aware blocking I/O;
- fail-closed approvals;
- cwd containment;
- bounded output;
- fixture-backed contract tests; and
- idempotent cleanup.

Avoid adding provider-specific conditionals to the core unless at least two adapters need the concept.

## Known gaps

- Session discovery is native-ID based; there is no bridge-owned catalog yet.
- Codex user-input and dynamic-tool server requests are rejected as unsupported.
- Claude `AskUserQuestion` is disabled until Pi can return structured answers safely.
- Normalized usage is currently available from Claude but not Codex.
- The initial Codex protocol types are a deliberately small compatibility surface rather than a vendored generated schema.
