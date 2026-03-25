import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'fs';
import { resolve, join } from 'path';
import { Sandbox } from '../src/security/sandbox.js';
import { ProcessManager } from '../src/process/process-manager.js';

const TEST_DIR = resolve('.test-procmgr-' + process.pid);
const WORKSPACE = join(TEST_DIR, 'workspace');

describe('ProcessManager', () => {
  let sandbox, pm;

  beforeEach(() => {
    mkdirSync(WORKSPACE, { recursive: true });
    sandbox = new Sandbox({ workspaceDir: WORKSPACE });
    pm = new ProcessManager({ sandbox, logger: null, maxProcesses: 3, defaultTimeoutMs: 10_000 });
  });

  afterEach(async () => {
    await pm.shutdownAll();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('runs a simple command', async () => {
    const result = await pm.run('echo hello', {});
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes('hello'));
    assert.equal(result.timedOut, false);
  });

  it('captures stderr', async () => {
    const result = await pm.run('echo error >&2', {});
    assert.ok(result.stderr.includes('error'));
  });

  it('reports non-zero exit code', async () => {
    const result = await pm.run('exit 42', {});
    assert.equal(result.exitCode, 42);
  });

  it('enforces timeout', async () => {
    const result = await pm.run('sleep 10', { timeoutMs: 1000 });
    assert.equal(result.timedOut, true);
  });

  it('starts and tracks background processes', async () => {
    const id = await pm.startBackground('sleep 5', { label: 'sleeper' });
    assert.ok(id);

    const status = pm.getStatus(id);
    assert.equal(status.status, 'running');
    assert.equal(status.label, 'sleeper');

    const active = pm.listActive();
    assert.ok(active.length >= 1);
  });

  it('kills background processes', async () => {
    const id = await pm.startBackground('sleep 5', { label: 'killme' });
    const killed = pm.kill(id);
    assert.equal(killed, true);

    // Wait for process to exit
    await new Promise(r => setTimeout(r, 200));
    const status = pm.getStatus(id);
    assert.equal(status.status, 'exited');
  });

  it('enforces max background processes', async () => {
    await pm.startBackground('sleep 5', {});
    await pm.startBackground('sleep 5', {});
    await pm.startBackground('sleep 5', {});

    await assert.rejects(
      () => pm.startBackground('sleep 5', {}),
      /Maximum background processes/
    );
  });

  it('shutdownAll kills all processes', async () => {
    await pm.startBackground('sleep 5', {});
    await pm.startBackground('sleep 5', {});
    await pm.shutdownAll();

    // After shutdown all should be exited
    const active = pm.listActive().filter(p => p.status === 'running');
    assert.equal(active.length, 0);
  });
});
