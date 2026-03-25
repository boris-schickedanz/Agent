import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import { Sandbox } from '../src/security/sandbox.js';
import { registerFsTools } from '../src/tools/built-in/fs-tools.js';

const TEST_DIR = resolve('.test-fs-tools-' + process.pid);
const WORKSPACE = join(TEST_DIR, 'workspace');

describe('FS Tools', () => {
  let registry, sandbox;

  beforeEach(() => {
    mkdirSync(join(WORKSPACE, 'src'), { recursive: true });
    writeFileSync(join(WORKSPACE, 'hello.txt'), 'line1\nline2\nline3\nline4\nline5');
    writeFileSync(join(WORKSPACE, 'src', 'index.js'), 'const x = 1;\nconst y = 2;\nexport { x, y };');

    sandbox = new Sandbox({ workspaceDir: WORKSPACE });
    registry = new ToolRegistry();
    registerFsTools(registry, sandbox);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('read_file', () => {
    it('reads file with line numbers', async () => {
      const tool = registry.get('read_file');
      const result = await tool.handler({ path: 'hello.txt' });
      assert.ok(result.includes('1 | line1'));
      assert.ok(result.includes('5 | line5'));
    });

    it('respects offset and limit', async () => {
      const tool = registry.get('read_file');
      const result = await tool.handler({ path: 'hello.txt', offset: 1, limit: 2 });
      assert.ok(result.includes('Lines 2-3 of 5'));
      assert.ok(result.includes('line2'));
      assert.ok(result.includes('line3'));
      assert.ok(!result.includes('line1'));
    });

    it('detects binary files', async () => {
      writeFileSync(join(WORKSPACE, 'binary.bin'), Buffer.from([0, 1, 2, 0, 3]));
      const tool = registry.get('read_file');
      const result = await tool.handler({ path: 'binary.bin' });
      assert.ok(result.startsWith('Binary file:'));
    });

    it('rejects paths outside workspace', async () => {
      const tool = registry.get('read_file');
      await assert.rejects(
        () => tool.handler({ path: '../../etc/passwd' }),
        { name: 'SandboxViolationError' }
      );
    });
  });

  describe('write_file', () => {
    it('creates a new file', async () => {
      const tool = registry.get('write_file');
      const result = await tool.handler({ path: 'new.txt', content: 'hello world' });
      assert.ok(result.includes('Written'));
      assert.ok(result.includes('new.txt'));
    });

    it('creates parent directories', async () => {
      const tool = registry.get('write_file');
      const result = await tool.handler({ path: 'deep/nested/file.txt', content: 'deep' });
      assert.ok(result.includes('Written'));
    });
  });

  describe('edit_file', () => {
    it('replaces unique text', async () => {
      const tool = registry.get('edit_file');
      const result = await tool.handler({ path: 'src/index.js', old_text: 'const x = 1;', new_text: 'const x = 42;' });
      assert.ok(result.includes('Edited'));

      // Verify the change
      const readTool = registry.get('read_file');
      const content = await readTool.handler({ path: 'src/index.js' });
      assert.ok(content.includes('const x = 42;'));
    });

    it('errors on non-unique match', async () => {
      writeFileSync(join(WORKSPACE, 'dup.txt'), 'foo\nfoo\nbar');
      const tool = registry.get('edit_file');
      await assert.rejects(
        () => tool.handler({ path: 'dup.txt', old_text: 'foo', new_text: 'baz' }),
        /matches 2 locations/
      );
    });

    it('errors when text not found', async () => {
      const tool = registry.get('edit_file');
      await assert.rejects(
        () => tool.handler({ path: 'hello.txt', old_text: 'nonexistent', new_text: 'replacement' }),
        /not found/
      );
    });
  });

  describe('list_directory', () => {
    it('lists workspace root', async () => {
      const tool = registry.get('list_directory');
      const result = await tool.handler({});
      assert.ok(result.includes('[F] hello.txt'));
      assert.ok(result.includes('[D] src'));
    });

    it('lists recursively', async () => {
      const tool = registry.get('list_directory');
      const result = await tool.handler({ recursive: true });
      assert.ok(result.includes('index.js'));
    });
  });

  describe('file_search', () => {
    it('finds files by pattern', async () => {
      const tool = registry.get('file_search');
      const result = await tool.handler({ pattern: '**/*.js' });
      assert.ok(result.includes('index.js'));
    });

    it('returns no results message', async () => {
      const tool = registry.get('file_search');
      const result = await tool.handler({ pattern: '**/*.xyz' });
      assert.ok(result.includes('No files found'));
    });
  });

  describe('grep_search', () => {
    it('finds content matches', async () => {
      const tool = registry.get('grep_search');
      const result = await tool.handler({ pattern: 'const' });
      assert.ok(result.includes('index.js'));
      assert.ok(result.includes('const'));
    });

    it('supports regex patterns', async () => {
      const tool = registry.get('grep_search');
      const result = await tool.handler({ pattern: '/export.*x/' });
      assert.ok(result.includes('index.js'));
    });

    it('returns no results message', async () => {
      const tool = registry.get('grep_search');
      const result = await tool.handler({ pattern: 'zzzznonexistent' });
      assert.ok(result.includes('No matches'));
    });
  });

  it('all fs tools have class brokered', () => {
    const toolNames = ['read_file', 'write_file', 'edit_file', 'list_directory', 'file_search', 'grep_search'];
    for (const name of toolNames) {
      assert.equal(registry.get(name).class, 'brokered', `${name} should be brokered`);
    }
  });
});
