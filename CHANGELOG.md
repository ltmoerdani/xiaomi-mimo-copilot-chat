# Changelog

All notable changes to the **Xiaomi MiMo Copilot Chat** extension are documented here.

Forked from [opencode-copilot-chat](https://github.com/ltmoerdani/opencode-copilot-chat).

## [0.1.2] — 2026-05-30

### Fixed

- **Phased timeout architecture** — replaced the single 10-minute wall timeout with a two-phase approach:
  - **60s connection timeout** — fails fast if the MiMo server is unreachable (previously could hang for 10 minutes).
  - **5 min overall timeout** — reduced from 10 minutes (MiMo is consistently <2s TTFB).
  - **90s stream idle timeout** — reduced from 2 minutes to detect stalled streams sooner.
- **Auto-retry on transient connection errors** — requests automatically retry once (with 1s backoff) on `ECONNRESET`, `ECONNREFUSED`, socket hang up, and other recoverable network errors.
- **Improved timeout error messages** — now indicates whether the failure occurred during the "connection" or "streaming" phase, with actionable suggestions.
- Corrected MiMo model IDs to Xiaomi's lowercase API identifiers and filtered the live model list to chat-capable MiMo models.
- Reused the SecretStorage API key when VS Code does not pass provider configuration into model discovery or chat requests.
- Quieted routine request/model metadata output by default behind the `xiaomi-mimo.debugLogging` setting.

### Changed

- Default `requestTimeoutSeconds`: `600` → `300` (minimum raised to 30s).
- Default `streamIdleTimeoutSeconds`: `120` → `90` (minimum raised to 10s).

## [0.1.0] — 2026-05-27

### Added

- Forked from [opencode-copilot-chat](https://github.com/ltmoerdani/opencode-copilot-chat) and adapted for Xiaomi MiMo AI models.
- MiMo provider registration with Xiaomi API endpoint (`https://token-plan-sgp.xiaomimimo.com/v1`).
- Simplified transport layer — all models route through OpenAI-compatible `/chat/completions`.
- Updated bundled model catalog to MiMo models only: `mimo-v2.5` and `mimo-v2.5-pro`.
- Updated all VS Code settings to `xiaomi-mimo.*` prefix.
- Updated all commands to `MiMo:*`.
- Removed unused features from upstream: dual-provider architecture, Anthropic/Google transports, TTL-cached models.dev snapshot, experimental context indicator, `freeOnly` toggle, debug reasoning output.
- Cleaned up codebase: removed unused test files, simplified auth headers, simplified routing logic.
