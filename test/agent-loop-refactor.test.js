import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop } from '../src/core/agent-loop.js';

function makeLoop(overrides = {}) {
  return new AgentLoop({
    llmProvider: overrides.llmProvider || {
      createMessage: async () => ({
        content: [{ type: 'text', text: 'Hello!' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    },
    promptBuilder: overrides.promptBuilder || { build: async () => 'system prompt' },
    toolExecutor: overrides.toolExecutor || {},
    contextCompactor: overrides.contextCompactor || { shouldCompact: () => false },
    logger: { error: () => {}, info: () => {}, warn: () => {} },
    config: { maxToolIterations: overrides.maxIterations || 25 },
  });
}

function makeParams(overrides = {}) {
  return {
    history: overrides.history || [],
    userContent: overrides.userContent || 'Hello',
    toolSchemas: overrides.toolSchemas || [],
    allowedToolNames: overrides.allowedToolNames || null,
    memorySnippets: overrides.memorySnippets || [],
    skillInstructions: overrides.skillInstructions || null,
    sessionMetadata: overrides.sessionMetadata || { sessionId: 'test', userId: 'u1', channelId: 'c1' },
    maxIterations: overrides.maxIterations || 25,
    cancellationSignal: overrides.cancellationSignal || { cancelled: false },
  };
}

describe('AgentLoop (refactored)', () => {
  it('works with pre-loaded history', async () => {
    const loop = makeLoop();
    const result = await loop.processMessage(makeParams({
      history: [
        { role: 'user', content: 'previous message' },
        { role: 'assistant', content: 'previous response' },
      ],
    }));

    assert.equal(result.status, 'completed');
    assert.equal(result.content, 'Hello!');
  });

  it('returns newMessages for host persistence', async () => {
    const loop = makeLoop();
    const result = await loop.processMessage(makeParams());

    assert.ok(result.newMessages.length >= 2);
    assert.equal(result.newMessages[0].role, 'user');
    assert.equal(result.newMessages[0].content, 'Hello');
    assert.equal(result.newMessages[result.newMessages.length - 1].role, 'assistant');
    assert.equal(result.newMessages[result.newMessages.length - 1].content, 'Hello!');
  });

  it('does not emit message:outbound', async () => {
    // The refactored AgentLoop has no eventBus reference
    const loop = makeLoop();
    const result = await loop.processMessage(makeParams());

    // If we got here without error, the loop doesn't try to emit
    assert.equal(result.status, 'completed');
  });

  it('does not call sessionManager.appendMessages', async () => {
    // The refactored AgentLoop has no sessionManager reference
    const loop = makeLoop();
    const result = await loop.processMessage(makeParams());

    // Success means it doesn't try to call appendMessages
    assert.equal(result.status, 'completed');
    assert.ok(result.newMessages.length > 0);
  });

  it('checks cancellationSignal between iterations', async () => {
    let callCount = 0;
    const signal = { cancelled: false };

    const loop = makeLoop({
      llmProvider: {
        createMessage: async () => {
          callCount++;
          return {
            content: [
              { type: 'tool_use', id: `tu${callCount}`, name: 'wait', input: { seconds: 1 } },
            ],
            stopReason: 'tool_use',
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        },
      },
      toolExecutor: {
        execute: async () => {
          // Cancel during tool execution so the signal is set before next iteration check
          signal.cancelled = true;
          return { success: true, result: 'done', durationMs: 10 };
        },
      },
    });

    const params = makeParams({ cancellationSignal: signal, maxIterations: 10 });
    const result = await loop.processMessage(params);

    assert.equal(result.status, 'cancelled');
    assert.equal(callCount, 1); // Only one LLM call before cancellation
  });

  it('returns structured error on LLM failure', async () => {
    const loop = makeLoop({
      llmProvider: {
        createMessage: async () => { throw new Error('API down'); },
      },
    });

    const result = await loop.processMessage(makeParams());
    assert.equal(result.status, 'error');
    assert.equal(result.error.code, 'llm_error');
    assert.ok(result.error.message.includes('API down'));
    assert.equal(result.error.retriable, true);
  });

  it('returns max_iterations status when loop exhausted', async () => {
    const loop = makeLoop({
      llmProvider: {
        createMessage: async () => ({
          content: [
            { type: 'tool_use', id: 'tu1', name: 'wait', input: { seconds: 1 } },
          ],
          stopReason: 'tool_use',
          usage: { inputTokens: 10, outputTokens: 5 },
        }),
      },
      toolExecutor: {
        execute: async () => ({ success: true, result: 'done', durationMs: 10 }),
      },
      maxIterations: 2,
    });

    const result = await loop.processMessage(makeParams({ maxIterations: 2 }));
    assert.equal(result.status, 'max_iterations');
    assert.equal(result.error.code, 'max_iterations');
    assert.ok(result.content.includes('maximum number'));
  });

  it('returns token usage and tools used', async () => {
    let callIdx = 0;
    const loop = makeLoop({
      llmProvider: {
        createMessage: async () => {
          callIdx++;
          if (callIdx === 1) {
            return {
              content: [{ type: 'tool_use', id: 'tu1', name: 'http_get', input: { url: 'http://x' } }],
              stopReason: 'tool_use',
              usage: { inputTokens: 100, outputTokens: 50 },
            };
          }
          return {
            content: [{ type: 'text', text: 'done' }],
            stopReason: 'end_turn',
            usage: { inputTokens: 200, outputTokens: 100 },
          };
        },
      },
      toolExecutor: {
        execute: async () => ({ success: true, result: 'ok', durationMs: 5 }),
      },
    });

    const result = await loop.processMessage(makeParams());
    assert.deepEqual(result.toolsUsed, ['http_get']);
    assert.equal(result.tokenUsage.inputTokens, 300);
    assert.equal(result.tokenUsage.outputTokens, 150);
    assert.equal(result.iterationCount, 2);
  });
});
