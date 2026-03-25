export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_aliases (
      adapter_user_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      canonical_id TEXT NOT NULL,
      PRIMARY KEY (adapter_user_id, channel_id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_aliases_canonical ON user_aliases(canonical_id);
  `);
}
