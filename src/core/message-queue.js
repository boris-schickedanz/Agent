/**
 * Per-session serial message queue.
 * Different sessions process in parallel, but messages within a session are serialized.
 */
export class MessageQueue {
  constructor(agentLoop, logger) {
    this.agentLoop = agentLoop;
    this.logger = logger;
    this._queues = new Map();
    this._processing = new Set();
    this._shuttingDown = false;
  }

  async enqueue(sessionId, message) {
    if (this._shuttingDown) {
      this.logger.warn({ sessionId }, 'Message rejected: shutting down');
      return null;
    }

    return new Promise((resolve, reject) => {
      if (!this._queues.has(sessionId)) {
        this._queues.set(sessionId, []);
      }
      this._queues.get(sessionId).push({ message, resolve, reject });
      this._processNext(sessionId);
    });
  }

  async _processNext(sessionId) {
    if (this._processing.has(sessionId)) return;

    const queue = this._queues.get(sessionId);
    if (!queue || queue.length === 0) return;

    this._processing.add(sessionId);
    const { message, resolve, reject } = queue.shift();

    try {
      const result = await this.agentLoop.processMessage(message);
      resolve(result);
    } catch (err) {
      this.logger.error({ sessionId, err: err.message }, 'Message processing failed');
      reject(err);
    } finally {
      this._processing.delete(sessionId);
      // Process next in queue if any
      if (queue.length > 0) {
        this._processNext(sessionId);
      } else {
        this._queues.delete(sessionId);
      }
    }
  }

  getQueueDepth(sessionId) {
    return this._queues.get(sessionId)?.length || 0;
  }

  shutdown() {
    this._shuttingDown = true;
  }
}
