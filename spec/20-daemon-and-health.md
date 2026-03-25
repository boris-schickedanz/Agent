# Spec 20 — Daemon Mode & Health Monitoring

> Status: **Implemented** | Owner: — | Last updated: 2026-03-25

## 1. Purpose

Enable AgentCore to run as an always-on service that survives reboots, crashes, and disconnections. Provide health monitoring endpoints for operational visibility. Enhance the scheduler for per-task independent execution.

## 2. Deployment Model

AgentCore is a plain Node.js application. The primary target is **Apple Silicon Macs**.

| Mode | Command |
|------|---------|
| **Foreground** | `npm start` or `agentcore start` |
| **Daemon** (crash-safe, boot-persistent) | `agentcore start --daemon` (uses PM2) |

PM2 is the single daemon strategy — cross-platform, battle-tested, zero custom code.

## 3. Components

### 3.1 PM2 Ecosystem Configuration

**File:** `ecosystem.config.cjs` (repo root)

```js
module.exports = {
  apps: [{
    name: 'agentcore',
    script: 'src/index.js',
    watch: false,
    max_memory_restart: '512M',
    env: { NODE_ENV: 'production' },
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    restart_delay: 5000,
    max_restarts: 10,
    min_uptime: 10000,
  }],
};
```

### 3.2 Health Endpoint

**File:** `src/web/health.js`
**Class:** `HealthServer`

Minimal HTTP server using Node.js built-in `http.createServer()`. No Express dependency.

**Interface:**

```js
constructor({ port, bind, messageQueue, adapterRegistry, db, logger, config })
start(): Promise<void>
stop(): Promise<void>
```

**Endpoints:**

#### `GET /health`

Returns 200 if healthy, 503 if unhealthy. No authentication required.

```json
{
  "status": "healthy",
  "uptime": 3600,
  "version": "0.1.0",
  "adapters": ["console", "telegram"],
  "llmProvider": "anthropic",
  "database": "ok"
}
```

Health check: `healthy` if database responds to `SELECT 1`; `unhealthy` otherwise.

#### `GET /status`

Extended status. Requires `Authorization: Bearer {MASTER_KEY}` header.

```json
{
  "health": { "..." },
  "config": {
    "agentName": "AgentCore",
    "llmProvider": "anthropic",
    "model": "claude-sonnet-4-20250514",
    "workspaceDir": "/app/workspace",
    "maxToolIterations": 25
  },
  "recentSessions": [
    { "id": "user:john", "userId": "john", "lastActivity": "2026-03-25T10:00:00Z" }
  ]
}
```

### 3.3 Enhanced Scheduler

**File:** `src/scheduler/scheduler.js`
**Class:** `TaskScheduler`

Replaces `HeartbeatScheduler` with per-task independent execution.

**Interface:**

```js
constructor({ runner, toolRegistry, sessionManager, db, logger, config })

loadTasks(): void                  // Load from tasks/ directory or HEARTBEAT.md
start(): void
stop(): void
getTaskStatus(name): TaskState | null
listTasks(): TaskState[]
```

**Task definition format** (in `tasks/` directory, parsed with `gray-matter`):

```markdown
---
name: check-ci
description: Monitor CI pipeline status
schedule: "30m"
timeout: 60000
tools: [http_get, run_command]
enabled: true
---

Check the CI pipeline status for the main repo...
```

**Schedule format:** Supports interval strings (`30m`, `1h`, `60s`, `5000ms`) and simple cron patterns (`*/30 * * * *` extracts the minute interval).

**Backward compatibility:** If `HEARTBEAT.md` exists and `tasks/` directory doesn't, falls back to HeartbeatScheduler-style behavior (parses `##` sections into individual tasks using the heartbeat interval).

**Per-task execution:** Each task gets its own `ExecutionRequest` with `origin: SCHEDULED_TASK`, session ID `task:{name}`, and tool schemas filtered by the task's `tools` field. Tasks with `_inFlight` flag are skipped (no overlap).

## 4. Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `HEALTH_PORT` | `9090` | Health endpoint port. Set to `0` to disable. |
| `HEALTH_BIND` | `127.0.0.1` | Bind address (localhost only by default for security) |

## 5. Integration (src/index.js)

```js
// Phase 14 — Health endpoint (or Dashboard if enabled)
if (config.healthPort > 0) {
  if (config.dashboardEnabled) {
    // DashboardServer extends HealthServer (Spec 22)
  } else {
    const healthServer = new HealthServer({ ... });
    await healthServer.start();
  }
}

// Phase 15 — Task scheduler (replaces heartbeat, falls back to HeartbeatScheduler)
const scheduler = new TaskScheduler({ runner, toolRegistry, sessionManager, db, logger, config });
scheduler.loadTasks();
scheduler.start();
```

## 6. Design Decisions

| Decision | Rationale |
|----------|-----------|
| PM2 as the single daemon strategy | Battle-tested, cross-platform, zero custom code. CLI wraps PM2 so users never need to learn it. |
| Health on localhost only | Prevents accidental exposure. Use SSH tunnel or reverse proxy for remote access. |
| No Express for health | One endpoint doesn't justify a framework dependency. |
| Per-task execution | One task's failure or token consumption shouldn't affect others. |
| Backward-compatible scheduler | Existing HEARTBEAT.md setups continue working. |
| `gray-matter` for task parsing | Already a dependency for skills. Consistent frontmatter format. |

## 7. Extension Points

- **Web dashboard (Spec 22):** Health server becomes the foundation for a full REST API via `DashboardServer`.
- **Webhook triggers:** Accept POST requests to trigger tasks on-demand.
- **File-watch triggers:** `fs.watch()` on directories to trigger tasks on file changes.
- **Metrics export:** Prometheus-compatible `/metrics` endpoint.
- **Alerting:** Emit events when health degrades for external monitoring integration.
