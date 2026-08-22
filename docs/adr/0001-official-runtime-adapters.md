# ADR 0001: Bridge official agent runtimes

- Status: Accepted
- Date: 2026-08-22

## Context

Pi can expose custom tools and subagent workflows, but reimplementing Codex or Claude Code would duplicate authentication, session storage, tool execution, approvals, streaming protocols, and rapidly changing runtime behavior. T3 Code demonstrates that official runtime integration is a more sustainable boundary.

The providers do not expose identical lifecycle APIs. Codex app-server eagerly creates threads and uses bidirectional JSONL RPC. The Claude TypeScript SDK starts a subprocess per `query()` call and may not allocate a native session ID until output begins.

## Decision

Create a provider-independent `ExternalAgent` contract with `start`, `resume`, `prompt`, `cancel`, and `close`. Allow `start` to return a bridge-local session before a provider-native ID exists; `prompt` returns the updated session with `runtimeSessionId`.

Implement:

- Codex through the official `codex app-server` stdio transport;
- Claude through the official `@anthropic-ai/claude-agent-sdk` package;
- Pi-specific tools, rendering/progress, approval UI, and shutdown outside the core; and
- provider-native session IDs as the persistence/resume boundary for the initial release.

## Consequences

### Positive

- Authentication and subscriptions remain with official CLIs.
- Native tools and runtime behavior are preserved.
- New providers can implement a bounded contract.
- Pi remains the primary agent and controls delegation UX.
- Provider protocol changes are isolated to adapters.

### Negative

- Normalized behavior cannot erase provider differences.
- Codex's version-specific app-server schema needs ongoing compatibility work.
- Native session IDs are less friendly than a bridge-owned catalog.
- Two official dependencies have different process and approval semantics.

## Alternatives considered

### Reimplement agent loops over model APIs

Rejected. This would not preserve official CLI behavior, subscription authentication, native tools, or sessions, and would create a large maintenance surface.

### Shell out to one-shot CLI print modes only

Rejected as the primary design. It is easy to bootstrap but loses structured sessions, progress, cancellation, approvals, and provider-native events.

### Expose provider protocols directly as Pi tools

Rejected. Pi tool schemas and orchestration would become coupled to each provider and future adapters would not share lifecycle or security handling.

## Follow-up

Revisit this ADR if an official runtime removes session control, if a common runtime protocol becomes stable across providers, or if evidence shows that native-ID persistence cannot support reliable resume.
