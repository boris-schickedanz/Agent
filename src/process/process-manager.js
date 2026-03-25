import { spawn, execSync } from 'child_process';
import { randomUUID } from 'crypto';

const DEFAULT_MAX_OUTPUT = 50 * 1024; // 50KB
const SIGTERM_GRACE_MS = 5000;

export class ProcessManager {
  constructor({ sandbox, logger, maxProcesses = 10, defaultTimeoutMs = 60_000, containerMode = false, containerRuntime = 'auto', containerImage = 'agentcore-sandbox' }) {
    this.sandbox = sandbox;
    this.logger = logger;
    this.maxProcesses = maxProcesses;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.containerMode = containerMode;
    this.containerRuntime = containerRuntime === 'auto' ? this._detectRuntime() : containerRuntime;
    this.containerImage = containerImage;
    this._processes = new Map();
    this._containerStarted = false;
  }

  async run(command, { cwd, env, timeoutMs, maxOutput } = {}) {
    const resolvedCwd = cwd ? this.sandbox.resolve(cwd) : this.sandbox.workspaceDir;
    const timeout = timeoutMs || this.defaultTimeoutMs;
    const outputLimit = maxOutput || DEFAULT_MAX_OUTPUT;

    if (this.containerMode) {
      return this._runInContainer(command, { cwd: resolvedCwd, env, timeoutMs: timeout, maxOutput: outputLimit });
    }
    return this._runDirect(command, { cwd: resolvedCwd, env, timeoutMs: timeout, maxOutput: outputLimit });
  }

  async startBackground(command, { cwd, env, label } = {}) {
    if (this._countActive() >= this.maxProcesses) {
      throw new Error(`Maximum background processes reached (${this.maxProcesses})`);
    }

    const resolvedCwd = cwd ? this.sandbox.resolve(cwd) : this.sandbox.workspaceDir;
    const id = randomUUID();
    const processLabel = label || command.slice(0, 50);

    const proc = spawn(command, [], {
      shell: true,
      cwd: resolvedCwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const handle = {
      id,
      command,
      label: processLabel,
      cwd: resolvedCwd,
      startedAt: Date.now(),
      status: 'running',
      exitCode: null,
      process: proc,
      stdout: new RingBuffer(DEFAULT_MAX_OUTPUT),
      stderr: new RingBuffer(DEFAULT_MAX_OUTPUT),
    };

    proc.stdout.on('data', (data) => handle.stdout.write(data));
    proc.stderr.on('data', (data) => handle.stderr.write(data));

    proc.on('exit', (code) => {
      handle.status = 'exited';
      handle.exitCode = code;
    });

    proc.on('error', (err) => {
      handle.status = 'exited';
      handle.exitCode = -1;
      this.logger?.warn({ id, err: err.message }, 'Background process error');
    });

    this._processes.set(id, handle);
    return id;
  }

  getStatus(processId) {
    const handle = this._processes.get(processId);
    if (!handle) return null;
    return {
      id: handle.id,
      command: handle.command,
      label: handle.label,
      cwd: handle.cwd,
      startedAt: handle.startedAt,
      status: handle.status,
      exitCode: handle.exitCode,
    };
  }

  getOutput(processId, { tail = 50 } = {}) {
    const handle = this._processes.get(processId);
    if (!handle) return null;

    const stdout = handle.stdout.toString();
    const stderr = handle.stderr.toString();
    const combined = stdout + (stderr ? `\nSTDERR:\n${stderr}` : '');

    if (tail) {
      const lines = combined.split('\n');
      return lines.slice(-tail).join('\n');
    }
    return combined;
  }

  kill(processId, signal = 'SIGTERM') {
    const handle = this._processes.get(processId);
    if (!handle || handle.status !== 'running') return false;

    try {
      handle.process.kill(signal);
      // Escalate to SIGKILL after grace period
      setTimeout(() => {
        if (handle.status === 'running') {
          try { handle.process.kill('SIGKILL'); } catch { /* already dead */ }
        }
      }, SIGTERM_GRACE_MS);
      return true;
    } catch {
      return false;
    }
  }

  listActive() {
    const active = [];
    for (const handle of this._processes.values()) {
      active.push({
        id: handle.id,
        command: handle.command,
        label: handle.label,
        cwd: handle.cwd,
        startedAt: handle.startedAt,
        status: handle.status,
        exitCode: handle.exitCode,
      });
    }
    return active;
  }

  async shutdownAll() {
    const promises = [];
    for (const [id, handle] of this._processes) {
      if (handle.status === 'running') {
        this.kill(id);
        promises.push(new Promise(resolve => {
          const timeout = setTimeout(() => {
            try { handle.process.kill('SIGKILL'); } catch { /* */ }
            resolve();
          }, SIGTERM_GRACE_MS);

          handle.process.on('exit', () => {
            clearTimeout(timeout);
            resolve();
          });
        }));
      }
    }
    await Promise.all(promises);

    // Stop sandbox container if running
    if (this.containerMode && this._containerStarted) {
      try {
        execSync(`${this.containerRuntime} stop agentcore-sandbox`, { timeout: 10_000 });
      } catch { /* ignore */ }
    }
  }

  // ── Private ──

  _runDirect(command, { cwd, env, timeoutMs, maxOutput }) {
    return new Promise((resolve) => {
      const proc = spawn(command, [], {
        shell: true,
        cwd,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const stdoutBuf = new RingBuffer(maxOutput);
      const stderrBuf = new RingBuffer(maxOutput);
      let timedOut = false;

      proc.stdout.on('data', (data) => stdoutBuf.write(data));
      proc.stderr.on('data', (data) => stderrBuf.write(data));

      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
        setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch { /* */ }
        }, SIGTERM_GRACE_MS);
      }, timeoutMs);

      proc.on('exit', (code) => {
        clearTimeout(timer);
        const stdout = stdoutBuf.toString();
        const stderr = stderrBuf.toString();
        resolve({
          exitCode: code ?? 1,
          stdout,
          stderr,
          durationMs: Date.now() - (proc.startTime || Date.now()),
          timedOut,
          truncated: stdoutBuf.truncated || stderrBuf.truncated,
        });
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          exitCode: -1,
          stdout: '',
          stderr: err.message,
          durationMs: 0,
          timedOut: false,
          truncated: false,
        });
      });

      proc.startTime = Date.now();
    });
  }

  async _runInContainer(command, { cwd, env, timeoutMs, maxOutput }) {
    await this._ensureContainer();

    // Map workspace path to container path
    const workspaceRelative = cwd.startsWith(this.sandbox.workspaceDir)
      ? cwd.slice(this.sandbox.workspaceDir.length).replace(/\\/g, '/') || ''
      : '';
    const containerCwd = `/workspace${workspaceRelative}`;

    const containerCmd = `${this.containerRuntime} exec agentcore-sandbox sh -c "cd ${containerCwd} && ${command.replace(/"/g, '\\"')}"`;
    return this._runDirect(containerCmd, { cwd: process.cwd(), env, timeoutMs, maxOutput });
  }

  async _ensureContainer() {
    if (this._containerStarted) return;

    try {
      // Check if container is already running
      execSync(`${this.containerRuntime} inspect agentcore-sandbox`, { timeout: 5000, stdio: 'ignore' });
      this._containerStarted = true;
      return;
    } catch { /* not running */ }

    try {
      execSync(
        `${this.containerRuntime} run -d --name agentcore-sandbox -v "${this.sandbox.workspaceDir}:/workspace" ${this.containerImage} sleep infinity`,
        { timeout: 30_000 }
      );
      this._containerStarted = true;
    } catch (err) {
      throw new Error(`Failed to start sandbox container: ${err.message}`);
    }
  }

  _detectRuntime() {
    for (const rt of ['container', 'podman', 'docker']) {
      try {
        execSync(`${rt} --version`, { timeout: 5000, stdio: 'ignore' });
        return rt;
      } catch { /* try next */ }
    }
    return 'docker'; // fallback
  }

  _countActive() {
    let count = 0;
    for (const h of this._processes.values()) {
      if (h.status === 'running') count++;
    }
    return count;
  }
}

class RingBuffer {
  constructor(maxSize) {
    this.maxSize = maxSize;
    this._chunks = [];
    this._totalSize = 0;
    this.truncated = false;
  }

  write(data) {
    const str = typeof data === 'string' ? data : data.toString();
    this._chunks.push(str);
    this._totalSize += str.length;

    while (this._totalSize > this.maxSize && this._chunks.length > 1) {
      const removed = this._chunks.shift();
      this._totalSize -= removed.length;
      this.truncated = true;
    }
  }

  toString() {
    return this._chunks.join('');
  }
}
