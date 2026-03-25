import { existsSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { AgentProfile } from './agent-profile.js';

export class AgentRegistry {
  constructor({ agentsDir, logger }) {
    this.agentsDir = resolve(agentsDir || 'agents');
    this.logger = logger;
    this._profiles = new Map();
  }

  loadAll() {
    if (!existsSync(this.agentsDir)) return;

    const dirs = readdirSync(this.agentsDir, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const dir of dirs) {
      const agentFile = join(this.agentsDir, dir.name, 'AGENT.md');
      if (!existsSync(agentFile)) continue;

      try {
        const profile = AgentProfile.fromFile(agentFile);
        this._profiles.set(profile.name, profile);
        this.logger?.info?.({ name: profile.name }, 'Agent profile loaded');
      } catch (err) {
        this.logger?.warn?.({ name: dir.name, err: err.message }, 'Failed to load agent profile');
      }
    }
  }

  get(name) {
    return this._profiles.get(name) || null;
  }

  getDefault() {
    // The default agent uses SOUL.md — no profile object needed
    return null;
  }

  list() {
    return Array.from(this._profiles.values());
  }
}
