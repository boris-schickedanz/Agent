import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRunner, RunnerUnavailableError } from '../src/core/runner/agent-runner.js';
import { LocalRunner } from '../src/core/runner/local-runner.js';
import { createExecutionRequest, ExecutionOrigin } from '../src/core/runner/execution-request.js';
import { createExecutionResult, ExecutionStatus } from '../src/core/runner/execution-result.js';

// --- AgentRunner base class ---

describe('AgentRunner', () => {
  it('execute() throws "must be implemented"', async () => {
    const runner = new AgentRunner();
    await assert.rejects(() => runner.execute({}), { message: 'AgentRunner.execute() must be implemented' });
  });

  it('cancel() returns false by default', async () => {
    const runner = new AgentRunner();
    assert.equal(await runner.cancel('some-id'), false);
  });

  it('shutdown() is a no-op by default', async () => {
    const runner = new AgentRunner();
    await runner.shutdown(); // should not throw
  });
});

// --- ExecutionRequest ---

describe('ExecutionRequest', () => {
  it('factory produces valid shape with all fields', () => {
    const req = createExecutionRequest({
      origin: ExecutionOrigin.USER_MESSAGE,
      sessionId: 'user:alice',
      userId: 'alice',
      channelId: 'console',
      userContent: 'Hello',
    });

    assert.ok(req.executionId);
    assert.equal(req.origin, 'user_message');
    assert.equal(req.sessionId, 'user:alice');
    assert.equal(req.userId, 'alice');
    assert.equal(req.channelId, 'console');
    assert.equal(req.userContent, 'Hello');
    assert.equal(req.userName, null);
    assert.deepEqual(req.sessionMetadata, {});
    assert.deepEqual(req.history, []);
    assert.deepEqual(req.toolSchemas, []);
    assert.equal(req.allowedToolNames, null);
    assert.equal(req.skillInstructions, null);
    assert.deepEqual(req.memorySnippets, []);
    assert.equal(req.maxIterations, 25);
    assert.equal(req.timeoutMs, null);
    assert.ok(req.createdAt > 0);
  });

  it('throws on missing required fields', () => {
    assert.throws(() => createExecutionRequest({ origin: 'user_message', sessionId: 's', userId: 'u', channelId: 'c' }), /requires userContent/);
    assert.throws(() => createExecutionRequest({ origin: 'user_message', sessionId: 's', userId: 'u', userContent: 'x' }), /requires channelId/);
    assert.throws(() => createExecutionRequest({ origin: 'user_message', sessionId: 's', channelId: 'c', userContent: 'x' }), /requires userId/);
    assert.throws(() => createExecutionRequest({ origin: 'user_message', userId: 'u', channelId: 'c', userContent: 'x' }), /requires sessionId/);
    assert.throws(() => createExecutionRequest({ sessionId: 's', userId: 'u', channelId: 'c', userContent: 'x' }), /requires origin/);
  });

  it('uses provided executionId and createdAt', () => {
    const req = createExecutionRequest({
      executionId: 'custom-id',
      origin: ExecutionOrigin.SCHEDULED_TASK,
      sessionId: 'heartbeat:system',
      userId: 'system',
      channelId: 'heartbeat',
      userContent: 'tick',
      createdAt: 1000,
    });

    assert.equal(req.executionId, 'custom-id');
    assert.equal(req.createdAt, 1000);
  });
});

// --- ExecutionResult ---

describe('ExecutionResult', () => {
  it('factory produces valid shape', () => {
    const res = createExecutionResult({
      executionId: 'id-1',
      status: ExecutionStatus.COMPLETED,
      content: 'Hello!',
      newMessages: [{ role: 'user', content: 'Hi' }],
      toolsUsed: ['http_get'],
      tokenUsage: { inputTokens: 100, outputTokens: 50 },
      iterationCount: 2,
      durationMs: 1500,
    });

    assert.equal(res.executionId, 'id-1');
    assert.equal(res.status, 'completed');
    assert.equal(res.content, 'Hello!');
    assert.equal(res.newMessages.length, 1);
    assert.deepEqual(res.toolsUsed, ['http_get']);
    assert.equal(res.tokenUsage.inputTokens, 100);
    assert.equal(res.iterationCount, 2);
    assert.equal(res.durationMs, 1500);
    assert.equal(res.error, null);
  });

  it('status values are exhaustive', () => {
    const statuses = Object.values(ExecutionStatus);
    assert.ok(statuses.includes('completed'));
    assert.ok(statuses.includes('max_iterations'));
    assert.ok(statuses.includes('error'));
    assert.ok(statuses.includes('cancelled'));
    assert.ok(statuses.includes('timeout'));
    assert.equal(statuses.length, 5);
  });

  it('throws on missing required fields', () => {
    assert.throws(() => createExecutionResult({ status: 'completed' }), /requires executionId/);
    assert.throws(() => createExecutionResult({ executionId: 'id' }), /requires status/);
  });

  it('throws on invalid status', () => {
    assert.throws(() => createExecutionResult({ executionId: 'id', status: 'invalid' }), /Invalid ExecutionStatus/);
  });
});

// --- LocalRunner ---

describe('LocalRunner', () => {
  function makeLogger() {
    return { error: () => {}, info: () => {}, warn: () => {} };
  }

  function makeRequest(overrides = {}) {
    return createExecutionRequest({
      origin: ExecutionOrigin.USER_MESSAGE,
      sessionId: 'user:alice',
      userId: 'alice',
      channelId: 'console',
      userContent: 'Hello',
      ...overrides,
    });
  }

  it('execute() calls agentLoop.processMessage and translates result', async () => {
    let receivedParams = null;
    const fakeLoop = {
      processMessage: async (params) => {
        receivedParams = params;
        return {
          content: 'Hi there!',
          newMessages: [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hi there!' }],
          toolsUsed: [],
          tokenUsage: { inputTokens: 50, outputTokens: 20 },
          iterationCount: 1,
          status: 'completed',
        };
      },
    };

    const runner = new LocalRunner({ agentLoop: fakeLoop, logger: makeLogger() });
    const request = makeRequest();
    const result = await runner.execute(request);

    // Verify delegation
    assert.deepEqual(receivedParams.history, []);
    assert.equal(receivedParams.userContent, 'Hello');
    assert.equal(receivedParams.maxIterations, 25);

    // Verify result translation
    assert.equal(result.executionId, request.executionId);
    assert.equal(result.status, 'completed');
    assert.equal(result.content, 'Hi there!');
    assert.equal(result.newMessages.length, 2);
    assert.ok(result.durationMs >= 0);
  });

  it('execute() translates request to loop format with all fields', async () => {
    let receivedParams = null;
    const fakeLoop = {
      processMessage: async (params) => {
        receivedParams = params;
        return { content: 'ok', newMessages: [], status: 'completed' };
      },
    };

    const runner = new LocalRunner({ agentLoop: fakeLoop, logger: makeLogger() });
    const request = makeRequest({
      history: [{ role: 'user', content: 'prev' }],
      memorySnippets: [{ key: 'k', content: 'c', metadata: {} }],
      skillInstructions: 'do things',
      sessionMetadata: { userName: 'Alice' },
      maxIterations: 10,
    });

    await runner.execute(request);

    assert.deepEqual(receivedParams.history, [{ role: 'user', content: 'prev' }]);
    assert.deepEqual(receivedParams.memorySnippets, [{ key: 'k', content: 'c', metadata: {} }]);
    assert.equal(receivedParams.skillInstructions, 'do things');
    assert.deepEqual(receivedParams.sessionMetadata, { userName: 'Alice' });
    assert.equal(receivedParams.maxIterations, 10);
    assert.ok(receivedParams.cancellationSignal);
    assert.equal(receivedParams.cancellationSignal.cancelled, false);
  });

  it('cancel() sets cancellation flag', async () => {
    let resolveLoop;
    const fakeLoop = {
      processMessage: async () => new Promise(r => { resolveLoop = r; }),
    };

    const runner = new LocalRunner({ agentLoop: fakeLoop, logger: makeLogger() });
    const request = makeRequest();

    // Start execution without awaiting
    const execPromise = runner.execute(request);

    // Cancel
    const cancelled = await runner.cancel(request.executionId);
    assert.equal(cancelled, true);

    // Resolve the loop
    resolveLoop({ content: 'partial', newMessages: [], status: 'cancelled' });
    const result = await execPromise;
    assert.equal(result.status, 'cancelled');
  });

  it('cancel() returns false for unknown executionId', async () => {
    const runner = new LocalRunner({ agentLoop: {}, logger: makeLogger() });
    assert.equal(await runner.cancel('nonexistent'), false);
  });

  it('shutdown() rejects subsequent execute calls', async () => {
    const runner = new LocalRunner({ agentLoop: {}, logger: makeLogger() });
    await runner.shutdown();

    const request = makeRequest();
    await assert.rejects(() => runner.execute(request), RunnerUnavailableError);
  });

  it('rejects duplicate executionId', async () => {
    let resolveLoop;
    const fakeLoop = {
      processMessage: async () => new Promise(r => { resolveLoop = r; }),
    };

    const runner = new LocalRunner({ agentLoop: fakeLoop, logger: makeLogger() });
    const request = makeRequest({ executionId: 'dup-id' });

    // Start first execution
    const exec1 = runner.execute(request);

    // Try duplicate
    await assert.rejects(() => runner.execute(request), RunnerUnavailableError);

    resolveLoop({ content: 'done', newMessages: [], status: 'completed' });
    await exec1;
  });

  it('returns error result on agentLoop exception', async () => {
    const fakeLoop = {
      processMessage: async () => { throw new Error('LLM exploded'); },
    };

    const runner = new LocalRunner({ agentLoop: fakeLoop, logger: makeLogger() });
    const request = makeRequest();
    const result = await runner.execute(request);

    assert.equal(result.status, 'error');
    assert.equal(result.error.code, 'runtime_error');
    assert.ok(result.error.message.includes('LLM exploded'));
  });
});
