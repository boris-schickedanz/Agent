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
  start              Start the agent (foreground)
  start --daemon     Start via PM2 (background)
  stop               Stop PM2 process
  status             Show agent status (queries health endpoint)
  onboard            Interactive setup wizard
  config list        Show current config
  config set K V     Set an env var in .env
  skill list         List installed skills
  skill install URL  Install a skill from URL
  skill remove NAME  Remove an installed skill
  agent list         List agent profiles
  logs               Tail agent logs
  help               Show this help message
`);
}

async function handleStart() {
  if (args.includes('--daemon')) {
    const { execSync } = await import('child_process');
    try {
      execSync('pm2 start ecosystem.config.cjs', { stdio: 'inherit' });
      console.log('\nAgent started in daemon mode.');
      console.log('Run "agentcore logs" to view logs.');
      console.log('Run "pm2 startup" to enable boot persistence.');
    } catch (err) {
      console.error('Failed to start daemon. Is PM2 installed? (npm install -g pm2)');
      process.exit(1);
    }
  } else {
    // Foreground mode — just run index.js
    await import('../src/index.js');
  }
}

async function handleStop() {
  const { execSync } = await import('child_process');
  try {
    execSync('pm2 stop agentcore', { stdio: 'inherit' });
  } catch {
    console.error('Failed to stop. Is the agent running via PM2?');
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
  const { execSync } = await import('child_process');
  try {
    execSync('pm2 logs agentcore --lines 50', { stdio: 'inherit' });
  } catch {
    console.error('Failed to read logs. Is PM2 running?');
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
