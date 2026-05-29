# Changelog

All notable changes to the **Xiaomi MiMo Copilot Chat** extension are documented here.

Forked from [opencode-copilot-chat](https://github.com/ltmoerdani/opencode-copilot-chat).

## Unreleased

### Fixed

- Corrected MiMo model IDs to Xiaomi's lowercase API identifiers and filtered the live model list to chat-capable MiMo models.
- Reused the SecretStorage API key when VS Code does not pass provider configuration into model discovery or chat requests.
- Quieted routine request/model metadata output by default behind the `xiaomi-mimo.debugLogging` setting.

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
