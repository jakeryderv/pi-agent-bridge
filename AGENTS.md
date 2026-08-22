# Project agent instructions

## Scope

`pi-agent-bridge` is a Pi package that delegates work to official coding-agent runtimes. Pi-specific lifecycle/UI code belongs in `src/extension.ts`; provider-neutral contracts belong in `src/core`; provider protocols belong under `src/adapters/<provider>`.

## Required workflow

- Read `README.md`, `docs/architecture.md`, and relevant ADRs before cross-cutting changes.
- Inspect current Pi and official runtime documentation/types before changing integrations.
- State acceptance criteria and security/documentation impact for non-trivial work.
- Add behavior and focused fixture-backed tests together.
- Do not start processes during extension factory execution.
- Propagate abort signals and keep cleanup idempotent.
- Fail closed on unknown approvals, requests, or trust state.
- Keep model-visible output bounded.
- Do not rely on host credentials, host-installed third-party CLIs, or third-party network calls in tests.

## Standard gates

```bash
npm run check
npm run security:audit
npm run smoke:pi
```

Report each as Pass, Fail, or Skip with fresh evidence. See `docs/development-lifecycle.md`.
