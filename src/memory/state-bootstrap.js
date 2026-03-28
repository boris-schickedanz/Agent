/**
 * Reads well-known persistent memory keys at request-build time
 * and returns a formatted string for system prompt injection.
 *
 * Well-known keys:
 *   - project_state: Living project document (objectives, tasks, decisions)
 *   - decision_journal: Append-only decision log
 *   - session_log: Brief per-session summaries
 */

const CACHE_TTL_MS = 60_000; // 1 minute

export class StateBootstrap {
  constructor({ persistentMemory, config, logger }) {
    this.persistentMemory = persistentMemory;
    this.config = config;
    this.logger = logger;
    this._cache = null;
    this._cacheTime = 0;
  }

  /**
   * Load well-known state keys and return a prompt-injectable overview.
   * Returns null if disabled. Returns a bootstrapping hint if no state exists.
   * Results are cached for 60s to avoid repeated disk reads on the hot path.
   */
  async scan() {
    if (!this.config.workspaceStateEnabled) return null;

    const now = Date.now();
    if (this._cache !== null && (now - this._cacheTime) < CACHE_TTL_MS) {
      return this._cache;
    }

    const result = await this._buildState();
    this._cache = result;
    this._cacheTime = now;
    return result;
  }

  async _buildState() {
    let projectState;
    try {
      projectState = await this.persistentMemory.load('project_state');
    } catch {
      return null;
    }

    if (!projectState) {
      return '[Workspace state not initialized. When working on a project, use save_memory with key "project_state" to track objectives, tasks, and decisions across sessions.]';
    }

    const parts = ['## Workspace State'];
    parts.push(projectState.substring(0, 2000));

    await this._appendLastSection(parts, 'session_log', '### Last Session');
    await this._appendLastSection(parts, 'decision_journal', '### Latest Decision');

    const maxChars = this.config.workspaceStateMaxChars || 3000;
    return parts.join('\n').substring(0, maxChars);
  }

  async _appendLastSection(parts, key, heading) {
    try {
      const content = await this.persistentMemory.load(key);
      if (content) {
        const section = this._lastSection(content, 500);
        if (section) {
          parts.push(`\n${heading}`);
          parts.push(section);
        }
      }
    } catch { /* non-critical */ }
  }

  _lastSection(content, maxChars) {
    if (!content) return null;
    const idx = content.lastIndexOf('\n## ');
    const section = idx >= 0 ? content.substring(idx + 1) : content;
    return section.substring(0, maxChars) || null;
  }
}
