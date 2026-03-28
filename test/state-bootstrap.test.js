import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StateBootstrap } from '../src/memory/state-bootstrap.js';

function makePersistentMemory(store = {}) {
  return {
    async load(key) { return store[key] || null; },
    async save(key, content) { store[key] = content; },
  };
}

function makeBootstrap(store = {}, configOverrides = {}) {
  return new StateBootstrap({
    persistentMemory: makePersistentMemory(store),
    config: {
      workspaceStateEnabled: true,
      workspaceStateMaxChars: 3000,
      ...configOverrides,
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
}

describe('StateBootstrap', () => {
  describe('scan()', () => {
    it('returns null when disabled', async () => {
      const bs = makeBootstrap({ project_state: '# Project' }, { workspaceStateEnabled: false });
      const result = await bs.scan();
      assert.equal(result, null);
    });

    it('returns bootstrapping hint when no state exists', async () => {
      const bs = makeBootstrap({});
      const result = await bs.scan();
      assert.ok(result.includes('not initialized'));
      assert.ok(result.includes('project_state'));
    });

    it('returns project_state when it exists', async () => {
      const bs = makeBootstrap({
        project_state: '# Project State\n\n## Current Objective\nBuild the widget',
      });
      const result = await bs.scan();
      assert.ok(result.includes('## Workspace State'));
      assert.ok(result.includes('Build the widget'));
    });

    it('includes last session_log entry', async () => {
      const bs = makeBootstrap({
        project_state: '# Project State\nSome content',
        session_log: '## Session 2026-03-27\nOld session\n\n## Session 2026-03-28\nLatest session work',
      });
      const result = await bs.scan();
      assert.ok(result.includes('### Last Session'));
      assert.ok(result.includes('Latest session work'));
      // Should NOT include the old session in the last section
      assert.ok(!result.includes('Old session'));
    });

    it('includes last decision_journal entry', async () => {
      const bs = makeBootstrap({
        project_state: '# Project State\nSome content',
        decision_journal: '## [2026-03-27] Old decision\nDetails\n\n## [2026-03-28] Latest decision\nChose X over Y',
      });
      const result = await bs.scan();
      assert.ok(result.includes('### Latest Decision'));
      assert.ok(result.includes('Chose X over Y'));
      assert.ok(!result.includes('Old decision'));
    });

    it('truncates project_state to 2000 chars', async () => {
      const longContent = '# Project State\n' + 'x'.repeat(3000);
      const bs = makeBootstrap({ project_state: longContent });
      const result = await bs.scan();
      // The project_state portion should be truncated
      assert.ok(result.length <= 3000);
    });

    it('respects workspaceStateMaxChars config', async () => {
      const bs = makeBootstrap({
        project_state: '# Project State\n' + 'x'.repeat(2000),
        session_log: '## Session\n' + 'y'.repeat(1000),
        decision_journal: '## Decision\n' + 'z'.repeat(1000),
      }, { workspaceStateMaxChars: 500 });
      const result = await bs.scan();
      assert.ok(result.length <= 500);
    });

    it('handles missing session_log and decision_journal gracefully', async () => {
      const bs = makeBootstrap({
        project_state: '# Project State\nJust this',
      });
      const result = await bs.scan();
      assert.ok(result.includes('## Workspace State'));
      assert.ok(result.includes('Just this'));
      assert.ok(!result.includes('### Last Session'));
      assert.ok(!result.includes('### Latest Decision'));
    });

    it('handles load errors gracefully', async () => {
      const brokenMemory = {
        async load(key) {
          if (key === 'session_log') throw new Error('disk error');
          if (key === 'project_state') return '# Project\nContent here';
          return null;
        },
      };
      const bs = new StateBootstrap({
        persistentMemory: brokenMemory,
        config: { workspaceStateEnabled: true, workspaceStateMaxChars: 3000 },
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      });
      const result = await bs.scan();
      assert.ok(result.includes('Content here'));
    });

    it('caches results for subsequent calls', async () => {
      let loadCount = 0;
      const memory = {
        async load(key) {
          loadCount++;
          return key === 'project_state' ? '# State' : null;
        },
      };
      const bs = new StateBootstrap({
        persistentMemory: memory,
        config: { workspaceStateEnabled: true, workspaceStateMaxChars: 3000 },
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      });

      const r1 = await bs.scan();
      const r2 = await bs.scan();
      assert.equal(r1, r2);
      // Only 1 load for project_state (session_log and decision_journal also attempted = 3 total)
      // Second scan() should hit cache, so still 3
      assert.equal(loadCount, 3);
    });
  });

  describe('_lastSection()', () => {
    it('extracts last ## section', () => {
      const bs = makeBootstrap();
      const content = '## First\nAAA\n\n## Second\nBBB\n\n## Third\nCCC';
      const result = bs._lastSection(content, 500);
      assert.ok(result.includes('## Third'));
      assert.ok(result.includes('CCC'));
      assert.ok(!result.includes('## Second'));
    });

    it('returns full content when no ## headers', () => {
      const bs = makeBootstrap();
      const result = bs._lastSection('Just plain text', 500);
      assert.equal(result, 'Just plain text');
    });

    it('truncates to maxChars', () => {
      const bs = makeBootstrap();
      const content = '## Section\n' + 'x'.repeat(1000);
      const result = bs._lastSection(content, 100);
      assert.equal(result.length, 100);
    });

    it('returns null for empty content', () => {
      const bs = makeBootstrap();
      assert.equal(bs._lastSection('', 500), null);
    });

    it('returns null for null content', () => {
      const bs = makeBootstrap();
      assert.equal(bs._lastSection(null, 500), null);
    });
  });
});
