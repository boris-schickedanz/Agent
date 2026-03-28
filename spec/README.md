# AgentCore Specifications

Authoritative design documents for every subsystem. These are the single source of truth for development.

**Start here:** [ARCHITECTURE.md](ARCHITECTURE.md) — high-level overview of all subsystems, message flow, and project structure.

**Deployment:** [DEPLOYMENT.md](DEPLOYMENT.md) — how the agent runs in production (Apple container, launchd, `agentcore` CLI).

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

## Coding Companion

Specs for the coding companion capabilities.

| Spec | Scope |
|------|-------|
| [16 — Sandbox & Audit Logging](16-sandbox-and-audit.md) | Workspace path sandboxing, audit log table, tool execution logging |
| [17 — Workspace Tools](17-workspace-tools.md) | File system tools: read, write, edit, list, search, grep |
| [18 — Shell Execution](18-shell-execution.md) | Shell command execution, process manager, background processes, optional container sandbox |
| [19 — Approval Workflow](19-approval-workflow.md) | Interactive tool approval prompts, per-invocation approval for write tools, /approve and /reject commands |
| [20 — Daemon & Health](20-daemon-and-health.md) | PM2 daemon mode, health HTTP endpoint, enhanced task scheduler |
| [21 — Agent Delegation](21-agent-delegation.md) | Sub-agent delegation (Claude Code, Codex), multi-agent profiles, memory namespace support |
| [22 — CLI & Platform](22-cli-and-platform.md) | CLI tool, onboarding wizard, skill installer, web dashboard |
| [23 — Read/Write Tool Policy](23-read-write-tool-policy.md) | Standard profile allows all tools; write tools gated by approval workflow instead of deny list |
| [24 — Apple Container Runtime](24-apple-container-runtime.md) | Run entire agent in Apple `container` by default; auto-build, sentinel detection, fallback to direct execution |
| [25 — Boot Resilience](25-boot-resilience.md) | Retry logic for `container system start` on boot; `ThrottleInterval` in launchd plist to survive post-reboot timing |
| [26 — Model Switch Command](26-model-switch-command.md) | `/model` command to display or switch the active LLM model at runtime |
| [27 — Command Context Persistence](27-command-context-persistence.md) | Persist `/model` and `/agent` command exchanges to history; include active model in system prompt |
| [29 — Persistent Workspace State](29-persistent-workspace-state.md) | Well-known memory keys for project state, decision journal, session log; state bootstrap injection into system prompt; continuation protocol |
| [31 — Multi-Project Support](31-multi-project.md) | Named project contexts with switching; active project state injection; `/project` command and `switch_project` tool |
| [Use Cases & PRD](PRD-Use-Cases.md) | Complete user-facing use case inventory, personas, E2E test coverage tracking |

## Draft

Specs not yet implemented. These describe planned features or migration plans and should not be treated as describing current behavior.

| Spec | Scope |
|------|-------|
| [28 — Lean System Prompt & Dynamic Tool Resolution](28-lean-system-prompt.md) | Two-tier tool resolution (core vs deferred), meta-tools (get_tool_details, get_agent_info), system prompt optimization |
| [32 — Single-User Model Migration](32-single-user-migration.md) | Align code and specs with PRD's single-user, single-session model: unified session ID, simplified security, global rate limiting |

## Archived

| File | Description |
|------|-------------|
| [14 — Migration Plan (ARCHIVED)](14-migration-plan-ARCHIVED.md) | Implementation plan for the host/runtime refactor (phases M1-M4). Retained as historical record. All phases complete. |
| [30 — Implementation Plan (ARCHIVED)](30-implementation-plan-ARCHIVED.md) | Phased roadmap for coding companion features (specs 16-22). All phases complete. |
