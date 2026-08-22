# Contributing

## Setup

Requirements:

- Node.js 22.19 or newer;
- npm 11 or newer; and
- Pi 0.84.2 or newer for local package smoke tests.

```bash
git clone https://github.com/jakeryderv/pi-agent-bridge.git
cd pi-agent-bridge
npm install
npm run check
npm run security:audit
npm run smoke:pi
```

## Workflow

1. Open or link an issue for non-trivial work.
2. State acceptance criteria and security/documentation impact.
3. Create a focused branch.
4. Keep provider-neutral, provider-specific, and Pi-specific concerns in their documented layers.
5. Add focused tests with controlled runtime fixtures.
6. Run the standard gates and record pass/fail/skip evidence in the pull request.
7. Review the package contents and final diff before requesting review.

See [Development lifecycle](docs/development-lifecycle.md).

## Coding conventions

- Strict TypeScript and ESM (`NodeNext`).
- Explicit `.js` suffixes for relative imports so compiled ESM works in Node.
- Abort-aware process and SDK operations.
- Fail-closed approvals and permission handling.
- No subprocess startup during extension factory execution.
- No unbounded model-visible output.
- No host credentials, third-party network access, or installed third-party CLIs in tests.
- Public API changes require documentation and a changelog entry.
- Cross-cutting durable decisions require an ADR under `docs/adr/`.

## Verification

```bash
npm run check          # format, lint, types, tests, build, package contents
npm run security:audit # production dependency audit
npm run smoke:pi       # real Pi loader/session binding with controlled adapters
```

A skipped check needs a reason and follow-up owner. Do not report a check as passing without fresh output.

## Pull requests

Keep pull requests focused. Include:

- summary and motivation;
- acceptance criteria;
- verification evidence;
- security and trust-boundary impact;
- documentation impact; and
- residual risks or follow-up work.

Do not combine unrelated formatting or cleanup with a feature.
