export function registerDelegationTools(registry, delegationManager) {
  // ── delegate_task ──
  registry.register({
    name: 'delegate_task',
    class: 'brokered',
    description: 'Spawn a sub-agent (Claude Code, Codex, or other) to handle a task autonomously.',
    timeout: 30_000,
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Natural language task description' },
        backend: {
          type: 'string',
          enum: ['claude-code', 'codex', 'custom'],
          description: 'Which coding tool to use. Default: claude-code',
        },
        work_dir: { type: 'string', description: 'Working directory (relative to workspace). Default: workspace root' },
        timeout_minutes: { type: 'integer', minimum: 1, maximum: 60, description: 'Max time in minutes. Default: 15' },
      },
      required: ['task'],
    },
    handler: async (input, context) => {
      const taskId = await delegationManager.delegate({
        backend: input.backend || 'claude-code',
        task: input.task,
        workDir: input.work_dir || '.',
        parentSessionId: context.sessionId,
        parentUserId: context.userId,
        timeout: (input.timeout_minutes || 15) * 60 * 1000,
      });

      return `Delegated task to ${input.backend || 'claude-code'} (Task ID: ${taskId})\nUse check_delegation to monitor progress.`;
    },
  });

  // ── check_delegation ──
  registry.register({
    name: 'check_delegation',
    class: 'brokered',
    description: 'Check status and output of a delegated task.',
    timeout: 5_000,
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID from delegate_task' },
      },
      required: ['task_id'],
    },
    handler: async (input) => {
      const status = await delegationManager.checkStatus(input.task_id);
      if (!status) return `Task ${input.task_id} not found.`;

      let result = `Task: ${status.task.slice(0, 100)}\n`;
      result += `Backend: ${status.backend}\n`;
      result += `Status: ${status.status}\n`;
      result += `Started: ${new Date(status.startedAt).toISOString()}\n`;

      if (status.status !== 'running') {
        const fullResult = await delegationManager.getResult(input.task_id);
        if (fullResult?.output) {
          result += `Duration: ${Math.round(fullResult.durationMs / 1000)}s\n`;
          result += `Exit code: ${fullResult.exitCode}\n`;
          result += `\nOutput:\n${fullResult.output}`;
        }
      }

      return result;
    },
  });

  // ── cancel_delegation ──
  registry.register({
    name: 'cancel_delegation',
    class: 'brokered',
    description: 'Cancel a running delegated task.',
    timeout: 10_000,
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID to cancel' },
      },
      required: ['task_id'],
    },
    handler: async (input) => {
      const cancelled = await delegationManager.cancel(input.task_id);
      return cancelled
        ? `Task ${input.task_id} cancelled.`
        : `Task ${input.task_id} not found or already completed.`;
    },
  });
}
