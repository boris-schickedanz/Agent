export const TOOLS_REQUIRING_APPROVAL = new Set([
  'run_command',
  'run_command_background',
  'kill_process',
  'write_file',
  'edit_file',
  'http_post',
  'delegate_task',
  'cancel_delegation',
]);

export class ApprovalManager {
  constructor({ db, eventBus, auditLogger, logger }) {
    this.db = db;
    this.eventBus = eventBus;
    this.auditLogger = auditLogger || null;
    this.logger = logger || null;

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

    return TOOLS_REQUIRING_APPROVAL.has(toolName);
  }

  /**
   * Role-agnostic check: is this tool in the approval-required set?
   */
  requiresApproval(toolName) {
    return TOOLS_REQUIRING_APPROVAL.has(toolName);
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
   * Clear pending approvals (e.g., on /new).
   */
  clearSession(sessionId) {
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
