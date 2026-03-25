const MAX_FIELD_SIZE = 2048; // 2KB truncation limit

function truncate(value, maxLen = MAX_FIELD_SIZE) {
  if (value == null) return null;
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 15) + '... [truncated]';
}

export class AuditLogger {
  constructor({ db, logger }) {
    this.db = db;
    this.logger = logger || null;

    this._insertStmt = db.prepare(`
      INSERT INTO audit_log (event_type, tool_name, user_id, session_id, input, output, success, duration_ms, details)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this._queryStmt = db.prepare(`
      SELECT * FROM audit_log
      WHERE (@userId IS NULL OR user_id = @userId)
        AND (@sessionId IS NULL OR session_id = @sessionId)
        AND (@toolName IS NULL OR tool_name = @toolName)
        AND (@since IS NULL OR timestamp >= @since)
      ORDER BY timestamp DESC
      LIMIT @limit
    `);
  }

  logToolExecution({ toolName, input, output, success, userId, sessionId, durationMs }) {
    try {
      this._insertStmt.run(
        'tool_execution',
        toolName,
        userId || null,
        sessionId || null,
        truncate(input),
        truncate(output),
        success ? 1 : 0,
        durationMs || 0,
        null
      );
    } catch (err) {
      this.logger?.warn({ err: err.message }, 'Audit log write failed');
    }
  }

  logApproval({ toolName, input, userId, sessionId, approved, reason }) {
    try {
      this._insertStmt.run(
        'approval',
        toolName,
        userId || null,
        sessionId || null,
        truncate(input),
        null,
        approved ? 1 : 0,
        0,
        reason ? JSON.stringify({ reason }) : null
      );
    } catch (err) {
      this.logger?.warn({ err: err.message }, 'Audit log write failed');
    }
  }

  logSecurityEvent({ event, userId, sessionId, details }) {
    try {
      this._insertStmt.run(
        'security',
        null,
        userId || null,
        sessionId || null,
        null,
        null,
        null,
        0,
        truncate(details ? { event, ...details } : { event })
      );
    } catch (err) {
      this.logger?.warn({ err: err.message }, 'Audit log write failed');
    }
  }

  query({ userId, sessionId, toolName, since, limit = 50 } = {}) {
    try {
      return this._queryStmt.all({
        userId: userId || null,
        sessionId: sessionId || null,
        toolName: toolName || null,
        since: since || null,
        limit,
      });
    } catch (err) {
      this.logger?.warn({ err: err.message }, 'Audit log query failed');
      return [];
    }
  }
}
