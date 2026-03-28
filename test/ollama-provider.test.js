import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { OllamaProvider } from '../src/brain/ollama-provider.js';

const mockLogger = { warn: () => {}, info: () => {}, error: () => {} };

function makeProvider(apiKey = '') {
  return new OllamaProvider(
    { ollamaHost: 'http://localhost:11434', ollamaModel: 'llama3.1', ollamaApiKey: apiKey },
    mockLogger
  );
}

// Minimal valid OpenAI chat completion response
function mockCompletionResponse() {
  return {
    choices: [{ message: { content: 'Hello', tool_calls: null }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

// Minimal SSE stream body
function mockStreamBody(content = 'Hello') {
  const lines = [
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
    'data: [DONE]\n\n',
  ];
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
}

describe('OllamaProvider', () => {
  describe('_buildHeaders()', () => {
    it('returns only Content-Type when no API key is set', () => {
      const provider = makeProvider();
      const headers = provider._buildHeaders();
      assert.deepStrictEqual(headers, { 'Content-Type': 'application/json' });
      assert.equal(headers['Authorization'], undefined);
    });

    it('includes Authorization Bearer header when API key is set', () => {
      const provider = makeProvider('my-secret-key');
      const headers = provider._buildHeaders();
      assert.deepStrictEqual(headers, {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer my-secret-key',
      });
    });
  });

  describe('createMessage() auth header', () => {
    let originalFetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('sends Authorization header when API key is set', async () => {
      let capturedHeaders;
      globalThis.fetch = mock.fn(async (url, opts) => {
        capturedHeaders = opts.headers;
        return { ok: true, json: async () => mockCompletionResponse() };
      });

      const provider = makeProvider('test-key');
      await provider.createMessage('system', []);

      assert.equal(capturedHeaders['Authorization'], 'Bearer test-key');
    });

    it('omits Authorization header when API key is empty', async () => {
      let capturedHeaders;
      globalThis.fetch = mock.fn(async (url, opts) => {
        capturedHeaders = opts.headers;
        return { ok: true, json: async () => mockCompletionResponse() };
      });

      const provider = makeProvider();
      await provider.createMessage('system', []);

      assert.equal(capturedHeaders['Authorization'], undefined);
    });
  });

  describe('streamMessage() tool call accumulation', () => {
    let originalFetch;

    beforeEach(() => { originalFetch = globalThis.fetch; });
    afterEach(() => { globalThis.fetch = originalFetch; });

    it('does not concatenate tool names across repeated SSE chunks', async () => {
      // Simulate two SSE chunks that both carry the full tool name (common with Ollama/OpenAI)
      const chunks = [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'http_get', arguments: '{"ur' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'http_get', arguments: 'l":"x"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
      ];
      const lines = chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).concat('data: [DONE]\n\n');
      const encoder = new TextEncoder();
      const body = new ReadableStream({
        start(controller) {
          for (const line of lines) controller.enqueue(encoder.encode(line));
          controller.close();
        },
      });
      globalThis.fetch = mock.fn(async () => ({ ok: true, body }));

      const provider = makeProvider();
      const result = await provider.streamMessage('system', [], [{ name: 'http_get', description: 'fetch', input_schema: { type: 'object' } }], () => {});

      const toolBlock = result.content.find(b => b.type === 'tool_use');
      assert.ok(toolBlock, 'expected a tool_use block');
      assert.equal(toolBlock.name, 'http_get', 'tool name must not be concatenated');
      assert.deepStrictEqual(toolBlock.input, { url: 'x' });
    });
  });

  describe('streamMessage() auth header', () => {
    let originalFetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('sends Authorization header when API key is set', async () => {
      let capturedHeaders;
      globalThis.fetch = mock.fn(async (url, opts) => {
        capturedHeaders = opts.headers;
        return { ok: true, body: mockStreamBody() };
      });

      const provider = makeProvider('stream-key');
      await provider.streamMessage('system', [], [], () => {});

      assert.equal(capturedHeaders['Authorization'], 'Bearer stream-key');
    });
  });
});
