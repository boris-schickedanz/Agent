/**
 * The core ReAct agent loop.
 * Accepts pre-loaded data from the host and returns structured results.
 * Does not perform session resolution, history loading, tool resolution,
 * persistence, guardrails, or outbound emission — those are host concerns.
 */
export class AgentLoop {
  constructor({
    llmProvider,
    promptBuilder,
    toolExecutor,
    contextCompactor,
    logger,
    config,
  }) {
    this.llm = llmProvider;
    this.promptBuilder = promptBuilder;
    this.toolExecutor = toolExecutor;
    this.compactor = contextCompactor;
    this.logger = logger;
    this.defaultMaxIterations = config.maxToolIterations;
  }

  /**
   * @param {object} params
   * @param {Message[]} params.history - Pre-loaded conversation history
   * @param {string} params.userContent - User message content
   * @param {object[]} params.toolSchemas - Resolved tool schemas
   * @param {object[]} params.memorySnippets - Pre-searched memory results
   * @param {string|null} params.skillInstructions - Matched skill instructions
   * @param {object} params.sessionMetadata - Session metadata
   * @param {number} params.maxIterations - Max ReAct iterations
   * @param {object} params.cancellationSignal - { cancelled: boolean }
   */
  async processMessage({
    history,
    userContent,
    toolSchemas,
    memorySnippets,
    skillInstructions,
    sessionMetadata,
    maxIterations,
    cancellationSignal,
  }) {
    const iterationCap = maxIterations || this.defaultMaxIterations;

    // Build system prompt from request data
    const sessionForPrompt = {
      id: sessionMetadata?.sessionId || 'unknown',
      userId: sessionMetadata?.userId || 'unknown',
      channelId: sessionMetadata?.channelId || 'unknown',
      userName: sessionMetadata?.userName || null,
      lastUserMessage: userContent,
      metadata: sessionMetadata || {},
    };

    const systemPrompt = await this.promptBuilder.build(
      sessionForPrompt,
      toolSchemas,
      skillInstructions,
      memorySnippets,
    );

    // Prepare messages array
    const messages = [
      ...history,
      { role: 'user', content: userContent },
    ];

    // Track new messages for host persistence
    const newMessages = [{ role: 'user', content: userContent }];

    // ReAct loop
    let finalText = '';
    let totalUsage = { inputTokens: 0, outputTokens: 0 };
    const toolsUsed = [];
    let iterationCount = 0;
    let status = 'completed';
    let error = null;

    for (let iteration = 0; iteration < iterationCap; iteration++) {
      // Check cancellation between iterations
      if (cancellationSignal && cancellationSignal.cancelled) {
        status = 'cancelled';
        error = { code: 'cancelled', message: 'Execution was cancelled', retriable: false };
        break;
      }

      iterationCount = iteration + 1;

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
        status = 'error';
        error = { code: 'llm_error', message: err.message, retriable: true };
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

        newMessages.push({ role: 'assistant', content: finalText });
        break;
      }

      // If the model wants to use tools
      if (response.stopReason === 'tool_use') {
        messages.push({ role: 'assistant', content: response.content });
        newMessages.push({ role: 'assistant', content: response.content });

        const toolResults = [];
        for (const block of response.content) {
          if (block.type !== 'tool_use') continue;

          toolsUsed.push(block.name);
          this.logger.info({ tool: block.name, iteration }, 'Executing tool');

          const result = await this.toolExecutor.execute(block.name, block.input, sessionForPrompt);

          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: result.success ? result.result : `Error: ${result.error}`,
          });
        }

        messages.push({ role: 'user', content: toolResults });
        newMessages.push({ role: 'user', content: toolResults });
        continue;
      }

      // Unexpected stop reason
      finalText = response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n') || 'I completed processing your request.';
      newMessages.push({ role: 'assistant', content: finalText });
      break;
    }

    // If we hit max iterations without a final response
    if (!finalText && status === 'completed') {
      finalText = 'I reached the maximum number of processing steps. Here is what I have so far.';
      newMessages.push({ role: 'assistant', content: finalText });
      status = 'max_iterations';
      error = { code: 'max_iterations', message: 'ReAct loop hit the iteration cap', retriable: false };
    }

    return {
      content: finalText,
      newMessages,
      toolsUsed,
      tokenUsage: totalUsage,
      iterationCount,
      status,
      error,
    };
  }

}
