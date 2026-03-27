import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DB } from '../src/db/database.js';
import { ToolPolicy } from '../src/security/tool-policy.js';
import { TOOLS_REQUIRING_APPROVAL } from '../src/security/approval-manager.js';
import { unlinkSync } from 'fs';

const TEST_DB = `.test-tool-policy-${process.pid}.db`;

describe('ToolPolicy', () => {
  let db;

  beforeEach(async () => {
    db = DB.getInstance(TEST_DB);
    await db.migrate();
    db.prepare('INSERT OR REPLACE INTO users (id, channel_id, role) VALUES (?, ?, ?)').run('admin1', 'test', 'admin');
    db.prepare('INSERT OR REPLACE INTO users (id, channel_id, role) VALUES (?, ?, ?)').run('user1', 'test', 'user');
    db.prepare('INSERT OR REPLACE INTO users (id, channel_id, role) VALUES (?, ?, ?)').run('pending1', 'test', 'pending');
    db.prepare('INSERT OR REPLACE INTO users (id, channel_id, role) VALUES (?, ?, ?)').run('blocked1', 'test', 'blocked');
  });

  afterEach(() => {
    db.close();
    try { unlinkSync(TEST_DB); } catch {}
  });

  // --- Minimal profile (pending users) — unchanged ---

  describe('minimal profile (pending)', () => {
    it('allows only get_current_time', () => {
      const tp = new ToolPolicy(db, {});
      assert.equal(tp.isAllowed('get_current_time', 'pending1'), true);
    });

    it('denies read tools for pending users', () => {
      const tp = new ToolPolicy(db, {});
      for (const tool of ['read_file', 'list_directory', 'grep_search', 'http_get']) {
        assert.equal(tp.isAllowed(tool, 'pending1'), false,
          `pending user should not have access to ${tool}`);
      }
    });

    it('denies write tools for pending users', () => {
      const tp = new ToolPolicy(db, {});
      for (const tool of ['run_command', 'write_file', 'edit_file', 'http_post']) {
        assert.equal(tp.isAllowed(tool, 'pending1'), false,
          `pending user should not have access to ${tool}`);
      }
    });

    it('getEffectiveToolNames returns annotated single-element list', () => {
      const tp = new ToolPolicy(db, {}, null);
      const result = tp.getEffectiveToolNames('pending1');
      assert.ok(Array.isArray(result));
      assert.equal(result.length, 1);
      assert.deepEqual(result[0], { name: 'get_current_time', requiresApproval: false });
    });
  });

  // --- Full profile (admin) — unchanged ---

  describe('full profile (admin)', () => {
    it('allows all tools', () => {
      const tp = new ToolPolicy(db, {});
      for (const tool of ['run_command', 'write_file', 'read_file', 'http_post',
        'kill_process', 'delegate_task', 'list_processes']) {
        assert.equal(tp.isAllowed(tool, 'admin1'), true,
          `admin should have access to ${tool}`);
      }
    });

    it('getEffectiveToolNames returns null (all tools)', () => {
      const tp = new ToolPolicy(db, {});
      assert.equal(tp.getEffectiveToolNames('admin1'), null);
    });
  });

  // --- Blocked users ---

  describe('blocked users', () => {
    it('denies all tools', () => {
      const tp = new ToolPolicy(db, {});
      assert.equal(tp.isAllowed('get_current_time', 'blocked1'), false);
      assert.equal(tp.isAllowed('read_file', 'blocked1'), false);
    });

    it('getEffectiveToolNames returns empty array', () => {
      const tp = new ToolPolicy(db, {});
      const result = tp.getEffectiveToolNames('blocked1');
      assert.ok(Array.isArray(result));
      assert.equal(result.length, 0);
    });
  });

  // --- Updated standard profile (Spec 23 changes) ---

  describe('standard profile (user) — expanded allow list', () => {
    it('allows read tools without policy block', () => {
      const tp = new ToolPolicy(db, {});
      const readTools = [
        'get_current_time', 'wait', 'search_memory', 'list_memories',
        'http_get', 'read_file', 'list_directory', 'file_search', 'grep_search',
        'list_processes', 'check_process', 'check_delegation',
      ];
      for (const tool of readTools) {
        assert.equal(tp.isAllowed(tool, 'user1'), true,
          `standard user should have access to read tool: ${tool}`);
      }
    });

    it('allows write tools at the policy level (approval handled elsewhere)', () => {
      const tp = new ToolPolicy(db, {});
      const writeTools = [
        'save_memory', 'http_post', 'write_file', 'edit_file',
        'run_command', 'run_command_background', 'kill_process',
        'delegate_task', 'cancel_delegation',
      ];
      for (const tool of writeTools) {
        assert.equal(tp.isAllowed(tool, 'user1'), true,
          `standard user should have policy-level access to write tool: ${tool}`);
      }
    });

    it('newly added tools are accessible: list_processes, check_process, check_delegation', () => {
      const tp = new ToolPolicy(db, {});
      assert.equal(tp.isAllowed('list_processes', 'user1'), true);
      assert.equal(tp.isAllowed('check_process', 'user1'), true);
      assert.equal(tp.isAllowed('check_delegation', 'user1'), true);
    });

    it('standard profile deny list is empty', () => {
      const tp = new ToolPolicy(db, {});
      // Previously denied tools should now be allowed
      const previouslyDenied = [
        'http_post', 'write_file', 'edit_file',
        'run_command', 'run_command_background', 'kill_process',
        'delegate_task', 'cancel_delegation',
      ];
      for (const tool of previouslyDenied) {
        assert.equal(tp.isAllowed(tool, 'user1'), true,
          `${tool} was previously denied but should now be allowed`);
      }
    });
  });

  // --- getEffectiveToolNames annotated return ---

  describe('getEffectiveToolNames — annotated return type', () => {
    const mockApprovalManager = {
      requiresApproval: (toolName) => TOOLS_REQUIRING_APPROVAL.has(toolName),
    };

    it('returns array of {name, requiresApproval} for standard user', () => {
      const tp = new ToolPolicy(db, {}, mockApprovalManager);
      const result = tp.getEffectiveToolNames('user1');

      assert.ok(Array.isArray(result));
      assert.ok(result.length > 0);

      // Every entry must have name and requiresApproval
      for (const entry of result) {
        assert.ok(typeof entry.name === 'string', 'entry must have name');
        assert.ok(typeof entry.requiresApproval === 'boolean', 'entry must have requiresApproval');
      }
    });

    it('read tools have requiresApproval: false', () => {
      const tp = new ToolPolicy(db, {}, mockApprovalManager);
      const result = tp.getEffectiveToolNames('user1');

      const readTools = ['read_file', 'list_directory', 'grep_search', 'http_get',
        'search_memory', 'list_memories', 'list_processes', 'check_process',
        'check_delegation', 'get_current_time', 'wait'];
      for (const toolName of readTools) {
        const entry = result.find(e => e.name === toolName);
        assert.ok(entry, `${toolName} should be in the effective tools list`);
        assert.equal(entry.requiresApproval, false,
          `${toolName} should not require approval`);
      }
    });

    it('write tools have requiresApproval: true', () => {
      const tp = new ToolPolicy(db, {}, mockApprovalManager);
      const result = tp.getEffectiveToolNames('user1');

      const writeTools = ['run_command', 'run_command_background', 'kill_process',
        'write_file', 'edit_file', 'http_post', 'delegate_task', 'cancel_delegation'];
      for (const toolName of writeTools) {
        const entry = result.find(e => e.name === toolName);
        assert.ok(entry, `${toolName} should be in the effective tools list`);
        assert.equal(entry.requiresApproval, true,
          `${toolName} should require approval`);
      }
    });

    it('save_memory has requiresApproval: false (low-risk write)', () => {
      const tp = new ToolPolicy(db, {}, mockApprovalManager);
      const result = tp.getEffectiveToolNames('user1');
      const entry = result.find(e => e.name === 'save_memory');
      assert.ok(entry, 'save_memory should be in the effective tools list');
      assert.equal(entry.requiresApproval, false);
    });

    it('returns null for admin (full profile)', () => {
      const tp = new ToolPolicy(db, {}, mockApprovalManager);
      assert.equal(tp.getEffectiveToolNames('admin1'), null);
    });

    it('returns annotated list for minimal profile', () => {
      const tp = new ToolPolicy(db, {}, mockApprovalManager);
      const result = tp.getEffectiveToolNames('pending1');
      assert.ok(Array.isArray(result));
      assert.equal(result.length, 1);
      assert.deepEqual(result[0], { name: 'get_current_time', requiresApproval: false });
    });

    it('works without approvalManager (falls back to requiresApproval: false)', () => {
      const tp = new ToolPolicy(db, {}, null);
      const result = tp.getEffectiveToolNames('user1');
      assert.ok(Array.isArray(result));
      // Without approvalManager, all entries should have requiresApproval: false
      for (const entry of result) {
        assert.equal(entry.requiresApproval, false,
          `${entry.name} should default to requiresApproval: false without approvalManager`);
      }
    });

    it('does not return null for standard profile (explicit list required)', () => {
      const tp = new ToolPolicy(db, {}, mockApprovalManager);
      const result = tp.getEffectiveToolNames('user1');
      assert.notEqual(result, null, 'standard profile must return explicit list, not null');
    });
  });

  // --- Constructor accepts approvalManager ---

  describe('constructor', () => {
    it('accepts approvalManager as third parameter', () => {
      const mockAM = { requiresApproval: () => false };
      const tp = new ToolPolicy(db, {}, mockAM);
      // Should not throw — approvalManager is stored
      const result = tp.getEffectiveToolNames('user1');
      assert.ok(Array.isArray(result));
    });

    it('works without approvalManager (backward compatible)', () => {
      const tp = new ToolPolicy(db, {});
      // Should not throw
      const result = tp.getEffectiveToolNames('user1');
      assert.ok(Array.isArray(result));
    });
  });
});
