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

See [`spec/ARCHITECTURE.md`](spec/ARCHITECTURE.md) for the full architecture overview including message flow, subsystem descriptions, and project structure.

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
