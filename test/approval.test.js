import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DB } from '../src/db/database.js';
import { ApprovalManager, TOOLS_REQUIRING_APPROVAL } from '../src/security/approval-manager.js';
import { unlinkSync } from 'fs';

const TEST_DB = `.test-approval-${process.pid}.db`;

describe('ApprovalManager', () => {
  let db, am;

  beforeEach(async () => {
    db = DB.getInstance(TEST_DB);
    await db.migrate();
    db.prepare('INSERT OR REPLACE INTO users (id, channel_id, role) VALUES (?, ?, ?)').run('admin1', 'test', 'admin');
    db.prepare('INSERT OR REPLACE INTO users (id, channel_id, role) VALUES (?, ?, ?)').run('user1', 'test', 'user');
    am = new ApprovalManager({ db, eventBus: null, auditLogger: null, logger: null });
  });

  afterEach(() => {
    db.close();
    try { unlinkSync(TEST_DB); } catch {}
  });

  // --- Role-based bypass ---

  describe('admin bypass', () => {
    it('admin bypasses approval for all write tools', () => {
      for (const tool of TOOLS_REQUIRING_APPROVAL) {
        assert.equal(am.needsApproval(tool, 'admin1', 'session1'), false,
          `admin should bypass approval for ${tool}`);
      }
    });
  });

  // --- Non-admin approval for write tools ---

  describe('non-admin write tool approval', () => {
    it('requires approval for each write tool', () => {
      for (const tool of TOOLS_REQUIRING_APPROVAL) {
        assert.equal(am.needsApproval(tool, 'user1', 'session1'), true,
          `non-admin should require approval for ${tool}`);
      }
    });
  });

  // --- Non-admin safe (read) tools ---

  describe('non-admin read tool access', () => {
    it('does not require approval for read tools', () => {
      for (const tool of ['get_current_time', 'read_file', 'list_directory',
        'grep_search', 'search_memory', 'list_memories', 'http_get',
        'list_processes', 'check_process', 'check_delegation', 'wait']) {
        assert.equal(am.needsApproval(tool, 'user1', 'session1'), false,
          `${tool} should not require approval`);
      }
    });
  });

  // --- requiresApproval() static check ---

  describe('requiresApproval()', () => {
    it('returns true for all tools in TOOLS_REQUIRING_APPROVAL', () => {
      for (const tool of TOOLS_REQUIRING_APPROVAL) {
        assert.equal(am.requiresApproval(tool), true,
          `requiresApproval should return true for ${tool}`);
      }
    });

    it('returns false for read tools', () => {
      for (const tool of ['get_current_time', 'read_file', 'list_directory', 'grep_search',
        'search_memory', 'list_memories', 'http_get',
        'list_processes', 'check_process', 'check_delegation',
        'save_memory', 'wait']) {
        assert.equal(am.requiresApproval(tool), false,
          `requiresApproval should return false for ${tool}`);
      }
    });

    it('returns false for unknown tools', () => {
      assert.equal(am.requiresApproval('nonexistent_tool'), false);
    });
  });

  // --- No session caching (every invocation requires approval) ---

  describe('no session caching', () => {
    it('requires approval again after resolve (no session cache)', () => {
      assert.equal(am.needsApproval('write_file', 'user1', 'session1'), true);

      am.setPending('session1', { toolName: 'write_file', input: {}, userId: 'user1' });
      am.resolve('session1', true);

      assert.equal(am.needsApproval('write_file', 'user1', 'session1'), true);
    });

    it('requires approval for every run_command invocation', () => {
      am.setPending('session1', { toolName: 'run_command', input: { command: 'ls' }, userId: 'user1' });
      am.resolve('session1', true);
      assert.equal(am.needsApproval('run_command', 'user1', 'session1'), true);
    });
  });

  // --- Pending approvals ---

  describe('pending approvals', () => {
    it('getPending returns null when nothing pending', () => {
      assert.equal(am.getPending('session1'), null);
    });

    it('getPending returns pending approval after setPending', () => {
      am.setPending('session1', { toolName: 'run_command', input: { command: 'ls' }, userId: 'user1' });
      const pending = am.getPending('session1');
      assert.equal(pending.toolName, 'run_command');
      assert.deepEqual(pending.input, { command: 'ls' });
      assert.equal(pending.userId, 'user1');
      assert.ok(pending.createdAt > 0);
    });

    it('resolve clears pending entry', () => {
      am.setPending('session1', { toolName: 'edit_file', input: {}, userId: 'user1' });
      am.resolve('session1', true);
      assert.equal(am.getPending('session1'), null);
    });

    it('resolve with rejection clears pending without granting', () => {
      am.setPending('session1', { toolName: 'run_command', input: {}, userId: 'user1' });
      am.resolve('session1', false, 'rejected by user');
      assert.equal(am.getPending('session1'), null);
      assert.equal(am.needsApproval('run_command', 'user1', 'session1'), true);
    });

    it('resolve with no pending is a no-op', () => {
      am.resolve('session1', true);
      assert.equal(am.getPending('session1'), null);
    });
  });

  // --- clearSession ---

  describe('clearSession', () => {
    it('clears pending approvals for the session', () => {
      am.setPending('session1', { toolName: 'run_command', input: {}, userId: 'user1' });
      am.clearSession('session1');
      assert.equal(am.getPending('session1'), null);
    });

    it('does not affect other sessions', () => {
      am.setPending('session1', { toolName: 'run_command', input: {}, userId: 'user1' });
      am.setPending('session2', { toolName: 'write_file', input: {}, userId: 'user1' });
      am.clearSession('session1');
      assert.equal(am.getPending('session1'), null);
      assert.ok(am.getPending('session2') !== null);
    });
  });

  // --- Audit logging ---

  describe('audit logging', () => {
    it('logs approval via auditLogger when provided', () => {
      const logged = [];
      const auditLogger = { logApproval: (entry) => logged.push(entry) };
      am = new ApprovalManager({ db, eventBus: null, auditLogger, logger: null });

      am.setPending('session1', { toolName: 'run_command', input: { command: 'rm -rf /' }, userId: 'user1' });
      am.resolve('session1', true);

      assert.equal(logged.length, 1);
      assert.equal(logged[0].toolName, 'run_command');
      assert.equal(logged[0].approved, true);
      assert.equal(logged[0].userId, 'user1');
    });

    it('logs rejection via auditLogger', () => {
      const logged = [];
      const auditLogger = { logApproval: (entry) => logged.push(entry) };
      am = new ApprovalManager({ db, eventBus: null, auditLogger, logger: null });

      am.setPending('session1', { toolName: 'write_file', input: {}, userId: 'user1' });
      am.resolve('session1', false, 'too dangerous');

      assert.equal(logged.length, 1);
      assert.equal(logged[0].approved, false);
      assert.equal(logged[0].reason, 'too dangerous');
    });
  });

  // --- grantSession / revokeSession removed ---

  describe('removed session cache API', () => {
    it('does not expose grantSession method', () => {
      assert.equal(typeof am.grantSession, 'undefined');
    });

    it('does not expose revokeSession method', () => {
      assert.equal(typeof am.revokeSession, 'undefined');
    });
  });

  // --- grantApproval / consumeGrant ---

  describe('grantApproval', () => {
    it('bypasses needsApproval for the granted tool', () => {
      assert.equal(am.needsApproval('write_file', 'user1', 'session1'), true);
      am.grantApproval('session1', 'write_file');
      assert.equal(am.needsApproval('write_file', 'user1', 'session1'), false);
    });

    it('grant is consumed on first use (one-time)', () => {
      am.grantApproval('session1', 'run_command');
      assert.equal(am.needsApproval('run_command', 'user1', 'session1'), false);
      // Second call should require approval again
      assert.equal(am.needsApproval('run_command', 'user1', 'session1'), true);
    });

    it('grant only matches the specified tool', () => {
      am.grantApproval('session1', 'write_file');
      // Different tool should still require approval
      assert.equal(am.needsApproval('run_command', 'user1', 'session1'), true);
      // Granted tool passes
      assert.equal(am.needsApproval('write_file', 'user1', 'session1'), false);
    });

    it('grant is scoped to the session', () => {
      am.grantApproval('session1', 'write_file');
      assert.equal(am.needsApproval('write_file', 'user1', 'session2'), true);
      assert.equal(am.needsApproval('write_file', 'user1', 'session1'), false);
    });

    it('grant expires after 5 minutes', () => {
      am.grantApproval('session1', 'write_file');
      // Simulate expiry by backdating the grant
      am._grants.get('session1').grantedAt = Date.now() - 6 * 60 * 1000;
      assert.equal(am.needsApproval('write_file', 'user1', 'session1'), true);
    });

    it('clearSession clears grants', () => {
      am.grantApproval('session1', 'write_file');
      am.clearSession('session1');
      assert.equal(am.needsApproval('write_file', 'user1', 'session1'), true);
    });

    it('admin still bypasses even without grant', () => {
      assert.equal(am.needsApproval('write_file', 'admin1', 'session1'), false);
    });
  });
});
