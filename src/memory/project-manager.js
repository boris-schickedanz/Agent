import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync, mkdirSync, statSync } from 'fs';
import { join } from 'path';
import { PersistentMemory } from './persistent-memory.js';

const MAX_SLUG_LENGTH = 50;

export class ProjectManager {
  constructor(dataDir, db) {
    this.dataDir = dataDir;
    this.db = db;
    this.memoryDir = join(dataDir, 'memory');
    this.projectsDir = join(this.memoryDir, 'projects');
    this._activeFile = join(this.memoryDir, '_active_project.md');
  }

  /** Returns the active project slug, or null if none. */
  getActive() {
    if (!existsSync(this._activeFile)) return null;
    const slug = readFileSync(this._activeFile, 'utf-8').trim();
    return slug || null;
  }

  /** Sets the active project. Creates the project directory if needed. */
  setActive(slug) {
    mkdirSync(join(this.projectsDir, slug), { recursive: true });
    writeFileSync(this._activeFile, slug, 'utf-8');
  }

  /** Deactivates the current project. */
  deactivate() {
    if (existsSync(this._activeFile)) {
      unlinkSync(this._activeFile);
    }
  }

  /** Lists all project slugs. */
  list() {
    if (!existsSync(this.projectsDir)) return [];
    return readdirSync(this.projectsDir)
      .filter(f => {
        try {
          return statSync(join(this.projectsDir, f)).isDirectory();
        } catch { return false; }
      })
      .sort();
  }

  /** Returns a PersistentMemory instance scoped to a project. */
  getMemory(slug) {
    return new PersistentMemory(this.dataDir, this.db, `projects/${slug}`);
  }

  /** Returns PersistentMemory for the active project, or null. */
  getActiveMemory() {
    const slug = this.getActive();
    if (!slug) return null;
    return this.getMemory(slug);
  }

  /** Convert a project name to a URL-safe slug. */
  slugify(name) {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/[\s]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, MAX_SLUG_LENGTH);
  }
}
