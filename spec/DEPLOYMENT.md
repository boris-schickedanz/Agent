# Deployment & Runtime Setup

AgentCore runs as an always-on service inside an Apple container on macOS (Apple Silicon). launchd ensures the process restarts on crash and starts on login/boot.

## Stack Overview

```
launchd (com.agentcore.agent)
  └─ node bin/agentcore.js start        (host process)
       └─ container run ... agentcore   (Apple container)
            └─ node src/index.js        (inside container)
```

## Apple Container (Spec 24)

The agent runs inside a native macOS container (Apple Silicon only, macOS 26 Tahoe). No Docker required.

- `agentcore start` auto-detects the `container` CLI and launches inside it
- Transparent fallback to direct execution if the CLI is absent (`CONTAINER_MODE=auto`)
- OCI-compatible `Containerfile` based on `node:22-alpine` (project root)
- Sentinel env var `AGENTCORE_IN_CONTAINER=1` prevents recursive container wrapping
- Each container gets its own IP; outbound HTTPS works natively
- Health port published to host via `--publish 9090:9090`

### Volume Mounts

| Host Path | Container Path | Purpose |
|-----------|---------------|---------|
| `./data` | `/app/data` | SQLite DB, memories |
| `./workspace` | `/app/workspace` | Sandbox for shell/fs tools |

Skills, agents, and SOUL.md are baked into the image at build time. Rebuild required after changes (`agentcore build`).

Key files: `Containerfile`, `src/container/container-launcher.js`

## agentcore CLI (Spec 22)

Entry point: `bin/agentcore.js` (registered as `agentcore` in `package.json` `bin` field).

### Deployment-relevant commands

| Command | Purpose |
|---------|---------|
| `agentcore start` | Foreground, in container by default |
| `agentcore start --daemon` | Detached container (`container run --detach`) |
| `agentcore start --no-container` | Direct execution, no container |
| `agentcore stop` | Stop daemon (checks container → PM2 fallback) |
| `agentcore install` | Write launchd plist and load it (boot persistence) |
| `agentcore uninstall` | Unload and remove launchd plist |
| `agentcore build` | Rebuild container image |
| `agentcore status` | Query health endpoint |
| `agentcore logs [-f]` | Tail logs (container → PM2 fallback) |
| `agentcore onboard` | Interactive setup wizard (writes `.env`) |

## launchd Service (Specs 20, 25)

`agentcore install` writes a plist to `~/Library/LaunchAgents/com.agentcore.agent.plist` and loads it via `launchctl`.

### Plist behavior

- **`RunAtLoad: true`** — starts on login
- **`KeepAlive: true`** — restarts on crash
- **`ThrottleInterval: 10`** — prevents rapid crash loops from triggering launchd back-off
- Captures current `PATH` so launchd can find the `container` CLI
- Logs to `<project>/logs/out.log` and `<project>/logs/error.log`

Key file: `src/container/launchd-installer.js`

### Boot Resilience (Spec 25)

After a Mac reboot, the Apple container system daemon takes time to initialize. `ContainerLauncher.ensureSystemRunning()` uses a retry loop (up to ~60s) to wait for the container system before launching. Without this, the agent would crash immediately post-reboot and potentially trigger launchd's internal back-off.

If the launchd plist was created before Spec 25, reinstall to pick up `ThrottleInterval`:

```bash
agentcore uninstall && agentcore install
```

## Startup Decision Tree

`handleStart()` in `bin/agentcore.js` follows this priority:

1. `--daemon` flag → `container run --detach --name agentcore-daemon ...`
2. `AGENTCORE_IN_CONTAINER=1` → direct execution (already inside container)
3. `--no-container` flag → direct execution
4. `CONTAINER_MODE=false` → direct execution
5. `container` CLI not found + `auto` mode → direct (silent fallback)
6. `container` CLI not found + `true` mode → error and exit
7. Image missing → auto-build (one-time), then launch
8. Launch in container → forward signals → exit with child's exit code

## Health Endpoint (Spec 20)

- `GET /health` on port 9090 (configurable via `HEALTH_PORT`)
- Bound to `127.0.0.1` by default; set to `0.0.0.0` inside container
- Returns `healthy`/`unhealthy` based on database connectivity
- `agentcore status` queries this endpoint

## Configuration Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTAINER_MODE` | `auto` | `auto` = use if available, `true` = require, `false` = never |
| `AGENTCORE_IN_CONTAINER` | (unset) | Sentinel — set to `1` inside container |
| `HEALTH_PORT` | `9090` | Health endpoint port (0 to disable) |
| `HEALTH_BIND` | `127.0.0.1` | Health bind address |

## Quick Start (Production)

```bash
# 1. Initial setup
agentcore onboard          # interactive wizard, writes .env

# 2. Build container image (happens automatically on first start)
agentcore build

# 3. Install as always-on service
agentcore install          # writes launchd plist, starts immediately

# 4. Verify
agentcore status           # should show "healthy"
agentcore logs -f          # follow logs
```

## Related Specs

- [Spec 24 — Apple Container Runtime](24-apple-container-runtime.md)
- [Spec 22 — CLI & Platform](22-cli-and-platform.md)
- [Spec 20 — Daemon & Health](20-daemon-and-health.md)
- [Spec 25 — Boot Resilience](25-boot-resilience.md)
