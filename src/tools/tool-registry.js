export class ToolRegistry {
  constructor() {
    this._tools = new Map();
  }

  register(toolDef) {
    const { name, description, inputSchema, handler } = toolDef;
    if (!name || !description || !handler) {
      throw new Error(`Tool registration requires name, description, and handler. Got: ${name}`);
    }
    this._tools.set(name, {
      name,
      description,
      inputSchema: inputSchema || { type: 'object', properties: {} },
      handler,
      permissions: toolDef.permissions || [],
      timeout: toolDef.timeout || 30_000,
      class: toolDef.class || 'runtime',
    });
  }

  get(name) {
    return this._tools.get(name) || null;
  }

  getAll() {
    return Array.from(this._tools.values());
  }

  /**
   * Return tool schemas in Anthropic API format.
   * Optionally filter by a set of allowed tool names.
   */
  getSchemas(filterNames = null) {
    const tools = filterNames
      ? this.getAll().filter(t => filterNames.has(t.name))
      : this.getAll();

    return tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
  }

  unregister(name) {
    this._tools.delete(name);
  }

  has(name) {
    return this._tools.has(name);
  }
}
