import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'fs';
import { resolve, join } from 'path';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import { Sandbox } from '../src/security/sandbox.js';
import { ProcessManager } from '../src/process/process-manager.js';
import { registerShellTools } from '../src/tools/built-in/shell-tools.js';

const TEST_DIR = resolve('.test-shell-tools-' + process.pid);
const WORKSPACE = join(TEST_DIR, 'workspace');

describe('Shell Tools', () => {
  let registry, sandbox, pm;

  beforeEach(() => {
    mkdirSync(WORKSPACE, { recursive: true });
    sandbox = new Sandbox({ workspaceDir: WORKSPACE });
    pm = new ProcessManager({ sandbox, logger: null, maxProcesses: 5 });
    registry = new ToolRegistry();
    registerShellTools(registry, pm, sandbox);
  });

  afterEach(async () => {
    await pm.shutdownAll();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('run_command', () => {
    it('executes command and returns output', async () => {
      const tool = registry.get('run_command');
      const result = await tool.handler({ command: 'echo hello world' });
      assert.ok(result.includes('Exit code: 0'));
      assert.ok(result.includes('hello world'));
    });

    it('shows timeout message', async () => {
      const tool = registry.get('run_command');
      const result = await tool.handler({ command: 'sleep 5', timeout_seconds: 1 });
      assert.ok(result.includes('timed out'));
    });

    it('reports non-zero exit codes', async () => {
      const tool = registry.get('run_command');
      const result = await tool.handler({ command: 'exit 1' });
      assert.ok(result.includes('Exit code: 1'));
    });
  });

  describe('run_command_background', () => {
    it('starts a background process', async () => {
      const tool = registry.get('run_command_background');
      const result = await tool.handler({ command: 'sleep 5', label: 'test-bg' });
      assert.ok(result.includes('Started background process'));
      assert.ok(result.includes('test-bg'));
    });
  });

  describe('check_process', () => {
    it('shows process status', async () => {
      const bgTool = registry.get('run_command_background');
      const bgResult = await bgTool.handler({ command: 'sleep 5', label: 'checker' });
      const idMatch = bgResult.match(/ID: ([a-f0-9-]+)/);
      assert.ok(idMatch);

      const checkTool = registry.get('check_process');
      const status = await checkTool.handler({ process_id: idMatch[1] });
      assert.ok(status.includes('checker'));
      assert.ok(status.includes('running'));
    });

    it('handles unknown process ID', async () => {
      const tool = registry.get('check_process');
      const result = await tool.handler({ process_id: 'nonexistent' });
      assert.ok(result.includes('not found'));
    });
  });

  describe('kill_process', () => {
    it('kills a running process', async () => {
      const bgTool = registry.get('run_command_background');
      const bgResult = await bgTool.handler({ command: 'sleep 5', label: 'killable' });
      const idMatch = bgResult.match(/ID: ([a-f0-9-]+)/);

      const killTool = registry.get('kill_process');
      const result = await killTool.handler({ process_id: idMatch[1] });
      assert.ok(result.includes('SIGTERM'));
    });
  });

  describe('list_processes', () => {
    it('lists active processes', async () => {
      const bgTool = registry.get('run_command_background');
      await bgTool.handler({ command: 'sleep 5', label: 'listed' });

      const listTool = registry.get('list_processes');
      const result = await listTool.handler({});
      assert.ok(result.includes('listed'));
    });

    it('shows empty message when no processes', async () => {
      const listTool = registry.get('list_processes');
      const result = await listTool.handler({});
      assert.ok(result.includes('No active'));
    });
  });

  it('all shell tools have class brokered', () => {
    const toolNames = ['run_command', 'run_command_background', 'check_process', 'kill_process', 'list_processes'];
    for (const name of toolNames) {
      assert.equal(registry.get(name).class, 'brokered', `${name} should be brokered`);
    }
  });
});
