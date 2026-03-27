# Spec 24 — Apple Container Runtime

> Status: **In Progress** | Owner: — | Last updated: 2026-03-27

## 1. Purpose

Run the entire AgentCore process inside an Apple `container` (native macOS containerization on Apple Silicon) by default. This provides process isolation, reproducible environments, and security boundaries without Docker overhead. Falls back to direct execution when the `container` CLI is not available.

## 2. Requirements

- `npm start` and `agentcore start` auto-detect Apple `container` CLI and launch inside it
- Transparent fallback to direct execution if `container` CLI is absent
- Data directory volume-mounted for persistence across restarts
- Environment variables (API keys, config) passed through to the container
- Health port published for host access
- Console/interactive mode works (TTY passthrough)
- `CONTAINER_MODE` config to force or disable container usage
- Sentinel env var (`AGENTCORE_IN_CONTAINER=1`) prevents infinite recursion

## 3. Networking

On macOS 26 (Tahoe), each Apple container gets its own IP with full outbound internet access:
- **Anthropic API** — outbound HTTPS, works natively
- **Telegram Bot API** — outbound HTTPS polling + sending, works natively
- **Web fetch tool** — arbitrary HTTP/S, works natively
- **Health endpoint** — inbound via `--publish 9090:9090`

## 4. Components

### 4.1 Containerfile

**File:** `Containerfile` (project root)

OCI-compatible image definition based on `node:22-alpine`. Installs native build tools for `better-sqlite3`, copies project files, sets sentinel env var, and uses `node src/index.js` as entrypoint.

### 4.2 Container Launcher

**File:** `src/container/container-launcher.js`
**Class:** `ContainerLauncher`

Encapsulates container lifecycle: availability detection, image building, and process launching.

**Interface:**

```js
constructor({ projectRoot, logger })

isAvailable(): boolean          // checks `container --version`
imageExists(): boolean          // checks `container images ls` for agentcore image
build(): void                   // runs `container build -t agentcore .`
launch(options): ChildProcess   // runs `container run` with volumes, env, ports
```

**`launch()` flags:**
- `-v <projectRoot>/data:/app/data` — data persistence
- `-v <projectRoot>/workspace:/app/workspace` — sandbox workspace
- `--env-file .env` — if `.env` exists
- `-e KEY=VALUE` — for config env vars set in current shell
- `-e AGENTCORE_IN_CONTAINER=1` — sentinel
- `-e HEALTH_BIND=0.0.0.0` — so published port is reachable from host
- `--publish <healthPort>:9090`
- `-it` — when `process.stdin.isTTY` (console adapter)
- `--rm` — cleanup on exit

## 5. Configuration

| Variable | Default | Values | Description |
|----------|---------|--------|-------------|
| `CONTAINER_MODE` | `auto` | `auto`, `true`, `false` | `auto` = use if available, `true` = require, `false` = never |
| `AGENTCORE_IN_CONTAINER` | (unset) | `1` | Sentinel — set inside container to prevent re-wrapping |

## 6. Startup Logic (bin/agentcore.js)

`handleStart()` decision order:

1. `--daemon` → `container run --detach --name agentcore-daemon ...` (no PM2)
2. `AGENTCORE_IN_CONTAINER=1` → direct execution (already inside)
3. `--no-container` flag → direct execution
4. `CONTAINER_MODE=false` → direct execution
5. `container` CLI not found + `auto` → direct (silent fallback)
6. `container` CLI not found + `true` → error and exit
7. Image missing → auto-build (one-time)
8. Launch in container → forward signals → exit with child's exit code

`handleStop()` — stops `agentcore-daemon` container, falls back to PM2 for legacy.

`handleLogs()` — tails `agentcore-daemon` container logs (`-f` to follow), falls back to PM2.

`agentcore install` — writes `~/Library/LaunchAgents/com.agentcore.agent.plist` and loads it. launchd runs `agentcore start` (foreground container, no TTY) and keeps it alive: restarts on crash, starts on login.

`agentcore uninstall` — unloads and removes the plist.

`agentcore build` — explicit image rebuild.

## 7. Volume Mounts

| Host Path | Container Path | Purpose |
|-----------|---------------|---------|
| `./data` | `/app/data` | SQLite DB, memories |
| `./workspace` | `/app/workspace` | Sandbox for shell/fs tools |

Skills, agents, and SOUL.md are baked into the image at build time. Rebuild required after changes.

## 8. Affected Components

- **`package.json`** — `start` script changes to `node bin/agentcore.js start`
- **`bin/agentcore.js`** — `handleStart()` gains container wrapping; new `handleBuild()`
- **`src/config.js`** — new `containerMode` entry
- **`dev` script** — unchanged, always runs directly for fast iteration
- **PM2 daemon mode** — unchanged, does not use containers
