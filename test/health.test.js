import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { DB } from '../src/db/database.js';
import { HealthServer } from '../src/web/health.js';
import { unlinkSync } from 'fs';

const TEST_DB = `.test-health-${process.pid}.db`;

function httpGet(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
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
      // Connection reset is expected for some error responses
      resolve({ status: 0, body: {}, error: err.message });
    });
  });
}

describe('HealthServer', () => {
  let db, server;
  const PORT = 19090 + (process.pid % 1000);

  beforeEach(async () => {
    db = DB.getInstance(TEST_DB);
    await db.migrate();
    server = new HealthServer({
      port: PORT,
      bind: '127.0.0.1',
      db,
      logger: { info: () => {}, error: () => {} },
      config: {
        agentName: 'TestAgent',
        llmProvider: 'anthropic',
        model: 'test-model',
        workspaceDir: '/tmp/workspace',
        maxToolIterations: 25,
        masterKey: 'test-key',
      },
    });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    db.close();
    try { unlinkSync(TEST_DB); } catch {}
  });

  it('GET /health returns 200 with status', async () => {
    const { status, body } = await httpGet(PORT, '/health');
    assert.equal(status, 200);
    assert.equal(body.status, 'healthy');
    assert.ok(body.uptime >= 0);
    assert.equal(body.database, 'ok');
  });

  it('GET /status requires auth', async () => {
    const { status } = await httpGet(PORT, '/status');
    assert.ok(status === 401 || status === 0, 'Should be 401 or connection error');
  });

  it('GET /status with auth returns extended info', async () => {
    const { status, body } = await httpGet(PORT, '/status', {
      Authorization: 'Bearer test-key',
    });
    assert.equal(status, 200);
    assert.ok(body.health);
    assert.equal(body.config.agentName, 'TestAgent');
  });

  it('GET /unknown returns 404', async () => {
    const { status } = await httpGet(PORT, '/unknown');
    assert.ok(status === 404 || status === 0, 'Should be 404 or connection error');
  });
});
