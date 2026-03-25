# Spec 12 — Host Orchestration

> Status: **Draft** | Owner: — | Last updated: 2026-03-25
>
> Depends on: [Spec 10 — Host/Runtime Boundary](10-host-runtime-boundary.md), [Spec 11 — Runner Interface](11-runner-interface.md)

## 1. Purpose

Define how the host creates, queues, dispatches, and finalizes execution requests. This spec covers the inbound message pipeline after the refactor, scheduled task dispatch, delegated agent dispatch, parallelism, persistence boundaries, delivery, and observability.

## 2. Inbound Message Pipeline (After Refactor)

The pipeline in `src/index.js` changes from directly enqueuing into a `MessageQueue` that calls `AgentLoop.processMessage` to a dispatcher-based flow that builds `ExecutionRequest` objects and passes them to the runner.

### 2.1 Pipeline Steps

```
message:inbound event
  │
  ▼
1. Rate limiting              — rateLimiter.consume(userId)
2. Permission check           — permissionManager.checkAccess(userId, channelId)
3. Input sanitization         — inputSanitizer.sanitize(message)
4. Injection detection        — inputSanitizer.detectInjection() (log only)
  │
  ▼
5. Session resolution         — sessionManager.resolveSessionId(message)
                                sessionManager.getOrCreate(sessionId, userId, channelId, userName)
6. History loading            — sessionManager.loadHistory(sessionId)
7. Tool resolution            — toolPolicy.getEffectiveToolNames(userId, session)
                                toolRegistry.getSchemas(allowedTools)
8. Memory search              — memorySearch.search(message.content, 5)
9. Skill matching             — skillLoader.matchTrigger(message.content) (if loaded)
  │
  ▼
10. Build ExecutionRequest    — Assemble all resolved data into an ExecutionRequest
  │
  ▼
11. Enqueue                   — messageQueue.enqueue(sessionId, executionRequest)
                                (queue serializes per-session, invokes runner)
  │
  ▼
12. Runner.execute(request)   — Runtime processes the request
  │
  ▼
13. Finalize                  — Host receives ExecutionResult:
                                a. Apply outbound guardrails
                                b. Persist newMessages to conversation memory
                                c. Emit message:outbound event
                                d. Record observability metrics
```

### 2.2 Changes from Current Pipeline

| Step | Before | After |
|------|--------|-------|
| Session resolution | Done inside `AgentLoop.processMessage` | Done by host before building request |
| History loading | Done inside `AgentLoop.processMessage` | Done by host, included in `ExecutionRequest.history` |
| Tool resolution | Done inside `AgentLoop.processMessage` | Done by host, included in `ExecutionRequest.toolSchemas` |
| Memory search | Done inside `PromptBuilder.build` | Done by host, included in `ExecutionRequest.memorySnippets` |
| Skill matching | Done inside `AgentLoop.processMessage` | Done by host, included in `ExecutionRequest.skillInstructions` |
| Persistence | Done inside `AgentLoop.processMessage` | Done by host after runner returns |
| Guardrails | Done inside `AgentLoop.processMessage` | Done by host after runner returns |
| Outbound emission | Done inside `AgentLoop.processMessage` | Done by host after runner returns |

## 3. Scheduled Task Dispatch

The `HeartbeatScheduler` currently calls `agentLoop.processMessage` directly with a synthetic message. After the refactor, it produces `ExecutionRequest` objects.

### 3.1 Heartbeat Tick (After Refactor)

```
HeartbeatScheduler.tick()
  │
  ▼
1. Parse HEARTBEAT.md tasks
2. For each task (or combined):
   a. Build ExecutionRequest:
      - origin: 'scheduled_task'
      - sessionId: 'heartbeat:system'
      - userId: 'system'
      - channelId: 'heartbeat'
      - userContent: task prompt
      - history: loadHistory('heartbeat:system') or []
      - toolSchemas: all tools (system user is admin)
      - allowedToolNames: null (admin = full access)
      - memorySnippets: [] (no memory search for scheduled tasks)
      - skillInstructions: null
      - maxIterations: config.maxToolIterations
      - timeoutMs: config.heartbeatIntervalMs (prevent overlap with next tick)
   b. Dispatch: runner.execute(request)
   c. Finalize:
      - Log result
      - Optionally persist conversation history
      - Update heartbeat_state table with last_run_at and last_result
```

### 3.2 Overlap Prevention

If a heartbeat execution is still running when the next tick fires, the scheduler must skip the new tick. This is enforced by tracking whether a heartbeat execution is in-flight:

```js
if (this._inFlight) {
  this.logger.warn('Heartbeat tick skipped: previous execution still running');
  return;
}
```

The `timeoutMs` on the request provides a hard cap to prevent indefinite blocking.

## 4. Delegated and Remote Agent Dispatch

Delegated agents are subtasks dispatched by the host on behalf of a parent execution or an external trigger (e.g., a webhook, a remote API call, or a parent agent that fans out work).

### 4.1 Dispatch Flow

```
Host receives delegation request
  (via API endpoint, parent agent callback, or remote trigger)
  │
  ▼
1. Authenticate and authorize the request
2. Build ExecutionRequest:
   - origin: 'delegated_agent'
   - sessionId: inherited from parent or newly generated
   - userId: inherited from parent or service account
   - userContent: delegated task prompt
   - history: [] or inherited subset
   - toolSchemas: scoped to delegated task requirements
   - timeoutMs: set by host (bounded by parent timeout)
3. Dispatch: runner.execute(request)
4. Return ExecutionResult to caller
```

### 4.2 Key Constraint

Delegated agents use the same runner and the same `ExecutionRequest` shape as user messages and scheduled tasks. No special runner type is needed. The `origin` field and host-side dispatch logic are the only differences.

## 5. Parallelism Model

### 5.1 Per-Session Serialization

Messages within a single session are processed serially, exactly as today. The `MessageQueue` ensures this:

- When an `ExecutionRequest` for session S is being processed, subsequent requests for session S are queued.
- When the execution completes, the next queued request for session S begins.

This prevents race conditions on conversation history (the second message would be processed with stale history).

### 5.2 Cross-Session Concurrency

Requests for different sessions execute in parallel with no coordination. Session A's execution does not block session B.

### 5.3 Fan-Out Limits

When delegated agent dispatch is introduced, the host must enforce a fan-out limit to prevent resource exhaustion:

| Limit | Default | Configurable |
|-------|---------|-------------|
| Max concurrent executions (global) | 10 | Yes (`MAX_CONCURRENT_EXECUTIONS`) |
| Max concurrent executions per session | 1 | No (enforced by per-session serialization) |
| Max delegated subtasks per parent execution | 5 | Yes (`MAX_DELEGATED_SUBTASKS`) |

When limits are reached, new requests receive a `runner_unavailable` error with `retriable: true`.

### 5.4 Cancellation Propagation

When a parent execution is cancelled:

1. The host cancels all in-flight delegated subtasks spawned by that parent.
2. Each subtask runner receives `cancel(executionId)`.
3. The parent execution's result includes the cancellation status.

When the host is shutting down:

1. `messageQueue.shutdown()` stops accepting new requests.
2. `runner.shutdown(timeoutMs)` signals in-flight executions to wrap up.
3. After `timeoutMs`, any remaining executions are force-cancelled.

## 6. MessageQueue Changes

The `MessageQueue` currently accepts `(sessionId, message)` and calls `agentLoop.processMessage(message)`. After the refactor:

### 6.1 New Interface

```js
class MessageQueue {
  constructor(runner, logger) {
    this.runner = runner;            // AgentRunner, not AgentLoop
    // ... rest unchanged
  }

  async enqueue(sessionId, executionRequest) {
    // Same queueing logic, but calls:
    // this.runner.execute(executionRequest)
    // instead of:
    // this.agentLoop.processMessage(message)
  }
}
```

### 6.2 Behavioral Changes

- The queue now holds `ExecutionRequest` objects instead of `NormalizedMessage` objects.
- The `resolve` callback returns an `ExecutionResult` instead of an `OutboundMessage`.
- The finalization step (guardrails, persistence, delivery) happens in the caller (the host dispatcher in `index.js`), not inside the queue.

## 7. Persistence Boundaries

### 7.1 Before Execution

| Data | Persisted By | When |
|------|-------------|------|
| Session record | Host (`SessionManager.getOrCreate`) | During request building (step 5) |

### 7.2 During Execution

| Data | Persisted By | When |
|------|-------------|------|
| Nothing | — | The runtime does not write to the database. It operates on in-memory data and returns results. |

### 7.3 After Execution

| Data | Persisted By | When |
|------|-------------|------|
| New messages (user, assistant, tool_use, tool_result) | Host (`SessionManager.appendMessages`) | After runner returns, during finalization |
| Session `updated_at` timestamp | Host (`SessionManager`) | Implicit on appendMessages |
| Heartbeat state | Host (`HeartbeatScheduler`) | After scheduled task runner returns |

### 7.4 Persistence Exceptions

- **Persistent memory writes via `save_memory` tool**: These happen during execution inside the runtime (via the tool handler). This is an exception to the "runtime doesn't persist" rule. Spec 13 addresses whether `save_memory` should be reclassified as a brokered tool.
- **Context compaction**: The compacted message array is not persisted during execution. The `newMessages` in the `ExecutionResult` reflect the uncompacted sequence. The host may choose to persist the compacted form separately.

## 8. Delivery Boundaries

### 8.1 Outbound Message Emission

After the runner returns and the host completes finalization:

```js
// Host dispatcher (in index.js or a dedicated module)
const result = await runner.execute(request);

// 1. Guardrails
let content = result.content;
if (permissionManager) {
  const guardrail = permissionManager.checkModelGuardrails(content);
  content = guardrail.content;
}

// 2. Persist
sessionManager.appendMessages(request.sessionId, result.newMessages);

// 3. Deliver
const outbound = {
  sessionId: request.sessionId,
  channelId: request.channelId,
  userId: request.userId,
  content,
  replyTo: originalMessageId,
  metadata: {
    toolsUsed: result.toolsUsed,
    tokenUsage: result.tokenUsage,
    processingTimeMs: result.durationMs,
  },
};
eventBus.emit('message:outbound', outbound);
```

### 8.2 Delivery by Origin

| Origin | Delivery Method |
|--------|----------------|
| `user_message` | `message:outbound` event → `AdapterRegistry` → adapter `sendMessage` |
| `scheduled_task` | Logged. Optionally emitted as `message:outbound` if a delivery channel is configured for heartbeat results. |
| `delegated_agent` | Returned to the parent caller. Not emitted on the event bus unless explicitly requested. |
| `maintenance_task` | Logged only. Never delivered to users. |

## 9. Observability Hooks

The host emits observability data after each execution completes. These are event bus events or structured log entries.

### 9.1 Metrics

| Metric | Source | Emitted When |
|--------|--------|-------------|
| `execution.duration_ms` | `result.durationMs` | After every execution |
| `execution.queue_duration_ms` | Time between enqueue and runner.execute start | After every execution |
| `execution.iteration_count` | `result.iterationCount` | After every execution |
| `execution.status` | `result.status` | After every execution |
| `execution.origin` | `request.origin` | After every execution |
| `execution.tools_used` | `result.toolsUsed` | After every execution |
| `execution.token_usage` | `result.tokenUsage` | After every execution |
| `execution.error_code` | `result.error?.code` | On non-completed executions |

### 9.2 Event Bus Events

| Event | Payload | Notes |
|-------|---------|-------|
| `execution:started` | `{ executionId, origin, sessionId }` | Emitted when the runner begins |
| `execution:completed` | `{ executionId, status, durationMs }` | Emitted after finalization |
| `tool:executed` | `{ tool, success, durationMs, sessionId }` | Unchanged from current. Emitted by runtime. |

### 9.3 Structured Logging

Each execution produces a structured log entry:

```json
{
  "executionId": "...",
  "origin": "user_message",
  "sessionId": "telegram:12345",
  "status": "completed",
  "iterations": 3,
  "toolsUsed": ["http_get", "save_memory"],
  "inputTokens": 4500,
  "outputTokens": 800,
  "queueDurationMs": 12,
  "executionDurationMs": 3400,
  "totalDurationMs": 3412
}
```

## 10. Design Decisions

| Decision | Rationale |
|----------|-----------|
| Host builds ExecutionRequest before queueing | All host-side resolution (session, history, tools, memory) happens once, before the request enters the queue. This keeps the queue simple. |
| Finalization after runner returns, not inside queue | The queue's job is serialization and dispatch. Persistence and delivery are host concerns that happen after. |
| Heartbeat uses the same runner | Eliminates a separate code path. Heartbeat tasks are ordinary execution requests with a different origin. |
| Fan-out limits are host-enforced | The runner doesn't know about global concurrency. The host tracks active executions. |
| `tool:executed` still emitted by runtime | Tool execution events are fine-grained and happen mid-execution. The runtime emits them directly on the event bus (passed as a dependency or callback). This is a pragmatic exception to "runtime doesn't touch event bus." |
| No distributed queue in first step | The current in-process `MessageQueue` is sufficient. A distributed queue can be introduced behind the same interface later. |
