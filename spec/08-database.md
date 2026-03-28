# Spec 08 — Database

> Status: **Implemented** | Owner: — | Last updated: 2026-03-25

## 1. Purpose

SQLite provides all persistence for AgentCore: conversation history, sessions, user identity, rate limiting, encrypted credentials, FTS5 search indexes, and heartbeat state. A single database file with WAL mode handles all concurrent access patterns.

## 2. Connection Management

**File:** `src/db/database.js`
**Class:** `DB`

**Singleton pattern:** `DB.getInstance(dbPath)` returns the same instance for a given path across the process.

**Pragmas set on connection:**

```sql
PRAGMA journal_mode = WAL;      -- Write-Ahead Logging for concurrent reads
PRAGMA foreign_keys = ON;        -- Enforce foreign key constraints
PRAGMA busy_timeout = 5000;      -- Wait up to 5s for locks instead of failing immediately
```

**Interface:**

```js
static getInstance(dbPath: string): DB
prepare(sql: string): Statement
exec(sql: string): void
transaction(fn: Function): TransactionFunction
async migrate(): void
close(): void
```

**Directory creation:** The parent directory of `dbPath` is created automatically via `mkdirSync({ recursive: true })`.

## 3. Migration System

Migrations are ES modules in `src/db/migrations/` named with a numeric prefix (e.g., `001-initial.js`).

**Migration file contract:**

```js
export function up(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ...`);
}
```

**Migration tracking:** The `migrations` table records which migrations have been applied:

```sql
CREATE TABLE migrations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,           -- Filename (e.g., "001-initial.js")
  applied_at INTEGER DEFAULT (unixepoch())
);
```

**Migration execution:**
1. Read all `.js` files from the migrations directory, sorted alphabetically.
2. Skip files already in the `migrations` table.
3. For each unapplied migration: execute `up(db)` inside a transaction, then record the filename.
4. Migrations are loaded via dynamic `import()` (ES module compatible).

**Adding a new migration:**
1. Create `src/db/migrations/NNN-<description>.js` with `export function up(db) { ... }`.
2. Use `db.exec()` for DDL statements.
3. The migration runs automatically on next startup.

## 4. Schema

### 4.1 Messages

Stores conversation history per session.

```sql
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,           -- Plain string or JSON-encoded content blocks
  token_estimate INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX idx_messages_session ON messages(session_id, created_at);
```

**Notes:**
- `content` stores strings directly or `JSON.stringify`'d arrays (for tool_use/tool_result blocks).
- `token_estimate` is `Math.ceil(content.length / 4)`.
- Index on `(session_id, created_at)` supports efficient history loading.

### 4.2 Sessions

Tracks active sessions.

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,            -- "{channelId}:{userId}" composite key
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  metadata TEXT,                  -- JSON blob
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);
```

### 4.3 Memory FTS

Full-text search index for persistent memory.

```sql
CREATE VIRTUAL TABLE memory_fts USING fts5(
  key,                            -- Memory identifier
  content,                        -- Full text content
  metadata,                       -- JSON metadata string
  tokenize='porter unicode61'     -- Porter stemming + Unicode normalization
);
```

**Note:** This is a virtual table managed by FTS5. It does not support standard SQL constraints. The source of truth for memory content is the markdown files on disk; this table is a derived search index.

### 4.4 Users

User identity table. Retained for backward compatibility (no destructive migrations) but no longer actively written to or read from in the single-user model ([Spec 32](32-single-user-migration.md)). The `ApprovalManager` reads the `role` column to determine admin bypass for the approval workflow.

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,            -- Platform user ID
  channel_id TEXT NOT NULL,
  display_name TEXT,
  role TEXT DEFAULT 'user' CHECK (role IN ('admin', 'user', 'pending', 'blocked')),
  created_at INTEGER DEFAULT (unixepoch())
);
```

### 4.5 Rate Limits

Fixed-window rate limiting counters.

```sql
CREATE TABLE rate_limits (
  user_id TEXT NOT NULL,
  window_start INTEGER NOT NULL,  -- Unix minutes (Date.now() / 60000)
  token_count INTEGER DEFAULT 0,
  PRIMARY KEY (user_id, window_start)
);
```

**Cleanup:** Old windows (older than 5 minutes) are deleted on each `consume()` call.

### 4.6 API Keys

Encrypted credential storage.

```sql
CREATE TABLE api_keys (
  service TEXT PRIMARY KEY,       -- Service identifier (e.g., "openweather")
  encrypted_key BLOB NOT NULL,    -- AES-256-GCM ciphertext
  iv BLOB NOT NULL,               -- 16-byte initialization vector
  auth_tag BLOB NOT NULL,         -- GCM authentication tag
  created_at INTEGER DEFAULT (unixepoch())
);
```

### 4.7 Heartbeat State

Tracks last execution of periodic tasks.

```sql
CREATE TABLE heartbeat_state (
  task_name TEXT PRIMARY KEY,
  last_run_at INTEGER,
  last_result TEXT
);
```

## 5. Data Location

Default: `./data/agent-core.db` (configurable via `DATA_DIR` env var).

Associated WAL files (`*.db-wal`, `*.db-shm`) are managed by SQLite and should be gitignored.

## 6. Design Decisions

| Decision | Rationale |
|----------|-----------|
| SQLite over PostgreSQL/Redis | Zero-dependency, single-file, embedded. No external service to manage. Sufficient for single-instance agent. |
| WAL mode | Allows concurrent reads while a write is in progress. Critical for adapters reading while the agent loop writes. |
| Singleton pattern | Prevents multiple connections to the same database, which could cause locking issues. |
| `unixepoch()` for timestamps | Integer timestamps are compact, sortable, and timezone-agnostic. |
| `CREATE IF NOT EXISTS` in migrations | Makes migrations idempotent — safe to re-run if the migrations table is lost. |
| Content stored as TEXT, not structured columns | LLM message content can be plain text or complex JSON (tool_use blocks). A TEXT column with JSON parsing on read handles both. |

## 7. Extension Points

- **Additional migrations:** Add `002-*.js`, `003-*.js`, etc. They run automatically on next startup.
- **Database compaction:** Add a `VACUUM` command to a heartbeat task for periodic defragmentation.
- **Backup:** Copy the `.db` file while in WAL mode (SQLite handles this safely) or use the `.backup` API.
- **Multiple databases:** Split read-heavy tables (messages) from write-heavy tables (rate_limits) into separate files if needed.
