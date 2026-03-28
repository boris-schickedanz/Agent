# Spec 27 — Command Context Persistence

> Status: **Implemented** | Owner: — | Last updated: 2026-03-28

## Problem

Host commands (`/model`, `/agent`, `/agent default`) are intercepted by `CommandRouter` before reaching the LLM pipeline. The command exchange (user input + bot response) is emitted directly via `EventBus` and **never persisted to `ConversationMemory`**. On the next user message, the agent loads history that contains no trace of the command, so it cannot reason about state changes.

Example: a user switches models with `/model gpt-4o`, then asks "how do I know the model was really changed?" — the agent responds with "I have no context about which model was changed."

Additionally, the system prompt (`PromptBuilder`) does not include the active model or agent profile name as runtime state, so even if the agent could infer a change, it cannot confirm "I am currently running on model X."

## Design

### 1. Persist command exchanges to conversation history

After a state-changing command is handled, persist both the user's command and the bot's response into `ConversationMemory` so they appear in subsequent history loads.

**Which commands get persisted:**

| Command | Persist? | Reason |
|---------|----------|--------|
| `/model <name>` | Yes | Agent should know which model is active |
| `/model` (query) | Yes | Minor, but keeps conversation coherent |
| `/agent <name>` | Yes | Agent should know its profile changed |
| `/agent default` | Yes | Agent should know profile was reset |
| `/agent list` | No | Informational, no state change |
| `/project <name>` | Yes | Agent should know which project is active |
| `/project` (query) | Yes | Keeps conversation coherent |
| `/project list` | Yes | Persisted for context |
| `/project none` | Yes | Agent should know project was deactivated |
| `/approve` / `/reject` | No | Already handled — approve forwards content to pipeline |
| `/new` | No | History is cleared by design |

**Implementation:** `CommandRouter._respond()` currently only emits to EventBus. Add a `_persistAndRespond()` method that also appends the user message + assistant response to `ConversationMemory`. Command handlers opt in by calling `_persistAndRespond()` instead of `_respond()`.

### 2. Include active model in system prompt

Add the current model name to the "Current Context" section of `PromptBuilder.build()`. This requires passing the model name into the session or as a separate parameter.

**Approach:** `HostDispatcher.buildRequest()` already has access to `llmProvider` (indirectly via config or direct reference). Add `activeModel` to the session metadata or to the `ExecutionRequest` so `PromptBuilder` can render it.

The simplest path: `PromptBuilder` receives the model name as part of the `session` object's metadata (set by `HostDispatcher` during request building).

### 3. Message format for persisted commands

Persisted command messages use plain text (not tool_use blocks):

```
User:      /model claude-3-opus
Assistant: Model switched from **claude-3-haiku** to **claude-3-opus**.
```

This keeps them lightweight and readable in history without special handling.

## Affected Components

| Component | Change |
|-----------|--------|
| `src/core/command-router.js` | Add `_persistAndRespond()` method; use it in `_handleModel()`, `_handleAgent()`, and `_handleProject()` |
| `src/brain/prompt-builder.js` | Add active model to "Current Context" section |
| `src/core/host-dispatcher.js` | Set `activeModel` on session metadata before passing to agent loop |

## Data Model

No database schema changes. Uses existing `messages` table via `ConversationMemory.append()`.

---

## Implementation Plan

### Prerequisites

None. All required infrastructure (`ConversationMemory`, `PromptBuilder`, `CommandRouter`) already exists.

### Step 1 — Persist command exchanges in CommandRouter

- **Files:** `src/core/command-router.js`
- **What:**
  1. Add `_persistAndRespond(message, text)` method that:
     - Resolves `sessionId` via `this.sessionManager.resolveSessionId(message)`
     - Calls `this.conversationMemory.append(sessionId, 'user', message.content)` (original command text)
     - Calls `this.conversationMemory.append(sessionId, 'assistant', text)` (bot response)
     - Calls existing `this._respond(message, text)` for EventBus delivery
  2. In `_handleModel()`: replace `this._respond(...)` with `this._persistAndRespond(...)` for both the query and switch cases
  3. In `_handleAgent()`: replace `this._respond(...)` with `this._persistAndRespond(...)` for the switch and reset cases (not for `list` or error cases)
- **Tests:** Verify that after `/model <name>`, `conversationMemory.getHistory()` contains both the user command and assistant response

### Step 2 — Add active model to system prompt

- **Files:** `src/core/host-dispatcher.js`, `src/brain/prompt-builder.js`
- **What:**
  1. In `HostDispatcher.buildRequest()`: set `session.metadata.activeModel = this.llmProvider.getModel()` (add `llmProvider` to dispatcher's constructor dependencies)
  2. In `PromptBuilder.build()`: after the channel line, add `- Model: ${session.metadata?.activeModel}` if present
- **Tests:** Verify the system prompt contains the active model name

### Step 3 — Tests

- **Files:** `test/command-context.test.js` (new)
- **What:**
  1. Test that `/model <name>` persists user + assistant messages to history
  2. Test that `/agent <name>` persists user + assistant messages to history
  3. Test that `/agent list` does NOT persist to history
  4. Test that `/new` does NOT persist (history is cleared)
  5. Test that `PromptBuilder` output includes model name when `session.metadata.activeModel` is set
  6. Test that `HostDispatcher.buildRequest()` sets `activeModel` on session metadata

### Integration & Verification

1. Start agent, send `/model` — verify current model shown and persisted
2. Send `/model <different-model>` — verify switch persisted
3. Send "what model are you using?" — agent should reference the model from both history and system prompt
4. Send `/agent <name>` then ask "which agent are you?" — agent should know
5. Send `/new` then ask about model — agent should still know (from system prompt) but not from history

### Risks

- **HostDispatcher dependency on llmProvider:** Currently `HostDispatcher` doesn't hold a reference to `llmProvider`. Need to wire it in `src/index.js`. Low risk — it's a constructor param addition.
- **Double messaging:** `_persistAndRespond` must call `_respond` (EventBus) AND `conversationMemory.append`. Need to ensure the EventBus-emitted response isn't also persisted elsewhere (it isn't — `finalize()` handles persistence only for LLM pipeline results).
