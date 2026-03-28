# Spec 18 — Shell Execution & Process Management

> Status: **Implemented** | Owner: — | Last updated: 2026-03-25

## 1. Purpose

Give the agent the ability to run shell commands (npm, git, build tools, tests) and manage long-running processes (dev servers, builds). This is the critical capability that enables autonomous coding workflows — without it, the agent cannot run tests, install dependencies, or interact with version control.

## 2. Components

### 2.1 Process Manager

**File:** `src/process/process-manager.js`
**Class:** `ProcessManager`

Manages child processes spawned by shell tools. Tracks running processes, captures output, enforces timeouts.

**Interface:**

```js
constructor({ sandbox, logger, maxProcesses?, defaultTimeoutMs?,
              containerMode?, containerRuntime?, containerImage? })

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

**Implementation details:**

- Uses `child_process.spawn()` with `shell: true` for cross-platform compatibility.
- **Output buffering:** `RingBuffer` class per process (internal), retaining last `maxOutput` bytes. Older output is discarded.
- **Timeout enforcement:** For `run()`, uses `setTimeout` + `SIGTERM`. If process doesn't exit within 5s after SIGTERM, sends `SIGKILL`.
- **Background processes:** Tracked in `Map<processId, ProcessHandle>`. Capped at `maxProcesses` (default 10). New spawns rejected if at capacity.
- **Cleanup:** `shutdownAll()` sends SIGTERM to all active processes, waits 5s, then SIGKILL. Called during graceful shutdown. Also stops sandbox container if running.

**Security constraints:**

- `cwd` is always resolved through `sandbox.resolve()`.
- Commands that write output files — the sandbox enforces this for file tools but cannot fully control shell commands (defense in depth, not prevention).

### 2.2 Shell Tools

**File:** `src/tools/built-in/shell-tools.js`
**Registration:** `registerShellTools(registry, processManager, sandbox)`

All 5 tools are class `brokered`.

#### `run_command`

Execute a shell command and return output. Timeout: 120,000 ms.

**Input:** `{ command, cwd?, timeout_seconds? }` (command required).
**Output format:** `Exit code: {code}\nSTDOUT:\n{stdout}\nSTDERR:\n{stderr}` with timeout/truncation notices.

#### `run_command_background`

Start a long-running process in the background. Timeout: 10,000 ms.

**Input:** `{ command, cwd?, label? }` (command required).
**Returns:** `"Started background process '{label}' (ID: {id})"`.

#### `check_process`

Check status and recent output of a background process. Timeout: 5,000 ms.

**Input:** `{ process_id, tail? }` (process_id required).
**Returns:** Process info with label, status, exit code, uptime, and recent output.

#### `kill_process`

Terminate a background process. Timeout: 10,000 ms.

**Input:** `{ process_id }` (required).

#### `list_processes`

List all active background processes. Timeout: 5,000 ms.

**Input:** none.
**Output:** Table of active processes with ID, status, uptime, label.

### 2.3 Container Sandbox (Optional Shell Isolation)

When `SHELL_CONTAINER=true`, ProcessManager executes all shell commands inside a long-lived container instead of directly on the host. Commands are dispatched via `container exec`.

**Container lifecycle:**
1. On first `run()` or `startBackground()`: auto-start a persistent container with workspace bind-mounted at `/workspace`.
2. On each command: `{runtime} exec agentcore-sandbox sh -c "cd /workspace/subdir && <command>"`.
3. On shutdown: `{runtime} stop agentcore-sandbox`.

**Runtime auto-detection** tries `container`, `podman`, `docker` in order, falling back to `docker`.

**Configuration:**

| Env var | Default | Description |
|---------|---------|-------------|
| `SHELL_CONTAINER` | `false` | Enable container-sandboxed shell execution |
| `SHELL_CONTAINER_RUNTIME` | auto | Container CLI: `container`, `podman`, or `docker` |
| `SHELL_CONTAINER_IMAGE` | `agentcore-sandbox` | Image name for the sandbox container |

> **Note:** No `Containerfile.sandbox` is shipped. Users must build or provide their own sandbox image. A suggested base is `node:22-alpine` with `git`, `python3`, `make`, `g++`.

## 3. Tool Policy Updates

All shell tools are available in the single-user model ([Spec 32](32-single-user-migration.md)). Shell tools (`run_command`, `run_command_background`, `kill_process`) require approval via the approval workflow ([Spec 19](19-approval-workflow.md)).

## 4. Graceful Shutdown

In `src/index.js` shutdown sequence:

```js
await processManager.shutdownAll();
```

## 5. Design Decisions

| Decision | Rationale |
|----------|-----------|
| `shell: true` in spawn | Cross-platform. Allows pipes, redirects, chaining. |
| Ring buffer for output | Prevents unbounded memory growth from verbose processes. |
| 2-minute default timeout for `run_command` | Most build/test commands complete within this. Long-running tasks use background processes. |
| No stdin support | Simplifies implementation. Interactive commands should use future terminal sessions. |
| Background processes capped at 10 | Prevents resource exhaustion. |
| SIGTERM → SIGKILL escalation | Gives processes a chance to clean up gracefully. |
| Container sandbox isolates shell commands, not the agent | The agent is trusted code. Only LLM-driven shell commands are untrusted. |
| Long-lived sandbox container | Avoids per-command container startup overhead. `container exec` is near-instant. |

## 6. Extension Points

- **Terminal sessions:** Persistent tmux/ConPTY sessions for interactive workflows (`src/process/terminal-session-manager.js` — designed but not yet implemented).
- **Command allowlisting:** Configurable whitelist of safe commands that skip approval (e.g., `npm test`, `git status`).
- **Output streaming:** Stream shell output to the user in real-time via adapter streaming events.
- **Container network isolation:** Disable outbound network in the sandbox container.
- **Containerfile:** Ship a default `Containerfile.sandbox` with common build tools.
