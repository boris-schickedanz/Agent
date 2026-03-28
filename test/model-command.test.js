import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CommandRouter } from '../src/core/command-router.js';

// ---------------------------------------------------------------------------
// /model command
// ---------------------------------------------------------------------------

describe('/model command', () => {
  let eventBus, emitted, router;

  const makeLlmProvider = (model = 'llama3.1') => ({
    model,
    getModel() { return this.model; },
    setModel(name) { this.model = name; },
    estimateTokens: () => 0,
  });

  const makeRouter = (llmProvider) => new CommandRouter({
    sessionManager: { resolveSessionId: () => 'session1' },
    conversationMemory: { clearSession: () => {}, getHistory: () => [], append: () => {} },
    config: { compactionMemoryFlush: false },
    eventBus,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    llmProvider,
  });

  const msg = (content) => ({ content, userId: 'user1', channelId: 'console' });

  beforeEach(() => {
    eventBus = new EventEmitter();
    emitted = [];
    eventBus.on('message:outbound', (m) => emitted.push(m));
  });

  it('/model with no args shows the current model', async () => {
    router = makeRouter(makeLlmProvider('llama3.1'));
    const result = await router.handle(msg('/model'));

    assert.equal(result.handled, true);
    assert.equal(emitted.length, 1);
    assert.ok(emitted[0].content.includes('llama3.1'));
  });

  it('/model <name> switches the model and confirms', async () => {
    const provider = makeLlmProvider('llama3.1');
    router = makeRouter(provider);
    const result = await router.handle(msg('/model qwen2'));

    assert.equal(result.handled, true);
    assert.equal(provider.getModel(), 'qwen2');
    assert.equal(emitted.length, 1);
    assert.ok(emitted[0].content.includes('llama3.1'));
    assert.ok(emitted[0].content.includes('qwen2'));
  });

  it('/model when llmProvider is null responds with error', async () => {
    router = makeRouter(null);
    const result = await router.handle(msg('/model'));

    assert.equal(result.handled, true);
    assert.equal(emitted.length, 1);
    assert.ok(emitted[0].content.includes('not available'));
  });

  it('/model with Telegram @BotName suffix is handled', async () => {
    router = makeRouter(makeLlmProvider('mistral'));
    const result = await router.handle(msg('/model@MyBot deepseek-r1'));

    assert.equal(result.handled, true);
    assert.equal(emitted.length, 1);
    assert.ok(emitted[0].content.includes('deepseek-r1'));
  });

  it('non-matching commands are not handled', async () => {
    router = makeRouter(makeLlmProvider('llama3.1'));
    const result = await router.handle(msg('/something'));

    assert.equal(result.handled, false);
    assert.equal(emitted.length, 0);
  });
});
