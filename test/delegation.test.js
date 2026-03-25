import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'fs';
import { resolve, join } from 'path';
import { Sandbox } from '../src/security/sandbox.js';
import { ProcessManager } from '../src/process/process-manager.js';
import { DelegationManager } from '../src/core/delegation-manager.js';

const TEST_DIR = resolve('.test-delegation-' + process.pid);
const WORKSPACE = join(TEST_DIR, 'workspace');

describe('DelegationManager', () => {
  let sandbox, pm, dm;

  const fakeConfig = {
    maxDelegations: 3,
    maxDelegationsPerSession: 2,
  };

  const echoBackend = {
    name: 'echo',
    available() { return true; },
    buildCommand(task) { return `echo "done: ${task.replace(/"/g, '')}"` ; },
    parseOutput(stdout) { return stdout.trim(); },
  };

  const unavailableBackend = {
    name: 'unavailable',
    available() { return false; },
    buildCommand() { return 'false'; },
    parseOutput() { return ''; },
  };

  beforeEach(() => {
    mkdirSync(WORKSPACE, { recursive: true });
    sandbox = new Sandbox({ workspaceDir: WORKSPACE });
    pm = new ProcessManager({ sandbox, logger: null, maxProcesses: 10 });
    dm = new DelegationManager({ processManager: pm, runner: null, db: null, logger: null, config: fakeConfig });
    dm.registerBackend(echoBackend);
    dm.registerBackend(unavailableBackend);
  });

  afterEach(async () => {
    await pm.shutdownAll();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('delegates a task and returns task ID', async () => {
    const taskId = await dm.delegate({
      backend: 'echo',
      task: 'do something',
      workDir: '.',
      parentSessionId: 's1',
      parentUserId: 'u1',
      timeout: 10_000,
    });
    assert.ok(taskId);
    assert.equal(typeof taskId, 'string');
  });

  it('checkStatus returns delegation info', async () => {
    const taskId = await dm.delegate({
      backend: 'echo',
      task: 'check me',
      workDir: '.',
      parentSessionId: 's1',
      parentUserId: 'u1',
    });

    const status = await dm.checkStatus(taskId);
    assert.ok(status);
    assert.equal(status.backend, 'echo');
    assert.ok(['running', 'completed'].includes(status.status));
  });

  it('getResult returns output after completion', async () => {
    const taskId = await dm.delegate({
      backend: 'echo',
      task: 'hello',
      workDir: '.',
      parentSessionId: 's1',
      parentUserId: 'u1',
    });

    // Wait for the echo command to finish
    await new Promise(r => setTimeout(r, 500));

    const result = await dm.getResult(taskId);
    assert.ok(result);
    assert.ok(result.output.includes('done'));
  });

  it('rejects unavailable backend', async () => {
    await assert.rejects(
      () => dm.delegate({
        backend: 'unavailable',
        task: 'test',
        workDir: '.',
        parentSessionId: 's1',
        parentUserId: 'u1',
      }),
      /not available/
    );
  });

  it('rejects unknown backend', async () => {
    await assert.rejects(
      () => dm.delegate({
        backend: 'nonexistent',
        task: 'test',
        workDir: '.',
        parentSessionId: 's1',
        parentUserId: 'u1',
      }),
      /Unknown delegation backend/
    );
  });

  it('enforces global delegation limit', async () => {
    await dm.delegate({ backend: 'echo', task: 'sleep 5', workDir: '.', parentSessionId: 's1', parentUserId: 'u1' });
    await dm.delegate({ backend: 'echo', task: 'sleep 5', workDir: '.', parentSessionId: 's2', parentUserId: 'u1' });
    await dm.delegate({ backend: 'echo', task: 'sleep 5', workDir: '.', parentSessionId: 's3', parentUserId: 'u1' });

    // Wait a tick so the sleep commands are running
    await new Promise(r => setTimeout(r, 100));

    await assert.rejects(
      () => dm.delegate({ backend: 'echo', task: 'too many', workDir: '.', parentSessionId: 's4', parentUserId: 'u1' }),
      /Maximum concurrent delegations/
    );
  });

  it('enforces per-session delegation limit', async () => {
    await dm.delegate({ backend: 'echo', task: 'sleep 5', workDir: '.', parentSessionId: 's1', parentUserId: 'u1' });
    await dm.delegate({ backend: 'echo', task: 'sleep 5', workDir: '.', parentSessionId: 's1', parentUserId: 'u1' });

    await new Promise(r => setTimeout(r, 100));

    await assert.rejects(
      () => dm.delegate({ backend: 'echo', task: 'too many in session', workDir: '.', parentSessionId: 's1', parentUserId: 'u1' }),
      /Maximum delegations per session/
    );
  });

  it('cancels a running delegation', async () => {
    const taskId = await dm.delegate({
      backend: 'echo',
      task: 'sleep 5',
      workDir: '.',
      parentSessionId: 's1',
      parentUserId: 'u1',
    });

    await new Promise(r => setTimeout(r, 100));

    const cancelled = await dm.cancel(taskId);
    assert.equal(cancelled, true);

    const status = await dm.checkStatus(taskId);
    assert.equal(status.status, 'cancelled');
  });

  it('listActive shows running delegations', async () => {
    await dm.delegate({ backend: 'echo', task: 'sleep 5', workDir: '.', parentSessionId: 's1', parentUserId: 'u1' });
    await new Promise(r => setTimeout(r, 100));

    const active = dm.listActive();
    assert.ok(active.length >= 1);
  });
});
