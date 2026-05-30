# 🚀 Xiaomi MiMo GitHub Copilot Chat

> **Use [MiMo](https://xiaomimimo.com) AI models directly in GitHub Copilot Chat — no Copilot Pro/Enterprise subscription needed. Just bring your own API key (BYOK).**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-1.120%2B-blue)](https://code.visualstudio.com/)
[![MiMo](https://img.shields.io/badge/MiMo-V2.5-orange)](https://xiaomimimo.com)
[![CI](https://github.com/ltmoerdani/xiaomi-mimo-copilot-chat/actions/workflows/ci.yml/badge.svg)](https://github.com/ltmoerdani/xiaomi-mimo-copilot-chat/actions/workflows/ci.yml)
[![Stars](https://img.shields.io/github/stars/ltmoerdani/xiaomi-mimo-copilot-chat?style=social)](https://github.com/ltmoerdani/xiaomi-mimo-copilot-chat/stargazers)
[![Issues](https://img.shields.io/github/issues/ltmoerdani/xiaomi-mimo-copilot-chat)](https://github.com/ltmoerdani/xiaomi-mimo-copilot-chat/issues)
[![Last Commit](https://img.shields.io/github/last-commit/ltmoerdani/xiaomi-mimo-copilot-chat)](https://github.com/ltmoerdani/xiaomi-mimo-copilot-chat/commits/main)

---

## 💡 What Is This?

**Xiaomi MiMo GitHub Copilot Chat** is a free, open-source VS Code extension that brings [Xiaomi MiMo](https://xiaomimimo.com) AI models into **GitHub Copilot Chat** via the official VS Code *Language Model Chat Provider API*.

### Why Xiaomi MiMo GitHub Copilot Chat?

- 🔑 **No Copilot Pro/Enterprise needed** — just sign in with a free GitHub account
- 💰 **BYOK (Bring Your Own Key)** — pay only for what you use on Xiaomi's token plan
- ⚡ **MiMo V2.5** — 1M token context window, top-tier performance at fraction of the cost
- 🧩 **Seamless integration** — appears in the Copilot Chat model picker like GPT-4 or Claude
- 🛡️ **Private & secure** — API key stored locally via VS Code SecretStorage, no telemetry

| Provider | Cost | Example Models |
|---|---|---|
| **MiMo** | Paid (token plan) | `mimo-v2.5`, `mimo-v2.5-pro` |

---

## ✨ Features

- **BYOK** — configure MiMo with your Xiaomi API key
- **Live model list** — fetches available models directly from MiMo API on every startup
- **Bundled fallback** — keeps the picker usable offline with an internal fallback catalog when live metadata cannot be refreshed
- **Tool-calling support** — forwards tool schemas using the OAI-compatible request shape
- **Native transport** — all models use OpenAI-compatible `/chat/completions` endpoint
- **Safer requests** — adds request and stream idle timeouts with clearer rate-limit/quota errors in VS Code
- **Diagnostics command** — one-click markdown report showing exactly which models VS Code has registered plus recent request summaries
- **Usage status bar** — shows the latest prompt/output/total/cache summary after each MiMo response

---

## Requirements

- VS Code **1.120.0** or higher with the Language Model Chat Provider API
- **GitHub Copilot Chat** extension — [install from marketplace](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot-chat) (required — this extension only adds models *into* Copilot Chat)
- Sign in to GitHub Copilot Chat (a personal GitHub account is sufficient — **no** Copilot Pro/Enterprise needed for BYOK)
- A **MiMo API key** — get one from [Xiaomi MiMo](https://xiaomimimo.com)

---

## ⚡ Quick Start

1. Install **GitHub Copilot Chat** from the marketplace if you haven't already.
2. Install this extension (or press `F5` in the repo to launch an Extension Development Host).
3. Open **GitHub Copilot Chat** (click the Copilot icon in the sidebar or press `Cmd+Shift+I` / `Ctrl+Shift+I`).
4. Click the **model picker** (current model name) → **Manage Models…**
5. Select **MiMo**.
6. Press `Enter` to accept the default **Group Name**.
7. Enter your MiMo **API Key** when prompted — VS Code stores it securely as a secret.
8. Choose the models you want available.
9. Select any MiMo model from the picker and start chatting.

> **💡 Tip:** Registered models are automatically available in the Copilot Chat model picker — no extra setup needed. If a model appears in the **Language Models** view but not in the chat picker, hover its row and click the eye icon (👁) to enable visibility.

---

## Commands

Once installed, MiMo models appear directly in the **GitHub Copilot Chat model picker** — no special commands needed. The easiest way to manage your API key is via **Settings → Language Models** (gear icon ⚙).

For advanced usage, you can also run these commands via the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`):

| Command | Description |
|---|---|
| `MiMo: Manage Provider` | Manage API key, refresh models, or test connection |
| `MiMo: Set API Key` | Store or update your MiMo API key |
| `MiMo: Diagnostics` | Show a markdown report of registered MiMo models and recent request summaries |

> **Note:** The native BYOK flow via **Language Models** (gear icon ⚙) is recommended. VS Code will ask for a group name, then the matching API key.

---

## Settings

| Setting | Type | Default | Description |
|---|---|---|---|
| `xiaomi-mimo.temperature` | `number` | `0.2` | Sampling temperature for chat completions (`0`–`2`) |
| `xiaomi-mimo.maxTokens` | `number` | `0` | Max output token override — `0` uses the per-model bundled maximum |
| `xiaomi-mimo.maxInputTokens` | `number` | `0` | Context window override — `0` uses the per-model bundled context size |
| `xiaomi-mimo.requestTimeoutSeconds` | `number` | `600` | Total request timeout for MiMo API calls |
| `xiaomi-mimo.streamIdleTimeoutSeconds` | `number` | `120` | Cancels a request if the response stream stops sending chunks for too long |
| `xiaomi-mimo.debugLogging` | `boolean` | `false` | Write verbose transport and model registration diagnostics to the MiMo output channel |
| `xiaomi-mimo.showUsageStatusBar` | `boolean` | `true` | Show the latest MiMo usage summary in the VS Code status bar |

---

## Models

The extension fetches the live model list from:

```
https://token-plan-sgp.xiaomimimo.com/v1/models
```

### Bundled model limits

| Model | Context window | Max output tokens |
|---|---:|---:|
| `mimo-v2.5` | 1,000,000 | 128,000 |
| `mimo-v2.5-pro` | 1,048,576 | 128,000 |

### Endpoint routing

All models use the OpenAI-compatible chat completions endpoint:

```
https://token-plan-sgp.xiaomimimo.com/v1/chat/completions
```

---

## Development

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Watch mode
npm run watch
```

Press `F5` in VS Code to launch an **Extension Development Host** with the extension loaded.

To package a `.vsix` for local install:

```bash
npm run package
```

---

## Contributing

Issues and pull requests are welcome. Please see [CONTRIBUTING.md](.github/CONTRIBUTING.md) for details.

---

## ⭐ Star History

If you find this useful, please ⭐ star the repo — it helps others discover it!

[![Star History Chart](https://api.star-history.com/svg?repos=ltmoerdani/xiaomi-mimo-copilot-chat&type=Date)](https://star-history.com/#ltmoerdani/xiaomi-mimo-copilot-chat&Date)

---

## 📄 License

MIT — see [LICENSE](./LICENSE) for details.

---

<p align="center">
  <strong>Made with ❤️ by <a href="https://github.com/ltmoerdani">ltmoerdani</a></strong><br/>
  <em>If this helps you, consider giving it a ⭐!</em>
</p>
