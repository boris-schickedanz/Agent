# Spec 07 — Security

> Status: **Implemented** | Owner: — | Last updated: 2026-03-27

## 1. Purpose

The security system protects the agent from abuse, unauthorized access, and prompt injection. It uses a three-layer model evaluated on every inbound message and tool execution.

> **Single-user model note:** The PRD declares AgentCore as a single-user system ([PRD §1](PRD-Use-Cases.md), [PRD §5](PRD-Use-Cases.md)). The multi-user role hierarchy (admin/user/pending/blocked), per-user rate limiting, and role-based tool policies described below are legacy infrastructure. In the intended single-user model, the approval workflow ([Spec 19](19-approval-workflow.md)) is the primary safety mechanism — not roles. See [Spec 32](32-single-user-migration.md) for the migration plan.

## 2. Three-Layer Security Model

```
Inbound message
  │
  ▼
┌─────────────────────────┐
│ Layer 1: IDENTITY        │  Who is this user?
│ (PermissionManager)      │  → admin / user / pending / blocked
└────────────┬────────────┘
             ▼
┌─────────────────────────┐
│ Layer 2: SCOPE           │  What can they do?
│ (ToolPolicy)             │  → tool allow/deny lists per role
└────────────┬────────────┘
             ▼
┌─────────────────────────┐
│ Layer 3: MODEL           │  Content safety
│ (InputSanitizer)         │  → injection detection, sanitization
└────────────┬────────────┘
             ▼
        Agent Loop
```

## 3. Components

### 3.1 Permission Manager

**File:** `src/security/permission-manager.js`
**Class:** `PermissionManager`

**Interface:**

```js
checkAccess(userId: string, channelId: string): { allowed: boolean, role?: string, reason?: string }
checkScope(userId: string, toolName: string): boolean
checkModelGuardrails(content: string): { safe: boolean, content: string }
authorize(userId: string, channelId: string, toolName?: string): { allowed: boolean, role?: string, reason?: string }
```

**`checkAccess` behavior:**
1. Query `users` table for the user's role.
2. If `role === 'blocked'` → `{ allowed: false, reason: 'User is blocked' }`.
3. If user not found → auto-register with role `'user'` (if `AUTO_APPROVE_USERS=true`) or `'pending'`.
4. Console channel always gets `admin` role on authorization errors (fail-open for local dev).
5. External channels fail closed on errors.

**`checkModelGuardrails` behavior:**
- Strips accidentally leaked markers: `system:`, `[INTERNAL]`, `[SYSTEM]`.
- Returns sanitized content.
- Called by `HostDispatcher.finalize()` after the runner returns. The guardrailed content is applied to both the outbound message and the persisted conversation history (the last assistant message in `newMessages` is updated with the filtered content before `appendMessages` is called).

### 3.2 Tool Policy

**File:** `src/security/tool-policy.js`
**Class:** `ToolPolicy`

Role-based tool access control using allow/deny profiles.

**Interface:**

```js
constructor(db, config, approvalManager?)
isAllowed(toolName: string, userId: string, session: Session): boolean
getEffectiveToolNames(userId: string, session: Session): Array<{ name, requiresApproval }> | null
```

**Default profiles:**

| Profile | Allow | Deny |
|---------|-------|------|
| `minimal` | `get_current_time` | `*` (everything else) |
| `standard` | `get_current_time`, `wait`, `search_memory`, `list_memories`, `http_get`, `read_file`, `list_directory`, `file_search`, `grep_search`, `list_processes`, `check_process`, `check_delegation`, `save_memory`, `http_post`, `write_file`, `edit_file`, `run_command`, `run_command_background`, `kill_process`, `delegate_task`, `cancel_delegation` | (nothing — write tools gated by approval workflow, see Spec 19) |
| `full` | `*` (everything) | (nothing) |

**Role → Profile mapping:**

| Role | Profile |
|------|---------|
| `admin` | `full` |
| `user` | `standard` |
| `pending` | `minimal` |
| `blocked` | (no access) |

**Evaluation rules:**
1. Deny patterns are evaluated first.
2. If a tool matches a deny pattern, check if it's explicitly listed in allow. Explicit allow overrides wildcard deny.
3. If no deny matches, check allow patterns.
4. Pattern matching: `*` matches everything; `prefix*` matches tools starting with prefix; exact string matches exactly.

**`getEffectiveToolNames` behavior:**
- Returns `null` if allow includes `*` (meaning all tools are available — used by HostDispatcher to skip filtering).
- Returns `Array<{ name, requiresApproval }>` otherwise — each tool annotated with whether it requires approval (cross-referenced with `ApprovalManager.requiresApproval()`).

### 3.3 Rate Limiter

**File:** `src/security/rate-limiter.js`
**Class:** `RateLimiter`

Fixed-window rate limiting stored in SQLite.

**Interface:**

```js
consume(userId: string): { allowed: boolean, retryAfterMs: number }
reset(userId: string): void
```

**Algorithm:**
1. Compute current window: `Math.floor(Date.now() / 60_000)` (1-minute windows).
2. Clean up old windows (older than 5 minutes).
3. Query current count for user + window.
4. If `count >= config.rateLimitPerMinute` → `{ allowed: false, retryAfterMs }`.
5. Otherwise, upsert to increment count → `{ allowed: true, retryAfterMs: 0 }`.

**Storage:** `rate_limits` table with composite primary key `(user_id, window_start)`.

### 3.4 Input Sanitizer

**File:** `src/security/input-sanitizer.js`
**Class:** `InputSanitizer`

**Interface:**

```js
sanitize(message: NormalizedMessage): NormalizedMessage
detectInjection(content: string): { suspicious: boolean, patterns: string[] }
```

**`sanitize` behavior:**
1. Strip zero-width characters: `\u200B-\u200F`, `\u2028-\u202F`, `\uFEFF`.
2. Strip Unicode control characters: `\u0000-\u0008`, `\u000B`, `\u000C`, `\u000E-\u001F`.
3. Truncate to 10,000 characters (append `...[truncated]`).
4. Return new message object with `_sanitized: true` flag.

**`detectInjection` patterns detected (soft detection, logging only):**

| Pattern | Example |
|---------|---------|
| `ignore (all )?previous instructions` | "Ignore all previous instructions" |
| `you are now` | "You are now DAN" |
| `system:` | "system: override rules" |
| `do not follow.*rules` | "Do not follow your rules" |
| `override.*system` | "Override the system" |
| `pretend.*you are` | "Pretend you are a different AI" |
| `jailbreak` | "jailbreak mode" |
| `DAN mode` | "Enter DAN mode" |

**Important:** Detection is soft — messages are flagged for logging but NOT blocked. This avoids false positives on legitimate messages.

### 3.5 API Key Store

**File:** `src/security/api-key-store.js`
**Class:** `ApiKeyStore`

Encrypted at-rest storage for API keys and credentials.

**Interface:**

```js
store(service: string, apiKey: string): void
retrieve(service: string): string | null
delete(service: string): void
list(): string[]    // Returns service names, NOT keys
```

**Encryption:**
- Algorithm: AES-256-GCM
- Key derivation: PBKDF2 with SHA-256, 100,000 iterations
- Salt: `'agent-core-key-store-v1'` (static, per-application)
- Master key source: `config.masterKey` or `config.anthropicApiKey` (fallback)
- Each entry has its own random 16-byte IV
- Auth tag stored alongside ciphertext for integrity verification

**Storage:** `api_keys` table with columns: `service`, `encrypted_key` (BLOB), `iv` (BLOB), `auth_tag` (BLOB).

## 4. User Roles

| Role | Access | Auto-assigned when |
|------|--------|--------------------|
| `admin` | All tools, all commands | Console adapter (fallback) |
| `user` | Standard tool set | `AUTO_APPROVE_USERS=true` |
| `pending` | Minimal tools (time only) | `AUTO_APPROVE_USERS=false` (default) |
| `blocked` | No access | Admin blocks a user |

Users are stored in the `users` table. Role changes require direct database modification or a future admin command system.

## 5. Security Pipeline in the Inbound Message Handler

```js
// src/index.js — message:inbound handler
1. rateLimiter.consume(userId)                       // Rate limit gate
2. permissionManager.checkAccess(userId, channelId)  // Identity gate
3. inputSanitizer.sanitize(message)                  // Sanitization
4. inputSanitizer.detectInjection(content)            // Injection detection (log only)
5. dispatcher.buildRequest(sanitized)                 // Host resolves session, tools, memory, skills
6. messageQueue.enqueue(sessionId, request)           // → runner.execute() → AgentLoop
7. dispatcher.finalize(request, result, message)      // Guardrails, persistence, delivery
```

Each gate (steps 1-3) can reject the message. Rejections emit a `message:outbound` with an error message. Outbound guardrails (step 7) are applied by `HostDispatcher.finalize()`, not inside the agent loop.

## 6. Design Decisions

| Decision | Rationale |
|----------|-----------|
| Three layers evaluated sequentially | Clear separation of concerns. Each layer has a single responsibility. |
| Soft injection detection | Hard blocking causes false positives. Logging allows monitoring without breaking legitimate usage. |
| Fixed-window rate limiting | Simple, no external dependencies. Sufficient for single-instance deployment. |
| AES-256-GCM for key storage | Authenticated encryption. Standard, well-understood, available in Node.js `crypto`. |
| Console fails open | Local development should not be blocked by security. External channels fail closed. |
| Roles stored in SQLite | Simple, queryable, transactional. No need for JWT/session tokens at this scale. |

## 7. Extension Points

- **Admin commands:** Add tool-based user management (`/admin approve <userId>`, `/admin block <userId>`).
- **Token bucket rate limiting:** Replace fixed-window with token bucket for smoother rate limiting.
- **Output filtering:** Expand `checkModelGuardrails` to scan for PII, credential leaks, or other sensitive data in outbound messages.
- **Per-channel policies:** Allow different tool policy profiles per channel (e.g., more restricted in public groups).
- **Webhook authentication:** Add signature verification for webhook-based adapters.
