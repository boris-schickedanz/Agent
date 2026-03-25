# Spec 21 — Agent Delegation & Multi-Agent Profiles

> Status: **Implemented** | Owner: — | Last updated: 2026-03-25

## 1. Purpose

Enable the agent to delegate tasks to external coding tools (Claude Code, Codex) via background processes, and to support multiple agent personalities with distinct capabilities, memories, and tool access.

## 2. Agent Delegation

### 2.1 Delegation Manager

**File:** `src/core/delegation-manager.js`
**Class:** `DelegationManager`

Orchestrates delegated task lifecycle: spawning via ProcessManager, monitoring, result collection.

**Interface:**

```js
constructor({ processManager, runner, db, logger, config })

registerBackend(backend): void
async delegate(task: DelegationTask): string               // returns task ID
async checkStatus(taskId: string): DelegationStatus | null
async getResult(taskId: string): DelegationResult | null
async cancel(taskId: string): boolean
listActive(): DelegationStatus[]
```

**DelegationTask shape:**

```js
{
  backend: string,          // 'claude-code' | 'codex' | 'custom'
  task: string,             // Natural language task description
  workDir: string,          // Working directory (within sandbox)
  parentSessionId: string,  // For fan-out limits
  parentUserId: string,
  timeout: number,          // Max execution time in ms
}
```

**Execution path:** All delegation goes through `ProcessManager.startBackground()`. A timer enforces the timeout, killing the process and marking status as `'timeout'`. A polling interval (2s) watches for process exit to update status to `'completed'` or `'failed'`.

### 2.2 Delegation Backends

**File:** `src/core/delegation-backends.js`

Each backend is an object with `{ name, available(), buildCommand(task, workDir), parseOutput(stdout, stderr) }`.

**Built-in backends:**

| Backend | Command | Detection |
|---------|---------|-----------|
| `claude-code` | `claude --dangerously-skip-permissions -p "{task}"` | `which claude` / `where claude` |
| `codex` | `codex --approval-mode full-auto "{task}"` | `which codex` / `where codex` |
| `custom` | Task string is used as the command directly | Always available |

`getAllBackends()` returns the array of all built-in backends.

### 2.3 Delegation Tools

**File:** `src/tools/built-in/delegation-tools.js`
**Registration:** `registerDelegationTools(registry, delegationManager)`

All 3 tools are class `brokered`.

#### `delegate_task`

Spawn a sub-agent. Timeout: 30,000 ms (spawning only).

**Input:** `{ task, backend?, work_dir?, timeout_minutes? }` (task required).
**Returns:** Task ID and instructions to use `check_delegation`.

#### `check_delegation`

Check status and output. Timeout: 5,000 ms.

**Input:** `{ task_id }` (required).
**Returns:** Task info, status, duration, output (if completed).

#### `cancel_delegation`

Cancel a running task. Timeout: 10,000 ms.

**Input:** `{ task_id }` (required).

### 2.4 Fan-Out Limits

| Limit | Default | Config var |
|-------|---------|-----------|
| Max concurrent delegations (global) | 10 | `MAX_DELEGATIONS` |
| Max concurrent per parent session | 3 | `MAX_DELEGATIONS_PER_SESSION` |

Enforced by `DelegationManager.delegate()` — rejects with a clear error if limits exceeded.

## 3. Multi-Agent Profiles

### 3.1 Agent Profile

**File:** `src/agents/agent-profile.js`
**Class:** `AgentProfile`

An agent profile defines a named persona with its own personality, tool access, and memory scope.

**Profile format** (stored in `agents/{name}/AGENT.md`, parsed with `gray-matter`):

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
...
```

**Profile fields:** `name`, `description`, `model` (optional LLM override), `tools` (optional allowlist, null = inherit from role), `memoryNamespace` (optional, for isolated memory), `soul` (the markdown body — used as system prompt personality).

**Static factory:** `AgentProfile.fromFile(filePath)` parses the AGENT.md file.

### 3.2 Agent Registry

**File:** `src/agents/agent-registry.js`
**Class:** `AgentRegistry`

```js
constructor({ agentsDir, logger })

loadAll(): void                       // Scan agents/ directory for AGENT.md files
get(name: string): AgentProfile | null
getDefault(): null                    // Default agent uses SOUL.md (handled by PromptBuilder)
list(): AgentProfile[]
```

### 3.3 Integration with Existing Components

#### HostDispatcher

`buildRequest()` resolves agent profile from `session.metadata.agentName`:
- If profile has a `tools` allowlist, intersect with role-based policy.
- Pass `agentProfile: { name, soul }` in `sessionMetadata` for PromptBuilder.

#### PromptBuilder

`build()` checks `session.metadata.agentProfile.soul` — if present, uses it instead of `SOUL.md` for the system prompt personality. Also shows the agent profile name in the context section.

#### Session Binding

Sessions are bound to an agent profile via `session.metadata.agentName`:

1. **Explicit command:** `/agent code-reviewer` (via CommandRouter).
2. **Reset:** `/agent default` or `/agent reset` removes binding.
3. **List:** `/agent list` shows available profiles.

#### Memory Isolation

`PersistentMemory` and `MemorySearch` accept an optional `namespace` parameter:
- `PersistentMemory(dataDir, db, namespace)` stores files in `data/memory/{namespace}/`.
- `MemorySearch(db, namespace)` filters FTS5 results by `{namespace}:` key prefix.

> **Note:** The current wiring in `index.js` creates a single `PersistentMemory` and `MemorySearch` instance (no namespace). Per-profile memory switching would require creating instances per active namespace — the infrastructure is ready but not yet wired per-session.

## 4. Tool Policy Updates

`standard` profile denies delegation tools: `delegate_task`, `check_delegation`, `cancel_delegation`.

## 5. Design Decisions

| Decision | Rationale |
|----------|-----------|
| Profiles are config, not processes | An "agent" is a personality + tool set, not a separate running instance. Same AgentLoop serves all. |
| Backend abstraction for delegation | Avoids coupling to any specific coding tool. New backends are trivial to add. |
| Delegation via ProcessManager | Reuses existing infrastructure. No new process management code needed. |
| Session-level agent binding | Natural for chat workflows. User talks to "code-reviewer" for the duration of that session. |
| `getDefault()` returns null | The default agent is handled by PromptBuilder reading SOUL.md. No profile object needed. |
| Frontmatter parsed with gray-matter | Consistent with skills. No Zod validation (kept simple). |

## 6. Extension Points

- **Internal `agentcore` backend:** Delegate to another AgentCore profile via Runner (designed in data model, not yet implemented as a backend).
- **Per-session memory namespacing:** Wire namespace-specific PersistentMemory/MemorySearch per active agent profile.
- **Agent creation via chat:** `"Create a new agent called 'frontend-dev'"` → generates AGENT.md.
- **Agent marketplace:** Share agent profiles like skills.
- **Delegation monitoring:** Real-time streaming of delegation output to user via adapter.
- **Git-aware delegation:** Auto-create branches per delegated task, merge results.
- **Trigger prefix binding:** Skills-style trigger matching (e.g., `@code-reviewer` prefix).
