import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateUrl } from '../src/tools/built-in/http-tools.js';

describe('validateUrl', () => {
  it('allows https URLs', () => {
    assert.doesNotThrow(() => validateUrl('https://example.com'));
  });

  it('allows http URLs', () => {
    assert.doesNotThrow(() => validateUrl('http://example.com'));
  });

  it('blocks file:// protocol', () => {
    assert.throws(() => validateUrl('file:///etc/passwd'), /Blocked protocol/);
  });

  it('blocks ftp:// protocol', () => {
    assert.throws(() => validateUrl('ftp://example.com'), /Blocked protocol/);
  });

  it('blocks javascript: protocol', () => {
    assert.throws(() => validateUrl('javascript:alert(1)'), /Blocked protocol/);
  });

  it('blocks localhost', () => {
    assert.throws(() => validateUrl('http://localhost/admin'), /Blocked host/);
  });

  it('blocks 127.0.0.1', () => {
    assert.throws(() => validateUrl('http://127.0.0.1/admin'), /Blocked host/);
  });

  it('blocks [::1]', () => {
    assert.throws(() => validateUrl('http://[::1]/admin'), /Blocked host/);
  });

  it('blocks 0.0.0.0', () => {
    assert.throws(() => validateUrl('http://0.0.0.0/admin'), /Blocked host/);
  });

  it('blocks cloud metadata endpoint', () => {
    assert.throws(() => validateUrl('http://169.254.169.254/latest/meta-data'), /Blocked host/);
  });

  it('blocks 10.x.x.x private range', () => {
    assert.throws(() => validateUrl('http://10.0.0.1/internal'), /Blocked private IP/);
  });

  it('blocks 172.16-31.x.x private range', () => {
    assert.throws(() => validateUrl('http://172.16.0.1/internal'), /Blocked private IP/);
    assert.throws(() => validateUrl('http://172.31.255.255/internal'), /Blocked private IP/);
  });

  it('allows 172.32.x.x (not private)', () => {
    assert.doesNotThrow(() => validateUrl('http://172.32.0.1'));
  });

  it('blocks 192.168.x.x private range', () => {
    assert.throws(() => validateUrl('http://192.168.1.1/admin'), /Blocked private IP/);
  });

  it('rejects invalid URLs', () => {
    assert.throws(() => validateUrl('not-a-url'), /Invalid URL/);
  });
});
