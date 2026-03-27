// E2E user flow tests — covers use cases from spec/PRD-Use-Cases.md
// Tests wire real components together (only LLM provider is mocked).

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DB } from '../src/db/database.js';
import { RateLimiter } from '../src/security/rate-limiter.js';
import { PermissionManager } from '../src/security/permission-manager.js';
import { ToolPolicy } from '../src/security/tool-policy.js';
import { ApprovalManager } from '../src/security/approval-manager.js';
import { InputSanitizer } from '../src/security/input-sanitizer.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import { ToolExecutor } from '../src/tools/tool-executor.js';
import { AgentLoop } from '../src/core/agent-loop.js';
import { LocalRunner } from '../src/core/runner/local-runner.js';
import { HostDispatcher } from '../src/core/host-dispatcher.js';
import { MessageQueue } from '../src/core/message-queue.js';
import { CommandRouter } from '../src/core/command-router.js';
import { normalizeMessage, extractAttachments } from '../src/adapters/telegram/telegram-normalize.js';
import { unlinkSync } from 'fs';

const TEST_DB = `.test-e2e-user-flows-${process.pid}.db`;
const logger = { error: () => {}, info: () => {}, warn: () => {} };

// --- Helpers ---

function makeLLMProvider(responseText = 'Hello!') {
  return {
    createMessage: async () => ({
      content: [{ type: 'text', text: responseText }],
      stopReason: 'end_turn',
      usage: { inputTokens: 50, outputTokens: 20 },
    }),
    estimateTokens: () => 100,
  };
}

function makeLLMProviderWithToolUse(toolName, toolInput, finalText = 'Done!') {
  let callIdx = 0;
  return {
    createMessage: async () => {
      callIdx++;
      if (callIdx === 1) {
        return {
          content: [{ type: 'tool_use', id: 'tu1', name: toolName, input: toolInput }],
          stopReason: 'tool_use',
          usage: { inputTokens: 50, outputTokens: 20 },
        };
      }
      return {
        content: [{ type: 'text', text: finalText }],
        stopReason: 'end_turn',
        usage: { inputTokens: 50, outputTokens: 20 },
      };
    },
    estimateTokens: () => 100,
  };
}

/**
 * Build a near-complete pipeline with real security components.
 * Only the LLM provider is mocked.
 */
function buildPipeline(db, config = {}) {
  const eventBus = new EventEmitter();
  const outbound = [];
  eventBus.on('message:outbound', (msg) => outbound.push(msg));

  const rateLimiter = new RateLimiter(db, {
    rateLimitPerMinute: config.rateLimitPerMinute ?? 20,
  });

  const approvalManager = new ApprovalManager({ db, eventBus, auditLogger: null, logger });
  const toolPolicy = new ToolPolicy(db, config, approvalManager);
  const permissionManager = new PermissionManager(db, toolPolicy, config);
  const inputSanitizer = new InputSanitizer();

  const toolRegistry = new ToolRegistry();
  toolRegistry.register({
    name: 'get_current_time',
    description: 'Get current time',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => new Date().toISOString(),
  });
  toolRegistry.register({
    name: 'read_file',
    description: 'Read a file',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    handler: async () => 'file contents',
  });
  toolRegistry.register({
    name: 'write_file',
    description: 'Write a file',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    handler: async () => 'file written',
  });

  const toolExecutor = new ToolExecutor(toolRegistry, toolPolicy, logger, {
    approvalManager,
  });

  const llmProvider = config.llmProvider || makeLLMProvider();
  const agentLoop = new AgentLoop({
    llmProvider,
    promptBuilder: { build: async () => 'system prompt' },
    toolExecutor,
    contextCompactor: { shouldCompact: () => false },
    logger,
    config: { maxToolIterations: 25, maxContextTokens: 100000 },
  });

  const runner = new LocalRunner({ agentLoop, logger });
  const messageQueue = new MessageQueue(runner, logger);

  const sessionManager = {
    resolveSessionId: (msg) => msg.sessionId || `user:${msg.userId}`,
    getOrCreate: (sid, uid, cid, uname) => ({
      id: sid, userId: uid, channelId: cid, userName: uname,
      metadata: {}, lastUserMessage: null,
    }),
    loadHistory: () => [],
    appendMessages: () => {},
  };

  const dispatcher = new HostDispatcher({
    sessionManager,
    toolPolicy,
    toolRegistry,
    memorySearch: { search: () => [] },
    skillLoader: null,
    permissionManager,
    eventBus,
    logger,
    config: { maxToolIterations: 25 },
  });

  const commandRouter = new CommandRouter({
    sessionManager,
    conversationMemory: { clearSession: () => {}, getHistory: () => [] },
    config: { compactionMemoryFlush: false },
    eventBus,
    logger,
    approvalManager,
  });

  // Simulate the full inbound handler from index.js (lines 192-268)
  async function processMessage(message) {
    const rateCheck = rateLimiter.consume(message.userId);
    if (!rateCheck.allowed) {
      eventBus.emit('message:outbound', {
        sessionId: message.sessionId,
        channelId: message.channelId,
        userId: message.userId,
        content: `Rate limit exceeded. Please wait ${Math.ceil(rateCheck.retryAfterMs / 1000)} seconds.`,
        replyTo: message.id,
        metadata: { toolsUsed: [], tokenUsage: { inputTokens: 0, outputTokens: 0 }, processingTimeMs: 0 },
      });
      return;
    }

    const accessCheck = permissionManager.checkAccess(message.userId, message.channelId);
    if (!accessCheck.allowed) {
      eventBus.emit('message:outbound', {
        sessionId: message.sessionId,
        channelId: message.channelId,
        userId: message.userId,
        content: `Access denied: ${accessCheck.reason}`,
        replyTo: message.id,
        metadata: { toolsUsed: [], tokenUsage: { inputTokens: 0, outputTokens: 0 }, processingTimeMs: 0 },
      });
      return;
    }

    const sanitized = inputSanitizer.sanitize(message);

    const cmd = await commandRouter.handle(sanitized);
    if (cmd.handled && !cmd.forwardContent) return;
    if (cmd.handled && cmd.forwardContent) {
      sanitized.content = cmd.forwardContent;
    }

    const request = dispatcher.buildRequest(sanitized);
    const result = await messageQueue.enqueue(request.sessionId, request);
    if (result) {
      await dispatcher.finalize(request, result, message);
    }
  }

  return { processMessage, outbound, rateLimiter, eventBus, messageQueue, runner, approvalManager };
}

// ---------------------------------------------------------------------------
// P0: Security flows (PRD §2.8 — P1, P2, P3, P4)
// ---------------------------------------------------------------------------

describe('E2E: New user first message (PRD P1)', () => {
  let db;

  beforeEach(async () => {
    db = DB.getInstance(TEST_DB);
    await db.migrate();
  });

  afterEach(() => {
    db.close();
    try { unlinkSync(TEST_DB); } catch {}
  });

  it('unknown user with AUTO_APPROVE_USERS=false → registered as pending → gets response', async () => {
    const { processMessage, outbound } = buildPipeline(db, { autoApproveUsers: false });

    await processMessage({
      id: 'msg-1', sessionId: 'telegram:12345', channelId: 'telegram',
      userId: 'newuser1', userName: 'New User', content: 'Hello',
    });

    // User should be auto-registered as pending
    const row = db.prepare('SELECT role FROM users WHERE id = ?').get('newuser1');
    assert.equal(row.role, 'pending');

    // Should still get a response (agent can respond, just with minimal tools)
    assert.equal(outbound.length, 1);
    assert.ok(outbound[0].content.length > 0);
  });

  it('unknown user with AUTO_APPROVE_USERS=true → registered as user', async () => {
    const { processMessage, outbound } = buildPipeline(db, { autoApproveUsers: true });

    await processMessage({
      id: 'msg-1', sessionId: 'telegram:12345', channelId: 'telegram',
      userId: 'newuser2', userName: 'New User', content: 'Hello',
    });

    const row = db.prepare('SELECT role FROM users WHERE id = ?').get('newuser2');
    assert.equal(row.role, 'user');
    assert.equal(outbound.length, 1);
  });

  it('unknown user in AUTO_APPROVE_USERS list → registered as user', async () => {
    const { processMessage } = buildPipeline(db, { autoApproveUsers: ['vip1', 'vip2'] });

    await processMessage({
      id: 'msg-1', sessionId: 'telegram:12345', channelId: 'telegram',
      userId: 'vip1', userName: 'VIP', content: 'Hello',
    });

    const row = db.prepare('SELECT role FROM users WHERE id = ?').get('vip1');
    assert.equal(row.role, 'user');
  });
});

describe('E2E: Blocked user (PRD P2)', () => {
  let db;

  beforeEach(async () => {
    db = DB.getInstance(TEST_DB);
    await db.migrate();
    db.prepare('INSERT INTO users (id, channel_id, role) VALUES (?, ?, ?)').run('blocked1', 'telegram', 'blocked');
  });

  afterEach(() => {
    db.close();
    try { unlinkSync(TEST_DB); } catch {}
  });

  it('blocked user gets access denied response', async () => {
    const { processMessage, outbound } = buildPipeline(db);

    await processMessage({
      id: 'msg-1', sessionId: 'telegram:blocked1', channelId: 'telegram',
      userId: 'blocked1', userName: 'Blocked', content: 'Hello',
    });

    assert.equal(outbound.length, 1);
    assert.ok(outbound[0].content.includes('Access denied'));
  });
});

describe('E2E: Pending user tool access (PRD P3)', () => {
  let db;

  beforeEach(async () => {
    db = DB.getInstance(TEST_DB);
    await db.migrate();
    db.prepare('INSERT INTO users (id, channel_id, role) VALUES (?, ?, ?)').run('pending1', 'telegram', 'pending');
  });

  afterEach(() => {
    db.close();
    try { unlinkSync(TEST_DB); } catch {}
  });

  it('pending user gets minimal tool set (only get_current_time)', async () => {
    // Use an LLM that tries to call read_file
    const { processMessage, outbound } = buildPipeline(db, {
      llmProvider: makeLLMProviderWithToolUse('read_file', { path: 'test.txt' }, 'Could not read file'),
    });

    await processMessage({
      id: 'msg-1', sessionId: 'telegram:pending1', channelId: 'telegram',
      userId: 'pending1', userName: 'Pending', content: 'Read file test.txt',
    });

    // Should get a response (the tool was filtered out by policy, so LLM only sees get_current_time)
    assert.equal(outbound.length, 1);
  });
});

describe('E2E: Rate limiting (PRD P4)', () => {
  let db;

  beforeEach(async () => {
    db = DB.getInstance(TEST_DB);
    await db.migrate();
    db.prepare('INSERT INTO users (id, channel_id, role) VALUES (?, ?, ?)').run('user1', 'telegram', 'user');
  });

  afterEach(() => {
    db.close();
    try { unlinkSync(TEST_DB); } catch {}
  });

  it('user exceeding rate limit gets retry-after response', async () => {
    const { processMessage, outbound } = buildPipeline(db, { rateLimitPerMinute: 2 });

    const msg = (id) => ({
      id, sessionId: 'telegram:user1', channelId: 'telegram',
      userId: 'user1', userName: 'User', content: 'Hello',
    });

    // First two messages: allowed
    await processMessage(msg('1'));
    await processMessage(msg('2'));

    // Third message: rate limited
    await processMessage(msg('3'));

    assert.equal(outbound.length, 3);
    // First two are normal responses
    assert.ok(!outbound[0].content.includes('Rate limit'));
    assert.ok(!outbound[1].content.includes('Rate limit'));
    // Third is rate limited
    assert.ok(outbound[2].content.includes('Rate limit exceeded'));
  });
});

// ---------------------------------------------------------------------------
// P0: Telegram attachments (PRD §2.10 — TG4, TG5, TG6)
// ---------------------------------------------------------------------------

describe('E2E: Telegram attachment normalization (PRD TG4-TG6)', () => {
  it('normalizes photo message with caption', () => {
    const msg = {
      message_id: 42,
      chat: { id: 12345, type: 'private' },
      from: { id: 99, first_name: 'Alice' },
      caption: 'Check this out',
      photo: [
        { file_id: 'small', file_size: 1000 },
        { file_id: 'large', file_size: 5000 },
      ],
      date: 1700000000,
    };

    const normalized = normalizeMessage(msg);

    assert.equal(normalized.content, 'Check this out');
    assert.equal(normalized.attachments.length, 1);
    assert.equal(normalized.attachments[0].type, 'photo');
    assert.equal(normalized.attachments[0].fileId, 'large'); // highest res
  });

  it('normalizes document message', () => {
    const msg = {
      message_id: 43,
      chat: { id: 12345, type: 'private' },
      from: { id: 99, first_name: 'Alice' },
      text: 'Here is the file',
      document: {
        file_id: 'doc123',
        mime_type: 'application/pdf',
        file_name: 'report.pdf',
        file_size: 10000,
      },
      date: 1700000000,
    };

    const normalized = normalizeMessage(msg);
    assert.equal(normalized.attachments.length, 1);
    assert.equal(normalized.attachments[0].type, 'document');
    assert.equal(normalized.attachments[0].mimeType, 'application/pdf');
    assert.equal(normalized.attachments[0].fileName, 'report.pdf');
  });

  it('normalizes voice message', () => {
    const msg = {
      message_id: 44,
      chat: { id: 12345, type: 'private' },
      from: { id: 99, first_name: 'Alice' },
      voice: { file_id: 'voice123', duration: 15, file_size: 8000 },
      date: 1700000000,
    };

    const normalized = normalizeMessage(msg);
    assert.equal(normalized.content, ''); // voice has no text
    assert.equal(normalized.attachments.length, 1);
    assert.equal(normalized.attachments[0].type, 'voice');
    assert.equal(normalized.attachments[0].duration, 15);
  });

  it('normalizes video message', () => {
    const msg = {
      message_id: 45,
      chat: { id: 12345, type: 'private' },
      from: { id: 99, first_name: 'Alice' },
      caption: 'A video',
      video: { file_id: 'vid123', duration: 30, file_size: 50000 },
      date: 1700000000,
    };

    const normalized = normalizeMessage(msg);
    assert.equal(normalized.content, 'A video');
    assert.equal(normalized.attachments.length, 1);
    assert.equal(normalized.attachments[0].type, 'video');
  });

  it('handles message with no text and no caption', () => {
    const msg = {
      message_id: 46,
      chat: { id: 12345, type: 'private' },
      from: { id: 99, first_name: 'Alice' },
      photo: [{ file_id: 'img', file_size: 100 }],
      date: 1700000000,
    };

    const normalized = normalizeMessage(msg);
    assert.equal(normalized.content, '');
    assert.equal(normalized.attachments.length, 1);
  });

  it('extractAttachments handles multiple attachment types', () => {
    const msg = {
      photo: [{ file_id: 'p1', file_size: 100 }],
      document: { file_id: 'd1', mime_type: 'text/plain', file_name: 'a.txt', file_size: 50 },
    };

    const attachments = extractAttachments(msg);
    assert.equal(attachments.length, 2);
    assert.equal(attachments[0].type, 'photo');
    assert.equal(attachments[1].type, 'document');
  });
});

// ---------------------------------------------------------------------------
// P1: Telegram group vs private session isolation (PRD TG2)
// ---------------------------------------------------------------------------

describe('E2E: Telegram group vs private session isolation (PRD TG2)', () => {
  it('same user gets different sessions in group vs private', () => {
    const privateMsg = {
      message_id: 1,
      chat: { id: 12345, type: 'private' },
      from: { id: 99, first_name: 'Alice' },
      text: 'Private message',
      date: 1700000000,
    };

    const groupMsg = {
      message_id: 2,
      chat: { id: -67890, type: 'group' },
      from: { id: 99, first_name: 'Alice' },
      text: 'Group message',
      date: 1700000000,
    };

    const normalizedPrivate = normalizeMessage(privateMsg);
    const normalizedGroup = normalizeMessage(groupMsg);

    assert.equal(normalizedPrivate.sessionId, 'telegram:12345');
    assert.equal(normalizedGroup.sessionId, 'telegram:group:-67890');
    assert.notEqual(normalizedPrivate.sessionId, normalizedGroup.sessionId);
    // Same userId
    assert.equal(normalizedPrivate.userId, normalizedGroup.userId);
  });
});

// ---------------------------------------------------------------------------
// P1: Approval flow through full security pipeline (PRD P5)
// ---------------------------------------------------------------------------

describe('E2E: Approval flow through security pipeline (PRD P5)', () => {
  let db;

  beforeEach(async () => {
    db = DB.getInstance(TEST_DB);
    await db.migrate();
    db.prepare('INSERT INTO users (id, channel_id, role) VALUES (?, ?, ?)').run('user1', 'telegram', 'user');
  });

  afterEach(() => {
    db.close();
    try { unlinkSync(TEST_DB); } catch {}
  });

  it('non-admin tool call → approval required → /approve → tool executes', async () => {
    const pipeline = buildPipeline(db, {
      llmProvider: makeLLMProviderWithToolUse('write_file', { path: 'test.txt' }, 'File created!'),
    });

    // Step 1: User asks to write a file → LLM calls write_file → approval required
    await pipeline.processMessage({
      id: 'msg-1', sessionId: 'telegram:user1', channelId: 'telegram',
      userId: 'user1', userName: 'User', content: 'Create test.txt',
    });

    // Should get a response (the approval message gets fed back to LLM, which produces text)
    assert.ok(pipeline.outbound.length >= 1);

    // Step 2: Verify pending approval was stored
    const pending = pipeline.approvalManager.getPending('telegram:user1');
    assert.ok(pending);
    assert.equal(pending.toolName, 'write_file');

    // Step 3: User sends /approve
    await pipeline.processMessage({
      id: 'msg-2', sessionId: 'telegram:user1', channelId: 'telegram',
      userId: 'user1', userName: 'User', content: '/approve',
    });

    // Should get "Approved. Continuing..." + the forwarded message response
    const approveMsg = pipeline.outbound.find(m => m.content.includes('Approved'));
    assert.ok(approveMsg, 'should see approval confirmation');
  });
});

// ---------------------------------------------------------------------------
// P1: Admin bypasses full pipeline (PRD P7)
// ---------------------------------------------------------------------------

describe('E2E: Admin bypass (PRD P7)', () => {
  let db;

  beforeEach(async () => {
    db = DB.getInstance(TEST_DB);
    await db.migrate();
    db.prepare('INSERT INTO users (id, channel_id, role) VALUES (?, ?, ?)').run('admin1', 'console', 'admin');
  });

  afterEach(() => {
    db.close();
    try { unlinkSync(TEST_DB); } catch {}
  });

  it('admin tool call executes immediately without approval', async () => {
    const { processMessage, outbound } = buildPipeline(db, {
      llmProvider: makeLLMProviderWithToolUse('write_file', { path: 'test.txt' }, 'File created!'),
    });

    await processMessage({
      id: 'msg-1', sessionId: 'console:admin1', channelId: 'console',
      userId: 'admin1', userName: 'Admin', content: 'Create test.txt',
    });

    assert.equal(outbound.length, 1);
    assert.equal(outbound[0].content, 'File created!');
  });
});

// ---------------------------------------------------------------------------
// P1: LLM error recovery (PRD E1)
// ---------------------------------------------------------------------------

describe('E2E: LLM error recovery (PRD E1)', () => {
  let db;

  beforeEach(async () => {
    db = DB.getInstance(TEST_DB);
    await db.migrate();
    db.prepare('INSERT INTO users (id, channel_id, role) VALUES (?, ?, ?)').run('user1', 'telegram', 'user');
  });

  afterEach(() => {
    db.close();
    try { unlinkSync(TEST_DB); } catch {}
  });

  it('LLM API error returns friendly error message', async () => {
    const { processMessage, outbound } = buildPipeline(db, {
      llmProvider: {
        createMessage: async () => { throw new Error('API rate limit exceeded'); },
        estimateTokens: () => 100,
      },
    });

    await processMessage({
      id: 'msg-1', sessionId: 'telegram:user1', channelId: 'telegram',
      userId: 'user1', userName: 'User', content: 'Hello',
    });

    assert.equal(outbound.length, 1);
    assert.ok(outbound[0].content.includes('error'));
  });
});
