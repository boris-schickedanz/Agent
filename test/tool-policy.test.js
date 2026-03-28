import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ToolPolicy } from '../src/security/tool-policy.js';

describe('ToolPolicy (single-user — all tools available)', () => {
  it('isAllowed() always returns true for any tool', () => {
    const tp = new ToolPolicy();
    for (const tool of ['run_command', 'write_file', 'read_file', 'http_post',
      'kill_process', 'delegate_task', 'get_current_time', 'unknown_tool']) {
      assert.equal(tp.isAllowed(tool), true,
        `isAllowed should return true for ${tool}`);
    }
  });

  it('getEffectiveToolNames() always returns null (all tools)', () => {
    const tp = new ToolPolicy();
    assert.equal(tp.getEffectiveToolNames(), null);
  });

  it('constructor works without arguments', () => {
    const tp = new ToolPolicy();
    assert.ok(tp);
    assert.equal(tp.isAllowed('anything'), true);
    assert.equal(tp.getEffectiveToolNames(), null);
  });
});
