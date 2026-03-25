const DEFAULT_PROFILES = {
  minimal: {
    allow: ['get_current_time'],
    deny: ['*'],
  },
  standard: {
    allow: [
      'get_current_time', 'search_memory', 'list_memories',
      'http_get', 'save_memory', 'wait',
    ],
    deny: ['http_post'],
  },
  full: {
    allow: ['*'],
    deny: [],
  },
};

const ROLE_PROFILE_MAP = {
  admin: 'full',
  user: 'standard',
  pending: 'minimal',
  blocked: null,
};

export class ToolPolicy {
  constructor(db, config) {
    this.db = db;
    this.config = config;
    this.profiles = { ...DEFAULT_PROFILES };
    this.roleMap = { ...ROLE_PROFILE_MAP };
  }

  /**
   * Check if a specific tool is allowed for a given user.
   */
  isAllowed(toolName, userId, session) {
    const role = this._getUserRole(userId, session?.channelId);
    const profileName = this.roleMap[role];

    if (!profileName) return false; // blocked users

    const profile = this.profiles[profileName];
    if (!profile) return false;

    // Deny rules are evaluated first
    for (const pattern of profile.deny) {
      if (this._matchPattern(pattern, toolName)) {
        // Check if explicitly allowed (allow overrides deny for specific tools)
        const explicitlyAllowed = profile.allow.includes(toolName);
        if (!explicitlyAllowed) return false;
      }
    }

    // Check allow rules
    for (const pattern of profile.allow) {
      if (this._matchPattern(pattern, toolName)) return true;
    }

    return false;
  }

  /**
   * Get the list of all tool names this user is allowed to use.
   */
  getEffectiveToolNames(userId, session) {
    const role = this._getUserRole(userId, session?.channelId);
    const profileName = this.roleMap[role];
    if (!profileName) return [];

    const profile = this.profiles[profileName];
    if (!profile) return [];

    // If allow includes '*', return null (meaning all tools)
    if (profile.allow.includes('*')) return null;

    return [...profile.allow];
  }

  _getUserRole(userId, channelId) {
    try {
      const row = this.db.prepare(
        'SELECT role FROM users WHERE id = ?'
      ).get(userId);

      if (row) return row.role;

      // Auto-approve or set as pending
      const role = this.config.autoApproveUsers ? 'user' : 'pending';
      this.db.prepare(
        'INSERT OR IGNORE INTO users (id, channel_id, role) VALUES (?, ?, ?)'
      ).run(userId, channelId || 'unknown', role);

      return role;
    } catch {
      return this.config.autoApproveUsers ? 'user' : 'pending';
    }
  }

  _matchPattern(pattern, toolName) {
    if (pattern === '*') return true;
    if (pattern.includes('*')) {
      const prefix = pattern.replace('*', '');
      return toolName.startsWith(prefix);
    }
    return pattern === toolName;
  }
}
