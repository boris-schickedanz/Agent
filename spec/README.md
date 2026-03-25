# AgentCore Specifications

Authoritative design documents for every subsystem. These are the single source of truth for development.

## Reading Order

Start with specs 01 and 10 for the overall architecture, then read subsystem specs as needed.

| Spec | Scope |
|------|-------|
| [01 — Runtime Core](01-runtime-core.md) | Agent loop, event bus, message queue, sessions, host dispatcher, runner layer, startup sequence, shutdown |
| [02 — Brain](02-brain.md) | LLM provider interface, prompt assembly, context compaction |
| [03 — Tools](03-tools.md) | Tool registry, executor, schema validation, built-in tools, tool class/trust boundary classification |
| [04 — Memory](04-memory.md) | Conversation history, persistent memory, FTS5 search |
| [05 — Skills](05-skills.md) | Skill format, loading, activation, lifecycle |
| [06 — Adapters](06-adapters.md) | Adapter interface, normalized message contract, console and Telegram adapters |
| [07 — Security](07-security.md) | Three-layer model (identity, scope, content), rate limiting, sanitization, encryption |
| [08 — Database](08-database.md) | SQLite schema, migrations, connection management |
| [09 — Configuration](09-configuration.md) | Environment variables, defaults, type coercion |
| [10 — Host & Runner Architecture](10-host-runtime-boundary.md) | Host/runtime boundary, runner interface, ExecutionRequest/Result, HostDispatcher, orchestration flow, parallelism, timeout/cancellation |
| [15 — Session Reset & Context Management](15-conversations-context.md) | `/new` command, tool result pruning, pre-compaction memory flush, rolling compression |

## Archived

| File | Description |
|------|-------------|
| [14 — Migration Plan (ARCHIVED)](14-migration-plan-ARCHIVED.md) | Implementation plan for the host/runtime refactor (phases M1-M4). Retained as historical record. All phases complete. |
