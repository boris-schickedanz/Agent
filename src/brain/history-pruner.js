/**
 * Trims oversized tool results in conversation history to reclaim context space.
 * Operates in-memory only — does not modify the database.
 */
export class HistoryPruner {
  constructor(config) {
    this.threshold = config.pruneThreshold ?? 4000;
    this.head = config.pruneHead ?? 1500;
    this.tail = config.pruneTail ?? 1500;
  }

  /**
   * Returns a new message array with large tool results trimmed.
   * Does not mutate the input.
   */
  prune(messages) {
    const result = [];
    let changed = false;
    for (const msg of messages) {
      const pruned = this._pruneMessage(msg);
      if (pruned !== msg) changed = true;
      result.push(pruned);
    }
    return changed ? result : messages;
  }

  _pruneMessage(msg) {
    if (!Array.isArray(msg.content)) return msg;

    let changed = false;
    const prunedContent = msg.content.map(block => {
      if (block.type !== 'tool_result') return block;

      const text = typeof block.content === 'string'
        ? block.content
        : JSON.stringify(block.content);

      if (text.length <= this.threshold) return block;

      changed = true;
      const pruned = text.length - this.head - this.tail;
      const trimmed = text.slice(0, this.head)
        + `\n...[pruned ${pruned} chars]...\n`
        + text.slice(-this.tail);

      return { ...block, content: trimmed };
    });

    return changed ? { ...msg, content: prunedContent } : msg;
  }
}
