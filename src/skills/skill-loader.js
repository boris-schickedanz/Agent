import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import matter from 'gray-matter';
import { validateSkill } from './skill-schema.js';

export class SkillLoader {
  constructor(toolRegistry, logger) {
    this.toolRegistry = toolRegistry;
    this.logger = logger;
    this._skills = new Map();
  }

  async loadAll(skillsDir) {
    if (!existsSync(skillsDir)) {
      this.logger.info('No skills directory found, skipping skill loading');
      return;
    }

    const skillFiles = this._findSkillFiles(skillsDir);
    for (const file of skillFiles) {
      try {
        await this.loadOne(file);
      } catch (err) {
        this.logger.error({ file, err: err.message }, 'Failed to load skill');
      }
    }

    this.logger.info({ count: this._skills.size }, 'Skills loaded');
  }

  async loadOne(filePath) {
    const raw = readFileSync(filePath, 'utf-8');
    const { data: frontmatter, content: body } = matter(raw);

    const validation = validateSkill(frontmatter);
    if (!validation.valid) {
      throw new Error(`Invalid skill frontmatter: ${validation.errors.join(', ')}`);
    }

    const skill = {
      ...validation.data,
      instructions: body.trim(),
      filePath,
    };

    this._skills.set(skill.name, skill);

    // Register a pseudo-tool so the agent can reference this skill
    if (skill.trigger) {
      this.toolRegistry.register({
        name: `skill_${skill.name}`,
        description: `Activate skill: ${skill.description}`,
        inputSchema: {
          type: 'object',
          properties: {
            input: {
              type: 'string',
              description: 'Input for the skill',
            },
          },
        },
        handler: async (toolInput) => {
          return `[Skill ${skill.name} activated]\n\nInstructions:\n${skill.instructions}\n\nUser input: ${toolInput.input || 'none'}`;
        },
        permissions: skill.permissions,
      });
    }

    return skill;
  }

  getLoadedSkills() {
    return Array.from(this._skills.values());
  }

  getSkill(name) {
    return this._skills.get(name) || null;
  }

  _findSkillFiles(dir) {
    const results = [];
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        const fullPath = join(dir, entry);
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          results.push(...this._findSkillFiles(fullPath));
        } else if (entry === 'SKILL.md') {
          results.push(fullPath);
        }
      }
    } catch {
      // Directory access error
    }
    return results;
  }
}
