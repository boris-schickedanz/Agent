import { readFileSync, existsSync, readdirSync } from 'fs';
import { resolve, join } from 'path';
import matter from 'gray-matter';
import { createExecutionRequest, ExecutionOrigin } from '../core/runner/execution-request.js';

export class TaskScheduler {
  constructor({ runner, toolRegistry, sessionManager, db, logger, config }) {
    this.runner = runner;
    this.toolRegistry = toolRegistry;
    this.sessionManager = sessionManager;
    this.db = db;
    this.logger = logger;
    this.config = config;
    this._tasks = new Map();
    this._timers = new Map();
    this._inFlight = new Set();
  }

  loadTasks() {
    // Load from tasks/ directory
    const tasksDir = resolve('tasks');
    if (existsSync(tasksDir)) {
      const files = readdirSync(tasksDir).filter(f => f.endsWith('.md'));
      for (const file of files) {
        try {
          const content = readFileSync(join(tasksDir, file), 'utf-8');
          const { data, content: instructions } = matter(content);
          if (data.name && data.enabled !== false) {
            this._tasks.set(data.name, {
              name: data.name,
              description: data.description || '',
              schedule: data.schedule || '30m',
              timeout: data.timeout || 60_000,
              tools: data.tools || null,
              instructions: instructions.trim(),
              source: `tasks/${file}`,
            });
          }
        } catch (err) {
          this.logger.warn({ file, err: err.message }, 'Failed to load task');
        }
      }
    }

    // Backward compat: load from HEARTBEAT.md if tasks/ is empty
    if (this._tasks.size === 0) {
      const heartbeatPath = resolve('HEARTBEAT.md');
      if (existsSync(heartbeatPath)) {
        const content = readFileSync(heartbeatPath, 'utf-8');
        const sections = content.split(/^##\s+/m).filter(Boolean);
        for (const section of sections) {
          const lines = section.trim().split('\n');
          const name = lines[0].trim();
          const instructions = lines.slice(1).join('\n').trim();
          if (name && instructions) {
            this._tasks.set(name, {
              name,
              description: '',
              schedule: `${this.config.heartbeatIntervalMs}ms`,
              timeout: this.config.heartbeatIntervalMs,
              tools: null,
              instructions,
              source: 'HEARTBEAT.md',
            });
          }
        }
      }
    }

    this.logger.info({ taskCount: this._tasks.size }, 'Tasks loaded');
  }

  start() {
    // Ensure system user has admin role
    try {
      this.db.prepare(
        'INSERT INTO users (id, channel_id, role) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET role = ?'
      ).run('system', 'scheduler', 'admin', 'admin');
    } catch { /* ignore */ }

    for (const [name, task] of this._tasks) {
      const intervalMs = this._parseSchedule(task.schedule);
      if (intervalMs <= 0) {
        this.logger.warn({ name, schedule: task.schedule }, 'Invalid schedule, skipping task');
        continue;
      }

      const timer = setInterval(() => {
        this._executeSingle(task).catch(err => {
          this.logger.error({ task: name, err: err.message }, 'Task execution failed');
        });
      }, intervalMs);

      this._timers.set(name, timer);
      this.logger.info({ name, intervalMs }, 'Task scheduled');
    }
  }

  stop() {
    for (const [name, timer] of this._timers) {
      clearInterval(timer);
    }
    this._timers.clear();
  }

  getTaskStatus(name) {
    const task = this._tasks.get(name);
    if (!task) return null;
    return {
      name: task.name,
      description: task.description,
      schedule: task.schedule,
      source: task.source,
      running: this._inFlight.has(name),
    };
  }

  listTasks() {
    return Array.from(this._tasks.values()).map(t => ({
      name: t.name,
      description: t.description,
      schedule: t.schedule,
      source: t.source,
      running: this._inFlight.has(t.name),
    }));
  }

  async _executeSingle(task) {
    if (this._inFlight.has(task.name)) {
      this.logger.warn({ task: task.name }, 'Task still running, skipping');
      return;
    }

    this._inFlight.add(task.name);
    const sessionId = `task:${task.name}`;

    try {
      // Filter tools if task specifies them
      let toolSchemas;
      if (task.tools) {
        const allowedSet = new Set(task.tools);
        toolSchemas = this.toolRegistry.getSchemas(allowedSet);
      } else {
        toolSchemas = this.toolRegistry.getSchemas(null); // admin = all tools
      }

      const history = this.sessionManager
        ? this.sessionManager.loadHistory(sessionId)
        : [];

      const request = createExecutionRequest({
        origin: ExecutionOrigin.SCHEDULED_TASK,
        sessionId,
        userId: 'system',
        channelId: 'scheduler',
        userName: 'Scheduler',
        sessionMetadata: { sessionId, userId: 'system', channelId: 'scheduler', userName: 'Scheduler' },
        history,
        userContent: `[Scheduled Task: ${task.name}]\n\n${task.instructions}`,
        toolSchemas,
        maxIterations: this.config.maxToolIterations,
        timeoutMs: task.timeout,
      });

      const result = await this.runner.execute(request);
      if (result?.content) {
        this.logger.info({ task: task.name, content: result.content.substring(0, 500) }, 'Task completed');
      }
    } catch (err) {
      this.logger.error({ task: task.name, err: err.message }, 'Task execution error');
    } finally {
      this._inFlight.delete(task.name);
    }
  }

  _parseSchedule(schedule) {
    if (!schedule) return 0;

    // Handle interval format: "30m", "1h", "60s", "60000ms"
    const match = schedule.match(/^(\d+)(ms|s|m|h)$/);
    if (match) {
      const value = parseInt(match[1], 10);
      const unit = match[2];
      switch (unit) {
        case 'ms': return value;
        case 's': return value * 1000;
        case 'm': return value * 60 * 1000;
        case 'h': return value * 60 * 60 * 1000;
      }
    }

    // Handle cron expressions: convert to approximate interval
    // For simplicity, parse common patterns
    if (schedule.startsWith('*/')) {
      const parts = schedule.split(' ');
      if (parts.length >= 5) {
        const minuteMatch = parts[0].match(/^\*\/(\d+)$/);
        if (minuteMatch) return parseInt(minuteMatch[1], 10) * 60 * 1000;
      }
    }

    // Fallback: try parsing as milliseconds
    const ms = parseInt(schedule, 10);
    return isNaN(ms) ? 0 : ms;
  }
}
