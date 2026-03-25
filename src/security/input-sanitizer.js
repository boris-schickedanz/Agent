const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /you\s+are\s+now\s+/i,
  /system\s*:\s*/i,
  /\bdo\s+not\s+follow\b.*\brules\b/i,
  /\boverride\b.*\bsystem\b/i,
  /\bpretend\b.*\byou\s+are\b/i,
  /\bjailbreak\b/i,
  /\bDAN\s+mode\b/i,
];

const MAX_MESSAGE_LENGTH = 10_000;

export class InputSanitizer {
  /**
   * Sanitize an inbound normalized message. Returns a new message object.
   */
  sanitize(message) {
    let content = message.content || '';

    // Strip zero-width characters and Unicode control chars (keep newlines, tabs)
    content = content.replace(/[\u200B-\u200F\u2028-\u202F\uFEFF\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

    // Truncate excessively long messages
    if (content.length > MAX_MESSAGE_LENGTH) {
      content = content.substring(0, MAX_MESSAGE_LENGTH) + '\n...[truncated]';
    }

    return {
      ...message,
      content,
      _sanitized: true,
    };
  }

  /**
   * Detect potential prompt injection patterns. Returns analysis object for logging.
   * This is a soft detection — messages are not blocked, only flagged.
   */
  detectInjection(content) {
    const matches = [];
    for (const pattern of INJECTION_PATTERNS) {
      if (pattern.test(content)) {
        matches.push(pattern.source);
      }
    }
    return {
      suspicious: matches.length > 0,
      patterns: matches,
    };
  }
}
