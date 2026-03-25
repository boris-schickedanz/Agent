import Anthropic from '@anthropic-ai/sdk';
import { LLMProvider } from './llm-provider.js';

export class AnthropicProvider extends LLMProvider {
  constructor(config, logger) {
    super();
    this.client = config.anthropicAuthToken
      ? new Anthropic({ authToken: config.anthropicAuthToken, apiKey: null })
      : new Anthropic({ apiKey: config.anthropicApiKey });
    this.model = config.model;
    this.logger = logger;
    this.maxRetries = 3;
  }

  async createMessage(systemPrompt, messages, tools = []) {
    const params = {
      model: this.model,
      max_tokens: 8192,
      system: systemPrompt,
      messages,
    };

    if (tools.length > 0) {
      params.tools = tools;
    }

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.client.messages.create(params);

        return {
          content: response.content,
          stopReason: response.stop_reason,
          usage: {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
          },
        };
      } catch (err) {
        const retryable = err.status === 429 || err.status === 500 || err.status === 529;
        if (retryable && attempt < this.maxRetries) {
          const delay = Math.pow(2, attempt) * 1000;
          this.logger.warn({ attempt, delay, status: err.status }, 'Retrying LLM call');
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
  }

  estimateTokens(messages) {
    // Anthropic-specific: slightly better estimate
    const text = JSON.stringify(messages);
    return Math.ceil(text.length / 3.5);
  }
}
