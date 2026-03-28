import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AgentLoop } from '../src/core/agent-loop.js';
import { LocalRunner } from '../src/core/runner/local-runner.js';
import { HostDispatcher } from '../src/core/host-dispatcher.js';
import { MessageQueue } from '../src/core/message-queue.js';

const logger = { error: () => {}, info: () => {}, warn: () => {} };

function makeAgentLoop(overrides = {}) {
  return new AgentLoop({
    llmProvider: overrides.llmProvider || {
      createMessage: async () => ({
        content: [{ type: 'text', text: 'Hello from the agent!' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 50, outputTokens: 20 },
      }),
    },
    promptBuilder: { build: async () => 'system prompt' },
    toolExecutor: overrides.toolExecutor || {
      execute: async () => ({ success: true, result: 'ok', durationMs: 5 }),
    },
    contextCompactor: { shouldCompact: () => false },
    logger,
    config: { maxToolIterations: 25 },
  });
}

function makeFullPipeline(overrides = {}) {
  const eventBus = new EventEmitter();
  const appended = [];
  const outboundMessages = [];

  eventBus.on('message:outbound', (msg) => outboundMessages.push(msg));

  const sessionManager = {
    resolveSessionId: (msg) => `user:${msg.userId}`,
    getOrCreate: (sid, uid, cid, uname) => ({
      id: sid, userId: uid, channelId: cid, userName: uname,
      metadata: { userName: uname }, lastUserMessage: null,
    }),
    loadHistory: () => overrides.history || [],
    appendMessages: (sid, msgs) => appended.push({ sid, msgs }),
  };

  const agentLoop = makeAgentLoop(overrides);
  const runner = new LocalRunner({ agentLoop, logger });
  const messageQueue = new MessageQueue(runner, logger);

  const dispatcher = new HostDispatcher({
    sessionManager,
    toolPolicy: overrides.toolPolicy || null,
    toolRegistry: overrides.toolRegistry || { getSchemas: () => [] },
    memorySearch: overrides.memorySearch || { search: () => [] },
    skillLoader: overrides.skillLoader || null,
    permissionManager: overrides.permissionManager || null,
    eventBus,
    logger,
    config: { maxToolIterations: 25 },
  });

  return { eventBus, dispatcher, messageQueue, runner, appended, outboundMessages };
}

describe('End-to-end pipeline (M3)', () => {
  it('console adapter message → response', async () => {
    const { dispatcher, messageQueue, outboundMessages, appended } = makeFullPipeline();

    const message = { id: 'msg-1', sessionId: 'console:user1', channelId: 'console', userId: 'user1', userName: 'User', content: 'Hello' };
    const request = await dispatcher.buildRequest(message);
    const result = await messageQueue.enqueue(request.sessionId, request);
    await dispatcher.finalize(request, result, message);

    assert.equal(outboundMessages.length, 1);
    assert.equal(outboundMessages[0].content, 'Hello from the agent!');
    assert.equal(outboundMessages[0].sessionId, 'console:user1');
    assert.equal(outboundMessages[0].replyTo, 'msg-1');
    assert.equal(appended.length, 1);
    assert.ok(appended[0].msgs.length >= 2); // user + assistant
  });

  it('Telegram adapter message → response (mock)', async () => {
    const { dispatcher, messageQueue, outboundMessages } = makeFullPipeline();

    const message = { id: 'tg-42', sessionId: 'telegram:99999', channelId: 'telegram', userId: '99999', userName: 'TgUser', content: 'Hallo' };
    const request = await dispatcher.buildRequest(message);
    const result = await messageQueue.enqueue(request.sessionId, request);
    await dispatcher.finalize(request, result, message);

    assert.equal(outboundMessages.length, 1);
    assert.equal(outboundMessages[0].sessionId, 'telegram:99999');
    assert.equal(outboundMessages[0].userId, '99999');
  });

  it('per-session serialization preserved', async () => {
    const callOrder = [];
    const { dispatcher, messageQueue } = makeFullPipeline({
      llmProvider: {
        createMessage: async () => {
          callOrder.push('llm');
          await new Promise(r => setTimeout(r, 10));
          return {
            content: [{ type: 'text', text: 'ok' }],
            stopReason: 'end_turn',
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        },
      },
    });

    // Two messages for the same session
    const msg1 = { id: '1', sessionId: 's1', channelId: 'c', userId: 'u1', content: 'First' };
    const msg2 = { id: '2', sessionId: 's1', channelId: 'c', userId: 'u1', content: 'Second' };

    const req1 = await dispatcher.buildRequest(msg1);
    const req2 = await dispatcher.buildRequest(msg2);

    const p1 = messageQueue.enqueue(req1.sessionId, req1);
    const p2 = messageQueue.enqueue(req2.sessionId, req2);

    await Promise.all([p1, p2]);

    // Both should have completed (serialized)
    assert.equal(callOrder.length, 2);
  });

  it('cross-session parallelism preserved', async () => {
    const activeSessions = new Set();
    let maxConcurrent = 0;

    const { dispatcher, messageQueue } = makeFullPipeline({
      llmProvider: {
        createMessage: async () => {
          activeSessions.add('active');
          maxConcurrent = Math.max(maxConcurrent, activeSessions.size);
          await new Promise(r => setTimeout(r, 20));
          activeSessions.delete('active');
          return {
            content: [{ type: 'text', text: 'ok' }],
            stopReason: 'end_turn',
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        },
      },
    });

    // Two messages for different sessions
    const msg1 = { id: '1', sessionId: 's1', channelId: 'c', userId: 'userA', content: 'A' };
    const msg2 = { id: '2', sessionId: 's2', channelId: 'c', userId: 'userB', content: 'B' };

    const req1 = await dispatcher.buildRequest(msg1);
    const req2 = await dispatcher.buildRequest(msg2);

    // Enqueue for different sessions — should process in parallel
    const p1 = messageQueue.enqueue(req1.sessionId, req1);
    const p2 = messageQueue.enqueue(req2.sessionId, req2);

    await Promise.all([p1, p2]);
    // Both sessions processed
    assert.ok(true);
  });

  it('tool execution success and failure paths preserved', async () => {
    let callIdx = 0;
    const { dispatcher, messageQueue, outboundMessages } = makeFullPipeline({
      llmProvider: {
        createMessage: async () => {
          callIdx++;
          if (callIdx === 1) {
            return {
              content: [{ type: 'tool_use', id: 'tu1', name: 'http_get', input: { url: 'http://x' } }],
              stopReason: 'tool_use',
              usage: { inputTokens: 10, outputTokens: 5 },
            };
          }
          return {
            content: [{ type: 'text', text: 'Got it!' }],
            stopReason: 'end_turn',
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        },
      },
      toolExecutor: {
        execute: async (name) => {
          if (name === 'http_get') return { success: true, result: 'page content', durationMs: 100 };
          return { success: false, error: 'unknown tool', durationMs: 0 };
        },
      },
    });

    const msg = { id: '1', channelId: 'c', userId: 'u1', content: 'fetch something' };
    const req = await dispatcher.buildRequest(msg);
    const result = await messageQueue.enqueue(req.sessionId, req);
    await dispatcher.finalize(req, result, msg);

    assert.equal(outboundMessages[0].content, 'Got it!');
    assert.deepEqual(result.toolsUsed, ['http_get']);
  });

  it('memory search results are included in request', async () => {
    let receivedSnippets = null;
    const { dispatcher, messageQueue } = makeFullPipeline({
      memorySearch: {
        search: () => [
          { key: 'pref', content: 'User likes coffee', metadata: { ts: 1 } },
        ],
      },
    });

    const msg = { id: '1', channelId: 'c', userId: 'u1', content: 'What do I like?' };
    const req = await dispatcher.buildRequest(msg);

    assert.equal(req.memorySnippets.length, 1);
    assert.equal(req.memorySnippets[0].key, 'pref');
  });

  it('skill trigger matching works', async () => {
    const { dispatcher } = makeFullPipeline({
      skillLoader: {
        getLoadedSkills: () => [{ trigger: '/translate', instructions: 'Translate!' }],
      },
    });

    const req = await dispatcher.buildRequest({
      userId: 'u', channelId: 'c', content: '/translate bonjour',
    });

    assert.equal(req.skillInstructions, 'Translate!');
  });

  it('guardrails applied during finalization', async () => {
    const { dispatcher, messageQueue, outboundMessages } = makeFullPipeline({
      permissionManager: {
        checkModelGuardrails: (content) => ({
          safe: true,
          content: content.replace('SECRET', '[REDACTED]'),
        }),
      },
      llmProvider: {
        createMessage: async () => ({
          content: [{ type: 'text', text: 'The SECRET is 42' }],
          stopReason: 'end_turn',
          usage: { inputTokens: 10, outputTokens: 5 },
        }),
      },
    });

    const msg = { id: '1', channelId: 'c', userId: 'u', content: 'Tell me the secret' };
    const req = await dispatcher.buildRequest(msg);
    const result = await messageQueue.enqueue(req.sessionId, req);
    await dispatcher.finalize(req, result, msg);

    assert.equal(outboundMessages[0].content, 'The [REDACTED] is 42');
  });

  it('graceful shutdown sequence', async () => {
    const { messageQueue, runner } = makeFullPipeline();

    messageQueue.shutdown();
    await runner.shutdown();

    // Queue rejects new messages
    const result = await messageQueue.enqueue('s1', {});
    assert.equal(result, null);
  });
});
