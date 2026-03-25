# Spec 18 — Shell Execution & Process Management

> Status: **Draft** | Owner: — | Last updated: 2026-03-25

## 1. Purpose

Give the agent the ability to run shell commands (npm, git, build tools, tests) and manage long-running processes (dev servers, builds, tmux sessions). This is the critical capability that enables autonomous coding workflows — without it, the agent cannot run tests, install dependencies, or interact with version control.

## 2. Components

### 2.1 Process Manager

**File:** `src/process/process-manager.js`
**Class:** `ProcessManager`

Manages child processes spawned by shell tools. Tracks running processes, captures output, enforces timeouts.

**Interface:**

```js
constructor({ sandbox, logger, maxProcesses?, defaultTimeoutMs? })

async run(command, { cwd?, env?, timeoutMs?, maxOutput? }): ProcessResult
async startBackground(command, { cwd?, env?, label? }): string   // returns process ID
getStatus(processId): ProcessInfo | null
getOutput(processId, { tail? }): string
kill(processId, signal?): boolean
listActive(): ProcessInfo[]
shutdownAll(): Promise<void>
```

**ProcessResult shape:**

```js
{
  exitCode: number,
  stdout: string,        // Truncated to maxOutput (default 50KB)
  stderr: string,        // Truncated to maxOutput
  durationMs: number,
  timedOut: boolean,
  truncated: boolean,    // true if output was truncated
}
```

**ProcessInfo shape:**

```js
{
  id: string,            // UUID
  command: string,
  label: string,         // Human-friendly name (e.g., "npm test")
  cwd: string,
  startedAt: number,
  status: 'running' | 'exited',
  exitCode: number | null,
}
```

**Implementation details:**

- Uses `child_process.spawn()` with `shell: true` for cross-platform compatibility.
- **Output buffering:** Ring buffer per process, retaining last `maxOutput` bytes. Older output is discarded.
- **Timeout enforcement:** For `run()`, uses `setTimeout` + `SIGTERM`. If process doesn't exit within 5s after SIGTERM, sends `SIGKILL`.
- **Background processes:** Tracked in `Map<processId, ProcessHandle>`. Capped at `maxProcesses` (default 10). New spawns rejected if at capacity.
- **Cleanup:** `shutdownAll()` sends SIGTERM to all active processes, waits 5s, then SIGKILL. Called during graceful shutdown.

**Security constraints:**

- `cwd` is always resolved through `sandbox.resolve()`.
- Commands that write output files — the agent should be instructed (via system prompt) to keep outputs within workspace. The sandbox enforces this for file tools but cannot fully control shell commands (defense in depth, not prevention).

### 2.2 Shell Tools

**File:** `src/tools/built-in/shell-tools.js`
**Registration:** `registerShellTools(registry, processManager, sandbox)`

#### `run_command`

Execute a shell command and return output.

| Field | Value |
|-------|-------|
| Class | `brokered` |
| Permissions | `shell:execute` |
| Timeout | 120,000 ms (2 minutes) |

**Input schema:**

```json
{
  "type": "object",
  "properties": {
    "command": { "type": "string", "description": "Shell command to execute" },
    "cwd": { "type": "string", "description": "Working directory (relative to workspace). Default: workspace root" },
    "timeout_seconds": { "type": "integer", "minimum": 1, "maximum": 300, "description": "Command timeout in seconds. Default: 60" }
  },
  "required": ["command"]
}
```

**Handler behavior:**

1. Resolve `cwd` via sandbox (default: workspace root).
2. Call `processManager.run(command, { cwd, timeoutMs })`.
3. Format output:
   ```
   Exit code: {code}

   STDOUT:
   {stdout}

   STDERR:
   {stderr}
   ```
4. If timed out: append `"\n[Command timed out after {n}s]"`.
5. If truncated: prepend `"[Output truncated to last 50KB]\n"`.

#### `run_command_background`

Start a long-running process in the background.

| Field | Value |
|-------|-------|
| Class | `brokered` |
| Permissions | `shell:execute` |
| Timeout | 10,000 ms |

**Input schema:**

```json
{
  "type": "object",
  "properties": {
    "command": { "type": "string", "description": "Shell command to run in background" },
    "cwd": { "type": "string", "description": "Working directory. Default: workspace root" },
    "label": { "type": "string", "description": "Friendly name for this process (e.g., 'dev-server')" }
  },
  "required": ["command"]
}
```

**Handler:** Start via `processManager.startBackground()`. Return `"Started background process '{label}' (ID: {id})"`.

#### `check_process`

Check status and recent output of a background process.

| Field | Value |
|-------|-------|
| Class | `brokered` |
| Permissions | `shell:execute` |
| Timeout | 5,000 ms |

**Input schema:**

```json
{
  "type": "object",
  "properties": {
    "process_id": { "type": "string", "description": "Process ID returned by run_command_background" },
    "tail": { "type": "integer", "minimum": 1, "maximum": 200, "description": "Number of output lines to show. Default: 50" }
  },
  "required": ["process_id"]
}
```

#### `kill_process`

Terminate a background process.

| Field | Value |
|-------|-------|
| Class | `brokered` |
| Permissions | `shell:execute` |
| Timeout | 10,000 ms |

**Input schema:**

```json
{
  "type": "object",
  "properties": {
    "process_id": { "type": "string", "description": "Process ID to terminate" }
  },
  "required": ["process_id"]
}
```

#### `list_processes`

List all active background processes.

| Field | Value |
|-------|-------|
| Class | `brokered` |
| Permissions | `shell:execute` |
| Timeout | 5,000 ms |

**Input:** none.
**Output:** Table of active processes with ID, label, command, status, uptime.

### 2.4 Container Sandbox (Optional Shell Isolation)

When `SHELL_CONTAINER` is enabled, the ProcessManager executes all shell commands inside a lightweight container instead of directly on the host. This provides process-level and filesystem-level isolation as a defense-in-depth layer on top of the path-based Sandbox (Spec 16) and the Approval Workflow (Spec 19).

**Why only shell commands?** The agent process itself is trusted code — containerizing it adds deployment friction (volume mounts, networking, port mapping) for no security benefit. The untrusted part is what the LLM tells the shell to do. Isolating just the shell commands gives real protection with zero impact on the agent's architecture.

**How it works:**

When `SHELL_CONTAINER` is set, `ProcessManager` maintains a long-lived sandbox container with the workspace mounted. Commands are executed via `container exec` instead of direct `child_process.spawn()`.

```js
// ProcessManager.run() — internal dispatch
if (this.containerMode) {
  // Execute inside the sandbox container
  return this._runInContainer(command, { cwd, env, timeoutMs, maxOutput });
} else {
  // Execute directly on the host
  return this._runDirect(command, { cwd, env, timeoutMs, maxOutput });
}
```

**Container lifecycle:**

```js
// On startup (if SHELL_CONTAINER is enabled):
//   1. Build/pull the sandbox image (once)
//   2. Start a persistent container with workspace mounted
//
// On each run_command:
//   container exec agentcore-sandbox sh -c "cd /workspace/subdir && <command>"
//
// On shutdown:
//   container stop agentcore-sandbox
```

**Sandbox container image** (`Containerfile.sandbox`):

```dockerfile
FROM node:22-alpine
RUN apk add --no-cache git python3 make g++
WORKDIR /workspace
```

A minimal image with common build tools. The workspace directory is bind-mounted at runtime so the container sees the same files as the host.

**Container startup** (handled by ProcessManager):

```bash
container run -d --name agentcore-sandbox \
  -v ${WORKSPACE_DIR}:/workspace \
  agentcore-sandbox \
  sleep infinity
```

**Platform support:**

| Platform | Container runtime | Notes |
|----------|------------------|-------|
| macOS (Apple Silicon) | Apple Containers | Native, near-native performance |
| macOS / Linux | Podman | Rootless, no daemon |
| Any | Docker | Works everywhere |

The `SHELL_CONTAINER_RUNTIME` config selects the CLI (`container`, `podman`, or `docker`). Default: auto-detect.

**Configuration:**

| Env var | Default | Description |
|---------|---------|-------------|
| `SHELL_CONTAINER` | `false` | Enable container-sandboxed shell execution |
| `SHELL_CONTAINER_RUNTIME` | auto | Container CLI: `container`, `podman`, or `docker` |
| `SHELL_CONTAINER_IMAGE` | `agentcore-sandbox` | Image name for the sandbox container |

### 2.5 Terminal Session Manager (Future — Phase 2)

**File:** `src/process/terminal-session-manager.js`
**Class:** `TerminalSessionManager`

Wraps tmux (Linux/macOS) or ConPTY (Windows) for persistent terminal sessions that survive agent restarts.

**Interface:**

```js
constructor({ logger })

create(name: string, { cwd?, command? }): string          // session ID
sendCommand(sessionId: string, command: string): void
readOutput(sessionId: string, lines?: number): string
list(): SessionInfo[]
close(sessionId: string): void
reconnectAll(): void    // Called on startup to reattach orphaned sessions
```

**Design notes:**

- On Linux/macOS: uses `tmux new-session -d -s {name}` etc.
- On Windows: uses `child_process` with PowerShell background jobs (tmux unavailable).
- `reconnectAll()` checks for existing tmux sessions with a known prefix (e.g., `agent_`) on startup.
- This component is Phase 2 — the basic `ProcessManager` is sufficient for Phase 1.

## 3. Tool Policy Updates

Add to `src/security/tool-policy.js`:

```js
standard: {
  allow: [
    // ... existing tools ...
    // Shell tools NOT included — admin only initially
  ],
  deny: ['http_post', 'write_file', 'edit_file',
         'run_command', 'run_command_background', 'kill_process'],
},
```

Shell tools are **admin-only** until the approval workflow (Spec 19) is implemented.

## 4. Graceful Shutdown

Extend `src/index.js` shutdown sequence:

```js
// After runner.shutdown()
await processManager.shutdownAll();
```

## 5. Design Decisions

| Decision | Rationale |
|----------|-----------|
| `shell: true` in spawn | Cross-platform. Allows pipes, redirects, chaining. |
| Ring buffer for output | Prevents unbounded memory growth from verbose processes. |
| 2-minute default timeout for `run_command` | Most build/test commands complete within this. Long-running tasks use background processes. |
| No stdin support initially | Simplifies implementation. Interactive commands should use terminal sessions (Phase 2). |
| Background processes capped at 10 | Prevents resource exhaustion. |
| Admin-only until approval workflow | Shell execution is the highest-risk capability. |
| SIGTERM → SIGKILL escalation | Gives processes a chance to clean up gracefully. |
| Container sandbox isolates shell commands, not the agent | The agent is trusted code. Only LLM-driven shell commands are untrusted. Isolating just the shell avoids deployment friction while providing real protection. |
| Long-lived sandbox container | Avoids per-command container startup overhead. `container exec` into a running container is near-instant. |
| Auto-detect container runtime | Works with Apple Containers, Podman, or Docker — whatever the user has installed. |

## 6. Extension Points

- **Approval integration (Spec 19):** Allow standard users to run shell commands with per-command approval.
- **Command allowlisting:** Configurable whitelist of safe commands that skip approval (e.g., `npm test`, `git status`).
- **Terminal sessions (Phase 2):** Persistent tmux/ConPTY sessions for interactive workflows.
- **Output streaming:** Stream shell output to the user in real-time via adapter streaming events.
- **Container network isolation:** Disable outbound network in the sandbox container for maximum security (agent brokers HTTP requests through host).
