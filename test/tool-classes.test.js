import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import { registerSystemTools } from '../src/tools/built-in/system-tools.js';
import { registerHttpTools } from '../src/tools/built-in/http-tools.js';
import { registerMemoryTools } from '../src/tools/built-in/memory-tools.js';

describe('ToolRegistry class field (M4)', () => {
  it('register accepts class field', () => {
    const reg = new ToolRegistry();
    reg.register({
      name: 'test_tool',
      description: 'Test',
      class: 'brokered',
      handler: async () => 'ok',
    });

    assert.equal(reg.get('test_tool').class, 'brokered');
  });

  it('register defaults class to runtime', () => {
    const reg = new ToolRegistry();
    reg.register({
      name: 'default_tool',
      description: 'Test',
      handler: async () => 'ok',
    });

    assert.equal(reg.get('default_tool').class, 'runtime');
  });

  it('system tools registered with class: runtime', () => {
    const reg = new ToolRegistry();
    registerSystemTools(reg);

    assert.equal(reg.get('get_current_time').class, 'runtime');
    assert.equal(reg.get('wait').class, 'runtime');
  });

  it('HTTP tools registered with class: brokered', () => {
    const reg = new ToolRegistry();
    registerHttpTools(reg);

    assert.equal(reg.get('http_get').class, 'brokered');
    assert.equal(reg.get('http_post').class, 'brokered');
  });

  it('memory tools registered with class: brokered', () => {
    const reg = new ToolRegistry();
    const fakePersistentMemory = { save: async () => {}, list: async () => [] };
    const fakeMemorySearch = { search: () => [] };
    registerMemoryTools(reg, fakePersistentMemory, fakeMemorySearch);

    assert.equal(reg.get('save_memory').class, 'brokered');
    assert.equal(reg.get('search_memory').class, 'brokered');
    assert.equal(reg.get('list_memories').class, 'brokered');
  });

  it('getSchemas does not include class field in API output', () => {
    const reg = new ToolRegistry();
    reg.register({
      name: 'test',
      description: 'Test',
      class: 'brokered',
      handler: async () => 'ok',
    });

    const schemas = reg.getSchemas();
    assert.equal(schemas.length, 1);
    assert.equal(schemas[0].name, 'test');
    // class is internal metadata, not exposed in API schemas
    assert.equal(schemas[0].class, undefined);
  });
});
