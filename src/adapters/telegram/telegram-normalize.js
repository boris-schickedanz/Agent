/**
 * Normalize Telegram message objects to the agent's universal format.
 */

export function normalizeMessage(msg) {
  const chatId = String(msg.chat.id);
  const userId = String(msg.from?.id || chatId);
  const userName = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || 'Unknown';

  return {
    id: String(msg.message_id),
    sessionId: `telegram:${chatId}`,
    channelId: 'telegram',
    userId,
    userName,
    content: msg.text || msg.caption || '',
    attachments: extractAttachments(msg),
    replyTo: msg.reply_to_message ? String(msg.reply_to_message.message_id) : null,
    timestamp: (msg.date || Math.floor(Date.now() / 1000)) * 1000,
    raw: msg,
  };
}

export function normalizeCallbackQuery(query) {
  const msg = query.message;
  const chatId = String(msg.chat.id);
  const userId = String(query.from.id);
  const userName = [query.from.first_name, query.from.last_name].filter(Boolean).join(' ') || 'Unknown';

  return {
    id: String(query.id),
    sessionId: `telegram:${chatId}`,
    channelId: 'telegram',
    userId,
    userName,
    content: query.data || '',
    attachments: [],
    replyTo: String(msg.message_id),
    timestamp: Date.now(),
    raw: query,
  };
}

export function extractAttachments(msg) {
  const attachments = [];

  if (msg.photo && msg.photo.length > 0) {
    // Get the highest resolution photo
    const largest = msg.photo[msg.photo.length - 1];
    attachments.push({
      type: 'photo',
      fileId: largest.file_id,
      size: largest.file_size || 0,
    });
  }

  if (msg.document) {
    attachments.push({
      type: 'document',
      fileId: msg.document.file_id,
      mimeType: msg.document.mime_type || 'application/octet-stream',
      fileName: msg.document.file_name || 'document',
      size: msg.document.file_size || 0,
    });
  }

  if (msg.voice) {
    attachments.push({
      type: 'voice',
      fileId: msg.voice.file_id,
      duration: msg.voice.duration,
      size: msg.voice.file_size || 0,
    });
  }

  if (msg.video) {
    attachments.push({
      type: 'video',
      fileId: msg.video.file_id,
      duration: msg.video.duration,
      size: msg.video.file_size || 0,
    });
  }

  return attachments;
}
