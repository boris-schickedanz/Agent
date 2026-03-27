import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DB } from '../src/db/database.js';
import { ApprovalManager } from '../src/security/approval-manager.js';
import { ToolExecutor } from '../src/tools/tool-executor.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import { CommandRouter } from '../src/core/command-router.js';
import { unlinkSync } from 'fs';

const TEST_DB = `.test-approval-flow-${process.pid}.db`;

// ---------------------------------------------------------------------------
// ToolExecutor — approval path
// ---------------------------------------------------------------------------

describe('ToolExecutor approval path', () => {
  let db, am, registry, executor;

  beforeEach(async () => {
    db = DB.getInstance(TEST_DB);
    await db.migrate();
    db.prepare('INSERT OR REPLACE INTO users (id, channel_id, role) VALUES (?, ?, ?)').run('admin1', 'test', 'admin');
    db.prepare('INSERT OR REPLACE INTO users (id, channel_id, role) VALUES (?, ?, ?)').run('user1', 'test', 'user');

    am = new ApprovalManager({ db, eventBus: null, auditLogger: null, logger: null });

    registry = new ToolRegistry();
    registry.register({
      name: 'write_file',
      description: 'Write a file',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      handler: async () => 'file written',
    });
    registry.register({
      name: 'read_file',
      description: 'Read a file',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      handler: async () => 'file contents',
    });

    const logger = { info: () => {}, warn: () => {}, error: () => {} };
    executor = new ToolExecutor(registry, null, logger, { approvalManager: am });
  });

  afterEach(() => {
    db.close();
    try { unlinkSync(TEST_DB); } catch {}
  });

  it('returns awaitingApproval and calls setPending for write tools (non-admin)', async () => {
    const session = { id: 'session1', userId: 'user1', channelId: 'test' };
    const result = await executor.execute('write_file', { path: 'test.txt' }, session);

    assert.equal(result.awaitingApproval, true);
    assert.ok(result.result.includes('[APPROVAL_REQUIRED]'));
    assert.ok(result.result.includes('write_file'));

    // Verify setPending was called
    const pending = am.getPending('session1');
    assert.ok(pending);
    assert.equal(pending.toolName, 'write_file');
    assert.deepEqual(pending.input, { path: 'test.txt' });
    assert.equal(pending.userId, 'user1');
  });

  it('does not require approval for read tools', async () => {
    const session = { id: 'session1', userId: 'user1', channelId: 'test' };
    const result = await executor.execute('read_file', { path: 'test.txt' }, session);

    assert.equal(result.success, true);
    assert.equal(result.awaitingApproval, undefined);
    assert.equal(result.result, 'file contents');
  });

  it('admin bypasses approval for write tools', async () => {
    const session = { id: 'session1', userId: 'admin1', channelId: 'test' };
    const result = await executor.execute('write_file', { path: 'test.txt' }, session);

    assert.equal(result.success, true);
    assert.equal(result.awaitingApproval, undefined);
    assert.equal(result.result, 'file written');
  });

  it('executes write tool after grantApproval', async () => {
    const session = { id: 'session1', userId: 'user1', channelId: 'test' };

    // First call: approval required
    const first = await executor.execute('write_file', { path: 'test.txt' }, session);
    assert.equal(first.awaitingApproval, true);

    // Grant approval
    am.grantApproval('session1', 'write_file');

    // Second call: should execute
    const second = await executor.execute('write_file', { path: 'test.txt' }, session);
    assert.equal(second.success, true);
    assert.equal(second.awaitingApproval, undefined);
    assert.equal(second.result, 'file written');
  });

  it('includes command summary in approval message', async () => {
    const session = { id: 'session1', userId: 'user1', channelId: 'test' };
    const result = await executor.execute('write_file', { path: '/workspace/notes.md' }, session);

    assert.ok(result.result.includes('/workspace/notes.md'));
  });

  it('logs audit entry with pending reason', async () => {
    const logged = [];
    const auditLogger = { logApproval: (e) => logged.push(e) };
    const loggedExecutor = new ToolExecutor(registry, null,
      { info: () => {}, warn: () => {}, error: () => {} },
      { approvalManager: am, auditLogger });

    const session = { id: 'session1', userId: 'user1', channelId: 'test' };
    await loggedExecutor.execute('write_file', { path: 'test.txt' }, session);

    assert.equal(logged.length, 1);
    assert.equal(logged[0].toolName, 'write_file');
    assert.equal(logged[0].approved, false);
    assert.equal(logged[0].reason, 'pending');
  });
});

// ---------------------------------------------------------------------------
// Full approval flow integration
// ---------------------------------------------------------------------------

describe('Full approval flow integration', () => {
  let db, am, registry, executor, eventBus, emitted;

  beforeEach(async () => {
    db = DB.getInstance(TEST_DB);
    await db.migrate();
    db.prepare('INSERT OR REPLACE INTO users (id, channel_id, role) VALUES (?, ?, ?)').run('user1', 'test', 'user');

    am = new ApprovalManager({ db, eventBus: null, auditLogger: null, logger: null });
    eventBus = new EventEmitter();
    emitted = [];
    eventBus.on('message:outbound', (msg) => emitted.push(msg));

    registry = new ToolRegistry();
    registry.register({
      name: 'run_command',
      description: 'Run a shell command',
      inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      handler: async (input) => `executed: ${input.command}`,
    });

    const logger = { info: () => {}, warn: () => {}, error: () => {} };
    executor = new ToolExecutor(registry, null, logger, { approvalManager: am });
  });

  afterEach(() => {
    db.close();
    try { unlinkSync(TEST_DB); } catch {}
  });

  it('tool → setPending → /approve → grant → retry → execute', async () => {
    const session = { id: 'session1', userId: 'user1', channelId: 'test' };

    // Step 1: Tool execution requires approval
    const first = await executor.execute('run_command', { command: 'ls -la' }, session);
    assert.equal(first.awaitingApproval, true);
    assert.ok(first.result.includes('[APPROVAL_REQUIRED]'));

    // Step 2: Verify pending state was stored
    const pending = am.getPending('session1');
    assert.ok(pending);
    assert.equal(pending.toolName, 'run_command');

    // Step 3: User sends /approve → CommandRouter handles it
    const router = new CommandRouter({
      sessionManager: { resolveSessionId: () => 'session1' },
      conversationMemory: { clearSession: () => {}, getHistory: () => [] },
      config: { compactionMemoryFlush: false },
      eventBus,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      approvalManager: am,
    });

    const cmd = await router.handle({ content: '/approve', userId: 'user1', channelId: 'test' });

    // Step 4: Verify grant was created and forwarding happens
    assert.equal(cmd.handled, true);
    assert.ok(cmd.forwardContent, 'should forward content to pipeline');
    assert.ok(cmd.forwardContent.includes('run_command'));

    // Step 5: Pending was cleared by resolve
    assert.equal(am.getPending('session1'), null);

    // Step 6: Retry tool execution — grant should bypass approval
    const second = await executor.execute('run_command', { command: 'ls -la' }, session);
    assert.equal(second.success, true);
    assert.equal(second.awaitingApproval, undefined);
    assert.equal(second.result, 'executed: ls -la');

    // Step 7: Grant was consumed — next call requires approval again
    const third = await executor.execute('run_command', { command: 'pwd' }, session);
    assert.equal(third.awaitingApproval, true);
  });

  it('tool → setPending → /reject → no grant → retry still requires approval', async () => {
    const session = { id: 'session1', userId: 'user1', channelId: 'test' };

    // Step 1: Tool execution requires approval
    await executor.execute('run_command', { command: 'rm -rf /' }, session);

    // Step 2: User rejects
    const router = new CommandRouter({
      sessionManager: { resolveSessionId: () => 'session1' },
      conversationMemory: { clearSession: () => {}, getHistory: () => [] },
      config: { compactionMemoryFlush: false },
      eventBus,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      approvalManager: am,
    });

    const cmd = await router.handle({ content: '/reject', userId: 'user1', channelId: 'test' });
    assert.equal(cmd.handled, true);
    assert.equal(cmd.forwardContent, undefined); // no forwarding on reject

    // Step 3: Retry still requires approval
    const retry = await executor.execute('run_command', { command: 'rm -rf /' }, session);
    assert.equal(retry.awaitingApproval, true);
  });

  it('Telegram /approve@BotName works in full flow', async () => {
    const session = { id: 'session1', userId: 'user1', channelId: 'telegram' };

    // Step 1: Tool requires approval
    await executor.execute('run_command', { command: 'echo hello' }, session);

    // Step 2: Telegram user sends /approve@AgentCoreBot
    const router = new CommandRouter({
      sessionManager: { resolveSessionId: () => 'session1' },
      conversationMemory: { clearSession: () => {}, getHistory: () => [] },
      config: { compactionMemoryFlush: false },
      eventBus,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      approvalManager: am,
    });

    const cmd = await router.handle({ content: '/approve@AgentCoreBot', userId: 'user1', channelId: 'telegram' });
    assert.equal(cmd.handled, true);
    assert.ok(cmd.forwardContent);

    // Step 3: Tool executes after grant
    const retry = await executor.execute('run_command', { command: 'echo hello' }, session);
    assert.equal(retry.success, true);
    assert.equal(retry.result, 'executed: echo hello');
  });
});
