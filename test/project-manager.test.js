import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { ProjectManager } from '../src/memory/project-manager.js';

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'pm-test-'));
  mkdirSync(join(dataDir, 'memory'), { recursive: true });
  const db = new Database(':memory:');
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(key, content, metadata)`);
  const pm = new ProjectManager(dataDir, db);
  return { dataDir, db, pm };
}

describe('ProjectManager', () => {
  describe('getActive()', () => {
    it('returns null when no project is active', () => {
      const { pm } = setup();
      assert.equal(pm.getActive(), null);
    });

    it('returns the active project slug after setActive', () => {
      const { pm } = setup();
      pm.setActive('panama-trip');
      assert.equal(pm.getActive(), 'panama-trip');
    });
  });

  describe('setActive()', () => {
    it('writes slug to _active_project.md', () => {
      const { dataDir, pm } = setup();
      pm.setActive('my-project');
      const content = readFileSync(join(dataDir, 'memory', '_active_project.md'), 'utf-8');
      assert.equal(content, 'my-project');
    });

    it('creates the project directory', () => {
      const { dataDir, pm } = setup();
      pm.setActive('new-proj');
      assert.ok(existsSync(join(dataDir, 'memory', 'projects', 'new-proj')));
    });

    it('overwrites previous active project', () => {
      const { pm } = setup();
      pm.setActive('project-a');
      pm.setActive('project-b');
      assert.equal(pm.getActive(), 'project-b');
    });
  });

  describe('deactivate()', () => {
    it('removes the active project', () => {
      const { pm } = setup();
      pm.setActive('some-project');
      pm.deactivate();
      assert.equal(pm.getActive(), null);
    });

    it('is safe to call when no project is active', () => {
      const { pm } = setup();
      pm.deactivate();
      assert.equal(pm.getActive(), null);
    });
  });

  describe('list()', () => {
    it('returns empty array when no projects exist', () => {
      const { pm } = setup();
      assert.deepEqual(pm.list(), []);
    });

    it('returns project slugs after creating projects', () => {
      const { pm } = setup();
      // Creating memory instances triggers directory creation
      pm.getMemory('alpha');
      pm.getMemory('beta');
      const projects = pm.list();
      assert.ok(projects.includes('alpha'));
      assert.ok(projects.includes('beta'));
    });
  });

  describe('getMemory()', () => {
    it('returns a PersistentMemory instance scoped to the project', async () => {
      const { pm } = setup();
      const mem = pm.getMemory('test-proj');
      await mem.save('project_state', '# Test Project');
      const loaded = await mem.load('project_state');
      assert.equal(loaded, '# Test Project');
    });

    it('isolates memory between projects', async () => {
      const { pm } = setup();
      const memA = pm.getMemory('proj-a');
      const memB = pm.getMemory('proj-b');

      await memA.save('project_state', '# Project A');
      await memB.save('project_state', '# Project B');

      assert.equal(await memA.load('project_state'), '# Project A');
      assert.equal(await memB.load('project_state'), '# Project B');
    });
  });

  describe('getActiveMemory()', () => {
    it('returns null when no project is active', () => {
      const { pm } = setup();
      assert.equal(pm.getActiveMemory(), null);
    });

    it('returns memory for the active project', async () => {
      const { pm } = setup();
      pm.setActive('active-proj');
      const mem = pm.getActiveMemory();
      assert.ok(mem);
      await mem.save('project_state', '# Active');
      assert.equal(await mem.load('project_state'), '# Active');
    });
  });

  describe('slugify()', () => {
    it('lowercases and replaces spaces with hyphens', () => {
      const { pm } = setup();
      assert.equal(pm.slugify('Panama Trip'), 'panama-trip');
    });

    it('removes special characters', () => {
      const { pm } = setup();
      assert.equal(pm.slugify('Coding: AgentCore!'), 'coding-agentcore');
    });

    it('collapses consecutive hyphens', () => {
      const { pm } = setup();
      assert.equal(pm.slugify('foo---bar'), 'foo-bar');
    });

    it('strips leading and trailing hyphens', () => {
      const { pm } = setup();
      assert.equal(pm.slugify('  My Project  '), 'my-project');
    });

    it('truncates to 50 characters', () => {
      const { pm } = setup();
      const long = 'a'.repeat(60);
      assert.ok(pm.slugify(long).length <= 50);
    });
  });
});
