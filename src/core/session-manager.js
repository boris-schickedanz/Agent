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
      getAlias: db.prepare(
        'SELECT canonical_id FROM user_aliases WHERE adapter_user_id = ? AND channel_id = ?'
      ),
    };
  }

  /**
   * Resolve an adapter-specific userId to a canonical userId.
   * Checks user_aliases table; falls back to channelId:adapterUserId.
   */
  resolveCanonicalUserId(adapterUserId, channelId) {
    const row = this._stmts.getAlias.get(adapterUserId, channelId);
    return row ? row.canonical_id : `${channelId}:${adapterUserId}`;
  }

  /**
   * Resolve the canonical sessionId from a normalized message.
   * - Group messages (adapter sessionId contains ":group:"): group:telegram:{chatId}
   * - Individual messages: user:{canonicalUserId}
   */
  resolveSessionId(normalizedMessage) {
    const { sessionId, userId, channelId } = normalizedMessage;

    // Group chats stay isolated to their channel
    if (sessionId && sessionId.includes(':group:')) {
      // Extract the group portion: "telegram:group:12345" -> "group:telegram:12345"
      const parts = sessionId.split(':group:');
      return `group:${parts[0]}:${parts[1]}`;
    }

    // Individual chats use canonical userId for cross-adapter continuity
    const canonicalId = this.resolveCanonicalUserId(userId, channelId);
    return `user:${canonicalId}`;
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
