export class MemorySearch {
  constructor(db) {
    this.db = db;
    this._searchStmt = db.prepare(
      `SELECT key, content, metadata, rank
       FROM memory_fts
       WHERE memory_fts MATCH ?
       ORDER BY rank
       LIMIT ?`
    );
  }

  search(query, limit = 5) {
    if (!query || query.trim().length === 0) return [];
    try {
      // Sanitize query for FTS5: remove special characters
      const sanitized = query.replace(/[^\w\s]/g, ' ').trim();
      if (!sanitized) return [];
      const rows = this._searchStmt.all(sanitized, limit);
      return rows.map(r => ({
        key: r.key,
        content: r.content,
        metadata: r.metadata ? JSON.parse(r.metadata) : {},
      }));
    } catch {
      return [];
    }
  }

  reindex(persistentMemory) {
    this.db.exec('DELETE FROM memory_fts');
    const keys = persistentMemory.list();
    for (const key of keys) {
      const content = persistentMemory.load(key);
      if (content) {
        this.db.prepare(
          'INSERT INTO memory_fts (key, content, metadata) VALUES (?, ?, ?)'
        ).run(key, content, '{}');
      }
    }
  }
}
