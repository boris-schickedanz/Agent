/**
 * The core ReAct agent loop.
 * For each inbound message: load context → call LLM → parse → execute tools → loop until done.
 */
export class AgentLoop {
  constructor({
    llmProvider,
    promptBuilder,
    toolExecutor,
    toolRegistry,
    toolPolicy,
    contextCompactor,
    sessionManager,
    permissionManager,
    eventBus,
    logger,
    config,
  }) {
    this.llm = llmProvider;
    this.promptBuilder = promptBuilder;
    this.toolExecutor = toolExecutor;
    this.toolRegistry = toolRegistry;
    this.toolPolicy = toolPolicy;
    this.compactor = contextCompactor;
    this.sessions = sessionManager;
    this.permissionManager = permissionManager || null;
    this.skillLoader = null;
    this.eventBus = eventBus;
    this.logger = logger;
    this.maxIterations = config.maxToolIterations;
  }

  async processMessage(normalizedMessage) {
    const { sessionId: routeSessionId, channelId, userId, userName, content } = normalizedMessage;

    // 1. Resolve canonical sessionId and get or create session
    const sessionId = this.sessions.resolveSessionId(normalizedMessage);
    const session = this.sessions.getOrCreate(sessionId, userId, channelId, userName);
    session.lastUserMessage = content;

    // 2. Load conversation history
    const history = this.sessions.loadHistory(sessionId);

    // 3. Resolve available tools for this user
    const allowedTools = this.toolPolicy
      ? new Set(this.toolPolicy.getEffectiveToolNames(userId, session))
      : null;
    const toolSchemas = this.toolRegistry.getSchemas(allowedTools);

    // 4. Build system prompt (with skill trigger matching)
    let skillInstructions = null;
    if (this.skillLoader) {
      for (const skill of this.skillLoader.getLoadedSkills()) {
        if (skill.trigger && content.startsWith(skill.trigger)) {
          skillInstructions = skill.instructions;
          break;
        }
      }
    }
    const systemPrompt = await this.promptBuilder.build(session, toolSchemas, skillInstructions);

    // 5. Prepare messages array
    const messages = [
      ...history,
      { role: 'user', content },
    ];

    // 6. Track new messages to persist later
    const newMessages = [{ role: 'user', content }];

    // 7. ReAct loop
    let finalText = '';
    let totalUsage = { inputTokens: 0, outputTokens: 0 };
    const toolsUsed = [];

    for (let iteration = 0; iteration < this.maxIterations; iteration++) {
      // Check if context needs compaction
      if (this.compactor.shouldCompact(messages)) {
        const compacted = await this.compactor.compact(messages);
        messages.length = 0;
        messages.push(...compacted);
      }

      // Call LLM
      let response;
      try {
        response = await this.llm.createMessage(systemPrompt, messages, toolSchemas);
      } catch (err) {
        this.logger.error({ err: err.message, iteration }, 'LLM call failed');
        finalText = 'I encountered an error processing your message. Please try again.';
        break;
      }

      totalUsage.inputTokens += response.usage.inputTokens;
      totalUsage.outputTokens += response.usage.outputTokens;

      // If the model produced a final response (no tool calls)
      if (response.stopReason === 'end_turn' || response.stopReason === 'stop') {
        finalText = response.content
          .filter(b => b.type === 'text')
          .map(b => b.text)
          .join('\n');

        // Add assistant response to new messages for persistence
        newMessages.push({ role: 'assistant', content: finalText });
        break;
      }

      // If the model wants to use tools
      if (response.stopReason === 'tool_use') {
        // Push assistant message with tool_use blocks
        messages.push({ role: 'assistant', content: response.content });
        newMessages.push({ role: 'assistant', content: response.content });

        // Execute each tool call
        const toolResults = [];
        for (const block of response.content) {
          if (block.type !== 'tool_use') continue;

          toolsUsed.push(block.name);
          this.logger.info({ tool: block.name, iteration }, 'Executing tool');

          const result = await this.toolExecutor.execute(block.name, block.input, session);

          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: result.success ? result.result : `Error: ${result.error}`,
          });

          this.eventBus.emit('tool:executed', {
            tool: block.name,
            success: result.success,
            durationMs: result.durationMs,
            sessionId,
          });
        }

        // Push tool results as a user message
        messages.push({ role: 'user', content: toolResults });
        newMessages.push({ role: 'user', content: toolResults });
        continue;
      }

      // Unexpected stop reason - extract any text and break
      finalText = response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n') || 'I completed processing your request.';
      newMessages.push({ role: 'assistant', content: finalText });
      break;
    }

    // If we hit max iterations without a final response
    if (!finalText) {
      finalText = 'I reached the maximum number of processing steps. Here is what I have so far.';
      newMessages.push({ role: 'assistant', content: finalText });
    }

    // 8. Apply outbound guardrails to the final assistant text before persistence
    if (this.permissionManager) {
      const guardrail = this.permissionManager.checkModelGuardrails(finalText);
      finalText = guardrail.content;
    }

    this._upsertFinalAssistantMessage(newMessages, finalText);

    // 9. Persist new messages
    this.sessions.appendMessages(sessionId, newMessages);

    // 10. Emit outbound message
    const outbound = {
      sessionId: routeSessionId || sessionId,
      channelId,
      userId,
      content: finalText,
      replyTo: normalizedMessage.id || null,
      metadata: {
        toolsUsed,
        tokenUsage: totalUsage,
        processingTimeMs: 0, // Will be set by caller
      },
    };

    this.eventBus.emit('message:outbound', outbound);

    return outbound;
  }

  _upsertFinalAssistantMessage(messages, finalText) {
    if (!finalText) return;

    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message.role === 'assistant' && typeof message.content === 'string') {
        messages[index] = { ...message, content: finalText };
        return;
      }
    }

    messages.push({ role: 'assistant', content: finalText });
  }
}
