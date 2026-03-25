import { AgentRunner, RunnerUnavailableError } from './agent-runner.js';
import { createExecutionResult, ExecutionStatus } from './execution-result.js';

/**
 * LocalRunner wraps the existing AgentLoop in-process.
 * Translates between ExecutionRequest/ExecutionResult and the AgentLoop's internal format.
 */
export class LocalRunner extends AgentRunner {
  constructor({ agentLoop, logger }) {
    super();
    this.agentLoop = agentLoop;
    this.logger = logger;
    this._active = new Map();       // executionId -> { cancelled: boolean }
    this._shuttingDown = false;
  }

  async execute(request) {
    if (this._shuttingDown) {
      throw new RunnerUnavailableError('Runner is shutting down');
    }
    if (this._active.has(request.executionId)) {
      throw new RunnerUnavailableError(`Duplicate executionId: ${request.executionId}`);
    }

    const cancellationSignal = { cancelled: false };
    this._active.set(request.executionId, cancellationSignal);
    const startTime = Date.now();

    try {
      const loopParams = {
        history: request.history,
        userContent: request.userContent,
        toolSchemas: request.toolSchemas,
        allowedToolNames: request.allowedToolNames,
        memorySnippets: request.memorySnippets,
        skillInstructions: request.skillInstructions,
        sessionMetadata: request.sessionMetadata,
        maxIterations: request.maxIterations,
        cancellationSignal,
      };

      let loopResult;
      if (request.timeoutMs) {
        const { timer, promise: timeoutPromise } = this._timeout(request.timeoutMs, request.executionId);
        try {
          loopResult = await Promise.race([
            this.agentLoop.processMessage(loopParams),
            timeoutPromise,
          ]);
        } finally {
          clearTimeout(timer);
        }

        if (loopResult && loopResult._timeout) {
          return createExecutionResult({
            executionId: request.executionId,
            status: ExecutionStatus.TIMEOUT,
            content: '',
            durationMs: Date.now() - startTime,
            error: { code: 'timeout', message: `Execution exceeded ${request.timeoutMs}ms`, retriable: true },
          });
        }
      } else {
        loopResult = await this.agentLoop.processMessage(loopParams);
      }

      return createExecutionResult({
        executionId: request.executionId,
        status: loopResult.status || ExecutionStatus.COMPLETED,
        content: loopResult.content,
        newMessages: loopResult.newMessages,
        toolsUsed: loopResult.toolsUsed || [],
        tokenUsage: loopResult.tokenUsage || { inputTokens: 0, outputTokens: 0 },
        iterationCount: loopResult.iterationCount || 0,
        durationMs: Date.now() - startTime,
        error: loopResult.error || null,
      });
    } catch (err) {
      this.logger.error({ err: err.message, executionId: request.executionId }, 'Runner execution failed');
      return createExecutionResult({
        executionId: request.executionId,
        status: ExecutionStatus.ERROR,
        content: '',
        durationMs: Date.now() - startTime,
        error: { code: 'runtime_error', message: err.message, retriable: false },
      });
    } finally {
      this._active.delete(request.executionId);
    }
  }

  async cancel(executionId) {
    const signal = this._active.get(executionId);
    if (!signal) return false;
    signal.cancelled = true;
    return true;
  }

  async shutdown(timeoutMs = 30_000) {
    this._shuttingDown = true;

    // Wait for in-flight executions to complete
    const deadline = Date.now() + timeoutMs;
    while (this._active.size > 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100));
    }

    // Force-cancel any remaining
    for (const [id, signal] of this._active) {
      signal.cancelled = true;
    }
  }

  _timeout(ms, executionId) {
    let timer;
    const promise = new Promise(resolve => {
      timer = setTimeout(() => {
        const signal = this._active.get(executionId);
        if (signal) signal.cancelled = true;
        resolve({ _timeout: true });
      }, ms);
    });
    return { timer, promise };
  }
}
