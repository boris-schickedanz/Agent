import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { DB } from '../src/db/database.js';
import { DashboardServer } from '../src/web/server.js';
import { PersistentMemory } from '../src/memory/persistent-memory.js';
import { ProjectManager } from '../src/memory/project-manager.js';
import { unlinkSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DB = `.test-dashboard-${process.pid}.db`;
const TEST_DATA_DIR = join(tmpdir(), `agentcore-test-dashboard-${process.pid}`);

function httpGet(port, path, headers = {}) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: '127.0.0.1', port, path, headers }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: body ? JSON.parse(body) : {} });
        } catch {
          resolve({ status: res.statusCode, body: {} });
        }
      });
      res.on('error', () => resolve({ status: res.statusCode, body: {} }));
    });
    req.on('error', (err) => {
      resolve({ status: 0, body: {}, error: err.message });
    });
  });
}

describe('DashboardServer project-aware endpoints', () => {
  let db, server, globalMemory, projectManager;
  const PORT = 19190 + (process.pid % 1000);
  const AUTH = { Authorization: 'Bearer test-key' };

  before(async () => {
    mkdirSync(TEST_DATA_DIR, { recursive: true });
    db = new DB(TEST_DB);
    await db.migrate();
    globalMemory = new PersistentMemory(TEST_DATA_DIR, db);
    projectManager = new ProjectManager(TEST_DATA_DIR, db);

    server = new DashboardServer({
      port: PORT,
      bind: '127.0.0.1',
      db,
      logger: { info: () => {}, error: () => {} },
      config: {
        agentName: 'TestAgent',
        llmProvider: 'test',
        model: 'test-model',
        workspaceDir: '/tmp',
        maxToolIterations: 25,
        masterKey: 'test-key',
        healthPort: PORT,
        dashboardEnabled: true,
      },
      persistentMemory: globalMemory,
      projectManager,
    });
    await server.start();
  });

  after(async () => {
    if (server.server) server.server.closeAllConnections();
    await server.stop();
    db.close();
    try { unlinkSync(TEST_DB); } catch {}
    try { rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch {}
  });

  it('GET /api/workspace-state returns global memory when no project active', async () => {
    // Ensure no project is active
    try { projectManager.deactivate(); } catch {}
    await globalMemory.save('project_state', 'Global state');

    const { status, body } = await httpGet(PORT, '/api/workspace-state', AUTH);
    assert.equal(status, 200);
    assert.equal(body.active_project, null);
    assert.equal(body.project_state, 'Global state');
  });

  it('GET /api/workspace-state returns project memory when project is active', async () => {
    projectManager.setActive('travel-planning');
    const projectMemory = projectManager.getMemory('travel-planning');
    await projectMemory.save('project_state', 'Panama trip planning');

    const { status, body } = await httpGet(PORT, '/api/workspace-state', AUTH);
    assert.equal(status, 200);
    assert.equal(body.active_project, 'travel-planning');
    assert.equal(body.project_state, 'Panama trip planning');
  });

  it('GET /api/memory lists both global and project keys', async () => {
    // project is still active from previous test
    const { status, body } = await httpGet(PORT, '/api/memory', AUTH);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body));

    const globalEntry = body.find(e => e.key === 'project_state' && e.scope === 'global');
    assert.ok(globalEntry, 'should include global project_state key');

    const projectEntry = body.find(e => e.key === 'project_state' && e.scope === 'project');
    assert.ok(projectEntry, 'should include project-scoped project_state key');
    assert.equal(projectEntry.project, 'travel-planning');
  });

  it('GET /api/memory/{key}?scope=project resolves project memory', async () => {
    const { status, body } = await httpGet(PORT, '/api/memory/project_state?scope=project', AUTH);
    assert.equal(status, 200);
    assert.equal(body.content, 'Panama trip planning');
    assert.equal(body.scope, 'project');
  });

  it('GET /api/memory/{key} without scope tries project first then global', async () => {
    const { status, body } = await httpGet(PORT, '/api/memory/project_state', AUTH);
    assert.equal(status, 200);
    // With project active, project memory should be found first
    assert.equal(body.content, 'Panama trip planning');
    assert.equal(body.scope, 'project');
  });

  it('GET /api/projects returns project list with active indicator', async () => {
    const { status, body } = await httpGet(PORT, '/api/projects', AUTH);
    assert.equal(status, 200);
    assert.equal(body.active, 'travel-planning');
    assert.ok(Array.isArray(body.projects));
    assert.ok(body.projects.includes('travel-planning'));
  });
});

describe('DashboardServer without projectManager', () => {
  let db, server, globalMemory;
  const PORT = 19290 + (process.pid % 1000);
  const AUTH = { Authorization: 'Bearer test-key' };
  const DATA_DIR = TEST_DATA_DIR + '-noproj';

  before(async () => {
    mkdirSync(DATA_DIR, { recursive: true });
    db = new DB(`.test-dashboard-noproj-${process.pid}.db`);
    await db.migrate();
    globalMemory = new PersistentMemory(DATA_DIR, db);

    server = new DashboardServer({
      port: PORT,
      bind: '127.0.0.1',
      db,
      logger: { info: () => {}, error: () => {} },
      config: {
        agentName: 'TestAgent',
        llmProvider: 'test',
        model: 'test-model',
        workspaceDir: '/tmp',
        maxToolIterations: 25,
        masterKey: 'test-key',
        healthPort: PORT,
        dashboardEnabled: true,
      },
      persistentMemory: globalMemory,
    });
    await server.start();
  });

  after(async () => {
    if (server.server) server.server.closeAllConnections();
    await server.stop();
    db.close();
    try { unlinkSync(`.test-dashboard-noproj-${process.pid}.db`); } catch {}
    try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
  });

  it('GET /api/projects returns empty when no projectManager', async () => {
    const { status, body } = await httpGet(PORT, '/api/projects', AUTH);
    assert.equal(status, 200);
    assert.equal(body.active, null);
    assert.deepStrictEqual(body.projects, []);
  });

  it('GET /api/workspace-state falls back to global memory', async () => {
    await globalMemory.save('project_state', 'Fallback state');
    const { status, body } = await httpGet(PORT, '/api/workspace-state', AUTH);
    assert.equal(status, 200);
    assert.equal(body.project_state, 'Fallback state');
  });
});
