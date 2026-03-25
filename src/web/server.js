import { HealthServer } from './health.js';
import { readFileSync, existsSync } from 'fs';
import { resolve, join, extname } from 'path';

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
};

export class DashboardServer extends HealthServer {
  constructor(opts) {
    super(opts);
    this.toolRegistry = opts.toolRegistry || null;
    this.skillLoader = opts.skillLoader || null;
    this.auditLogger = opts.auditLogger || null;
    this.scheduler = opts.scheduler || null;
    this.agentRegistry = opts.agentRegistry || null;
    this.publicDir = resolve('src/web/public');
  }

  _handleRequest(req, res) {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health endpoints (inherited)
    if (req.url === '/health' || req.url === '/status') {
      return super._handleRequest(req, res);
    }

    // API endpoints
    if (req.url.startsWith('/api/')) {
      return this._handleApi(req, res);
    }

    // Static files
    return this._handleStatic(req, res);
  }

  _handleApi(req, res) {
    if (!this._requireAuth(req, res)) return;

    const url = req.url.split('?')[0];

    const routes = {
      '/api/status': () => this._apiStatus(req, res),
      '/api/sessions': () => this._apiSessions(req, res),
      '/api/tools': () => this._apiTools(req, res),
      '/api/skills': () => this._apiSkills(req, res),
      '/api/users': () => this._apiUsers(req, res),
      '/api/audit': () => this._apiAudit(req, res),
      '/api/config': () => this._apiConfig(req, res),
      '/api/tasks': () => this._apiTasks(req, res),
      '/api/agents': () => this._apiAgents(req, res),
    };

    const handler = routes[url];
    if (handler) {
      try {
        handler();
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  }

  _handleStatic(req, res) {
    let filePath = req.url === '/' ? '/index.html' : req.url;
    filePath = join(this.publicDir, filePath);

    if (!existsSync(filePath)) {
      // SPA fallback
      filePath = join(this.publicDir, 'index.html');
    }

    if (!existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const ext = extname(filePath);
    const mimeType = MIME_TYPES[ext] || 'text/plain';

    try {
      const content = readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': mimeType });
      res.end(content);
    } catch {
      res.writeHead(500);
      res.end('Internal error');
    }
  }

  _apiStatus(req, res) {
    const health = this._getHealthData();
    this._json(res, { health, config: this._safeConfig() });
  }

  _apiSessions(req, res) {
    try {
      const sessions = this.db.prepare(
        'SELECT id, user_id, channel_id, updated_at FROM sessions ORDER BY updated_at DESC LIMIT 50'
      ).all();
      this._json(res, sessions);
    } catch {
      this._json(res, []);
    }
  }

  _apiTools(req, res) {
    const tools = this.toolRegistry
      ? this.toolRegistry.getAll().map(t => ({ name: t.name, description: t.description, class: t.class }))
      : [];
    this._json(res, tools);
  }

  _apiSkills(req, res) {
    const skills = this.skillLoader
      ? this.skillLoader.getLoadedSkills().map(s => ({ name: s.name, trigger: s.trigger, description: s.description }))
      : [];
    this._json(res, skills);
  }

  _apiUsers(req, res) {
    try {
      const users = this.db.prepare('SELECT id, channel_id, display_name, role, created_at FROM users LIMIT 100').all();
      this._json(res, users);
    } catch {
      this._json(res, []);
    }
  }

  _apiAudit(req, res) {
    if (!this.auditLogger) {
      this._json(res, []);
      return;
    }
    const entries = this.auditLogger.query({ limit: 100 });
    this._json(res, entries);
  }

  _apiConfig(req, res) {
    this._json(res, this._safeConfig());
  }

  _apiTasks(req, res) {
    const tasks = this.scheduler ? this.scheduler.listTasks() : [];
    this._json(res, tasks);
  }

  _apiAgents(req, res) {
    const agents = this.agentRegistry
      ? this.agentRegistry.list().map(a => ({ name: a.name, description: a.description, model: a.model }))
      : [];
    this._json(res, agents);
  }

  _safeConfig() {
    return {
      agentName: this.config.agentName,
      llmProvider: this.config.llmProvider,
      model: this.config.model,
      workspaceDir: this.config.workspaceDir,
      maxToolIterations: this.config.maxToolIterations,
      healthPort: this.config.healthPort,
      dashboardEnabled: this.config.dashboardEnabled,
    };
  }

  _json(res, data) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }
}
