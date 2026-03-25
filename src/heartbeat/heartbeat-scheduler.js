import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { createExecutionRequest, ExecutionOrigin } from '../core/runner/execution-request.js';

export class HeartbeatScheduler {
  constructor(runner, toolRegistry, sessionManager, db, config, logger) {
    this.runner = runner;
    this.toolRegistry = toolRegistry;
    this.sessionManager = sessionManager;
    this.db = db;
    this.config = config;
    this.logger = logger;
    this._interval = null;
    this._inFlight = false;
    this._heartbeatPath = resolve('HEARTBEAT.md');
  }

  start() {
    if (!existsSync(this._heartbeatPath)) {
      this.logger.info('No HEARTBEAT.md found, heartbeat disabled');
      return;
    }

    if (this.config.heartbeatIntervalMs <= 0) return;

    // Ensure the system user has admin role so heartbeat can use all tools
    this.db.prepare(
      'INSERT INTO users (id, channel_id, role) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET role = ?'
    ).run('system', 'heartbeat', 'admin', 'admin');

    this._interval = setInterval(() => {
      this.tick().catch(err => {
        this.logger.error({ err: err.message }, 'Heartbeat tick failed');
      });
    }, this.config.heartbeatIntervalMs);

    this.logger.info(
      { intervalMinutes: this.config.heartbeatIntervalMs / 60_000 },
      'Heartbeat scheduler started'
    );
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
  }

  async tick() {
    if (this._inFlight) {
      this.logger.warn('Heartbeat tick skipped: previous execution still running');
      return;
    }

    const tasks = this._parseTasks();
    if (tasks.length === 0) return;

    this._inFlight = true;

    const combinedPrompt = tasks
      .map(t => `## ${t.name}\n${t.instructions}`)
      .join('\n\n');

    const sessionId = 'heartbeat:system';
    const history = this.sessionManager.loadHistory(sessionId);
    const toolSchemas = this.toolRegistry.getSchemas(null); // admin = all tools

    const executionRequest = createExecutionRequest({
      origin: ExecutionOrigin.SCHEDULED_TASK,
      sessionId,
      userId: 'system',
      channelId: 'heartbeat',
      userName: 'Heartbeat',
      sessionMetadata: { sessionId, userId: 'system', channelId: 'heartbeat', userName: 'Heartbeat' },
      history,
      userContent: `[Heartbeat] Please process the following periodic tasks:\n\n${combinedPrompt}`,
      toolSchemas,
      maxIterations: this.config.maxToolIterations,
      timeoutMs: this.config.heartbeatIntervalMs,
    });

    this.logger.info({ taskCount: tasks.length }, 'Heartbeat tick');

    try {
      const result = await this.runner.execute(executionRequest);
      if (result?.content) {
        this.logger.info({ content: result.content.substring(0, 500) }, 'Heartbeat completed');
      }
    } catch (err) {
      this.logger.error({ err: err.message }, 'Heartbeat processing failed');
    } finally {
      this._inFlight = false;
    }
  }

  _parseTasks() {
    if (!existsSync(this._heartbeatPath)) return [];

    const content = readFileSync(this._heartbeatPath, 'utf-8');
    const tasks = [];
    const sections = content.split(/^##\s+/m).filter(Boolean);

    for (const section of sections) {
      const lines = section.trim().split('\n');
      const name = lines[0].trim();
      const instructions = lines.slice(1).join('\n').trim();
      if (name && instructions) {
        tasks.push({ name, instructions });
      }
    }

    return tasks;
  }
}
