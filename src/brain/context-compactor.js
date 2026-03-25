export class ContextCompactor {
  constructor(llmProvider, config) {
    this.llmProvider = llmProvider;
    this.threshold = config.compactionThreshold;
  }

  shouldCompact(messages) {
    return this.llmProvider.estimateTokens(messages) > this.threshold;
  }

  async compact(messages) {
    if (messages.length < 4) return messages;

    // Keep the most recent messages, summarize the older ones
    const splitPoint = Math.floor(messages.length / 2);
    const olderMessages = messages.slice(0, splitPoint);
    const recentMessages = messages.slice(splitPoint);

    const summaryPrompt = 'Summarize the following conversation concisely, preserving key facts, decisions, tool results, and user preferences. Output only the summary.';

    const summaryMessages = [
      {
        role: 'user',
        content: `${summaryPrompt}\n\n${JSON.stringify(olderMessages.map(m => ({
          role: m.role,
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
        })))}`
      }
    ];

    try {
      const response = await this.llmProvider.createMessage(
        'You are a conversation summarizer. Be concise but preserve important details.',
        summaryMessages,
        []
      );

      const summaryText = response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n');

      const summaryMessage = {
        role: 'user',
        content: `[Previous conversation summary]: ${summaryText}`
      };

      return [summaryMessage, ...recentMessages];
    } catch {
      // If summarization fails, just truncate
      return recentMessages;
    }
  }
}
