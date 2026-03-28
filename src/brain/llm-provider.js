/**
 * Abstract LLM provider interface.
 * All providers must implement createMessage and estimateTokens.
 */
export class LLMProvider {
  get supportsStreaming() {
    return false;
  }

  async createMessage(systemPrompt, messages, tools) {
    throw new Error('Not implemented');
  }

  async streamMessage(systemPrompt, messages, tools, onTextDelta) {
    throw new Error('Not implemented');
  }

  getModel() {
    return this.model || null;
  }

  setModel(name) {
    this.model = name;
  }

  estimateTokens(messages) {
    // Rough estimate: ~4 chars per token
    const text = JSON.stringify(messages);
    return Math.ceil(text.length / 4);
  }
}
