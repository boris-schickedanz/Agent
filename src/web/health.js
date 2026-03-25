import { createServer } from 'http';
import { readFileSync } from 'fs';
import { resolve } from 'path';

export class HealthServer {
  constructor({ port, bind, messageQueue, adapterRegistry, db, logger, config }) {
    this.port = port;
    this.bind = bind || '127.0.0.1';
    this.messageQueue = messageQueue || null;
    this.adapterRegistry = adapterRegistry || null;
    this.db = db;
    this.logger = logger;
    this.config = config;
    this.server = null;
    this._startTime = Date.now();
  }

  async start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this._handleRequest(req, res));

      this.server.on('error', (err) => {
        this.logger.error({ err: err.message }, 'Health server error');
        reject(err);
      });

      this.server.listen(this.port, this.bind, () => {
        this.logger.info({ port: this.port, bind: this.bind }, 'Health server started');
        resolve();
      });
    });
  }

  async stop() {
    if (!this.server) return;
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  _handleRequest(req, res) {
    // CORS headers for dashboard
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && req.url === '/health') {
      return this._handleHealth(req, res);
    }

    if (req.method === 'GET' && req.url === '/status') {
      return this._handleStatus(req, res);
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  _handleHealth(req, res) {
    const health = this._getHealthData();
    const statusCode = health.status === 'unhealthy' ? 503 : 200;

    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(health));
  }

  _handleStatus(req, res) {
    if (!this._requireAuth(req, res)) return;

    const health = this._getHealthData();
    let version = '0.1.0';
    try {
      const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf-8'));
      version = pkg.version;
    } catch { /* ignore */ }

    const status = {
      health,
      config: {
        agentName: this.config.agentName,
        llmProvider: this.config.llmProvider,
        model: this.config.model,
        workspaceDir: this.config.workspaceDir,
        maxToolIterations: this.config.maxToolIterations,
      },
      tools: [],
      skills: [],
      recentSessions: [],
    };

    try {
      const sessions = this.db.prepare(
        'SELECT id, user_id, updated_at FROM sessions ORDER BY updated_at DESC LIMIT 10'
      ).all();
      status.recentSessions = sessions.map(s => ({
        id: s.id,
        userId: s.user_id,
        lastActivity: new Date(s.updated_at * 1000).toISOString(),
      }));
    } catch { /* ignore */ }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
  }

  _getHealthData() {
    const uptimeMs = Date.now() - this._startTime;
    let dbOk = false;
    try {
      this.db.prepare('SELECT 1').get();
      dbOk = true;
    } catch { /* db failed */ }

    const adapters = this.adapterRegistry
      ? this.adapterRegistry.getAll().map(a => a.channelId)
      : [];

    let status = 'healthy';
    if (!dbOk) status = 'unhealthy';

    let version = '0.1.0';
    try {
      const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf-8'));
      version = pkg.version;
    } catch { /* ignore */ }

    return {
      status,
      uptime: Math.floor(uptimeMs / 1000),
      version,
      adapters,
      llmProvider: this.config.llmProvider,
      database: dbOk ? 'ok' : 'error',
    };
  }

  _requireAuth(req, res) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!this.config.masterKey || token !== this.config.masterKey) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return false;
    }
    return true;
  }
}
