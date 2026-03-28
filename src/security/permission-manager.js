/**
 * PermissionManager — Single-user model.
 * Identity and scope checks always allow. Model guardrails remain for content safety.
 */
export class PermissionManager {
  checkAccess(_userId, _channelId) {
    return { allowed: true, role: 'admin' };
  }

  checkScope(_userId, _toolName) {
    return true;
  }

  checkModelGuardrails(content) {
    const sanitized = content
      .replace(/^system\s*:/gim, '')
      .replace(/\[INTERNAL\]/g, '')
      .replace(/\[SYSTEM\]/g, '');
    return { safe: true, content: sanitized };
  }

  authorize(_userId, _channelId, _toolName) {
    return { allowed: true, role: 'admin' };
  }
}
