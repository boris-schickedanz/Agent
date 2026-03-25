export class RunnerUnavailableError extends Error {
  constructor(message = 'Runner is unavailable') {
    super(message);
    this.name = 'RunnerUnavailableError';
  }
}

/**
 * Abstract base class for all runners.
 * The host calls execute() and receives an ExecutionResult.
 */
export class AgentRunner {
  async execute(request) {
    throw new Error('AgentRunner.execute() must be implemented');
  }

  async cancel(executionId) {
    return false;
  }

  async shutdown(timeoutMs = 30_000) {
    // Default: no-op
  }
}
