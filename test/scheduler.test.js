import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { TaskScheduler } from '../src/scheduler/scheduler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const TEST_DIR = resolve('.test-scheduler-' + process.pid);

describe('TaskScheduler', () => {
  let scheduler, originalCwd;

  const fakeRunner = {
    execute: async () => ({ content: 'done', toolsUsed: [], tokenUsage: {} }),
  };
  const fakeRegistry = {
    getSchemas: () => [],
  };
  const fakeSessionManager = {
    loadHistory: () => [],
  };
  const fakeDb = {
    prepare: () => ({ run: () => {}, get: () => null }),
  };
  const fakeLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  const fakeConfig = {
    maxToolIterations: 25,
    heartbeatIntervalMs: 30 * 60 * 1000,
  };

  beforeEach(() => {
    originalCwd = process.cwd();
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.chdir(TEST_DIR);
  });

  afterEach(() => {
    if (scheduler) scheduler.stop();
    process.chdir(originalCwd);
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('loads tasks from tasks/ directory', () => {
    mkdirSync('tasks', { recursive: true });
    writeFileSync('tasks/test-task.md', `---
name: test-task
description: A test task
schedule: "30m"
timeout: 60000
enabled: true
---

Do something useful.
`);

    scheduler = new TaskScheduler({
      runner: fakeRunner,
      toolRegistry: fakeRegistry,
      sessionManager: fakeSessionManager,
      db: fakeDb,
      logger: fakeLogger,
      config: fakeConfig,
    });
    scheduler.loadTasks();

    const tasks = scheduler.listTasks();
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].name, 'test-task');
    assert.equal(tasks[0].schedule, '30m');
  });

  it('loads from HEARTBEAT.md when no tasks/ dir', () => {
    writeFileSync('HEARTBEAT.md', `## Check Status\nCheck system status and report.`);

    scheduler = new TaskScheduler({
      runner: fakeRunner,
      toolRegistry: fakeRegistry,
      sessionManager: fakeSessionManager,
      db: fakeDb,
      logger: fakeLogger,
      config: fakeConfig,
    });
    scheduler.loadTasks();

    const tasks = scheduler.listTasks();
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].name, 'Check Status');
  });

  it('skips disabled tasks', () => {
    mkdirSync('tasks', { recursive: true });
    writeFileSync('tasks/disabled.md', `---
name: disabled-task
enabled: false
schedule: "1h"
---

Should not load.
`);

    scheduler = new TaskScheduler({
      runner: fakeRunner,
      toolRegistry: fakeRegistry,
      sessionManager: fakeSessionManager,
      db: fakeDb,
      logger: fakeLogger,
      config: fakeConfig,
    });
    scheduler.loadTasks();

    assert.equal(scheduler.listTasks().length, 0);
  });

  it('getTaskStatus returns task info', () => {
    mkdirSync('tasks', { recursive: true });
    writeFileSync('tasks/status.md', `---
name: status-task
schedule: "10m"
---

Check something.
`);

    scheduler = new TaskScheduler({
      runner: fakeRunner,
      toolRegistry: fakeRegistry,
      sessionManager: fakeSessionManager,
      db: fakeDb,
      logger: fakeLogger,
      config: fakeConfig,
    });
    scheduler.loadTasks();

    const status = scheduler.getTaskStatus('status-task');
    assert.ok(status);
    assert.equal(status.name, 'status-task');
    assert.equal(status.running, false);
  });

  it('returns null for unknown task', () => {
    scheduler = new TaskScheduler({
      runner: fakeRunner,
      toolRegistry: fakeRegistry,
      sessionManager: fakeSessionManager,
      db: fakeDb,
      logger: fakeLogger,
      config: fakeConfig,
    });
    scheduler.loadTasks();

    assert.equal(scheduler.getTaskStatus('nonexistent'), null);
  });

  it('parses various schedule formats', () => {
    scheduler = new TaskScheduler({
      runner: fakeRunner,
      toolRegistry: fakeRegistry,
      sessionManager: fakeSessionManager,
      db: fakeDb,
      logger: fakeLogger,
      config: fakeConfig,
    });
    scheduler.loadTasks();

    assert.equal(scheduler._parseSchedule('30m'), 30 * 60 * 1000);
    assert.equal(scheduler._parseSchedule('1h'), 60 * 60 * 1000);
    assert.equal(scheduler._parseSchedule('60s'), 60 * 1000);
    assert.equal(scheduler._parseSchedule('5000ms'), 5000);
    assert.equal(scheduler._parseSchedule('*/30 * * * *'), 30 * 60 * 1000);
  });
});
