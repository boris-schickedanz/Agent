# Spec 16 — Sandbox & Audit Logging

> Status: **Implemented** | Owner: — | Last updated: 2026-03-25

## 1. Purpose

Provide foundational security infrastructure that every capability touching the file system or shell depends on: a workspace sandbox that confines tool operations to approved directories, and a structured audit log that records every tool execution for security review and debugging.

## 2. Components

### 2.1 Workspace Sandbox

**File:** `src/security/sandbox.js`
**Class:** `Sandbox`
**Error class:** `SandboxViolationError`

Validates and resolves file paths to ensure all operations stay within configured boundaries.

**Interface:**

```js
constructor({ workspaceDir, readOnlyDirs?, logger })

resolve(inputPath: string): string          // Returns absolute path or throws
isAllowed(inputPath: string): boolean       // Check without throwing
assertReadable(inputPath: string): string   // Resolve (delegates to resolve())
assertWritable(inputPath: string): string   // Resolve + ensure not read-only
```

**Path resolution rules:**

1. Block UNC paths (`\\server\share`).
2. Strip null bytes, normalize unicode (NFC).
3. Resolve `inputPath` relative to `workspaceDir` via `path.resolve()`.
4. Call `fs.realpathSync.native()` (resolves symlinks). If path doesn't exist, walk up to the nearest existing ancestor and resolve that.
5. Check that the resolved path starts with `workspaceDir` + path separator (or equals `workspaceDir`).
6. If check fails → throw `SandboxViolationError` (never exposes the resolved path in error messages).

**Attack surface coverage:**

| Attack | Mitigation |
|--------|-----------|
| Path traversal (`../../etc/passwd`) | `realpath` + prefix check after resolution |
| Symlink escape (`link → /etc`) | `realpathSync.native` follows symlinks before prefix check |
| Null byte injection (`file\x00.txt`) | Strip null bytes before resolution |
| Unicode normalization (`..／`) | NFC normalize before path resolution |
| UNC paths on Windows (`\\server\share`) | Block paths starting with `\\` |

**Read-only zones:**

Optional `readOnlyDirs` array (e.g., `['readonly']`). Paths resolved relative to `workspaceDir`. Paths within these directories pass `assertReadable` but fail `assertWritable`.

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

Migration `src/db/migrations/003-audit-log.js`:

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

**Query uses named parameters** (`@userId`, `@sessionId`, etc.) for compatibility with better-sqlite3's handling of reused parameter positions.

**Design constraints:**

- **Non-blocking:** Truncate inputs/outputs to 2KB. Better-sqlite3 sync writes are fast (~0.1ms).
- **Tamper-resistant:** Append-only table. No DELETE or UPDATE operations exposed.
- **Retention:** No automatic pruning. Future: configurable retention policy.

## 3. Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `WORKSPACE_DIR` | `./workspace` | Root directory for file/shell operations |
| `WORKSPACE_READONLY_DIRS` | `''` | Comma-separated list of read-only subdirectories (relative to WORKSPACE_DIR) |
| `AUDIT_LOG_ENABLED` | `true` | Enable/disable audit logging |

## 4. Integration

### 4.1 Wiring (src/index.js)

```js
// Phase 4b — Sandbox & Audit
mkdirSync(config.workspaceDir, { recursive: true });
const sandbox = new Sandbox({ workspaceDir: config.workspaceDir, readOnlyDirs: config.workspaceReadOnlyDirs, logger });
const auditLogger = config.auditLogEnabled ? new AuditLogger({ db, logger }) : null;
```

### 4.2 Tool Executor Hook

`ToolExecutor` accepts `{ auditLogger, approvalManager }` as an options object in its constructor. Calls `auditLogger.logToolExecution()` after every execution (success or failure), and on permission denial.

### 4.3 Downstream consumers

- **File system tools** (Spec 17): use `sandbox.assertReadable()` / `sandbox.assertWritable()`
- **Shell tools** (Spec 18): use `sandbox.resolve()` for `cwd` parameter via `ProcessManager`
- **Approval manager** (Spec 19): use `auditLogger.logApproval()`

## 5. Design Decisions

| Decision | Rationale |
|----------|-----------|
| `realpathSync.native` over manual checks | Handles symlinks, `.`, `..`, case normalization atomically. Native performance. |
| Walk up to nearest existing parent for new files | Allows writes to paths that don't exist yet while still validating the parent chain. |
| Sandbox as a standalone class (not baked into tools) | Reusable across file tools, shell tools, and future components. Testable in isolation. |
| Audit in SQLite (not separate log file) | Queryable, indexable, consistent with existing persistence layer. No log rotation complexity. |
| Named parameters in query | Better-sqlite3 doesn't support reuse of numbered positional parameters (`?1`). Named params work correctly. |
| Truncate audit inputs/outputs to 2KB | Prevents database bloat from large file reads or shell output while retaining enough for debugging. |

## 6. Extension Points

- **Sandbox profiles:** Different workspace roots per agent profile (Spec 21).
- **Audit export:** Export audit log to JSON/CSV for external analysis.
- **Audit alerting:** Watch for anomalous patterns (rapid file writes, repeated permission denials).
- **Retention policy:** Prune entries older than N days via scheduled task.
