# Changelog

All notable changes to the **Xiaomi MiMo Copilot Chat** extension are documented here.

Forked from [opencode-copilot-chat](https://github.com/ltmoerdani/opencode-copilot-chat).

## [0.1.3] — 2026-06-14

### Fixed

- **Model list fetch errors no longer spam notifications** — when the MiMo API key is invalid/expired (401) or the model list endpoint is unreachable, the error is now silently logged to the **MiMo Output Channel** during background fetches instead of showing a popup every time the chat panel loads.
- The popup notification is now reserved for **manual refresh only** (via the *Refresh Models* command), so users are still alerted when they explicitly request a refresh.
- Runtime chat request errors (sent during an actual conversation) are unchanged — they continue to surface immediately as before.
- **Robust stream abort mechanism** — `abort()` now also calls `reader.cancel()` directly as a fallback. In Electron/Node.js fetch, `controller.abort()` on an already-received response body sometimes does not propagate to the stream reader, leaving `reader.read()` stuck forever. The explicit cancel guarantees the stuck read is unblocked.
- **First-event timeout (90s)** — a dedicated timer fires when the server returns `200 OK` with `text/event-stream` but never sends any SSE data. This catches the "server accepted the request but silently stalled" case faster than waiting for the stream idle timeout (which may never fire if `reader.read()` is stuck).
- **Default request timeout reduced from 300s to 120s** — users now wait a maximum of 2 minutes before a failing request surfaces an error, down from 5 minutes.
- **Removed speculative error messages** — timeout errors no longer claim "this often happens with large conversation context — try continuing in a new chat". They report facts only (duration and phase), avoiding misleading users about the root cause.
- **Smart retry with body pruning on empty-stream timeout** — when the server accepts a request but sends no data (detected via first-event or stream-idle timeout), the extension automatically retries once with a pruned payload body. Older messages are trimmed (keeping ~50% most recent plus any system prompt), which often resolves silent server drops without requiring the user to manually start a new chat. Compatible with OpenAI Chat, Anthropic Messages, Google GenerateContent, and Responses API body formats.

### Changed

- `DEFAULT_REQUEST_TIMEOUT_MS`: `300000` → `120000` (2 minutes).

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
