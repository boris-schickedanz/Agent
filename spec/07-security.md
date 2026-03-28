# Spec 07 — Security

> Status: **Implemented** | Owner: — | Last updated: 2026-03-28

## 1. Purpose

The security system protects the agent from abuse and prompt injection. AgentCore is a **single-user, single continuous session** system. The approval workflow ([Spec 19](19-approval-workflow.md)) is the primary safety mechanism for destructive tools. Content sanitization and injection detection protect against prompt injection.

## 2. Two-Layer Security Model

```
Inbound message
  │
  ▼
┌─────────────────────────┐
│ Layer 1: RATE LIMIT      │  Global rate limiting
│ (RateLimiter)            │  → reject if exceeded
└────────────┬────────────┘
             ▼
┌─────────────────────────┐
│ Layer 2: CONTENT         │  Content safety
│ (InputSanitizer)         │  → injection detection, sanitization
└────────────┬────────────┘
             ▼
        Agent Loop
```

The approval workflow ([Spec 19](19-approval-workflow.md)) gates destructive tools (write, shell) at the tool execution layer, not the inbound pipeline.

## 3. Components

### 3.1 Permission Manager

**File:** `src/security/permission-manager.js`
**Class:** `PermissionManager`

Single-user model: all access checks always allow. The only active behavior is `checkModelGuardrails()` for outbound content filtering.

**Interface:**

```js
checkAccess(userId: string, channelId: string): { allowed: true, role: 'admin' }
checkScope(userId: string, toolName: string): true
checkModelGuardrails(content: string): { safe: boolean, content: string }
authorize(userId: string, channelId: string, toolName?: string): { allowed: true, role: 'admin' }
```

**`checkModelGuardrails` behavior:**
- Strips accidentally leaked markers: `system:`, `[INTERNAL]`, `[SYSTEM]`.
- Returns sanitized content.
- Called by `HostDispatcher.finalize()` after the runner returns. The guardrailed content is applied to both the outbound message and the persisted conversation history.

### 3.2 Tool Policy

**File:** `src/security/tool-policy.js`
**Class:** `ToolPolicy`

Single-user model: all tools are available. The approval workflow ([Spec 19](19-approval-workflow.md)) is the safety gate for destructive tools.

**Interface:**

```js
isAllowed(toolName: string, userId?: string, session?: Session): true
getEffectiveToolNames(userId?: string, session?: Session): null
```

- `isAllowed()` always returns `true`.
- `getEffectiveToolNames()` always returns `null` (meaning all tools are available — used by HostDispatcher to skip filtering).

### 3.3 Rate Limiter

**File:** `src/security/rate-limiter.js`
**Class:** `RateLimiter`

Fixed-window rate limiting with a single global bucket.

**Interface:**

```js
consume(): { allowed: boolean, retryAfterMs: number }
reset(): void
```

**Algorithm:**
1. Compute current window: `Math.floor(Date.now() / 60_000)` (1-minute windows).
2. Clean up old windows (older than 5 minutes).
3. Query current count for the `'global'` bucket + window.
4. If `count >= config.rateLimitPerMinute` → `{ allowed: false, retryAfterMs }`.
5. Otherwise, upsert to increment count → `{ allowed: true, retryAfterMs: 0 }`.

**Storage:** `rate_limits` table with composite primary key `(user_id, window_start)`. Uses `'global'` as the `user_id` value.

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

## 4. Security Pipeline in the Inbound Message Handler

```js
// src/index.js — message:inbound handler
1. rateLimiter.consume()                         // Global rate limit gate
2. inputSanitizer.sanitize(message)              // Sanitization
3. inputSanitizer.detectInjection(content)        // Injection detection (log only)
4. commandRouter.handle(sanitized)               // Intercept /new, /approve, /reject, /agent, /model, /project
5. dispatcher.buildRequest(sanitized)             // Host resolves session, tools, memory, skills
6. messageQueue.enqueue(sessionId, request, onStreamEvent)  // → runner.execute() → AgentLoop
7. dispatcher.finalize(request, result, message)  // Guardrails, persistence, delivery
```

Step 1 can reject the message. Rejections emit a `message:outbound` with an error message. Outbound guardrails (step 6) are applied by `HostDispatcher.finalize()`, not inside the agent loop.

## 5. Design Decisions

| Decision | Rationale |
|----------|-----------|
| Single-user, approval-based safety | Roles are unnecessary for single-user. The approval workflow gates destructive tools interactively. |
| Soft injection detection | Hard blocking causes false positives. Logging allows monitoring without breaking legitimate usage. |
| Fixed-window rate limiting | Simple, no external dependencies. Sufficient for single-instance deployment. |
| Global rate limit bucket | Single user, single bucket. No per-user tracking needed. |
| AES-256-GCM for key storage | Authenticated encryption. Standard, well-understood, available in Node.js `crypto`. |

## 6. Extension Points

- **Token bucket rate limiting:** Replace fixed-window with token bucket for smoother rate limiting.
- **Output filtering:** Expand `checkModelGuardrails` to scan for PII, credential leaks, or other sensitive data in outbound messages.
- **Webhook authentication:** Add signature verification for webhook-based adapters.
