# Spec 19 — Approval Workflow

> Status: **Implemented** | Owner: — | Last updated: 2026-03-27

## 1. Purpose

Provide interactive, per-tool approval prompts so that dangerous operations (shell execution, file writes, destructive actions) can be gated behind explicit user consent. This is the critical security mechanism that enables non-admin users to access powerful tools safely.

## 2. Design Overview

When a tool requiring approval is invoked, the agent pauses, asks the user for permission via their chat channel, and resumes or aborts based on the response. The approval mechanism is transparent to the LLM — it sees either the tool result (if approved) or the approval prompt (if pending).

```
AgentLoop calls tool → ToolExecutor checks approval
  → If admin: proceed (bypass)
  → If needed: return [APPROVAL_REQUIRED] message to LLM
     → LLM relays to user
     → User responds /approve or /reject
     → Next agent iteration: tool executes if approved
```

## 3. Components

### 3.1 Approval Manager

**File:** `src/security/approval-manager.js`
**Class:** `ApprovalManager`

**Interface:**

```js
constructor({ db, eventBus, auditLogger, logger })

needsApproval(toolName, userId, sessionId): boolean  // checks role, grant, then TOOLS_REQUIRING_APPROVAL
requiresApproval(toolName): boolean          // role-agnostic, checks TOOLS_REQUIRING_APPROVAL
getPending(sessionId): PendingApproval | null
setPending(sessionId, { toolName, input, userId }): void
resolve(sessionId, approved, reason?): void
grantApproval(sessionId, toolName): void     // one-time grant, consumed by needsApproval()
clearSession(sessionId): void                // clears pending + grants
```

### 3.2 Approval Defaults

Tools requiring approval are defined in the exported `TOOLS_REQUIRING_APPROVAL` set (`approval-manager.js`):

| Tool | Requires approval (non-admin) |
|------|-------------------------------|
| `run_command` | yes |
| `run_command_background` | yes |
| `kill_process` | yes |
| `write_file` | yes |
| `edit_file` | yes |
| `http_post` | yes |
| `delegate_task` | yes |
| `cancel_delegation` | yes |
| All other tools | no |

Admin users (`role: 'admin'`) bypass approval entirely (checked via DB query in `_getUserRole()`).

### 3.3 Approval Flow in Detail

**Step 1: Tool invocation**

`ToolExecutor.execute()` checks `approvalManager.needsApproval(toolName, userId, sessionId)` (step 2.5, between permission check and input validation).

If approval is needed, returns:

```js
{
  success: true,
  result: `[APPROVAL_REQUIRED] The tool "${toolName}" requires your approval...\n\nReply /approve to allow or /reject to deny.`,
  awaitingApproval: true,
  durationMs: 0,
}
```

**Step 1b: Pending state stored**

`ToolExecutor` calls `approvalManager.setPending(sessionId, { toolName, input, userId })` so that the pending request is available when the user responds.

**Step 2: User response**

`CommandRouter` intercepts `/approve`, `/yes`, `/reject`, `/no`. Telegram `@BotName` suffixes (e.g. `/approve@AgentCoreBot`) are stripped before matching.

- `/approve` or `/yes` → `approvalManager.resolve(sessionId, true)` → `approvalManager.grantApproval(sessionId, toolName)` → responds "Approved. Continuing..." → returns `forwardContent` so the message re-enters the pipeline and the agent loop retries the tool.
- `/reject` or `/no` → `approvalManager.resolve(sessionId, false, 'User rejected')` → responds "Rejected. Operation cancelled."

**Step 3: Agent resumes**

The forwarded message (e.g. `[User approved the run_command operation. Continue.]`) enters the pipeline. The agent loop retries the tool. `needsApproval()` finds the temporary grant, consumes it, and returns `false` — the tool executes normally.

Every write tool invocation requires individual approval — there is no session caching. The grant is one-time use and expires after 5 minutes.

### 3.4 Temporary Grants

`grantApproval(sessionId, toolName)` creates a one-time, session+tool-scoped grant consumed by the next `needsApproval()` check. Grants expire after 5 minutes and are cleaned up by `clearSession()`.

### 3.5 Telegram Command Handling

Telegram sends commands with optional `@BotName` suffixes (e.g. `/approve@MyBot`). The `CommandRouter` normalizes commands by stripping the `@mention` suffix before matching, so all commands work identically across console and Telegram adapters.

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
| No session caching — every invocation requires approval | Simpler model, stronger safety. Each execution is independently approved. |
| `/approve` and `/reject` commands | Simple, discoverable. Works across all adapters. Also accepts `/yes` and `/no`. Telegram `@BotName` suffixes stripped automatically. |
| One-time grant after `/approve` | Enables seamless tool retry without a second approval prompt, while maintaining per-invocation security. |
| Admin bypasses approval | Admin role already implies full trust. |
| Approval info logged to audit | Creates accountability trail for who approved what and when. |

## 6. Extension Points

- **Persistent approval rules:** Per-user persistent allow/deny per tool (a `tool_approvals` table).
- **Command pattern approval:** Approve patterns like `npm *` or `git status` instead of blanket tool approval.
- **Multi-user approval:** In group chats, require approval from a designated approver.
- **Telegram inline buttons:** Use Telegram's inline keyboard for approve/reject buttons.
- **Approval timeout:** Auto-reject if no response within N minutes.
