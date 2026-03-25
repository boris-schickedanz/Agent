# Spec 02 — Brain (LLM Layer)

> Status: **Implemented** | Owner: — | Last updated: 2026-03-25

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
  memorySnippets?: MemorySnippet[]
): Promise<string>
```

**Assembly order (each section separated by newline):**

1. **Agent personality** — contents of `SOUL.md` (cached after first read, falls back to a default string if file missing)
2. **Current context** — date/time (ISO), session ID, user name, channel ID
3. **Relevant memories** — pre-searched by the host (`HostDispatcher`) and passed as `memorySnippets`. Each snippet is truncated to 300 chars by the host before inclusion.
4. **Tool count** — brief note about available tool count
5. **Skill instructions** — optional, injected when a skill is active

**Caching:** `SOUL.md` is read once and cached for the process lifetime. To reload, restart the agent.

**Note:** Memory search was previously performed inside `build()` by calling `memorySearch.search()`. After the host/runtime boundary refactor, memory search is performed by the host (`HostDispatcher.buildRequest()`) and the results are passed into the runtime via the `ExecutionRequest`. The `PromptBuilder` now receives pre-searched snippets as a parameter.

### 2.4 Context Compactor

**File:** `src/brain/context-compactor.js`
**Class:** `ContextCompactor`

Manages context window size by summarizing older messages when the estimated token count exceeds a threshold.

**Interface:**

```js
shouldCompact(messages: Message[]): boolean
async compact(messages: Message[]): Message[]
```

**Algorithm:**

1. `shouldCompact` returns `true` if `llmProvider.estimateTokens(messages) > config.compactionThreshold`
2. If fewer than 4 messages, skip compaction (not enough to summarize).
3. Split messages at the midpoint.
4. Send the older half to the LLM with a summarization prompt: *"Summarize the following conversation concisely, preserving key facts, decisions, tool results, and user preferences."*
5. Replace the older half with a single synthetic message: `{ role: 'user', content: '[Previous conversation summary]: ...' }`
6. Return `[summaryMessage, ...recentMessages]`.
7. If summarization LLM call fails, fall back to simply dropping the older half (truncation).

**Configuration:**
- `config.compactionThreshold`: token count triggering compaction (default: 80,000)
- `config.maxContextTokens`: informational upper bound (default: 100,000)

## 3. Adding a New LLM Provider

1. Create `src/brain/<provider-name>-provider.js` extending `LLMProvider`.
2. Implement `createMessage()` mapping to the provider's API format.
3. Add a config variable (e.g., `OPENAI_API_KEY`).
4. Wire it in `src/index.js` based on a config flag (e.g., `config.llmProvider === 'openai'`).
5. Update this spec.

## 4. Design Decisions

| Decision | Rationale |
|----------|-----------|
| Abstract provider interface | Allows swapping LLMs (Anthropic, OpenAI, local) without changing the agent loop. |
| Prompt assembly in a dedicated class | Keeps the agent loop clean. Prompt logic is independently testable. |
| Mid-point split for compaction | Simple, predictable. Preserves the most recent context which is most relevant. |
| Fallback to truncation on compaction failure | Guarantees the loop can always continue, even if the summarization call fails. |
| SOUL.md cached for process lifetime | Avoids filesystem reads on every message. Restart to reload. |
