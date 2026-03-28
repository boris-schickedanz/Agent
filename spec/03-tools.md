# Spec 03 — Tool System

> Status: **Implemented** | Owner: — | Last updated: 2026-03-27

## 1. Purpose

The tool system provides the agent with capabilities beyond text generation. Tools are the atomic units of agent action — each is a function with a JSON Schema interface that the LLM can invoke.

## 2. Components

### 2.1 Tool Registry

**File:** `src/tools/tool-registry.js`
**Class:** `ToolRegistry`

Central registry for all tools (built-in, skill-derived, and custom).

**Interface:**

```js
register(toolDef: ToolDefinition): void
get(name: string): ToolDefinition | null
getAll(): ToolDefinition[]
getSchemas(filterNames?: Set<string> | null): AnthropicToolSchema[]
unregister(name: string): void
has(name: string): boolean
```

**`getSchemas(filterNames)`** returns tool definitions in Anthropic API format:

```js
{ name: string, description: string, input_schema: JSONSchema }
```

If `filterNames` is `null`, all tools are returned (used for admin users with full access). If it's a `Set`, only matching tools are included.

### 2.2 Tool Definition Shape

Every tool registered with the system MUST conform to this shape:

```js
{
  name: string,           // Unique, lowercase, kebab-case (e.g., 'http_get')
  class: string,          // 'runtime' | 'brokered' | 'host' (default: 'runtime')
  description: string,    // Human-readable, sent to the LLM
  inputSchema: {          // JSON Schema object
    type: 'object',
    properties: { ... },
    required: [ ... ]     // Optional
  },
  handler: async (input: object, context: ToolContext) => string,
  permissions: string[],  // Required permission scopes (e.g., ['network:outbound'])
  timeout: number         // Max execution time in ms (default: 30,000)
}
```

**ToolContext shape** (passed to every handler):

```js
{
  sessionId: string,
  userId: string,
  channelId: string,
  logger: Logger
}
```

**Handler contract:**
- MUST return a `string` (or a value that will be `JSON.stringify`'d).
- MUST NOT throw for expected error conditions — return an error description string instead.
- MAY throw for unexpected errors (these are caught by the executor).
- MUST respect the timeout; long-running work should be cancellable.

### 2.3 Tool Executor

**File:** `src/tools/tool-executor.js`
**Class:** `ToolExecutor`

Executes tool calls with validation, permission checking, timeout enforcement, and error handling.

**Interface:**

```js
async execute(
  toolName: string,
  toolInput: object,
  session: Session
): Promise<ToolResult>
```

**ToolResult shape:**

```js
{
  success: boolean,
  result: string | null,
  error: string | null,
  durationMs: number
}
```

**Constructor:**

```js
constructor(registry: ToolRegistry, toolPolicy: ToolPolicy, logger: Logger, options?: {
  auditLogger?: AuditLogger,
  approvalManager?: ApprovalManager
})
```

**Execution flow:**

1. **Lookup** — `toolRegistry.get(toolName)`. If not found → `{ success: false, error: 'Unknown tool' }`.
2. **Permission check** — `toolPolicy.isAllowed(toolName, session.userId, session)`. If denied → `{ success: false, error: 'Permission denied' }`.
2b. **Approval check** — if `approvalManager` is present and `approvalManager.needsApproval(toolName, session)` returns true, the executor returns `{ awaitingApproval: true }` with a formatted approval prompt. The pending request is stored via `approvalManager.setPending()`. See [Spec 19](19-approval-workflow.md).
3. **Input validation** — `validateInput(toolInput, tool.inputSchema)`. If invalid → `{ success: false, error: 'Invalid input: ...' }`.
4. **Execution** — `Promise.race([handler(input, context), timeoutPromise])`.
5. **Result coercion** — if handler returns non-string, `JSON.stringify` it.
6. **Audit logging** — if `auditLogger` is present, log tool name, input, output, duration, and success status.
7. **Logging** — log tool name and duration on success; log error on failure.

### 2.4 Tool Schema Validation

**File:** `src/tools/tool-schema.js`

**Exports:**

```js
jsonSchemaToZod(schema: JSONSchema): ZodSchema
validateInput(input: object, schema: JSONSchema): { valid: boolean, data?: any, errors: string[] }
```

**Supported JSON Schema types:** `string` (with `minLength`, `maxLength`, `enum`), `number`, `integer` (with `minimum`, `maximum`), `boolean`, `array` (with `items`), `object` (with `properties`, `required`).

Unsupported types fall back to `z.any()`.

## 3. Built-in Tools

### 3.1 System Tools

**File:** `src/tools/built-in/system-tools.js`
**Registration:** `registerSystemTools(registry)`

| Tool | Class | Description | Input | Permissions |
|------|-------|-------------|-------|-------------|
| `get_current_time` | `runtime` | Current date/time in a given timezone | `{ timezone?: string }` — IANA name, default UTC | None |
| `wait` | `runtime` | Async sleep | `{ seconds: number }` — 1-30, clamped | None |

### 3.2 HTTP Tools

**File:** `src/tools/built-in/http-tools.js`
**Registration:** `registerHttpTools(registry)`

| Tool | Class | Description | Input | Permissions |
|------|-------|-------------|-------|-------------|
| `http_get` | `brokered` | Fetch a URL (GET) | `{ url: string, headers?: object }` | `network:outbound` |
| `http_post` | `brokered` | POST JSON to a URL | `{ url: string, body?: object, headers?: object }` | `network:outbound` |

**Constraints:**
- Request timeout: 15 seconds (`AbortSignal.timeout`)
- Tool timeout: 20 seconds
- Response truncation: 10,000 characters max
- Non-OK responses return `HTTP {status}: {body}` (truncated to 1,000 chars)

### 3.3 Memory Tools

**File:** `src/tools/built-in/memory-tools.js`
**Registration:** `registerMemoryTools(registry, persistentMemory, memorySearch, projectManager)`

| Tool | Class | Description | Input | Permissions |
|------|-------|-------------|-------|-------------|
| `save_memory` | `brokered` | Save to persistent memory. Workspace state keys (`project_state`, `decision_journal`, `session_log`) route to the active project when one exists. | `{ key: string, content: string }` | `memory:write` |
| `search_memory` | `brokered` | FTS5 search across memories | `{ query: string, limit?: number (1-20, default 5) }` | `memory:read` |
| `list_memories` | `brokered` | List all memory keys | (none) | `memory:read` |
| `switch_project` | `brokered` | Switch active project context (creates if new). See [Spec 31](31-multi-project.md). | `{ name: string }` | `memory:write` |

### 3.4 File System Tools

**File:** `src/tools/built-in/fs-tools.js`
**Registration:** `registerFsTools(registry, sandbox)`

All file system tools use the Sandbox for path resolution and access control. See [Spec 17](17-workspace-tools.md) for full details.

| Tool | Class | Description | Approval Required |
|------|-------|-------------|-------------------|
| `read_file` | `brokered` | Read file contents with line numbers | No |
| `write_file` | `brokered` | Create or overwrite a file (atomic write) | Yes |
| `edit_file` | `brokered` | Search-and-replace edit (unique match required) | Yes |
| `list_directory` | `brokered` | Recursive listing up to depth 3 | No |
| `file_search` | `brokered` | Glob pattern file search | No |
| `grep_search` | `brokered` | Regex content search across files | No |

### 3.5 Shell Tools

**File:** `src/tools/built-in/shell-tools.js`
**Registration:** `registerShellTools(registry, processManager, sandbox)`

Shell tools use the ProcessManager for execution and the Sandbox for working directory resolution. See [Spec 18](18-shell-execution.md) for full details.

| Tool | Class | Description | Approval Required |
|------|-------|-------------|-------------------|
| `run_command` | `brokered` | Execute a shell command (120s timeout) | Yes |
| `run_command_background` | `brokered` | Spawn a background process | Yes |
| `check_process` | `brokered` | Check status and tail output of a process | No |
| `kill_process` | `brokered` | Terminate a background process | Yes |
| `list_processes` | `brokered` | List all active background processes | No |

### 3.6 Delegation Tools

**File:** `src/tools/built-in/delegation-tools.js`
**Registration:** `registerDelegationTools(registry, delegationManager)`

Delegation tools allow the agent to spawn sub-agents (Claude Code, Codex, or custom). See [Spec 21](21-agent-delegation.md) for full details.

| Tool | Class | Description | Approval Required |
|------|-------|-------------|-------------------|
| `delegate_task` | `brokered` | Spawn a sub-agent to handle a task | Yes |
| `check_delegation` | `brokered` | Check status of a delegated task | No |
| `cancel_delegation` | `brokered` | Cancel a running delegation | Yes |

## 4. Adding a New Built-in Tool

1. Create `src/tools/built-in/<name>-tools.js` exporting a `register<Name>Tools(registry, ...deps)` function.
2. Define one or more tools using `registry.register({ name, description, inputSchema, handler, permissions })`.
3. Call the registration function in `src/index.js`, passing any required dependencies.
4. Add the tool name to the appropriate policy profile(s) in `src/security/tool-policy.js`.
5. Update this spec with the tool's entry in the built-in tools table.

## 5. Tool Classes and Trust Boundaries

Each tool is assigned a `class` that determines its trust boundary relative to the host/runtime split (see [Spec 10](10-host-runtime-boundary.md)). The class field defaults to `'runtime'` if not specified during registration.

### 5.1 Class Definitions

| Class | Description | Examples |
|-------|-------------|----------|
| `runtime` | Executes entirely within the runtime. Pure computation or stateless operations. No access to persistent storage, file system, or network (in a sandboxed runtime). Safe to run in a container without special permissions. | `get_current_time`, `wait`, skill pseudo-tools |
| `brokered` | Invoked by the LLM like a runtime tool, but execution crosses the host/runtime boundary. In `LocalRunner`, brokering is a no-op — the tool handler closure captures host-side references (e.g., `persistentMemory`, `memorySearch`). In a future container runner, the runtime would send a structured request over a bridge to the host. | `http_get`, `http_post`, `save_memory`, `search_memory`, `list_memories` |
| `host` | Host-only tools not exposed to the LLM. Callable only through host-side APIs (admin commands, management endpoints). | (none currently — reserved for future admin tools) |

### 5.2 Classification Criteria

| Criterion | Runtime | Brokered | Host |
|-----------|---------|----------|------|
| Accesses database? | No | Yes (via host) | Yes (directly) |
| Accesses file system? | No | Yes (via host) | Yes (directly) |
| Makes network calls? | No (in sandbox) | Yes (via host) | Yes (directly) |
| Invoked by LLM? | Yes | Yes | No |
| Runs in sandbox? | Yes | Proxy in sandbox, execution on host | No |
| Requires host credentials? | No | Yes (host provides) | Yes |

### 5.3 Summary Table

| Tool | File | Class | Side Effects |
|------|------|-------|-------------|
| `get_current_time` | `system-tools.js` | `runtime` | None |
| `wait` | `system-tools.js` | `runtime` | None |
| `http_get` | `http-tools.js` | `brokered` | Outbound network request |
| `http_post` | `http-tools.js` | `brokered` | Outbound network request, external state mutation |
| `save_memory` | `memory-tools.js` | `brokered` | File system write, database write |
| `search_memory` | `memory-tools.js` | `brokered` | Database read |
| `list_memories` | `memory-tools.js` | `brokered` | File system read |
| `read_file` | `fs-tools.js` | `brokered` | File system read |
| `write_file` | `fs-tools.js` | `brokered` | File system write |
| `edit_file` | `fs-tools.js` | `brokered` | File system write |
| `list_directory` | `fs-tools.js` | `brokered` | File system read |
| `file_search` | `fs-tools.js` | `brokered` | File system read |
| `grep_search` | `fs-tools.js` | `brokered` | File system read |
| `run_command` | `shell-tools.js` | `brokered` | Shell execution, file system mutation |
| `run_command_background` | `shell-tools.js` | `brokered` | Shell execution, persistent process |
| `check_process` | `shell-tools.js` | `brokered` | None (read-only) |
| `kill_process` | `shell-tools.js` | `brokered` | Process termination |
| `list_processes` | `shell-tools.js` | `brokered` | None (read-only) |
| `delegate_task` | `delegation-tools.js` | `brokered` | Spawns sub-agent process |
| `check_delegation` | `delegation-tools.js` | `brokered` | None (read-only) |
| `cancel_delegation` | `delegation-tools.js` | `brokered` | Process termination |
| `skill_{name}` | (dynamic) | `runtime` | None |

### 5.4 Registry Behavior

- The `class` field is stored on each tool definition in the registry.
- `getSchemas()` excludes `class` from the API output sent to the LLM — it is internal metadata.
- Tools registered without a `class` field default to `'runtime'`.
- The `class` field is informational in `LocalRunner` but becomes load-bearing when a container runner needs to decide whether to execute locally or broker to the host.

### 5.5 Policy Enforcement Across Classes

- **Runtime tools:** Permission checked by `ToolExecutor` inside the runtime using `allowedToolNames` from the `ExecutionRequest`.
- **Brokered tools:** Permission checked twice — pre-flight (host includes only permitted schemas in request) and at execution (runtime's `ToolExecutor` re-checks). In a future brokered setup, the host re-checks on the brokered request (defense in depth).
- **Host tools:** Host-side only. Not exposed to the LLM or runtime.

### 5.6 Container/Remote Implications (Future)

When the runtime runs in a container:
- **Runtime tools** execute inside the container directly.
- **Brokered tools** require a communication channel (HTTP, gRPC, stdio) between container and host. The container sends a structured request; the host executes and returns the result.
- **Host tools** are never sent to the container.

A containerized runtime should have no outbound network access (HTTP tools brokered through host for SSRF protection and audit) and a read-only or ephemeral file system (memory tools brokered because they access host storage).

## 6. Design Decisions

| Decision | Rationale |
|----------|-----------|
| Handlers return strings | The LLM consumes text. Returning strings avoids serialization ambiguity. |
| Timeout via `Promise.race` | No external dependencies. Works with any async handler. |
| Zod for validation | Runtime type safety. Zod is already a dependency for skill schema validation. |
| Permission scopes as strings | Simple pattern matching (`memory:write`, `network:*`). No ACL complexity needed at this scale. |
| Tool executor logs all executions | Audit trail for debugging and security review. |
| Three tool classes (runtime/brokered/host) | A simple host/runtime split would force HTTP and memory tools into one bucket. The brokered class captures LLM-invokable tools that require host-side execution. |
| Brokering is a no-op in LocalRunner | Avoids unnecessary abstraction. The class is an architectural annotation for now, load-bearing when a container runner is introduced. |
| `class` field excluded from API schemas | Internal metadata. The LLM doesn't need to know about trust boundaries. |
