import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AgentLoop } from '../src/core/agent-loop.js';
import { LocalRunner } from '../src/core/runner/local-runner.js';
import { HostDispatcher } from '../src/core/host-dispatcher.js';
import { MessageQueue } from '../src/core/message-queue.js';
import { StateBootstrap } from '../src/memory/state-bootstrap.js';

const logger = { error: () => {}, info: () => {}, warn: () => {} };

function makePersistentMemory(store = {}) {
  return {
    async load(key) { return store[key] || null; },
    async save(key, content) { store[key] = content; },
  };
}

function makePipeline({ memoryStore = {}, captureSystemPrompt } = {}) {
  const eventBus = new EventEmitter();
  const outbound = [];
  eventBus.on('message:outbound', (msg) => outbound.push(msg));

  let capturedPrompt = null;

  const agentLoop = new AgentLoop({
    llmProvider: {
      createMessage: async (systemPrompt) => {
        capturedPrompt = systemPrompt;
        if (captureSystemPrompt) captureSystemPrompt(systemPrompt);
        return {
          content: [{ type: 'text', text: 'OK' }],
          stopReason: 'end_turn',
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
    },
    promptBuilder: {
      build: async (session, tools, skill, memory, workspaceState) => {
        const parts = ['system prompt'];
        if (workspaceState) parts.push(workspaceState);
        return parts.join('\n');
      },
    },
    toolExecutor: {},
    contextCompactor: { shouldCompact: () => false },
    logger,
    config: { maxToolIterations: 25 },
  });

  const runner = new LocalRunner({ agentLoop, logger });
  const messageQueue = new MessageQueue(runner, logger);

  const persistentMemory = makePersistentMemory(memoryStore);
  const stateBootstrap = new StateBootstrap({
    persistentMemory,
    config: { workspaceStateEnabled: true, workspaceStateMaxChars: 3000 },
    logger,
  });

  const dispatcher = new HostDispatcher({
    sessionManager: {
      resolveSessionId: (msg) => `user:${msg.userId}`,
      getOrCreate: (sid, uid, cid, uname) => ({
        id: sid, userId: uid, channelId: cid, userName: uname,
        metadata: {}, lastUserMessage: null,
      }),
      loadHistory: () => [],
      appendMessages: () => {},
    },
    toolPolicy: null,
    toolRegistry: { getSchemas: () => [] },
    memorySearch: { search: () => [] },
    skillLoader: null,
    permissionManager: null,
    stateBootstrap,
    eventBus,
    logger,
    config: { maxToolIterations: 25 },
  });

  return { dispatcher, messageQueue, outbound, getCapturedPrompt: () => capturedPrompt };
}

describe('Workspace State E2E (WS1-WS2)', () => {
  it('WS1: injects bootstrapping hint when no project_state exists', async () => {
    const { dispatcher, messageQueue, getCapturedPrompt } = makePipeline({
      memoryStore: {},
    });

    const msg = { id: '1', channelId: 'console', userId: 'u1', content: 'Hello' };
    const req = await dispatcher.buildRequest(msg);
    await messageQueue.enqueue(req.sessionId, req);

    const prompt = getCapturedPrompt();
    assert.ok(prompt.includes('not initialized'), 'Should include bootstrapping hint');
    assert.ok(prompt.includes('project_state'), 'Should mention project_state key');
  });

  it('WS2: injects workspace state when project_state exists', async () => {
    const { dispatcher, messageQueue, getCapturedPrompt } = makePipeline({
      memoryStore: {
        project_state: '# Project State\n\n## Current Objective\nBuild the widget\n\n## Active Tasks\n- [ ] Implement feature X',
      },
    });

    const msg = { id: '2', channelId: 'console', userId: 'u1', content: 'What should I work on?' };
    const req = await dispatcher.buildRequest(msg);
    await messageQueue.enqueue(req.sessionId, req);

    const prompt = getCapturedPrompt();
    assert.ok(prompt.includes('Workspace State'), 'Should include workspace state section');
    assert.ok(prompt.includes('Build the widget'), 'Should include project objective');
    assert.ok(prompt.includes('Implement feature X'), 'Should include active tasks');
  });

  it('WS2: includes session_log and decision_journal last entries', async () => {
    const { dispatcher, messageQueue, getCapturedPrompt } = makePipeline({
      memoryStore: {
        project_state: '# Project\nOngoing work',
        session_log: '## Session 2026-03-27\nOld session\n\n## Session 2026-03-28\nFinished auth module',
        decision_journal: '## [2026-03-27] Old\nStuff\n\n## [2026-03-28] Chose JWT\nOver session cookies for stateless auth',
      },
    });

    const msg = { id: '3', channelId: 'console', userId: 'u1', content: 'Continue' };
    const req = await dispatcher.buildRequest(msg);
    await messageQueue.enqueue(req.sessionId, req);

    const prompt = getCapturedPrompt();
    assert.ok(prompt.includes('Last Session'), 'Should include last session header');
    assert.ok(prompt.includes('Finished auth module'), 'Should include last session content');
    assert.ok(prompt.includes('Latest Decision'), 'Should include latest decision header');
    assert.ok(prompt.includes('Chose JWT'), 'Should include latest decision content');
    assert.ok(!prompt.includes('Old session'), 'Should NOT include old session entries');
  });

  it('WS2: workspace state disabled skips injection', async () => {
    const eventBus = new EventEmitter();

    const agentLoop = new AgentLoop({
      llmProvider: {
        createMessage: async () => ({
          content: [{ type: 'text', text: 'OK' }],
          stopReason: 'end_turn',
          usage: { inputTokens: 10, outputTokens: 5 },
        }),
      },
      promptBuilder: {
        build: async (session, tools, skill, memory, workspaceState) => {
          assert.equal(workspaceState, null, 'workspaceState should be null when disabled');
          return 'system prompt';
        },
      },
      toolExecutor: {},
      contextCompactor: { shouldCompact: () => false },
      logger,
      config: { maxToolIterations: 25 },
    });

    const runner = new LocalRunner({ agentLoop, logger });
    const messageQueue = new MessageQueue(runner, logger);

    const stateBootstrap = new StateBootstrap({
      persistentMemory: makePersistentMemory({ project_state: '# State' }),
      config: { workspaceStateEnabled: false, workspaceStateMaxChars: 3000 },
      logger,
    });

    const dispatcher = new HostDispatcher({
      sessionManager: {
        resolveSessionId: () => 'user:u1',
        getOrCreate: () => ({ id: 'user:u1', metadata: {}, lastUserMessage: null }),
        loadHistory: () => [],
        appendMessages: () => {},
      },
      toolPolicy: null,
      toolRegistry: { getSchemas: () => [] },
      memorySearch: { search: () => [] },
      stateBootstrap,
      eventBus,
      logger,
      config: { maxToolIterations: 25 },
    });

    const msg = { id: '4', channelId: 'console', userId: 'u1', content: 'Hi' };
    const req = await dispatcher.buildRequest(msg);
    await messageQueue.enqueue(req.sessionId, req);
  });
});
