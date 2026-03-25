# Spec 19 — Approval Workflow

> Status: **Implemented** | Owner: — | Last updated: 2026-03-25

## 1. Purpose

Provide interactive, per-tool approval prompts so that dangerous operations (shell execution, file writes, destructive actions) can be gated behind explicit user consent. This is the critical security mechanism that enables non-admin users to access powerful tools safely.

## 2. Design Overview

When a tool requiring approval is invoked, the agent pauses, asks the user for permission via their chat channel, and resumes or aborts based on the response. The approval mechanism is transparent to the LLM — it sees either the tool result (if approved) or the approval prompt (if pending).

```
AgentLoop calls tool → ToolExecutor checks approval
  → If admin: proceed (bypass)
  → If cached: proceed
  → If needed: return [APPROVAL_REQUIRED] message to LLM
     → LLM relays to user
     → User responds /approve or /reject
     → Next agent iteration: tool now cached, executes normally
```

## 3. Components

### 3.1 Approval Manager

**File:** `src/security/approval-manager.js`
**Class:** `ApprovalManager`

**Interface:**

```js
constructor({ db, eventBus, auditLogger, logger })

needsApproval(toolName, userId, sessionId): boolean
grantSession(toolName, sessionId): void
revokeSession(toolName, sessionId): void
getPending(sessionId): PendingApproval | null
setPending(sessionId, { toolName, input, userId }): void
resolve(sessionId, approved, reason?): void
clearSession(sessionId): void
```

### 3.2 Approval Defaults

Approval mode per tool is defined in `TOOL_APPROVAL_DEFAULTS` (hardcoded in `approval-manager.js`):

| Tool | Default approval for non-admin |
|------|-------------------------------|
| `run_command` | `always` |
| `run_command_background` | `always` |
| `kill_process` | `once-per-session` |
| `write_file` | `once-per-session` |
| `edit_file` | `once-per-session` |
| All other tools | no approval needed |

Admin users (`role: 'admin'`) bypass approval entirely (checked via DB query in `_getUserRole()`).

### 3.3 Approval Flow in Detail

**Step 1: Tool invocation**

`ToolExecutor.execute()` checks `approvalManager.needsApproval(toolName, userId, sessionId)` (step 2.5, between permission check and input validation).

If approval is needed and not cached, returns:

```js
{
  success: true,
  result: `[APPROVAL_REQUIRED] The tool "${toolName}" requires your approval...\n\nReply /approve to allow or /reject to deny.`,
  awaitingApproval: true,
  durationMs: 0,
}
```

**Step 2: User response**

`CommandRouter` intercepts `/approve`, `/yes`, `/reject`, `/no`:
- `/approve` or `/yes` → `approvalManager.resolve(sessionId, true)` → grants session cache → responds "Approved. Continuing..."
- `/reject` or `/no` → `approvalManager.resolve(sessionId, false, 'User rejected')` → responds "Rejected. Operation cancelled."

**Step 3: Agent resumes**

On next message, the agent re-attempts the tool. `needsApproval()` returns false (session-cached), and the tool executes normally.

### 3.4 Session Approval Cache

**Storage:** In-memory `Map<sessionId, Set<toolName>>`.

- `grantSession()` adds to cache.
- On `/new` command, `CommandRouter` calls `approvalManager.clearSession(sessionId)`.
- Cache is not persisted across agent restarts (conservative).

## 4. Integration

### 4.1 ToolExecutor

`ToolExecutor` constructor accepts `{ auditLogger, approvalManager }` as an options object:

```js
const toolExecutor = new ToolExecutor(toolRegistry, toolPolicy, logger, {
  auditLogger,
  approvalManager,
});
```

### 4.2 CommandRouter

`CommandRouter` constructor accepts `approvalManager` and handles `/approve`, `/reject`, `/yes`, `/no` commands.

## 5. Design Decisions

| Decision | Rationale |
|----------|-----------|
| Approval as tool result (not event/interrupt) | Works within existing ReAct loop without new control flow. The LLM naturally communicates the pending approval to the user. |
| `success: true` with `awaitingApproval` flag | The LLM sees the approval message as a tool result, not an error. This ensures it communicates the prompt to the user. |
| Session-scoped cache (not persistent) | Conservative default. Users must re-approve after restart. |
| `/approve` and `/reject` commands | Simple, discoverable. Works across all adapters. Also accepts `/yes` and `/no`. |
| Admin bypasses approval | Admin role already implies full trust. |
| Approval info logged to audit | Creates accountability trail for who approved what and when. |

## 6. Extension Points

- **Persistent approval rules:** Per-user persistent allow/deny per tool (a `tool_approvals` table).
- **Command pattern approval:** Approve patterns like `npm *` or `git status` instead of blanket tool approval.
- **Multi-user approval:** In group chats, require approval from a designated approver.
- **Telegram inline buttons:** Use Telegram's inline keyboard for approve/reject buttons.
- **Approval timeout:** Auto-reject if no response within N minutes.
