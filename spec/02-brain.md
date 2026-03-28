# Spec 02 — Brain (LLM Layer)

> Status: **Implemented** | Owner: — | Last updated: 2026-03-28

## 1. Purpose

The brain layer abstracts LLM interaction behind a provider interface, assembles system prompts from multiple sources, and manages context window limits via compaction.

## 2. Components

### 2.1 LLM Provider Interface

**File:** `src/brain/llm-provider.js`
**Class:** `LLMProvider` (abstract base)

**Interface:**

```js
async createMessage(
  systemPrompt: string,
  messages: Message[],
  tools: ToolSchema[]
): Promise<LLMResponse>

async streamMessage(
  systemPrompt: string,
  messages: Message[],
  tools: ToolSchema[]
): AsyncIterable<StreamEvent>

estimateTokens(messages: Message[]): number
```

**LLMResponse shape:**

```js
{
  content: ContentBlock[],   // Array of { type: 'text', text } or { type: 'tool_use', id, name, input }
  stopReason: string,        // 'end_turn' | 'stop' | 'tool_use' | 'max_tokens'
  usage: {
    inputTokens: number,
    outputTokens: number
  }
}
```

**Token estimation:** Default implementation uses `JSON.stringify(messages).length / 4`. Providers may override with more accurate estimates.

### 2.2 Anthropic Provider

**File:** `src/brain/anthropic-provider.js`
**Class:** `AnthropicProvider extends LLMProvider`

**Configuration:**
- Uses `config.anthropicApiKey` for authentication
- Uses `config.model` for model selection (default: `claude-sonnet-4-20250514`)
- `max_tokens`: 8192 per response

**API call mapping:**
- `systemPrompt` → `system` parameter
- `messages` → `messages` parameter (passed through directly)
- `tools` → `tools` parameter (only included if non-empty)

**Retry behavior:**
- Max retries: 3
- Retryable status codes: `429` (rate limit), `500` (server error), `529` (overloaded)
- Backoff: exponential — `2^attempt * 1000ms` (2s, 4s, 8s)
- Non-retryable errors propagate immediately

**Token estimation:** Overrides base with `text.length / 3.5` (Anthropic-specific ratio).

### 2.2b Ollama Provider

**File:** `src/brain/ollama-provider.js`
**Class:** `OllamaProvider extends LLMProvider`

Alternative LLM backend for local or cloud-hosted Ollama models. Loaded dynamically when `config.llmProvider === 'ollama'`.

**Configuration:**
- Uses `config.ollamaHost` for API endpoint (default: `http://localhost:11434`)
- Uses `config.ollamaModel` for model selection (default: `llama3.1`)
- Uses `config.ollamaApiKey` for optional API authentication (default: empty). When set, sends `Authorization: Bearer <key>` header with requests (required for Ollama Cloud).

**Retry behavior:**
- Max retries: 3
- Retryable status codes: `429` (rate limit), `500` (server error), `503` (service unavailable)
- Backoff: exponential — `2^attempt * 1000ms` (2s, 4s, 8s)

Note: Ollama uses `503` instead of Anthropic's `529` since it follows standard HTTP semantics.

### 2.3 Prompt Builder

**File:** `src/brain/prompt-builder.js`
**Class:** `PromptBuilder`

Assembles the complete system prompt from multiple sources.

**Interface:**

```js
async build(
  session: Session,
  availableTools: ToolSchema[],
  skillInstructions?: string,
  memorySnippets?: MemorySnippet[],
  workspaceState?: string
): Promise<string>
```

Note: `availableTools` is accepted for interface consistency but not currently used in assembly. Tool schemas are passed directly to the LLM API call, not embedded in the system prompt.

**Assembly order (each section separated by newline):**

1. **Agent personality** — contents of `SOUL.md` (cached after first read, falls back to a default string if file missing). If the session has an active agent profile with a custom `soul`, that is used instead.
2. **Current context** — date/time (ISO), user name, channel, (if active) agent profile name, and active model name (see [Spec 27](27-command-context-persistence.md))
3. **Relevant memories** — pre-searched by the host (`HostDispatcher`) and passed as `memorySnippets`. Each snippet is truncated to 300 chars by the host before inclusion.
3b. **Workspace state** — pre-scanned by the host (`StateBootstrap`) and passed as `workspaceState`. Contains the living project state document, latest session log entry, and latest decision. See [Spec 29](29-persistent-workspace-state.md).
4. **Skill instructions** — optional, injected when a skill is active

**Caching:** `SOUL.md` is read once and cached for the process lifetime. To reload, restart the agent.

**Note:** Memory search was previously performed inside `build()` by calling `memorySearch.search()`. After the host/runtime boundary refactor, memory search is performed by the host (`HostDispatcher.buildRequest()`) and the results are passed into the runtime via the `ExecutionRequest`. The `PromptBuilder` now receives pre-searched snippets as a parameter.

### 2.4 Context Compactor

**File:** `src/brain/context-compactor.js`
**Class:** `ContextCompactor`

Manages context window size by summarizing older messages when the estimated token count exceeds a threshold. Uses rolling compression and configurable retention. See [Spec 15](15-conversations-context.md) for full design rationale.

**Interface:**

```js
shouldCompact(messages: Message[]): boolean
async compact(messages: Message[]): Message[]
```

**Algorithm:**

1. `shouldCompact` returns `true` if `llmProvider.estimateTokens(messages) > config.compactionThreshold`
2. If fewer than `retainMessages + 4` messages, skip compaction (not enough to summarize).
3. Split at `messages.length - retainMessages` (keeps a configurable number of recent messages intact).
4. **Rolling compression:** If the first message is a prior summary (`[Previous conversation summary]`), the summarization prompt instructs the LLM to merge the old summary with the newly-old messages into a single updated summary. Otherwise, a standard summarization prompt is used.
5. Messages are serialized via `_formatMessages()` as `[role]: content` blocks.
6. Replace the older portion with a single synthetic message: `{ role: 'user', content: '[Previous conversation summary]: ...' }`
7. Return `[summaryMessage, ...recentMessages]`.
8. If summarization LLM call fails, log a warning and prepend a sentinel summary (`[Summarization failed. Some earlier context may be missing.]`) before the retained messages so the agent knows context was lost.

**Configuration:**
- `config.compactionThreshold`: token count triggering compaction (default: 80,000)
- `config.compactionRetainMessages`: number of recent messages to keep after compaction (default: 10)
- `config.maxContextTokens`: informational upper bound (default: 100,000)

### 2.5 History Pruner

**File:** `src/brain/history-pruner.js`
**Class:** `HistoryPruner`

Trims oversized tool results in conversation history to reclaim context space. Operates in-memory only — does not modify the database. Called by `HostDispatcher.buildRequest()` after loading history, before every LLM request.

**Interface:**

```js
prune(messages: Message[]): Message[]   // Returns new array, does not mutate input
```

**Algorithm:** For each message with array content, any `tool_result` block whose text exceeds `config.pruneThreshold` (default: 4000 chars) is trimmed to head + `...[pruned N chars]...` + tail.

**Configuration:**
- `config.pruneThreshold`: chars above which tool results are pruned (default: 4000)
- `config.pruneHead`: chars to keep from start (default: 1500)
- `config.pruneTail`: chars to keep from end (default: 1500)

## 3. Adding a New LLM Provider

1. Create `src/brain/<provider-name>-provider.js` extending `LLMProvider`.
2. Implement `createMessage()` mapping to the provider's API format.
3. Add a config variable (e.g., `OPENAI_API_KEY`).
4. Wire it in `src/index.js` based on a config flag (e.g., `config.llmProvider === 'openai'`).
5. Update this spec.

### 2.6 Memory Flusher

**File:** `src/brain/memory-flusher.js`
**Class:** `MemoryFlusher`

Shared logic for pre-compaction and pre-clear memory flush. Sends a single LLM turn restricted to `save_memory`, then executes any tool calls. Used by both `AgentLoop` (before compaction) and `CommandRouter` (before `/new` clear). See [Spec 15 §4](15-conversations-context.md) for design rationale.

**Interface:**

```js
async flush(systemPrompt, messages, toolSchemas, sessionForPrompt, flushPrompt): void
```

The `messages` array is mutated: the flush prompt, LLM response, and tool results are appended. The `toolSchemas` array is filtered internally to expose only `save_memory`. Tool execution is also guarded to only allow `save_memory` calls.

## 4. Design Decisions

| Decision | Rationale |
|----------|-----------|
| Abstract provider interface | Allows swapping LLMs (Anthropic, OpenAI, local) without changing the agent loop. |
| Prompt assembly in a dedicated class | Keeps the agent loop clean. Prompt logic is independently testable. |
| Configurable retention over midpoint split | A fixed retention count gives predictable context budgets. Midpoint split retains a variable number depending on history length. |
| Rolling compression over summary chains | Chaining summaries compounds information loss. Merging the old summary with new messages maintains coherence. |
| Fallback to truncation on compaction failure | Guarantees the loop can always continue, even if the summarization call fails. |
| Pruning as a separate layer from compaction | Pruning is cheap (string slicing), reversible (DB untouched), and effective for the most common bloat source (tool results). Delays compaction. |
| SOUL.md cached for process lifetime | Avoids filesystem reads on every message. Restart to reload. |
