export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
      event_type TEXT NOT NULL,
      tool_name TEXT,
      user_id TEXT,
      session_id TEXT,
      input TEXT,
      output TEXT,
      success INTEGER,
      duration_ms INTEGER,
      details TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_audit_log_session ON audit_log(session_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_audit_log_tool ON audit_log(tool_name, timestamp);
  `);
}
