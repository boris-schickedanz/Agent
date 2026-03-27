import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { HostDispatcher } from '../src/core/host-dispatcher.js';

function makeDispatcher(overrides = {}) {
  const eventBus = overrides.eventBus || new EventEmitter();

  return new HostDispatcher({
    sessionManager: overrides.sessionManager || {
      resolveSessionId: (msg) => `user:${msg.userId}`,
      getOrCreate: (sid, uid, cid, uname) => ({
        id: sid, userId: uid, channelId: cid, userName: uname,
        metadata: { userName: uname }, lastUserMessage: null,
      }),
      loadHistory: () => overrides.history || [],
      appendMessages: overrides.appendMessages || (() => {}),
    },
    toolPolicy: overrides.toolPolicy || null,
    toolRegistry: overrides.toolRegistry || {
      getSchemas: () => [{ name: 'get_current_time', description: 'Get time', input_schema: {} }],
    },
    memorySearch: overrides.memorySearch || {
      search: () => [],
    },
    skillLoader: overrides.skillLoader || null,
    permissionManager: overrides.permissionManager || null,
    eventBus,
    logger: { error: () => {}, info: () => {}, warn: () => {} },
    config: { maxToolIterations: 25 },
  });
}

describe('HostDispatcher.buildRequest', () => {
  it('produces valid ExecutionRequest shape', () => {
    const dispatcher = makeDispatcher();
    const req = dispatcher.buildRequest({
      userId: 'alice',
      channelId: 'console',
      userName: 'Alice',
      content: 'Hello',
    });

    assert.ok(req.executionId);
    assert.equal(req.origin, 'user_message');
    assert.equal(req.sessionId, 'user:alice');
    assert.equal(req.userId, 'alice');
    assert.equal(req.channelId, 'console');
    assert.equal(req.userName, 'Alice');
    assert.equal(req.userContent, 'Hello');
    assert.ok(Array.isArray(req.history));
    assert.ok(Array.isArray(req.toolSchemas));
    assert.equal(req.toolSchemas.length, 1);
    assert.equal(req.maxIterations, 25);
    assert.ok(req.createdAt > 0);
  });

  it('resolves session and loads history', () => {
    let resolvedId = null;
    let loadedSession = null;

    const dispatcher = makeDispatcher({
      sessionManager: {
        resolveSessionId: (msg) => { resolvedId = `user:${msg.userId}`; return resolvedId; },
        getOrCreate: (sid) => { loadedSession = sid; return { id: sid, metadata: {}, lastUserMessage: null }; },
        loadHistory: (sid) => [{ role: 'user', content: 'prev' }],
        appendMessages: () => {},
      },
    });

    const req = dispatcher.buildRequest({
      userId: 'bob',
      channelId: 'telegram',
      content: 'Hi',
    });

    assert.equal(resolvedId, 'user:bob');
    assert.equal(loadedSession, 'user:bob');
    assert.equal(req.history.length, 1);
  });

  it('includes tool schemas filtered by policy (annotated return)', () => {
    // Spec 23: getEffectiveToolNames now returns { name, requiresApproval }[]
    const dispatcher = makeDispatcher({
      toolPolicy: {
        getEffectiveToolNames: () => [
          { name: 'get_current_time', requiresApproval: false },
          { name: 'read_file', requiresApproval: false },
          { name: 'run_command', requiresApproval: true },
        ],
      },
      toolRegistry: {
        getSchemas: (filter) => {
          assert.ok(filter instanceof Set);
          assert.ok(filter.has('get_current_time'));
          assert.ok(filter.has('read_file'));
          assert.ok(filter.has('run_command'));
          return [
            { name: 'get_current_time', description: 'Get time', input_schema: {} },
            { name: 'read_file', description: 'Read file', input_schema: {} },
            { name: 'run_command', description: 'Run command', input_schema: {} },
          ];
        },
      },
    });

    const req = dispatcher.buildRequest({
      userId: 'alice',
      channelId: 'console',
      content: 'What time?',
    });

    assert.equal(req.toolSchemas.length, 3);
  });

  it('extracts .name from annotated tool list for Set filtering', () => {
    // Spec 23: HostDispatcher must extract .name from { name, requiresApproval }[]
    let receivedFilter = null;
    const dispatcher = makeDispatcher({
      toolPolicy: {
        getEffectiveToolNames: () => [
          { name: 'write_file', requiresApproval: true },
          { name: 'list_directory', requiresApproval: false },
        ],
      },
      toolRegistry: {
        getSchemas: (filter) => {
          receivedFilter = filter;
          return [];
        },
      },
    });

    dispatcher.buildRequest({
      userId: 'alice',
      channelId: 'console',
      content: 'test',
    });

    assert.ok(receivedFilter instanceof Set);
    assert.ok(receivedFilter.has('write_file'));
    assert.ok(receivedFilter.has('list_directory'));
    // Should not contain the object itself
    assert.equal(receivedFilter.size, 2);
  });

  it('handles null from getEffectiveToolNames (admin/full profile)', () => {
    // Spec 23: null means all tools — no filtering
    const dispatcher = makeDispatcher({
      toolPolicy: {
        getEffectiveToolNames: () => null,
      },
      toolRegistry: {
        getSchemas: (filter) => {
          assert.equal(filter, null);
          return [{ name: 'get_current_time', description: 'Get time', input_schema: {} }];
        },
      },
    });

    const req = dispatcher.buildRequest({
      userId: 'admin',
      channelId: 'console',
      content: 'do anything',
    });

    assert.equal(req.toolSchemas.length, 1);
  });

  it('matches skill triggers', () => {
    const dispatcher = makeDispatcher({
      skillLoader: {
        getLoadedSkills: () => [
          { trigger: '/translate', instructions: 'Translate the following text' },
          { trigger: '/summarize', instructions: 'Summarize the following' },
        ],
      },
    });

    const req = dispatcher.buildRequest({
      userId: 'alice',
      channelId: 'console',
      content: '/translate hello world',
    });

    assert.equal(req.skillInstructions, 'Translate the following text');
  });

  it('searches memory', () => {
    const dispatcher = makeDispatcher({
      memorySearch: {
        search: (query, limit) => {
          assert.equal(query, 'What do I like?');
          assert.equal(limit, 5);
          return [{ key: 'prefs', content: 'User likes coffee and long walks', metadata: { ts: 123 } }];
        },
      },
    });

    const req = dispatcher.buildRequest({
      userId: 'alice',
      channelId: 'console',
      content: 'What do I like?',
    });

    assert.equal(req.memorySnippets.length, 1);
    assert.equal(req.memorySnippets[0].key, 'prefs');
  });

  it('handles memory search failure gracefully', () => {
    const dispatcher = makeDispatcher({
      memorySearch: {
        search: () => { throw new Error('FTS broken'); },
      },
    });

    const req = dispatcher.buildRequest({
      userId: 'alice',
      channelId: 'console',
      content: 'test',
    });

    assert.deepEqual(req.memorySnippets, []);
  });
});

describe('HostDispatcher.finalize', () => {
  it('applies guardrails, persists, and emits', async () => {
    let persisted = null;
    let emitted = null;
    const eventBus = new EventEmitter();
    eventBus.on('message:outbound', (msg) => { emitted = msg; });

    const dispatcher = makeDispatcher({
      eventBus,
      sessionManager: {
        resolveSessionId: () => 'user:alice',
        getOrCreate: () => ({ id: 'user:alice', metadata: {}, lastUserMessage: null }),
        loadHistory: () => [],
        appendMessages: (sid, msgs) => { persisted = { sid, msgs }; },
      },
      permissionManager: {
        checkModelGuardrails: (content) => ({
          safe: true,
          content: content.replace('SECRET', '[REDACTED]'),
        }),
      },
    });

    const request = {
      executionId: 'exec-1',
      sessionId: 'user:alice',
      channelId: 'console',
      userId: 'alice',
    };

    const result = {
      content: 'Here is SECRET data',
      newMessages: [
        { role: 'user', content: 'tell me' },
        { role: 'assistant', content: 'Here is SECRET data' },
      ],
      toolsUsed: ['http_get'],
      tokenUsage: { inputTokens: 100, outputTokens: 50 },
      durationMs: 1500,
    };

    const outbound = await dispatcher.finalize(request, result, { id: 'msg-1', sessionId: 'telegram:12345' });

    // Guardrails applied
    assert.equal(outbound.content, 'Here is [REDACTED] data');

    // Persisted
    assert.equal(persisted.sid, 'user:alice');
    assert.equal(persisted.msgs.length, 2);

    // Emitted
    assert.ok(emitted);
    assert.equal(emitted.sessionId, 'telegram:12345');
    assert.equal(emitted.replyTo, 'msg-1');
    assert.deepEqual(emitted.metadata.toolsUsed, ['http_get']);
  });

  it('skips persistence when no new messages', async () => {
    let persistCalled = false;
    const eventBus = new EventEmitter();

    const dispatcher = makeDispatcher({
      eventBus,
      sessionManager: {
        resolveSessionId: () => 's',
        getOrCreate: () => ({ id: 's', metadata: {} }),
        loadHistory: () => [],
        appendMessages: () => { persistCalled = true; },
      },
    });

    await dispatcher.finalize(
      { sessionId: 's', channelId: 'c', userId: 'u' },
      { content: 'hi', newMessages: [], toolsUsed: [] },
      null
    );

    assert.equal(persistCalled, false);
  });
});
