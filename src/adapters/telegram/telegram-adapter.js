import TelegramBot from 'node-telegram-bot-api';
import { AdapterInterface } from '../adapter-interface.js';
import { normalizeMessage, normalizeCallbackQuery } from './telegram-normalize.js';
import { TelegramSender } from './telegram-sender.js';

export class TelegramAdapter extends AdapterInterface {
  constructor(eventBus, config, logger) {
    super();
    this.eventBus = eventBus;
    this.config = config;
    this.logger = logger;
    this.bot = null;
    this.sender = null;
  }

  get channelId() {
    return 'telegram';
  }

  async start() {
    this.bot = new TelegramBot(this.config.telegramBotToken, { polling: true });
    this.sender = new TelegramSender(this.bot, this.logger);

    // Handle text messages
    this.bot.on('message', (msg) => {
      // Skip non-text messages without captions
      if (!msg.text && !msg.caption) return;

      const normalized = this.normalizeInbound(msg);
      this.logger.info(
        { userId: normalized.userId, sessionId: normalized.sessionId },
        'Telegram message received'
      );
      this.eventBus.emit('message:inbound', normalized);
    });

    // Handle callback queries (inline keyboard)
    this.bot.on('callback_query', (query) => {
      const normalized = normalizeCallbackQuery(query);
      this.eventBus.emit('message:inbound', normalized);
      // Acknowledge the callback
      this.bot.answerCallbackQuery(query.id).catch(() => {});
    });

    // Handle polling errors
    this.bot.on('polling_error', (err) => {
      this.logger.error({ err: err.message }, 'Telegram polling error');
    });

    const me = await this.bot.getMe();
    this.logger.info({ botName: me.username }, 'Telegram adapter started');
  }

  async stop() {
    if (this.bot) {
      await this.bot.stopPolling();
      this.bot = null;
    }
  }

  normalizeInbound(rawMessage) {
    return normalizeMessage(rawMessage);
  }

  formatOutbound(agentMessage) {
    return {
      text: agentMessage.content,
      replyToMessageId: agentMessage.replyTo ? parseInt(agentMessage.replyTo, 10) : null,
      chatId: this._extractChatId(agentMessage.sessionId),
    };
  }

  async sendMessage(sessionId, formattedMessage) {
    const chatId = formattedMessage.chatId || this._extractChatId(sessionId);
    await this.sender.send(chatId, formattedMessage.text, {
      replyToMessageId: formattedMessage.replyToMessageId,
    });
  }

  _extractChatId(sessionId) {
    // sessionId format: "telegram:{chatId}" or "telegram:group:{chatId}"
    const parts = sessionId.split(':');
    return parts[parts.length - 1];
  }
}
