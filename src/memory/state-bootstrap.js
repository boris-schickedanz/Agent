/**
 * Reads well-known persistent memory keys at request-build time
 * and returns a formatted string for system prompt injection.
 *
 * Well-known keys:
 *   - project_state: Living project document (objectives, tasks, decisions)
 *   - decision_journal: Append-only decision log
 *   - session_log: Brief per-session summaries
 */
export class StateBootstrap {
  constructor({ persistentMemory, config, logger }) {
    this.persistentMemory = persistentMemory;
    this.config = config;
    this.logger = logger;
  }

  /**
   * Load well-known state keys and return a prompt-injectable overview.
   * Returns null if disabled. Returns a bootstrapping hint if no state exists.
   * Reads at most 3 small files, truncates aggressively.
   */
  async scan() {
    if (!this.config.workspaceStateEnabled) return null;

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

    // Session log — last entry only
    try {
      const sessionLog = await this.persistentMemory.load('session_log');
      if (sessionLog) {
        const lastEntry = this._lastSection(sessionLog, 500);
        if (lastEntry) {
          parts.push('\n### Last Session');
          parts.push(lastEntry);
        }
      }
    } catch { /* non-critical */ }

    // Decision journal — last entry only
    try {
      const decisions = await this.persistentMemory.load('decision_journal');
      if (decisions) {
        const lastDecision = this._lastSection(decisions, 500);
        if (lastDecision) {
          parts.push('\n### Latest Decision');
          parts.push(lastDecision);
        }
      }
    } catch { /* non-critical */ }

    const maxChars = this.config.workspaceStateMaxChars || 3000;
    return parts.join('\n').substring(0, maxChars);
  }

  /**
   * Extract the last "## " section from markdown content.
   * Returns the text from the last ## heading to end-of-string, truncated.
   */
  _lastSection(content, maxChars) {
    if (!content) return null;
    const sections = content.split(/(?=^## )/m);
    const last = sections[sections.length - 1];
    return last ? last.substring(0, maxChars) : null;
  }
}
