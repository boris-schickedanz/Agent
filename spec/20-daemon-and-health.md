# Spec 20 — Daemon Mode & Health Monitoring

> Status: **Draft** | Owner: — | Last updated: 2026-03-25

## 1. Purpose

Enable AgentCore to run as an always-on service that survives reboots, crashes, and disconnections. Provide health monitoring endpoints for operational visibility. Enhance the scheduler for per-task independent execution.

## 2. Components

### 2.1 PM2 Ecosystem Configuration

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

**Usage:**

```bash
pm2 start ecosystem.config.cjs     # Start
pm2 startup                         # Enable boot persistence
pm2 save                            # Save current process list
pm2 monit                           # Monitor
pm2 logs agentcore                  # View logs
pm2 restart agentcore               # Restart
```

### 2.2 Docker Configuration

**File:** `Dockerfile`

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
RUN mkdir -p /app/data /app/workspace /app/logs
VOLUME ["/app/data", "/app/workspace"]
EXPOSE 9090
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:9090/health || exit 1
CMD ["node", "src/index.js"]
```

**File:** `docker-compose.yml`

```yaml
services:
  agentcore:
    build: .
    restart: unless-stopped
    ports:
      - "9090:9090"
    volumes:
      - ./data:/app/data
      - ./workspace:/app/workspace
    env_file: .env
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

### 2.3 Health Endpoint

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

### 2.4 Enhanced Scheduler

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

## 3. Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `HEALTH_PORT` | `9090` | Health endpoint port. Set to `0` to disable. |
| `HEALTH_BIND` | `127.0.0.1` | Bind address (localhost only by default for security) |

Added to `src/config.js`.

## 4. Integration (src/index.js)

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

## 5. Design Decisions

| Decision | Rationale |
|----------|-----------|
| PM2 (not custom daemon) | Battle-tested, zero code needed. Handles restart, logs, boot persistence. |
| Docker as optional alternative | Clean isolation for VPS deployments. Volumes preserve state. |
| Health on localhost only | Prevents accidental exposure. Use SSH tunnel or reverse proxy for remote access. |
| No Express for health | One endpoint doesn't justify a framework dependency. |
| Per-task execution | One task's failure or token consumption shouldn't affect others. |
| Backward-compatible scheduler | Existing HEARTBEAT.md setups continue working. |

## 6. Extension Points

- **Web dashboard (Spec 22):** Health server becomes the foundation for a full REST API.
- **Webhook triggers:** Accept POST requests to trigger tasks on-demand.
- **File-watch triggers:** `fs.watch()` on directories to trigger tasks on file changes.
- **Metrics export:** Prometheus-compatible `/metrics` endpoint.
- **Alerting:** Emit events when health degrades for external monitoring integration.
