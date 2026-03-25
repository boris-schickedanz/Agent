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
| `message:outbound` | `OutboundMessage` | AgentLoop | AdapterRegistry |
| `tool:executed` | `{ tool, success, durationMs, sessionId }` | AgentLoop | Listeners (logging, metrics) |
| `error` | `Error` | Any component | Global error handler |

**Constraints:**
- Max listeners: 50 (configurable via `setMaxListeners`)
- `emitAsync(event, ...args)` calls all listeners concurrently via `Promise.all` and swallows per-listener errors by emitting `error`

### 2.2 Message Queue

**File:** `src/core/message-queue.js`
**Class:** `MessageQueue`

Ensures messages within a single session are processed serially (no interleaving) while different sessions process in parallel.

**Interface:**

```js
enqueue(sessionId: string, message: NormalizedMessage): Promise<OutboundMessage>
getQueueDepth(sessionId: string): number
shutdown(): void
```

**Behavior:**
- Internally maintains `Map<sessionId, QueueEntry[]>` and a `Set<sessionId>` of currently-processing sessions.
- When `enqueue` is called and no message is currently processing for that session, processing begins immediately.
- When a message finishes processing, the next queued message for that session (if any) begins.
- `shutdown()` sets a flag that causes subsequent `enqueue` calls to reject.
- Each `enqueue` returns a Promise that resolves with the agent's outbound response for that message.

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

The heart of the framework. Implements the ReAct (Reasoning + Acting) pattern.

**Interface:**

```js
async processMessage(normalizedMessage: NormalizedMessage): Promise<OutboundMessage>
```

**Processing steps (per inbound message):**

1. **Session resolution** — `sessionManager.getOrCreate(userId, channelId, userName)`
2. **History loading** — `sessionManager.loadHistory(sessionId)` (default limit: 50)
3. **Tool resolution** — `toolPolicy.getEffectiveToolNames(userId, session)` → `toolRegistry.getSchemas(allowedTools)`
4. **System prompt assembly** — `promptBuilder.build(session, toolSchemas)`
5. **Message array construction** — `[...history, { role: 'user', content }]`
6. **ReAct loop** (max `config.maxToolIterations` iterations):
   - a. **Compaction check** — if `contextCompactor.shouldCompact(messages)`, compact.
   - b. **LLM call** — `llmProvider.createMessage(systemPrompt, messages, toolSchemas)`
   - c. **If `stopReason === 'end_turn'` or `'stop'`** — extract text blocks, break.
   - d. **If `stopReason === 'tool_use'`** — for each `tool_use` block: execute via `toolExecutor.execute(name, input, session)`, collect `tool_result` blocks, push onto messages, continue loop.
   - e. **LLM error** — set fallback text, break.
7. **Persistence** — `sessionManager.appendMessages(sessionId, newMessages)`
8. **Emit** — `eventBus.emit('message:outbound', outbound)`

**Outbound message shape:**

```js
{
  sessionId: string,
  channelId: string,
  userId: string,
  content: string,           // Final text response
  replyTo: string|null,
  metadata: {
    toolsUsed: string[],
    tokenUsage: { inputTokens: number, outputTokens: number },
    processingTimeMs: number
  }
}
```

**Error handling:**
- LLM call failures produce a user-friendly fallback message.
- Max iterations exceeded produces a fallback message.
- Individual tool failures are reported as `Error: ...` in the tool_result and the loop continues (the LLM sees the error and can adapt).

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
10. Session Manager
11. Tool Executor
12. Agent Loop
13. Message Queue
14. Event bus wiring (`message:inbound` handler with security pipeline)
15. Adapter Registry + adapter registration (Telegram if configured, Console always)
16. Skill Loader (optional)
17. Heartbeat Scheduler (optional)
18. `adapterRegistry.startAll()`

**Inbound message pipeline (wired on EventBus):**

```
message:inbound
  → rateLimiter.consume(userId)          — reject if rate limited
  → permissionManager.checkAccess(userId, channelId)  — reject if blocked
  → inputSanitizer.sanitize(message)     — strip dangerous content
  → messageQueue.enqueue(sessionId, sanitizedMessage)
```

## 4. Shutdown

Triggered by `SIGINT` or `SIGTERM`:

1. `messageQueue.shutdown()` — stop accepting new messages
2. `adapterRegistry.stopAll()` — stop all adapters
3. `db.close()` — close SQLite connection
4. `process.exit(0)`

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
