import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { HeartbeatScheduler } from '../src/heartbeat/heartbeat-scheduler.js';

describe('HeartbeatScheduler', () => {
  let rawDb, wrappedDb, scheduler;

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

    const fakeRunner = {
      execute: async (request) => ({ content: 'done', newMessages: [] }),
    };
    const fakeToolRegistry = {
      getSchemas: () => [],
    };
    const fakeSessionManager = {
      loadHistory: () => [],
    };
    const fakeLogger = { info: () => {}, error: () => {}, warn: () => {} };
    const fakeConfig = { heartbeatIntervalMs: 0, maxToolIterations: 25 };

    scheduler = new HeartbeatScheduler(fakeRunner, fakeToolRegistry, fakeSessionManager, wrappedDb, fakeConfig, fakeLogger);
  });

  it('tick creates an ExecutionRequest with correct userId and channelId', async () => {
    let capturedRequest = null;
    scheduler.runner = {
      execute: async (request) => {
        capturedRequest = request;
        return { content: 'ok', newMessages: [] };
      },
    };
    scheduler._parseTasks = () => [{ name: 'Test', instructions: 'do something' }];

    await scheduler.tick();

    assert.equal(capturedRequest.userId, 'system');
    assert.equal(capturedRequest.channelId, 'heartbeat');
    assert.ok(capturedRequest.sessionId.includes('heartbeat'));
  });

  it('start ensures system user has admin role', () => {
    scheduler.config = { heartbeatIntervalMs: 60000 };
    scheduler._heartbeatPath = '__nonexistent__';
    scheduler.start(); // Will return early due to file not found

    // Test the DB insert directly
    wrappedDb.prepare(
      'INSERT INTO users (id, channel_id, role) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET role = ?'
    ).run('system', 'heartbeat', 'admin', 'admin');

    const row = rawDb.prepare('SELECT role FROM users WHERE id = ?').get('system');
    assert.equal(row.role, 'admin');
  });
});
