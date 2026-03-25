# Spec 15 — Session Reset & Context Management

> Status: **Implemented** | Owner: — | Last updated: 2026-03-25

## 1. Purpose

Add a `/new` command for starting fresh sessions and implement layered context management (pruning, pre-compaction memory flush, rolling compaction) to keep long-running conversations effective.

### 1.1 Motivation

The current session model — one continuous history per user — is the right default for a personal agent. Continuity is a feature, not a bug. But two problems remain:

1. **No escape hatch.** When a user wants a genuinely fresh start (new topic, clean slate), there is no way to do it without restarting the agent or manually clearing the DB.
2. **Context grows unboundedly until compaction.** The only defense is a midpoint-split summarization that fires late and loses nuance. There is no incremental trimming of bloated tool results, and no mechanism to save important facts before they are compacted away.

### 1.2 Prior Art

| Project | Reset model | Context management |
|---------|------------|-------------------|
| **OpenClaw** | `/new` or `/reset` mints a fresh transcript under the same session key. Also supports idle timeout and daily auto-reset (default 4 AM). | 3-layer: pruning (trim tool results in-memory), compaction (LLM summary persisted, rolling merge), memory flush (silent agentic turn saves facts before compaction). |
| **NanoClaw** | One continuous conversation per group. No reset command. | No built-in pruning or compaction. Relies on container isolation keeping contexts small. |

This spec adopts OpenClaw's `/new` command (simplified) and its layered context management approach.

## 2. `/new` Command

### 2.1 Behavior

The `/new` command clears the current session's message history and starts fresh. Persistent memory (markdown files + FTS index) is **not** affected — the agent retains all long-term knowledge.

1. User sends `/new`.
2. Intercepted in `index.js` **before** `dispatcher.buildRequest()`.
3. Resolve session from the inbound message.
4. Call `conversationMemory.clearSession(sessionId)`.
5. Respond directly (no LLM call): `"Conversation cleared. Persistent memories are still available."`

If the user sends `/new <message>`, the history is cleared and `<message>` is forwarded through the normal pipeline as the first message of the fresh session.

### 2.2 Pre-Clear Memory Flush (Optional)

When `config.compactionMemoryFlush` is enabled and the session has messages, trigger a memory flush **before** clearing:

1. Estimate tokens in current history.
2. If above a minimum threshold (`> 2000` tokens — skip flush for near-empty sessions):
   - Send the history to the LLM with the flush prompt (§4.2).
   - The LLM calls `save_memory` for anything worth preserving.
3. Clear the session history.
4. Respond.

This ensures that important context from the cleared conversation is not lost. The flush is best-effort — if it fails, the clear proceeds anyway.

### 2.3 Command Handling

**File:** `src/core/command-router.js`
**Class:** `CommandRouter`

```js
class CommandRouter {
  constructor({ sessionManager, conversationMemory, llmProvider, toolExecutor,
                toolRegistry, promptBuilder, config, eventBus, logger }) { ... }

  /**
   * Check if the message is a host command.
   * Returns true if handled (response emitted), false if normal pipeline should continue.
   */
  async handle(sanitizedMessage): Promise<{ handled: boolean, forwardContent?: string }>
}
```

Internally creates a `MemoryFlusher` instance (see §4) for pre-clear flushes. The `toolRegistry` parameter is optional — falls back to `toolExecutor.registry` if not provided.

Return shape:
- `{ handled: true }` — command fully handled, response emitted. Stop pipeline.
- `{ handled: true, forwardContent: "the user message" }` — command handled (history cleared), but forward the trailing content as a new message through the normal pipeline.
- `{ handled: false }` — not a command. Continue normal pipeline.

**Wiring in `index.js`:** After sanitization and permission check, before `dispatcher.buildRequest()`:

```js
const sanitized = inputSanitizer.sanitize(message);
// ... permission check ...

const cmd = await commandRouter.handle(sanitized);
if (cmd.handled && !cmd.forwardContent) return;
if (cmd.handled && cmd.forwardContent) {
  sanitized.content = cmd.forwardContent;
}

const request = dispatcher.buildRequest(sanitized);
// ... rest of pipeline
```

## 3. Tool Result Pruning (Layer 1)

**When:** Every request, in `HostDispatcher.buildRequest()` after loading history.
**What:** Trim oversized tool results in the loaded history array. Does **not** modify the database.
**Why:** Tool results (file contents, HTTP responses, search results) are often large but only the key parts matter for ongoing conversation. This is the cheapest way to reclaim context space and delay compaction.

### 3.1 Algorithm

```
For each message in history:
  If message.content is an array (content blocks):
    For each block where block.type === 'tool_result':
      text = (typeof block.content === 'string') ? block.content : JSON.stringify(block.content)
      If text.length > PRUNE_THRESHOLD (default: 4000 chars):
        Keep first PRUNE_HEAD chars (default: 1500)
        Keep last PRUNE_TAIL chars (default: 1500)
        Replace middle with "\n...[pruned {N} chars]...\n"
```

### 3.2 Interface

**File:** `src/brain/history-pruner.js`
**Class:** `HistoryPruner`

```js
class HistoryPruner {
  constructor(config) {
    this.threshold = config.pruneThreshold ?? 4000;
    this.head = config.pruneHead ?? 1500;
    this.tail = config.pruneTail ?? 1500;
  }

  /**
   * Returns a new array with pruned tool results. Does not mutate input.
   */
  prune(messages): Message[]
}
```

### 3.3 Integration Point

Called in `HostDispatcher.buildRequest()`:

```js
const history = this.sessionManager.loadHistory(sessionId);
const prunedHistory = this.historyPruner.prune(history);
// ... use prunedHistory in ExecutionRequest
```

## 4. Pre-Compaction Memory Flush (Layer 2)

**When:** Immediately before compaction is triggered, inside `AgentLoop`.
**What:** Inject a special turn so the LLM writes durable memories before history is summarized.
**Why:** Compaction summaries are lossy. Critical facts, decisions, and preferences should be persisted to long-term memory before they are compressed. This is OpenClaw's most impactful innovation.

### 4.1 Trigger

In `AgentLoop.processMessage()`, at the top of each ReAct loop iteration, before the LLM call:

```
if contextCompactor.shouldCompact(messages) AND config.compactionMemoryFlush AND !flushedThisTurn:
  → set flushedThisTurn = true
  → if adding flush prompt would not exceed maxContextTokens:
    → delegate to memoryFlusher.flush() (LLM may call save_memory)
  → then proceed to compaction
```

### 4.2 Flush Prompt

Injected as a synthetic system message:

```
[System] Context compaction will run after this turn.
Review the conversation and save any important information to long-term memory using the save_memory tool. Focus on:
- Key decisions and their reasoning
- User preferences and corrections
- Facts or data that would be lost in a summary
- Ongoing task state or progress
Only save what is genuinely important. Do not respond to the user.
```

### 4.3 Guard Rails

- Memory flush runs **at most once per `processMessage()` call**. The `flushedThisTurn` flag prevents loops.
- If the flush turn itself causes an error, log it and proceed directly to compaction. Never block the user's request.
- If the estimated tokens after adding the flush prompt would exceed `config.maxContextTokens`, skip the flush and compact immediately. Don't make the overflow worse.

## 5. Enhanced Compaction (Layer 3)

Improves the current `ContextCompactor` (Spec 02 §2.4) with rolling compression and configurable retention.

### 5.1 Rolling Compression

**Current problem:** If compaction runs multiple times, each summary only knows about the messages it summarized. The first summary is discarded when the second runs, creating information loss chains.

**Solution:** When the first message in the history is a `[Previous conversation summary]`, the new compaction includes it as context for the summarizer. The result is a single **merged** summary.

```
Input:  [old summary] [msg5] [msg6] [msg7] [msg8] [msg9] [msg10]
                       ^^^^^^^^^^^^^^^^^^^^^^^^  ^^^^^^^^^^^^^^^^^^
                       to summarize (merge with   to keep
                       old summary)

Output: [merged summary] [msg9] [msg10]
```

The summarization prompt detects the presence of a prior summary:

```
You are updating a running conversation summary. The previous summary and new
messages since then are provided below. Produce a single merged summary that
incorporates both. Preserve key facts, decisions, tool results, and user
preferences. Output only the summary.
```

When there is no prior summary, the current prompt is used unchanged.

### 5.2 Configurable Retention

Instead of a fixed midpoint split, keep a configurable number of recent messages:

| Config key | Default | Description |
|------------|---------|-------------|
| `config.compactionRetainMessages` | `10` | Number of recent messages to keep intact after compaction |
| `config.compactionThreshold` | `80000` | Token estimate triggering compaction (existing) |

The split point is `messages.length - retainMessages`, clamped so at least 4 messages are available for summarization. If there aren't enough messages to both summarize and retain, skip compaction.

### 5.3 Persistence After Compaction

After `compact()` returns the new message array:

1. `ConversationMemory.replaceHistory(sessionId, compactedMessages)` — existing method, already handles this atomically (clear + re-insert in a transaction).
2. The compacted messages become the new history for subsequent turns.

This is unchanged from the current implementation. The `replaceHistory` method in [conversation-memory.js:58-66](src/memory/conversation-memory.js#L58-L66) already supports this.

### 5.4 Updated `compact()` Method

```js
async compact(messages) {
  if (messages.length < this.retainMessages + 4) return messages;

  const splitPoint = messages.length - this.retainMessages;
  const olderMessages = messages.slice(0, splitPoint);
  const recentMessages = messages.slice(splitPoint);

  // Detect prior summary for rolling compression
  const hasPriorSummary = typeof olderMessages[0]?.content === 'string'
    && olderMessages[0].content.startsWith('[Previous conversation summary]');

  const prompt = hasPriorSummary
    ? 'You are updating a running conversation summary. The previous summary and new messages since then are provided below. Produce a single merged summary that incorporates both. Preserve key facts, decisions, tool results, and user preferences. Output only the summary.'
    : 'Summarize the following conversation concisely, preserving key facts, decisions, tool results, and user preferences. Output only the summary.';

  try {
    const response = await this.llmProvider.createMessage(
      'You are a conversation summarizer. Be concise but preserve important details.',
      [{ role: 'user', content: `${prompt}\n\n${this._formatMessages(olderMessages)}` }],
      []
    );

    const summaryText = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');

    return [
      { role: 'user', content: `[Previous conversation summary]: ${summaryText}` },
      ...recentMessages,
    ];
  } catch {
    return recentMessages; // Fallback: truncate
  }
}
```

## 6. Configuration

New environment variables (added to `src/config.js`):

| Variable | Default | Description |
|----------|---------|-------------|
| `COMPACTION_RETAIN_MESSAGES` | `10` | Messages to keep after compaction |
| `COMPACTION_MEMORY_FLUSH` | `true` | Enable pre-compaction memory flush |
| `PRUNE_THRESHOLD` | `4000` | Chars above which tool results are pruned |
| `PRUNE_HEAD` | `1500` | Chars to keep from start of pruned result |
| `PRUNE_TAIL` | `1500` | Chars to keep from end of pruned result |

Existing variables `COMPACTION_THRESHOLD` (default: 80000) and `MAX_CONTEXT_TOKENS` (default: 100000) remain unchanged.

## 7. Affected Components

| Component | Change |
|-----------|--------|
| `ContextCompactor` | Rolling compression, configurable retention, `_formatMessages` helper |
| `AgentLoop` | Memory flush delegation to `MemoryFlusher` before compaction |
| `HostDispatcher` | Pruning step in `buildRequest()` |
| `index.js` | Command router wired before `buildRequest()` |
| `src/config.js` | New env vars |

New files:

| File | Purpose |
|------|---------|
| `src/core/command-router.js` | `/new` command handling |
| `src/brain/history-pruner.js` | Tool result pruning |
| `src/brain/memory-flusher.js` | Shared memory flush logic (used by both AgentLoop and CommandRouter) |

No database migration required. The session model is unchanged.

## 8. Implementation Plan

### Phase 1: `/new` Command

1. Implement `CommandRouter` with `/new` handling (simple version: clear + respond).
2. Wire into `index.js` after sanitization, before `buildRequest()`.
3. Support `/new <message>` forwarding.
4. Tests: command parsing, history clearing, forward content.

### Phase 2: Tool Result Pruning

1. Implement `HistoryPruner`.
2. Inject into `HostDispatcher`, call in `buildRequest()` after loading history.
3. Tests: pruning thresholds, content block types, no-mutation guarantee, edge cases (empty content, non-array content).

### Phase 3: Enhanced Compaction

1. Refactor `ContextCompactor`: rolling compression, configurable retention via `retainMessages`.
2. Add `_formatMessages` helper for clean serialization.
3. Tests: rolling merge with prior summary, first-time compaction, retention count, fallback on error.

### Phase 4: Pre-Compaction Memory Flush

1. Add flush logic in `AgentLoop.processMessage()`: detect compaction trigger, inject flush prompt, process flush turn, then compact.
2. Add guard rails: once-per-call flag, token overflow check, error handling.
3. Wire `config.compactionMemoryFlush` toggle.
4. Tests: flush triggers save_memory, flush skipped when disabled, flush skipped on overflow, flush error doesn't block compaction.

### Phase 5: `/new` with Memory Flush

1. Extend `CommandRouter` to optionally run memory flush before clearing (for sessions with substantial history).
2. Tests: flush before clear, flush failure doesn't block clear, skip flush for near-empty sessions.

## 9. Design Decisions

| Decision | Rationale |
|----------|-----------|
| Single session per user, no conversation table | A personal agent benefits from continuity. Multi-conversation adds complexity without clear value for the primary use case. `/new` provides an escape hatch when needed. |
| `/new` clears history rather than creating a new session ID | Keeps session identity stable for routing, message queue keying, and cross-adapter continuity. Only the message history resets. |
| Host command intercepted before the LLM | `/new` is a deterministic operation. No LLM tokens needed. |
| Pruning as a separate layer from compaction | Pruning is cheap (string slicing), reversible (DB untouched), and effective for the most common bloat source (tool results). It delays compaction and preserves more conversational context. |
| Memory flush before compaction | Compaction summaries are lossy by nature. Persisting key facts to long-term memory before compression ensures they survive. Inspired by OpenClaw's approach. |
| Rolling compression over summary chains | Chaining summaries (`[Summary of [Summary of ...]]`) compounds information loss. Merging the old summary with new messages into a single summary maintains coherence. |
| Configurable retention count over midpoint split | Midpoint split retains a variable number of messages depending on history length. A fixed retention count gives predictable context budgets. |
| Memory flush is Phase 4, not Phase 1 | The flush mechanism touches `AgentLoop` internals and requires careful interaction with the tool executor. Building it after the simpler layers are stable reduces risk. |
