const TOOL_APPROVAL_DEFAULTS = {
  run_command: 'always',
  run_command_background: 'always',
  kill_process: 'once-per-session',
  write_file: 'once-per-session',
  edit_file: 'once-per-session',
};

export class ApprovalManager {
  constructor({ db, eventBus, auditLogger, logger }) {
    this.db = db;
    this.eventBus = eventBus;
    this.auditLogger = auditLogger || null;
    this.logger = logger || null;

    // Session-scoped approval cache: Map<sessionId, Set<toolName>>
    this._sessionCache = new Map();
    // Pending approvals: Map<sessionId, PendingApproval>
    this._pending = new Map();
  }

  /**
   * Check if a tool invocation needs user approval.
   */
  needsApproval(toolName, userId, sessionId) {
    // Admin users bypass approval
    const role = this._getUserRole(userId);
    if (role === 'admin') return false;

    const mode = TOOL_APPROVAL_DEFAULTS[toolName];
    if (!mode || mode === 'never') return false;

    // Check session cache for once-per-session tools
    if (mode === 'once-per-session') {
      const cached = this._sessionCache.get(sessionId);
      if (cached && cached.has(toolName)) return false;
    }

    // Check if already approved in cache (for 'always' tools that got session grant)
    const cached = this._sessionCache.get(sessionId);
    if (cached && cached.has(toolName)) return false;

    return true;
  }

  /**
   * Grant session-level approval for a tool.
   */
  grantSession(toolName, sessionId) {
    if (!this._sessionCache.has(sessionId)) {
      this._sessionCache.set(sessionId, new Set());
    }
    this._sessionCache.get(sessionId).add(toolName);
  }

  /**
   * Revoke session-level approval for a tool.
   */
  revokeSession(toolName, sessionId) {
    const cached = this._sessionCache.get(sessionId);
    if (cached) cached.delete(toolName);
  }

  /**
   * Get pending approval for a session.
   */
  getPending(sessionId) {
    return this._pending.get(sessionId) || null;
  }

  /**
   * Resolve a pending approval request.
   */
  resolve(sessionId, approved, reason) {
    const pending = this._pending.get(sessionId);
    if (!pending) return;

    this._pending.delete(sessionId);

    if (approved) {
      // Grant session-level approval based on tool's mode
      const mode = TOOL_APPROVAL_DEFAULTS[pending.toolName];
      if (mode === 'once-per-session' || mode === 'always') {
        this.grantSession(pending.toolName, sessionId);
      }
    }

    this.auditLogger?.logApproval({
      toolName: pending.toolName,
      input: pending.input,
      userId: pending.userId,
      sessionId,
      approved,
      reason: reason || null,
    });
  }

  /**
   * Store a pending approval request.
   */
  setPending(sessionId, { toolName, input, userId }) {
    this._pending.set(sessionId, { toolName, input, userId, createdAt: Date.now() });
  }

  /**
   * Clear session cache (e.g., on /new).
   */
  clearSession(sessionId) {
    this._sessionCache.delete(sessionId);
    this._pending.delete(sessionId);
  }

  _getUserRole(userId) {
    try {
      const row = this.db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
      return row?.role || 'pending';
    } catch {
      return 'pending';
    }
  }
}
