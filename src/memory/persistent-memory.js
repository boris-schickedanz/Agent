import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

export class PersistentMemory {
  constructor(dataDir, db, namespace = null) {
    const subDir = namespace ? join('memory', namespace) : 'memory';
    this.memoryDir = join(dataDir, subDir);
    this.db = db;
    this.namespace = namespace || '';
    mkdirSync(this.memoryDir, { recursive: true });
  }

  async save(key, content, metadata = {}) {
    const safeName = key.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filePath = join(this.memoryDir, `${safeName}.md`);
    writeFileSync(filePath, content, 'utf-8');

    const nsKey = this.namespace ? `${this.namespace}:${safeName}` : safeName;
    const enrichedMetadata = { ...metadata, saved_at: new Date().toISOString() };

    // Update FTS index
    try {
      this.db.prepare('DELETE FROM memory_fts WHERE key = ?').run(nsKey);
      this.db.prepare(
        'INSERT INTO memory_fts (key, content, metadata) VALUES (?, ?, ?)'
      ).run(nsKey, content, JSON.stringify(enrichedMetadata));
    } catch {
      // FTS update failure is non-fatal
    }
  }

  async load(key) {
    const safeName = key.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filePath = join(this.memoryDir, `${safeName}.md`);
    if (!existsSync(filePath)) return null;
    return readFileSync(filePath, 'utf-8');
  }

  async list() {
    if (!existsSync(this.memoryDir)) return [];
    return readdirSync(this.memoryDir)
      .filter(f => f.endsWith('.md'))
      .map(f => f.replace(/\.md$/, ''));
  }

  async delete(key) {
    const safeName = key.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filePath = join(this.memoryDir, `${safeName}.md`);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
    const nsKey = this.namespace ? `${this.namespace}:${safeName}` : safeName;
    try {
      this.db.prepare('DELETE FROM memory_fts WHERE key = ?').run(nsKey);
    } catch {
      // Non-fatal
    }
  }
}
