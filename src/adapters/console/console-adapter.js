import { createInterface } from 'readline';
import { AdapterInterface } from '../adapter-interface.js';

export class ConsoleAdapter extends AdapterInterface {
  constructor(eventBus, config) {
    super();
    this.eventBus = eventBus;
    this.config = config;
    this.rl = null;
    this._userId = config.consoleUserId || 'console-user';
  }

  get channelId() {
    return 'console';
  }

  async start() {
    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    console.log(`\n🤖 ${this.config.agentName} is ready. Type your message (Ctrl+C to exit).\n`);

    this.rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      const normalized = this.normalizeInbound(trimmed);
      this.eventBus.emit('message:inbound', normalized);
    });

    this.rl.on('close', () => {
      process.exit(0);
    });
  }

  async stop() {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }

  normalizeInbound(text) {
    return {
      id: `console_${Date.now()}`,
      sessionId: `console:${this._userId}`,
      channelId: 'console',
      userId: this._userId,
      userName: 'Console User',
      content: text,
      attachments: [],
      replyTo: null,
      timestamp: Date.now(),
      raw: { text },
    };
  }

  formatOutbound(agentMessage) {
    return agentMessage.content;
  }

  async sendMessage(sessionId, message) {
    console.log(`\n💬 ${message}\n`);
  }
}
