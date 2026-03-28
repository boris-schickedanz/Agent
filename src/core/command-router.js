import { MemoryFlusher } from '../brain/memory-flusher.js';

/**
 * Intercepts host commands (e.g. /new, /approve, /reject, /agent) before they
 * reach the LLM pipeline.
 * Returns { handled, forwardContent } to indicate whether the message was
 * consumed and whether remaining content should be forwarded.
 */
export class CommandRouter {
  constructor({ sessionManager, conversationMemory, llmProvider, toolExecutor,
                toolRegistry, promptBuilder, config, eventBus, logger,
                approvalManager, agentRegistry }) {
    this.sessionManager = sessionManager;
    this.conversationMemory = conversationMemory;
    this.llmProvider = llmProvider || null;
    this.toolRegistry = toolRegistry || (toolExecutor ? toolExecutor.registry : null);
    this.promptBuilder = promptBuilder || null;
    this.config = config;
    this.eventBus = eventBus;
    this.logger = logger;
    this.approvalManager = approvalManager || null;
    this.agentRegistry = agentRegistry || null;
    this.memoryFlusher = (llmProvider && toolExecutor)
      ? new MemoryFlusher(llmProvider, toolExecutor, logger)
      : null;
  }

  /**
   * @param {object} sanitizedMessage - Normalized, sanitized inbound message
   * @returns {Promise<{ handled: boolean, forwardContent?: string }>}
   */
  async handle(sanitizedMessage) {
    // Strip @BotName suffix from Telegram-style commands (e.g. /approve@MyBot → /approve)
    const content = sanitizedMessage.content.trim().replace(/^(\/\w+)@\S+/, '$1');

    if (content === '/new' || content.startsWith('/new ')) {
      return this._handleNew(sanitizedMessage, content);
    }

    if (content === '/approve' || content === '/yes') {
      return this._handleApprove(sanitizedMessage, true);
    }

    if (content === '/reject' || content === '/no') {
      return this._handleApprove(sanitizedMessage, false);
    }

    if (content.startsWith('/agent ')) {
      return this._handleAgent(sanitizedMessage, content);
    }

    if (content === '/model' || content.startsWith('/model ')) {
      return this._handleModel(sanitizedMessage, content);
    }

    return { handled: false };
  }

  _handleApprove(message, approved) {
    if (!this.approvalManager) {
      this._respond(message, 'Approval system is not enabled.');
      return { handled: true };
    }

    const sessionId = this.sessionManager.resolveSessionId(message);
    const pending = this.approvalManager.getPending(sessionId);

    if (!pending) {
      this._respond(message, 'No pending approval request.');
      return { handled: true };
    }

    this.approvalManager.resolve(sessionId, approved, approved ? null : 'User rejected');

    if (approved) {
      // Grant temporary approval so the retried tool call bypasses the check
      this.approvalManager.grantApproval(sessionId, pending.toolName);
      this._respond(message, 'Approved. Continuing...');
      // Forward to pipeline so the agent loop retries the tool
      return { handled: true, forwardContent: `[User approved the ${pending.toolName} operation. Continue.]` };
    } else {
      this._respond(message, 'Rejected. Operation cancelled.');
      return { handled: true };
    }
  }

  _handleAgent(message, content) {
    if (!this.agentRegistry) {
      this._respond(message, 'Agent profiles are not enabled.');
      return { handled: true };
    }

    const agentName = content.slice('/agent '.length).trim();

    if (agentName === 'list') {
      const agents = this.agentRegistry.list();
      if (agents.length === 0) {
        this._respond(message, 'No agent profiles found.');
      } else {
        const list = agents.map(a => `- **${a.name}**: ${a.description}`).join('\n');
        this._respond(message, `Available agents:\n${list}`);
      }
      return { handled: true };
    }

    if (agentName === 'default' || agentName === 'reset') {
      const sessionId = this.sessionManager.resolveSessionId(message);
      const session = this.sessionManager.getOrCreate(sessionId, message.userId, message.channelId, message.userName);
      if (session.metadata) {
        delete session.metadata.agentName;
      }
      this._respond(message, 'Switched to default agent.');
      return { handled: true };
    }

    const profile = this.agentRegistry.get(agentName);
    if (!profile) {
      this._respond(message, `Agent profile "${agentName}" not found. Use /agent list to see available profiles.`);
      return { handled: true };
    }

    const sessionId = this.sessionManager.resolveSessionId(message);
    const session = this.sessionManager.getOrCreate(sessionId, message.userId, message.channelId, message.userName);
    if (!session.metadata) session.metadata = {};
    session.metadata.agentName = agentName;

    this._respond(message, `Switched to agent: **${profile.name}** — ${profile.description}`);
    return { handled: true };
  }

  _handleModel(message, content) {
    if (!this.llmProvider) {
      this._respond(message, 'LLM provider is not available.');
      return { handled: true };
    }

    const arg = content.slice('/model'.length).trim();

    if (!arg) {
      const current = this.llmProvider.getModel();
      this._respond(message, `Current model: **${current || 'unknown'}**`);
      return { handled: true };
    }

    const previous = this.llmProvider.getModel();
    this.llmProvider.setModel(arg);
    this._respond(message, `Model switched from **${previous}** to **${arg}**.`);
    return { handled: true };
  }

  async _handleNew(message, content) {
    const sessionId = this.sessionManager.resolveSessionId(message);

    // Clear approval cache for this session
    if (this.approvalManager) {
      this.approvalManager.clearSession(sessionId);
    }

    if (this.config.compactionMemoryFlush !== false && this.memoryFlusher) {
      this._respond(message, 'Saving important context before clearing...');
      await this._memoryFlushBeforeClear(sessionId, message);
    }

    this.conversationMemory.clearSession(sessionId);
    this.logger.info({ sessionId }, 'Session history cleared via /new');

    const trailing = content.slice('/new'.length).trim();

    if (trailing) {
      this._respond(message, 'Conversation cleared. Processing your message...');
      return { handled: true, forwardContent: trailing };
    }

    this._respond(message, 'Conversation cleared. Persistent memories are still available.');
    return { handled: true };
  }

  async _memoryFlushBeforeClear(sessionId, message) {
    try {
      const history = this.conversationMemory.getHistory(sessionId, 50);
      const tokenEstimate = this.llmProvider.estimateTokens(history);

      if (tokenEstimate < 2000) return;

      this.logger.info({ sessionId, tokenEstimate }, 'Running memory flush before /new');

      const sessionForPrompt = {
        id: sessionId,
        userId: message.userId,
        channelId: message.channelId,
        userName: message.userName || null,
        lastUserMessage: '/new',
        metadata: {},
      };

      const systemPrompt = await this.promptBuilder.build(sessionForPrompt, [], null, []);

      const flushPrompt = [
        '[System] The user is about to clear this conversation.',
        'Review the conversation history and save any important information to long-term memory using the save_memory tool. Focus on:',
        '- Key decisions and their reasoning',
        '- User preferences and corrections',
        '- Facts or data that would be lost',
        '- Ongoing task state or progress',
        'Only save what is genuinely important.',
      ].join('\n');

      const toolSchemas = this.toolRegistry ? this.toolRegistry.getSchemas() : [];

      await this.memoryFlusher.flush(systemPrompt, history, toolSchemas, sessionForPrompt, flushPrompt);
    } catch (err) {
      this.logger.warn({ err: err.message }, 'Memory flush before /new failed, proceeding with clear');
    }
  }

  _respond(message, text) {
    this.eventBus.emit('message:outbound', {
      sessionId: message.sessionId,
      channelId: message.channelId,
      userId: message.userId,
      content: text,
      replyTo: message.id || null,
      metadata: { toolsUsed: [], tokenUsage: { inputTokens: 0, outputTokens: 0 }, processingTimeMs: 0 },
    });
  }
}
