import { randomUUID } from 'crypto';

export const ExecutionOrigin = Object.freeze({
  USER_MESSAGE: 'user_message',
  SCHEDULED_TASK: 'scheduled_task',
  DELEGATED_AGENT: 'delegated_agent',
  MAINTENANCE_TASK: 'maintenance_task',
});

/**
 * Create a validated ExecutionRequest.
 */
export function createExecutionRequest({
  executionId,
  origin,
  sessionId,
  userId,
  channelId,
  userName = null,
  sessionMetadata = {},
  history = [],
  userContent,
  toolSchemas = [],
  allowedToolNames = null,
  skillInstructions = null,
  memorySnippets = [],
  maxIterations = 25,
  timeoutMs = null,
  createdAt,
}) {
  if (!origin) throw new Error('ExecutionRequest requires origin');
  if (!sessionId) throw new Error('ExecutionRequest requires sessionId');
  if (!userId) throw new Error('ExecutionRequest requires userId');
  if (!channelId) throw new Error('ExecutionRequest requires channelId');
  if (userContent == null || userContent === '') throw new Error('ExecutionRequest requires userContent');

  return {
    executionId: executionId || randomUUID(),
    origin,
    sessionId,
    userId,
    channelId,
    userName,
    sessionMetadata,
    history,
    userContent,
    toolSchemas,
    allowedToolNames,
    skillInstructions,
    memorySnippets,
    maxIterations,
    timeoutMs,
    createdAt: createdAt || Date.now(),
  };
}
