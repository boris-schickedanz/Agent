# Spec 01 — Runtime Core

> Status: **Implemented** | Owner: — | Last updated: 2026-03-25

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
| `error` | `Error` | Any component | Global error handler |

**Constraints:**
- Max listeners: 50 (configurable via `setMaxListeners`)
- `emitAsync(event, ...args)` calls all listeners concurrently via `Promise.all` and swallows per-listener errors by emitting `error`

### 2.2 Message Queue

**File:** `src/core/message-queue.js`
**Class:** `MessageQueue`

Ensures execution requests within a single session are processed serially (no interleaving) while different sessions process in parallel.

**Interface:**

```js
constructor(runner: AgentRunner, logger: Logger)
enqueue(sessionId: string, executionRequest: ExecutionRequest): Promise<ExecutionResult>
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

### 2.3 Session Manager

**File:** `src/core/session-manager.js`
**Class:** `SessionManager`

Manages session lifecycle. A session represents one conversation context, keyed by `channelId:userId`.

**Interface:**

```js
getSessionKey(userId: string, channelId: string): string
getOrCreate(userId: string, channelId: string, userName?: string): Session
loadHistory(sessionId: string, limit?: number): Message[]
appendMessage(sessionId: string, role: string, content: any): void
appendMessages(sessionId: string, messages: Message[]): void
```

**Session object shape:**

```js
{
  id: string,            // "channelId:userId"
  userId: string,
  channelId: string,
  userName: string|null,
  metadata: object,
  lastUserMessage: string|null
}
```

**Behavior:**
- Sessions are cached in-memory (`Map`) and persisted to the `sessions` SQLite table.
- `getOrCreate` does an `INSERT ... ON CONFLICT ... DO UPDATE` to upsert the session row.
- `loadHistory` and `appendMessages` delegate to `ConversationMemory`.

### 2.4 Agent Loop (ReAct)

**File:** `src/core/agent-loop.js`
**Class:** `AgentLoop`

The heart of the framework. Implements the ReAct (Reasoning + Acting) pattern. The loop is a pure runtime component: it accepts pre-loaded data and returns structured results. It does not perform session resolution, history loading, tool resolution, persistence, guardrails, or outbound emission — those are host concerns handled by `HostDispatcher`.

**Constructor dependencies:** `llmProvider`, `promptBuilder`, `toolExecutor`, `contextCompactor`, `logger`, `config`

**Interface:**

```js
async processMessage({
  history: Message[],
  userContent: string,
  toolSchemas: AnthropicToolSchema[],
  memorySnippets: MemorySnippet[],
  skillInstructions: string | null,
  sessionMetadata: object,
  maxIterations: number,
  cancellationSignal: { cancelled: boolean },
}): Promise<AgentLoopResult>
```

**Processing steps:**

1. **System prompt assembly** — `promptBuilder.build(sessionForPrompt, toolSchemas, skillInstructions, memorySnippets)`
2. **Message array construction** — `[...history, { role: 'user', content: userContent }]`
3. **ReAct loop** (max `maxIterations` iterations):
   - a. **Cancellation check** — if `cancellationSignal.cancelled`, set `status: 'cancelled'`, break.
   - b. **Compaction check** — if `contextCompactor.shouldCompact(messages)`, compact.
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
buildRequest(sanitizedMessage: NormalizedMessage, origin?: string): ExecutionRequest
async finalize(request: ExecutionRequest, result: ExecutionResult, originalMessage?: NormalizedMessage): OutboundMessage
```

**`buildRequest` steps:**
1. Session resolution — `sessionManager.resolveSessionId(message)` + `getOrCreate()`
2. History loading — `sessionManager.loadHistory(sessionId)`
3. Tool resolution — `toolPolicy.getEffectiveToolNames()` → `toolRegistry.getSchemas()`
4. Skill matching — iterate `skillLoader.getLoadedSkills()` for trigger match
5. Memory search — `memorySearch.search(content, 5)`, truncate to 300 chars each
6. Assemble `ExecutionRequest` with all resolved data

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
4. LLM Provider (AnthropicProvider)
5. Context Compactor
6. Memory subsystems (ConversationMemory, PersistentMemory, MemorySearch)
7. Tool Registry + built-in tool registration
8. Security layer (InputSanitizer, RateLimiter, ToolPolicy, PermissionManager)
9. Prompt Builder
10. Session Manager, Tool Executor, AgentLoop (runtime core)
11. LocalRunner (wraps AgentLoop)
12. MessageQueue (accepts runner)
13. Skill Loader (optional, loaded before dispatcher)
14. Host Dispatcher (owns session/tool/memory/skill resolution and finalization)
15. Event bus wiring (`message:inbound` handler with security pipeline)
16. Adapter Registry + adapter registration (Telegram if configured, Console always)
17. Heartbeat Scheduler (optional, uses runner)
18. `adapterRegistry.startAll()`

**Inbound message pipeline (wired on EventBus):**

```
message:inbound
  → rateLimiter.consume(userId)              — reject if rate limited
  → permissionManager.checkAccess(userId, channelId)  — reject if blocked
  → inputSanitizer.sanitize(message)         — strip dangerous content
  → dispatcher.buildRequest(sanitized)       — resolve session, tools, memory, skills
  → messageQueue.enqueue(sessionId, request) — per-session serialization → runner.execute()
  → dispatcher.finalize(request, result)     — guardrails, persistence, delivery
```

## 4. Shutdown

Triggered by `SIGINT` or `SIGTERM`:

1. `messageQueue.shutdown()` — stop accepting new requests
2. `runner.shutdown()` — wait for in-flight executions, then force-cancel remaining
3. `adapterRegistry.stopAll()` — stop all adapters
4. `db.close()` — close SQLite connection
5. `process.exit(0)`

## 5. Design Decisions

| Decision | Rationale |
|----------|-----------|
| EventBus over direct calls | Decouples adapters from core. Adding a new adapter requires zero changes to the agent loop. |
| Per-session serial queue | Prevents race conditions from rapid messages by the same user. Different users are not blocked. |
| Session key = `channelId:userId` | Allows the same user to have separate conversations on different channels. |
| Max iterations cap | Safety valve against infinite tool loops. Default 25 is generous for complex multi-step tasks. |
| Dynamic imports for optional modules | Telegram, skills, and heartbeat only load if configured/available. Keeps startup fast. |

## 6. Extension Points

- **New event types:** Add to the EventBus and document in this spec.
- **Custom message pipeline middleware:** Insert additional handlers in the `message:inbound` listener chain in `src/index.js`.
- **Alternative queue strategies:** Replace `MessageQueue` with a priority queue or distributed queue while preserving the same interface.
