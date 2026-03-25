const MAX_MESSAGE_LENGTH = 4096;

/**
 * Handles outbound message formatting and sending for Telegram.
 */
export class TelegramSender {
  constructor(bot, logger) {
    this.bot = bot;
    this.logger = logger;
  }

  async send(chatId, text, options = {}) {
    const chunks = this.splitLongMessage(text, MAX_MESSAGE_LENGTH);

    for (let i = 0; i < chunks.length; i++) {
      const sendOptions = {
        parse_mode: 'Markdown',
      };

      // Only reply to the original message for the first chunk
      if (i === 0 && options.replyToMessageId) {
        sendOptions.reply_to_message_id = options.replyToMessageId;
      }

      try {
        await this.bot.sendMessage(chatId, chunks[i], sendOptions);
      } catch (err) {
        // If Markdown parsing fails, retry without parse_mode
        if (err.message?.includes('parse')) {
          this.logger.warn('Markdown parse failed, sending as plain text');
          await this.bot.sendMessage(chatId, chunks[i], {
            reply_to_message_id: sendOptions.reply_to_message_id,
          });
        } else {
          throw err;
        }
      }
    }
  }

  /**
   * Split a long message at paragraph boundaries.
   */
  splitLongMessage(text, maxLength = MAX_MESSAGE_LENGTH) {
    if (text.length <= maxLength) return [text];

    const chunks = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }

      // Try to split at a paragraph boundary
      let splitIndex = remaining.lastIndexOf('\n\n', maxLength);

      // Fall back to single newline
      if (splitIndex < maxLength * 0.3) {
        splitIndex = remaining.lastIndexOf('\n', maxLength);
      }

      // Fall back to space
      if (splitIndex < maxLength * 0.3) {
        splitIndex = remaining.lastIndexOf(' ', maxLength);
      }

      // Hard split as last resort
      if (splitIndex < maxLength * 0.3) {
        splitIndex = maxLength;
      }

      chunks.push(remaining.substring(0, splitIndex));
      remaining = remaining.substring(splitIndex).trimStart();
    }

    return chunks;
  }
}
