import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { HistoryPruner } from '../src/brain/history-pruner.js';
import { ContextCompactor } from '../src/brain/context-compactor.js';
import { CommandRouter } from '../src/core/command-router.js';

// ---------------------------------------------------------------------------
// HistoryPruner
// ---------------------------------------------------------------------------

describe('HistoryPruner', () => {
  const pruner = new HistoryPruner({ pruneThreshold: 100, pruneHead: 20, pruneTail: 20 });

  it('does not mutate the input array', () => {
    const original = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: '1', content: 'x'.repeat(200) }] }];
    const result = pruner.prune(original);
    assert.notEqual(result, original);
    assert.equal(original[0].content[0].content, 'x'.repeat(200));
  });

  it('prunes tool_result blocks exceeding threshold', () => {
    const longText = 'A'.repeat(20) + 'B'.repeat(160) + 'C'.repeat(20);
    const messages = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: '1', content: longText }] }];
    const result = pruner.prune(messages);

    assert.ok(result[0].content[0].content.includes('...[pruned'));
    assert.ok(result[0].content[0].content.startsWith('A'.repeat(20)));
    assert.ok(result[0].content[0].content.endsWith('C'.repeat(20)));
  });

  it('leaves small tool_result blocks unchanged', () => {
    const messages = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: '1', content: 'short' }] }];
    const result = pruner.prune(messages);
    assert.equal(result[0].content[0].content, 'short');
  });

  it('leaves non-array content messages unchanged', () => {
    const messages = [{ role: 'user', content: 'plain text' }];
    const result = pruner.prune(messages);
    assert.equal(result[0], messages[0]); // same reference — no copy needed
  });

  it('leaves non-tool_result blocks unchanged', () => {
    const messages = [{
      role: 'assistant',
      content: [
        { type: 'text', text: 'x'.repeat(200) },
        { type: 'tool_use', id: '1', name: 'foo', input: {} },
      ],
    }];
    const result = pruner.prune(messages);
    assert.equal(result[0], messages[0]); // no tool_result — same reference
  });

  it('handles JSON content in tool_result', () => {
    const obj = { data: 'x'.repeat(200) };
    const messages = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: '1', content: obj }] }];
    const result = pruner.prune(messages);
    assert.ok(typeof result[0].content[0].content === 'string');
    assert.ok(result[0].content[0].content.includes('...[pruned'));
  });

  it('uses default config values', () => {
    const defaultPruner = new HistoryPruner({});
    assert.equal(defaultPruner.threshold, 4000);
    assert.equal(defaultPruner.head, 1500);
    assert.equal(defaultPruner.tail, 1500);
  });
});

// ---------------------------------------------------------------------------
// ContextCompactor (enhanced)
// ---------------------------------------------------------------------------

describe('ContextCompactor', () => {
  function makeLLM(summaryText = 'Summary of conversation') {
    return {
      estimateTokens: (msgs) => msgs.length * 1000,
      createMessage: async () => ({
        content: [{ type: 'text', text: summaryText }],
        stopReason: 'end_turn',
        usage: { inputTokens: 100, outputTokens: 50 },
      }),
    };
  }

  it('skips compaction when below threshold', () => {
    const compactor = new ContextCompactor(makeLLM(), { compactionThreshold: 50000 });
    const messages = Array.from({ length: 5 }, (_, i) => ({ role: 'user', content: `msg ${i}` }));
    assert.equal(compactor.shouldCompact(messages), false);
  });

  it('triggers compaction when above threshold', () => {
    const compactor = new ContextCompactor(makeLLM(), { compactionThreshold: 5000 });
    const messages = Array.from({ length: 20 }, (_, i) => ({ role: 'user', content: `msg ${i}` }));
    assert.equal(compactor.shouldCompact(messages), true);
  });

  it('skips compaction if not enough messages for retain + summarize', async () => {
    const compactor = new ContextCompactor(makeLLM(), { compactionThreshold: 100, compactionRetainMessages: 10 });
    // 10 retain + 4 min = 14, but only 12 messages
    const messages = Array.from({ length: 12 }, (_, i) => ({ role: 'user', content: `msg ${i}` }));
    const result = await compactor.compact(messages);
    assert.equal(result.length, 12); // unchanged
  });

  it('retains configured number of recent messages', async () => {
    const compactor = new ContextCompactor(makeLLM(), { compactionThreshold: 100, compactionRetainMessages: 5 });
    const messages = Array.from({ length: 20 }, (_, i) => ({ role: 'user', content: `msg ${i}` }));
    const result = await compactor.compact(messages);

    // 1 summary + 5 retained
    assert.equal(result.length, 6);
    assert.ok(result[0].content.startsWith('[Previous conversation summary]'));
    assert.equal(result[5].content, 'msg 19');
  });

  it('performs rolling compression with prior summary', async () => {
    let capturedPrompt = '';
    const llm = {
      estimateTokens: () => 100000,
      createMessage: async (_sys, msgs) => {
        capturedPrompt = msgs[0].content;
        return {
          content: [{ type: 'text', text: 'Merged summary' }],
          stopReason: 'end_turn',
          usage: { inputTokens: 100, outputTokens: 50 },
        };
      },
    };

    const compactor = new ContextCompactor(llm, { compactionThreshold: 100, compactionRetainMessages: 3 });
    const messages = [
      { role: 'user', content: '[Previous conversation summary]: Old stuff happened' },
      ...Array.from({ length: 10 }, (_, i) => ({ role: 'user', content: `msg ${i}` })),
    ];

    const result = await compactor.compact(messages);

    assert.ok(capturedPrompt.includes('updating a running conversation summary'));
    assert.ok(result[0].content.includes('Merged summary'));
    assert.equal(result.length, 4); // 1 summary + 3 retained
  });

  it('uses standard prompt when no prior summary', async () => {
    let capturedPrompt = '';
    const llm = {
      estimateTokens: () => 100000,
      createMessage: async (_sys, msgs) => {
        capturedPrompt = msgs[0].content;
        return {
          content: [{ type: 'text', text: 'Fresh summary' }],
          stopReason: 'end_turn',
          usage: { inputTokens: 100, outputTokens: 50 },
        };
      },
    };

    const compactor = new ContextCompactor(llm, { compactionThreshold: 100, compactionRetainMessages: 3 });
    const messages = Array.from({ length: 10 }, (_, i) => ({ role: 'user', content: `msg ${i}` }));
    await compactor.compact(messages);

    assert.ok(capturedPrompt.includes('Summarize the following conversation'));
    assert.ok(!capturedPrompt.includes('updating'));
  });

  it('falls back to truncation on LLM error', async () => {
    const llm = {
      estimateTokens: () => 100000,
      createMessage: async () => { throw new Error('LLM down'); },
    };

    const compactor = new ContextCompactor(llm, { compactionThreshold: 100, compactionRetainMessages: 3 });
    const messages = Array.from({ length: 10 }, (_, i) => ({ role: 'user', content: `msg ${i}` }));
    const result = await compactor.compact(messages);

    // Falls back to just the retained messages
    assert.equal(result.length, 3);
    assert.equal(result[0].content, 'msg 7');
  });

  it('defaults retainMessages to 10', () => {
    const compactor = new ContextCompactor(makeLLM(), { compactionThreshold: 80000 });
    assert.equal(compactor.retainMessages, 10);
  });
});

// ---------------------------------------------------------------------------
// CommandRouter
// ---------------------------------------------------------------------------

describe('CommandRouter', () => {
  function makeRouter(overrides = {}) {
    const eventBus = new EventEmitter();
    const emitted = [];
    eventBus.on('message:outbound', (msg) => emitted.push(msg));

    return {
      router: new CommandRouter({
        sessionManager: overrides.sessionManager || {
          resolveSessionId: (msg) => `user:${msg.userId}`,
        },
        conversationMemory: overrides.conversationMemory || {
          clearSession: overrides.clearSession || (() => {}),
          getHistory: () => [],
        },
        llmProvider: overrides.llmProvider || null,
        toolExecutor: overrides.toolExecutor || null,
        promptBuilder: overrides.promptBuilder || null,
        config: overrides.config || { compactionMemoryFlush: false },
        eventBus,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      }),
      emitted,
    };
  }

  it('ignores non-command messages', async () => {
    const { router } = makeRouter();
    const result = await router.handle({ content: 'hello', userId: 'alice', channelId: 'console' });
    assert.equal(result.handled, false);
  });

  it('handles /new and clears session', async () => {
    let clearedSession = null;
    const { router, emitted } = makeRouter({
      clearSession: (sid) => { clearedSession = sid; },
      conversationMemory: {
        clearSession: (sid) => { clearedSession = sid; },
        getHistory: () => [],
      },
    });

    const result = await router.handle({ content: '/new', userId: 'alice', channelId: 'console' });

    assert.equal(result.handled, true);
    assert.equal(result.forwardContent, undefined);
    assert.equal(clearedSession, 'user:alice');
    assert.equal(emitted.length, 1);
    assert.ok(emitted[0].content.includes('Conversation cleared'));
  });

  it('handles /new with trailing message', async () => {
    const { router, emitted } = makeRouter();
    const result = await router.handle({ content: '/new tell me a joke', userId: 'alice', channelId: 'console' });

    assert.equal(result.handled, true);
    assert.equal(result.forwardContent, 'tell me a joke');
    assert.equal(emitted.length, 1);
  });

  it('does not match /newish as a command', async () => {
    const { router } = makeRouter();
    const result = await router.handle({ content: '/newish', userId: 'alice', channelId: 'console' });
    assert.equal(result.handled, false);
  });

  it('handles /new with leading whitespace', async () => {
    const { router } = makeRouter();
    const result = await router.handle({ content: '  /new  ', userId: 'alice', channelId: 'console' });
    assert.equal(result.handled, true);
  });

  it('skips memory flush when config disables it', async () => {
    let llmCalled = false;
    const { router } = makeRouter({
      config: { compactionMemoryFlush: false },
      llmProvider: {
        estimateTokens: () => 50000,
        createMessage: async () => { llmCalled = true; return { content: [], stopReason: 'end_turn', usage: {} }; },
      },
    });

    await router.handle({ content: '/new', userId: 'alice', channelId: 'console' });
    assert.equal(llmCalled, false);
  });

  it('only allows save_memory during flush', async () => {
    const toolsCalled = [];
    const { router } = makeRouter({
      config: { compactionMemoryFlush: true },
      conversationMemory: {
        clearSession: () => {},
        getHistory: () => [
          { role: 'user', content: 'important stuff' },
          { role: 'assistant', content: 'noted' },
          { role: 'user', content: 'more important stuff' },
          { role: 'assistant', content: 'got it' },
        ],
      },
      llmProvider: {
        estimateTokens: () => 5000,
        createMessage: async () => ({
          content: [
            { type: 'tool_use', id: '1', name: 'save_memory', input: { key: 'test', content: 'data' } },
            { type: 'tool_use', id: '2', name: 'http_get', input: { url: 'http://evil.com' } },
          ],
          stopReason: 'tool_use',
          usage: { inputTokens: 100, outputTokens: 50 },
        }),
      },
      promptBuilder: { build: async () => 'system prompt' },
      toolExecutor: {
        registry: { getSchemas: () => [
          { name: 'save_memory', description: 'Save', input_schema: {} },
          { name: 'http_get', description: 'HTTP', input_schema: {} },
        ]},
        execute: async (name) => { toolsCalled.push(name); return { success: true, result: 'ok' }; },
      },
    });

    await router.handle({ content: '/new', userId: 'alice', channelId: 'console' });

    // MemoryFlusher filters to save_memory only — http_get should not execute
    assert.deepEqual(toolsCalled, ['save_memory']);
  });
});
