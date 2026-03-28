# Spec 06 — Adapter System

> Status: **Implemented** | Owner: — | Last updated: 2026-03-25

## 1. Purpose

Adapters connect AgentCore to external messaging platforms. Each adapter normalizes platform-specific messages into a universal format and converts agent responses back to platform-native format.

## 2. Adapter Interface

**File:** `src/adapters/adapter-interface.js`
**Class:** `AdapterInterface` (abstract base)

All adapters MUST extend this class and implement every method.

```js
class AdapterInterface {
  get channelId(): string          // Unique identifier (e.g., 'telegram', 'console')
  async start(): void              // Begin listening for messages
  async stop(): void               // Graceful shutdown
  normalizeInbound(raw): NormalizedMessage
  formatOutbound(agentMessage): PlatformMessage
  async sendMessage(sessionId, message): void
}
```

## 3. Normalized Message Format (Universal Contract)

All adapters MUST normalize inbound messages to this exact shape:

```js
{
  id: string,              // Platform message ID
  sessionId: string,       // Computed: "{channelId}:{userId}" or "{channelId}:group:{groupId}"
  channelId: string,       // Adapter's channelId
  userId: string,          // Platform user ID (string)
  userName: string,        // Display name
  content: string,         // Text content
  attachments: Attachment[], // Media attachments (may be empty)
  replyTo: string | null,  // Parent message ID for threading
  timestamp: number,       // Unix milliseconds
  raw: object              // Original platform payload (for debugging)
}
```

**Attachment shape:**

```js
{
  type: 'photo' | 'document' | 'voice' | 'video',
  fileId: string,          // Platform-specific file identifier
  mimeType?: string,
  fileName?: string,
  size?: number,           // Bytes
  duration?: number        // Seconds (for voice/video)
}
```

## 4. Outbound Message Format

Agent responses emitted on `message:outbound` by `HostDispatcher.finalize()`:

```js
{
  sessionId: string,       // Original adapter sessionId (for routing back)
  channelId: string,
  userId: string,
  content: string,         // Markdown text (after guardrail filtering)
  replyTo: string | null,
  metadata: {
    toolsUsed: string[],
    tokenUsage: { inputTokens, outputTokens },
    processingTimeMs: number
  }
}
```

**Note:** The `sessionId` in outbound messages is the original adapter session ID (e.g., `telegram:12345`), not the canonical session ID used internally. This ensures the adapter can route the response back to the correct chat.

## 5. Adapter Registry

**File:** `src/adapters/adapter-registry.js`
**Class:** `AdapterRegistry`

**Interface:**

```js
register(adapter: AdapterInterface): void
get(channelId: string): AdapterInterface | null
getAll(): AdapterInterface[]
async startAll(): void
async stopAll(): void
```

**Wiring:** On `register()`, the registry subscribes to `message:outbound` events. When an outbound message's `channelId` matches the adapter, it calls `adapter.formatOutbound()` then `adapter.sendMessage()`.

## 6. Console Adapter

**File:** `src/adapters/console/console-adapter.js`
**Class:** `ConsoleAdapter extends AdapterInterface`

| Property | Value |
|----------|-------|
| `channelId` | `'console'` |
| User ID | `'console-user'` (hardcoded) |
| Session ID | `'console:console-user'` |

**Behavior:**
- Uses Node.js `readline` to read lines from stdin.
- Empty lines are ignored.
- Each non-empty line emits a `message:inbound` event.
- Outbound messages are printed to stdout.
- `Ctrl+C` triggers `rl.close()` → `process.exit(0)`.

## 7. Telegram Adapter

### 7.1 Adapter

**File:** `src/adapters/telegram/telegram-adapter.js`
**Class:** `TelegramAdapter extends AdapterInterface`

| Property | Value |
|----------|-------|
| `channelId` | `'telegram'` |
| Library | `node-telegram-bot-api` |
| Mode | Polling (development). Webhook support is a future extension. |

**Activation:** Only loaded if `config.telegramBotToken` is set. Loaded via dynamic `import()` in `src/index.js`.

**Inbound events handled:**
- `message` — text messages and captions
- `callback_query` — inline keyboard button presses

**Outbound:** Delegates to `TelegramSender`.

### 7.2 Message Normalization

**File:** `src/adapters/telegram/telegram-normalize.js`

**Exports:**

```js
normalizeMessage(msg: TelegramMessage): NormalizedMessage
normalizeCallbackQuery(query: TelegramCallbackQuery): NormalizedMessage
extractAttachments(msg: TelegramMessage): Attachment[]
```

**Session ID computation:**
- Private chat: `telegram:{chat.id}`

**User name:** `msg.from.first_name` + `msg.from.last_name` (space-joined, fallback `'Unknown'`).

**Attachments extracted:** photo (highest resolution), document, voice, video.

### 7.3 Message Sending

**File:** `src/adapters/telegram/telegram-sender.js`
**Class:** `TelegramSender`

**Interface:**

```js
async send(chatId: string, text: string, options?: { replyToMessageId?: number }): void
splitLongMessage(text: string, maxLength?: number): string[]
```

**Behavior:**
- Sends with `parse_mode: 'Markdown'`.
- If Markdown parsing fails (Telegram API error), retries as plain text.
- Long messages (>4096 chars) are split at paragraph boundaries (`\n\n`), then newlines (`\n`), then spaces, then hard-split.
- Only the first chunk includes `reply_to_message_id`.

**Chat ID extraction:** The adapter extracts the chat ID from the session ID by taking the last segment after splitting on `:`.

## 8. Adding a New Adapter

1. Create `src/adapters/<name>/` directory.
2. Create `<name>-adapter.js` extending `AdapterInterface`.
3. Implement all required methods:
   - `get channelId` — return a unique string
   - `normalizeInbound(raw)` — convert to the normalized message format
   - `formatOutbound(agentMessage)` — convert to platform format
   - `sendMessage(sessionId, message)` — send via platform API
   - `start()` — begin listening
   - `stop()` — clean up
4. Register in `src/index.js`, gated on a config variable.
5. Update this spec with the adapter's details.

## 9. Design Decisions

| Decision | Rationale |
|----------|-----------|
| Abstract interface over duck typing | Enforces the contract. Missing methods throw immediately, not at runtime when a message arrives. |
| Normalized message format | Decouples the entire agent core from any specific platform. Core code never sees Telegram objects. |
| `raw` field preserved | Useful for debugging and for adapters that need platform-specific features. |
| Polling over webhooks for Telegram | Simpler setup, no SSL/domain required. Webhook support can be added later. |
| Markdown parse fallback | Telegram's Markdown parser is strict. Falling back to plain text ensures delivery. |
