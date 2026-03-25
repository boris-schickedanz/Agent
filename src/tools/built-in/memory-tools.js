export function registerMemoryTools(registry, persistentMemory, memorySearch) {
  registry.register({
    name: 'save_memory',
    class: 'brokered',
    description: 'Save information to long-term persistent memory. Use this to remember important facts, preferences, or decisions across conversations.',
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'A short, descriptive identifier for this memory (e.g., "user_preferences", "project_goals")',
        },
        content: {
          type: 'string',
          description: 'The content to remember',
        },
      },
      required: ['key', 'content'],
    },
    handler: async (input) => {
      await persistentMemory.save(input.key, input.content);
      return `Memory saved with key: ${input.key}`;
    },
    permissions: ['memory:write'],
  });

  registry.register({
    name: 'search_memory',
    class: 'brokered',
    description: 'Search through long-term persistent memory using natural language queries.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query to find relevant memories',
        },
        limit: {
          type: 'integer',
          description: 'Maximum number of results to return (default: 5)',
          minimum: 1,
          maximum: 20,
        },
      },
      required: ['query'],
    },
    handler: async (input) => {
      const results = memorySearch.search(input.query, input.limit || 5);
      if (results.length === 0) {
        return 'No memories found matching your query.';
      }
      return results
        .map(r => `**${r.key}**: ${r.content}`)
        .join('\n\n');
    },
    permissions: ['memory:read'],
  });

  registry.register({
    name: 'list_memories',
    class: 'brokered',
    description: 'List all stored memory keys.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const keys = await persistentMemory.list();
      if (keys.length === 0) return 'No memories stored yet.';
      return `Stored memories:\n${keys.map(k => `- ${k}`).join('\n')}`;
    },
    permissions: ['memory:read'],
  });
}
