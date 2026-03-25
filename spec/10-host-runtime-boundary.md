# Spec 10 — Host & Runner Architecture

> Status: **Implemented** | Owner: — | Last updated: 2026-03-25

## 1. Purpose

Define the architectural split between the **host** (control plane) and the **runtime** (execution plane) within AgentCore, and the contracts that bridge them: the runner interface, execution request/result shapes, host dispatcher, orchestration flow, and lifecycle management.

## 2. Definitions

| Term | Definition |
|------|-----------|
| **Host** | The long-lived process that owns adapters, the event bus, the security pipeline, the message queue, persistence (SQLite), scheduling, and outbound delivery. It is the only component that communicates with external systems. |
| **Runtime** | The execution module that receives an `ExecutionRequest`, runs the ReAct loop (LLM calls + tool execution), and returns an `ExecutionResult`. It has no direct access to adapters, the event bus, or persistence stores. |
| **Runner** | The interface the host uses to invoke the runtime. The host constructs an `ExecutionRequest` and calls `runner.execute(request)`. The runner returns an `ExecutionResult`. |
| **LocalRunner** | The current runner implementation. Wraps the existing `AgentLoop` in-process and translates between `ExecutionRequest`/`ExecutionResult` and the loop's internal format. |
| **HostDispatcher** | The host-side component that builds `ExecutionRequest` objects from inbound messages and finalizes `ExecutionResult` objects into outbound messages. |

## 3. Ownership Matrix

| Responsibility | Owner | Location |
|----------------|-------|----------|
| Adapter lifecycle (start/stop) | Host | `AdapterRegistry` |
| Inbound message normalization | Host | Adapters |
| Security pipeline (rate limit, permissions, sanitization) | Host | `index.js` event handler |
| Message queueing and per-session serialization | Host | `MessageQueue` |
| Session resolution and creation | Host | `HostDispatcher` → `SessionManager` |
| Conversation history loading | Host | `HostDispatcher` → `SessionManager` |
| Tool resolution (policy → schemas) | Host | `HostDispatcher` → `ToolPolicy`, `ToolRegistry` |
| Memory search | Host | `HostDispatcher` → `MemorySearch` |
| Skill trigger matching | Host | `HostDispatcher` → `SkillLoader` |
| System prompt assembly | Runtime | `PromptBuilder` (from data in request) |
| ReAct loop (LLM + tool iteration) | Runtime | `AgentLoop` |
| Tool execution | Runtime | `ToolExecutor` |
| Context compaction | Runtime | `ContextCompactor` |
| Outbound guardrails | Host | `HostDispatcher` → `PermissionManager` |
| Conversation history persistence | Host | `HostDispatcher` → `SessionManager` |
| Outbound message emission | Host | `HostDispatcher` → `EventBus` |
| Heartbeat scheduling | Host | `HeartbeatScheduler` → `Runner` |
| Graceful shutdown | Host | `index.js` |

## 4. Architecture Flow

### 4.1 Inbound Message Pipeline

```
Adapter → EventBus(message:inbound) → Security Pipeline
                                           ↓
                                    HostDispatcher.buildRequest()
                                      Session resolution
                                      History loading
                                      Tool resolution
                                      Memory search
                                      Skill matching
                                           ↓
                                    MessageQueue.enqueue(sessionId, request)
                                      (per-session serialization)
                                           ↓
                                    LocalRunner.execute(request)
                                           ↓
                                      [Runtime]
                                      Prompt building
                                      ReAct loop (LLM + tools)
                                      Context compaction
                                           ↓
                                    ExecutionResult returned
                                           ↓
                                    HostDispatcher.finalize()
                                      Guardrails
                                      Persistence (with guardrailed content)
                                      EventBus(message:outbound) → Adapter
```

### 4.2 Scheduled Tasks

```
HeartbeatScheduler.tick()
  → Parse HEARTBEAT.md tasks
  → Build ExecutionRequest (origin: scheduled_task)
  → Runner.execute(request)
  → Log result
```

The heartbeat builds an `ExecutionRequest` like any other dispatch path. Overlap prevention via `_inFlight` flag skips ticks while a previous execution is running.

### 4.3 Delegated Agent (Future)

```
Host receives delegation request → Build ExecutionRequest (origin: delegated_agent)
  → Runner.execute(request) → Return result to caller
```

Same runner contract. Only the `origin` field and host-side dispatch logic differ.

## 5. AgentRunner Interface

**File:** `src/core/runner/agent-runner.js`

```js
class AgentRunner {
  async execute(request) { throw new Error('must be implemented'); }
  async cancel(executionId) { return false; }
  async shutdown(timeoutMs = 30_000) { /* no-op */ }
}
```

| Method | Required | Notes |
|--------|----------|-------|
| `execute(request)` | Yes | Returns `ExecutionResult`. Rejects duplicate `executionId` with `RunnerUnavailableError`. |
| `cancel(executionId)` | No | Cooperative cancellation. Returns `true` if initiated, `false` if not found. |
| `shutdown(timeoutMs)` | No | After shutdown, `execute()` throws `RunnerUnavailableError`. |

## 6. ExecutionRequest

**File:** `src/core/runner/execution-request.js`

A self-contained description of work. The runtime executes using only this data plus its injected dependencies (LLM provider, tool executor).

```js
{
  executionId: string,              // UUID v4, generated by host
  origin: ExecutionOrigin,          // 'user_message' | 'scheduled_task' | 'delegated_agent' | 'maintenance_task'
  sessionId: string,
  userId: string,
  channelId: string,
  userName: string | null,
  sessionMetadata: object,
  history: Message[],               // Pre-loaded by host
  userContent: string,
  toolSchemas: AnthropicToolSchema[],
  allowedToolNames: Set<string> | null,  // null = all tools
  skillInstructions: string | null,
  memorySnippets: MemorySnippet[],  // { key, content (≤300 chars), metadata }
  maxIterations: number,            // Default: 25
  timeoutMs: number | null,         // null = no limit
  createdAt: number,                // Unix ms
}
```

**Required fields:** `origin`, `sessionId`, `userId`, `channelId`, `userContent`. All others have defaults.

**Validation:** `createExecutionRequest()` factory validates required fields and generates `executionId` / `createdAt` if not provided.

### 6.1 Execution Origins

| Origin | Session | Persistence | Delivery | Timeout |
|--------|---------|-------------|----------|---------|
| `user_message` | Real session from adapter | Full | Outbound via adapter | Typically none |
| `scheduled_task` | Synthetic `heartbeat:system` | Optional | Logged only | Recommended |
| `delegated_agent` | Inherited or synthetic | Host decides | Returned to caller | Recommended |
| `maintenance_task` | Synthetic | Typically not persisted | Logged only | Recommended |

## 7. ExecutionResult

**File:** `src/core/runner/execution-result.js`

```js
{
  executionId: string,
  status: ExecutionStatus,
  content: string,                  // Final text (may be empty on error)
  newMessages: Message[],           // All messages generated — host persists these
  toolsUsed: string[],
  tokenUsage: { inputTokens, outputTokens },
  iterationCount: number,
  durationMs: number,
  error: { code, message, retriable } | null,
}
```

### 7.1 ExecutionStatus

| Status | Meaning |
|--------|---------|
| `completed` | Final response produced. `error` is `null`. |
| `max_iterations` | Hit iteration cap. `content` may be partial. |
| `error` | Runtime or LLM error. `content` may have fallback. |
| `cancelled` | Cancelled via `cancel()`. |
| `timeout` | Exceeded `timeoutMs`. |

### 7.2 Error Codes

| Code | Retriable | Typical Cause |
|------|-----------|---------------|
| `runner_unavailable` | Yes | Shutting down or at capacity |
| `runtime_error` | Maybe | Bug in loop or prompt builder |
| `llm_error` | Yes | API rate limit, server error |
| `timeout` | Yes | Complex task, slow LLM |
| `cancelled` | No | Host called `cancel()` |
| `max_iterations` | No | Multi-step loop |

## 8. LocalRunner

**File:** `src/core/runner/local-runner.js`

Wraps `AgentLoop` in-process. Translates between `ExecutionRequest`/`ExecutionResult` and the loop's internal param/result format.

**Construction:** `new LocalRunner({ agentLoop, logger })`

**State:** `_active: Map<executionId, { cancelled: boolean }>`, `_shuttingDown: boolean`

**`execute()` behavior:**
1. Reject if shutting down or duplicate `executionId`.
2. Register in `_active` with a cancellation signal.
3. Translate request → loop params (history, userContent, toolSchemas, etc.).
4. If `timeoutMs` set: `Promise.race` with a timer that sets the cancellation signal on expiry.
5. Call `agentLoop.processMessage(params)`.
6. Translate loop result → `ExecutionResult` via `createExecutionResult()`.
7. Remove from `_active`.

**`shutdown()` behavior:** Set `_shuttingDown`, poll `_active` until empty or deadline, then force-cancel remaining.

## 9. HostDispatcher

**File:** `src/core/host-dispatcher.js`

Extracts host concerns into a single orchestration point. Two methods: `buildRequest` (before execution) and `finalize` (after execution).

**Construction:**

```js
new HostDispatcher({
  sessionManager, toolPolicy, toolRegistry, memorySearch,
  skillLoader, permissionManager, eventBus, logger, config,
})
```

### 9.1 buildRequest(sanitizedMessage, origin?)

1. `sessionManager.resolveSessionId(message)` + `getOrCreate()`
2. `sessionManager.loadHistory(sessionId)`
3. `toolPolicy.getEffectiveToolNames()` → `toolRegistry.getSchemas(allowedTools)`
4. Skill trigger matching (iterate `skillLoader.getLoadedSkills()`)
5. `memorySearch.search(content, 5)` — truncate each to 300 chars, catch errors silently
6. Return `createExecutionRequest({ ... })`

### 9.2 finalize(request, result, originalMessage?)

1. **Guardrails** — `permissionManager.checkModelGuardrails(content)` strips markers.
2. **Persist** — Apply guardrailed content to the last assistant message in `newMessages`, then `sessionManager.appendMessages()`. Skip if no new messages.
3. **Deliver** — Emit `message:outbound` on EventBus with the original adapter `sessionId` for routing.

## 10. Parallelism and Queueing

### 10.1 Per-Session Serialization

Messages within a single session are processed serially. The `MessageQueue` ensures this: when a request for session S is processing, subsequent requests for S are queued.

### 10.2 Cross-Session Concurrency

Requests for different sessions execute in parallel with no coordination.

### 10.3 Fan-Out Limits (Future)

When delegated agent dispatch is introduced:

| Limit | Default |
|-------|---------|
| Max concurrent executions (global) | 10 |
| Max concurrent executions per session | 1 |
| Max delegated subtasks per parent | 5 |

## 11. Timeout and Cancellation

**Timeout:** Host sets `timeoutMs` in the request. `LocalRunner` uses `Promise.race` with a timer. On timeout, the cancellation signal is set and the result has `status: 'timeout'`.

**Cancellation:** Host calls `runner.cancel(executionId)`. The runner sets an internal flag checked between ReAct iterations. Cooperative, not preemptive — the current LLM call or tool execution completes first.

**Shutdown propagation:** `messageQueue.shutdown()` stops new requests → `runner.shutdown(timeoutMs)` waits for in-flight work, then force-cancels.

## 12. Persistence Boundaries

| Phase | What is persisted | By whom |
|-------|-------------------|---------|
| Before execution | Session record (upsert) | `HostDispatcher` → `SessionManager` |
| During execution | Nothing | Runtime operates on in-memory data only |
| After execution | New messages (with guardrailed content) | `HostDispatcher` → `SessionManager` |

**Exception:** `save_memory` tool writes to persistent memory during execution via its handler closure. This is a brokered tool concern — see [Spec 03 §5](03-tools.md).

## 13. Boundary Constraints

1. **Host concerns must not leak into the runner.** The runner must not import `EventBus`, `AdapterRegistry`, `SessionManager`, `ConversationMemory`, or `PersistentMemory`.
2. **Runtime concerns must not leak into the host.** The host must not construct LLM messages, call the LLM provider, or execute tools directly.
3. **Session and history are provided, not fetched.** The runtime receives conversation history and session metadata in the `ExecutionRequest`.

## 14. Design Decisions

| Decision | Rationale |
|----------|-----------|
| Single runner contract | Sufficient for local, scheduled, and delegated execution. No routing complexity needed. |
| Host loads history before invoking runner | Moves persistence access out of the runtime. Runtime operates on in-memory data only. |
| Host applies guardrails after runner returns | Output filtering is a host policy concern. Guardrailed content is also applied to persisted messages. |
| Session resolution in host | Session identity is tied to adapters and persistence. Runtime receives metadata, not a key to resolve. |
| EventBus emission in host | Runtime doesn't know about the event bus or adapter routing. |
| Prompt building in runtime | Tightly coupled with the ReAct loop and context compaction. Uses data from the request. |
| Cooperative cancellation | Preemptive cancellation requires process isolation. Cooperative is sufficient for `LocalRunner`. |
| Error taxonomy as codes | Codes are serializable (future remote runners) and easy to match. |
| `ExecutionRequest` is self-contained | Enables future remote or containerized runners without changing the contract. |

## 15. Extension Points

- **ContainerRunner:** Serializes `ExecutionRequest`, starts a sandboxed process, deserializes `ExecutionResult`. Host code unchanged.
- **RemoteRunner:** Sends request to a remote worker over HTTP or message queue. Same interface.
- **Multi-runner routing:** Host component selects runner based on request properties (tool requirements, origin, resource limits).
- **Streaming:** Future `executeStream()` method yields `ExecutionEvent` objects. Does not change the synchronous `execute()` contract.
