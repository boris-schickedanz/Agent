# Spec 31 — Multi-Project Support

> Status: **In Progress** | Owner: — | Last updated: 2026-03-28

## 1. Purpose

The agent is a single-user, single continuous session system. Spec 29 introduced workspace state — a living `project_state` document injected into every system prompt for continuity. But there's only one `project_state` at a time. When the user naturally switches between topics (e.g., from a cooking project to travel planning), the old project state stays injected and contaminates the agent's responses.

This spec adds **multi-project support**: multiple named projects can exist, each with its own workspace state keys. Only the active project's state is injected. The user or agent can switch between projects explicitly or implicitly.

### 1.1 Motivation

Real usage shows the user works on multiple unrelated things over time. Without project isolation:

- Old `project_state` content pollutes unrelated conversations (e.g., "Pasta-Kochen" appearing during Panama travel planning).
- The agent confuses contexts because workspace state from one topic is always present.
- The user must manually clear and recreate `project_state` each time they switch topics.

### 1.2 Design Principles

| Principle | Application |
|-----------|-------------|
| Reuse existing infrastructure | Projects use `PersistentMemory` with namespaces (Spec 04). No new storage layer. |
| Minimal new code | One new class (`ProjectManager`, ~60 lines), one new tool, one new command. |
| Convention over infrastructure | Project structure follows Spec 29 conventions. No rigid schema. |
| Explicit and implicit switching | User can switch via `/project` command; agent can switch via `switch_project` tool when it detects a topic change. |
| Non-breaking | Global (non-project) memories remain unchanged. Existing `save_memory` behavior is preserved for non-workspace-state keys. |

## 2. Data Model

### 2.1 Project Storage

Each project is a namespaced subdirectory under `data/memory/projects/`:

```
data/memory/projects/{slug}/project_state.md
data/memory/projects/{slug}/decision_journal.md
data/memory/projects/{slug}/session_log.md
```

The slug is a URL-safe, lowercase identifier derived from the project name (e.g., "Panama Trip" → `panama-trip`).

### 2.2 Active Project Tracking

The currently active project is stored in a special file:

```
data/memory/_active_project.md
```

Contents: just the project slug (e.g., `panama-trip`). When no project is active, this file does not exist.

### 2.3 Global Memory

Non-workspace-state keys (e.g., `user_preferences`, `api_design`) remain in the global `data/memory/` directory, unaffected by project switching. These are shared across all projects.

## 3. ProjectManager Module

New file: `src/memory/project-manager.js` (~60 lines)

```js
export class ProjectManager {
  constructor(dataDir, db) { ... }

  /** Returns the active project slug, or null if none. */
  getActive() { ... }

  /** Sets the active project. Creates the project directory if needed. */
  setActive(slug) { ... }

  /** Deactivates the current project (deletes _active_project.md). */
  deactivate() { ... }

  /** Lists all project slugs (subdirectories of data/memory/projects/). */
  list() { ... }

  /** Returns a PersistentMemory instance scoped to a project. */
  getMemory(slug) { ... }

  /** Returns PersistentMemory for the active project, or null. */
  getActiveMemory() { ... }
}
```

Implementation notes:
- `getActive()` reads `_active_project.md` from the global memory directory. Returns null if file doesn't exist.
- `setActive(slug)` writes the slug to `_active_project.md` and ensures `data/memory/projects/{slug}/` exists.
- `getMemory(slug)` returns `new PersistentMemory(dataDir, db, 'projects/' + slug)`.
- `list()` reads subdirectories of `data/memory/projects/`.

### 3.1 Slugification

Project names are converted to slugs: lowercase, spaces/special chars replaced with hyphens, consecutive hyphens collapsed, leading/trailing hyphens stripped. Max length: 50 characters.

```
"Panama Trip"     → "panama-trip"
"Coding: AgentCore" → "coding-agentcore"
"  My Project  "  → "my-project"
```

## 4. Integration Points

### 4.1 StateBootstrap Changes (`src/memory/state-bootstrap.js`)

The `StateBootstrap` constructor accepts an additional `projectManager` parameter.

`scan()` behavior changes:
1. Check `projectManager.getActive()` for the active project slug.
2. If a project is active → load workspace state from `projectManager.getActiveMemory()` instead of the global `persistentMemory`.
3. If no project is active → return a hint: `"[No active project. Use /project <name> to activate one, or tell me what you're working on and I'll set one up.]"`
4. Include the project name in the output header: `## Workspace State (Project: panama-trip)`.

The cache changes from a single value to a `Map` keyed by project slug, with simple eviction (drop oldest when size > 50).

### 4.2 Memory Tools Changes (`src/tools/built-in/memory-tools.js`)

`registerMemoryTools` accepts an additional `projectManager` parameter.

**`save_memory` routing:** For the three reserved workspace state keys (`project_state`, `decision_journal`, `session_log`):
- If a project is active → save to `projectManager.getActiveMemory()`
- If no project is active → save to global `persistentMemory` (backward-compatible fallback)

For all other keys → save to global `persistentMemory` (unchanged).

**New tool: `switch_project`:**

```js
{
  name: 'switch_project',
  class: 'brokered',
  description: 'Switch the active project context. Creates the project if it does not exist yet. Use this when the user starts working on a different topic or project.',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Project name (will be slugified for storage)',
      },
    },
    required: ['name'],
  },
  handler: async (input) => {
    const slug = slugify(input.name);
    projectManager.setActive(slug);
    const existing = projectManager.getActiveMemory();
    const state = await existing.load('project_state');
    if (state) {
      return `Switched to project: ${slug} (existing project with state)`;
    }
    return `Switched to project: ${slug} (new project — initialize project_state when ready)`;
  },
  permissions: ['memory:write'],
}
```

### 4.3 Command Router Changes (`src/core/command-router.js`)

New `/project` command (following `/agent` and `/model` patterns):

| Command | Behavior |
|---------|----------|
| `/project` | Show active project name (or "No active project") |
| `/project list` | List all projects |
| `/project <name>` | Activate project (create if needed), persist to history |
| `/project none` | Deactivate current project |

### 4.4 Wiring (`src/index.js`)

```js
// Phase 3: Memory
const projectManager = new ProjectManager(config.dataDir, db);

// Phase 3b: State bootstrap — now project-aware
const stateBootstrap = new StateBootstrap({ persistentMemory, config, logger, projectManager });

// Phase 4: Tools — pass projectManager
registerMemoryTools(toolRegistry, persistentMemory, memorySearch, projectManager);

// Phase 11: Command router — pass projectManager
const commandRouter = new CommandRouter({ ..., projectManager });
```

## 5. Prompt Additions (SOUL.md)

Add a "Projects" subsection to the Memory section:

```markdown
### Projects

Multiple projects can exist. Only one is active at a time — its workspace state is injected into your system prompt.

- When you detect the user has switched to a different topic or project, use the `switch_project` tool to activate the right project. If the project doesn't exist yet, the tool creates it.
- When starting a genuinely new project, switch to it and initialize its `project_state`.
- Don't switch projects for casual conversation or quick questions unrelated to any project.
```

Additionally:
- Add factual error correction instruction to Personality section.
- Add explicit no-emoji instruction to Response Style section.

## 6. Interaction with Existing Systems

### 6.1 Context Compaction (Spec 15)

Pre-compaction memory flush continues to work — it calls `save_memory`, which now routes workspace state keys to the active project. No changes needed to the flush mechanism.

### 6.2 Conversation Reset (`/new`)

`/new` clears conversation history but preserves all persistent memory, including project state. After `/new`, the agent starts fresh but the active project's state is still injected via `StateBootstrap`.

### 6.3 Memory Auto-Search (Spec 04)

Global memories remain searchable across all projects. Project-scoped memories (workspace state keys) are stored with namespace prefixes in FTS5 (e.g., `projects/panama-trip:project_state`), so they're findable via `search_memory` but won't randomly surface for unrelated queries.

### 6.4 Agent Profiles (Spec 21)

Agent profiles with memory namespaces are orthogonal to projects. If an agent profile has a namespace, its memories are separate from both global and project memories.

## 7. Files Changed

| File | Change Type | Scope |
|------|-------------|-------|
| `src/memory/project-manager.js` | **NEW** | ~60 lines. Project lifecycle management. |
| `src/memory/state-bootstrap.js` | Modified | Accept `projectManager`, load from active project, per-project cache. |
| `src/tools/built-in/memory-tools.js` | Modified | Route workspace state saves, add `switch_project` tool. |
| `src/core/command-router.js` | Modified | Add `/project` command handling. |
| `src/index.js` | Modified | Instantiate `ProjectManager`, wire to components. |
| `SOUL.md` | Modified | Projects section, factual error correction, no-emoji instruction. |
| `src/brain/context-compactor.js` | Modified | Add logger, sentinel message on failure. |

## 8. Design Decisions

| Decision | Rationale |
|----------|-----------|
| Projects stored as PersistentMemory namespaces | Reuses existing infrastructure. Each project is just a subdirectory with its own markdown files. |
| Active project tracked via file, not DB | Simple, inspectable, consistent with the file-based memory model. |
| Agent can auto-switch via tool | The agent should detect topic changes and switch proactively, not just wait for `/project` commands. |
| Global memories not scoped to projects | User preferences, API patterns, etc. are cross-project knowledge. Only workspace state is project-scoped. |
| No migration needed | Existing global `project_state` continues to work if no project is activated. |

## 9. Deliberate Omissions

| Omission | Rationale |
|----------|-----------|
| No project deletion command | Projects are just directories. Manual deletion is fine for now. |
| No project rename | Rename by creating new + deactivating old. Avoids complexity. |
| No project-scoped general memories | General memories are intentionally global. Project-specific notes go in `project_state`. |
| No automatic project detection from message content | Agent uses `switch_project` tool with LLM reasoning. No keyword-matching heuristics. |

## 10. Implementation Plan

### Phase 1: Tests (TDD)
1. `test/project-manager.test.js` — CRUD, slugification, memory isolation.
2. Update `test/state-bootstrap.test.js` — project-aware scan, cache per project.
3. Update `test/context-management.test.js` — compactor sentinel message.

### Phase 2: Core Implementation
1. `src/memory/project-manager.js` — ProjectManager class.
2. Update `src/memory/state-bootstrap.js` — project-aware scan and caching.
3. Update `src/tools/built-in/memory-tools.js` — save routing + `switch_project` tool.
4. Update `src/core/command-router.js` — `/project` command.
5. Wire in `src/index.js`.

### Phase 3: Prompt & Docs
1. Update `SOUL.md`.
2. Update `src/brain/context-compactor.js`.
3. Update existing specs to reflect single-user, single-session, no-group-chat model.
