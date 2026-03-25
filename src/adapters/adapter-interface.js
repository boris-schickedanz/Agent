/**
 * Abstract adapter interface. All channel adapters must extend this class.
 *
 * Normalized message format:
 * {
 *   id: string,              // Platform message ID
 *   sessionId: string,       // channelId:userId
 *   channelId: string,       // Adapter identifier
 *   userId: string,          // Platform user ID
 *   userName: string,        // Display name
 *   content: string,         // Text content
 *   attachments: Array,      // Optional media
 *   replyTo: string|null,    // Parent message ID
 *   timestamp: number,       // Unix ms
 *   raw: object              // Original platform payload
 * }
 */
export class AdapterInterface {
  get channelId() {
    throw new Error('Not implemented: channelId');
  }

  async start() {
    throw new Error('Not implemented: start()');
  }

  async stop() {
    throw new Error('Not implemented: stop()');
  }

  normalizeInbound(rawMessage) {
    throw new Error('Not implemented: normalizeInbound()');
  }

  formatOutbound(agentMessage) {
    throw new Error('Not implemented: formatOutbound()');
  }

  async sendMessage(sessionId, message) {
    throw new Error('Not implemented: sendMessage()');
  }
}
