# Spec 09 — Configuration

> Status: **Implemented** | Owner: — | Last updated: 2026-03-25

## 1. Purpose

All runtime configuration is centralized in a single frozen object loaded from environment variables. No configuration is hardcoded in application logic.

## 2. Configuration Source

**File:** `src/config.js`

Configuration is loaded from:
1. `.env` file (via `dotenv`) — for local development
2. `process.env` — for production (takes precedence over `.env`)

The config object is `Object.freeze()`'d to prevent accidental mutation.

## 3. Configuration Variables

| Variable | Config Key | Type | Required | Default | Description |
|----------|-----------|------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | `anthropicApiKey` | string | Yes | `''` | Anthropic API key for Claude |
| `TELEGRAM_BOT_TOKEN` | `telegramBotToken` | string | No | `''` | Telegram Bot API token. Telegram adapter only starts if this is set. |
| `AGENT_NAME` | `agentName` | string | No | `'AgentCore'` | Display name in prompts and logs |
| `DATA_DIR` | `dataDir` | string | No | `'./data'` | Directory for SQLite DB and memory files. Resolved to absolute path. |
| `LOG_LEVEL` | `logLevel` | string | No | `'info'` | Pino log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal` |
| `MODEL` | `model` | string | No | `'claude-sonnet-4-20250514'` | Anthropic model ID |
| `MAX_TOOL_ITERATIONS` | `maxToolIterations` | number | No | `25` | Maximum ReAct loop iterations per message |
| `HEARTBEAT_INTERVAL_MINUTES` | `heartbeatIntervalMs` | number | No | `30` | Minutes between heartbeat ticks. Stored as milliseconds internally. `0` disables heartbeat. |
| `RATE_LIMIT_MESSAGES_PER_MINUTE` | `rateLimitPerMinute` | number | No | `20` | Max messages per user per minute |
| `MAX_CONTEXT_TOKENS` | `maxContextTokens` | number | No | `100000` | Informational upper bound for context window |
| `COMPACTION_THRESHOLD` | `compactionThreshold` | number | No | `80000` | Token estimate at which context compaction triggers |
| `COMPACTION_RETAIN_MESSAGES` | `compactionRetainMessages` | number | No | `10` | Number of recent messages to keep after compaction |
| `COMPACTION_MEMORY_FLUSH` | `compactionMemoryFlush` | boolean | No | `true` | Enable pre-compaction memory flush (saves important facts before summarizing) |
| `PRUNE_THRESHOLD` | `pruneThreshold` | number | No | `4000` | Chars above which tool results are pruned in-memory |
| `PRUNE_HEAD` | `pruneHead` | number | No | `1500` | Chars to keep from start of pruned tool result |
| `PRUNE_TAIL` | `pruneTail` | number | No | `1500` | Chars to keep from end of pruned tool result |
| `AUTO_APPROVE_USERS` | `autoApproveUsers` | boolean | No | `false` | If `true`, new users get `user` role. If `false`, they get `pending` (restricted). |
| `MASTER_KEY` | `masterKey` | string | No | `''` | Encryption key for the API key store. Falls back to `ANTHROPIC_API_KEY` if empty. |
| | | | | | |
| **Workspace & Security** (Spec 16) | | | | | |
| `WORKSPACE_DIR` | `workspaceDir` | string | No | `'./workspace'` | Root directory for file/shell operations. Resolved to absolute path. |
| `WORKSPACE_READONLY_DIRS` | `workspaceReadOnlyDirs` | string[] | No | `[]` | Comma-separated list of read-only subdirectories (relative to WORKSPACE_DIR). |
| `AUDIT_LOG_ENABLED` | `auditLogEnabled` | boolean | No | `true` | Enable/disable audit logging of tool executions. |
| | | | | | |
| **Shell Execution** (Spec 18) | | | | | |
| `SHELL_CONTAINER` | `shellContainer` | boolean | No | `false` | Execute shell commands inside a container instead of directly on host. |
| `SHELL_CONTAINER_RUNTIME` | `shellContainerRuntime` | string | No | auto | Container CLI: `container` (Apple), `podman`, or `docker`. Auto-detects if unset. |
| `SHELL_CONTAINER_IMAGE` | `shellContainerImage` | string | No | `'agentcore-sandbox'` | Image name for the sandbox container. |
| | | | | | |
| **Health & Daemon** (Spec 20) | | | | | |
| `HEALTH_PORT` | `healthPort` | number | No | `9090` | Health endpoint port. Set to `0` to disable. |
| `HEALTH_BIND` | `healthBind` | string | No | `'127.0.0.1'` | Bind address for health endpoint (localhost only by default). |

## 4. Type Coercion

- Integer variables are parsed with `parseInt(value, 10)`.
- Boolean variables use strict comparison: `value === 'true'`.
- `DATA_DIR` is resolved to an absolute path via `path.resolve()`.
- `HEARTBEAT_INTERVAL_MINUTES` is converted to milliseconds: `value * 60_000`.

## 5. .env.example

The `.env.example` file at the project root documents all variables with placeholder values. It is committed to version control. The actual `.env` file is gitignored.

## 6. How Configuration Is Consumed

The `config` object is imported directly by components that need it:

```js
import { config } from './config.js';
```

Components that receive config via constructor injection (e.g., `AgentLoop`, `RateLimiter`) accept the full config object and extract what they need. This provides a single dependency to mock in tests.

## 7. Adding a New Configuration Variable

1. Add the variable to `.env.example` with a placeholder value.
2. Add parsing logic to `src/config.js` with a sensible default.
3. Add the variable to the table in this spec.
4. Use the new config key in the relevant component.

## 8. Design Decisions

| Decision | Rationale |
|----------|-----------|
| Environment variables over config files | Standard 12-factor app practice. Works with containers, CI/CD, and cloud platforms without file management. |
| `Object.freeze()` | Prevents components from accidentally mutating shared configuration. |
| `dotenv` for local dev | Convenience for development. Not loaded in production if env vars are already set. |
| Sensible defaults for everything except API key | The agent should start with minimal configuration. Only the API key is truly required. |
| `DATA_DIR` resolved to absolute path | Avoids ambiguity when the working directory changes. |
