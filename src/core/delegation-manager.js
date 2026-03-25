import { randomUUID } from 'crypto';

export class DelegationManager {
  constructor({ processManager, runner, db, logger, config }) {
    this.processManager = processManager;
    this.runner = runner;
    this.db = db;
    this.logger = logger;
    this.config = config;
    this._delegations = new Map();
    this._backends = new Map();
  }

  registerBackend(backend) {
    this._backends.set(backend.name, backend);
  }

  async delegate(task) {
    // Enforce global limit
    const active = this._getActiveCount();
    if (active >= this.config.maxDelegations) {
      throw new Error(`Maximum concurrent delegations reached (${this.config.maxDelegations})`);
    }

    // Enforce per-session limit
    const sessionActive = this._getSessionActiveCount(task.parentSessionId);
    if (sessionActive >= this.config.maxDelegationsPerSession) {
      throw new Error(`Maximum delegations per session reached (${this.config.maxDelegationsPerSession})`);
    }

    const backend = this._backends.get(task.backend || 'claude-code');
    if (!backend) {
      throw new Error(`Unknown delegation backend: ${task.backend}`);
    }

    if (!backend.available()) {
      throw new Error(`Backend "${backend.name}" is not available on this system`);
    }

    const taskId = randomUUID();
    const command = backend.buildCommand(task.task, task.workDir);
    const timeoutMs = (task.timeout || 15 * 60 * 1000);

    let processId;
    try {
      processId = await this.processManager.startBackground(command, {
        cwd: task.workDir || '.',
        label: `delegation:${backend.name}:${taskId.slice(0, 8)}`,
      });
    } catch (err) {
      throw new Error(`Failed to start delegation: ${err.message}`);
    }

    const delegation = {
      taskId,
      backend: backend.name,
      task: task.task,
      status: 'running',
      startedAt: Date.now(),
      completedAt: null,
      processId,
      parentSessionId: task.parentSessionId,
      parentUserId: task.parentUserId,
      timeoutMs,
    };

    this._delegations.set(taskId, delegation);

    // Set up timeout
    setTimeout(() => {
      const d = this._delegations.get(taskId);
      if (d && d.status === 'running') {
        this.processManager.kill(processId);
        d.status = 'timeout';
        d.completedAt = Date.now();
      }
    }, timeoutMs);

    // Watch for process completion
    this._watchProcess(taskId, processId, backend);

    return taskId;
  }

  async checkStatus(taskId) {
    const delegation = this._delegations.get(taskId);
    if (!delegation) return null;

    // Refresh status from process manager
    if (delegation.status === 'running') {
      const procStatus = this.processManager.getStatus(delegation.processId);
      if (procStatus && procStatus.status === 'exited') {
        delegation.status = procStatus.exitCode === 0 ? 'completed' : 'failed';
        delegation.completedAt = Date.now();
      }
    }

    return {
      taskId: delegation.taskId,
      backend: delegation.backend,
      task: delegation.task,
      status: delegation.status,
      startedAt: delegation.startedAt,
      completedAt: delegation.completedAt,
      processId: delegation.processId,
    };
  }

  async getResult(taskId) {
    const delegation = this._delegations.get(taskId);
    if (!delegation) return null;

    const output = this.processManager.getOutput(delegation.processId, { tail: 100 }) || '';
    const procStatus = this.processManager.getStatus(delegation.processId);

    const backend = this._backends.get(delegation.backend);
    const parsedOutput = backend ? backend.parseOutput(output, '') : output;

    return {
      taskId: delegation.taskId,
      status: delegation.status,
      output: parsedOutput,
      exitCode: procStatus?.exitCode ?? null,
      durationMs: (delegation.completedAt || Date.now()) - delegation.startedAt,
      filesModified: [],
    };
  }

  async cancel(taskId) {
    const delegation = this._delegations.get(taskId);
    if (!delegation || delegation.status !== 'running') return false;

    this.processManager.kill(delegation.processId);
    delegation.status = 'cancelled';
    delegation.completedAt = Date.now();
    return true;
  }

  listActive() {
    return Array.from(this._delegations.values())
      .filter(d => d.status === 'running')
      .map(d => ({
        taskId: d.taskId,
        backend: d.backend,
        task: d.task,
        status: d.status,
        startedAt: d.startedAt,
        completedAt: d.completedAt,
        processId: d.processId,
      }));
  }

  _watchProcess(taskId, processId, backend) {
    const check = setInterval(() => {
      const delegation = this._delegations.get(taskId);
      if (!delegation || delegation.status !== 'running') {
        clearInterval(check);
        return;
      }

      const procStatus = this.processManager.getStatus(processId);
      if (procStatus && procStatus.status === 'exited') {
        delegation.status = procStatus.exitCode === 0 ? 'completed' : 'failed';
        delegation.completedAt = Date.now();
        clearInterval(check);
      }
    }, 2000);
  }

  _getActiveCount() {
    let count = 0;
    for (const d of this._delegations.values()) {
      if (d.status === 'running') count++;
    }
    return count;
  }

  _getSessionActiveCount(sessionId) {
    let count = 0;
    for (const d of this._delegations.values()) {
      if (d.status === 'running' && d.parentSessionId === sessionId) count++;
    }
    return count;
  }
}
