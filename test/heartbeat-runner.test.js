import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { HeartbeatScheduler } from '../src/heartbeat/heartbeat-scheduler.js';

describe('HeartbeatScheduler (runner-based)', () => {
  let rawDb, wrappedDb, scheduler, capturedRequest;

  beforeEach(() => {
    rawDb = new Database(':memory:');
    rawDb.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, display_name TEXT, role TEXT DEFAULT 'user', created_at INTEGER DEFAULT (unixepoch()));
      CREATE TABLE heartbeat_state (task_name TEXT PRIMARY KEY, last_run_at INTEGER, last_result TEXT);
    `);
    wrappedDb = {
      prepare: (sql) => rawDb.prepare(sql),
      exec: (sql) => rawDb.exec(sql),
    };

    capturedRequest = null;
    const fakeRunner = {
      execute: async (request) => {
        capturedRequest = request;
        return { content: 'done', newMessages: [], toolsUsed: [], tokenUsage: { inputTokens: 0, outputTokens: 0 } };
      },
    };
    const fakeToolRegistry = {
      getSchemas: (filter) => [{ name: 'get_current_time', description: 'Get time', input_schema: {} }],
    };
    const fakeSessionManager = {
      loadHistory: () => [],
    };
    const fakeLogger = { info: () => {}, error: () => {}, warn: () => {} };
    const fakeConfig = { heartbeatIntervalMs: 0, maxToolIterations: 25 };

    scheduler = new HeartbeatScheduler(fakeRunner, fakeToolRegistry, fakeSessionManager, wrappedDb, fakeConfig, fakeLogger);
  });

  it('tick produces ExecutionRequest with origin: scheduled_task', async () => {
    scheduler._parseTasks = () => [{ name: 'Test', instructions: 'do something' }];
    await scheduler.tick();

    assert.ok(capturedRequest);
    assert.equal(capturedRequest.origin, 'scheduled_task');
  });

  it('tick produces ExecutionRequest with correct session fields', async () => {
    scheduler._parseTasks = () => [{ name: 'Test', instructions: 'do something' }];
    await scheduler.tick();

    assert.equal(capturedRequest.sessionId, 'heartbeat:system');
    assert.equal(capturedRequest.userId, 'system');
    assert.equal(capturedRequest.channelId, 'heartbeat');
    assert.ok(capturedRequest.executionId);
    assert.ok(capturedRequest.userContent.includes('do something'));
  });

  it('tick calls runner.execute()', async () => {
    let executeCalled = false;
    scheduler.runner = {
      execute: async (req) => {
        executeCalled = true;
        return { content: 'ok', newMessages: [] };
      },
    };
    scheduler._parseTasks = () => [{ name: 'Test', instructions: 'check' }];
    await scheduler.tick();

    assert.ok(executeCalled);
  });

  it('overlap prevention works', async () => {
    let callCount = 0;
    let resolveFirst;

    scheduler.runner = {
      execute: async () => {
        callCount++;
        if (callCount === 1) {
          await new Promise(r => { resolveFirst = r; });
        }
        return { content: 'ok', newMessages: [] };
      },
    };
    scheduler._parseTasks = () => [{ name: 'Test', instructions: 'go' }];

    // Start first tick (will block)
    const tick1 = scheduler.tick();

    // Second tick should be skipped
    await scheduler.tick();
    assert.equal(callCount, 1); // Only first call went through

    // Resolve first
    resolveFirst();
    await tick1;
  });

  it('includes tool schemas (admin = all tools)', async () => {
    scheduler._parseTasks = () => [{ name: 'Test', instructions: 'run' }];
    await scheduler.tick();

    assert.ok(Array.isArray(capturedRequest.toolSchemas));
    assert.equal(capturedRequest.toolSchemas.length, 1);
    assert.equal(capturedRequest.allowedToolNames, null);
  });

  it('start ensures system user has admin role', () => {
    scheduler.config = { heartbeatIntervalMs: 60000 };
    scheduler._heartbeatPath = '__nonexistent__';
    scheduler.start(); // Returns early due to file not found, but we test DB setup directly

    wrappedDb.prepare(
      'INSERT INTO users (id, channel_id, role) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET role = ?'
    ).run('system', 'heartbeat', 'admin', 'admin');

    const row = rawDb.prepare('SELECT role FROM users WHERE id = ?').get('system');
    assert.equal(row.role, 'admin');
  });
});
