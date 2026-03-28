/**
 * Reads well-known persistent memory keys at request-build time
 * and returns a formatted string for system prompt injection.
 *
 * Well-known keys:
 *   - project_state: Living project document (objectives, tasks, decisions)
 *   - decision_journal: Append-only decision log
 *   - session_log: Brief per-session summaries
 *
 * When a ProjectManager is provided, state is loaded from the active
 * project's namespaced memory. Otherwise falls back to global memory.
 */

const CACHE_TTL_MS = 60_000; // 1 minute
const MAX_CACHE_ENTRIES = 50;
const NO_OP_LOGGER = { info() {}, warn() {}, error() {} };

export class StateBootstrap {
  constructor({ persistentMemory, config, logger, projectManager = null }) {
    this.persistentMemory = persistentMemory;
    this.config = config;
    this.logger = logger || NO_OP_LOGGER;
    this.projectManager = projectManager;
    this._cache = new Map(); // key -> { value, timestamp }

    // Invalidate cache when the active project changes
    if (projectManager) {
      projectManager.onSwitch(() => this._cache.clear());
    }
  }

  /**
   * Load well-known state keys and return a prompt-injectable overview.
   * Returns null if disabled. Returns a hint if no state exists.
   * Results are cached for 60s per project to avoid repeated disk reads.
   */
  async scan() {
    if (!this.config.workspaceStateEnabled) return null;

    const activeSlug = this.projectManager ? this.projectManager.getActive() : null;
    const cacheKey = activeSlug || '__global__';

    const now = Date.now();
    const cached = this._cache.get(cacheKey);
    if (cached && (now - cached.timestamp) < CACHE_TTL_MS) {
      return cached.value;
    }

    let result;
    if (this.projectManager && !activeSlug) {
      result = '[No active project. Use /project <name> to activate one, or tell me what you\'re working on and I\'ll set one up.]';
    } else {
      const memory = activeSlug
        ? this.projectManager.getActiveMemory()
        : this.persistentMemory;
      result = await this._buildState(memory, activeSlug);
    }

    // Evict oldest entry if cache is full
    if (this._cache.size >= MAX_CACHE_ENTRIES && !this._cache.has(cacheKey)) {
      let oldestKey = null;
      let oldestTime = Infinity;
      for (const [k, entry] of this._cache) {
        if (entry.timestamp < oldestTime) { oldestTime = entry.timestamp; oldestKey = k; }
      }
      if (oldestKey) this._cache.delete(oldestKey);
    }

    this._cache.set(cacheKey, { value: result, timestamp: now });
    return result;
  }

  async _buildState(memory, projectSlug = null) {
    let projectState;
    try {
      projectState = await memory.load('project_state');
    } catch {
      return null;
    }

    if (!projectState) {
      if (projectSlug) {
        return `[Project "${projectSlug}" has no state yet. Use save_memory with key "project_state" to initialize it.]`;
      }
      return '[Workspace state not initialized. When working on a project, use save_memory with key "project_state" to track objectives, tasks, and decisions.]';
    }

    const header = projectSlug
      ? `## Workspace State (Project: ${projectSlug})`
      : '## Workspace State';
    const parts = [header];
    parts.push(projectState.substring(0, 2000));

    await this._appendLastSection(parts, memory, 'session_log', '### Last Session');
    await this._appendLastSection(parts, memory, 'decision_journal', '### Latest Decision');

    const maxChars = this.config.workspaceStateMaxChars || 3000;
    return parts.join('\n').substring(0, maxChars);
  }

  async _appendLastSection(parts, memory, key, heading) {
    try {
      const content = await memory.load(key);
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
