import Database from 'better-sqlite3';
import { mkdirSync, existsSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

let instance = null;

export class DB {
  constructor(dbPath) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
  }

  static getInstance(dbPath) {
    if (!instance) {
      instance = new DB(dbPath);
    }
    return instance;
  }

  prepare(sql) {
    return this.db.prepare(sql);
  }

  exec(sql) {
    return this.db.exec(sql);
  }

  transaction(fn) {
    return this.db.transaction(fn);
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER DEFAULT (unixepoch())
      )
    `);

    const applied = new Set(
      this.db.prepare('SELECT name FROM migrations').all().map(r => r.name)
    );

    const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
    if (!existsSync(migrationsDir)) return;

    const files = readdirSync(migrationsDir)
      .filter(f => f.endsWith('.js'))
      .sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const migration = await_import(join(migrationsDir, file));
      this.db.transaction(() => {
        migration.up(this);
        this.db.prepare('INSERT INTO migrations (name) VALUES (?)').run(file);
      })();
    }
  }

  close() {
    this.db.close();
    instance = null;
  }
}

// Helper to handle dynamic import synchronously via a workaround:
// We use require-like pattern since better-sqlite3 is sync anyway
function await_import(path) {
  // For migrations we use a sync pattern - migrations export { up(db) }
  // We'll load them via a dynamic import in the migrate method instead
  return null;
}

// Async version of migrate that properly handles ES module imports
DB.prototype.migrate = async function () {
  this.db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER DEFAULT (unixepoch())
    )
  `);

  const applied = new Set(
    this.db.prepare('SELECT name FROM migrations').all().map(r => r.name)
  );

  const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
  if (!existsSync(migrationsDir)) return;

  const files = readdirSync(migrationsDir)
    .filter(f => f.endsWith('.js'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const migrationPath = 'file:///' + join(migrationsDir, file).replace(/\\/g, '/');
    const migration = await import(migrationPath);
    this.db.transaction(() => {
      migration.up(this);
      this.db.prepare('INSERT INTO migrations (name) VALUES (?)').run(file);
    })();
  }
};
