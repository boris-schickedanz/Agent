export function registerSystemTools(registry) {
  registry.register({
    name: 'get_current_time',
    description: 'Get the current date and time in ISO 8601 format',
    inputSchema: {
      type: 'object',
      properties: {
        timezone: {
          type: 'string',
          description: 'IANA timezone name (e.g., "Europe/Zurich"). Defaults to UTC.',
        },
      },
    },
    handler: async (input) => {
      const tz = input.timezone || 'UTC';
      try {
        return new Date().toLocaleString('en-US', {
          timeZone: tz,
          dateStyle: 'full',
          timeStyle: 'long',
        });
      } catch {
        return new Date().toISOString();
      }
    },
    permissions: [],
  });

  registry.register({
    name: 'wait',
    description: 'Wait for a specified number of seconds (max 30)',
    inputSchema: {
      type: 'object',
      properties: {
        seconds: {
          type: 'number',
          description: 'Number of seconds to wait (1-30)',
          minimum: 1,
          maximum: 30,
        },
      },
      required: ['seconds'],
    },
    handler: async (input) => {
      const seconds = Math.min(Math.max(input.seconds, 1), 30);
      await new Promise(r => setTimeout(r, seconds * 1000));
      return `Waited ${seconds} seconds.`;
    },
    permissions: [],
  });
}
