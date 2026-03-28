# Spec 26 — Model Switch Command

> Status: **Implemented** | Owner: — | Last updated: 2026-03-28

## Problem

When using Ollama (or Anthropic), the active model is set at startup via environment variables (`OLLAMA_MODEL` / `MODEL`) and frozen in `config.js`. Switching models requires editing `.env` and restarting the process. This is cumbersome when experimenting with different models during a conversation.

## Design

### Command syntax

| Command | Behavior |
|---------|----------|
| `/model` | Display the current model name |
| `/model <name>` | Switch the active model to `<name>` |

### Handling

The `/model` command is handled by `CommandRouter` — the same component that handles `/new`, `/approve`, `/agent`. It is intercepted before reaching the LLM pipeline, so no tokens are consumed.

### Runtime model change

`LLMProvider` (base class) gains two methods:

```js
getModel()   // returns this.model
setModel(name)  // sets this.model
```

Both `OllamaProvider` and `AnthropicProvider` already store the model as `this.model` and reference it in `createMessage()` / `streamMessage()`. Changing `this.model` immediately affects subsequent LLM calls with no further plumbing needed.

### No model validation

The command does **not** verify whether the model exists on the Ollama server or Anthropic API. The next LLM call will surface any errors naturally. This avoids async API calls in the synchronous command path.

### Persistence

The model switch itself is ephemeral — it lives only in the provider's instance property. A restart reverts to the configured default. However, the command exchange (user command + bot response) is persisted to conversation history so the agent retains context about the change. The active model name is also injected into the system prompt. See [Spec 27](27-command-context-persistence.md).

## Affected Components

| Component | Change |
|-----------|--------|
| `src/brain/llm-provider.js` | Add `getModel()` and `setModel()` |
| `src/core/command-router.js` | Add `/model` routing and `_handleModel()` handler |

No changes to `OllamaProvider`, `AnthropicProvider`, `index.js`, or the database.

## Data Model

No database changes.
