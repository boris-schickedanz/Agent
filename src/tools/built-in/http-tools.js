const BLOCKED_HOSTS = ['localhost', '127.0.0.1', '[::1]', '0.0.0.0', '169.254.169.254'];

export function validateUrl(urlString) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error('Invalid URL');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Blocked protocol: ${parsed.protocol}`);
  }

  if (BLOCKED_HOSTS.includes(parsed.hostname)) {
    throw new Error('Blocked host');
  }

  // Block private IP ranges (10.x, 172.16-31.x, 192.168.x)
  const ipMatch = parsed.hostname.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (ipMatch) {
    const a = Number(ipMatch[1]);
    const b = Number(ipMatch[2]);
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
      throw new Error('Blocked private IP range');
    }
  }
}

export function registerHttpTools(registry) {
  registry.register({
    name: 'http_get',
    class: 'brokered',
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
      validateUrl(input.url);
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
    class: 'brokered',
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
      validateUrl(input.url);
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
