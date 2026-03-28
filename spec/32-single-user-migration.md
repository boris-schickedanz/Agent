# Spec 32 — Single-User Model Migration

> Status: **Implemented** | Owner: — | Last updated: 2026-03-28

## 1. Problem

The PRD ([§1](PRD-Use-Cases.md)) declares AgentCore as a **single-user, single continuous session** system. However, the codebase and several specs retain multi-user infrastructure from an earlier design:

- **Per-adapter session IDs** — Console and Telegram produce different session IDs, resulting in separate conversation histories. The PRD requires all adapters to share one session.
- **Multi-user role hierarchy** — Four roles (admin/user/pending/blocked) with role-based tool profiles. Dead code for single-user.
- **Per-user rate limiting** — Rate limiter buckets by `userId`. Should be global.
- **Unused `user_aliases` table** — Spec 01 and ARCHITECTURE.md reference cross-adapter identity via this table, but it is never queried.
- **Per-user auto-approval config** — `AUTO_APPROVE_USERS` supports CSV user ID lists, which is irrelevant for single-user.

This spec defines the migration plan to align code with the intended model.

## 2. Design Principles

1. **Approval workflow is the safety mechanism** — not roles. [Spec 19](19-approval-workflow.md) gates destructive tools (write, shell) via interactive approval. This replaces role-based access control.
2. **One session, shared across adapters** — All adapters share a single conversation history and project context. Switching from Console to Telegram continues the same conversation.
3. **Global rate limiting** — A single rate limiter protects against runaway input, not per-user buckets.
4. **Backward-compatible migrations** — Existing database tables (`users`, `user_aliases`, `rate_limits`) stay in place. New code simply ignores them. No destructive migrations.

## 3. Changes

### 3.1 Unified Session ID

**Files:** `src/core/session-manager.js`, `src/adapters/console/console-adapter.js`, `src/adapters/telegram/telegram-normalize.js`

**Current:** `resolveSessionId()` returns `user:{channelId}:{adapterUserId}` — per-adapter sessions.

**Target:** Return a single constant session ID for all adapters:

```js
resolveSessionId(normalizedMessage) {
  return 'user:default';
}
```

- All adapters produce the same canonical session ID.
- `getOrCreate` uses this ID for history, metadata, and queue serialization.
- The `channelId` and `userId` fields are still stored on the session object for outbound routing (which adapter to reply through).
- `resolveCanonicalUserId()` becomes a no-op that returns a constant (e.g., `'default'`).
- The `user_aliases` table is no longer referenced (it already wasn't).

**Adapter changes:** Adapters continue to set `channelId` and `userId` on normalized messages for routing purposes. Only the `sessionId` resolution changes.

**Outbound routing:** `HostDispatcher.finalize()` must preserve the original `channelId` from the inbound message so the response routes to the correct adapter. This already works — the outbound message uses the original adapter `channelId`, not the canonical session ID.

**Specs to update:** [Spec 01 §2.3](01-runtime-core.md), [Spec 06 §3](06-adapters.md), [ARCHITECTURE.md](ARCHITECTURE.md)

### 3.2 Simplify Security to Approval-Only

**Files:** `src/security/permission-manager.js`, `src/security/tool-policy.js`, `src/index.js`

**Current:**
- `PermissionManager.checkAccess()` looks up user role in `users` table, auto-registers new users with `pending` or `user` role.
- `ToolPolicy.getEffectiveToolNames()` maps role → profile (full/standard/minimal) → allowed tool list.
- `ToolPolicy.isAllowed()` checks per-user role before allowing tool execution.

**Target:**
- `PermissionManager.checkAccess()` always returns `{ allowed: true, role: 'admin' }`. No database lookup.
- `ToolPolicy.getEffectiveToolNames()` always returns `null` (all tools available). The approval workflow ([Spec 19](19-approval-workflow.md)) remains the safety gate for destructive tools.
- `ToolPolicy.isAllowed()` always returns `true`.
- `ToolPolicy` constructor no longer needs `db`.

The `users` table stays in the database (no destructive migration) but is no longer written to or read from.

**Specs to update:** [Spec 07 §3.1–3.2](07-security.md), [Spec 07 §4](07-security.md)

### 3.3 Global Rate Limiter

**Files:** `src/security/rate-limiter.js`

**Current:** `consume(userId)` and `reset(userId)` bucket by `userId`.

**Target:**
- `consume()` takes no arguments (or ignores `userId`). Uses a fixed key (e.g., `'global'`) for the rate limit bucket.
- `reset()` takes no arguments. Clears the global bucket.
- The `rate_limits` table structure is unchanged — just uses `'global'` as the `user_id` value.

**Interface change:**

```js
consume(): { allowed: boolean, retryAfterMs: number }
reset(): void
```

**Specs to update:** [Spec 07 §3.3](07-security.md), [Spec 09](09-configuration.md) (remove `RATE_LIMIT_MESSAGES_PER_MINUTE` per-user wording)

### 3.4 Remove AUTO_APPROVE_USERS

**Files:** `src/config.js`, `src/security/permission-manager.js`

**Current:** `AUTO_APPROVE_USERS` supports `true`, `false`, or a CSV list of user IDs.

**Target:** Remove the config variable entirely. The single user is always authorized. The `PermissionManager` no longer auto-registers users.

**Backward compatibility:** If `AUTO_APPROVE_USERS` is set in `.env`, it is silently ignored.

**Specs to update:** [Spec 09](09-configuration.md)

### 3.5 Security Pipeline Simplification

**File:** `src/index.js`

**Current inbound pipeline:**
```
rateLimiter.consume(userId)
permissionManager.checkAccess(userId, channelId)
inputSanitizer.sanitize(message)
inputSanitizer.detectInjection(content)
```

**Target:**
```
rateLimiter.consume()
inputSanitizer.sanitize(message)
inputSanitizer.detectInjection(content)
```

- Remove `permissionManager.checkAccess()` from the inbound pipeline (it now always allows).
- Rate limiter call simplified (no userId).
- `InputSanitizer` and `detectInjection` remain unchanged — content safety is independent of user model.
- `permissionManager.checkModelGuardrails()` in `finalize()` remains unchanged — it's content filtering, not user filtering.

**Specs to update:** [Spec 07 §5](07-security.md), [Spec 01 §3](01-runtime-core.md)

### 3.6 Cross-Session Queue Behavior

**File:** `src/core/message-queue.js`

**Current:** Per-session serialization with cross-session parallelism.

**Target:** With a unified session ID, all messages are serialized through a single queue. Cross-session parallelism becomes irrelevant (there's only one session). No code change needed — the existing `MessageQueue` handles this correctly by virtue of all messages sharing the same `sessionId`.

**Note:** This means messages from Console and Telegram are serialized. A Telegram message waits for a Console message to finish processing. This is the correct behavior for a single continuous session.

## 4. Migration Order

The changes can be applied independently, but this order minimizes intermediate inconsistency:

| Phase | Changes | Risk |
|-------|---------|------|
| **M1** | §3.1 Unified session ID | Low — only changes session routing. If outbound routing breaks, responses go to wrong adapter. Test cross-adapter. |
| **M2** | §3.2 Simplify security + §3.4 Remove AUTO_APPROVE_USERS | Low — removes restrictions. No feature loss. |
| **M3** | §3.3 Global rate limiter | Low — trivial change. |
| **M4** | §3.5 Pipeline simplification | Low — removes a gate that now always passes. |
| **M5** | Spec updates (01, 06, 07, 09, ARCHITECTURE.md) | None — documentation only. |

## 5. What Does NOT Change

- **Approval workflow** ([Spec 19](19-approval-workflow.md)) — remains the safety gate for write/shell tools
- **Sandbox** ([Spec 16](16-sandbox-and-audit.md)) — workspace path confinement unchanged
- **Audit logger** — continues logging all tool executions
- **Input sanitizer** — content sanitization and injection detection unchanged
- **Model guardrails** — outbound content filtering unchanged
- **Database tables** — `users`, `user_aliases`, `rate_limits` tables remain (no destructive migrations). They become unused.
- **Memory system** — persistent memory, conversation memory, FTS search all unchanged
- **Multi-project system** — project manager, state bootstrap unchanged
- **Context compaction** — thresholds, algorithms unchanged

## 6. Affected Specs (Post-Migration Updates)

| Spec | Updates Needed |
|------|---------------|
| [01 — Runtime Core](01-runtime-core.md) | §2.3 SessionManager: single session ID. §3 Startup: remove permission check from pipeline. Remove single-user notes. |
| [06 — Adapters](06-adapters.md) | §3: session ID is shared, not per-adapter. Remove single-user note. |
| [07 — Security](07-security.md) | §3.1: PermissionManager always allows. §3.2: ToolPolicy always returns all tools. §3.3: Global rate limiter. §4: Remove role table. §5: Simplified pipeline. Remove single-user note. |
| [09 — Configuration](09-configuration.md) | Remove `AUTO_APPROVE_USERS`. Update `RATE_LIMIT_MESSAGES_PER_MINUTE` description. Remove single-user note. |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Session identity section: single shared session. Security pipeline: simplified. Remove single-user note. |

## 7. Test Plan

| Test | Validates |
|------|-----------|
| Send message via Console, then via Telegram — same conversation history | §3.1 Unified session |
| `/new` via Console clears history for Telegram too | §3.1 Shared session |
| Destructive tool (write_file) still requires approval | §3.2 Approval workflow preserved |
| Rate limit triggers after 20 messages regardless of adapter | §3.3 Global rate limiter |
| New Telegram user immediately has all tools available | §3.2 No pending role |
| Project state persists across adapter switch | §3.1 + Spec 31 interaction |
| Message queue serializes Console and Telegram messages | §3.6 Single queue |
