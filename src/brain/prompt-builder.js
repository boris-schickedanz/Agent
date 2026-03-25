import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

export class PromptBuilder {
  constructor(config, memorySearch) {
    this.config = config;
    this.memorySearch = memorySearch;
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

  async build(session, availableTools, skillInstructions = null) {
    const parts = [];

    // 1. Agent personality
    parts.push(this._loadSoul());

    // 2. Current context
    parts.push(`\n## Current Context`);
    parts.push(`- Date/Time: ${new Date().toISOString()}`);
    parts.push(`- Session: ${session.id}`);
    parts.push(`- User: ${session.userName || session.userId}`);
    parts.push(`- Channel: ${session.channelId}`);

    // 3. Relevant memories
    if (this.memorySearch && session.lastUserMessage) {
      try {
        const memories = this.memorySearch.search(session.lastUserMessage, 5);
        if (memories.length > 0) {
          parts.push(`\n## Relevant Memories`);
          for (const mem of memories) {
            parts.push(`- **${mem.key}**: ${mem.content.substring(0, 300)}`);
          }
        }
      } catch {
        // Memory search failure is non-fatal
      }
    }

    // 4. Available tools summary
    if (availableTools.length > 0) {
      parts.push(`\n## Available Tools`);
      parts.push(`You have the following tools available. You MUST use them when appropriate instead of saying you cannot do something:\n`);
      for (const tool of availableTools) {
        parts.push(`- **${tool.name}**: ${tool.description}`);
      }
    }

    // 5. Skill instructions
    if (skillInstructions) {
      parts.push(`\n## Active Skill Instructions`);
      parts.push(skillInstructions);
    }

    return parts.join('\n');
  }
}
