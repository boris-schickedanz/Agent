const GUARDRAIL_PATTERNS = [
  /^system\s*:/gim,
  /\[INTERNAL\]/g,
  /\[SYSTEM\]/g,
];

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
    let sanitized = content;
    for (const pattern of GUARDRAIL_PATTERNS) {
      pattern.lastIndex = 0;
      sanitized = sanitized.replace(pattern, '');
    }
    return { safe: true, content: sanitized };
  }

  authorize(_userId, _channelId, _toolName) {
    return { allowed: true, role: 'admin' };
  }
}
