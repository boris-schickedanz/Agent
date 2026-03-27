import { validateInput } from './tool-schema.js';

export class ToolExecutor {
  constructor(toolRegistry, toolPolicy, logger, { auditLogger, approvalManager } = {}) {
    this.registry = toolRegistry;
    this.policy = toolPolicy;
    this.logger = logger;
    this.auditLogger = auditLogger || null;
    this.approvalManager = approvalManager || null;
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
        this._audit(toolName, toolInput, null, false, session, Date.now() - start);
        return { success: false, result: null, error: `Permission denied for tool: ${toolName}`, durationMs: 0 };
      }
    }

    // 2.5. Approval check
    if (this.approvalManager) {
      const sessionId = session.sessionId || session.id;
      const needs = this.approvalManager.needsApproval(toolName, session.userId, sessionId);
      if (needs) {
        const summary = this._summarizeInput(toolName, toolInput);
        this.approvalManager.setPending(sessionId, { toolName, input: toolInput, userId: session.userId });
        this.auditLogger?.logApproval({
          toolName,
          input: toolInput,
          userId: session.userId,
          sessionId,
          approved: false,
          reason: 'pending',
        });
        return {
          success: true,
          result: `[APPROVAL_REQUIRED] The tool "${toolName}" requires your approval to proceed.\n\nCommand: ${summary}\n\nReply /approve to allow or /reject to deny.`,
          error: null,
          awaitingApproval: true,
          durationMs: 0,
        };
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

      const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
      this._audit(toolName, toolInput, resultStr, true, session, durationMs);

      return {
        success: true,
        result: resultStr,
        error: null,
        durationMs,
      };
    } catch (err) {
      const durationMs = Date.now() - start;
      this.logger.error({ toolName, err: err.message, durationMs }, 'Tool execution failed');

      this._audit(toolName, toolInput, err.message, false, session, durationMs);

      return {
        success: false,
        result: null,
        error: err.message,
        durationMs,
      };
    }
  }

  _audit(toolName, input, output, success, session, durationMs) {
    if (!this.auditLogger) return;
    this.auditLogger.logToolExecution({
      toolName,
      input,
      output,
      success,
      userId: session.userId,
      sessionId: session.sessionId || session.id,
      durationMs,
    });
  }

  _summarizeInput(toolName, input) {
    if (input.command) return input.command;
    if (input.path) return input.path;
    return JSON.stringify(input).slice(0, 200);
  }
}
