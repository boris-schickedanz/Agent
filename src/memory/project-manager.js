import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync, mkdirSync, statSync } from 'fs';
import { join } from 'path';
import { PersistentMemory } from './persistent-memory.js';

const MAX_SLUG_LENGTH = 50;
const SAFE_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

export class ProjectManager {
  constructor(dataDir, db) {
    this.dataDir = dataDir;
    this.db = db;
    this.memoryDir = join(dataDir, 'memory');
    this.projectsDir = join(this.memoryDir, 'projects');
    this._activeFile = join(this.memoryDir, '_active_project.md');
    this._activeSlug = undefined; // undefined = not loaded, null = no active project
    this._memoryCache = new Map(); // slug -> PersistentMemory
    this._onSwitchCallbacks = [];
  }

  /** Register a callback to be invoked when the active project changes. */
  onSwitch(cb) {
    this._onSwitchCallbacks.push(cb);
  }

  /** Returns the active project slug, or null if none. */
  getActive() {
    if (this._activeSlug !== undefined) return this._activeSlug;
    this._activeSlug = this._readActiveFromDisk();
    return this._activeSlug;
  }

  /** Sets the active project. Creates the project directory if needed. */
  setActive(slug) {
    if (!SAFE_SLUG_RE.test(slug)) {
      throw new Error(`Invalid project slug: "${slug}"`);
    }
    mkdirSync(join(this.projectsDir, slug), { recursive: true });
    writeFileSync(this._activeFile, slug, 'utf-8');
    this._activeSlug = slug;
    this._notifySwitch(slug);
  }

  /** Deactivates the current project. */
  deactivate() {
    if (existsSync(this._activeFile)) {
      unlinkSync(this._activeFile);
    }
    this._activeSlug = null;
    this._notifySwitch(null);
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

  /** Returns a PersistentMemory instance scoped to a project (cached). */
  getMemory(slug) {
    let mem = this._memoryCache.get(slug);
    if (!mem) {
      mem = new PersistentMemory(this.dataDir, this.db, `projects/${slug}`);
      this._memoryCache.set(slug, mem);
    }
    return mem;
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

  _readActiveFromDisk() {
    if (!existsSync(this._activeFile)) return null;
    const slug = readFileSync(this._activeFile, 'utf-8').trim();
    return slug || null;
  }

  _notifySwitch(slug) {
    for (const cb of this._onSwitchCallbacks) {
      try { cb(slug); } catch { /* non-critical */ }
    }
  }
}
