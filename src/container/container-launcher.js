import { execSync, spawn } from 'child_process';
import { existsSync, readFileSync, realpathSync } from 'fs';
import { resolve } from 'path';

// Env var names from src/config.js that should be forwarded into the container
const CONFIG_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'TELEGRAM_BOT_TOKEN',
  'AGENT_NAME',
  'LOG_LEVEL',
  'MAX_TOOL_ITERATIONS',
  'HEARTBEAT_INTERVAL_MINUTES',
  'RATE_LIMIT_MESSAGES_PER_MINUTE',
  'MAX_CONTEXT_TOKENS',
  'COMPACTION_THRESHOLD',
  'COMPACTION_RETAIN_MESSAGES',
  'COMPACTION_MEMORY_FLUSH',
  'PRUNE_THRESHOLD',
  'PRUNE_HEAD',
  'PRUNE_TAIL',
  'AUTO_APPROVE_USERS',
  'MASTER_KEY',
  'LLM_PROVIDER',
  'MODEL',
  'OLLAMA_HOST',
  'OLLAMA_MODEL',
  'OLLAMA_API_KEY',
  'CONSOLE_USER_ID',
  'AUDIT_LOG_ENABLED',
  'SHELL_CONTAINER',
  'SHELL_CONTAINER_RUNTIME',
  'SHELL_CONTAINER_IMAGE',
  'MAX_BACKGROUND_PROCESSES',
  'DEFAULT_SHELL_TIMEOUT_SECONDS',
  'HEALTH_PORT',
  'DASHBOARD_ENABLED',
  'MAX_DELEGATIONS',
  'MAX_DELEGATIONS_PER_SESSION',
];

const IMAGE_NAME = 'agentcore';
const DAEMON_NAME = 'agentcore-daemon';

export class ContainerLauncher {
  constructor({ projectRoot, logger } = {}) {
    this.projectRoot = projectRoot || process.cwd();
    this.logger = logger;
  }

  isAvailable() {
    try {
      execSync('container --version', { timeout: 5000, stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  isSystemRunning() {
    try {
      execSync('container system status', { timeout: 5000, stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  ensureSystemRunning() {
    const maxAttempts = 12; // ~60 seconds total (12 × 5s)
    const delayMs = 5_000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (this.isSystemRunning()) return;

      try {
        execSync('container system start', { timeout: 30_000, stdio: 'ignore' });
        // Brief pause to let the system daemon settle before re-checking
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_000);
        if (this.isSystemRunning()) return;
      } catch {
        // start failed or timed out — will retry
      }

      if (attempt < maxAttempts) {
        this.logger?.warn(
          { attempt, maxAttempts },
          `Container system not ready, retrying in ${delayMs / 1000}s…`,
        );
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
      }
    }

    throw new Error('Container system failed to start after 60 seconds.');
  }

  stopStaleContainers() {
    try {
      const output = execSync('container ls', { timeout: 10_000, encoding: 'utf-8' });
      const lines = output.split('\n').slice(1); // skip header
      for (const line of lines) {
        if (line.includes(IMAGE_NAME) && !line.startsWith('buildkit')) {
          const id = line.split(/\s+/)[0];
          if (id) {
            try { execSync(`container stop ${id}`, { timeout: 15_000, stdio: 'ignore' }); } catch {}
          }
        }
      }
    } catch {}
  }

  imageExists() {
    try {
      const output = execSync(`container image ls`, { timeout: 10_000, encoding: 'utf-8' });
      return output.includes(IMAGE_NAME);
    } catch {
      return false;
    }
  }

  build() {
    this.logger?.info('Building container image...');
    execSync(`container build -t ${IMAGE_NAME} .`, {
      cwd: this.projectRoot,
      stdio: 'inherit',
      timeout: 300_000, // 5 minutes
    });
    this.logger?.info('Container image built.');
  }

  isDaemonRunning() {
    try {
      const output = execSync('container ls', { timeout: 5000, encoding: 'utf-8' });
      return output.includes(DAEMON_NAME);
    } catch {
      return false;
    }
  }

  stopDaemon() {
    execSync(`container stop ${DAEMON_NAME}`, { timeout: 30_000, stdio: 'inherit' });
  }

  tailLogs({ lines = 50, follow = false } = {}) {
    const logArgs = ['logs', `--tail=${lines}`];
    if (follow) logArgs.push('--follow');
    logArgs.push(DAEMON_NAME);

    const child = spawn('container', logArgs, { stdio: 'inherit' });
    return child;
  }

  _buildRunArgs({ healthPort = 9090 } = {}) {
    const args = [];

    // Volume mounts for persistence
    const dataDir = resolve(this.projectRoot, 'data');
    const workspaceDir = resolve(this.projectRoot, 'workspace');
    args.push('-v', `${dataDir}:/app/data`);
    args.push('-v', `${workspaceDir}:/app/workspace`);

    // Pass .env file if it exists
    const envFile = resolve(this.projectRoot, '.env');
    if (existsSync(envFile)) {
      args.push('--env-file', envFile);
    }

    // Forward known config env vars from current shell
    for (const key of CONFIG_ENV_KEYS) {
      if (process.env[key] !== undefined) {
        args.push('-e', `${key}=${process.env[key]}`);
      }
    }

    // Resolve OLLAMA_HOST: check process.env first, then .env file
    let ollamaHost = process.env.OLLAMA_HOST || '';
    if (!ollamaHost || ollamaHost === '0.0.0.0:11434') {
      try {
        const envContent = readFileSync(envFile, 'utf-8');
        const match = envContent.match(/^OLLAMA_HOST=(.+)$/m);
        if (match) ollamaHost = match[1].trim();
      } catch {}
    }
    // Rewrite localhost/host.containers.internal to host gateway for container access
    const hostPattern = /localhost|127\.0\.0\.1|host\.containers\.internal|0\.0\.0\.0/;
    if (ollamaHost && hostPattern.test(ollamaHost)) {
      const gatewayUrl = ollamaHost.replace(hostPattern, '192.168.64.1');
      args.push('-e', `OLLAMA_HOST=${gatewayUrl}`);
    }

    // Sentinel to prevent re-wrapping
    args.push('-e', 'AGENTCORE_IN_CONTAINER=1');

    // Health bind must be 0.0.0.0 inside container for port publish to work
    args.push('-e', 'HEALTH_BIND=0.0.0.0');

    // Publish health port
    args.push('--publish', `${healthPort}:9090`);

    return args;
  }

  launch({ healthPort = 9090, tty = process.stdin.isTTY } = {}) {
    const args = ['run', '--rm'];

    // TTY passthrough for console adapter
    if (tty) {
      args.push('-it');
    }

    args.push(...this._buildRunArgs({ healthPort }));
    args.push(IMAGE_NAME);

    this.logger?.info({ cmd: ['container', ...args].join(' ') }, 'Launching container');

    const child = spawn('container', args, {
      stdio: 'inherit',
      cwd: this.projectRoot,
    });

    return child;
  }

  launchDetached({ healthPort = 9090 } = {}) {
    if (this.isDaemonRunning()) {
      throw new Error(`Daemon container '${DAEMON_NAME}' is already running. Run "agentcore stop" first.`);
    }

    const args = ['run', '--detach', '--name', DAEMON_NAME];
    args.push(...this._buildRunArgs({ healthPort }));
    args.push(IMAGE_NAME);

    this.logger?.info({ cmd: ['container', ...args].join(' ') }, 'Launching daemon container');

    execSync(['container', ...args].join(' '), {
      cwd: this.projectRoot,
      timeout: 30_000,
    });
  }
}
