import { execSync } from 'child_process';

function commandExists(cmd) {
  try {
    execSync(`which ${cmd} 2>/dev/null || where ${cmd} 2>NUL`, { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export const claudeCodeBackend = {
  name: 'claude-code',

  available() {
    return commandExists('claude');
  },

  buildCommand(task, workDir) {
    const escaped = task.replace(/"/g, '\\"').replace(/\$/g, '\\$');
    return `claude --dangerously-skip-permissions -p "${escaped}"`;
  },

  parseOutput(stdout, stderr) {
    // Claude Code outputs directly to stdout
    return (stdout || '').trim() || (stderr || '').trim() || '(no output)';
  },
};

export const codexBackend = {
  name: 'codex',

  available() {
    return commandExists('codex');
  },

  buildCommand(task, workDir) {
    const escaped = task.replace(/"/g, '\\"').replace(/\$/g, '\\$');
    return `codex --approval-mode full-auto "${escaped}"`;
  },

  parseOutput(stdout, stderr) {
    return (stdout || '').trim() || (stderr || '').trim() || '(no output)';
  },
};

export const customBackend = {
  name: 'custom',

  available() {
    return true; // Always available — user provides the command
  },

  buildCommand(task, workDir) {
    // For custom backend, the task IS the command
    return task;
  },

  parseOutput(stdout, stderr) {
    return (stdout || '').trim() || (stderr || '').trim() || '(no output)';
  },
};

export function getAllBackends() {
  return [claudeCodeBackend, codexBackend, customBackend];
}
