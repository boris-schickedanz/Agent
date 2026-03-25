import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { Sandbox, SandboxViolationError } from '../src/security/sandbox.js';

const TEST_DIR = resolve('.test-sandbox-' + process.pid);
const WORKSPACE = join(TEST_DIR, 'workspace');

describe('Sandbox', () => {
  beforeEach(() => {
    mkdirSync(join(WORKSPACE, 'subdir'), { recursive: true });
    mkdirSync(join(WORKSPACE, 'readonly'), { recursive: true });
    writeFileSync(join(WORKSPACE, 'file.txt'), 'hello');
    writeFileSync(join(WORKSPACE, 'subdir', 'nested.txt'), 'nested');
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('resolves relative paths within workspace', () => {
    const sandbox = new Sandbox({ workspaceDir: WORKSPACE });
    const resolved = sandbox.resolve('file.txt');
    assert.equal(resolved, join(WORKSPACE, 'file.txt'));
  });

  it('resolves nested relative paths', () => {
    const sandbox = new Sandbox({ workspaceDir: WORKSPACE });
    const resolved = sandbox.resolve('subdir/nested.txt');
    assert.equal(resolved, join(WORKSPACE, 'subdir', 'nested.txt'));
  });

  it('blocks path traversal with ../', () => {
    const sandbox = new Sandbox({ workspaceDir: WORKSPACE });
    assert.throws(() => sandbox.resolve('../../../etc/passwd'), SandboxViolationError);
  });

  it('blocks path traversal with resolved ../', () => {
    const sandbox = new Sandbox({ workspaceDir: WORKSPACE });
    assert.throws(() => sandbox.resolve('subdir/../../..'), SandboxViolationError);
  });

  it('blocks UNC paths', () => {
    const sandbox = new Sandbox({ workspaceDir: WORKSPACE });
    assert.throws(() => sandbox.resolve('\\\\server\\share'), SandboxViolationError);
  });

  it('strips null bytes', () => {
    const sandbox = new Sandbox({ workspaceDir: WORKSPACE });
    const resolved = sandbox.resolve('file\x00.txt');
    assert.equal(resolved, join(WORKSPACE, 'file.txt'));
  });

  it('blocks symlink escapes', () => {
    const linkPath = join(WORKSPACE, 'escape-link');
    try {
      symlinkSync(resolve('/'), linkPath);
    } catch {
      // Symlink creation may require elevated privileges on Windows
      return;
    }
    const sandbox = new Sandbox({ workspaceDir: WORKSPACE });
    assert.throws(() => sandbox.resolve('escape-link'), SandboxViolationError);
  });

  it('isAllowed returns true for valid paths', () => {
    const sandbox = new Sandbox({ workspaceDir: WORKSPACE });
    assert.equal(sandbox.isAllowed('file.txt'), true);
  });

  it('isAllowed returns false for escaping paths', () => {
    const sandbox = new Sandbox({ workspaceDir: WORKSPACE });
    assert.equal(sandbox.isAllowed('../../etc/passwd'), false);
  });

  it('assertReadable returns resolved path', () => {
    const sandbox = new Sandbox({ workspaceDir: WORKSPACE });
    const resolved = sandbox.assertReadable('file.txt');
    assert.equal(resolved, join(WORKSPACE, 'file.txt'));
  });

  it('assertWritable allows writable paths', () => {
    const sandbox = new Sandbox({ workspaceDir: WORKSPACE });
    const resolved = sandbox.assertWritable('file.txt');
    assert.equal(resolved, join(WORKSPACE, 'file.txt'));
  });

  it('assertWritable blocks read-only zones', () => {
    const sandbox = new Sandbox({
      workspaceDir: WORKSPACE,
      readOnlyDirs: ['readonly'],
    });
    assert.throws(
      () => sandbox.assertWritable('readonly/test.txt'),
      SandboxViolationError
    );
  });

  it('assertReadable allows read-only zones', () => {
    const sandbox = new Sandbox({
      workspaceDir: WORKSPACE,
      readOnlyDirs: ['readonly'],
    });
    const resolved = sandbox.assertReadable('readonly/test.txt');
    assert.ok(resolved);
  });

  it('resolves workspace root itself', () => {
    const sandbox = new Sandbox({ workspaceDir: WORKSPACE });
    const resolved = sandbox.resolve('.');
    assert.equal(resolved, WORKSPACE);
  });

  it('allows non-existent files within workspace', () => {
    const sandbox = new Sandbox({ workspaceDir: WORKSPACE });
    const resolved = sandbox.resolve('newfile.txt');
    assert.equal(resolved, join(WORKSPACE, 'newfile.txt'));
  });
});
