import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMessage, normalizeCallbackQuery } from '../src/adapters/telegram/telegram-normalize.js';
import { SessionManager } from '../src/core/session-manager.js';
import Database from 'better-sqlite3';

function makeTelegramMsg({ chatId, chatType, userId, text = 'hello' }) {
  return {
    message_id: 1,
    chat: { id: chatId, type: chatType },
    from: { id: userId, first_name: 'Test' },
    text,
    date: Math.floor(Date.now() / 1000),
  };
}

describe('Telegram normalizeMessage', () => {
  it('private chat sessionId uses chatId', () => {
    const msg = makeTelegramMsg({ chatId: 100, chatType: 'private', userId: 100 });
    const norm = normalizeMessage(msg);
    assert.equal(norm.sessionId, 'telegram:100');
    assert.equal(norm.userId, '100');
  });

  it('group chat sessionId uses chatId without group marker', () => {
    const msg = makeTelegramMsg({ chatId: -200, chatType: 'group', userId: 100 });
    const norm = normalizeMessage(msg);
    assert.equal(norm.sessionId, 'telegram:-200');
    assert.equal(norm.userId, '100');
  });

  it('supergroup chat sessionId uses chatId without group marker', () => {
    const msg = makeTelegramMsg({ chatId: -300, chatType: 'supergroup', userId: 100 });
    const norm = normalizeMessage(msg);
    assert.equal(norm.sessionId, 'telegram:-300');
  });
});

describe('Telegram normalizeCallbackQuery', () => {
  it('private callback sessionId uses chatId', () => {
    const query = {
      id: '1',
      from: { id: 100, first_name: 'Test' },
      message: { chat: { id: 100, type: 'private' }, message_id: 1 },
      data: 'btn1',
    };
    const norm = normalizeCallbackQuery(query);
    assert.equal(norm.sessionId, 'telegram:100');
  });

  it('group callback sessionId uses chatId', () => {
    const query = {
      id: '2',
      from: { id: 100, first_name: 'Test' },
      message: { chat: { id: -200, type: 'group' }, message_id: 2 },
      data: 'btn2',
    };
    const norm = normalizeCallbackQuery(query);
    assert.equal(norm.sessionId, 'telegram:-200');
  });
});

describe('SessionManager', () => {
  let db, sm;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, channel_id TEXT NOT NULL, metadata TEXT, created_at INTEGER DEFAULT (unixepoch()), updated_at INTEGER DEFAULT (unixepoch()));
    `);
    const wrappedDb = {
      prepare: (sql) => db.prepare(sql),
      exec: (sql) => db.exec(sql),
    };
    const fakeMemory = {
      getHistory: () => [],
      append: () => {},
      appendMany: () => {},
    };
    sm = new SessionManager(wrappedDb, fakeMemory);
  });

  it('resolveSessionId returns unified session ID for all messages', () => {
    const msg = { sessionId: 'telegram:100', userId: '100', channelId: 'telegram' };
    const sid = sm.resolveSessionId(msg);
    assert.equal(sid, 'user:default');
  });

  it('same user from different adapters gets the same session ID', () => {
    const telegramMsg = { sessionId: 'telegram:100', userId: '100', channelId: 'telegram' };
    const consoleMsg = { sessionId: 'console:user', userId: 'user', channelId: 'console' };

    assert.equal(sm.resolveSessionId(telegramMsg), 'user:default');
    assert.equal(sm.resolveSessionId(consoleMsg), 'user:default');
  });

  it('getOrCreate uses provided sessionId as key', () => {
    const session = sm.getOrCreate('user:default', 'u1', 'telegram', 'Alice');
    assert.equal(session.id, 'user:default');
    assert.equal(session.userId, 'u1');
  });

  it('getOrCreate returns cached session on second call', () => {
    const s1 = sm.getOrCreate('user:default', 'u1', 'telegram', 'Alice');
    const s2 = sm.getOrCreate('user:default', 'u1', 'telegram', 'Alice');
    assert.equal(s1, s2);
  });

  it('messages from Console and Telegram share same session via resolveSessionId', () => {
    const telegramSid = sm.resolveSessionId({ userId: '100', channelId: 'telegram' });
    const consoleSid = sm.resolveSessionId({ userId: 'console-user', channelId: 'console' });
    assert.equal(telegramSid, consoleSid, 'All adapters must share a single session ID');

    const session = sm.getOrCreate(telegramSid, '100', 'telegram', 'TelegramUser');
    const session2 = sm.getOrCreate(consoleSid, 'console-user', 'console', 'ConsoleUser');
    assert.equal(session, session2, 'getOrCreate returns the same cached session object');
  });
});
