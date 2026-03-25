export function registerShellTools(registry, processManager, sandbox) {
  // ── run_command ──
  registry.register({
    name: 'run_command',
    class: 'brokered',
    description: 'Execute a shell command and return output. Use for running tests, builds, git commands, etc.',
    timeout: 120_000,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        cwd: { type: 'string', description: 'Working directory (relative to workspace). Default: workspace root' },
        timeout_seconds: { type: 'integer', minimum: 1, maximum: 300, description: 'Command timeout in seconds. Default: 60' },
      },
      required: ['command'],
    },
    handler: async (input) => {
      const cwd = input.cwd || '.';
      const timeoutMs = (input.timeout_seconds || 60) * 1000;

      const result = await processManager.run(input.command, { cwd, timeoutMs });

      let output = '';
      if (result.truncated) {
        output += '[Output truncated to last 50KB]\n';
      }

      output += `Exit code: ${result.exitCode}\n`;

      if (result.stdout) {
        output += `\nSTDOUT:\n${result.stdout}`;
      }

      if (result.stderr) {
        output += `\nSTDERR:\n${result.stderr}`;
      }

      if (result.timedOut) {
        output += `\n[Command timed out after ${Math.round(timeoutMs / 1000)}s]`;
      }

      return output;
    },
  });

  // ── run_command_background ──
  registry.register({
    name: 'run_command_background',
    class: 'brokered',
    description: 'Start a long-running process in the background (e.g., dev servers, watchers).',
    timeout: 10_000,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run in background' },
        cwd: { type: 'string', description: 'Working directory. Default: workspace root' },
        label: { type: 'string', description: "Friendly name for this process (e.g., 'dev-server')" },
      },
      required: ['command'],
    },
    handler: async (input) => {
      const id = await processManager.startBackground(input.command, {
        cwd: input.cwd || '.',
        label: input.label,
      });
      const label = input.label || input.command.slice(0, 50);
      return `Started background process '${label}' (ID: ${id})`;
    },
  });

  // ── check_process ──
  registry.register({
    name: 'check_process',
    class: 'brokered',
    description: 'Check status and recent output of a background process.',
    timeout: 5_000,
    inputSchema: {
      type: 'object',
      properties: {
        process_id: { type: 'string', description: 'Process ID returned by run_command_background' },
        tail: { type: 'integer', minimum: 1, maximum: 200, description: 'Number of output lines to show. Default: 50' },
      },
      required: ['process_id'],
    },
    handler: async (input) => {
      const status = processManager.getStatus(input.process_id);
      if (!status) return `Process ${input.process_id} not found.`;

      const output = processManager.getOutput(input.process_id, { tail: input.tail || 50 });
      const uptime = Math.round((Date.now() - status.startedAt) / 1000);

      let result = `Process: ${status.label}\n`;
      result += `Status: ${status.status}\n`;
      if (status.exitCode !== null) result += `Exit code: ${status.exitCode}\n`;
      result += `Uptime: ${uptime}s\n`;
      if (output) result += `\nRecent output:\n${output}`;
      return result;
    },
  });

  // ── kill_process ──
  registry.register({
    name: 'kill_process',
    class: 'brokered',
    description: 'Terminate a background process.',
    timeout: 10_000,
    inputSchema: {
      type: 'object',
      properties: {
        process_id: { type: 'string', description: 'Process ID to terminate' },
      },
      required: ['process_id'],
    },
    handler: async (input) => {
      const status = processManager.getStatus(input.process_id);
      if (!status) return `Process ${input.process_id} not found.`;

      const killed = processManager.kill(input.process_id);
      return killed
        ? `Sent SIGTERM to process '${status.label}' (${input.process_id})`
        : `Process '${status.label}' is not running (status: ${status.status})`;
    },
  });

  // ── list_processes ──
  registry.register({
    name: 'list_processes',
    class: 'brokered',
    description: 'List all active background processes.',
    timeout: 5_000,
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const processes = processManager.listActive();
      if (processes.length === 0) return 'No active background processes.';

      const lines = processes.map(p => {
        const uptime = Math.round((Date.now() - p.startedAt) / 1000);
        return `${p.id}  ${p.status.padEnd(8)}  ${uptime}s  ${p.label}`;
      });

      return `ID${' '.repeat(34)}Status    Uptime  Label\n${lines.join('\n')}`;
    },
  });
}
