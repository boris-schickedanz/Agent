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

  getSessionKey(userId, channelId) {
    return `${channelId}:${userId}`;
  }

  getOrCreate(userId, channelId, userName = null) {
    const id = this.getSessionKey(userId, channelId);

    if (this._sessions.has(id)) {
      return this._sessions.get(id);
    }

    // Persist to DB
    this._stmts.upsert.run(id, userId, channelId, JSON.stringify({ userName }));

    const session = {
      id,
      userId,
      channelId,
      userName,
      metadata: { userName },
      lastUserMessage: null,
    };

    this._sessions.set(id, session);
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
