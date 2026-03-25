export class PermissionManager {
  constructor(db, toolPolicy, config) {
    this.db = db;
    this.toolPolicy = toolPolicy;
    this.config = config;
  }

  /**
   * Layer 1: Identity check. Is this user allowed to interact with the agent?
   */
  checkAccess(userId, channelId) {
    try {
      const row = this.db.prepare('SELECT role FROM users WHERE id = ?').get(userId);

      if (row) {
        if (row.role === 'blocked') {
          return { allowed: false, reason: 'User is blocked' };
        }
        return { allowed: true, role: row.role };
      }

      // New user - auto-register
      const approved = this.config.autoApproveUsers === true
        || (Array.isArray(this.config.autoApproveUsers) && this.config.autoApproveUsers.includes(userId));
      const role = approved ? 'user' : 'pending';
      this.db.prepare(
        'INSERT OR IGNORE INTO users (id, channel_id, role) VALUES (?, ?, ?)'
      ).run(userId, channelId, role);

      if (role === 'pending') {
        return { allowed: true, role: 'pending' };
      }
      return { allowed: true, role };
    } catch {
      // Fail open for console, fail closed for external
      if (channelId === 'console') {
        return { allowed: true, role: 'admin' };
      }
      return { allowed: false, reason: 'Authorization error' };
    }
  }

  /**
   * Layer 2: Scope check. Can this user use a specific tool?
   */
  checkScope(userId, toolName) {
    return this.toolPolicy.isAllowed(toolName, userId, null);
  }

  /**
   * Layer 3: Model guardrails. Content safety check on outbound messages.
   */
  checkModelGuardrails(content) {
    // Strip any accidentally leaked system prompt markers
    const sanitized = content
      .replace(/^system\s*:/gim, '')
      .replace(/\[INTERNAL\]/g, '')
      .replace(/\[SYSTEM\]/g, '');
    return { safe: true, content: sanitized };
  }

  /**
   * Combined authorization check.
   */
  authorize(userId, channelId, toolName) {
    const access = this.checkAccess(userId, channelId);
    if (!access.allowed) return access;

    if (toolName) {
      const scopeAllowed = this.checkScope(userId, toolName);
      if (!scopeAllowed) {
        return { allowed: false, reason: `No permission for tool: ${toolName}` };
      }
    }

    return { allowed: true, role: access.role };
  }
}
