# Spec 20 — Daemon Mode & Health Monitoring

> Status: **Draft** | Owner: — | Last updated: 2026-03-25

## 1. Purpose

Enable AgentCore to run as an always-on service that survives reboots, crashes, and disconnections. Provide health monitoring endpoints for operational visibility. Enhance the scheduler for per-task independent execution.

## 2. Deployment Model

AgentCore is a plain Node.js application — it runs anywhere Node.js runs (macOS, Linux, Windows). The primary target is **Apple Silicon Macs**.

There is one way to run it:

| Mode | Command |
|------|---------|
| **Foreground** | `npm start` or `agentcore start` |
| **Daemon** (crash-safe, boot-persistent) | `agentcore start --daemon` (uses PM2 under the hood) |

PM2 is the single daemon strategy — cross-platform (macOS, Linux, Windows), battle-tested, zero custom code.

Shell command isolation via containers is an optional security layer, configured in the ProcessManager (see [Spec 18 §2.4](18-shell-execution.md)).

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
    env: {
      NODE_ENV: 'production',
    },
    // Log management
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    // Restart policy
    restart_delay: 5000,
    max_restarts: 10,
    min_uptime: 10000,
  }],
};
```

The CLI (`agentcore start --daemon`) wraps these PM2 commands:

```bash
pm2 start ecosystem.config.cjs     # Start
pm2 startup                         # Enable boot persistence
pm2 save                            # Save current process list
pm2 monit                           # Monitor
pm2 logs agentcore                  # View logs
pm2 restart agentcore               # Restart
```

> **Advanced (macOS):** Users who prefer launchd over PM2 can write a standard `.plist` — AgentCore has no special launchd integration, it's just `node src/index.js` with `KeepAlive` and `RunAtLoad`.

### 3.2 Health Endpoint

**File:** `src/web/health.js`
**Class:** `HealthServer`

Minimal HTTP server for health checks and basic status.

**Interface:**

```js
constructor({ port, messageQueue, adapterRegistry, db, logger })
start(): Promise<void>
stop(): Promise<void>
```

**Endpoints:**

#### `GET /health`

Returns 200 if healthy, 503 if degraded.

```json
{
  "status": "healthy",
  "uptime": 3600,
  "version": "1.0.0",
  "sessions": {
    "active": 5,
    "queued": 2
  },
  "adapters": ["console", "telegram"],
  "llmProvider": "anthropic",
  "database": "ok"
}
```

Health check logic:
- `healthy`: all adapters running, database responsive
- `degraded`: one or more adapters failed, but core is running
- `unhealthy`: database unresponsive or critical error

#### `GET /status`

Extended status (requires `MASTER_KEY` in `Authorization` header):

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
  "tools": ["get_current_time", "read_file", "run_command", "..."],
  "skills": [{ "name": "github", "trigger": "/gh" }],
  "recentSessions": [
    { "id": "user:john", "lastActivity": "2026-03-25T10:00:00Z", "messageCount": 42 }
  ]
}
```

**Implementation:**

Uses Node.js built-in `http.createServer()`. No Express or framework dependencies.

```js
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    // ... health check logic
  } else if (req.method === 'GET' && req.url === '/status') {
    // ... auth check + extended status
  } else {
    res.writeHead(404);
    res.end();
  }
});
```

### 3.3 Enhanced Scheduler

**File:** `src/scheduler/scheduler.js`
**Class:** `TaskScheduler`

Replaces `HeartbeatScheduler` with per-task independent execution.

**Interface:**

```js
constructor({ runner, db, logger, config })

loadTasks(): void                  // Load from HEARTBEAT.md + tasks/ directory
start(): void
stop(): void
getTaskStatus(name): TaskState
listTasks(): TaskState[]
```

**Task definition format** (in `tasks/` directory):

```markdown
---
name: check-ci
description: Monitor CI pipeline status
schedule: "*/30 * * * *"           # Cron expression (or interval: "30m")
timeout: 60000
tools: [http_get, run_command]
enabled: true
---

Check the CI pipeline status for the main repo...
```

**Key improvements over HeartbeatScheduler:**

| Aspect | HeartbeatScheduler | TaskScheduler |
|--------|-------------------|---------------|
| Execution | All tasks in one LLM turn | Each task independent |
| Scheduling | Single interval | Per-task cron or interval |
| Failure isolation | One task fails → all fail | Independent |
| State | Single `_inFlight` flag | Per-task state |
| Source | `HEARTBEAT.md` only | `HEARTBEAT.md` + `tasks/*.md` |

**Backward compatibility:**

If `HEARTBEAT.md` exists and `tasks/` doesn't, fall back to HeartbeatScheduler behavior (single combined execution).

**Per-task execution:**

Each task gets its own `ExecutionRequest`:

```js
createExecutionRequest({
  origin: ExecutionOrigin.SCHEDULED_TASK,
  sessionId: `task:${taskName}`,
  userId: 'system',
  channelId: 'scheduler',
  userContent: task.instructions,
  toolSchemas: /* filtered by task.tools */,
  timeoutMs: task.timeout,
});
```

## 4. Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `HEALTH_PORT` | `9090` | Health endpoint port. Set to `0` to disable. |
| `HEALTH_BIND` | `127.0.0.1` | Bind address (localhost only by default for security) |

Added to `src/config.js`.

## 5. Integration (src/index.js)

New phase after adapters:

```js
// Phase 14 — Health endpoint
if (config.healthPort > 0) {
  const healthServer = new HealthServer({ port: config.healthPort, bind: config.healthBind, messageQueue, adapterRegistry, db, logger });
  await healthServer.start();
  // Add to shutdown sequence
}

// Phase 15 — Task scheduler (replaces heartbeat)
const scheduler = new TaskScheduler({ runner, db, logger, config });
scheduler.loadTasks();
scheduler.start();
```

## 6. Design Decisions

| Decision | Rationale |
|----------|-----------|
| PM2 as the single daemon strategy | Battle-tested, cross-platform (macOS/Linux/Windows), zero custom code. Handles restart, logs, boot persistence. CLI wraps PM2 so users never need to learn it. |
| No container for the agent itself | The agent is trusted code — containerizing it adds friction (volume mounts, networking) without security benefit. Shell command isolation is handled at the ProcessManager level (Spec 18). |
| Health on localhost only | Prevents accidental exposure. Use SSH tunnel or reverse proxy for remote access. |
| No Express for health | One endpoint doesn't justify a framework dependency. |
| Per-task execution | One task's failure or token consumption shouldn't affect others. |
| Backward-compatible scheduler | Existing HEARTBEAT.md setups continue working. |

## 7. Extension Points

- **Web dashboard (Spec 22):** Health server becomes the foundation for a full REST API.
- **Webhook triggers:** Accept POST requests to trigger tasks on-demand.
- **File-watch triggers:** `fs.watch()` on directories to trigger tasks on file changes.
- **Metrics export:** Prometheus-compatible `/metrics` endpoint.
- **Alerting:** Emit events when health degrades for external monitoring integration.
