import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DB } from '../src/db/database.js';
import { AuditLogger } from '../src/security/audit-logger.js';
import { unlinkSync } from 'fs';

const TEST_DB = `.test-audit-${process.pid}.db`;

describe('AuditLogger', () => {
  let db, auditLogger;

  beforeEach(async () => {
    db = DB.getInstance(TEST_DB);
    await db.migrate();
    auditLogger = new AuditLogger({ db, logger: null });
  });

  afterEach(() => {
    db.close();
    try { unlinkSync(TEST_DB); } catch {}
  });

  it('logs tool execution', () => {
    auditLogger.logToolExecution({
      toolName: 'read_file',
      input: { path: 'test.txt' },
      output: 'file contents',
      success: true,
      userId: 'user1',
      sessionId: 'session1',
      durationMs: 42,
    });

    const rows = auditLogger.query({ userId: 'user1' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event_type, 'tool_execution');
    assert.equal(rows[0].tool_name, 'read_file');
    assert.equal(rows[0].success, 1);
    assert.equal(rows[0].duration_ms, 42);
  });

  it('logs approval events', () => {
    auditLogger.logApproval({
      toolName: 'run_command',
      input: { command: 'rm -rf /' },
      userId: 'user1',
      sessionId: 'session1',
      approved: false,
      reason: 'User rejected',
    });

    const rows = auditLogger.query({ toolName: 'run_command' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event_type, 'approval');
    assert.equal(rows[0].success, 0);
  });

  it('logs security events', () => {
    auditLogger.logSecurityEvent({
      event: 'sandbox_violation',
      userId: 'user1',
      sessionId: 'session1',
      details: { path: '/etc/passwd' },
    });

    const rows = auditLogger.query({ userId: 'user1' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event_type, 'security');
  });

  it('truncates large inputs to 2KB', () => {
    const largeInput = 'x'.repeat(5000);
    auditLogger.logToolExecution({
      toolName: 'test',
      input: largeInput,
      output: largeInput,
      success: true,
      userId: 'user1',
      sessionId: 'session1',
      durationMs: 0,
    });

    const rows = auditLogger.query({ userId: 'user1' });
    assert.equal(rows.length, 1);
    assert.ok(rows[0].input.length <= 2048);
    assert.ok(rows[0].output.length <= 2048);
    assert.ok(rows[0].input.includes('[truncated]'));
  });

  it('queries with filters', () => {
    auditLogger.logToolExecution({ toolName: 'a', input: {}, output: '', success: true, userId: 'u1', sessionId: 's1', durationMs: 0 });
    auditLogger.logToolExecution({ toolName: 'b', input: {}, output: '', success: true, userId: 'u2', sessionId: 's2', durationMs: 0 });

    assert.equal(auditLogger.query({ userId: 'u1' }).length, 1);
    assert.equal(auditLogger.query({ sessionId: 's2' }).length, 1);
    assert.equal(auditLogger.query({}).length, 2);
  });

  it('respects limit', () => {
    for (let i = 0; i < 10; i++) {
      auditLogger.logToolExecution({ toolName: 'test', input: {}, output: '', success: true, userId: 'u1', sessionId: 's1', durationMs: 0 });
    }

    assert.equal(auditLogger.query({ limit: 5 }).length, 5);
  });
});
