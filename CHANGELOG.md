# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project intends to use [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial Pi package scaffold with `codex_agent` and `claude_agent` tools.
- Provider-independent external-agent lifecycle and lazy adapter pool.
- Codex app-server JSONL RPC adapter with streaming, approvals, resume, interruption, and cleanup.
- Claude Agent SDK adapter with streaming, permission profiles, resume, cancellation, limits, and usage.
- Trusted configuration loading, cwd containment, bounded output, and fail-closed approvals.
- Unit, adapter-contract, package-content, and real Pi loader/session smoke tests.
- Architecture, ADR, security, contribution, lifecycle, and release documentation.
