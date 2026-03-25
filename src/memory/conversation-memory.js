export class ConversationMemory {
  constructor(db) {
    this.db = db;
    this._stmts = {
      insert: db.prepare(
        'INSERT INTO messages (session_id, role, content, token_estimate) VALUES (?, ?, ?, ?)'
      ),
      getHistory: db.prepare(
        'SELECT role, content, created_at FROM messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?'
      ),
      getAll: db.prepare(
        'SELECT role, content, created_at FROM messages WHERE session_id = ? ORDER BY created_at ASC'
      ),
      clear: db.prepare('DELETE FROM messages WHERE session_id = ?'),
      deleteOldest: db.prepare(
        `DELETE FROM messages WHERE id IN (
          SELECT id FROM messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?
        )`
      ),
    };
  }

  append(sessionId, role, content) {
    const contentStr = typeof content === 'string' ? content : JSON.stringify(content);
    const tokenEstimate = Math.ceil(contentStr.length / 4);
    this._stmts.insert.run(sessionId, role, contentStr, tokenEstimate);
  }

  appendMany(sessionId, messages) {
    const insertMany = this.db.transaction((msgs) => {
      for (const msg of msgs) {
        this.append(sessionId, msg.role, msg.content);
      }
    });
    insertMany(messages);
  }

  getHistory(sessionId, limit = 50) {
    const rows = this._stmts.getHistory.all(sessionId, limit);
    return rows.map(r => ({
      role: r.role,
      content: this._parseContent(r.content),
    }));
  }

  getFullHistory(sessionId) {
    const rows = this._stmts.getAll.all(sessionId);
    return rows.map(r => ({
      role: r.role,
      content: this._parseContent(r.content),
    }));
  }

  clearSession(sessionId) {
    this._stmts.clear.run(sessionId);
  }

  replaceHistory(sessionId, messages) {
    const replace = this.db.transaction(() => {
      this._stmts.clear.run(sessionId);
      for (const msg of messages) {
        this.append(sessionId, msg.role, msg.content);
      }
    });
    replace();
  }

  _parseContent(content) {
    try {
      return JSON.parse(content);
    } catch {
      return content;
    }
  }
}
