import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AgentLoop } from '../src/core/agent-loop.js';
import { LocalRunner } from '../src/core/runner/local-runner.js';
import { HostDispatcher } from '../src/core/host-dispatcher.js';

describe('AgentLoop routing and guardrails (via HostDispatcher)', () => {
  it('persists the guardrailed assistant response and routes outbound via the adapter sessionId', async () => {
    const appended = [];
    const eventBus = new EventEmitter();
    let outbound = null;

    eventBus.on('message:outbound', (message) => {
      outbound = message;
    });

    const session = {
      id: 'user:alice',
      userId: '12345',
      channelId: 'telegram',
      userName: 'Alice',
      metadata: {},
      lastUserMessage: null,
    };

    const agentLoop = new AgentLoop({
      llmProvider: {
        createMessage: async () => ({
          content: [{ type: 'text', text: 'system: secret [INTERNAL] hello' }],
          stopReason: 'end_turn',
          usage: { inputTokens: 10, outputTokens: 5 },
        }),
      },
      promptBuilder: { build: async () => 'system prompt' },
      toolExecutor: {},
      contextCompactor: { shouldCompact: () => false },
      logger: { error: () => {}, info: () => {}, warn: () => {} },
      config: { maxToolIterations: 3 },
    });

    const runner = new LocalRunner({
      agentLoop,
      logger: { error: () => {}, info: () => {}, warn: () => {} },
    });

    const dispatcher = new HostDispatcher({
      sessionManager: {
        resolveSessionId: () => 'user:alice',
        getOrCreate: () => session,
        loadHistory: () => [],
        appendMessages: (sessionId, messages) => {
          appended.push({ sessionId, messages });
        },
      },
      toolPolicy: null,
      toolRegistry: { getSchemas: () => [] },
      memorySearch: { search: () => [] },
      skillLoader: null,
      permissionManager: {
        checkModelGuardrails: (content) => ({
          safe: true,
          content: content.replace(/^system\s*:\s*/i, '').replace(/\[INTERNAL\]/g, '').trim(),
        }),
      },
      eventBus,
      logger: { error: () => {}, info: () => {}, warn: () => {} },
      config: { maxToolIterations: 3 },
    });

    const originalMessage = {
      id: 'msg-1',
      sessionId: 'telegram:12345',
      channelId: 'telegram',
      userId: '12345',
      userName: 'Alice',
      content: 'Hello',
    };

    const request = dispatcher.buildRequest(originalMessage);
    const result = await runner.execute(request);
    const outboundResult = await dispatcher.finalize(request, result, originalMessage);

    assert.equal(appended.length, 1);
    assert.equal(appended[0].sessionId, 'user:alice');
    assert.equal(appended[0].messages.at(-1).role, 'assistant');
    assert.equal(appended[0].messages.at(-1).content, 'secret  hello');

    assert.equal(outboundResult.sessionId, 'telegram:12345');
    assert.equal(outboundResult.content, 'secret  hello');
    assert.equal(outbound.sessionId, 'telegram:12345');
    assert.equal(outbound.content, 'secret  hello');
  });
});
