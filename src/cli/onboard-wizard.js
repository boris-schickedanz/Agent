import { createInterface } from 'readline';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve } from 'path';
import { randomBytes } from 'crypto';

export class OnboardWizard {
  constructor() {
    this.rl = createInterface({ input: process.stdin, output: process.stdout });
    this.env = {};
  }

  async run() {
    console.log('\nWelcome to AgentCore!\n');
    console.log('This wizard will guide you through the initial setup.\n');

    await this._stepProvider();
    await this._stepModel();
    await this._stepTelegram();
    await this._stepWorkspace();
    await this._stepSecurity();

    this.rl.close();

    this._writeEnv();
    this._ensureDirs();

    console.log('\nConfiguration saved to .env');
    console.log("Run 'agentcore start' to begin!\n");
  }

  async _stepProvider() {
    console.log('Step 1/5: LLM Provider');
    const choice = await this._choose(
      '  Choose: [1] Anthropic (recommended) [2] Ollama',
      ['1', '2'],
      '1'
    );

    if (choice === '2') {
      this.env.LLM_PROVIDER = 'ollama';
      const host = await this._ask('  Ollama host [http://localhost:11434]: ') || 'http://localhost:11434';
      this.env.OLLAMA_HOST = host;
      const apiKey = await this._ask('  Ollama API key (leave blank for local): ');
      if (apiKey) this.env.OLLAMA_API_KEY = apiKey;
    } else {
      this.env.LLM_PROVIDER = 'anthropic';
      const key = await this._ask('  Enter your Anthropic API key: ');
      if (key) this.env.ANTHROPIC_API_KEY = key;
    }
  }

  async _stepModel() {
    console.log('\nStep 2/5: Model');
    if (this.env.LLM_PROVIDER === 'ollama') {
      const model = await this._ask('  Ollama model [llama3.1]: ') || 'llama3.1';
      this.env.OLLAMA_MODEL = model;
    } else {
      const choice = await this._choose(
        '  Choose: [1] Claude Sonnet 4 (recommended) [2] Claude Opus 4 [3] Claude Haiku 4.5',
        ['1', '2', '3'],
        '1'
      );
      const models = {
        '1': 'claude-sonnet-4-20250514',
        '2': 'claude-opus-4-20250514',
        '3': 'claude-haiku-4-5-20251001',
      };
      this.env.MODEL = models[choice];
    }
  }

  async _stepTelegram() {
    console.log('\nStep 3/5: Messaging Channel');
    const setupTg = await this._ask('  Set up Telegram? (y/n) [n]: ') || 'n';
    if (setupTg.toLowerCase() === 'y') {
      const token = await this._ask('  Enter Telegram Bot Token: ');
      if (token) this.env.TELEGRAM_BOT_TOKEN = token;
    }
  }

  async _stepWorkspace() {
    console.log('\nStep 4/5: Workspace');
    const dir = await this._ask('  Workspace directory [./workspace]: ') || './workspace';
    this.env.WORKSPACE_DIR = dir;
  }

  async _stepSecurity() {
    console.log('\nStep 5/5: Security');

    let masterKey = await this._ask('  Master key for dashboard (leave blank to auto-generate): ');
    if (!masterKey) {
      masterKey = randomBytes(24).toString('hex');
      console.log(`  Generated master key: ${masterKey}`);
    }
    this.env.MASTER_KEY = masterKey;
  }

  _writeEnv() {
    const envPath = resolve('.env');
    let existing = '';
    try { existing = readFileSync(envPath, 'utf-8'); } catch { /* new file */ }

    for (const [key, value] of Object.entries(this.env)) {
      const regex = new RegExp(`^${key}=.*$`, 'm');
      if (regex.test(existing)) {
        existing = existing.replace(regex, `${key}=${value}`);
      } else {
        existing += `\n${key}=${value}`;
      }
    }

    writeFileSync(envPath, existing.trim() + '\n');
  }

  _ensureDirs() {
    const dirs = ['data', this.env.WORKSPACE_DIR || './workspace', 'logs'];
    for (const dir of dirs) {
      mkdirSync(resolve(dir), { recursive: true });
    }
  }

  _ask(prompt) {
    return new Promise(resolve => {
      this.rl.question(prompt, resolve);
    });
  }

  async _choose(prompt, valid, defaultChoice) {
    while (true) {
      const answer = (await this._ask(`${prompt}\n  > `)) || defaultChoice;
      if (valid.includes(answer)) return answer;
      console.log(`  Please choose one of: ${valid.join(', ')}`);
    }
  }
}
