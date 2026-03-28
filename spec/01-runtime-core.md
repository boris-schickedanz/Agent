# Spec 01 — Runtime Core

> Status: **Implemented** | Owner: — | Last updated: 2026-03-28

## 1. Purpose

The runtime core orchestrates message flow from adapters through security gates, the ReAct agent loop, and back out to adapters. It is the central nervous system of AgentCore.

## 2. Components

### 2.1 Event Bus

**File:** `src/core/event-bus.js`
**Class:** `EventBus extends EventEmitter`

A lightweight in-process pub/sub system that decouples adapters from the agent loop. All cross-component communication flows through events.

**Registered events:**

| Event | Payload | Emitted by | Consumed by |
|-------|---------|------------|-------------|
| `message:inbound` | `NormalizedMessage` | Adapters | `src/index.js` (security pipeline) |
| `message:outbound` | `OutboundMessage` | HostDispatcher | AdapterRegistry |
| `stream:event` | `StreamEvent` | Inbound handler (via `onStreamEvent` callback) | AdapterRegistry → Adapter.handleStreamEvent() |
| `error` | `Error` | Any component | Global error handler |

**Constraints:**
- Max listeners: 50 (configurable via `setMaxListeners`)
- `emitAsync(event, ...args)` calls all listeners concurrently via `Promise.all` and swallows per-listener errors by emitting `error`

### 2.2 Message Queue

**File:** `src/core/message-queue.js`
**Class:** `MessageQueue`

Ensures execution requests within the single continuous session are processed serially (no interleaving).

**Interface:**

```js
constructor(runner: AgentRunner, logger: Logger)
enqueue(sessionId: string, executionRequest: ExecutionRequest, onStreamEvent?: Function): Promise<ExecutionResult>
getQueueDepth(sessionId: string): number
shutdown(): void
```

**Behavior:**
- Constructor accepts an `AgentRunner` (not `AgentLoop` directly). Calls `runner.execute(executionRequest)`.
- Internally maintains `Map<sessionId, QueueEntry[]>` and a `Set<sessionId>` of currently-processing sessions.
- When `enqueue` is called and no request is currently processing for that session, processing begins immediately.
- When a request finishes processing, the next queued request for that session (if any) begins.
- `shutdown()` sets a flag that causes subsequent `enqueue` calls to return `null`.
- Each `enqueue` returns a Promise that resolves with the runner's `ExecutionResult`.
- The optional `onStreamEvent` callback is forwarded to the runner for real-time streaming support.

### 2.3 Session Manager

**File:** `src/core/session-manager.js`
**Class:** `SessionManager`

Manages session lifecycle. Sessions are keyed by a canonical ID that supports cross-adapter continuity.

> **Single-user model note:** The current implementation produces per-adapter session IDs (`user:{channelId}:{userId}`), which means Console and Telegram get separate sessions with separate histories. The PRD requires all adapters to share a single session ([PRD §1](PRD-Use-Cases.md)). The `user_aliases` table referenced below is never queried. See [Spec 32](32-single-user-migration.md) for the migration plan.

**Interface:**

```js
resolveCanonicalUserId(adapterUserId: string, channelId: string): string
resolveSessionId(normalizedMessage: NormalizedMessage): string
getOrCreate(sessionId: string, userId: string, channelId: string, userName?: string): Session
loadHistory(sessionId: string, limit?: number): Message[]
appendMessage(sessionId: string, role: string, content: any): void
appendMessages(sessionId: string, messages: Message[]): void
```

**Session ID resolution:**

- `user:{canonicalUserId}` where `canonicalUserId` is resolved via the `user_aliases` table, falling back to `{channelId}:{adapterUserId}`. Example: `user:telegram:12345`.

**Session object shape:**

```js
{
  id: string,            // Canonical session ID (see above)
  userId: string,
  channelId: string,
  userName: string|null,
  metadata: object,
  lastUserMessage: string|null
}
```

**Behavior:**
- `resolveCanonicalUserId` checks the `user_aliases` table for cross-adapter identity mapping. Falls back to `channelId:adapterUserId`.
- `resolveSessionId` resolves the canonical session ID for the single user.
- Sessions are cached in-memory (`Map`) and persisted to the `sessions` SQLite table.
- `getOrCreate` does an `INSERT ... ON CONFLICT ... DO UPDATE` to upsert the session row.
- `loadHistory` and `appendMessages` delegate to `ConversationMemory`.

### 2.4 Agent Loop (ReAct)

**File:** `src/core/agent-loop.js`
**Class:** `AgentLoop`

The heart of the framework. Implements the ReAct (Reasoning + Acting) pattern. The loop is a pure runtime component: it accepts pre-loaded data and returns structured results. It does not perform session resolution, history loading, tool resolution, persistence, guardrails, or outbound emission — those are host concerns handled by `HostDispatcher`.

**Constructor dependencies:** `llmProvider`, `promptBuilder`, `toolExecutor`, `contextCompactor`, `logger`, `config` (reads `compactionMemoryFlush` and `maxContextTokens` from config)

**Interface:**

```js
async processMessage({
  history: Message[],
  userContent: string,
  toolSchemas: AnthropicToolSchema[],
  memorySnippets: MemorySnippet[],
  workspaceState: string | null,
  skillInstructions: string | null,
  sessionMetadata: object,
  maxIterations: number,
  cancellationSignal: { cancelled: boolean },
  onStreamEvent?: (event: StreamEvent) => void,
}): Promise<AgentLoopResult>
```

**Streaming:** When `onStreamEvent` is provided and the LLM provider supports streaming (`llm.supportsStreaming`), the loop calls `llm.streamMessage()` instead of `llm.createMessage()`. Stream events (`stream:start`, `stream:delta`, `stream:status`, `stream:end`) are forwarded to the callback, which ultimately emits them on the EventBus for adapter consumption.

**Processing steps:**

1. **System prompt assembly** — `promptBuilder.build(sessionForPrompt, toolSchemas, skillInstructions, memorySnippets, workspaceState)`
2. **Message array construction** — `[...history, { role: 'user', content: userContent }]`
3. **ReAct loop** (max `maxIterations` iterations):
   - a. **Cancellation check** — if `cancellationSignal.cancelled`, set `status: 'cancelled'`, break.
   - b. **Compaction check** — if `contextCompactor.shouldCompact(messages)`: (1) optionally run a pre-compaction memory flush turn (see [Spec 15 §4](15-conversations-context.md)), (2) compact. Memory flush runs at most once per `processMessage()` call.
   - c. **LLM call** — `llmProvider.createMessage(systemPrompt, messages, toolSchemas)`
   - d. **If `stopReason === 'end_turn'` or `'stop'`** — extract text blocks, break.
   - e. **If `stopReason === 'tool_use'`** — for each `tool_use` block: execute via `toolExecutor.execute(name, input, sessionForPrompt)`, collect `tool_result` blocks, push onto messages, continue loop.
   - f. **LLM error** — set fallback text, set `status: 'error'`, break.
4. **Return structured result** (not persisted or emitted — the host does that).

**Result shape:**

```js
{
  content: string,                 // Final text response
  newMessages: Message[],          // All messages generated (user echo, assistant, tool_use, tool_result)
  toolsUsed: string[],
  tokenUsage: { inputTokens: number, outputTokens: number },
  iterationCount: number,
  status: 'completed' | 'max_iterations' | 'error' | 'cancelled',
  error: { code: string, message: string, retriable: boolean } | null,
}
```

**Error handling:**
- LLM call failures set `status: 'error'` with `error.code: 'llm_error'` and `retriable: true`.
- Max iterations exceeded sets `status: 'max_iterations'`.
- Cancellation sets `status: 'cancelled'`.
- Individual tool failures are reported as `Error: ...` in the tool_result and the loop continues.

### 2.5 Host Dispatcher

**File:** `src/core/host-dispatcher.js`
**Class:** `HostDispatcher`

Extracts host concerns (session, tools, memory, skills, guardrails, persistence, delivery) from the agent loop into a single orchestration point. Provides two methods: `buildRequest` (before execution) and `finalize` (after execution).

**Interface:**

```js
async buildRequest(sanitizedMessage: NormalizedMessage, origin?: string): ExecutionRequest
async finalize(request: ExecutionRequest, result: ExecutionResult, originalMessage?: NormalizedMessage): OutboundMessage
```

**`buildRequest` steps:**
1. Session resolution — `sessionManager.resolveSessionId(message)` + `getOrCreate()`
2. History loading — `sessionManager.loadHistory(sessionId)`
3. History pruning — `historyPruner.prune(history)` trims oversized tool results in-memory (see [Spec 15 §3](15-conversations-context.md))
4. Tool resolution — `toolPolicy.getEffectiveToolNames()` → `toolRegistry.getSchemas()`
5. Skill matching — iterate `skillLoader.getLoadedSkills()` for trigger match
6. Memory search — `memorySearch.search(content, 5)`, truncate to 300 chars each
7. Workspace state scan — `stateBootstrap.scan()` loads well-known state keys for prompt injection (see [Spec 29](29-persistent-workspace-state.md))
8. Assemble `ExecutionRequest` with all resolved data

**`finalize` steps:**
1. Apply guardrails — `permissionManager.checkModelGuardrails(content)`
2. Persist — apply guardrailed content to last assistant message in `newMessages`, then `sessionManager.appendMessages()`
3. Deliver — emit `message:outbound` on `EventBus`

### 2.6 Runner Layer

**Files:** `src/core/runner/agent-runner.js`, `src/core/runner/local-runner.js`, `src/core/runner/execution-request.js`, `src/core/runner/execution-result.js`

The runner layer bridges the host and the agent loop. The host calls `runner.execute(request)` and receives an `ExecutionResult`. See [Spec 10 — Host & Runner Architecture](10-host-runtime-boundary.md) for full details.

**`AgentRunner`** — abstract base class with `execute(request)`, `cancel(executionId)`, `shutdown(timeoutMs)`.

**`LocalRunner extends AgentRunner`** — wraps `AgentLoop` in-process. Translates `ExecutionRequest` to loop params and loop result to `ExecutionResult`. Supports cancellation (cooperative signal), timeout (`Promise.race`), duplicate execution rejection, and graceful shutdown.

## 3. Startup Sequence

Defined in `src/index.js`. Components are instantiated in strict dependency order:

1. Logger (pino)
2. Database (SQLite singleton + migrations)
3. EventBus
4. LLM Provider (Anthropic or Ollama, based on `config.llmProvider`)
5. Context Compactor
6. Memory subsystems (ConversationMemory, PersistentMemory, MemorySearch)
6b. State bootstrap (reads well-known persistent memory keys for prompt injection, see [Spec 29](29-persistent-workspace-state.md))
7. Tool Registry + built-in tool registration (system, HTTP, memory tools)
7b. Sandbox + AuditLogger (workspace path sandboxing, tool execution logging)
7c. File system tools registration (read, write, edit, list, search, grep)
7d. ProcessManager + shell tools registration (run_command, background processes, etc.)
7e. DelegationManager + delegation tools registration (delegate_task, check, cancel)
8. Security layer (InputSanitizer, RateLimiter, ApprovalManager, ToolPolicy, PermissionManager)
9. Prompt Builder
9b. History Pruner
9c. Agent Registry (optional, loads profiles from `agents/`)
10. Session Manager, Tool Executor, AgentLoop (runtime core)
11. LocalRunner (wraps AgentLoop)
12. MessageQueue (accepts runner)
13. Skill Loader (optional, loaded before dispatcher)
14. Command Router (handles `/new`, `/approve`, `/reject`, `/agent`, `/model`, `/project`)
15. Host Dispatcher (owns session/tool/memory/skill resolution, pruning, and finalization)
16. Event bus wiring (`message:inbound` handler with security pipeline + command routing + streaming)
17. Adapter Registry + adapter registration (Telegram if configured, Console if TTY)
18. Health/Dashboard server (optional, if `healthPort > 0`)
19. Task Scheduler (optional, falls back to legacy HeartbeatScheduler)
20. `adapterRegistry.startAll()`

**Inbound message pipeline (wired on EventBus):**

```
message:inbound
  → rateLimiter.consume(userId)              — reject if rate limited
  → permissionManager.checkAccess(userId, channelId)  — reject if blocked
  → inputSanitizer.sanitize(message)         — strip dangerous content
  → inputSanitizer.detectInjection(content)  — soft check, log only
  → commandRouter.handle(sanitized)          — intercept /new, /approve, /reject, /agent, /model, /project
  → await dispatcher.buildRequest(sanitized)  — resolve session, tools, memory, skills, workspace state, prune history
  → onStreamEvent callback created           — bridges AgentLoop streaming to EventBus
  → messageQueue.enqueue(sessionId, request, onStreamEvent) — per-session serialization → runner.execute()
  → dispatcher.finalize(request, result)     — guardrails, persistence, delivery
```

## 4. Shutdown

Triggered by `SIGINT` or `SIGTERM`:

1. `messageQueue.shutdown()` — stop accepting new requests
2. `scheduler.stop()` — stop task scheduler (if running)
3. `runner.shutdown()` — wait for in-flight executions, then force-cancel remaining
4. `processManager.shutdownAll()` — terminate all background processes
5. `adapterRegistry.stopAll()` — stop all adapters
6. `db.close()` — close SQLite connection
7. `process.exit(0)`

## 5. Design Decisions

| Decision | Rationale |
|----------|-----------|
| EventBus over direct calls | Decouples adapters from core. Adding a new adapter requires zero changes to the agent loop. |
| Per-session serial queue | Prevents race conditions from rapid messages by the same user. Different users are not blocked. |
| Session key = `user:{canonical}` | Supports cross-adapter identity via user_aliases for the single user. |
| Console adapter conditional on TTY | Prevents readline EOF crashes under daemon/launchd/nohup. |
| Max iterations cap | Safety valve against infinite tool loops. Default 25 is generous for complex multi-step tasks. |
| Dynamic imports for optional modules | Telegram, skills, and heartbeat only load if configured/available. Keeps startup fast. |

## 6. Extension Points

- **New event types:** Add to the EventBus and document in this spec.
- **Custom message pipeline middleware:** Insert additional handlers in the `message:inbound` listener chain in `src/index.js`.
- **Alternative queue strategies:** Replace `MessageQueue` with a priority queue or distributed queue while preserving the same interface.
