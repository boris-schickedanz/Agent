# Spec 21 — Agent Delegation & Multi-Agent Profiles

> Status: **Draft** | Owner: — | Last updated: 2026-03-25

## 1. Purpose

Enable the agent to delegate tasks to external coding tools (Claude Code, Codex, Cursor CLI) or other AgentCore instances running in background processes, and to support multiple agent personalities with distinct capabilities, memories, and tool access.

## 2. Agent Delegation

### 2.1 Delegation Manager

**File:** `src/core/delegation-manager.js`
**Class:** `DelegationManager`

Orchestrates delegated task lifecycle: spawning, monitoring, result collection.

**Interface:**

```js
constructor({ processManager, runner, db, logger, config })

async delegate(task: DelegationTask): string               // returns task ID
async checkStatus(taskId: string): DelegationStatus
async getResult(taskId: string): DelegationResult | null
async cancel(taskId: string): boolean
listActive(): DelegationStatus[]
```

**DelegationTask shape:**

```js
{
  backend: string,          // 'claude-code' | 'agentcore' | 'codex' | 'custom'
  task: string,             // Natural language task description
  workDir: string,          // Working directory (within sandbox)
  parentSessionId: string,  // For context and fan-out limits
  parentUserId: string,
  timeout: number,          // Max execution time in ms
  env?: object,             // Additional env vars for the subprocess
}
```

**DelegationStatus shape:**

```js
{
  taskId: string,
  backend: string,
  task: string,
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout',
  startedAt: number,
  completedAt: number | null,
  processId: string | null,   // From ProcessManager
}
```

**DelegationResult shape:**

```js
{
  taskId: string,
  status: string,
  output: string,             // Captured stdout/stderr (truncated)
  exitCode: number | null,
  durationMs: number,
  filesModified: string[],    // If detectable (git diff)
}
```

### 2.2 Delegation Backends

**File:** `src/core/delegation-backends.js`

Each backend knows how to start and monitor a specific external tool.

**Interface (per backend):**

```js
{
  name: string,
  available(): boolean,               // Check if tool is installed
  buildCommand(task, workDir): string, // Shell command to start it
  parseOutput(stdout, stderr): string, // Extract meaningful result
}
```

**Built-in backends:**

| Backend | Command | Detection |
|---------|---------|-----------|
| `claude-code` | `claude --dangerously-skip-permissions -p "{task}"` | `which claude` |
| `codex` | `codex --approval-mode full-auto "{task}"` | `which codex` |
| `agentcore` | Spawn another AgentCore instance via Runner (internal) | Always available |
| `custom` | User-provided command template | N/A |

### 2.3 Delegation Tools

**File:** `src/tools/built-in/delegation-tools.js`
**Registration:** `registerDelegationTools(registry, delegationManager)`

#### `delegate_task`

Spawn a sub-agent to handle a task autonomously.

| Field | Value |
|-------|-------|
| Class | `brokered` |
| Permissions | `agent:delegate` |
| Timeout | 30,000 ms (spawning only — the task runs in background) |

**Input schema:**

```json
{
  "type": "object",
  "properties": {
    "task": { "type": "string", "description": "Natural language task description" },
    "backend": { "type": "string", "enum": ["claude-code", "codex", "agentcore", "custom"], "description": "Which coding tool to use. Default: claude-code" },
    "work_dir": { "type": "string", "description": "Working directory (relative to workspace). Default: workspace root" },
    "timeout_minutes": { "type": "integer", "minimum": 1, "maximum": 60, "description": "Max time in minutes. Default: 15" }
  },
  "required": ["task"]
}
```

**Handler:** Calls `delegationManager.delegate()`, returns task ID and status.

#### `check_delegation`

Check status and output of a delegated task.

| Field | Value |
|-------|-------|
| Class | `brokered` |
| Permissions | `agent:delegate` |
| Timeout | 5,000 ms |

**Input schema:**

```json
{
  "type": "object",
  "properties": {
    "task_id": { "type": "string", "description": "Task ID from delegate_task" }
  },
  "required": ["task_id"]
}
```

#### `cancel_delegation`

Cancel a running delegated task.

| Field | Value |
|-------|-------|
| Class | `brokered` |
| Permissions | `agent:delegate` |
| Timeout | 10,000 ms |

### 2.4 Fan-Out Limits

As defined in Spec 10 §10.3:

| Limit | Default | Config var |
|-------|---------|-----------|
| Max concurrent delegations (global) | 10 | `MAX_DELEGATIONS` |
| Max concurrent per parent session | 3 | `MAX_DELEGATIONS_PER_SESSION` |

Enforced by `DelegationManager.delegate()` — rejects with a clear error if limits exceeded.

### 2.5 Execution Path

Delegated tasks do **not** go through `MessageQueue` (they would block the parent session). Instead:

```
delegate_task tool call
  → DelegationManager.delegate()
    → ProcessManager.startBackground(backend.buildCommand(...))
    → Store in delegation tracking table
    → Return task ID immediately

// Later, on check_delegation or task completion:
  → ProcessManager.getOutput(processId)
  → backend.parseOutput()
  → Return result
```

For `agentcore` backend (internal delegation):
```
  → runner.execute(createExecutionRequest({
      origin: ExecutionOrigin.DELEGATED_AGENT,
      sessionId: `delegation:${taskId}`,
      ...
    }))
```

## 3. Multi-Agent Profiles

### 3.1 Agent Profile

**File:** `src/agents/agent-profile.js`

An agent profile defines a named persona with its own personality, tool access, and memory scope.

**Profile format** (stored in `agents/{name}/AGENT.md`):

```markdown
---
name: code-reviewer
description: Expert code reviewer focused on quality and security
model: claude-sonnet-4-20250514
tools: [read_file, grep_search, list_directory, file_search]
memory_namespace: code-reviewer
---

You are a senior code reviewer. Your focus is on:
- Code quality and readability
- Security vulnerabilities
- Performance issues
- Test coverage gaps

Be thorough but constructive. Always explain *why* something is an issue.
```

**Profile schema (validated with Zod):**

```js
{
  name: string,                // Unique identifier (kebab-case)
  description: string,
  model: string | undefined,   // Override LLM model
  tools: string[] | undefined, // Allowlist (null = inherit from role)
  memory_namespace: string | undefined,  // Subdirectory for isolated memory
}
```

### 3.2 Agent Registry

**File:** `src/agents/agent-registry.js`
**Class:** `AgentRegistry`

**Interface:**

```js
constructor({ agentsDir, logger })

loadAll(): void                       // Scan agents/ directory
get(name: string): AgentProfile | null
getDefault(): AgentProfile            // The main agent (SOUL.md)
list(): AgentProfile[]
```

### 3.3 Integration with Existing Components

#### HostDispatcher

Extend `buildRequest()` to resolve agent profile:

```js
// After session resolution, before tool resolution:
const agentProfile = this.agentRegistry.get(session.metadata?.agentName)
                     || this.agentRegistry.getDefault();

// Use profile's tool restrictions (intersect with role-based policy)
// Use profile's memory namespace for memory search
// Pass profile's soul (body) as system prompt personality
```

#### PromptBuilder

Extend to accept a soul string instead of always reading `SOUL.md`:

```js
buildSystemPrompt({ soul, tools, skills, memories, context })
// soul parameter: profile body text (or SOUL.md content for default)
```

#### Session Binding

Sessions can be bound to an agent profile via metadata:

```js
session.metadata.agentName = 'code-reviewer';
```

**Binding methods:**

1. **Explicit command:** `/agent code-reviewer` (via CommandRouter) — binds current session to that profile.
2. **Delegation:** When delegating with `agentcore` backend, the task specifies a target agent profile.
3. **Trigger prefix:** Skills-style trigger matching (e.g., messages starting with `@code-reviewer`).

### 3.4 Memory Isolation

Each agent profile with a `memory_namespace` gets isolated persistent memory:

- Files in `data/memory/{namespace}/` instead of `data/memory/`
- Separate FTS5 index (prefixed table or namespace column)
- `MemorySearch` and `PersistentMemory` accept an optional `namespace` parameter

## 4. Design Decisions

| Decision | Rationale |
|----------|-----------|
| Profiles are config, not processes | An "agent" is a personality + tool set, not a separate running instance. Same AgentLoop serves all. Keeps resource usage constant. |
| Backend abstraction for delegation | Avoids coupling to any specific coding tool. New backends are trivial to add. |
| Delegation via ProcessManager | Reuses existing infrastructure. No new process management code needed. |
| Session-level agent binding | Natural for chat workflows. User talks to "code-reviewer" for the duration of that session. |
| Memory namespace isolation | Prevents cross-contamination. The main agent's memories don't pollute the code reviewer's context. |
| `DELEGATED_AGENT` origin (from Spec 10) | Already defined in the codebase. Internal delegations use the existing runner contract. |

## 5. Extension Points

- **Agent-to-agent communication:** Agents can invoke other agent profiles as tools (not just external backends).
- **Agent creation via chat:** `"Create a new agent called 'frontend-dev' that specializes in React"` → generates AGENT.md.
- **Agent marketplace:** Share agent profiles like skills (same distribution mechanism).
- **Delegation monitoring:** Real-time streaming of delegation output to user via adapter.
- **Git-aware delegation:** Auto-create branches per delegated task, merge results.
