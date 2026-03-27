# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Workflow — spec-driven development

All features and changes follow this sequence:

1. **Spec first** — Write a new spec in `spec/` (next available number, e.g. `11-feature-name.md`) describing the feature: motivation, design, API surface, data model changes, and affected components. Add it to the table in `spec/README.md`.
2. **Implementation plan** — Create a step-by-step plan (can be a section within the spec or a separate document). Get alignment before writing code.
3. **Test Driven Design** - Implement tests first according to the plan and spec.
4. **Implement** — Build according to the plan and spec. Make sure the tests you created previously run smoothly.
5. **Update existing docs** — If the new feature changes behaviour described in other specs, update those specs and `spec/README.md` to stay consistent. Outdated specs that no longer apply should be marked `ARCHIVED` in filename and moved to the Archived table.

Specs in `spec/` are the single source of truth. Code should match specs; when they diverge, update the spec or fix the code — never leave them inconsistent.

The **Use Cases PRD** ([`spec/PRD-Use-Cases.md`](spec/PRD-Use-Cases.md)) is the canonical inventory of all user-facing capabilities, organized by persona and category. When adding a feature, add its use case to the PRD. When writing tests, use the PRD to identify missing E2E coverage.

## Commands

```bash
npm start              # Run the agent
npm run dev            # Run with --watch (auto-restart on changes)
npm test               # Run all tests
node --test test/pipeline-e2e.test.js   # Run a single test file
```

Tests use Node's built-in test runner (`node:test` + `node:assert/strict`). No test framework to install.

## Architecture

This is an autonomous LLM agent ("AgentCore") that receives messages from multiple channels, processes them through a ReAct loop with tool use, and sends responses back. It uses SQLite (better-sqlite3) for persistence and supports Anthropic and Ollama as LLM backends.

### Message flow

```
Adapter (inbound) → EventBus "message:inbound" → index.js handler
  → rate limit / permission / sanitize
  → HostDispatcher.buildRequest() — resolves session, loads history, tools, memories, skills
  → MessageQueue.enqueue() → LocalRunner.execute() → AgentLoop.processMessage() (ReAct loop)
  → HostDispatcher.finalize() — guardrails, persist messages, emit outbound
  → EventBus "message:outbound" → AdapterRegistry routes to correct Adapter
```

### Key boundaries

- **AgentLoop** (`src/core/agent-loop.js`): Pure ReAct loop. Receives pre-loaded data (history, tools, memories), returns structured results. Has no knowledge of sessions, persistence, or adapters.
- **HostDispatcher** (`src/core/host-dispatcher.js`): Orchestrates all host concerns — session resolution, tool policy, memory search, skill matching, persistence, guardrails, and delivery. The single point where request building and result finalization happen.
- **Runner abstraction** (`src/core/runner/agent-runner.js`): Abstract base; `LocalRunner` wraps AgentLoop in-process. Translates between `ExecutionRequest`/`ExecutionResult` and the loop's internal format. Designed for future remote runner implementations.
- **MessageQueue** (`src/core/message-queue.js`): Per-session serial, cross-session parallel. Ensures one message per session processes at a time.

### Adapter system

Adapters extend `AdapterInterface` (`src/adapters/adapter-interface.js`). Each adapter normalizes inbound messages to a common format and formats outbound messages for its platform. The `AdapterRegistry` wires adapters to EventBus events (`message:outbound`, `stream:event`) filtered by `channelId`.

Currently: `ConsoleAdapter` (always loaded), `TelegramAdapter` (loaded if `TELEGRAM_BOT_TOKEN` set).

Streaming: adapters implement `handleStreamEvent()` for `stream:start`, `stream:delta`, `stream:end` events.

### Session identity

`SessionManager` resolves normalized messages to canonical session IDs:
- Individual chats: `user:{canonicalUserId}` (cross-adapter via `user_aliases` table)
- Group chats: `group:{channel}:{chatId}`

### Skills

Markdown files (`skills/**/SKILL.md`) with YAML frontmatter. Loaded by `SkillLoader`, matched by `trigger` prefix. When matched, `skillInstructions` are injected into the system prompt. Each skill also registers a pseudo-tool.

### Personality

`SOUL.md` at project root defines the agent's system prompt personality. Falls back to a default if absent. Cached after first read by `PromptBuilder`.

### Database

SQLite via better-sqlite3 (synchronous API). Migrations in `src/db/migrations/` are `.js` files exporting `up(db)`, auto-applied in sort order on startup. The `db` parameter passed to migrations is the `DB` wrapper (use `db.exec()` for DDL).

### Configuration

All config via environment variables (see `.env.example`). Loaded in `src/config.js` as a frozen object. Key settings: `LLM_PROVIDER` (`anthropic`|`ollama`), `MODEL`, `TELEGRAM_BOT_TOKEN`, `AUTO_APPROVE_USERS`, `MAX_TOOL_ITERATIONS`.

## Patterns

- ES modules throughout (`"type": "module"` in package.json). Use `import`/`export`, not `require`.
- Abstract base classes with `throw new Error('Not implemented')` for interfaces (`AdapterInterface`, `LLMProvider`, `AgentRunner`).
- Tools are registered via `ToolRegistry.register({ name, description, inputSchema, handler })`. Built-in tools in `src/tools/built-in/`. Schemas follow Anthropic's tool input format.
- EventBus is a standard Node `EventEmitter` subclass. Key events: `message:inbound`, `message:outbound`, `stream:event`, `error`.
- Wiring happens in `src/index.js` — all components are constructed and connected there in numbered phases.
