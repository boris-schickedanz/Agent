import { createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const SALT = 'agent-core-key-store-v1';

export class ApiKeyStore {
  constructor(db, config) {
    this.db = db;
    this._derivedKey = this._deriveKey(config.masterKey || config.anthropicApiKey);

    this._stmts = {
      upsert: db.prepare(`
        INSERT INTO api_keys (service, encrypted_key, iv, auth_tag)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(service) DO UPDATE SET
          encrypted_key = excluded.encrypted_key,
          iv = excluded.iv,
          auth_tag = excluded.auth_tag
      `),
      get: db.prepare('SELECT encrypted_key, iv, auth_tag FROM api_keys WHERE service = ?'),
      delete: db.prepare('DELETE FROM api_keys WHERE service = ?'),
      list: db.prepare('SELECT service FROM api_keys'),
    };
  }

  _deriveKey(secret) {
    if (!secret) return randomBytes(KEY_LENGTH);
    return pbkdf2Sync(secret, SALT, 100_000, KEY_LENGTH, 'sha256');
  }

  store(service, apiKey) {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this._derivedKey, iv);
    const encrypted = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    this._stmts.upsert.run(service, encrypted, iv, authTag);
  }

  retrieve(service) {
    const row = this._stmts.get.get(service);
    if (!row) return null;

    const decipher = createDecipheriv(ALGORITHM, this._derivedKey, row.iv);
    decipher.setAuthTag(row.auth_tag);
    const decrypted = Buffer.concat([decipher.update(row.encrypted_key), decipher.final()]);
    return decrypted.toString('utf8');
  }

  delete(service) {
    this._stmts.delete.run(service);
  }

  list() {
    return this._stmts.list.all().map(r => r.service);
  }
}
