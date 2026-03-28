# Spec 23 — Read/Write Tool Policy

> Status: **Implemented** | Owner: — | Last updated: 2026-03-27

## 1. Purpose

This spec established the read/write tool classification and made the approval workflow ([Spec 19](19-approval-workflow.md)) the primary security gate for write operations.

> **Note:** As of [Spec 32](32-single-user-migration.md), `ToolPolicy` always returns all tools (single-user model). The read/write classification below remains relevant for the **approval workflow** — it determines which tools require interactive approval before execution.

- **Read tools** are allowed without approval.
- **Write tools** require approval via the approval workflow (user must approve before execution).

## 2. Design

### 2.1 Tool Classification: Read vs Write

Every tool is classified as **read** or **write** based on whether it mutates state:

| Category | Definition | Examples |
|----------|-----------|----------|
| **Read** | Observes state without side effects. Safe to run without confirmation. | `read_file`, `list_directory`, `grep_search`, `list_processes`, `check_process`, `http_get`, `search_memory`, `list_memories`, `check_delegation` |
| **Write** | Mutates state (files, processes, network, memory). Requires approval via the approval workflow. | `write_file`, `edit_file`, `run_command`, `run_command_background`, `kill_process`, `http_post`, `save_memory`, `delegate_task`, `cancel_delegation` |

### 2.2 Updated Standard Profile

The `standard` profile in `tool-policy.js` changes from a restrictive allow-list to an open allow with explicit deny only for truly unsafe operations:

**Before:**

```js
standard: {
  allow: [
    'get_current_time', 'search_memory', 'list_memories',
    'http_get', 'save_memory', 'wait',
    'read_file', 'list_directory', 'file_search', 'grep_search',
  ],
  deny: [
    'http_post',
    'write_file', 'edit_file',
    'run_command', 'run_command_background', 'kill_process',
    'delegate_task', 'check_delegation', 'cancel_delegation',
  ],
}
```

**After:**

```js
standard: {
  allow: [
    // read
    'get_current_time', 'wait', 'search_memory', 'list_memories',
    'http_get', 'read_file', 'list_directory', 'file_search', 'grep_search',
    'list_processes', 'check_process', 'check_delegation',
    // write (gated by approval workflow)
    'save_memory', 'http_post', 'write_file', 'edit_file',
    'run_command', 'run_command_background', 'kill_process',
    'delegate_task', 'cancel_delegation',
  ],
  deny: [],
}
```

All tools are now allowed at the policy level. The approval workflow (Spec 19) becomes the gate for write operations. `save_memory` requires no approval.

### 2.3 Updated Approval Defaults

The exported `TOOLS_REQUIRING_APPROVAL` set in `approval-manager.js` lists all write tools:

| Tool | Rationale |
|------|-----------|
| `run_command` | Arbitrary shell execution |
| `run_command_background` | Long-running processes |
| `kill_process` | Destructive — terminates a process |
| `write_file` | File mutation |
| `edit_file` | File mutation |
| `http_post` | Outbound state mutation |
| `delegate_task` | Spawns sub-agent |
| `cancel_delegation` | Terminates sub-agent |

Every write tool requires approval for each individual execution. There is no session-scoped caching — the user must explicitly approve every invocation. Read tools need no approval.

### 2.4 Minimal and Full Profiles — No Change

- **`minimal`** (legacy — no longer active): Was restricted to `get_current_time` only.
- **`full`** (current — single-user model): Allow `*`, deny nothing. All tools available; write tools gated by approval workflow.

## 3. Affected Components

| File | Change |
|------|--------|
| `src/security/tool-policy.js` | Update `standard` profile allow list; change `getEffectiveToolNames` to return `{ name, approval }[]`; accept `ApprovalManager` reference |
| `src/security/approval-manager.js` | Replace `TOOL_APPROVAL_DEFAULTS` map with exported `TOOLS_REQUIRING_APPROVAL` set; remove session cache; expose `requiresApproval(toolName): boolean` method |
| `src/core/host-dispatcher.js` | Update `buildRequest` to handle new `{ name, approval }[]` shape from `getEffectiveToolNames` |
| `src/index.js` | Pass `ApprovalManager` to `ToolPolicy` constructor |
| Spec 07 (Security) | Update §3.2 standard profile table |
| Spec 19 (Approval Workflow) | Update §3.2 approval defaults table |

### 2.5 `getEffectiveToolNames` Behavior

`getEffectiveToolNames` returns `null` in the single-user model (all tools available). The annotated return type below is retained for reference but is not active.

The method signature changes to return approval metadata alongside each tool name, so callers (and ultimately users) can see which tools are freely available and which require approval:

**New return type:**

```js
getEffectiveToolNames(userId, session): EffectiveToolList | null

// where:
EffectiveToolList = Array<{
  name: string,
  requiresApproval: boolean
}>
```

- Returns `null` for `full` profile (admin) — all tools, no approval.
- Returns the annotated list for `standard` and `minimal` profiles.

**Implementation:** `getEffectiveToolNames` cross-references the allow list with `ApprovalManager.requiresApproval(toolName)` to populate the flag.

This requires `ToolPolicy` to receive a reference to `ApprovalManager` (or its defaults map) at construction time.

**Example return value for a `standard` user:**

```js
[
  { name: 'read_file',              requiresApproval: false },
  { name: 'list_directory',         requiresApproval: false },
  { name: 'grep_search',            requiresApproval: false },
  { name: 'list_processes',         requiresApproval: false },
  { name: 'check_process',          requiresApproval: false },
  { name: 'search_memory',          requiresApproval: false },
  // ...
  { name: 'run_command',            requiresApproval: true },
  { name: 'run_command_background', requiresApproval: true },
  { name: 'write_file',             requiresApproval: true },
  { name: 'edit_file',              requiresApproval: true },
  { name: 'kill_process',           requiresApproval: true },
  { name: 'http_post',              requiresApproval: true },
  { name: 'delegate_task',          requiresApproval: true },
  { name: 'cancel_delegation',      requiresApproval: true },
]
```

### 2.6 Callers of `getEffectiveToolNames`

`HostDispatcher.buildRequest()` uses this method to filter tool schemas. It must be updated to handle the new shape — extract `.name` for filtering, and optionally pass the full list downstream so adapters can display approval status to the user (e.g. a `/tools` command).

## 4. Design Decisions

| Decision | Rationale |
|----------|-----------|
| `save_memory` requires no approval | Low-risk, essential for agent autonomy. Already allowed in the current standard profile. |
| Explicit allow list (not `'*'`) for standard | `getEffectiveToolNames` must return a concrete list so `HostDispatcher` filters schemas correctly. `'*'` is reserved for admin/full profile. |
| Approval manager is the write gate | Separates "can the user see/use this tool" (policy) from "does this specific invocation need consent" (approval). Cleaner than blocking tools entirely. |
| Every write invocation requires approval | No session caching. Each execution is independently approved. Simpler model, stronger safety. |

## Implementation Plan

### Prerequisites

None. All affected files already exist. No migrations needed (no schema changes).

### Step 1 — Simplify ApprovalManager: remove session cache, add `requiresApproval()`

- **Files:** `src/security/approval-manager.js`
- **What:**
  1. Update `TOOL_APPROVAL_DEFAULTS` — change all modes to `always`, add `http_post`, `delegate_task`, `cancel_delegation`:
     ```js
     const TOOL_APPROVAL_DEFAULTS = {
       run_command: 'always',
       run_command_background: 'always',
       kill_process: 'always',
       write_file: 'always',
       edit_file: 'always',
       http_post: 'always',
       delegate_task: 'always',
       cancel_delegation: 'always',
     };
     ```
  2. Remove `this._sessionCache` (the `Map<sessionId, Set<toolName>>`).
  3. Simplify `needsApproval()` — remove all session-cache checks. Just: admin → false, in defaults → true, else → false.
  4. Remove `grantSession()` and `revokeSession()` methods.
  5. Simplify `resolve()` — remove the `grantSession` call. Keep audit logging and pending cleanup.
  6. Simplify `clearSession()` — only clear `_pending` (no session cache to clear).
  7. Add `requiresApproval(toolName)` — a static-like check that returns `true` if the tool is in `TOOL_APPROVAL_DEFAULTS`, `false` otherwise. Does NOT check user role (that's the caller's concern).
- **Tests:** Existing `test/approval.test.js` must be updated:
  - Remove: "once-per-session tools are cached after grant", "resolve grants session approval", "clearSession resets cache", "different sessions have independent caches"
  - Add: tests for new tools (`http_post`, `delegate_task`, `cancel_delegation`)
  - Add: test for `requiresApproval()` method
  - Keep: "admin bypasses approval", "non-admin requires approval for run_command", "non-admin does not require approval for safe tools", "resolve with rejection does not grant", "getPending returns pending approval"

### Step 2 — Update ToolPolicy: expanded standard profile, annotated return type

- **Files:** `src/security/tool-policy.js`
- **What:**
  1. Constructor accepts optional `approvalManager` parameter: `constructor(db, config, approvalManager = null)`.
  2. Update `standard` profile — replace current allow/deny with:
     ```js
     standard: {
       allow: [
         'get_current_time', 'wait', 'search_memory', 'list_memories',
         'http_get', 'read_file', 'list_directory', 'file_search', 'grep_search',
         'list_processes', 'check_process', 'check_delegation',
         'save_memory', 'http_post', 'write_file', 'edit_file',
         'run_command', 'run_command_background', 'kill_process',
         'delegate_task', 'cancel_delegation',
       ],
       deny: [],
     }
     ```
  3. Change `getEffectiveToolNames()` return type. Currently returns `string[] | null`. New return: `Array<{ name, requiresApproval }> | null`.
     - If profile has `'*'` in allow → return `null` (unchanged, for admin).
     - Otherwise → map the allow list to `{ name, requiresApproval: this.approvalManager?.requiresApproval(name) ?? false }`.
  4. `isAllowed()` — no signature change needed. The expanded allow list and empty deny means it will now return `true` for all listed tools.
- **Tests:** Add/update tests for:
  - `standard` user can access `list_processes`, `check_process`, `run_command` (all now allowed at policy level)
  - `getEffectiveToolNames` returns annotated objects with `requiresApproval` flag
  - `minimal` and `full` profiles unchanged
  - `isAllowed` returns `true` for write tools on `standard` user

### Step 3 — Update HostDispatcher to handle annotated tool list

- **Files:** `src/core/host-dispatcher.js`
- **What:**
  1. In `buildRequest()`, lines 56-58: `getEffectiveToolNames` now returns `{ name, requiresApproval }[]` or `null`. Extract names for the `Set`:
     ```js
     const effectiveTools = this.toolPolicy
       ? this.toolPolicy.getEffectiveToolNames(sanitizedMessage.userId, session)
       : null;
     const allowedToolNames = effectiveTools
       ? new Set(effectiveTools.map(t => t.name))
       : null;
     ```
  2. Agent profile intersection logic (lines 60-67) works on `allowedToolNames` (a `Set<string>`) — no change needed there.
  3. Optionally store the full `effectiveTools` list in `sessionMetadata` so adapters/commands can display it to the user later (e.g., a `/tools` command).
- **Tests:** Verify `buildRequest` works with the new shape (integration-level, covered by existing pipeline tests).

### Step 4 — Wire ApprovalManager into ToolPolicy in index.js

- **Files:** `src/index.js`
- **What:**
  1. Line 112: `ToolPolicy` is currently constructed before `ApprovalManager` (line 114). Reorder so `ApprovalManager` is created first, then passed to `ToolPolicy`:
     ```js
     // Phase 5: Security
     const inputSanitizer = new InputSanitizer();
     const rateLimiter = new RateLimiter(db, config);
     const approvalManager = new ApprovalManager({ db, eventBus, auditLogger, logger });
     const toolPolicy = new ToolPolicy(db, config, approvalManager);
     const permissionManager = new PermissionManager(db, toolPolicy, config);
     ```
  2. Remove the separate `approvalManager` declaration from line 114 (it's now above `toolPolicy`).
- **Tests:** No new tests needed — existing integration tests cover wiring.

### Step 5 — Update existing tests

- **Files:** `test/approval.test.js`
- **What:** Apply the test changes described in Step 1. Run `npm test` to verify everything passes.

### Step 6 — Update specs

- **Files:** `spec/07-security.md`, `spec/19-approval-workflow.md`
- **What:**
  1. Spec 07 §3.2: Update the standard profile table to show the full allow list with empty deny. Add note about approval workflow as the gate for write tools.
  2. Spec 19 §3.2: Update `TOOL_APPROVAL_DEFAULTS` table — all modes are `always`, add `http_post`, `delegate_task`, `cancel_delegation`. Remove references to `once-per-session` and session caching (§3.4).

### Integration & Verification

1. `npm test` — all existing + new tests pass.
2. Manual test: start agent as a `user` role → verify `list_processes` works without approval → verify `run_command` prompts for approval → verify `/approve` lets it execute → verify next `run_command` prompts again (no caching).
3. Manual test: start as `admin` → verify all tools work without approval (unchanged).
4. Manual test: start as `pending` → verify only `get_current_time` works (unchanged).

### Risks

- **ToolExecutor stores pending approval but no longer grants session cache.** After `/approve`, `resolve()` clears the pending entry but doesn't cache. On the next agent iteration the tool re-executes via `needsApproval()` → false path no longer exists without cache. **Mitigation:** The `resolve()` flow works differently — after approval, `CommandRouter` triggers a re-send of the message. The `ToolExecutor` needs a way to know this specific invocation was just approved. Current code at `approval-manager.js:80-85` calls `grantSession` after resolve. Without the cache, the re-attempt would prompt again. **Solution:** Keep a single-use approval token: `resolve(approved=true)` sets a one-shot flag `_lastApproved.set(sessionId, toolName)`. `needsApproval()` checks and consumes this flag. This replaces the session cache with a single-use pass.
- **Spec 19's `CommandRouter` calls `clearSession` on `/new`.** With no session cache, this simplifies to just clearing `_pending`. Low risk.
