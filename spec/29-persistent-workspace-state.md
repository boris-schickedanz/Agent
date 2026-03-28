# Spec 29 — Persistent Workspace State

> Status: **Implemented** | Owner: — | Last updated: 2026-03-28

## 1. Purpose

Give the agent continuity across conversation resets. Today, after a `/new` reset, the agent starts cold — the agent has no idea what it worked on last time, what decisions it made, or what's next. Users must re-explain context every session, and the agent can't build on its own prior work.

This spec defines conventions and a small orchestration layer so the agent maintains structured project state using the existing persistent memory system (Spec 04). Each run becomes a continuation, not a reset. Context compounds instead of being re-explained every time.

### 1.1 Motivation

The agent already has all the building blocks:

- **Persistent memory** (Spec 04): Persistent key-value store as markdown files + FTS5 search index. Agent can call `save_memory`, `search_memory`, `list_memories`.
- **Workspace** (Spec 17): Sandboxed directory with full file tools for project work.
- **Context compaction** (Spec 15): Pre-compaction memory flush saves important facts before history is summarized.
- **Memory auto-injection**: `HostDispatcher.buildRequest()` searches memory for relevant snippets (top 5, truncated to 300 chars) and injects them into the system prompt via `PromptBuilder`.

What's missing is the **protocol layer**:

1. **No state bootstrapping** — the agent doesn't orient itself from prior state at session start.
2. **No structured conventions** — no well-known place for project state, decisions, session history.
3. **No continuation protocol** — the agent doesn't know to check what it worked on last time.
4. **No guaranteed state injection** — memory auto-search is relevance-based; project state should always be visible regardless of what the user says.

### 1.2 Design Principles

| Principle | Application |
|-----------|-------------|
| Reuse existing infrastructure | All state stored via `PersistentMemory` (Spec 04). No new storage layer. |
| Convention over infrastructure | Define well-known memory keys and prompt conventions, not rigid schemas. |
| No new tools | Agent uses existing `save_memory` / `search_memory` / `list_memories`. |
| Opt-in complexity | Basic state (project doc) just works. Decision journal and session log are optional agent behaviors. |
| Non-blocking | State scan is best-effort. Failures never block message processing. |

## 2. Well-Known Memory Keys

The agent maintains structured state using three reserved memory keys. These are stored as markdown files in `data/memory/` and indexed in FTS5 — exactly like any other persistent memory.

| Memory Key | File on Disk | Purpose | Update Pattern |
|---|---|---|---|
| `project_state` | `data/memory/project_state.md` | Living project state document: current objective, active tasks, open questions, architecture notes, files of interest | Overwritten at natural breakpoints |
| `decision_journal` | `data/memory/decision_journal.md` | Append-only log of significant decisions with context, options, and reasoning | Appended when making choices |
| `session_log` | `data/memory/session_log.md` | Brief per-session summaries: what happened, what's next | Appended at session wrap-up |

### 2.1 `project_state` — The Living Project Document

This is the single most important state file. The agent maintains it as a living document. Suggested structure:

```markdown
# Project State
Last updated: 2026-03-28T14:30:00Z

## Current Objective
What are we working toward right now?

## Active Tasks
- [ ] Task description (started 2026-03-28)
- [x] Completed task (completed 2026-03-27)

## Open Questions
- Question that needs user input?
- Unresolved technical question?

## Key Decisions
- [2026-03-27] Chose X over Y because... (detail in decision_journal)

## Architecture Notes
Stable reference material the agent needs across sessions.

## Files of Interest
- `path/to/important/file` — why it matters
```

The structure is not enforced programmatically. The agent follows the convention via prompt instructions (§5) and adapts the structure to the project's needs.

### 2.2 `decision_journal` — Decision Log

Append-only. Each entry:

```markdown
## [2026-03-28] Decision: Chose PostgreSQL over SQLite
**Context:** Need to support concurrent writes from multiple agents
**Options considered:** SQLite (simpler), PostgreSQL (concurrent), DuckDB (analytics)
**Decision:** PostgreSQL
**Reasoning:** Concurrent write support is critical for multi-agent delegation
```

### 2.3 `session_log` — Session Summaries

Append-only. Brief entries:

```markdown
## Session 2026-03-28T14:30:00Z
**Goal:** Implement user authentication module
**Outcome:** Completed JWT middleware, started route guards
**Next:** Finish route guards, add refresh token logic
```

## 3. State Bootstrap Module

New file: `src/memory/state-bootstrap.js`

This module reads well-known memory keys at request-build time and returns a formatted string for prompt injection. It is the only new code of significance (~80 lines).

### 3.1 Interface

```js
export class StateBootstrap {
  constructor({ persistentMemory, config, logger }) {
    this.persistentMemory = persistentMemory;
    this.config = config;
    this.logger = logger;
  }

  /**
   * Load well-known state keys and return a prompt-injectable overview.
   * Returns null if disabled or no state exists.
   * Must be fast — reads at most 3 small files, truncates aggressively.
   */
  async scan() { ... }
}
```

### 3.2 `scan()` Logic

1. If `config.workspaceStateEnabled` is `false`, return `null`.
2. Load `project_state` from `PersistentMemory`. If it doesn't exist, return a short bootstrapping hint:
   `"[Workspace state not initialized. When working on a project, use save_memory with key \"project_state\" to track objectives, tasks, and decisions across sessions.]"`
3. Truncate `project_state` to first 2000 characters.
4. Load `session_log`. Extract last section (last `## ` header to end), truncate to 500 chars.
5. Load `decision_journal`. Extract last section, truncate to 500 chars.
6. Assemble formatted output, cap total at `config.workspaceStateMaxChars` (default 3000).

Output format:

```
## Workspace State
[Contents of project_state, truncated to 2000 chars]

### Last Session
[Last entry from session_log, truncated to 500 chars]

### Latest Decision
[Last entry from decision_journal, truncated to 500 chars]
```

### 3.3 Section Extraction

The `_lastSection(content, maxChars)` helper finds the last `## ` heading in the content and returns everything from that heading to the end, truncated to `maxChars`. This enables append-only files (decision_journal, session_log) to show only the most recent entry without loading the full history.

```js
_lastSection(content, maxChars) {
  const sections = content.split(/(?=^## )/m);
  const last = sections[sections.length - 1];
  return last?.substring(0, maxChars) || null;
}
```

### 3.4 Error Handling

All reads are wrapped in try/catch. If any file read fails, that section is silently omitted. If `scan()` itself throws, the caller (`HostDispatcher`) catches it and proceeds without workspace state. State scanning is **never** a blocking concern.

## 4. Integration Points

### 4.1 `src/config.js` — New Configuration

| Variable | Default | Description |
|---|---|---|
| `WORKSPACE_STATE_ENABLED` | `true` | Enable state scanning and prompt injection |
| `WORKSPACE_STATE_MAX_CHARS` | `3000` | Max characters for workspace state in system prompt |

```js
workspaceStateEnabled: process.env.WORKSPACE_STATE_ENABLED !== 'false',
workspaceStateMaxChars: parseInt(process.env.WORKSPACE_STATE_MAX_CHARS || '3000', 10),
```

### 4.2 `src/index.js` — Instantiation (Phase 3, after memory)

```js
// Phase 3: Memory
const conversationMemory = new ConversationMemory(db);
const persistentMemory = new PersistentMemory(config.dataDir, db);
const memorySearch = new MemorySearch(db);

// Phase 3b: State bootstrap
const stateBootstrap = new StateBootstrap({ persistentMemory, config, logger });
```

Pass `stateBootstrap` to `HostDispatcher` constructor (Phase 11).

### 4.3 `src/core/host-dispatcher.js` — Scan at Request Build Time

Accept `stateBootstrap` in constructor. In `buildRequest()`, after the existing `memorySnippets` search:

```js
// Existing: memorySnippets search (line 90-96)
let memorySnippets = [];
try { ... } catch { }

// NEW: workspace state scan
let workspaceState = null;
try {
  if (this.stateBootstrap) {
    workspaceState = await this.stateBootstrap.scan();
  }
} catch { /* non-critical */ }

return createExecutionRequest({
  ...existing fields,
  workspaceState,  // NEW field
});
```

**Note:** `buildRequest()` is currently synchronous. Adding `await` requires making it `async`. This is safe — all callers of `buildRequest()` are already in async contexts (the message pipeline in `index.js`).

### 4.4 `src/core/runner/execution-request.js` — New Field

Add `workspaceState` to the function signature and returned object:

```js
export function createExecutionRequest({
  ...existing params,
  workspaceState = null,   // NEW
}) {
  return {
    ...existing fields,
    workspaceState,        // NEW
  };
}
```

### 4.5 `src/core/runner/local-runner.js` — Pass Through

Add `workspaceState` to `loopParams`:

```js
const loopParams = {
  ...existing fields,
  workspaceState: request.workspaceState,
};
```

### 4.6 `src/core/agent-loop.js` — Accept and Forward

Accept `workspaceState` in `processMessage()` params and pass to `promptBuilder.build()`:

```js
async processMessage({
  ...existing params,
  workspaceState,   // NEW
}) {
  // ...
  const systemPrompt = await this.promptBuilder.build(
    sessionForPrompt,
    toolSchemas,
    skillInstructions,
    memorySnippets,
    workspaceState,  // NEW parameter
  );
}
```

### 4.7 `src/brain/prompt-builder.js` — Render Workspace State

Add `workspaceState` as a fifth parameter to `build()`. Inject it between "Relevant Memories" (section 3) and "Active Skill Instructions" (section 4):

```js
async build(session, availableTools, skillInstructions = null, memorySnippets = null, workspaceState = null) {
  // ... sections 1-3 unchanged ...

  // 3b. Workspace state (if available)
  if (workspaceState) {
    parts.push(`\n${workspaceState}`);
  }

  // 4. Skill instructions (unchanged)
  if (skillInstructions) { ... }

  return parts.join('\n');
}
```

## 5. Prompt Additions (SOUL.md)

The SOUL.md "Memory" section explains both memory mechanisms and when to use each:

```markdown
## Memory

You have two memory mechanisms. Both use `save_memory(key, content)`.

### Workspace State (always visible)

Three reserved keys are **always injected** into your system prompt, every turn:

- **`project_state`** — Living project document: objectives, current tasks, key context. Truncated to **2000 chars** — keep it dense.
- **`decision_journal`** — Append-only. When you make a significant choice, append a dated entry with context and reasoning. Only the **last section** (500 chars) is shown.
- **`session_log`** — Append-only. When a logical chunk of work completes, append a brief summary. Only the **last section** (500 chars) is shown.

Total budget: ~3000 chars. This is your continuity lifeline — it survives context compaction and history clears. Write it for your future self who has lost the conversation.

### General Memory (search-based)

Any other key (e.g., `api_design`, `user_preferences`, `deployment_notes`) is stored permanently but only surfaced when the system's full-text search considers it relevant to the current message. You cannot predict when a general memory will appear — write keys and content to be findable.

**Use workspace state for** things you need every turn: active tasks, project context, recent decisions.
**Use general memory for** reference material you need sometimes: API patterns, user preferences, environment details, how-tos.

### Continuation Protocol

Your system prompt includes workspace state when it exists. Use it to:
1. Understand where you left off
2. Check for open questions or blocked tasks
3. Continue without asking the user to re-explain context

If no workspace state exists yet, create `project_state` during your first substantive interaction.

### When to Update

- After completing a task: update `project_state`, optionally append to `session_log`
- After a significant decision: append to `decision_journal`, update `project_state`
- When the user shares important context: capture in `project_state` or a named general memory
- When you learn reusable reference info (API patterns, env setup, preferences): save as general memory with a descriptive key
- Don't update obsessively — do it at natural breakpoints
```

## 6. Interaction with Existing Systems

### 6.1 Memory Auto-Search (Spec 04)

The existing `memorySearch.search(userMessage, 5)` in `HostDispatcher.buildRequest()` already searches FTS5 across all persistent memories, including workspace state keys. When the user asks about something related to project state, auto-search may surface it in the "Relevant Memories" section.

The state bootstrap provides **guaranteed** injection of the `project_state` key regardless of search relevance. Both mechanisms are complementary:

- **Auto-search**: Surfaces relevant memories (may include state keys) based on the user's current message.
- **State bootstrap**: Always injects project state so the agent has orientation regardless of what the user says.

To avoid redundancy, `project_state` content appearing in both "Workspace State" and "Relevant Memories" is acceptable — the duplication is minor (300-char snippet vs. 2000-char full doc) and the system prompt is already token-budgeted.

### 6.2 Pre-Compaction Memory Flush (Spec 15)

The existing memory flush before compaction prompts the agent to save important facts via `save_memory`. With workspace state conventions in place, the agent will naturally use `project_state` as a target during flush. No changes to the flush mechanism needed.

### 6.3 Agent Profiles & Namespaced Memory (Spec 21)

Agent profiles can have isolated memory namespaces (`PersistentMemory(dataDir, db, namespace)`). Workspace state keys follow the same namespacing — a `code-reviewer` profile would store `code-reviewer:project_state` in `data/memory/code-reviewer/project_state.md`.

The `StateBootstrap` module receives the same `PersistentMemory` instance as the current session, so namespace isolation is automatic.

### 6.4 Conversation Reset (`/new` Command, Spec 15)

The `/new` command clears conversation history but preserves persistent memory. Workspace state keys survive `/new` — this is the intended behavior. After a conversation reset, the agent starts a fresh conversation but retains full project context via the state bootstrap.

## 7. Token Budget

| Component | Max Characters | ~Tokens |
|---|---|---|
| `project_state` content | 2000 | ~500 |
| `session_log` last entry | 500 | ~125 |
| `decision_journal` last entry | 500 | ~125 |
| **Total workspace state** | **3000** | **~750** |

For comparison, the existing memory snippets injection is 5 × 300 = 1500 chars (~375 tokens). The combined system prompt increase is modest (~750 tokens from state + ~375 tokens from memory = ~1125 tokens total contextual injection).

## 8. Files Changed

| File | Change Type | Scope |
|---|---|---|
| `src/memory/state-bootstrap.js` | **NEW** | ~80 lines. Core scan logic. |
| `src/config.js` | Modified | +2 config fields |
| `src/index.js` | Modified | +3 lines: import, instantiate, pass to dispatcher |
| `src/core/host-dispatcher.js` | Modified | +7 lines: store ref, call scan(), pass result. `buildRequest()` becomes async. |
| `src/core/runner/execution-request.js` | Modified | +1 field in signature and return |
| `src/core/runner/local-runner.js` | Modified | +1 line: pass workspaceState in loopParams |
| `src/core/agent-loop.js` | Modified | +2 lines: accept workspaceState, pass to promptBuilder |
| `src/brain/prompt-builder.js` | Modified | +4 lines: accept param, inject section |
| `SOUL.md` | Modified | +~30 lines: workspace state management instructions |

Total: ~80 lines new code + ~20 lines of modifications across 7 existing files.

## 9. Design Decisions

| Decision | Rationale |
|---|---|
| Store state in PersistentMemory, not workspace files | Reuses existing storage (markdown + FTS5). State is searchable alongside other memories. No parallel storage path. |
| Well-known keys, not a new table | Keeps the system simple. Memory keys are just strings; no schema migration needed. |
| Guaranteed injection via bootstrap + relevance via auto-search | Bootstrap ensures orientation context is always present. Auto-search surfaces state when contextually relevant. Complementary, not redundant. |
| No new tools | `save_memory` already does everything needed. Adding `update_project_state` would increase API surface without adding capability. |
| Convention via prompt, not schema enforcement | LLMs work best with flexible structure. Rigid schemas would fight the model's natural language abilities. |
| `buildRequest()` becomes async | Required for `persistentMemory.load()` (which is `async`). All callers already handle async. Minimal disruption. |
| Bootstrapping hint when no state exists | Gentle nudge for the agent to start tracking state, without forcing it on trivial interactions. |
| State cap at 3000 chars | Balances rich context (~750 tokens) with system prompt budget. Configurable via env var. |

## 10. Deliberate Omissions

| Omission | Rationale |
|---|---|
| No automatic session-end detection | Agent is prompted to log sessions, not hooked. The `/new` memory flush (Spec 15) already handles pre-clear saving. |
| No state file versioning | Markdown files in `data/memory/` can be git-tracked manually. Automatic versioning adds complexity without clear value today. |
| No schema enforcement | Free-form markdown. Convention via prompt. See design decisions. |
| No automatic artifact management | Reusable artifact lifecycle (templates, generated code, vector indexes) is a separate concern. The state conventions provide a foundation but this spec does not define artifact lifecycle rules. |
| No deduplication between state and memory snippets | Minor redundancy (300-char snippet vs. 2000-char full doc) is acceptable. Active deduplication adds complexity for marginal token savings. |

Multi-project support has been added in Spec 31.

## 11. Extension Points

- **State categories:** Add more well-known keys (e.g., `error_log`, `user_preferences`, `codebase_map`) as patterns emerge.
- **State hooks:** Run state update automatically before `/new` or on idle timeout (extension of Spec 15 memory flush).
- **State versioning:** Use `decision_journal` pattern (append-only with timestamps) for all state keys, or integrate with workspace git.
- **State-aware compaction:** Include workspace state in compaction summaries to improve rolling compression quality.
- **State dashboard:** Surface workspace state in the health endpoint (Spec 20) for visibility.
- **Multi-project support:** Multiple named projects with switching. See Spec 31.

## 12. Implementation Plan

### Phase 1: StateBootstrap Module
1. Create `src/memory/state-bootstrap.js` with `scan()` and `_lastSection()`.
2. Tests: scan with no state, scan with project_state only, scan with all three keys, truncation, disabled config.

### Phase 2: Pipeline Integration
1. Add config fields to `src/config.js`.
2. Make `HostDispatcher.buildRequest()` async; add state scan.
3. Thread `workspaceState` through `execution-request.js` → `local-runner.js` → `agent-loop.js` → `prompt-builder.js`.
4. Instantiate `StateBootstrap` in `src/index.js`.
5. Tests: verify state appears in system prompt, verify disabled config skips injection.

### Phase 3: Prompt Engineering
1. Add workspace state management section to `SOUL.md`.
2. Test with conversation reset workflow: start a project, save state, `/new`, verify agent picks up context.
