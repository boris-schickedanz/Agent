import { config } from './config.js';
import { DB } from './db/database.js';
import { EventBus } from './core/event-bus.js';
import { AnthropicProvider } from './brain/anthropic-provider.js';
import { PromptBuilder } from './brain/prompt-builder.js';
import { ContextCompactor } from './brain/context-compactor.js';
import { ToolRegistry } from './tools/tool-registry.js';
import { ToolExecutor } from './tools/tool-executor.js';
import { ConversationMemory } from './memory/conversation-memory.js';
import { PersistentMemory } from './memory/persistent-memory.js';
import { MemorySearch } from './memory/memory-search.js';
import { SessionManager } from './core/session-manager.js';
import { MessageQueue } from './core/message-queue.js';
import { AgentLoop } from './core/agent-loop.js';
import { LocalRunner } from './core/runner/local-runner.js';
import { HostDispatcher } from './core/host-dispatcher.js';
import { AdapterRegistry } from './adapters/adapter-registry.js';
import { ConsoleAdapter } from './adapters/console/console-adapter.js';
import { InputSanitizer } from './security/input-sanitizer.js';
import { RateLimiter } from './security/rate-limiter.js';
import { ToolPolicy } from './security/tool-policy.js';
import { PermissionManager } from './security/permission-manager.js';
import { registerSystemTools } from './tools/built-in/system-tools.js';
import { registerHttpTools } from './tools/built-in/http-tools.js';
import { registerMemoryTools } from './tools/built-in/memory-tools.js';
import pino from 'pino';

async function main() {
  const logger = pino({ level: config.logLevel });

  // Phase 1: Foundation
  const db = DB.getInstance(`${config.dataDir}/agent-core.db`);
  await db.migrate();
  const eventBus = new EventBus();

  logger.info('Database initialized');

  // Phase 2: Brain
  let llmProvider;
  if (config.llmProvider === 'ollama') {
    const { OllamaProvider } = await import('./brain/ollama-provider.js');
    llmProvider = new OllamaProvider(config, logger);
    logger.info({ model: config.ollamaModel, host: config.ollamaHost }, 'Using Ollama provider');
  } else {
    llmProvider = new AnthropicProvider(config, logger);
  }
  const contextCompactor = new ContextCompactor(llmProvider, config);

  // Phase 3: Memory
  const conversationMemory = new ConversationMemory(db);
  const persistentMemory = new PersistentMemory(config.dataDir, db);
  const memorySearch = new MemorySearch(db);

  // Phase 4: Tools
  const toolRegistry = new ToolRegistry();
  registerSystemTools(toolRegistry);
  registerHttpTools(toolRegistry);
  registerMemoryTools(toolRegistry, persistentMemory, memorySearch);

  // Phase 5: Security
  const inputSanitizer = new InputSanitizer();
  const rateLimiter = new RateLimiter(db, config);
  const toolPolicy = new ToolPolicy(db, config);
  const permissionManager = new PermissionManager(db, toolPolicy, config);

  // Phase 6: Prompt Builder
  const promptBuilder = new PromptBuilder(config, memorySearch);

  // Phase 7: Core — AgentLoop (runtime) + LocalRunner + HostDispatcher
  const sessionManager = new SessionManager(db, conversationMemory);
  const toolExecutor = new ToolExecutor(toolRegistry, toolPolicy, logger);
  const agentLoop = new AgentLoop({
    llmProvider,
    promptBuilder,
    toolExecutor,
    contextCompactor,
    logger,
    config,
  });
  const runner = new LocalRunner({ agentLoop, logger });
  const messageQueue = new MessageQueue(runner, logger);

  // Phase 8: Skills (loaded dynamically if directory exists)
  let skillLoader = null;
  try {
    const { SkillLoader } = await import('./skills/skill-loader.js');
    skillLoader = new SkillLoader(toolRegistry, logger);
    await skillLoader.loadAll('./skills');
  } catch {
    // Skills are optional
  }

  // Phase 9: Host Dispatcher
  const dispatcher = new HostDispatcher({
    sessionManager,
    toolPolicy,
    toolRegistry,
    memorySearch,
    skillLoader,
    permissionManager,
    eventBus,
    logger,
    config,
  });

  // Phase 10: Wire event bus — inbound message processing
  eventBus.on('message:inbound', async (message) => {
    const start = Date.now();

    // Rate limiting
    const rateCheck = rateLimiter.consume(message.userId);
    if (!rateCheck.allowed) {
      logger.warn({ userId: message.userId }, 'Rate limited');
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

    // Permission check
    const accessCheck = permissionManager.checkAccess(message.userId, message.channelId);
    if (!accessCheck.allowed) {
      logger.warn({ userId: message.userId, reason: accessCheck.reason }, 'Access denied');
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

    // Sanitize
    const sanitized = inputSanitizer.sanitize(message);

    // Injection detection (soft — log only, do not block)
    const injection = inputSanitizer.detectInjection(sanitized.content);
    if (injection.suspicious) {
      logger.warn({ userId: message.userId, patterns: injection.patterns }, 'Potential prompt injection detected');
    }

    // Build request, enqueue, and finalize
    try {
      const request = dispatcher.buildRequest(sanitized);
      const result = await messageQueue.enqueue(request.sessionId, request);
      if (result) {
        const outbound = await dispatcher.finalize(request, result, message);
        outbound.metadata.processingTimeMs = Date.now() - start;
      }
    } catch (err) {
      logger.error({ err: err.message, sessionId: message.sessionId }, 'Processing failed');
    }
  });

  // Phase 11: Adapters
  const adapterRegistry = new AdapterRegistry(eventBus);

  // Telegram adapter (loaded dynamically if token present)
  if (config.telegramBotToken) {
    try {
      const { TelegramAdapter } = await import('./adapters/telegram/telegram-adapter.js');
      adapterRegistry.register(new TelegramAdapter(eventBus, config, logger));
      logger.info('Telegram adapter registered');
    } catch (err) {
      logger.error({ err: err.message }, 'Failed to load Telegram adapter');
    }
  }

  // Console adapter (always available)
  adapterRegistry.register(new ConsoleAdapter(eventBus, config));

  // Phase 12: Heartbeat (loaded dynamically if configured)
  try {
    const { HeartbeatScheduler } = await import('./heartbeat/heartbeat-scheduler.js');
    const heartbeat = new HeartbeatScheduler(runner, toolRegistry, sessionManager, db, config, logger);
    heartbeat.start();
  } catch {
    // Heartbeat is optional
  }

  // Start all adapters
  await adapterRegistry.startAll();

  logger.info(
    { adapters: adapterRegistry.getAll().map(a => a.channelId) },
    `${config.agentName} started`
  );

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...');
    messageQueue.shutdown();
    await runner.shutdown();
    await adapterRegistry.stopAll();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
