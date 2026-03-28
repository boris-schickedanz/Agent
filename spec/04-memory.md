# Spec 04 — Memory System

> Status: **Implemented** | Owner: — | Last updated: 2026-03-28

## 1. Purpose

The memory system provides both short-term (per-session conversation history) and long-term (persistent, cross-session) storage. It enables the agent to maintain context within a conversation and recall knowledge across conversations.

## 2. Components

### 2.1 Conversation Memory

**File:** `src/memory/conversation-memory.js`
**Class:** `ConversationMemory`

SQLite-backed message history, scoped per session.

**Interface:**

```js
append(sessionId: string, role: string, content: any): void
appendMany(sessionId: string, messages: Message[]): void        // Transactional
getHistory(sessionId: string, limit?: number): Message[]         // Default limit: 50
getFullHistory(sessionId: string): Message[]
clearSession(sessionId: string): void
replaceHistory(sessionId: string, messages: Message[]): void     // Used after compaction
```

**Storage format:**
- `content` is stored as a string. Objects are `JSON.stringify`'d on write and `JSON.parse`'d on read.
- `token_estimate` is computed as `Math.ceil(content.length / 4)`.
- `appendMany` wraps all inserts in a single SQLite transaction for atomicity.

**Message shape returned by `getHistory`:**

```js
{ role: 'user' | 'assistant' | 'system', content: string | ContentBlock[] }
```

### 2.2 Persistent Memory

**File:** `src/memory/persistent-memory.js`
**Class:** `PersistentMemory`

Long-term memory stored as markdown files on disk, with an FTS5 index in SQLite for search.

**Interface:**

```js
async save(key: string, content: string, metadata?: object): void
async load(key: string): string | null
async list(): string[]
async delete(key: string): void
```

**Storage:**
- Files are written to `{config.dataDir}/memory/{safeKey}.md`
- `safeKey` is derived from `key` by replacing non-alphanumeric characters (except `_` and `-`) with `_`
- On `save`, the FTS5 index (`memory_fts` table) is updated: old entry deleted, new entry inserted
- On `delete`, both the file and FTS5 entry are removed

**Directory:** `{config.dataDir}/memory/` — created automatically if missing.

### 2.3 Memory Search

**File:** `src/memory/memory-search.js`
**Class:** `MemorySearch`

Full-text search across persistent memory using SQLite FTS5.

**Interface:**

```js
search(query: string, limit?: number): SearchResult[]    // Default limit: 5
async reindex(persistentMemory: PersistentMemory): Promise<void>
```

**SearchResult shape:**

```js
{ key: string, content: string, metadata: object }
```

**Query processing:**
- Special characters are stripped from the query (`/[^\w\s]/g` → space)
- Empty or whitespace-only queries return `[]`
- Results are ordered by FTS5 rank (relevance)
- Search failures (malformed queries, FTS errors) return `[]` silently

**Reindex:** Drops all FTS5 entries and rebuilds from all files in the memory directory. Use for recovery or after manual file edits.

### 2.4 State Bootstrap

**File:** `src/memory/state-bootstrap.js`
**Class:** `StateBootstrap`

Reads well-known persistent memory keys at request-build time and returns a formatted string for system prompt injection. Provides cross-session continuity by always injecting project state into the prompt, regardless of search relevance. Results are cached with a 60-second TTL to avoid repeated disk reads on the hot path.

**Interface:**

```js
async scan(): string | null
```

**Well-known keys:** `project_state`, `decision_journal`, `session_log`. See [Spec 29](29-persistent-workspace-state.md) for conventions and integration details.

## 3. How Memory Is Used in the Pipeline

1. **Host-side search:** `HostDispatcher.buildRequest()` calls `memorySearch.search(message.content, 5)` to find relevant memories and includes them as `memorySnippets` (truncated to 300 chars each) in the `ExecutionRequest`. This search was previously performed inside `PromptBuilder.build()` but was moved to the host as part of the host/runtime boundary refactor.
2. **Workspace state scan:** `HostDispatcher.buildRequest()` calls `stateBootstrap.scan()` to load well-known state keys (`project_state`, `decision_journal`, `session_log`) and includes the result as `workspaceState` in the `ExecutionRequest`. This provides guaranteed cross-session context injection independent of search relevance. See [Spec 29](29-persistent-workspace-state.md).
3. **Prompt building:** `PromptBuilder.build()` receives pre-searched `memorySnippets` and pre-scanned `workspaceState` from the request and includes both in the system prompt.
4. **Tool use:** The agent can explicitly call `save_memory`, `search_memory`, and `list_memories` tools to manage persistent memory.
5. **Context compaction:** When conversation history is compacted, the summary replaces older messages in conversation memory via `replaceHistory`.

## 4. FTS5 Configuration

The `memory_fts` virtual table uses:
- Tokenizer: `porter unicode61` (Porter stemming + Unicode normalization)
- Columns indexed: `key`, `content`, `metadata`
- Ranking: BM25 (FTS5 default)

## 5. Design Decisions

| Decision | Rationale |
|----------|-----------|
| SQLite for conversation history | Atomic writes, queryable, no external service. WAL mode handles concurrent reads. |
| Markdown files for persistent memory | Human-readable, editable, versionable. Easy to inspect and manually modify. |
| FTS5 for search | Built into SQLite. Porter stemming handles word variations. No external search service needed. |
| Dual storage (files + FTS index) | Files are the source of truth (human-editable). FTS is a derived index for fast search. |
| Silent search failures | Memory search is a non-critical enhancement. A search failure should never block message processing. |

## 6. Extension Points

- **Semantic search:** Replace or augment FTS5 with embedding-based search (e.g., store embeddings in SQLite, compute cosine similarity).
- **Memory categories:** Add a `category` column to FTS5 and file frontmatter to organize memories by type.
- **Memory expiry:** Add a `ttl` or `expires_at` field. The heartbeat scheduler can prune expired memories.
