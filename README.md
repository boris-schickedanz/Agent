# AgentCore

A lean, extensible autonomous agent framework for Node.js that doubles as a persistent coding companion. Connects to LLMs (Anthropic Claude, Ollama) and exposes the agent over multiple channels (console REPL, Telegram) with a ReAct tool-use loop, persistent memory, file/shell tools, a skill system, and layered security with approval workflows.

## Quick Start

```bash
# Install dependencies
npm install

# Interactive setup (creates .env)
npx agentcore onboard

# Or manually: copy and edit .env
cp .env.example .env

# Run the agent (console REPL)
npm start

# Run as a daemon (requires pm2)
npx agentcore start --daemon
```

## What It Can Do

- **Chat** — Conversational AI via console or Telegram, with persistent memory across sessions
- **Read & write code** — Read files, apply edits, search codebases (grep, glob) within a sandboxed workspace
- **Run commands** — Execute shell commands, manage background processes (dev servers, builds)
- **GitHub workflows** — Clone repos, run tests, create PRs via the `/gh` skill
- **Delegate tasks** — Spawn Claude Code or Codex as sub-agents for complex coding tasks
- **Run 24/7** — PM2 daemon mode with health endpoint, scheduled tasks, and crash recovery
- **Multi-agent profiles** — Switch between personas (code reviewer, backend dev) with `/agent`
- **Web dashboard** — Monitor sessions, tools, audit log, and config via a browser UI

## Configuration

All configuration is via environment variables (or `.env` file). Run `agentcore onboard` for guided setup.

### Core

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Yes* | — | Anthropic API key (*not needed if using Ollama) |
| `LLM_PROVIDER` | No | `anthropic` | `anthropic` or `ollama` |
| `MODEL` | No | `claude-sonnet-4-20250514` | LLM model ID |
| `TELEGRAM_BOT_TOKEN` | No | — | Telegram Bot API token |
| `AGENT_NAME` | No | `AgentCore` | Display name |
| `DATA_DIR` | No | `./data` | Directory for SQLite database and memory files |
| `LOG_LEVEL` | No | `info` | Pino log level |
| `MAX_TOOL_ITERATIONS` | No | `25` | Max tool-use loop iterations per message |
| `RATE_LIMIT_MESSAGES_PER_MINUTE` | No | `20` | Per-user rate limit |
| `AUTO_APPROVE_USERS` | No | `false` | `true`, `false`, or comma-separated user IDs |
| `MASTER_KEY` | No | — | Auth key for `/status` endpoint and dashboard |

### Workspace & Security

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKSPACE_DIR` | `./workspace` | Root directory for file/shell operations (sandboxed) |
| `WORKSPACE_READONLY_DIRS` | — | Comma-separated read-only subdirectories |
| `AUDIT_LOG_ENABLED` | `true` | Log all tool executions to `audit_log` table |
| `SHELL_CONTAINER` | `false` | Run shell commands inside a container for isolation |
| `SHELL_CONTAINER_RUNTIME` | auto | `container`, `podman`, or `docker` |

### Operations

| Variable | Default | Description |
|----------|---------|-------------|
| `HEALTH_PORT` | `9090` | Health endpoint port (`0` to disable) |
| `HEALTH_BIND` | `127.0.0.1` | Bind address |
| `DASHBOARD_ENABLED` | `false` | Enable web dashboard on the health port |
| `MAX_DELEGATIONS` | `10` | Max concurrent sub-agent delegations |

### Context Management

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_CONTEXT_TOKENS` | `100000` | Max estimated tokens before compaction |
| `COMPACTION_THRESHOLD` | `80000` | Token count triggering context compaction |
| `HEARTBEAT_INTERVAL_MINUTES` | `30` | Legacy heartbeat interval (`0` to disable) |

## Architecture

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

See [`spec/`](spec/README.md) for complete specifications and [`spec/PRD-Use-Cases.md`](spec/PRD-Use-Cases.md) for the full use case inventory.

## Project Structure

```
agent-core/
├── bin/
│   └── agentcore.js             # CLI entry point
├── src/
│   ├── index.js                 # Entry point and component wiring
│   ├── config.js                # Environment-based configuration
│   ├── core/
│   │   ├── agent-loop.js        # ReAct loop (runtime)
│   │   ├── host-dispatcher.js   # Request building + agent profile resolution
│   │   ├── message-queue.js     # Per-session serial queue
│   │   ├── session-manager.js   # Session lifecycle
│   │   ├── event-bus.js         # Internal pub/sub
│   │   ├── command-router.js    # /new, /approve, /reject, /agent commands
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
│   │   ├── prompt-builder.js    # System prompt assembly (supports agent profiles)
│   │   ├── context-compactor.js # Token management
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

## CLI

```bash
agentcore start              # Start (foreground)
agentcore start --daemon     # Start via PM2 (background, crash-safe)
agentcore stop               # Stop PM2 process
agentcore status             # Query health endpoint
agentcore onboard            # Interactive setup wizard
agentcore config list        # Show current config
agentcore config set K V     # Set env var in .env
agentcore skill list         # List installed skills
agentcore skill install URL  # Install skill from URL/git
agentcore skill remove NAME  # Remove skill
agentcore agent list         # List agent profiles
agentcore logs               # Tail PM2 logs
```

## Chat Commands

| Command | Description |
|---------|-------------|
| `/new` | Clear conversation history (saves important context to memory first) |
| `/new <message>` | Clear and start fresh with a new message |
| `/approve` or `/yes` | Approve a pending tool execution |
| `/reject` or `/no` | Reject a pending tool execution |
| `/agent <name>` | Switch to an agent profile |
| `/agent list` | List available agent profiles |
| `/agent default` | Switch back to the default agent |
| `/gh <request>` | Activate the GitHub skill |

## Key Files

| File | Purpose |
|------|---------|
| `SOUL.md` | Agent personality and behavioral rules. Loaded as the system prompt prefix. |
| `tasks/*.md` | Scheduled tasks with YAML frontmatter (name, schedule, tools). Replaces HEARTBEAT.md. |
| `skills/*/SKILL.md` | Skill definitions with YAML frontmatter. See `spec/05-skills.md`. |
| `agents/*/AGENT.md` | Agent profile definitions. See `spec/21-agent-delegation.md`. |
| `.env` | Runtime configuration (gitignored). |

## Specifications

The [`spec/`](spec/README.md) directory contains the authoritative specifications:

**Core architecture:**

| Spec | Scope |
|------|-------|
| `01-runtime-core` | Agent loop, event bus, message queue, sessions, host dispatcher, runner layer |
| `02-brain` | LLM provider interface, prompt assembly, context compaction |
| `03-tools` | Tool registry, executor, schema validation, built-in tools, tool classes |
| `04-memory` | Conversation history, persistent memory, FTS5 search |
| `05-skills` | Skill format, loading, activation, lifecycle |
| `06-adapters` | Adapter interface, message contract, console and Telegram adapters |
| `07-security` | Three-layer model, rate limiting, sanitization, encryption |
| `08-database` | Schema, migrations, connection management |
| `09-configuration` | All environment variables, defaults, validation |
| `10-host-runtime-boundary` | Host/runtime split, runner interface, orchestration |
| `15-conversations-context` | `/new` command, tool result pruning, memory flush, rolling compression |

**Coding companion:**

| Spec | Scope |
|------|-------|
| `16-sandbox-and-audit` | Workspace path sandboxing, audit log, tool execution logging |
| `17-workspace-tools` | File system tools: read, write, edit, list, search, grep |
| `18-shell-execution` | Shell commands, process manager, background processes, container sandbox |
| `19-approval-workflow` | Interactive tool approval, session caching, /approve and /reject |
| `20-daemon-and-health` | PM2 daemon, health endpoint, enhanced task scheduler |
| `21-agent-delegation` | Sub-agent delegation, multi-agent profiles, memory namespaces |
| `22-cli-and-platform` | CLI tool, onboarding wizard, skill installer, web dashboard |

## Adding a New Tool

1. Create a registration function in `src/tools/built-in/<name>-tools.js`
2. Call it from `src/index.js`
3. Add to the appropriate tool policy profile in `src/security/tool-policy.js`
4. Update `spec/03-tools.md`

## Adding a Skill

1. Create `skills/<skill-name>/SKILL.md` with YAML frontmatter
2. Restart the agent. Skills are auto-discovered on startup.
3. Or install from a URL: `agentcore skill install <url>`

## Adding an Agent Profile

1. Create `agents/<name>/AGENT.md` with YAML frontmatter (`name`, `description`, `tools`, `memory_namespace`)
2. The markdown body becomes the agent's system prompt personality
3. Switch to it via `/agent <name>` in chat

## Dependencies

| Package | Purpose |
|---------|---------|
| `@anthropic-ai/sdk` | Anthropic Claude API client |
| `better-sqlite3` | SQLite with WAL mode and FTS5 |
| `dotenv` | Environment variable loading |
| `gray-matter` | YAML frontmatter parsing for skills, tasks, and agent profiles |
| `node-telegram-bot-api` | Telegram Bot API |
| `pino` | Structured JSON logging |
| `zod` | Runtime schema validation |

## License

MIT
