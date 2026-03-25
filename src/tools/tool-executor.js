import { validateInput } from './tool-schema.js';

export class ToolExecutor {
  constructor(toolRegistry, toolPolicy, logger) {
    this.registry = toolRegistry;
    this.policy = toolPolicy;
    this.logger = logger;
  }

  async execute(toolName, toolInput, session) {
    const start = Date.now();

    // 1. Look up tool
    const tool = this.registry.get(toolName);
    if (!tool) {
      return { success: false, result: null, error: `Unknown tool: ${toolName}`, durationMs: 0 };
    }

    // 2. Check permissions
    if (this.policy) {
      const allowed = this.policy.isAllowed(toolName, session.userId, session);
      if (!allowed) {
        this.logger.warn({ toolName, userId: session.userId }, 'Tool access denied');
        return { success: false, result: null, error: `Permission denied for tool: ${toolName}`, durationMs: 0 };
      }
    }

    // 3. Validate input
    const validation = validateInput(toolInput, tool.inputSchema);
    if (!validation.valid) {
      return {
        success: false,
        result: null,
        error: `Invalid input: ${validation.errors.join(', ')}`,
        durationMs: Date.now() - start,
      };
    }

    // 4. Execute with timeout
    try {
      const context = {
        sessionId: session.id,
        userId: session.userId,
        channelId: session.channelId,
        logger: this.logger,
      };

      const result = await Promise.race([
        tool.handler(toolInput, context),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Tool '${toolName}' timed out after ${tool.timeout}ms`)), tool.timeout)
        ),
      ]);

      const durationMs = Date.now() - start;
      this.logger.info({ toolName, durationMs }, 'Tool executed');

      return {
        success: true,
        result: typeof result === 'string' ? result : JSON.stringify(result),
        error: null,
        durationMs,
      };
    } catch (err) {
      const durationMs = Date.now() - start;
      this.logger.error({ toolName, err: err.message, durationMs }, 'Tool execution failed');

      return {
        success: false,
        result: null,
        error: err.message,
        durationMs,
      };
    }
  }
}
