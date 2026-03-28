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
import { StateBootstrap } from './memory/state-bootstrap.js';
import { ProjectManager } from './memory/project-manager.js';
import { SessionManager } from './core/session-manager.js';
import { MessageQueue } from './core/message-queue.js';
import { AgentLoop } from './core/agent-loop.js';
import { LocalRunner } from './core/runner/local-runner.js';
import { HostDispatcher } from './core/host-dispatcher.js';
import { AdapterRegistry } from './adapters/adapter-registry.js';
import { ConsoleAdapter } from './adapters/console/console-adapter.js';
import { CommandRouter } from './core/command-router.js';
import { InputSanitizer } from './security/input-sanitizer.js';
import { RateLimiter } from './security/rate-limiter.js';
import { ToolPolicy } from './security/tool-policy.js';
import { PermissionManager } from './security/permission-manager.js';
import { HistoryPruner } from './brain/history-pruner.js';
import { registerSystemTools } from './tools/built-in/system-tools.js';
import { registerHttpTools } from './tools/built-in/http-tools.js';
import { registerMemoryTools } from './tools/built-in/memory-tools.js';
import { Sandbox } from './security/sandbox.js';
import { AuditLogger } from './security/audit-logger.js';
import { ApprovalManager } from './security/approval-manager.js';
import { ProcessManager } from './process/process-manager.js';
import { registerFsTools } from './tools/built-in/fs-tools.js';
import { registerShellTools } from './tools/built-in/shell-tools.js';
import { registerDelegationTools } from './tools/built-in/delegation-tools.js';
import { DelegationManager } from './core/delegation-manager.js';
import { getAllBackends } from './core/delegation-backends.js';
import { mkdirSync } from 'fs';
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
  const contextCompactor = new ContextCompactor(llmProvider, config, logger);

  // Phase 3: Memory
  const conversationMemory = new ConversationMemory(db);
  const persistentMemory = new PersistentMemory(config.dataDir, db);
  const memorySearch = new MemorySearch(db);

  // Phase 3b: Project manager & state bootstrap (Specs 29, 31)
  const projectManager = new ProjectManager(config.dataDir, db);
  const stateBootstrap = new StateBootstrap({ persistentMemory, config, logger, projectManager });

  // Phase 4: Tools
  const toolRegistry = new ToolRegistry();
  registerSystemTools(toolRegistry);
  registerHttpTools(toolRegistry);
  registerMemoryTools(toolRegistry, persistentMemory, memorySearch, projectManager);

  // Phase 4b: Sandbox & Audit
  mkdirSync(config.workspaceDir, { recursive: true });
  const sandbox = new Sandbox({
    workspaceDir: config.workspaceDir,
    readOnlyDirs: config.workspaceReadOnlyDirs,
    logger,
  });
  const auditLogger = config.auditLogEnabled ? new AuditLogger({ db, logger }) : null;

  // Phase 4c: File system tools
  registerFsTools(toolRegistry, sandbox);

  // Phase 4d: Process Manager & Shell tools
  const processManager = new ProcessManager({
    sandbox,
    logger,
    maxProcesses: config.maxBackgroundProcesses,
    defaultTimeoutMs: config.defaultShellTimeoutMs,
    containerMode: config.shellContainer,
    containerRuntime: config.shellContainerRuntime,
    containerImage: config.shellContainerImage,
  });
  registerShellTools(toolRegistry, processManager, sandbox);

  // Phase 4e: Delegation Manager & tools
  const delegationManager = new DelegationManager({
    processManager,
    runner: null, // Set after runner is created
    db,
    logger,
    config,
  });
  for (const backend of getAllBackends()) {
    delegationManager.registerBackend(backend);
  }
  registerDelegationTools(toolRegistry, delegationManager);

  // Phase 5: Security
  const inputSanitizer = new InputSanitizer();
  const rateLimiter = new RateLimiter(db, config);
  const approvalManager = new ApprovalManager({ db, eventBus, auditLogger, logger });
  const toolPolicy = new ToolPolicy();
  const permissionManager = new PermissionManager();

  // Phase 6: Prompt Builder
  const promptBuilder = new PromptBuilder(config);

  // Phase 7: Core — AgentLoop (runtime) + LocalRunner + HostDispatcher
  const sessionManager = new SessionManager(db, conversationMemory);
  const toolExecutor = new ToolExecutor(toolRegistry, toolPolicy, logger, {
    auditLogger,
    approvalManager,
  });
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

  // Wire delegation manager's runner reference
  delegationManager.runner = runner;

  // Phase 8: Skills (loaded dynamically if directory exists)
  let skillLoader = null;
  try {
    const { SkillLoader } = await import('./skills/skill-loader.js');
    skillLoader = new SkillLoader(toolRegistry, logger);
    await skillLoader.loadAll('./skills');
  } catch {
    // Skills are optional
  }

  // Phase 9: History Pruner
  const historyPruner = new HistoryPruner(config);

  // Phase 9b: Agent Registry
  let agentRegistry = null;
  try {
    const { AgentRegistry } = await import('./agents/agent-registry.js');
    agentRegistry = new AgentRegistry({ agentsDir: 'agents', logger });
    agentRegistry.loadAll();
  } catch {
    // Agent profiles are optional
  }

  // Phase 10: Command Router
  const commandRouter = new CommandRouter({
    sessionManager,
    conversationMemory,
    llmProvider,
    toolExecutor,
    promptBuilder,
    config,
    eventBus,
    logger,
    approvalManager,
    agentRegistry,
    projectManager,
  });

  // Phase 11: Host Dispatcher
  const dispatcher = new HostDispatcher({
    sessionManager,
    toolPolicy,
    toolRegistry,
    memorySearch,
    skillLoader,
    permissionManager,
    historyPruner,
    eventBus,
    logger,
    config,
    agentRegistry,
    llmProvider,
    stateBootstrap,
  });

  // Phase 12: Wire event bus — inbound message processing
  eventBus.on('message:inbound', async (message) => {
    const start = Date.now();

    // Rate limiting (global bucket — single-user model)
    const rateCheck = rateLimiter.consume();
    if (!rateCheck.allowed) {
      logger.warn('Rate limited');
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

    // Sanitize
    const sanitized = inputSanitizer.sanitize(message);

    // Injection detection (soft — log only, do not block)
    const injection = inputSanitizer.detectInjection(sanitized.content);
    if (injection.suspicious) {
      logger.warn({ userId: message.userId, patterns: injection.patterns }, 'Potential prompt injection detected');
    }

    // Host commands (e.g. /new, /approve, /reject, /agent) — handled before the LLM pipeline
    try {
      const cmd = await commandRouter.handle(sanitized);
      if (cmd.handled && !cmd.forwardContent) return;
      if (cmd.handled && cmd.forwardContent) {
        sanitized.content = cmd.forwardContent;
      }
    } catch (err) {
      logger.error({ err: err.message }, 'Command router error');
      // Don't let command text leak to the LLM on router failure
      if (sanitized.content.trim().startsWith('/')) return;
    }

    // Build request, enqueue, and finalize
    try {
      const request = await dispatcher.buildRequest(sanitized);

      // Create streaming callback that emits on the EventBus
      const onStreamEvent = (event) => {
        eventBus.emit('stream:event', {
          ...event,
          sessionId: message.sessionId,
          channelId: message.channelId,
        });
      };

      const result = await messageQueue.enqueue(request.sessionId, request, onStreamEvent);
      if (result) {
        const outbound = await dispatcher.finalize(request, result, message);
        outbound.metadata.processingTimeMs = Date.now() - start;
      }
    } catch (err) {
      logger.error({ err: err.message, sessionId: message.sessionId }, 'Processing failed');
    }
  });

  // Phase 13: Adapters
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

  // Console adapter (only when running interactively — skip when stdin is not a TTY
  // to avoid readline EOF causing process.exit(0) under launchd/nohup)
  if (process.stdin.isTTY) {
    adapterRegistry.register(new ConsoleAdapter(eventBus, config));
  }

  // Phase 14: Health endpoint / Dashboard
  let dashboardServer = null;
  if (config.healthPort > 0) {
    try {
      if (config.dashboardEnabled) {
        const { DashboardServer } = await import('./web/server.js');
        dashboardServer = new DashboardServer({
          port: config.healthPort,
          bind: config.healthBind,
          messageQueue,
          adapterRegistry,
          db,
          logger,
          config,
          toolRegistry,
          skillLoader,
          auditLogger,
          scheduler: null, // Set after scheduler is created
          agentRegistry,
          persistentMemory,
          projectManager,
          conversationMemory,
        });
        await dashboardServer.start();
        logger.info({ port: config.healthPort }, 'Dashboard server started');
      } else {
        const { HealthServer } = await import('./web/health.js');
        const healthServer = new HealthServer({
          port: config.healthPort,
          bind: config.healthBind,
          messageQueue,
          adapterRegistry,
          db,
          logger,
          config,
        });
        await healthServer.start();
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'Failed to start health/dashboard server');
    }
  }

  // Phase 15: Task Scheduler (replaces heartbeat)
  let scheduler = null;
  try {
    const { TaskScheduler } = await import('./scheduler/scheduler.js');
    scheduler = new TaskScheduler({
      runner,
      toolRegistry,
      sessionManager,
      db,
      logger,
      config,
    });
    scheduler.loadTasks();
    scheduler.start();
  } catch {
    // Fall back to legacy HeartbeatScheduler
    try {
      const { HeartbeatScheduler } = await import('./heartbeat/heartbeat-scheduler.js');
      const heartbeat = new HeartbeatScheduler(runner, toolRegistry, sessionManager, db, config, logger);
      heartbeat.start();
    } catch {
      // Scheduling is optional
    }
  }

  // Wire scheduler into dashboard (if both exist)
  if (dashboardServer && scheduler) {
    dashboardServer.scheduler = scheduler;
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
    if (scheduler) scheduler.stop();
    await runner.shutdown();
    await processManager.shutdownAll();
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
