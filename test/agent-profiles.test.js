import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { resolve, join } from 'path';
import { AgentProfile } from '../src/agents/agent-profile.js';
import { AgentRegistry } from '../src/agents/agent-registry.js';

const TEST_DIR = resolve('.test-agents-' + process.pid);
const AGENTS_DIR = join(TEST_DIR, 'agents');

describe('AgentProfile', () => {
  beforeEach(() => {
    mkdirSync(join(AGENTS_DIR, 'code-reviewer'), { recursive: true });
    writeFileSync(join(AGENTS_DIR, 'code-reviewer', 'AGENT.md'), `---
name: code-reviewer
description: Expert code reviewer focused on quality
model: claude-sonnet-4-20250514
tools: [read_file, grep_search, list_directory]
memory_namespace: code-reviewer
---

You are a senior code reviewer. Focus on quality and security.
`);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('loads profile from file', () => {
    const profile = AgentProfile.fromFile(join(AGENTS_DIR, 'code-reviewer', 'AGENT.md'));
    assert.equal(profile.name, 'code-reviewer');
    assert.equal(profile.description, 'Expert code reviewer focused on quality');
    assert.equal(profile.model, 'claude-sonnet-4-20250514');
    assert.deepEqual(profile.tools, ['read_file', 'grep_search', 'list_directory']);
    assert.equal(profile.memoryNamespace, 'code-reviewer');
    assert.ok(profile.soul.includes('senior code reviewer'));
  });
});

describe('AgentRegistry', () => {
  beforeEach(() => {
    mkdirSync(join(AGENTS_DIR, 'reviewer'), { recursive: true });
    mkdirSync(join(AGENTS_DIR, 'backend-dev'), { recursive: true });
    mkdirSync(join(AGENTS_DIR, 'empty-dir'), { recursive: true });

    writeFileSync(join(AGENTS_DIR, 'reviewer', 'AGENT.md'), `---
name: reviewer
description: Code reviewer
---

Review code carefully.
`);

    writeFileSync(join(AGENTS_DIR, 'backend-dev', 'AGENT.md'), `---
name: backend-dev
description: Backend developer
tools: [read_file, write_file, run_command]
---

You are a backend developer.
`);
    // empty-dir has no AGENT.md — should be skipped
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('loads all profiles from directory', () => {
    const registry = new AgentRegistry({ agentsDir: AGENTS_DIR, logger: null });
    registry.loadAll();

    assert.equal(registry.list().length, 2);
  });

  it('gets profile by name', () => {
    const registry = new AgentRegistry({ agentsDir: AGENTS_DIR, logger: null });
    registry.loadAll();

    const reviewer = registry.get('reviewer');
    assert.ok(reviewer);
    assert.equal(reviewer.name, 'reviewer');

    const backendDev = registry.get('backend-dev');
    assert.ok(backendDev);
    assert.deepEqual(backendDev.tools, ['read_file', 'write_file', 'run_command']);
  });

  it('returns null for unknown profile', () => {
    const registry = new AgentRegistry({ agentsDir: AGENTS_DIR, logger: null });
    registry.loadAll();

    assert.equal(registry.get('nonexistent'), null);
  });

  it('getDefault returns null (uses SOUL.md)', () => {
    const registry = new AgentRegistry({ agentsDir: AGENTS_DIR, logger: null });
    registry.loadAll();

    assert.equal(registry.getDefault(), null);
  });

  it('handles missing agents directory gracefully', () => {
    const registry = new AgentRegistry({ agentsDir: join(TEST_DIR, 'nonexistent'), logger: null });
    registry.loadAll();

    assert.equal(registry.list().length, 0);
  });
});
