# Spec 14 — Migration Plan

> Status: **Draft** | Owner: — | Last updated: 2026-03-25
>
> Depends on: [Spec 10](10-host-runtime-boundary.md), [Spec 11](11-runner-interface.md), [Spec 12](12-host-orchestration.md), [Spec 13](13-tool-boundaries.md)

## 1. Purpose

Turn the architecture specs into an implementation sequence. This spec provides a file-by-file migration map, an intermediate compatibility state, the extraction sequence, required tests for each step, a rollback strategy, and an acceptance checklist.

## 2. Implementation Phases

The migration is split into four implementation phases. Each phase ends with all existing tests passing and the system behaviorally identical to the pre-migration state.

| Phase | Name | Description |
|-------|------|-------------|
| M1 | Introduce abstractions | Create `AgentRunner`, `LocalRunner`, `ExecutionRequest`, `ExecutionResult` as new files. No existing code changes. |
| M2 | Extract host concerns from AgentLoop | Move session resolution, history loading, tool resolution, memory search, persistence, guardrails, and outbound emission out of `AgentLoop` and into the host dispatcher. |
| M3 | Wire LocalRunner into host | Replace `MessageQueue(agentLoop)` with `MessageQueue(localRunner)`. Update heartbeat to use runner. Wire host dispatcher. |
| M4 | Annotate tool classes | Add `class` field to `ToolDefinition`. Annotate existing tools. No behavioral change. |

## 3. File-by-File Migration Map

### 3.1 New Files

| File | Phase | Purpose |
|------|-------|---------|
| `src/core/runner/agent-runner.js` | M1 | Abstract `AgentRunner` base class |
| `src/core/runner/local-runner.js` | M1 | `LocalRunner` implementation wrapping `AgentLoop` |
| `src/core/runner/execution-request.js` | M1 | `ExecutionRequest` factory and validation |
| `src/core/runner/execution-result.js` | M1 | `ExecutionResult` factory and status constants |
| `src/core/host-dispatcher.js` | M2 | Host-side request building and result finalization |

### 3.2 Modified Files

| File | Phase | Changes |
|------|-------|---------|
| `src/core/agent-loop.js` | M2 | Remove host concerns (see §4). Accept pre-loaded data. Return `newMessages` in result. Stop emitting `message:outbound`. Stop calling `sessionManager.appendMessages`. |
| `src/core/message-queue.js` | M3 | Constructor accepts `AgentRunner` instead of `AgentLoop`. `enqueue` accepts `ExecutionRequest`. |
| `src/heartbeat/heartbeat-scheduler.js` | M3 | Build `ExecutionRequest` objects. Call `runner.execute()` instead of `agentLoop.processMessage()`. |
| `src/index.js` | M3 | Instantiate `LocalRunner`. Wire host dispatcher. Pass runner to `MessageQueue`. Update inbound handler to use dispatcher. |
| `src/tools/tool-registry.js` | M4 | Accept optional `class` field in `register()`. Default to `'runtime'`. |
| `src/tools/built-in/system-tools.js` | M4 | Add `class: 'runtime'` to registrations. |
| `src/tools/built-in/http-tools.js` | M4 | Add `class: 'brokered'` to registrations. |
| `src/tools/built-in/memory-tools.js` | M4 | Add `class: 'brokered'` to registrations. |

### 3.3 Unchanged Files

| File | Reason |
|------|--------|
| `src/adapters/adapter-interface.js` | Host ingress/egress contract unchanged |
| `src/adapters/adapter-registry.js` | Host-side routing unchanged |
| `src/adapters/console/console-adapter.js` | No changes |
| `src/adapters/telegram/*` | No changes |
| `src/brain/llm-provider.js` | Runtime dependency, no interface change |
| `src/brain/anthropic-provider.js` | Runtime dependency, no interface change |
| `src/brain/prompt-builder.js` | Runtime dependency; receives data from request instead of querying |
| `src/brain/context-compactor.js` | Runtime internal, no interface change |
| `src/memory/conversation-memory.js` | Host persistence, no interface change |
| `src/memory/persistent-memory.js` | Host persistence, no interface change |
| `src/memory/memory-search.js` | Host search, no interface change |
| `src/security/*` | All security components remain host-side, no interface change |
| `src/skills/skill-loader.js` | Host-side loading, no interface change |
| `src/skills/skill-schema.js` | No changes |
| `src/db/*` | No schema changes, no interface change |
| `src/config.js` | No changes (new config vars added only if fan-out limits are implemented) |
| `src/core/event-bus.js` | No changes |
| `src/core/session-manager.js` | No changes (host calls it; agent loop stops calling it) |

## 4. AgentLoop Extraction Detail (Phase M2)

The `AgentLoop.processMessage` method currently handles both host and runtime concerns. The following table shows what moves out.

### 4.1 Lines to Remove from AgentLoop

| Concern | Current Code Location | Moves To |
|---------|----------------------|----------|
| Session resolution | `this.sessions.resolveSessionId(normalizedMessage)` and `this.sessions.getOrCreate(...)` (lines 37–39) | `host-dispatcher.js` |
| History loading | `this.sessions.loadHistory(sessionId)` (line 42) | `host-dispatcher.js` |
| Tool resolution | `this.toolPolicy.getEffectiveToolNames(...)` and `this.toolRegistry.getSchemas(...)` (lines 45–48) | `host-dispatcher.js` |
| Skill trigger matching | The `skillLoader` loop (lines 52–59) | `host-dispatcher.js` |
| Outbound guardrails | `this.permissionManager.checkModelGuardrails(finalText)` (lines 161–164) | `host-dispatcher.js` |
| Persistence | `this.sessions.appendMessages(sessionId, newMessages)` (line 169) | `host-dispatcher.js` |
| Outbound emission | `this.eventBus.emit('message:outbound', outbound)` (line 185) | `host-dispatcher.js` |

### 4.2 New AgentLoop.processMessage Signature

```js
async processMessage({
  history,              // Pre-loaded conversation history
  userContent,          // User message content
  toolSchemas,          // Resolved tool schemas
  allowedToolNames,     // Allowed tool names (for ToolExecutor)
  memorySnippets,       // Pre-searched memory results
  skillInstructions,    // Matched skill instructions (or null)
  sessionMetadata,      // Session metadata (for prompt builder and tool context)
  maxIterations,        // Max ReAct iterations
  cancellationSignal,   // { cancelled: boolean } object checked between iterations
}) → {
  content: string,
  newMessages: Message[],
  toolsUsed: string[],
  tokenUsage: { inputTokens, outputTokens },
  iterationCount: number,
  status: 'completed' | 'max_iterations' | 'error' | 'cancelled',
  error: { code, message, retriable } | null,
}
```

### 4.3 Dependencies Removed from AgentLoop Constructor

After M2, the `AgentLoop` constructor no longer receives:

| Dependency | Reason |
|-----------|--------|
| `sessionManager` | Host resolves sessions and loads history |
| `toolPolicy` | Host resolves tool permissions |
| `toolRegistry` (for schema generation) | Host provides schemas in request. Registry still needed for execution. |
| `permissionManager` | Host applies guardrails |
| `eventBus` | Host emits outbound events |
| `skillLoader` | Host matches skills |

Dependencies that remain:

| Dependency | Reason |
|-----------|--------|
| `llmProvider` | Runtime calls the LLM |
| `promptBuilder` | Runtime assembles the system prompt from request data |
| `toolExecutor` | Runtime executes tools |
| `contextCompactor` | Runtime manages context window |
| `logger` | Logging |
| `config` (partial) | Only `maxToolIterations` default, if not overridden by request |

## 5. Host Dispatcher Detail (Phase M2–M3)

### 5.1 Request Building

```js
// src/core/host-dispatcher.js

export class HostDispatcher {
  constructor({
    sessionManager,
    toolPolicy,
    toolRegistry,
    memorySearch,
    skillLoader,
    permissionManager,
    eventBus,
    runner,
    logger,
    config,
  }) { /* store references */ }

  /**
   * Build an ExecutionRequest from a sanitized inbound message.
   */
  buildRequest(sanitizedMessage, origin = 'user_message') {
    const sessionId = this.sessionManager.resolveSessionId(sanitizedMessage);
    const session = this.sessionManager.getOrCreate(
      sessionId, sanitizedMessage.userId, sanitizedMessage.channelId, sanitizedMessage.userName
    );
    session.lastUserMessage = sanitizedMessage.content;

    const history = this.sessionManager.loadHistory(sessionId);

    const allowedToolNames = this.toolPolicy
      ? new Set(this.toolPolicy.getEffectiveToolNames(sanitizedMessage.userId, session))
      : null;
    const toolSchemas = this.toolRegistry.getSchemas(allowedToolNames);

    let skillInstructions = null;
    if (this.skillLoader) {
      for (const skill of this.skillLoader.getLoadedSkills()) {
        if (skill.trigger && sanitizedMessage.content.startsWith(skill.trigger)) {
          skillInstructions = skill.instructions;
          break;
        }
      }
    }

    let memorySnippets = [];
    try {
      memorySnippets = this.memorySearch.search(sanitizedMessage.content, 5)
        .map(r => ({ key: r.key, content: r.content.substring(0, 300), metadata: r.metadata }));
    } catch { /* non-critical */ }

    return {
      executionId: crypto.randomUUID(),
      origin,
      sessionId,
      userId: sanitizedMessage.userId,
      channelId: sanitizedMessage.channelId,
      userName: sanitizedMessage.userName || null,
      sessionMetadata: session.metadata || {},
      history,
      userContent: sanitizedMessage.content,
      toolSchemas,
      allowedToolNames,
      skillInstructions,
      memorySnippets,
      maxIterations: this.config.maxToolIterations,
      timeoutMs: null,
      createdAt: Date.now(),
    };
  }

  /**
   * Finalize an ExecutionResult: guardrails, persistence, delivery.
   */
  async finalize(request, result, originalMessage) {
    // 1. Guardrails
    let content = result.content;
    if (this.permissionManager) {
      const guardrail = this.permissionManager.checkModelGuardrails(content);
      content = guardrail.content;
    }

    // 2. Persist
    if (result.newMessages && result.newMessages.length > 0) {
      this.sessionManager.appendMessages(request.sessionId, result.newMessages);
    }

    // 3. Deliver
    const outbound = {
      sessionId: originalMessage?.sessionId || request.sessionId,
      channelId: request.channelId,
      userId: request.userId,
      content,
      replyTo: originalMessage?.id || null,
      metadata: {
        toolsUsed: result.toolsUsed || [],
        tokenUsage: result.tokenUsage || { inputTokens: 0, outputTokens: 0 },
        processingTimeMs: result.durationMs || 0,
      },
    };

    this.eventBus.emit('message:outbound', outbound);

    return outbound;
  }
}
```

## 6. Intermediate Compatibility State

During Phases M1 and M2, the system runs in a compatibility state:

1. **M1 (new files only):** `AgentRunner`, `LocalRunner`, request/result types exist but are not wired. The system runs exactly as before via `AgentLoop` + `MessageQueue`.
2. **M2 (AgentLoop modified):** `AgentLoop.processMessage` accepts the new parameter shape. `HostDispatcher` is created but not yet wired into the pipeline. A thin adapter layer in `index.js` translates from the old `NormalizedMessage` to the new parameter shape, preserving current behavior.
3. **M3 (wired):** The full pipeline uses `HostDispatcher` → `MessageQueue(runner)` → `LocalRunner` → `AgentLoop`. The old direct `AgentLoop.processMessage` path is removed.
4. **M4 (annotations):** Tool `class` field added. No behavioral change.

At every phase boundary, the system must pass all existing tests and produce identical behavior from the adapter's perspective.

## 7. Required Tests for Each Phase

### 7.1 Phase M1 Tests

| Test | Verifies |
|------|----------|
| `AgentRunner.execute()` throws "must be implemented" | Base class contract |
| `LocalRunner.execute()` calls `agentLoop.processMessage` | Delegation works |
| `LocalRunner.execute()` translates request to loop format | Shape mapping |
| `LocalRunner.execute()` translates loop result to `ExecutionResult` | Shape mapping |
| `LocalRunner.cancel()` sets cancellation flag | Cooperative cancel |
| `LocalRunner.shutdown()` rejects subsequent execute calls | Shutdown contract |
| `ExecutionRequest` factory produces valid shape | Schema correctness |
| `ExecutionResult` status values are exhaustive | Enum coverage |

### 7.2 Phase M2 Tests

| Test | Verifies |
|------|----------|
| `AgentLoop.processMessage` works with pre-loaded history | No internal session load |
| `AgentLoop.processMessage` returns `newMessages` | Persistence delegation |
| `AgentLoop.processMessage` does not emit `message:outbound` | Emission delegation |
| `AgentLoop.processMessage` does not call `sessionManager.appendMessages` | Persistence delegation |
| `AgentLoop.processMessage` checks `cancellationSignal` between iterations | Cooperative cancel |
| `HostDispatcher.buildRequest` produces valid `ExecutionRequest` | Integration with session, tools, memory, skills |
| `HostDispatcher.finalize` applies guardrails, persists, emits | Post-execution pipeline |

### 7.3 Phase M3 Tests

| Test | Verifies |
|------|----------|
| End-to-end: console adapter message → response | Full pipeline |
| End-to-end: Telegram adapter message → response (mock) | Full pipeline |
| Rate limiting still rejects | Security pipeline preserved |
| Permission check still blocks unauthorized users | Security pipeline preserved |
| Per-session serialization preserved | MessageQueue behavior |
| Cross-session parallelism preserved | MessageQueue behavior |
| Heartbeat tick produces ExecutionRequest with `origin: 'scheduled_task'` | Heartbeat migration |
| Heartbeat tick calls `runner.execute()` | Heartbeat migration |
| Heartbeat overlap prevention works | Skip when in-flight |
| Tool execution success and failure paths preserved | ToolExecutor integration |
| Context compaction triggers and produces correct output | Compactor integration |
| Memory search results appear in prompt | Memory integration |
| Skill trigger matching works | Skill integration |
| Graceful shutdown sequence | Shutdown order |

### 7.4 Phase M4 Tests

| Test | Verifies |
|------|----------|
| `ToolRegistry.register` accepts `class` field | Schema extension |
| `ToolRegistry.register` defaults `class` to `'runtime'` | Default behavior |
| System tools registered with `class: 'runtime'` | Correct annotation |
| HTTP tools registered with `class: 'brokered'` | Correct annotation |
| Memory tools registered with `class: 'brokered'` | Correct annotation |
| `getSchemas` includes `class` field (or not, depending on whether it's API-visible) | Schema output |

## 8. Rollback Strategy

Each phase is designed to be independently rollbackable via `git revert`.

| Phase | Rollback Action | Risk |
|-------|----------------|------|
| M1 | Delete new files. No code references them yet. | None |
| M2 | Revert `agent-loop.js` changes. The old signature and internal behavior are restored. `host-dispatcher.js` becomes dead code (can be deleted). | Low — AgentLoop is the only modified production file. |
| M3 | Revert `index.js`, `message-queue.js`, and `heartbeat-scheduler.js`. Restore `agentLoop` direct references. | Medium — three files touched, but each change is a wiring change (constructor args and call targets), not logic. |
| M4 | Revert tool registration changes. Remove `class` field from `ToolRegistry`. | None — annotations have no behavioral effect. |

### 8.1 Rollback Decision Criteria

Roll back a phase if:

- Any existing test fails after the phase change and the fix is not obvious within one hour.
- An adapter produces different response content for the same input (excluding new metadata fields).
- Session persistence produces different message sequences.
- Rate limiting or permission checks behave differently.

## 9. Acceptance Checklist

The refactor is complete when all of the following are true:

- [ ] `AgentRunner` and `LocalRunner` exist and are tested.
- [ ] `ExecutionRequest` and `ExecutionResult` types exist and are tested.
- [ ] `HostDispatcher` builds requests and finalizes results.
- [ ] `AgentLoop.processMessage` accepts the new parameter shape and returns `newMessages`.
- [ ] `AgentLoop` no longer imports or calls `SessionManager`, `PermissionManager` (guardrails), or `EventBus` (outbound).
- [ ] `MessageQueue` constructor accepts an `AgentRunner`, not an `AgentLoop`.
- [ ] `HeartbeatScheduler` builds `ExecutionRequest` objects and calls `runner.execute()`.
- [ ] `index.js` instantiates `LocalRunner` and `HostDispatcher`, wires them into the pipeline.
- [ ] All existing tools are annotated with a `class` field.
- [ ] All Phase M3 end-to-end tests pass.
- [ ] The system produces identical adapter-visible behavior (same response content, same tool execution order, same persistence).
- [ ] Specs 01 through 09 are reviewed and updated where references to the old architecture are outdated.

## 10. Sequence Diagram (Full Pipeline After M3)

```
Adapter
  │ message:inbound
  ▼
index.js (event handler)
  │ rateLimiter.consume()
  │ permissionManager.checkAccess()
  │ inputSanitizer.sanitize()
  ▼
HostDispatcher.buildRequest(sanitizedMessage)
  │ sessionManager.resolveSessionId()
  │ sessionManager.getOrCreate()
  │ sessionManager.loadHistory()
  │ toolPolicy.getEffectiveToolNames()
  │ toolRegistry.getSchemas()
  │ memorySearch.search()
  │ skillLoader.matchTrigger()
  ▼
ExecutionRequest
  │
  ▼
MessageQueue.enqueue(sessionId, request)
  │ (per-session serialization)
  ▼
LocalRunner.execute(request)
  │ translate request → AgentLoop params
  ▼
AgentLoop.processMessage(params)
  │ promptBuilder.build(from request data)
  │ ReAct loop (LLM + tools)
  │ contextCompactor (if needed)
  ▼
{ content, newMessages, toolsUsed, tokenUsage, ... }
  │ translate → ExecutionResult
  ▼
LocalRunner returns ExecutionResult
  │
  ▼
HostDispatcher.finalize(request, result, originalMessage)
  │ permissionManager.checkModelGuardrails()
  │ sessionManager.appendMessages()
  │ eventBus.emit('message:outbound')
  ▼
AdapterRegistry → Adapter.sendMessage()
```

## 11. Post-Refactor Spec Updates

After the migration is accepted, update these existing specs:

| Spec | Required Updates |
|------|-----------------|
| 01 — Runtime Core | Update §2.4 (AgentLoop) to reflect new parameter shape. Update §3 (Startup Sequence) to include runner and dispatcher. Update §2.2 (MessageQueue) constructor signature. |
| 03 — Tools | Add §6 documenting the `class` field and tool boundary classification. Reference spec 13. |
| 04 — Memory | Note that memory search is now performed by the host before execution, not by the prompt builder. |
| 07 — Security | Note that outbound guardrails are now applied by the host dispatcher, not inside the agent loop. |

Specs 02, 05, 06, 08, and 09 require no changes.
