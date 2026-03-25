import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

export class HeartbeatScheduler {
  constructor(agentLoop, sessionManager, db, config, logger) {
    this.agentLoop = agentLoop;
    this.sessionManager = sessionManager;
    this.db = db;
    this.config = config;
    this.logger = logger;
    this._interval = null;
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
    const tasks = this._parseTasks();
    if (tasks.length === 0) return;

    const combinedPrompt = tasks
      .map(t => `## ${t.name}\n${t.instructions}`)
      .join('\n\n');

    // Create a synthetic heartbeat message
    const heartbeatMessage = {
      id: `heartbeat_${Date.now()}`,
      sessionId: 'heartbeat:system',
      channelId: 'heartbeat',
      userId: 'system',
      userName: 'Heartbeat',
      content: `[Heartbeat] Please process the following periodic tasks:\n\n${combinedPrompt}`,
      attachments: [],
      replyTo: null,
      timestamp: Date.now(),
      raw: {},
    };

    this.logger.info({ taskCount: tasks.length }, 'Heartbeat tick');

    try {
      const result = await this.agentLoop.processMessage(heartbeatMessage);
      if (result?.content) {
        this.logger.info({ content: result.content.substring(0, 500) }, 'Heartbeat completed');
      }
    } catch (err) {
      this.logger.error({ err: err.message }, 'Heartbeat processing failed');
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
