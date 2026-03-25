import { LLMProvider } from './llm-provider.js';

export class OllamaProvider extends LLMProvider {
  constructor(config, logger) {
    super();
    this.baseUrl = config.ollamaHost || 'http://localhost:11434';
    this.model = config.ollamaModel || 'llama3.1';
    this.logger = logger;
    this.maxRetries = 3;
  }

  async createMessage(systemPrompt, messages, tools = []) {
    const openaiMessages = [
      { role: 'system', content: systemPrompt },
      ...this._convertMessages(messages),
    ];

    const body = {
      model: this.model,
      messages: openaiMessages,
      stream: false,
    };

    if (tools.length > 0) {
      body.tools = tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        },
      }));
    }

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const text = await res.text();
          const err = new Error(`${res.status} ${text}`);
          err.status = res.status;
          throw err;
        }

        const data = await res.json();
        return this._convertResponse(data);
      } catch (err) {
        const retryable = err.status === 429 || err.status === 500 || err.status === 503;
        if (retryable && attempt < this.maxRetries) {
          const delay = Math.pow(2, attempt) * 1000;
          this.logger.warn({ attempt, delay, status: err.status }, 'Retrying Ollama call');
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
  }

  _convertMessages(messages) {
    const result = [];
    for (const msg of messages) {
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        // Tool results in Anthropic format -> OpenAI tool messages
        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            result.push({
              role: 'tool',
              tool_call_id: block.tool_use_id,
              content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
            });
          }
        }
      } else if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        // Anthropic assistant content blocks -> OpenAI assistant message
        const textParts = [];
        const toolCalls = [];
        for (const block of msg.content) {
          if (block.type === 'text') {
            textParts.push(block.text);
          } else if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input),
              },
            });
          }
        }
        const assistantMsg = { role: 'assistant', content: textParts.join('\n') || null };
        if (toolCalls.length > 0) {
          assistantMsg.tool_calls = toolCalls;
        }
        result.push(assistantMsg);
      } else {
        result.push({ role: msg.role, content: msg.content });
      }
    }
    return result;
  }

  _convertResponse(data) {
    const choice = data.choices[0];
    const msg = choice.message;
    const content = [];

    if (msg.content) {
      content.push({ type: 'text', text: msg.content });
    }

    let stopReason = 'end_turn';

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      stopReason = 'tool_use';
      for (const tc of msg.tool_calls) {
        let args;
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          args = {};
        }
        content.push({
          type: 'tool_use',
          id: tc.id || `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          name: tc.function.name,
          input: args,
        });
      }
    } else if (choice.finish_reason === 'stop') {
      stopReason = 'end_turn';
    }

    return {
      content,
      stopReason,
      usage: {
        inputTokens: data.usage?.prompt_tokens || 0,
        outputTokens: data.usage?.completion_tokens || 0,
      },
    };
  }
}
