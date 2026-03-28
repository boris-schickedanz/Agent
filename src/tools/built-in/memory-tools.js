const WORKSPACE_STATE_KEYS = new Set(['project_state', 'decision_journal', 'session_log']);

export function registerMemoryTools(registry, persistentMemory, memorySearch, projectManager = null) {
  registry.register({
    name: 'save_memory',
    class: 'brokered',
    description: 'Save information to long-term persistent memory. Reserved keys (project_state, decision_journal, session_log) are saved to the active project when one exists. All other keys are stored globally.',
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
      const memory = _resolveMemory(input.key, persistentMemory, projectManager);
      await memory.save(input.key, input.content);
      const projectNote = (WORKSPACE_STATE_KEYS.has(input.key) && projectManager?.getActive())
        ? ` (project: ${projectManager.getActive()})`
        : '';
      return `Memory saved with key: ${input.key}${projectNote}`;
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

  if (projectManager) {
    registry.register({
      name: 'switch_project',
      class: 'brokered',
      description: 'Switch the active project context. Creates the project if it does not exist yet. Use this when the user starts working on a different topic or project.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Project name (will be slugified for storage)',
          },
        },
        required: ['name'],
      },
      handler: async (input) => {
        const slug = projectManager.slugify(input.name);
        if (!slug) return 'Error: project name is empty after slugification.';
        projectManager.setActive(slug);
        const mem = projectManager.getActiveMemory();
        const state = await mem.load('project_state');
        if (state) {
          return `Switched to project: ${slug} (existing project with state)`;
        }
        return `Switched to project: ${slug} (new project — initialize project_state when ready)`;
      },
      permissions: ['memory:write'],
    });
  }
}

function _resolveMemory(key, globalMemory, projectManager) {
  if (WORKSPACE_STATE_KEYS.has(key) && projectManager) {
    const activeMem = projectManager.getActiveMemory();
    if (activeMem) return activeMem;
  }
  return globalMemory;
}
