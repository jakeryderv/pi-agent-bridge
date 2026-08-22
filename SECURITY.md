# Security policy

## Supported versions

Before the first stable release, security fixes are applied to the latest published version and the `main` branch.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability reporting for `jakeryderv/pi-agent-bridge` when available. Include:

- affected version or commit;
- runtime and platform versions;
- reproduction steps;
- expected and observed permission boundary; and
- potential impact.

## Trust model

This package is a Pi extension and therefore runs with the user's operating-system permissions. External Codex and Claude processes can read files, execute commands, modify the working tree, access the network, and use credentials according to their runtime policies.

The bridge does not parse or store Codex or Claude credentials. Official runtimes discover their own existing login state. The Claude subprocess inherits the host environment; Codex inherits the environment used to launch Pi. Codex app-server may record a cwd as trusted in Codex's own configuration when starting a workspace-write or full-access thread; this is native app-server behavior rather than bridge-owned state.

Treat all of the following as trusted code or configuration:

- the installed Pi package;
- executable overrides and process arguments in user configuration;
- the resolved `codex` or Claude executable on `PATH`;
- official runtime updates; and
- project-local Pi resources after approving project trust.

## Security invariants

- Runtime processes start only in response to a tool call.
- Project config cannot replace executables, add process arguments, expand cwd access, re-enable disabled providers, or elevate permission/limit defaults.
- Requested working directories resolve through real paths and remain inside Pi's cwd by default.
- Approval requests fail closed without an interactive Pi UI or recognized active turn.
- `full-access` requires an explicit tool argument or user-level default.
- Unsupported bidirectional runtime requests receive an error rather than implicit approval.
- Cancellation and Pi shutdown attempt to stop active runtime work.
- Tool output is bounded; preserved full output uses a private temporary directory and mode-0600 file.
- Config parsing validates accepted value types before use.

## Prompt injection

External agents process repository content and may encounter malicious instructions. Pi should delegate bounded tasks, use the least privilege that meets the task, and review resulting diffs. Do not treat an external agent's text or tool request as authorization from the user.

## Credential and environment guidance

- Do not place tokens in `pi-agent-bridge.json`, prompts, tool arguments, or issue reports.
- Prefer official `codex login` and `claude auth login` flows.
- Use absolute executable overrides in user configuration when PATH integrity is uncertain.
- Keep `security.allowOutsideCwd` disabled unless cross-worktree access is necessary.
- Avoid `full-access` for untrusted repositories or delegated review tasks.

## Dependency and protocol risk

The bridge executes official runtime packages and CLIs that evolve independently. Dependency changes and Codex schema changes require focused contract tests, `npm audit`, package-content review, and real-runtime validation before release.
