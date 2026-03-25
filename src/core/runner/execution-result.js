export const ExecutionStatus = Object.freeze({
  COMPLETED: 'completed',
  MAX_ITERATIONS: 'max_iterations',
  ERROR: 'error',
  CANCELLED: 'cancelled',
  TIMEOUT: 'timeout',
});

/**
 * Create an ExecutionResult.
 */
export function createExecutionResult({
  executionId,
  status,
  content = '',
  newMessages = [],
  toolsUsed = [],
  tokenUsage = { inputTokens: 0, outputTokens: 0 },
  iterationCount = 0,
  durationMs = 0,
  error = null,
}) {
  if (!executionId) throw new Error('ExecutionResult requires executionId');
  if (!status) throw new Error('ExecutionResult requires status');

  const validStatuses = Object.values(ExecutionStatus);
  if (!validStatuses.includes(status)) {
    throw new Error(`Invalid ExecutionStatus: ${status}. Must be one of: ${validStatuses.join(', ')}`);
  }

  return {
    executionId,
    status,
    content,
    newMessages,
    toolsUsed,
    tokenUsage,
    iterationCount,
    durationMs,
    error,
  };
}
