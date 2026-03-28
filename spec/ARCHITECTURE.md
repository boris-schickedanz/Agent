# Architecture

AgentCore is an autonomous LLM agent that receives messages from multiple channels, processes them through a ReAct loop with tool use, and sends responses back. It uses SQLite (better-sqlite3) for persistence and supports Anthropic and Ollama as LLM backends. The agent doubles as a persistent coding companion with file/shell tools, approval workflows, sub-agent delegation, and layered security.

## Message flow

```
┌─────────────┐     ┌─────────────┐
│   Telegram   │     │   Console   │    ...adapters
│   Adapter    │     │   Adapter   │
└──────┬───────┘     └──────┬──────┘
       │  normalizeInbound  │
       ▼                    ▼
┌──────────────────────────────────┐
│            EventBus              │  message:inbound / message:outbound
└──────────────┬───────────────────┘
               ▼
┌──────────────────────────────────┐
│  Security Pipeline + Commands    │
│  Rate Limiter → Permissions      │
│  → Sanitizer → CommandRouter     │
│    (/new /approve /reject /agent)│
└──────────────┬───────────────────┘
               ▼
┌──────────────────────────────────┐
│  Host Dispatcher (buildRequest)  │  ← session, tools, memory, skills, agent profile
└──────────────┬───────────────────┘
               ▼
┌──────────────────────────────────┐
│   Message Queue (per-session)    │
└──────────────┬───────────────────┘
               ▼
┌──────────────────────────────────┐
│      LocalRunner.execute()       │
└──────────────┬───────────────────┘
               ▼
┌──────────────────────────────────┐
│     Agent Loop (ReAct Runtime)   │
│  ┌──────────┐  ┌──────────────┐  │
│  │  Prompt   │  │     Tool     │  │
│  │  Builder  │  │   Executor   │  │
│  └──────────┘  │  + Approval   │  │
│                │  + Audit Log  │  │
│                └──────────────┘  │
│  ┌──────────────────────────────┐ │
│  │     Context Compactor        │ │
│  └──────────────────────────────┘ │
└──────────────┬───────────────────┘
               ▼
┌──────────────────────────────────┐
│   LLM Provider (Anthropic)       │
└──────────────────────────────────┘
               ▼
┌──────────────────────────────────┐
│ Host Dispatcher (finalize)       │  ← guardrails, persist, deliver
└──────────────────────────────────┘
```

## Core runtime

- **AgentLoop** (`src/core/agent-loop.js`): Pure ReAct loop. Receives pre-loaded data (history, tools, memories), returns structured results. Has no knowledge of sessions, persistence, or adapters. See [spec 01](01-runtime-core.md).
- **HostDispatcher** (`src/core/host-dispatcher.js`): Orchestrates all host concerns — session resolution, tool policy, memory search, skill matching, persistence, guardrails, and delivery. Two methods: `buildRequest()` and `finalize()`. See [spec 10](10-host-runtime-boundary.md).
- **Runner abstraction** (`src/core/runner/agent-runner.js`): Abstract base; `LocalRunner` wraps AgentLoop in-process. Translates between `ExecutionRequest`/`ExecutionResult` and the loop's internal format. Designed for future remote runner implementations.
- **MessageQueue** (`src/core/message-queue.js`): Per-session serial, cross-session parallel. Ensures one message per session processes at a time.
- **EventBus** (`src/core/event-bus.js`): In-process pub/sub (`EventEmitter` subclass). Key events: `message:inbound`, `message:outbound`, `stream:event`, `error`.
- **CommandRouter** (`src/core/command-router.js`): Intercepts slash commands (`/new`, `/approve`, `/reject`, `/agent`, `/model`) before the LLM pipeline. Consumed commands stop processing; partial matches forward remaining content.

## Brain subsystem

Components in `src/brain/` handle LLM interaction and context management. See [spec 02](02-brain.md).

- **LLM providers**: Abstract `LLMProvider` base with `AnthropicProvider` and `OllamaProvider` implementations. Support streaming via `streamMessage()`. Configurable via `LLM_PROVIDER` env var.
- **PromptBuilder** (`src/brain/prompt-builder.js`): Assembles the system prompt from SOUL.md (or agent profile), current context (date, user, channel, active model), relevant memories, and skill instructions. Caches SOUL.md for process lifetime.
- **ContextCompactor** (`src/brain/context-compactor.js`): Rolling LLM-based summarization when token count exceeds `COMPACTION_THRESHOLD`. Retains recent messages, merges older content into summaries. Falls back to truncation if summarization fails. See [spec 15](15-conversations-context.md).
- **HistoryPruner** (`src/brain/history-pruner.js`): Trims oversized tool results in-memory (head + tail with ellipsis) before sending to the LLM. Non-destructive — operates on copies.
- **MemoryFlusher** (`src/brain/memory-flusher.js`): Extracts key facts from conversation into persistent memory before compaction discards them. Also runs before `/new` clears a session.

## Memory

Three layers in `src/memory/`. See [spec 04](04-memory.md).

- **ConversationMemory** (`conversation-memory.js`): Per-session message history stored in SQLite. Methods: `append()`, `getHistory()`, `clearSession()`, `replaceHistory()`.
- **PersistentMemory** (`persistent-memory.js`): Cross-session key-value facts stored as markdown files in `{DATA_DIR}/memory/`. FTS-indexed on save.
- **MemorySearch** (`memory-search.js`): FTS5 full-text search across persistent memories. Used by HostDispatcher to inject relevant context into each request.

The agent accesses persistent memory via `save_memory`, `search_memory`, and `list_memories` tools.

## Tool system

See [spec 03](03-tools.md).

- **ToolRegistry** (`src/tools/tool-registry.js`): Central registry. Tools are registered with `{ name, description, inputSchema, handler, class, permissions, timeout }`.
- **ToolExecutor** (`src/tools/tool-executor.js`): Executes tools with permission checks (ToolPolicy), approval checks (ApprovalManager), input validation (Zod), timeout enforcement, and audit logging.
- **Tool classes**: `runtime` (stateless, no side effects), `brokered` (crosses host/runtime boundary — HTTP, memory, file, shell), `host` (admin-only, not exposed to LLM).

Built-in tools in `src/tools/built-in/`:

| File | Tools |
|------|-------|
| `system-tools.js` | `get_current_time`, `wait` |
| `http-tools.js` | `http_get`, `http_post` |
| `memory-tools.js` | `save_memory`, `search_memory`, `list_memories` |
| `fs-tools.js` | `read_file`, `write_file`, `edit_file`, `list_directory`, `file_search`, `grep_search` |
| `shell-tools.js` | `run_command`, `run_command_background`, `check_process`, `kill_process`, `list_processes` |
| `delegation-tools.js` | `delegate_task`, `check_delegation`, `cancel_delegation` |

## Security pipeline

Seven components in `src/security/` implement a three-layer model. See [spec 07](07-security.md).

```
Inbound message
  → Layer 1: IDENTITY — PermissionManager checks user role (admin/user/pending/blocked)
  → Layer 2: SCOPE — ToolPolicy filters available tools per role
  → Layer 3: CONTENT — InputSanitizer strips injection patterns, truncates oversized input
  → Agent Loop
```

- **RateLimiter** (`rate-limiter.js`): Per-user fixed-window rate limiting (default: 20 msg/min).
- **ApprovalManager** (`approval-manager.js`): Interactive approve/reject workflow for write tools. Temporary grants (5-minute window). See [spec 19](19-approval-workflow.md).
- **ToolPolicy** (`tool-policy.js`): Role-based allow/deny profiles — `full` (admin), `standard` (user, write tools gated by approval), `minimal` (pending). See [spec 23](23-read-write-tool-policy.md).
- **Sandbox** (`sandbox.js`): Workspace path confinement. Blocks directory traversal, symlink escapes, null bytes. See [spec 16](16-sandbox-and-audit.md).
- **AuditLogger** (`audit-logger.js`): Logs all tool executions with name, input, output, duration, and success status to SQLite.

## Adapter system

See [spec 06](06-adapters.md).

Adapters extend `AdapterInterface` (`src/adapters/adapter-interface.js`). Each adapter normalizes inbound messages to a common format and formats outbound messages for its platform. The `AdapterRegistry` wires adapters to EventBus events (`message:outbound`, `stream:event`) filtered by `channelId`.

Currently: `ConsoleAdapter` (always loaded), `TelegramAdapter` (loaded if `TELEGRAM_BOT_TOKEN` set).

Streaming: adapters implement `handleStreamEvent()` for `stream:start`, `stream:delta`, `stream:end` events.

## Session identity

`SessionManager` (`src/core/session-manager.js`) resolves normalized messages to canonical session IDs:
- Individual chats: `user:{canonicalUserId}` (cross-adapter via `user_aliases` table)
- Group chats: `group:{channel}:{chatId}`

## Skills

See [spec 05](05-skills.md).

Markdown files (`skills/**/SKILL.md`) with YAML frontmatter defining `name`, `trigger`, `tools`, `permissions`, and `env`. Loaded by `SkillLoader` (`src/skills/skill-loader.js`), matched by `trigger` prefix in `HostDispatcher.buildRequest()`. When matched, skill instructions are injected into the system prompt. Each skill also registers a pseudo-tool.

## Agent profiles

See [spec 21](21-agent-delegation.md).

`AgentRegistry` (`src/agents/agent-registry.js`) loads personality profiles from `agents/*/AGENT.md` (markdown with YAML frontmatter: `name`, `description`, `tools`, `memory_namespace`). The markdown body becomes the agent's system prompt personality. Switchable at runtime via `/agent <name>` command. The default personality uses `SOUL.md`.

## Personality

`SOUL.md` at project root defines the agent's default system prompt personality. Falls back to a built-in default if absent. Cached after first read by `PromptBuilder`. Agent profiles override this with their own personality when active.

## Process execution

`ProcessManager` (`src/process/process-manager.js`) centralizes all shell execution — synchronous `run()` and background `startBackground()`. Enforces `Sandbox` path confinement. Optionally runs commands inside a container when `SHELL_CONTAINER=true` (runtime auto-detected: `container`, `podman`, or `docker`). Ring buffers capture stdout/stderr (50KB limit). See [spec 18](18-shell-execution.md).

## Delegation

`DelegationManager` (`src/core/delegation-manager.js`) spawns sub-agent processes (Claude Code, Codex) via `ProcessManager.startBackground()`. Pluggable backends defined in `delegation-backends.js`. Enforces global (`MAX_DELEGATIONS`) and per-session concurrency limits. Exposed to the agent via `delegate_task`, `check_delegation`, and `cancel_delegation` tools. See [spec 21](21-agent-delegation.md).

## Scheduling

`TaskScheduler` (`src/scheduler/scheduler.js`) loads task definitions from `tasks/*.md` (YAML frontmatter with `name`, `schedule`, `tools`). Each task runs independently on its own cron schedule. Replaces the legacy `HeartbeatScheduler`. See [spec 20](20-daemon-and-health.md).

## Database

SQLite via better-sqlite3 (synchronous API). WAL journal mode, foreign keys enabled, 5s busy timeout. Migrations in `src/db/migrations/` are `.js` files exporting `up(db)`, auto-applied in sort order on startup. The `db` parameter passed to migrations is the `DB` wrapper (use `db.exec()` for DDL). See [spec 08](08-database.md).

## Configuration

All config via environment variables (or `.env` file). Loaded in `src/config.js` as a frozen object. See [spec 09](09-configuration.md) and the [README](../README.md) for the full configuration table.

## Project structure

```
agent-core/
├── bin/
│   └── agentcore.js             # CLI entry point
├── src/
│   ├── index.js                 # Entry point and component wiring (15 phases)
│   ├── config.js                # Environment-based configuration
│   ├── core/
│   │   ├── agent-loop.js        # ReAct loop (runtime)
│   │   ├── host-dispatcher.js   # Request building + agent profile resolution
│   │   ├── message-queue.js     # Per-session serial queue
│   │   ├── session-manager.js   # Session lifecycle
│   │   ├── event-bus.js         # Internal pub/sub
│   │   ├── command-router.js    # /new, /approve, /reject, /agent, /model commands
│   │   ├── delegation-manager.js   # Sub-agent task orchestration
│   │   ├── delegation-backends.js  # Claude Code, Codex, custom backends
│   │   └── runner/
│   │       ├── agent-runner.js      # Abstract runner interface
│   │       ├── local-runner.js      # In-process runner
│   │       ├── execution-request.js # Request shape and validation
│   │       └── execution-result.js  # Result shape and status codes
│   ├── brain/
│   │   ├── llm-provider.js      # Abstract LLM interface
│   │   ├── anthropic-provider.js
│   │   ├── ollama-provider.js
│   │   ├── prompt-builder.js    # System prompt assembly (supports agent profiles)
│   │   ├── context-compactor.js # Token management and rolling compression
│   │   ├── history-pruner.js    # Tool result pruning
│   │   └── memory-flusher.js    # Pre-compaction memory save
│   ├── tools/
│   │   ├── tool-registry.js     # Tool registration (with class field)
│   │   ├── tool-executor.js     # Execution with timeout, audit, approval
│   │   ├── tool-schema.js       # JSON Schema validation
│   │   └── built-in/
│   │       ├── system-tools.js      # get_current_time, wait
│   │       ├── http-tools.js        # http_get, http_post
│   │       ├── memory-tools.js      # save_memory, search_memory, list_memories
│   │       ├── fs-tools.js          # read_file, write_file, edit_file, list_directory, file_search, grep_search
│   │       ├── shell-tools.js       # run_command, run_command_background, check_process, kill_process, list_processes
│   │       └── delegation-tools.js  # delegate_task, check_delegation, cancel_delegation
│   ├── process/
│   │   └── process-manager.js   # Child process lifecycle, ring buffer output, container sandbox
│   ├── skills/
│   │   ├── skill-loader.js      # Skill discovery and loading
│   │   ├── skill-schema.js      # Frontmatter validation
│   │   └── skill-installer.js   # Install skills from URL/git/local
│   ├── agents/
│   │   ├── agent-profile.js     # Agent persona definition (AGENT.md)
│   │   └── agent-registry.js    # Load and resolve agent profiles
│   ├── scheduler/
│   │   └── scheduler.js         # Per-task independent scheduling (replaces heartbeat)
│   ├── memory/
│   │   ├── conversation-memory.js  # SQLite message history
│   │   ├── persistent-memory.js    # Markdown file memory (namespace support)
│   │   └── memory-search.js        # FTS5 full-text search (namespace support)
│   ├── adapters/
│   │   ├── adapter-interface.js    # Abstract contract
│   │   ├── adapter-registry.js     # Registration and routing
│   │   ├── console/               # REPL adapter
│   │   └── telegram/              # Telegram Bot API adapter
│   ├── security/
│   │   ├── sandbox.js             # Workspace path confinement
│   │   ├── audit-logger.js        # Structured tool execution log
│   │   ├── approval-manager.js    # Interactive tool approval workflow
│   │   ├── permission-manager.js  # Three-layer authorization
│   │   ├── rate-limiter.js        # Fixed-window rate limiting
│   │   ├── input-sanitizer.js     # Injection detection
│   │   ├── tool-policy.js         # Role-based tool access (fs/shell/delegation scopes)
│   │   └── api-key-store.js       # AES-256-GCM key storage
│   ├── web/
│   │   ├── health.js              # GET /health, GET /status
│   │   ├── server.js              # Dashboard REST API (extends health)
│   │   └── public/                # Dashboard SPA (vanilla JS, dark theme)
│   ├── cli/
│   │   └── onboard-wizard.js      # Interactive setup
│   ├── heartbeat/
│   │   └── heartbeat-scheduler.js # Legacy scheduler (superseded by scheduler/)
│   ├── container/
│   │   ├── container-launcher.js  # Docker/Podman/Apple container integration
│   │   └── launchd-installer.js   # macOS daemon support
│   └── db/
│       ├── database.js            # SQLite + WAL + migrations
│       └── migrations/
│           ├── 001-initial.js
│           ├── 002-user-aliases.js
│           └── 003-audit-log.js
├── skills/                        # Skill definitions (SKILL.md files)
│   ├── example-weather/
│   └── github/                    # Git/GitHub operations skill (/gh)
├── agents/                        # Agent profile definitions (AGENT.md files)
├── tasks/                         # Scheduled task definitions (parsed by TaskScheduler)
├── workspace/                     # Sandboxed working directory for file/shell tools
├── spec/                          # Specifications (single source of truth)
├── ecosystem.config.cjs           # PM2 daemon configuration
├── SOUL.md                        # Agent personality
├── HEARTBEAT.md                   # Legacy periodic tasks (use tasks/ instead)
└── .env.example
```
