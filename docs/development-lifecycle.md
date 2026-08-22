# Development lifecycle

This project uses a lightweight software engineering lifecycle. Ceremony should match the size and reversibility of a change, but every change must remain understandable, verifiable, and traceable.

## Lifecycle stages

| Stage | Purpose | Typical output or gate |
| --- | --- | --- |
| Understand | Inspect the request, code, constraints, prior decisions, and repository state. | Scope and relevant context. |
| Plan | Define the intended change and acceptance criteria. | Short plan, issue, or pull request description. |
| Design | Choose an approach and evaluate trade-offs. | Design note; ADR for significant durable decisions. |
| Implement | Make a minimal, coherent change. | Source, configuration, or content diff. |
| Verify | Run static analysis, tests, package checks, smoke tests, and security checks. | Structured pass/fail/skip evidence. |
| Review | Compare the diff with requirements, architecture, security boundaries, and risks. | Human or agent review findings. |
| Document | Update user, API, architecture, operations, security, or release documentation. | Applicable documentation changes. |
| Deliver | Commit, open a pull request, merge, package, or release. | Traceable delivery record. |
| Operate and learn | Observe outcomes and feed issues back into planning. | Metrics, incidents, and follow-up work. |

Documentation and security are cross-cutting concerns. A failed verification or review returns the work to planning, design, or implementation as appropriate.

## Understand

Before changing the repository:

- Read the request and relevant project documentation.
- Inspect the working tree and existing implementation.
- Identify constraints from Pi, Node.js, packaging, supported platforms, and project trust.
- Inspect current official Codex and Claude API/types when adapter behavior changes.
- Separate known facts from assumptions requiring verification.

## Plan

State:

- the behavior or outcome being changed;
- what is in and out of scope;
- acceptance criteria that can be checked; and
- expected security and documentation impact.

A small change may keep this plan in its pull request description. Larger work should use a linked issue.

## Design

Use the simplest design that meets the acceptance criteria. Create an ADR only when a decision is durable, cross-cutting, costly to reverse, or likely to be questioned later. Routine implementation choices do not need ADRs.

Preserve these boundaries:

- Pi lifecycle, trust, UI, and rendering belong in the extension layer.
- Provider-independent lifecycle and data belong in `src/core`.
- Official protocol behavior belongs in the corresponding adapter.
- Provider-specific protocol objects should not become public Pi tool inputs.

## Implement

Keep the diff minimal and internally coherent:

- Add behavior and tests together.
- Avoid speculative modules or abstractions without a current caller.
- Keep Pi-specific lifecycle and rendering logic out of the agent-independent runtime.
- Do not mix unrelated cleanup into a feature change.
- Start subprocesses lazily, never during extension factory execution.
- Propagate cancellation to blocking I/O and clean resources idempotently.

## Verify

The standard local gate is:

```bash
npm run check
npm run security:audit
npm run smoke:pi
```

Report every applicable check as:

| Result | Meaning |
| --- | --- |
| Pass | The command ran successfully and its result was inspected. |
| Fail | The command ran and found a blocking problem. |
| Skip | The check was inapplicable or could not run; include the reason and follow-up. |

Do not claim a build, test, or check passes without fresh command output. Feature changes should add focused tests capable of falsifying their acceptance criteria.

`npm run smoke:pi` must use a real `DefaultResourceLoader` and session binding. It must invoke applicable controlled tools without model access, credentials, or third-party network calls, and prove that startup/tool execution leaves controlled version/help/manpage markers untouched. `cli_docs` is not currently a tool in this package; if one is added, the smoke must invoke it rather than relying on a print-mode notification.

Adapter or registry expansion must load actual bundled definitions and use controlled fixtures for every bundled candidate. Tests must not depend on host-installed third-party CLIs, credentials, or third-party CLI network behavior. Dependency installation, audit, and package-install smoke steps may contact the package registry.

## Review

Review the final diff for:

- alignment with the request and acceptance criteria;
- unintended behavior or unrelated changes;
- error, cancellation, timeout, and cleanup paths;
- shell, PATH, environment, credential, filesystem, network, and prompt-injection risks;
- approval routing and fail-closed behavior;
- test quality and missing edge cases;
- package contents and runtime dependency placement; and
- documentation and migration impact.

Review findings may return the change to an earlier lifecycle stage.

## Document

For every change, explicitly consider:

- README or user-facing behavior;
- public types or API contracts;
- architecture and ADRs;
- security and trust boundaries;
- development and operational procedures; and
- release notes or migration guidance.

“No documentation change” is acceptable only when it is a considered result.

## Deliver

Prefer a focused branch and pull request with:

- a concise summary;
- linked acceptance criteria or issue;
- verification evidence;
- security and documentation impact; and
- residual risks and follow-up work.

Commits should describe intent. Releases and published packages require the separate [release process](releasing.md); passing normal CI is necessary but not sufficient to publish.

## Operate and learn

After delivery, observe CI reliability, dependency updates, package installation, Pi loading, native session resume, cancellations, approvals, and real CLI behavior. Record actionable findings as issues. Update an ADR when evidence invalidates a previous decision rather than silently diverging from it.
