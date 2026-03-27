import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

export class PromptBuilder {
  constructor(config) {
    this.config = config;
    this.soulPath = resolve('SOUL.md');
    this._soulCache = null;
  }

  _loadSoul() {
    if (this._soulCache) return this._soulCache;
    if (existsSync(this.soulPath)) {
      this._soulCache = readFileSync(this.soulPath, 'utf-8');
    } else {
      this._soulCache = `You are ${this.config.agentName}, a helpful autonomous agent.`;
    }
    return this._soulCache;
  }

  _humanizeChannel(channelId) {
    if (!channelId) return 'Unknown';
    const adapter = channelId.split(':')[0];
    return adapter.charAt(0).toUpperCase() + adapter.slice(1);
  }

  async build(session, availableTools, skillInstructions = null, memorySnippets = null) {
    const parts = [];

    // 1. Agent personality — use agent profile soul if present, otherwise SOUL.md
    const agentProfile = session.metadata?.agentProfile;
    if (agentProfile?.soul) {
      parts.push(agentProfile.soul);
    } else {
      parts.push(this._loadSoul());
    }

    // 2. Current context
    parts.push(`\n## Current Context`);
    parts.push(`- Date/Time: ${new Date().toISOString()}`);
    parts.push(`- User: ${session.userName || session.userId}`);
    parts.push(`- Channel: ${this._humanizeChannel(session.channelId)}`);
    if (agentProfile?.name) {
      parts.push(`- Agent Profile: ${agentProfile.name}`);
    }

    // 3. Relevant memories (use pre-fetched snippets from host; no duplicate search)
    const snippets = memorySnippets && memorySnippets.length > 0 ? memorySnippets : null;
    if (snippets) {
      parts.push(`\n## Relevant Memories`);
      for (const mem of snippets) {
        const savedAt = mem.metadata?.saved_at
          ? ` (saved ${mem.metadata.saved_at.substring(0, 10)})`
          : '';
        parts.push(`- **${mem.key}**${savedAt}: ${mem.content.substring(0, 300)}`);
      }
    }

    // 4. Skill instructions
    if (skillInstructions) {
      parts.push(`\n## Active Skill Instructions`);
      parts.push(skillInstructions);
    }

    return parts.join('\n');
  }
}
