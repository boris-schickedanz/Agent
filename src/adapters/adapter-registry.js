export class AdapterRegistry {
  constructor(eventBus) {
    this.eventBus = eventBus;
    this._adapters = new Map();
  }

  register(adapter) {
    this._adapters.set(adapter.channelId, adapter);

    // Wire outbound messages to the correct adapter
    this.eventBus.on('message:outbound', async (message) => {
      if (message.channelId === adapter.channelId) {
        try {
          const formatted = adapter.formatOutbound(message);
          await adapter.sendMessage(message.sessionId, formatted);
        } catch (err) {
          this.eventBus.emit('error', err);
        }
      }
    });
  }

  get(channelId) {
    return this._adapters.get(channelId) || null;
  }

  getAll() {
    return Array.from(this._adapters.values());
  }

  async startAll() {
    for (const adapter of this._adapters.values()) {
      await adapter.start();
    }
  }

  async stopAll() {
    for (const adapter of this._adapters.values()) {
      await adapter.stop();
    }
  }
}
