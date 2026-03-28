import TelegramBot from 'node-telegram-bot-api';
import { AdapterInterface } from '../adapter-interface.js';
import { normalizeMessage, normalizeCallbackQuery } from './telegram-normalize.js';
import { TelegramSender } from './telegram-sender.js';

const STREAM_EDIT_INTERVAL_MS = 1500;

export class TelegramAdapter extends AdapterInterface {
  constructor(eventBus, config, logger) {
    super();
    this.eventBus = eventBus;
    this.config = config;
    this.logger = logger;
    this.bot = null;
    this.sender = null;
    this._streams = new Map(); // sessionId -> { chatId, messageId, text, timer, dirty }
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
    // If we already streamed this response, skip the full send
    if (this._streams.has(sessionId)) {
      this._streams.delete(sessionId);
      return;
    }
    const chatId = formattedMessage.chatId || this._extractChatId(sessionId);
    await this.sender.send(chatId, formattedMessage.text, {
      replyToMessageId: formattedMessage.replyToMessageId,
    });
  }

  handleStreamEvent(sessionId, event) {
    switch (event.type) {
      case 'stream:start':
        this._streamStart(sessionId);
        break;
      case 'stream:delta':
        this._streamDelta(sessionId, event.text);
        break;
      case 'stream:status': {
        const chatId = this._extractChatId(sessionId);
        this.bot.sendChatAction(chatId, 'typing').catch(() => {});
        break;
      }
      case 'stream:end':
        this._streamEnd(sessionId);
        break;
    }
  }

  _streamStart(sessionId) {
    const chatId = this._extractChatId(sessionId);
    const state = { chatId, messageId: null, text: '', timer: null, dirty: false, sending: false };
    this._streams.set(sessionId, state);

    // Send initial placeholder message
    this.bot.sendMessage(chatId, '...', { parse_mode: 'Markdown' })
      .then((sent) => { state.messageId = sent.message_id; })
      .catch((err) => this.logger.warn({ err: err.message }, 'Failed to send stream placeholder'));
  }

  _streamDelta(sessionId, text) {
    const state = this._streams.get(sessionId);
    if (!state) return;

    state.text += text;
    state.dirty = true;

    // Debounce edits
    if (!state.timer) {
      state.timer = setTimeout(() => this._flushEdit(sessionId), STREAM_EDIT_INTERVAL_MS);
    }
  }

  async _streamEnd(sessionId) {
    const state = this._streams.get(sessionId);
    if (!state) return;

    // Clear pending timer and do a final edit
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    await this._flushEdit(sessionId);
  }

  async _flushEdit(sessionId) {
    const state = this._streams.get(sessionId);
    if (!state || !state.dirty || !state.messageId) {
      if (state) state.timer = null;
      return;
    }

    state.dirty = false;
    state.timer = null;

    try {
      await this.bot.editMessageText(state.text, {
        chat_id: state.chatId,
        message_id: state.messageId,
        parse_mode: 'Markdown',
      });
    } catch (err) {
      // Markdown parse failure — retry as plain text
      if (err.message?.includes('parse')) {
        try {
          await this.bot.editMessageText(state.text, {
            chat_id: state.chatId,
            message_id: state.messageId,
          });
        } catch { /* ignore secondary failure */ }
      }
    }
  }

  _extractChatId(sessionId) {
    // sessionId format: "telegram:{chatId}"
    const parts = sessionId.split(':');
    return parts[parts.length - 1];
  }
}
