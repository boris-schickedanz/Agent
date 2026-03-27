#!/usr/bin/env node

import { resolve } from 'path';
import { existsSync } from 'fs';

const args = process.argv.slice(2);
const command = args[0];
const subcommand = args[1];

async function main() {
  switch (command) {
    case 'start':
      return handleStart();
    case 'stop':
      return handleStop();
    case 'status':
      return handleStatus();
    case 'build':
      return handleBuild();
    case 'install':
      return handleInstall();
    case 'uninstall':
      return handleUninstall();
    case 'onboard':
      return handleOnboard();
    case 'config':
      return handleConfig();
    case 'skill':
      return handleSkill();
    case 'agent':
      return handleAgent();
    case 'logs':
      return handleLogs();
    case 'help':
    case '--help':
    case '-h':
    default:
      return showHelp();
  }
}

function showHelp() {
  console.log(`
AgentCore CLI

Usage: agentcore <command> [options]

Commands:
  start              Start the agent (foreground, in container by default)
  start --daemon     Start as detached container (background)
  start --no-container  Start directly without container
  stop               Stop the daemon (container or PM2)
  status             Show agent status (queries health endpoint)
  install            Install launchd service (boot persistence + auto-restart)
  uninstall          Remove launchd service
  build              Build/rebuild the container image
  onboard            Interactive setup wizard
  config list        Show current config
  config set K V     Set an env var in .env
  skill list         List installed skills
  skill install URL  Install a skill from URL
  skill remove NAME  Remove an installed skill
  agent list         List agent profiles
  logs               Show agent logs (add -f to follow)
  help               Show this help message
`);
}

async function handleStart() {
  // Daemon mode — detached container
  if (args.includes('--daemon')) {
    const { ContainerLauncher } = await import('../src/container/container-launcher.js');
    const launcher = new ContainerLauncher({ projectRoot: resolve('.') });

    if (!launcher.isAvailable()) {
      console.error('Apple container CLI not found. Install it to use daemon mode.');
      process.exit(1);
    }

    launcher.ensureSystemRunning();
    launcher.stopStaleContainers();

    if (!launcher.imageExists()) {
      console.log('Building container image (first run)...');
      try {
        launcher.build();
      } catch (err) {
        console.error(`Failed to build container image: ${err.message}`);
        process.exit(1);
      }
    }

    const healthPort = parseInt(process.env.HEALTH_PORT || '9090', 10);
    try {
      launcher.launchDetached({ healthPort });
      console.log('Agent started in daemon mode.');
      console.log('Run "agentcore logs" to view logs.');
      console.log('Run "agentcore stop" to stop.');
    } catch (err) {
      console.error(`Failed to start daemon: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  // Already inside a container — run directly
  if (process.env.AGENTCORE_IN_CONTAINER === '1') {
    await import('../src/index.js');
    return;
  }

  // Explicit skip
  if (args.includes('--no-container')) {
    await import('../src/index.js');
    return;
  }

  // Check container mode config
  const containerMode = process.env.CONTAINER_MODE || 'auto';
  if (containerMode === 'false') {
    await import('../src/index.js');
    return;
  }

  // Try container launch
  const { ContainerLauncher } = await import('../src/container/container-launcher.js');
  const launcher = new ContainerLauncher({ projectRoot: resolve('.') });

  if (!launcher.isAvailable()) {
    if (containerMode === 'true') {
      console.error('Apple container CLI not found. Install it or set CONTAINER_MODE=false.');
      process.exit(1);
    }
    // auto mode — silent fallback to direct execution
    await import('../src/index.js');
    return;
  }

  launcher.ensureSystemRunning();
  launcher.stopStaleContainers();

  // Auto-build image on first run
  if (!launcher.imageExists()) {
    console.log('Building container image (first run)...');
    try {
      launcher.build();
    } catch (err) {
      console.error(`Failed to build container image: ${err.message}`);
      if (containerMode === 'true') {
        process.exit(1);
      }
      console.log('Falling back to direct execution.');
      await import('../src/index.js');
      return;
    }
  }

  // Launch in container, forward signals
  const healthPort = parseInt(process.env.HEALTH_PORT || '9090', 10);
  const child = launcher.launch({ healthPort });

  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));

  child.on('error', (err) => {
    console.error(`Container error: ${err.message}`);
    process.exit(1);
  });

  child.on('exit', (code) => {
    process.exit(code ?? 1);
  });
}

async function handleInstall() {
  const { ContainerLauncher } = await import('../src/container/container-launcher.js');
  const { LaunchdInstaller } = await import('../src/container/launchd-installer.js');

  const launcher = new ContainerLauncher({ projectRoot: resolve('.') });
  const installer = new LaunchdInstaller({ projectRoot: resolve('.') });

  if (!launcher.isAvailable()) {
    console.error('Apple container CLI not found. Install it before setting up the launchd service.');
    process.exit(1);
  }

  launcher.ensureSystemRunning();

  // Auto-build image if needed
  if (!launcher.imageExists()) {
    console.log('Building container image (first run)...');
    try {
      launcher.build();
    } catch (err) {
      console.error(`Failed to build container image: ${err.message}`);
      process.exit(1);
    }
  }

  if (installer.isInstalled()) {
    console.error(`Already installed at: ${installer.plistPath()}`);
    console.error('Run "agentcore uninstall" first to reinstall.');
    process.exit(1);
  }

  try {
    installer.install();
    console.log(`Installed launchd service: ${installer.plistPath()}`);
    console.log('Agent will start automatically on login and restart on crash.');
    console.log('Run "agentcore logs -f" to follow logs.');
    console.log('Run "agentcore uninstall" to remove.');
  } catch (err) {
    console.error(`Install failed: ${err.message}`);
    process.exit(1);
  }
}

async function handleUninstall() {
  const { LaunchdInstaller } = await import('../src/container/launchd-installer.js');
  const installer = new LaunchdInstaller({ projectRoot: resolve('.') });

  if (!installer.isInstalled()) {
    console.error('Not installed.');
    process.exit(1);
  }

  try {
    installer.uninstall();
    console.log('launchd service removed. Agent will no longer start on login.');
  } catch (err) {
    console.error(`Uninstall failed: ${err.message}`);
    process.exit(1);
  }
}

async function handleBuild() {
  const { ContainerLauncher } = await import('../src/container/container-launcher.js');
  const launcher = new ContainerLauncher({ projectRoot: resolve('.') });

  if (!launcher.isAvailable()) {
    console.error('Apple container CLI not found.');
    process.exit(1);
  }

  try {
    launcher.build();
    console.log('Container image built successfully.');
  } catch (err) {
    console.error(`Build failed: ${err.message}`);
    process.exit(1);
  }
}

async function handleStop() {
  const { ContainerLauncher } = await import('../src/container/container-launcher.js');
  const { LaunchdInstaller } = await import('../src/container/launchd-installer.js');
  const launcher = new ContainerLauncher({ projectRoot: resolve('.') });
  const installer = new LaunchdInstaller({ projectRoot: resolve('.') });

  // If launchd-managed: stop via launchctl (launchd will restart unless we unload)
  if (installer.isInstalled()) {
    const { execSync } = await import('child_process');
    try {
      execSync(`launchctl stop com.boris.agentcore`, { stdio: 'inherit' });
      console.log('Agent stopped. (launchd will restart it — run "agentcore uninstall" to disable.)');
    } catch (err) {
      console.error(`Failed to stop: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  // Detached container daemon
  if (launcher.isAvailable() && launcher.isDaemonRunning()) {
    try {
      launcher.stopDaemon();
      console.log('Agent stopped.');
    } catch (err) {
      console.error(`Failed to stop container: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  // Fallback: try PM2 for legacy deployments
  const { execSync } = await import('child_process');
  try {
    execSync('pm2 stop agentcore', { stdio: 'inherit' });
  } catch {
    console.error('No running agent found (checked launchd, container daemon, and PM2).');
    process.exit(1);
  }
}

async function handleStatus() {
  const { config } = await import('../src/config.js');
  const port = config.healthPort;
  const http = await import('http');

  const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      try {
        const data = JSON.parse(body);
        console.log(`Status: ${data.status}`);
        console.log(`Uptime: ${data.uptime}s`);
        console.log(`Version: ${data.version}`);
        console.log(`Database: ${data.database}`);
        console.log(`LLM Provider: ${data.llmProvider}`);
        console.log(`Adapters: ${(data.adapters || []).join(', ') || 'none'}`);
      } catch {
        console.log(body);
      }
    });
  });

  req.on('error', () => {
    console.error(`Cannot connect to health endpoint on port ${port}.`);
    console.error('Is the agent running?');
    process.exit(1);
  });
}

async function handleOnboard() {
  const { OnboardWizard } = await import('../src/cli/onboard-wizard.js');
  const wizard = new OnboardWizard();
  await wizard.run();
}

async function handleConfig() {
  if (subcommand === 'set') {
    const key = args[2];
    const value = args[3];
    if (!key || value === undefined) {
      console.error('Usage: agentcore config set KEY VALUE');
      process.exit(1);
    }

    const { readFileSync, writeFileSync } = await import('fs');
    const envPath = resolve('.env');
    let content = '';
    try { content = readFileSync(envPath, 'utf-8'); } catch { /* new file */ }

    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${value}`);
    } else {
      content += `\n${key}=${value}`;
    }

    writeFileSync(envPath, content.trim() + '\n');
    console.log(`Set ${key}=${value} in .env`);
  } else {
    // List config
    const { config } = await import('../src/config.js');
    const safe = { ...config };
    // Redact secrets
    if (safe.anthropicApiKey) safe.anthropicApiKey = '***';
    if (safe.anthropicAuthToken) safe.anthropicAuthToken = '***';
    if (safe.telegramBotToken) safe.telegramBotToken = '***';
    if (safe.masterKey) safe.masterKey = '***';

    for (const [key, value] of Object.entries(safe)) {
      console.log(`${key}: ${JSON.stringify(value)}`);
    }
  }
}

async function handleSkill() {
  const { SkillInstaller } = await import('../src/skills/skill-installer.js');
  const installer = new SkillInstaller({ skillsDir: resolve('skills'), logger: console });

  switch (subcommand) {
    case 'install': {
      const url = args[2];
      if (!url) {
        console.error('Usage: agentcore skill install <url-or-path>');
        process.exit(1);
      }
      const result = await installer.installFromUrl(url);
      console.log(`Installed skill: ${result.name} → ${result.path}`);
      break;
    }
    case 'remove': {
      const name = args[2];
      if (!name) {
        console.error('Usage: agentcore skill remove <name>');
        process.exit(1);
      }
      const removed = installer.uninstall(name);
      console.log(removed ? `Removed skill: ${name}` : `Skill not found: ${name}`);
      break;
    }
    case 'list':
    default: {
      const skills = installer.listInstalled();
      if (skills.length === 0) {
        console.log('No skills installed.');
      } else {
        for (const s of skills) {
          console.log(`  ${s.name} (${s.path})`);
        }
      }
      break;
    }
  }
}

async function handleAgent() {
  const { AgentRegistry } = await import('../src/agents/agent-registry.js');
  const registry = new AgentRegistry({ agentsDir: resolve('agents'), logger: console });
  registry.loadAll();

  const agents = registry.list();
  if (agents.length === 0) {
    console.log('No agent profiles found. Create one in agents/<name>/AGENT.md');
  } else {
    for (const a of agents) {
      console.log(`  ${a.name}: ${a.description}`);
    }
  }
}

async function handleLogs() {
  const { ContainerLauncher } = await import('../src/container/container-launcher.js');
  const { LaunchdInstaller } = await import('../src/container/launchd-installer.js');
  const { spawn } = await import('child_process');
  const launcher = new ContainerLauncher({ projectRoot: resolve('.') });
  const installer = new LaunchdInstaller({ projectRoot: resolve('.') });
  const follow = args.includes('-f') || args.includes('--follow');

  // launchd-managed: tail the log files
  if (installer.isInstalled()) {
    const logFile = resolve('.', 'logs', 'out.log');
    const tailArgs = follow ? ['-f', logFile] : ['-n', '50', logFile];
    const child = spawn('tail', tailArgs, { stdio: 'inherit' });
    child.on('error', (err) => {
      console.error(`Failed to read logs: ${err.message}`);
      process.exit(1);
    });
    return;
  }

  // Detached container daemon
  if (launcher.isAvailable() && launcher.isDaemonRunning()) {
    const child = launcher.tailLogs({ lines: 50, follow });
    child.on('error', (err) => {
      console.error(`Failed to read logs: ${err.message}`);
      process.exit(1);
    });
    return;
  }

  // Fallback: PM2
  const { execSync } = await import('child_process');
  try {
    execSync('pm2 logs agentcore --lines 50', { stdio: 'inherit' });
  } catch {
    console.error('No running agent found (checked launchd, container daemon, and PM2).');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
