import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DB } from '../src/db/database.js';
import { ApprovalManager } from '../src/security/approval-manager.js';
import { unlinkSync } from 'fs';

const TEST_DB = `.test-approval-${process.pid}.db`;

describe('ApprovalManager', () => {
  let db, am;

  beforeEach(async () => {
    db = DB.getInstance(TEST_DB);
    await db.migrate();
    // Create admin and user
    db.prepare('INSERT OR REPLACE INTO users (id, channel_id, role) VALUES (?, ?, ?)').run('admin1', 'test', 'admin');
    db.prepare('INSERT OR REPLACE INTO users (id, channel_id, role) VALUES (?, ?, ?)').run('user1', 'test', 'user');
    am = new ApprovalManager({ db, eventBus: null, auditLogger: null, logger: null });
  });

  afterEach(() => {
    db.close();
    try { unlinkSync(TEST_DB); } catch {}
  });

  it('admin bypasses approval', () => {
    assert.equal(am.needsApproval('run_command', 'admin1', 'session1'), false);
  });

  it('non-admin requires approval for run_command', () => {
    assert.equal(am.needsApproval('run_command', 'user1', 'session1'), true);
  });

  it('non-admin does not require approval for safe tools', () => {
    assert.equal(am.needsApproval('get_current_time', 'user1', 'session1'), false);
    assert.equal(am.needsApproval('read_file', 'user1', 'session1'), false);
  });

  it('once-per-session tools are cached after grant', () => {
    assert.equal(am.needsApproval('write_file', 'user1', 'session1'), true);
    am.grantSession('write_file', 'session1');
    assert.equal(am.needsApproval('write_file', 'user1', 'session1'), false);
  });

  it('resolve grants session approval', () => {
    am.setPending('session1', { toolName: 'edit_file', input: {}, userId: 'user1' });
    am.resolve('session1', true);
    assert.equal(am.needsApproval('edit_file', 'user1', 'session1'), false);
  });

  it('resolve with rejection does not grant', () => {
    am.setPending('session1', { toolName: 'run_command', input: {}, userId: 'user1' });
    am.resolve('session1', false, 'rejected');
    assert.equal(am.needsApproval('run_command', 'user1', 'session1'), true);
  });

  it('clearSession resets cache', () => {
    am.grantSession('write_file', 'session1');
    assert.equal(am.needsApproval('write_file', 'user1', 'session1'), false);
    am.clearSession('session1');
    assert.equal(am.needsApproval('write_file', 'user1', 'session1'), true);
  });

  it('getPending returns pending approval', () => {
    assert.equal(am.getPending('session1'), null);
    am.setPending('session1', { toolName: 'run_command', input: { command: 'ls' }, userId: 'user1' });
    const pending = am.getPending('session1');
    assert.equal(pending.toolName, 'run_command');
  });

  it('different sessions have independent caches', () => {
    am.grantSession('write_file', 'session1');
    assert.equal(am.needsApproval('write_file', 'user1', 'session1'), false);
    assert.equal(am.needsApproval('write_file', 'user1', 'session2'), true);
  });
});
