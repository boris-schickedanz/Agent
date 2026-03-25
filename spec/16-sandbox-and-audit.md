# Spec 16 — Sandbox & Audit Logging

> Status: **Draft** | Owner: — | Last updated: 2026-03-25

## 1. Purpose

Provide foundational security infrastructure that every capability touching the file system or shell depends on: a workspace sandbox that confines tool operations to approved directories, and a structured audit log that records every tool execution for security review and debugging.

## 2. Components

### 2.1 Workspace Sandbox

**File:** `src/security/sandbox.js`
**Class:** `Sandbox`

Validates and resolves file paths to ensure all operations stay within configured boundaries.

**Interface:**

```js
constructor({ workspaceDir, readOnlyDirs?, logger })

resolve(inputPath: string): string          // Returns absolute path or throws
isAllowed(inputPath: string): boolean       // Check without throwing
assertReadable(inputPath: string): string   // Resolve + ensure exists
assertWritable(inputPath: string): string   // Resolve + ensure not read-only
```

**Path resolution rules:**

1. Resolve `inputPath` relative to `workspaceDir` (if relative) or as absolute.
2. Call `path.resolve()` then `fs.realpathSync.native()` (resolves symlinks).
3. Check that the resolved path starts with `workspaceDir` (normalized with trailing separator).
4. If check fails → throw `SandboxViolationError` with the attempted path (never expose the resolved path in error messages to the LLM).

**Attack surface coverage:**

| Attack | Mitigation |
|--------|-----------|
| Path traversal (`../../etc/passwd`) | `realpath` + prefix check after resolution |
| Symlink escape (`link → /etc`) | `realpathSync.native` follows symlinks before prefix check |
| Null byte injection (`file\x00.txt`) | Strip null bytes before resolution |
| Unicode normalization (`..／`) | Normalize unicode before path resolution |
| UNC paths on Windows (`\\server\share`) | Block paths starting with `\\` |

**Read-only zones:**

Optional `readOnlyDirs` array (e.g., `['/project/node_modules']`). Paths within these directories pass `assertReadable` but fail `assertWritable`.

### 2.2 Audit Logger

**File:** `src/security/audit-logger.js`
**Class:** `AuditLogger`

Structured append-only log of all tool executions and security-relevant events.

**Interface:**

```js
constructor({ db, logger })

logToolExecution({ toolName, input, output, success, userId, sessionId, durationMs }): void
logApproval({ toolName, input, userId, sessionId, approved, reason? }): void
logSecurityEvent({ event, userId, sessionId, details }): void
query({ userId?, sessionId?, toolName?, since?, limit? }): AuditEntry[]
```

**Storage:**

New migration `src/db/migrations/003-audit-log.js`:

```sql
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  event_type TEXT NOT NULL,         -- 'tool_execution' | 'approval' | 'security'
  tool_name TEXT,
  user_id TEXT,
  session_id TEXT,
  input TEXT,                       -- JSON (truncated to 2KB)
  output TEXT,                      -- JSON (truncated to 2KB)
  success INTEGER,                  -- 0 or 1
  duration_ms INTEGER,
  details TEXT                      -- JSON for additional context
);

CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_log_session ON audit_log(session_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_log_tool ON audit_log(tool_name, timestamp);
```

**Design constraints:**

- **Non-blocking:** Audit writes must not slow down tool execution. Use synchronous SQLite inserts (better-sqlite3 is already sync) but truncate inputs/outputs to 2KB.
- **Tamper-resistant:** Append-only table. No DELETE or UPDATE operations exposed.
- **Retention:** No automatic pruning. Future: configurable retention policy.

## 3. Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `WORKSPACE_DIR` | `./workspace` | Root directory for file/shell operations |
| `WORKSPACE_READONLY_DIRS` | `''` | Comma-separated list of read-only subdirectories (relative to WORKSPACE_DIR) |
| `AUDIT_LOG_ENABLED` | `true` | Enable/disable audit logging |

Added to `src/config.js` as:

```js
workspaceDir: path.resolve(process.env.WORKSPACE_DIR || './workspace'),
workspaceReadOnlyDirs: (process.env.WORKSPACE_READONLY_DIRS || '')
  .split(',').map(s => s.trim()).filter(Boolean),
auditLogEnabled: process.env.AUDIT_LOG_ENABLED !== 'false',
```

## 4. Integration

### 4.1 Wiring (src/index.js)

Insert between Phase 4 (tools) and Phase 5 (security):

```js
// Phase 4b — Sandbox & Audit
const sandbox = new Sandbox({ workspaceDir: config.workspaceDir, readOnlyDirs: config.workspaceReadOnlyDirs, logger });
const auditLogger = config.auditLogEnabled ? new AuditLogger({ db, logger }) : null;
```

### 4.2 Tool Executor Hook

Extend `ToolExecutor.execute()` to call `auditLogger.logToolExecution()` after every execution (success or failure). The audit logger is injected via constructor.

### 4.3 Downstream consumers

- **File system tools** (Spec 17): use `sandbox.assertReadable()` / `sandbox.assertWritable()`
- **Shell tools** (Spec 18): use `sandbox.resolve()` for `cwd` parameter; validate output paths
- **Approval manager** (Spec 19): use `auditLogger.logApproval()`

## 5. Design Decisions

| Decision | Rationale |
|----------|-----------|
| `realpathSync.native` over manual checks | Handles symlinks, `.`, `..`, case normalization atomically. Native performance. |
| Sandbox as a standalone class (not baked into tools) | Reusable across file tools, shell tools, and future components. Testable in isolation. |
| Audit in SQLite (not separate log file) | Queryable, indexable, consistent with existing persistence layer. No log rotation complexity. |
| Truncate audit inputs/outputs to 2KB | Prevents database bloat from large file reads or shell output while retaining enough for debugging. |
| Non-blocking audit writes | Tool latency must not increase due to logging. Better-sqlite3 sync writes are fast (~0.1ms). |

## 6. Extension Points

- **Sandbox profiles:** Different workspace roots per agent profile (Spec 21).
- **Audit export:** Export audit log to JSON/CSV for external analysis.
- **Audit alerting:** Watch for anomalous patterns (rapid file writes, repeated permission denials).
- **Retention policy:** Prune entries older than N days via scheduled task.
