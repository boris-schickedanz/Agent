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

  it('group chat sessionId includes group marker and chatId', () => {
    const msg = makeTelegramMsg({ chatId: -200, chatType: 'group', userId: 100 });
    const norm = normalizeMessage(msg);
    assert.equal(norm.sessionId, 'telegram:group:-200');
    assert.equal(norm.userId, '100');
  });

  it('supergroup chat sessionId includes group marker', () => {
    const msg = makeTelegramMsg({ chatId: -300, chatType: 'supergroup', userId: 100 });
    const norm = normalizeMessage(msg);
    assert.equal(norm.sessionId, 'telegram:group:-300');
  });
});

describe('Telegram normalizeCallbackQuery', () => {
  it('private callback uses non-group sessionId', () => {
    const query = {
      id: '1',
      from: { id: 100, first_name: 'Test' },
      message: { chat: { id: 100, type: 'private' }, message_id: 1 },
      data: 'btn1',
    };
    const norm = normalizeCallbackQuery(query);
    assert.equal(norm.sessionId, 'telegram:100');
  });

  it('group callback uses group sessionId matching normalizeMessage', () => {
    const query = {
      id: '2',
      from: { id: 100, first_name: 'Test' },
      message: { chat: { id: -200, type: 'group' }, message_id: 2 },
      data: 'btn2',
    };
    const norm = normalizeCallbackQuery(query);
    assert.equal(norm.sessionId, 'telegram:group:-200');
  });
});

describe('SessionManager', () => {
  let db, sm;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, channel_id TEXT NOT NULL, metadata TEXT, created_at INTEGER DEFAULT (unixepoch()), updated_at INTEGER DEFAULT (unixepoch()));
      CREATE TABLE user_aliases (adapter_user_id TEXT NOT NULL, channel_id TEXT NOT NULL, canonical_id TEXT NOT NULL, PRIMARY KEY (adapter_user_id, channel_id));
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

  it('resolveCanonicalUserId falls back to channelId:userId without alias', () => {
    const canonical = sm.resolveCanonicalUserId('12345', 'telegram');
    assert.equal(canonical, 'telegram:12345');
  });

  it('resolveCanonicalUserId returns canonical_id when alias exists', () => {
    db.prepare('INSERT INTO user_aliases VALUES (?, ?, ?)').run('12345', 'telegram', 'alice');
    const canonical = sm.resolveCanonicalUserId('12345', 'telegram');
    assert.equal(canonical, 'alice');
  });

  it('resolveSessionId returns user-scoped session for individual messages', () => {
    const msg = { sessionId: 'telegram:100', userId: '100', channelId: 'telegram' };
    const sid = sm.resolveSessionId(msg);
    assert.equal(sid, 'user:telegram:100');
  });

  it('resolveSessionId returns group-scoped session for group messages', () => {
    const msg = { sessionId: 'telegram:group:-200', userId: '100', channelId: 'telegram' };
    const sid = sm.resolveSessionId(msg);
    assert.equal(sid, 'group:telegram:-200');
  });

  it('cross-adapter continuity: same canonical user gets same sessionId', () => {
    db.prepare('INSERT INTO user_aliases VALUES (?, ?, ?)').run('12345', 'telegram', 'alice');
    db.prepare('INSERT INTO user_aliases VALUES (?, ?, ?)').run('console-user', 'console', 'alice');

    const telegramMsg = { sessionId: 'telegram:12345', userId: '12345', channelId: 'telegram' };
    const consoleMsg = { sessionId: 'console:console-user', userId: 'console-user', channelId: 'console' };

    assert.equal(sm.resolveSessionId(telegramMsg), 'user:alice');
    assert.equal(sm.resolveSessionId(consoleMsg), 'user:alice');
  });

  it('getOrCreate uses provided sessionId as key', () => {
    const session = sm.getOrCreate('user:alice', 'u1', 'telegram', 'Alice');
    assert.equal(session.id, 'user:alice');
    assert.equal(session.userId, 'u1');
  });
});
