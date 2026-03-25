# AgentCore

A lean, extensible autonomous agent framework for Node.js. Inspired by NanoClaw's minimalism and OpenClaw's architectural patterns.

AgentCore connects to LLMs (Anthropic Claude) and exposes the agent over multiple channels (console REPL, Telegram) with a ReAct tool-use loop, persistent memory, a skill system, and three-layer security.

## Quick Start

```bash
# Install dependencies
npm install

# Copy and configure environment
cp .env.example .env
# Edit .env — at minimum set ANTHROPIC_API_KEY

# Run the agent (console REPL)
npm start

# Run with file-watch (auto-restart on changes)
npm run dev
```

## Configuration

All configuration is via environment variables (or `.env` file):

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Yes | — | Anthropic API key |
| `TELEGRAM_BOT_TOKEN` | No | — | Telegram Bot API token. If set, Telegram adapter starts automatically. |
| `AGENT_NAME` | No | `AgentCore` | Display name used in prompts and logs |
| `DATA_DIR` | No | `./data` | Directory for SQLite database and memory files |
| `LOG_LEVEL` | No | `info` | Pino log level (`debug`, `info`, `warn`, `error`) |
| `MODEL` | No | `claude-sonnet-4-20250514` | Anthropic model ID |
| `MAX_TOOL_ITERATIONS` | No | `25` | Max tool-use loop iterations per message |
| `HEARTBEAT_INTERVAL_MINUTES` | No | `30` | Heartbeat tick interval. `0` disables. |
| `RATE_LIMIT_MESSAGES_PER_MINUTE` | No | `20` | Per-user rate limit |
| `MAX_CONTEXT_TOKENS` | No | `100000` | Max estimated tokens before compaction |
| `COMPACTION_THRESHOLD` | No | `80000` | Token count triggering context compaction |
| `AUTO_APPROVE_USERS` | No | `false` | If `true`, new users get `user` role. If `false`, they get `pending`. |
| `MASTER_KEY` | No | — | Encryption key for the API key store. Falls back to `ANTHROPIC_API_KEY`. |

## Architecture

The system is split into a **host** (control plane) and a **runtime** (execution plane), connected by a **runner** interface.

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
│        Security Pipeline         │
│  Rate Limiter → Permissions      │
│  → Input Sanitizer               │
└──────────────┬───────────────────┘
               ▼
┌──────────────────────────────────┐
│  Host Dispatcher (buildRequest)  │  ← session, tools, memory, skills
└──────────────┬───────────────────┘
               ▼
┌──────────────────────────────────┐
│   Message Queue (per-session)    │
└──────────────┬───────────────────┘
               ▼
┌──────────────────────────────────┐
│      LocalRunner.execute()       │  ← timeout, cancellation, dedup
└──────────────┬───────────────────┘
               ▼
┌──────────────────────────────────┐
│     Agent Loop (ReAct Runtime)   │
│  ┌──────────┐  ┌──────────────┐  │
│  │  Prompt   │  │     Tool     │  │
│  │  Builder  │  │   Executor   │  │
│  └──────────┘  └──────────────┘  │
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

See [`spec/`](spec/README.md) for complete specifications.

## Project Structure

```
agent-core/
├── src/
│   ├── index.js                 # Entry point and component wiring
│   ├── config.js                # Environment-based configuration
│   ├── core/
│   │   ├── agent-loop.js        # ReAct loop (runtime)
│   │   ├── host-dispatcher.js   # Request building and result finalization (host)
│   │   ├── message-queue.js     # Per-session serial queue
│   │   ├── session-manager.js   # Session lifecycle
│   │   ├── event-bus.js         # Internal pub/sub
│   │   └── runner/
│   │       ├── agent-runner.js      # Abstract runner interface
│   │       ├── local-runner.js      # In-process runner wrapping AgentLoop
│   │       ├── execution-request.js # Request shape and validation
│   │       └── execution-result.js  # Result shape and status codes
│   ├── brain/
│   │   ├── llm-provider.js      # Abstract LLM interface
│   │   ├── anthropic-provider.js
│   │   ├── prompt-builder.js    # System prompt assembly
│   │   └── context-compactor.js # Token management
│   ├── tools/
│   │   ├── tool-registry.js     # Tool registration (with class field)
│   │   ├── tool-executor.js     # Execution with timeout
│   │   ├── tool-schema.js       # JSON Schema validation
│   │   └── built-in/            # system, http, memory tools
│   ├── skills/
│   │   ├── skill-loader.js      # Skill discovery and loading
│   │   └── skill-schema.js      # Frontmatter validation
│   ├── memory/
│   │   ├── conversation-memory.js  # SQLite message history
│   │   ├── persistent-memory.js    # Markdown file memory
│   │   └── memory-search.js        # FTS5 full-text search
│   ├── adapters/
│   │   ├── adapter-interface.js    # Abstract contract
│   │   ├── adapter-registry.js     # Registration and routing
│   │   ├── console/               # REPL adapter
│   │   └── telegram/              # Telegram Bot API adapter
│   ├── security/
│   │   ├── permission-manager.js  # Three-layer authorization
│   │   ├── rate-limiter.js        # Fixed-window rate limiting
│   │   ├── input-sanitizer.js     # Injection detection
│   │   ├── tool-policy.js         # Role-based tool access
│   │   └── api-key-store.js       # AES-256-GCM key storage
│   ├── heartbeat/
│   │   └── heartbeat-scheduler.js
│   └── db/
│       ├── database.js            # SQLite + WAL + migrations
│       └── migrations/
├── spec/                          # Specifications (single source of truth)
├── skills/                        # User-defined SKILL.md files
├── data/                          # Runtime data (gitignored)
├── SOUL.md                        # Agent personality
├── HEARTBEAT.md                   # Periodic task definitions
└── .env.example
```

## Key Files

| File | Purpose |
|------|---------|
| `SOUL.md` | Agent personality and behavioral rules. Loaded as the system prompt prefix. |
| `HEARTBEAT.md` | Periodic autonomous tasks. Each `## Heading` is a task with instructions in the body. |
| `skills/*/SKILL.md` | Skill definitions with YAML frontmatter. See `spec/05-skills.md`. |
| `.env` | Runtime configuration (gitignored). |

## Specifications

The [`spec/`](spec/README.md) directory contains the authoritative specifications for every subsystem:

| Spec | Scope |
|------|-------|
| `01-runtime-core` | Agent loop, event bus, message queue, sessions, host dispatcher, runner layer, startup |
| `02-brain` | LLM provider interface, prompt assembly, context compaction |
| `03-tools` | Tool registry, executor, schema validation, built-in tools, tool class/trust boundaries |
| `04-memory` | Conversation history, persistent memory, FTS5 search |
| `05-skills` | Skill format, loading, activation, lifecycle |
| `06-adapters` | Adapter interface, message contract, console and Telegram adapters |
| `07-security` | Three-layer model, rate limiting, sanitization, encryption |
| `08-database` | Schema, migrations, connection management |
| `09-configuration` | All environment variables, defaults, validation |
| `10-host-runtime-boundary` | Host/runtime split, runner interface, ExecutionRequest/Result, orchestration |

## Adding a New Adapter

1. Create `src/adapters/<name>/<name>-adapter.js` extending `AdapterInterface`
2. Implement `channelId`, `start()`, `stop()`, `normalizeInbound()`, `formatOutbound()`, `sendMessage()`
3. Register in `src/index.js` (gated on a config token/flag)
4. Update `spec/06-adapters.md`

## Adding a New Tool

1. Create a registration function in `src/tools/built-in/<name>-tools.js`
2. Call it from `src/index.js`
3. Add to the appropriate tool policy profile in `src/security/tool-policy.js`
4. Update `spec/03-tools.md`

## Adding a Skill

1. Create `skills/<skill-name>/SKILL.md` with YAML frontmatter
2. Restart the agent. Skills are auto-discovered on startup.
3. See `spec/05-skills.md` for the frontmatter schema.

## Dependencies

| Package | Purpose |
|---------|---------|
| `@anthropic-ai/sdk` | Anthropic Claude API client |
| `better-sqlite3` | SQLite with WAL mode and FTS5 |
| `dotenv` | Environment variable loading |
| `gray-matter` | YAML frontmatter parsing for skills |
| `node-telegram-bot-api` | Telegram Bot API |
| `pino` | Structured JSON logging |
| `zod` | Runtime schema validation |

## License

MIT
