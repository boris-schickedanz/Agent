import { MemoryFlusher } from '../brain/memory-flusher.js';

/**
 * Intercepts host commands (e.g. /new) before they reach the LLM pipeline.
 * Returns { handled, forwardContent } to indicate whether the message was
 * consumed and whether remaining content should be forwarded.
 */
export class CommandRouter {
  constructor({ sessionManager, conversationMemory, llmProvider, toolExecutor,
                toolRegistry, promptBuilder, config, eventBus, logger }) {
    this.sessionManager = sessionManager;
    this.conversationMemory = conversationMemory;
    this.llmProvider = llmProvider || null;
    this.toolRegistry = toolRegistry || (toolExecutor ? toolExecutor.registry : null);
    this.promptBuilder = promptBuilder || null;
    this.config = config;
    this.eventBus = eventBus;
    this.logger = logger;
    this.memoryFlusher = (llmProvider && toolExecutor)
      ? new MemoryFlusher(llmProvider, toolExecutor, logger)
      : null;
  }

  /**
   * @param {object} sanitizedMessage - Normalized, sanitized inbound message
   * @returns {Promise<{ handled: boolean, forwardContent?: string }>}
   */
  async handle(sanitizedMessage) {
    const content = sanitizedMessage.content.trim();

    if (content === '/new' || content.startsWith('/new ')) {
      return this._handleNew(sanitizedMessage, content);
    }

    return { handled: false };
  }

  async _handleNew(message, content) {
    const sessionId = this.sessionManager.resolveSessionId(message);

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
