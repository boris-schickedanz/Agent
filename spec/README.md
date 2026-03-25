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

## Coding Companion Roadmap (Draft)

Specs for evolving AgentCore into a persistent coding companion. See [30 — Implementation Plan](30-implementation-plan.md) for phasing and dependencies.

| Spec | Scope | Phase |
|------|-------|-------|
| [16 — Sandbox & Audit Logging](16-sandbox-and-audit.md) | Workspace path sandboxing, audit log table, tool execution logging | 0 |
| [17 — Workspace Tools](17-workspace-tools.md) | File system tools: read, write, edit, list, search, grep | 1 |
| [18 — Shell Execution](18-shell-execution.md) | Shell command execution, process manager, background processes, terminal sessions | 1 |
| [19 — Approval Workflow](19-approval-workflow.md) | Interactive tool approval prompts, session-scoped caching, /approve and /reject commands | 1 |
| [20 — Daemon & Health](20-daemon-and-health.md) | PM2/Docker daemon mode, health HTTP endpoint, enhanced task scheduler | 2 |
| [21 — Agent Delegation](21-agent-delegation.md) | Sub-agent delegation (Claude Code, Codex), multi-agent profiles, memory isolation | 3 |
| [22 — CLI & Platform](22-cli-and-platform.md) | CLI tool, onboarding wizard, skill marketplace, web dashboard | 3 |
| [30 — Implementation Plan](30-implementation-plan.md) | Phased roadmap, dependency graph, file change summary, acceptance criteria | — |

## Archived

| File | Description |
|------|-------------|
| [14 — Migration Plan (ARCHIVED)](14-migration-plan-ARCHIVED.md) | Implementation plan for the host/runtime refactor (phases M1-M4). Retained as historical record. All phases complete. |
