// Spec 27 — Command Context Persistence
// Tests that state-changing commands (/model, /agent) persist their exchanges
// to conversation history, and that the system prompt includes active model info.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CommandRouter } from '../src/core/command-router.js';
import { PromptBuilder } from '../src/brain/prompt-builder.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRouter(overrides = {}) {
  const eventBus = new EventEmitter();
  const emitted = [];
  const persisted = [];
  eventBus.on('message:outbound', (msg) => emitted.push(msg));

  const conversationMemory = overrides.conversationMemory || {
    clearSession: () => {},
    getHistory: () => [],
    append: (sessionId, role, content) => persisted.push({ sessionId, role, content }),
  };

  const sessionManager = overrides.sessionManager || {
    resolveSessionId: (msg) => `user:${msg.userId}`,
    getOrCreate: (sid, uid, cid, uname) => ({ id: sid, metadata: {}, lastUserMessage: null }),
  };

  const router = new CommandRouter({
    sessionManager,
    conversationMemory,
    llmProvider: overrides.llmProvider || null,
    toolExecutor: overrides.toolExecutor || null,
    toolRegistry: overrides.toolRegistry || null,
    promptBuilder: overrides.promptBuilder || null,
    config: overrides.config || { compactionMemoryFlush: false },
    eventBus,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    approvalManager: overrides.approvalManager || null,
    agentRegistry: overrides.agentRegistry || null,
  });

  return { router, emitted, persisted, eventBus };
}

function makeLlmProvider(model = 'llama3.1') {
  return {
    model,
    getModel() { return this.model; },
    setModel(name) { this.model = name; },
    estimateTokens: () => 0,
  };
}

const msg = (content) => ({ content, userId: 'alice', channelId: 'console' });

// ---------------------------------------------------------------------------
// /model command — history persistence
// ---------------------------------------------------------------------------

describe('/model command persistence', () => {
  it('persists user command and bot response when switching model', async () => {
    const provider = makeLlmProvider('llama3.1');
    const { router, persisted } = makeRouter({ llmProvider: provider });

    await router.handle(msg('/model qwen2'));

    // Should have 2 persisted entries: user command + assistant response
    assert.equal(persisted.length, 2);
    assert.equal(persisted[0].role, 'user');
    assert.equal(persisted[0].content, '/model qwen2');
    assert.equal(persisted[1].role, 'assistant');
    assert.ok(persisted[1].content.includes('qwen2'));
    assert.ok(persisted[1].content.includes('llama3.1'));
  });

  it('persists user command and bot response when querying model', async () => {
    const provider = makeLlmProvider('claude-3-opus');
    const { router, persisted } = makeRouter({ llmProvider: provider });

    await router.handle(msg('/model'));

    assert.equal(persisted.length, 2);
    assert.equal(persisted[0].role, 'user');
    assert.equal(persisted[0].content, '/model');
    assert.equal(persisted[1].role, 'assistant');
    assert.ok(persisted[1].content.includes('claude-3-opus'));
  });

  it('persists to the correct session', async () => {
    const provider = makeLlmProvider('llama3.1');
    const { router, persisted } = makeRouter({ llmProvider: provider });

    await router.handle(msg('/model qwen2'));

    assert.equal(persisted[0].sessionId, 'user:alice');
    assert.equal(persisted[1].sessionId, 'user:alice');
  });

  it('does not persist when llmProvider is null (error case)', async () => {
    const { router, persisted } = makeRouter({ llmProvider: null });

    await router.handle(msg('/model'));

    // Error response should NOT be persisted — no state change
    assert.equal(persisted.length, 0);
  });

  it('still emits outbound event when persisting', async () => {
    const provider = makeLlmProvider('llama3.1');
    const { router, emitted } = makeRouter({ llmProvider: provider });

    await router.handle(msg('/model qwen2'));

    assert.equal(emitted.length, 1);
    assert.ok(emitted[0].content.includes('qwen2'));
  });
});

// ---------------------------------------------------------------------------
// /agent command — history persistence
// ---------------------------------------------------------------------------

describe('/agent command persistence', () => {
  const agentRegistry = {
    get: (name) => {
      if (name === 'coder') return { name: 'coder', description: 'Coding agent' };
      return null;
    },
    list: () => [
      { name: 'coder', description: 'Coding agent' },
      { name: 'reviewer', description: 'Code reviewer' },
    ],
  };

  const sessionManager = {
    resolveSessionId: (msg) => `user:${msg.userId}`,
    getOrCreate: () => ({ id: 'user:alice', metadata: {}, lastUserMessage: null }),
  };

  it('persists user command and bot response when switching agent', async () => {
    const { router, persisted } = makeRouter({ agentRegistry, sessionManager });

    await router.handle(msg('/agent coder'));

    assert.equal(persisted.length, 2);
    assert.equal(persisted[0].role, 'user');
    assert.equal(persisted[0].content, '/agent coder');
    assert.equal(persisted[1].role, 'assistant');
    assert.ok(persisted[1].content.includes('coder'));
  });

  it('persists user command and bot response when resetting to default', async () => {
    const { router, persisted } = makeRouter({ agentRegistry, sessionManager });

    await router.handle(msg('/agent default'));

    assert.equal(persisted.length, 2);
    assert.equal(persisted[0].role, 'user');
    assert.equal(persisted[0].content, '/agent default');
    assert.equal(persisted[1].role, 'assistant');
    assert.ok(persisted[1].content.includes('default'));
  });

  it('does not persist /agent list (informational only)', async () => {
    const { router, persisted } = makeRouter({ agentRegistry, sessionManager });

    await router.handle(msg('/agent list'));

    assert.equal(persisted.length, 0);
  });

  it('does not persist when agent not found (error case)', async () => {
    const { router, persisted } = makeRouter({ agentRegistry, sessionManager });

    await router.handle(msg('/agent nonexistent'));

    assert.equal(persisted.length, 0);
  });

  it('does not persist when agentRegistry is null (error case)', async () => {
    const { router, persisted } = makeRouter({ agentRegistry: null });

    await router.handle(msg('/agent coder'));

    assert.equal(persisted.length, 0);
  });
});

// ---------------------------------------------------------------------------
// /new command — should NOT persist (history is cleared)
// ---------------------------------------------------------------------------

describe('/new command does not persist', () => {
  it('does not persist command exchange on /new', async () => {
    const { router, persisted } = makeRouter();

    await router.handle(msg('/new'));

    assert.equal(persisted.length, 0);
  });
});

// ---------------------------------------------------------------------------
// /approve and /reject — should NOT persist
// ---------------------------------------------------------------------------

describe('/approve and /reject do not persist', () => {
  it('does not persist /approve', async () => {
    const approvalManager = {
      getPending: () => ({ toolName: 'write_file', input: {}, userId: 'alice' }),
      resolve: () => {},
      grantApproval: () => {},
    };
    const { router, persisted } = makeRouter({ approvalManager });

    await router.handle(msg('/approve'));

    assert.equal(persisted.length, 0);
  });

  it('does not persist /reject', async () => {
    const approvalManager = {
      getPending: () => ({ toolName: 'run_command', input: {}, userId: 'alice' }),
      resolve: () => {},
    };
    const { router, persisted } = makeRouter({ approvalManager });

    await router.handle(msg('/reject'));

    assert.equal(persisted.length, 0);
  });
});

// ---------------------------------------------------------------------------
// PromptBuilder — active model in system prompt
// ---------------------------------------------------------------------------

describe('PromptBuilder includes active model', () => {
  it('renders model name in Current Context when activeModel is set', async () => {
    const builder = new PromptBuilder({ agentName: 'TestBot' });
    const session = {
      userId: 'alice',
      userName: 'Alice',
      channelId: 'console',
      metadata: { activeModel: 'claude-3-opus' },
    };

    const prompt = await builder.build(session, [], null, null);

    assert.ok(prompt.includes('claude-3-opus'), 'Prompt should contain the active model name');
    assert.ok(prompt.includes('Model:'), 'Prompt should have a Model label');
  });

  it('omits model line when activeModel is not set', async () => {
    const builder = new PromptBuilder({ agentName: 'TestBot' });
    const session = {
      userId: 'alice',
      userName: 'Alice',
      channelId: 'console',
      metadata: {},
    };

    const prompt = await builder.build(session, [], null, null);

    assert.ok(!prompt.includes('Model:'), 'Prompt should not have a Model label when unset');
  });

  it('omits model line when metadata is absent', async () => {
    const builder = new PromptBuilder({ agentName: 'TestBot' });
    const session = {
      userId: 'alice',
      userName: 'Alice',
      channelId: 'console',
    };

    const prompt = await builder.build(session, [], null, null);

    assert.ok(!prompt.includes('Model:'), 'Prompt should not have a Model label when no metadata');
  });
});

// ---------------------------------------------------------------------------
// HostDispatcher.buildRequest — sets activeModel on session metadata
// ---------------------------------------------------------------------------

describe('HostDispatcher.buildRequest sets activeModel', () => {
  // This test imports HostDispatcher — defined inline to avoid circular setup
  it('sets activeModel from llmProvider on session metadata', async () => {
    const { HostDispatcher } = await import('../src/core/host-dispatcher.js');

    let capturedSession = null;
    const dispatcher = new HostDispatcher({
      sessionManager: {
        resolveSessionId: (msg) => `user:${msg.userId}`,
        getOrCreate: (sid, uid, cid, uname) => {
          const session = { id: sid, userId: uid, channelId: cid, userName: uname, metadata: {}, lastUserMessage: null };
          capturedSession = session;
          return session;
        },
        loadHistory: () => [],
        appendMessages: () => {},
      },
      toolPolicy: null,
      toolRegistry: { getSchemas: () => [] },
      memorySearch: { search: () => [] },
      skillLoader: null,
      permissionManager: null,
      eventBus: new EventEmitter(),
      logger: { error: () => {}, info: () => {}, warn: () => {} },
      config: { maxToolIterations: 25 },
      agentRegistry: null,
      llmProvider: { getModel: () => 'claude-3-opus' },
    });

    await dispatcher.buildRequest({
      userId: 'alice',
      channelId: 'console',
      content: 'Hello',
    });

    assert.ok(capturedSession, 'Session should have been created');
    assert.equal(capturedSession.metadata.activeModel, 'claude-3-opus');
  });

  it('works without llmProvider (activeModel not set)', async () => {
    const { HostDispatcher } = await import('../src/core/host-dispatcher.js');

    let capturedSession = null;
    const dispatcher = new HostDispatcher({
      sessionManager: {
        resolveSessionId: (msg) => `user:${msg.userId}`,
        getOrCreate: (sid, uid, cid, uname) => {
          const session = { id: sid, userId: uid, channelId: cid, userName: uname, metadata: {}, lastUserMessage: null };
          capturedSession = session;
          return session;
        },
        loadHistory: () => [],
        appendMessages: () => {},
      },
      toolPolicy: null,
      toolRegistry: { getSchemas: () => [] },
      memorySearch: { search: () => [] },
      skillLoader: null,
      permissionManager: null,
      eventBus: new EventEmitter(),
      logger: { error: () => {}, info: () => {}, warn: () => {} },
      config: { maxToolIterations: 25 },
      agentRegistry: null,
      // no llmProvider
    });

    await dispatcher.buildRequest({
      userId: 'alice',
      channelId: 'console',
      content: 'Hello',
    });

    assert.ok(capturedSession);
    assert.equal(capturedSession.metadata.activeModel, undefined);
  });
});
