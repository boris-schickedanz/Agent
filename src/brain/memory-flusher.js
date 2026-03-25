/**
 * Shared logic for pre-compaction / pre-clear memory flush.
 * Sends a single LLM turn restricted to save_memory, then executes any tool calls.
 */
export class MemoryFlusher {
  constructor(llmProvider, toolExecutor, logger) {
    this.llm = llmProvider;
    this.toolExecutor = toolExecutor;
    this.logger = logger;
  }

  /**
   * Run a flush turn: inject flushPrompt, call LLM with only save_memory,
   * execute any save_memory calls, append results to messages.
   *
   * @param {string} systemPrompt
   * @param {Message[]} messages - mutated: flush prompt + response appended
   * @param {object[]} toolSchemas - full list; filtered internally to save_memory
   * @param {object} sessionForPrompt - session context for tool execution
   * @param {string} flushPrompt - the instruction text to inject
   */
  async flush(systemPrompt, messages, toolSchemas, sessionForPrompt, flushPrompt) {
    messages.push({ role: 'user', content: flushPrompt });

    const saveMemoryTools = toolSchemas.filter(t => t.name === 'save_memory');
    const response = await this.llm.createMessage(systemPrompt, messages, saveMemoryTools);

    if (response.stopReason === 'tool_use') {
      messages.push({ role: 'assistant', content: response.content });

      const toolResults = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use' || block.name !== 'save_memory') continue;
        this.logger.info({ tool: block.name }, 'Memory flush: save_memory call');
        const result = await this.toolExecutor.execute(block.name, block.input, sessionForPrompt);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: result.success ? result.result : `Error: ${result.error}`,
        });
      }
      messages.push({ role: 'user', content: toolResults });
    } else {
      messages.push({ role: 'assistant', content: response.content });
    }
  }
}
