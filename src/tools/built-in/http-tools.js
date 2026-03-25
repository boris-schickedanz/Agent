export function registerHttpTools(registry) {
  registry.register({
    name: 'http_get',
    description: 'Fetch content from a URL via HTTP GET. Returns the response body as text.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to fetch',
        },
        headers: {
          type: 'object',
          description: 'Optional HTTP headers as key-value pairs',
        },
      },
      required: ['url'],
    },
    handler: async (input) => {
      const response = await fetch(input.url, {
        method: 'GET',
        headers: input.headers || {},
        signal: AbortSignal.timeout(15_000),
      });
      const text = await response.text();
      if (!response.ok) {
        return `HTTP ${response.status}: ${text.substring(0, 1000)}`;
      }
      // Truncate large responses
      return text.length > 10_000 ? text.substring(0, 10_000) + '\n...[truncated]' : text;
    },
    permissions: ['network:outbound'],
    timeout: 20_000,
  });

  registry.register({
    name: 'http_post',
    description: 'Send data to a URL via HTTP POST. Returns the response body as text.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to POST to',
        },
        body: {
          type: 'object',
          description: 'JSON body to send',
        },
        headers: {
          type: 'object',
          description: 'Optional HTTP headers as key-value pairs',
        },
      },
      required: ['url'],
    },
    handler: async (input) => {
      const headers = { 'Content-Type': 'application/json', ...(input.headers || {}) };
      const response = await fetch(input.url, {
        method: 'POST',
        headers,
        body: input.body ? JSON.stringify(input.body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
      const text = await response.text();
      if (!response.ok) {
        return `HTTP ${response.status}: ${text.substring(0, 1000)}`;
      }
      return text.length > 10_000 ? text.substring(0, 10_000) + '\n...[truncated]' : text;
    },
    permissions: ['network:outbound'],
    timeout: 20_000,
  });
}
