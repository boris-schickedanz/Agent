# Spec 13 — Tool Boundaries

> Status: **Draft** | Owner: — | Last updated: 2026-03-25
>
> Depends on: [Spec 10 — Host/Runtime Boundary](10-host-runtime-boundary.md), [Spec 11 — Runner Interface](11-runner-interface.md)

## 1. Purpose

Classify tools by trust boundary: which tools can run fully inside the runtime, which must remain on the host side, and which require a brokered request from runtime to host. This classification must be defined before any execution-boundary isolation work.

## 2. Tool Classes

### 2.1 Runtime Tools

Tools that execute entirely within the runtime process. They have no side effects outside the runtime boundary and do not access host-owned resources (database, file system, adapters).

**Characteristics:**
- Pure computation or stateless operations
- No access to persistent storage
- No network I/O (in a sandboxed runtime)
- Safe to run in a container or sandbox without special permissions
- Timeout enforcement is the runtime's responsibility

### 2.2 Host Tools

Tools that must execute on the host side because they directly access host-owned resources. These tools are never sent into a sandboxed runtime.

**Characteristics:**
- Access the database, file system, or host-managed state
- May require host credentials or configuration not available to the runtime
- Execution is fully trusted (host code path)
- Not subject to runtime sandbox restrictions

### 2.3 Brokered Tools

Tools that the LLM invokes as if they were runtime tools, but whose execution is delegated from the runtime back to the host via a request/response bridge. From the LLM's perspective, they look identical to runtime tools. From the architecture's perspective, they cross the trust boundary.

**Characteristics:**
- Appear in the tool schema sent to the LLM
- When invoked during the ReAct loop, the runtime sends a brokered request to the host
- The host executes the tool with full host-side access and returns the result
- The runtime receives the result as a string (same as any tool result)
- Adds latency in a remote/container runner scenario (one round-trip per invocation)

**Brokering mechanism (LocalRunner):**
In the `LocalRunner`, brokering is a no-op — the tool handler closure already captures host-side references (e.g., `persistentMemory`, `memorySearch`). The brokering abstraction is relevant when the runtime is isolated (container, remote process). At that point, the runtime would send a structured request over the bridge instead of calling the closure directly.

## 3. Decision Criteria

| Criterion | Runtime Tool | Brokered Tool | Host Tool |
|-----------|-------------|---------------|-----------|
| Accesses database? | No | Yes (via host) | Yes (directly) |
| Accesses file system? | No | Yes (via host) | Yes (directly) |
| Makes network calls? | No (in sandbox) | Yes (via host) | Yes (directly) |
| Invoked by LLM? | Yes | Yes | No |
| Runs in sandbox? | Yes | Proxy runs in sandbox, execution on host | No |
| Has host-side side effects? | No | Yes | Yes |
| Requires host credentials? | No | Yes (host provides) | Yes |

## 4. Classification of Existing Built-in Tools

### 4.1 System Tools (`src/tools/built-in/system-tools.js`)

| Tool | Class | Rationale |
|------|-------|-----------|
| `get_current_time` | **Runtime** | Pure computation. Uses `Date` and `toLocaleString`. No external dependencies. |
| `wait` | **Runtime** | Stateless timer. No side effects. |

### 4.2 HTTP Tools (`src/tools/built-in/http-tools.js`)

| Tool | Class | Rationale |
|------|-------|-----------|
| `http_get` | **Brokered** | Makes outbound network requests. In a sandboxed runtime, network access would be blocked. The host must proxy these requests to enforce SSRF protection (`validateUrl`), apply rate limits, and audit outbound traffic. |
| `http_post` | **Brokered** | Same rationale as `http_get`. Additionally, POST can mutate external state, making host-side auditing essential. |

### 4.3 Memory Tools (`src/tools/built-in/memory-tools.js`)

| Tool | Class | Rationale |
|------|-------|-----------|
| `save_memory` | **Brokered** | Writes to the host file system (`data/memory/`) and updates the FTS5 index in the host database. The runtime must not have direct write access to host persistence. |
| `search_memory` | **Brokered** | Queries the FTS5 index in the host database. Read-only, but still crosses the persistence boundary. |
| `list_memories` | **Brokered** | Reads from the host file system. |

### 4.4 Skill Pseudo-Tools

| Tool | Class | Rationale |
|------|-------|-----------|
| `skill_{name}` | **Runtime** | Returns a static string (skill instructions). No external dependencies. The instructions are available in the runtime's memory. |

### 4.5 Summary Table

| Tool | Current File | Class | Side Effects |
|------|-------------|-------|-------------|
| `get_current_time` | `system-tools.js` | Runtime | None |
| `wait` | `system-tools.js` | Runtime | None |
| `http_get` | `http-tools.js` | Brokered | Outbound network request |
| `http_post` | `http-tools.js` | Brokered | Outbound network request, external state mutation |
| `save_memory` | `memory-tools.js` | Brokered | File system write, database write |
| `search_memory` | `memory-tools.js` | Brokered | Database read |
| `list_memories` | `memory-tools.js` | Brokered | File system read |
| `skill_{name}` | (dynamic) | Runtime | None |

## 5. Host Tools (Future)

Currently, no tools are host-only (not invoked by the LLM). Future host tools might include:

| Tool | Purpose | Why Host-Only |
|------|---------|---------------|
| `admin_approve_user` | Approve a pending user | Modifies `users` table, must be admin-gated at host level |
| `admin_block_user` | Block a user | Same |
| `manage_adapters` | Start/stop adapters | Adapter lifecycle is host-only |
| `manage_heartbeat` | Modify heartbeat schedule | Heartbeat is host-only |

Host tools would be callable only through host-side APIs (admin commands, management endpoints), never through the LLM's tool-use mechanism.

## 6. Implications for Future Container or Remote Execution

### 6.1 Container Runtime

When the runtime runs in a container:

- **Runtime tools** execute inside the container with no special handling.
- **Brokered tools** require a communication channel (HTTP, gRPC, Unix socket, or stdin/stdout) between the container and the host. The container sends a structured request; the host executes the tool and returns the result.
- **Host tools** are never sent to the container.

### 6.2 Network Isolation

A containerized runtime should have no outbound network access. All HTTP tools must be brokered through the host, which enforces:

- URL validation (SSRF prevention via `validateUrl`)
- Rate limiting on outbound requests
- Audit logging of all external calls
- Optional content filtering on responses

### 6.3 File System Isolation

A containerized runtime should have a read-only or ephemeral file system. Memory tools must be brokered because:

- `save_memory` writes to the host's persistent storage
- `search_memory` and `list_memories` read from the host's persistent storage
- The runtime may have a temporary workspace but no access to host-managed data

## 7. Policy Enforcement Across Tool Classes

### 7.1 Runtime Tools

- Permission check: performed by `ToolExecutor` inside the runtime, using the `allowedToolNames` from the `ExecutionRequest`.
- Policy source: the host resolves permissions before building the request. The runtime enforces what was granted.
- Audit: the runtime emits `tool:executed` events.

### 7.2 Brokered Tools

- Permission check: performed twice:
  1. **Pre-flight (host):** The host includes only permitted tool schemas in the `ExecutionRequest`. The LLM cannot invoke a tool it doesn't see.
  2. **At execution (runtime or host):** The runtime's `ToolExecutor` checks `allowedToolNames` before invoking the handler. In a brokered setup, the host re-checks permissions on the brokered request (defense in depth).
- Audit: both the runtime (`tool:executed` event) and the host (structured log on brokered request) record the execution.

### 7.3 Host Tools

- Permission check: host-side only. These tools are not exposed to the LLM or the runtime.
- Audit: host-side structured logging.

## 8. Migration Notes

### 8.1 ToolExecutor

The current `ToolExecutor` (`src/tools/tool-executor.js`) handles all tool execution uniformly. After the refactor:

- In the `LocalRunner` (first step): **no change**. All tools are executed in-process. The brokered/runtime distinction is architectural documentation, not a code change. The tool handler closures already work correctly because they capture host references.
- In a future containerized runner: the `ToolExecutor` inside the container handles runtime tools directly. For brokered tools, it sends a request over the bridge instead of calling the handler closure.

### 8.2 ToolRegistry

The `ToolRegistry` (`src/tools/tool-registry.js`) currently has no concept of tool class. A future extension adds a `class` field to `ToolDefinition`:

```js
{
  name: string,
  class: 'runtime' | 'brokered' | 'host',   // New field
  description: string,
  inputSchema: object,
  handler: Function,
  permissions: string[],
  timeout: number,
}
```

This field is informational in the `LocalRunner` step but becomes load-bearing when a container runner needs to decide whether to execute locally or broker to the host.

### 8.3 Registration Changes

No registration changes in the first step. The existing `registerSystemTools`, `registerHttpTools`, and `registerMemoryTools` functions continue to work as-is. The `class` field is added with default values during registration:

- `system-tools.js` → `class: 'runtime'`
- `http-tools.js` → `class: 'brokered'`
- `memory-tools.js` → `class: 'brokered'`
- Skill pseudo-tools → `class: 'runtime'`

## 9. Design Decisions

| Decision | Rationale |
|----------|-----------|
| Three classes, not two | A simple host/runtime split would force HTTP and memory tools into one bucket. The brokered class captures tools that are LLM-invokable but require host-side execution. |
| Brokering is a no-op in LocalRunner | Avoids unnecessary abstraction in the first step. The brokered class is an architectural annotation, not a code path change. |
| HTTP tools are brokered, not runtime | Even though `fetch` is available in any Node.js process, outbound network from a sandboxed runtime must be controlled. Brokering ensures SSRF protection and audit. |
| Memory tools are brokered, not runtime | Persistent memory is a host resource. The runtime should not have direct database or file system access. |
| Permission check at both levels | Defense in depth. The host prevents tool schemas from being sent for unauthorized tools. The runtime double-checks. In a brokered setup, the host checks again. |
| `class` field added to ToolDefinition | Future-proofing. The field has no behavioral effect in LocalRunner but enables container/remote runners to route tool calls correctly. |
