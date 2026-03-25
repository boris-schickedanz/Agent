import { LLMProvider } from './llm-provider.js';

export class OllamaProvider extends LLMProvider {
  constructor(config, logger) {
    super();
    this.baseUrl = config.ollamaHost || 'http://localhost:11434';
    this.model = config.ollamaModel || 'llama3.1';
    this.logger = logger;
    this.maxRetries = 3;
  }

  get supportsStreaming() {
    return true;
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

  async streamMessage(systemPrompt, messages, tools = [], onTextDelta) {
    const openaiMessages = [
      { role: 'system', content: systemPrompt },
      ...this._convertMessages(messages),
    ];

    const body = {
      model: this.model,
      messages: openaiMessages,
      stream: true,
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

        // Parse SSE stream and accumulate the full response
        const accumulated = { content: '', toolCalls: [], usage: { prompt_tokens: 0, completion_tokens: 0 } };

        for await (const chunk of this._parseSSE(res.body)) {
          if (chunk.choices?.[0]?.delta?.content) {
            const text = chunk.choices[0].delta.content;
            accumulated.content += text;
            if (onTextDelta) onTextDelta(text);
          }
          if (chunk.choices?.[0]?.delta?.tool_calls) {
            for (const tc of chunk.choices[0].delta.tool_calls) {
              const idx = tc.index ?? accumulated.toolCalls.length;
              if (!accumulated.toolCalls[idx]) {
                accumulated.toolCalls[idx] = { id: tc.id || '', function: { name: '', arguments: '' } };
              }
              if (tc.id) accumulated.toolCalls[idx].id = tc.id;
              if (tc.function?.name) accumulated.toolCalls[idx].function.name += tc.function.name;
              if (tc.function?.arguments) accumulated.toolCalls[idx].function.arguments += tc.function.arguments;
            }
          }
          if (chunk.usage) {
            accumulated.usage.prompt_tokens = chunk.usage.prompt_tokens || accumulated.usage.prompt_tokens;
            accumulated.usage.completion_tokens = chunk.usage.completion_tokens || accumulated.usage.completion_tokens;
          }
        }

        // Build response in the same format as createMessage
        return this._convertStreamResult(accumulated);
      } catch (err) {
        const retryable = err.status === 429 || err.status === 500 || err.status === 503;
        if (retryable && attempt < this.maxRetries) {
          const delay = Math.pow(2, attempt) * 1000;
          this.logger.warn({ attempt, delay, status: err.status }, 'Retrying Ollama call (stream)');
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
  }

  async *_parseSSE(body) {
    const decoder = new TextDecoder();
    let buffer = '';

    for await (const chunk of body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') return;
        try {
          yield JSON.parse(data);
        } catch { /* skip malformed chunks */ }
      }
    }
  }

  _convertStreamResult(accumulated) {
    const content = [];

    if (accumulated.content) {
      content.push({ type: 'text', text: accumulated.content });
    }

    let stopReason = 'end_turn';

    if (accumulated.toolCalls.length > 0) {
      stopReason = 'tool_use';
      for (const tc of accumulated.toolCalls) {
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
    }

    return {
      content,
      stopReason,
      usage: {
        inputTokens: accumulated.usage.prompt_tokens || 0,
        outputTokens: accumulated.usage.completion_tokens || 0,
      },
    };
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
