# Spec 19 — Approval Workflow

> Status: **Draft** | Owner: — | Last updated: 2026-03-25

## 1. Purpose

Provide interactive, per-tool approval prompts so that dangerous operations (shell execution, file writes, destructive actions) can be gated behind explicit user consent. This is the critical security mechanism that enables non-admin users to access powerful tools safely.

## 2. Design Overview

When a tool marked as requiring approval is invoked, the agent pauses, asks the user for permission via their chat channel, and resumes or aborts based on the response. The approval mechanism is transparent to the LLM — it sees either the tool result (if approved) or a denial message (if rejected).

```
AgentLoop calls tool → ToolExecutor checks approval
  → If cached: proceed
  → If needed: return "Awaiting approval" to LLM
     → User receives approval prompt via adapter
     → User responds yes/no
     → Next agent iteration picks up the decision
```

## 3. Components

### 3.1 Approval Manager

**File:** `src/security/approval-manager.js`
**Class:** `ApprovalManager`

**Interface:**

```js
constructor({ db, eventBus, auditLogger, logger })

needsApproval(toolName, userId, sessionId): boolean
requestApproval(toolName, input, userId, sessionId): Promise<ApprovalResult>
grantSession(toolName, sessionId): void     // Pre-approve for rest of session
revokeSession(toolName, sessionId): void
getPending(sessionId): PendingApproval | null
resolve(sessionId, approved, reason?): void
```

**ApprovalResult:**

```js
{
  approved: boolean,
  cached: boolean,        // true if from session cache
  reason: string | null,  // user's reason if denied
}
```

### 3.2 Approval Configuration

Each tool definition gains an optional `approval` field:

```js
{
  name: 'run_command',
  approval: 'always',     // 'always' | 'once-per-session' | 'never' | undefined
  // ... rest of tool definition
}
```

| Mode | Behavior |
|------|----------|
| `'always'` | Every invocation requires approval (unless pre-approved via command) |
| `'once-per-session'` | First invocation in a session requires approval; subsequent calls to the same tool are auto-approved |
| `'never'` | No approval needed (default for safe tools) |
| `undefined` | Inherits from role-based default (admin → never, user → tool-specific) |

**Per-tool defaults:**

| Tool | Default approval for non-admin |
|------|-------------------------------|
| `run_command` | `always` |
| `run_command_background` | `always` |
| `kill_process` | `once-per-session` |
| `write_file` | `once-per-session` |
| `edit_file` | `once-per-session` |
| All other tools | `never` |

Admin users (`role: 'admin'`) bypass approval entirely.

### 3.3 Approval Flow in Detail

**Step 1: Tool invocation**

`ToolExecutor.execute()` checks `approvalManager.needsApproval(toolName, userId, sessionId)`.

If approval is needed and not cached:

**Step 2: Emit approval request**

The tool executor returns a special result:

```js
{
  success: false,
  error: null,
  result: `[APPROVAL_REQUIRED] The tool "${toolName}" requires your approval to proceed.\n\nCommand: ${summarizeInput(input)}\n\nReply /approve to allow or /reject to deny.`,
  awaitingApproval: true,
}
```

The agent loop treats this as a tool result and returns it to the LLM. The LLM sees the approval message and should relay it to the user.

**Step 3: User response**

The `CommandRouter` intercepts `/approve` and `/reject` messages:

```js
// In CommandRouter.handle()
if (content === '/approve' || content === '/yes') {
  approvalManager.resolve(sessionId, true);
  return { handled: true, reply: 'Approved. Continuing...' };
}
if (content === '/reject' || content === '/no') {
  approvalManager.resolve(sessionId, false, 'User rejected');
  return { handled: true, reply: 'Rejected. Operation cancelled.' };
}
```

**Step 4: Agent resumes**

On the next user message (the approval response is treated as a new turn), the agent re-attempts the tool call. If approved, `needsApproval()` returns false (cached), and the tool executes normally.

### 3.4 Session Approval Cache

**Storage:** In-memory `Map<sessionId, Set<toolName>>` for session-scoped approvals.

- `grantSession(toolName, sessionId)` adds to cache.
- Cache is cleared when session is reset (`/new` command).
- Cache is not persisted across agent restarts (conservative — require re-approval).

### 3.5 Persistent Approval Rules (Future)

A `tool_approvals` table for persistent per-user rules:

```sql
CREATE TABLE tool_approvals (
  user_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  mode TEXT NOT NULL,           -- 'always_allow' | 'always_deny' | 'session'
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, tool_name)
);
```

Not in initial implementation — session cache is sufficient.

## 4. Integration

### 4.1 ToolExecutor Changes

Add approval check between permission check (step 2) and input validation (step 3) in `ToolExecutor.execute()`:

```js
// Existing step 2: permission check
const allowed = this.toolPolicy.isAllowed(toolName, session.userId, session);
if (!allowed) return { success: false, error: 'Permission denied' };

// NEW step 2.5: approval check
if (this.approvalManager) {
  const needs = this.approvalManager.needsApproval(toolName, session.userId, session.sessionId);
  if (needs) {
    this.auditLogger?.logApproval({ toolName, input: toolInput, userId: session.userId, sessionId: session.sessionId, approved: false, reason: 'pending' });
    return {
      success: true,
      result: `[APPROVAL_REQUIRED] ...`,
      awaitingApproval: true,
      durationMs: 0,
    };
  }
}

// Existing step 3: input validation
```

### 4.2 CommandRouter Changes

Add `/approve` and `/reject` handlers in `src/core/command-router.js`.

### 4.3 Wiring

```js
// src/index.js Phase 5 (security)
const approvalManager = new ApprovalManager({ db, eventBus, auditLogger, logger });

// Pass to ToolExecutor
const toolExecutor = new ToolExecutor({ toolRegistry, toolPolicy, approvalManager, auditLogger, logger });
```

## 5. Design Decisions

| Decision | Rationale |
|----------|-----------|
| Approval as tool result (not event/interrupt) | Works within existing ReAct loop without new control flow. The LLM naturally communicates the pending approval to the user. |
| Session-scoped cache (not persistent) | Conservative default. Users must re-approve after restart. Persistent rules come later. |
| `/approve` and `/reject` commands | Simple, discoverable. Works across all adapters. |
| Admin bypasses approval | Admin role already implies full trust. Adding approval friction to admins reduces utility without security benefit. |
| Approval info logged to audit | Creates accountability trail for who approved what and when. |

## 6. Extension Points

- **Persistent approval rules:** Per-user persistent allow/deny per tool (the `tool_approvals` table).
- **Command pattern approval:** Approve patterns like `npm *` or `git status` instead of blanket tool approval.
- **Multi-user approval:** In group chats, require approval from a designated approver (not just any user).
- **Telegram inline buttons:** Use Telegram's inline keyboard for approve/reject buttons instead of text commands.
- **Approval timeout:** Auto-reject if no response within N minutes.
