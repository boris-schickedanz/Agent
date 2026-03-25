/**
 * Per-session serial message queue.
 * Different sessions process in parallel, but messages within a session are serialized.
 */
export class MessageQueue {
  constructor(runner, logger) {
    this.runner = runner;
    this.logger = logger;
    this._queues = new Map();
    this._processing = new Set();
    this._shuttingDown = false;
  }

  async enqueue(sessionId, executionRequest, onStreamEvent) {
    if (this._shuttingDown) {
      this.logger.warn({ sessionId }, 'Message rejected: shutting down');
      return null;
    }

    return new Promise((resolve, reject) => {
      if (!this._queues.has(sessionId)) {
        this._queues.set(sessionId, []);
      }
      this._queues.get(sessionId).push({ executionRequest, onStreamEvent, resolve, reject });
      this._processNext(sessionId);
    });
  }

  async _processNext(sessionId) {
    if (this._processing.has(sessionId)) return;

    const queue = this._queues.get(sessionId);
    if (!queue || queue.length === 0) return;

    this._processing.add(sessionId);
    const { executionRequest, onStreamEvent, resolve, reject } = queue.shift();

    try {
      const result = await this.runner.execute(executionRequest, onStreamEvent);
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
