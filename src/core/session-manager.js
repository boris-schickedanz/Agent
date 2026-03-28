export const DEFAULT_SESSION_ID = 'user:default';

export class SessionManager {
  constructor(db, conversationMemory) {
    this.db = db;
    this.memory = conversationMemory;
    this._sessions = new Map();

    this._stmts = {
      upsert: db.prepare(`
        INSERT INTO sessions (id, user_id, channel_id, metadata, updated_at)
        VALUES (?, ?, ?, ?, unixepoch())
        ON CONFLICT(id) DO UPDATE SET updated_at = unixepoch()
      `),
      get: db.prepare('SELECT * FROM sessions WHERE id = ?'),
    };
  }

  /**
   * Resolve the canonical sessionId from a normalized message.
   * Single-user system: all adapters share one session.
   */
  resolveSessionId(_normalizedMessage) {
    return DEFAULT_SESSION_ID;
  }

  getOrCreate(sessionId, userId, channelId, userName = null) {
    if (this._sessions.has(sessionId)) {
      return this._sessions.get(sessionId);
    }

    // Persist to DB
    this._stmts.upsert.run(sessionId, userId, channelId, JSON.stringify({ userName }));

    const session = {
      id: sessionId,
      userId,
      channelId,
      userName,
      metadata: { userName },
      lastUserMessage: null,
    };

    this._sessions.set(sessionId, session);
    return session;
  }

  loadHistory(sessionId, limit = 50) {
    return this.memory.getHistory(sessionId, limit);
  }

  appendMessage(sessionId, role, content) {
    this.memory.append(sessionId, role, content);
  }

  appendMessages(sessionId, messages) {
    this.memory.appendMany(sessionId, messages);
  }
}
