const NO_OP_LOGGER = { info() {}, warn() {}, error() {} };

export class ContextCompactor {
  constructor(llmProvider, config, logger = null) {
    this.llmProvider = llmProvider;
    this.threshold = config.compactionThreshold;
    this.retainMessages = config.compactionRetainMessages ?? 10;
    this.logger = logger || NO_OP_LOGGER;
  }

  shouldCompact(messages) {
    return this.llmProvider.estimateTokens(messages) > this.threshold;
  }

  async compact(messages) {
    // Need enough messages to both summarize and retain
    const minMessages = this.retainMessages + 4;
    if (messages.length < minMessages) return messages;

    const splitPoint = messages.length - this.retainMessages;
    const olderMessages = messages.slice(0, splitPoint);
    const recentMessages = messages.slice(splitPoint);

    // Detect prior summary for rolling compression
    const hasPriorSummary = typeof olderMessages[0]?.content === 'string'
      && olderMessages[0].content.startsWith('[Previous conversation summary]');

    const prompt = hasPriorSummary
      ? 'You are updating a running conversation summary. The previous summary and new messages since then are provided below. Produce a single merged summary that incorporates both. Preserve key facts, decisions, tool results, and user preferences. Output only the summary.'
      : 'Summarize the following conversation concisely, preserving key facts, decisions, tool results, and user preferences. Output only the summary.';

    try {
      const response = await this.llmProvider.createMessage(
        'You are a conversation summarizer. Be concise but preserve important details.',
        [{ role: 'user', content: `${prompt}\n\n${this._formatMessages(olderMessages)}` }],
        []
      );

      const summaryText = response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n');

      return [
        { role: 'user', content: `[Previous conversation summary]: ${summaryText}` },
        ...recentMessages,
      ];
    } catch (err) {
      this.logger.warn({ err: err.message, droppedMessages: olderMessages.length },
        'Context summarization failed; older messages dropped');
      return [
        { role: 'user', content: '[Previous conversation summary]: [Summarization failed. Some earlier context may be missing.]' },
        ...recentMessages,
      ];
    }
  }

  _formatMessages(messages) {
    return messages.map(m => {
      const content = typeof m.content === 'string'
        ? m.content
        : JSON.stringify(m.content);
      return `[${m.role}]: ${content}`;
    }).join('\n\n');
  }
}
