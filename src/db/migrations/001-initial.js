export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      token_estimate INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      metadata TEXT,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      key, content, metadata,
      tokenize='porter unicode61'
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      display_name TEXT,
      role TEXT DEFAULT 'user' CHECK (role IN ('admin', 'user', 'pending', 'blocked')),
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS rate_limits (
      user_id TEXT NOT NULL,
      window_start INTEGER NOT NULL,
      token_count INTEGER DEFAULT 0,
      PRIMARY KEY (user_id, window_start)
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      service TEXT PRIMARY KEY,
      encrypted_key BLOB NOT NULL,
      iv BLOB NOT NULL,
      auth_tag BLOB NOT NULL,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS heartbeat_state (
      task_name TEXT PRIMARY KEY,
      last_run_at INTEGER,
      last_result TEXT
    );
  `);
}
