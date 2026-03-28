# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Workflow — spec-driven development

All features and changes follow this sequence:

1. **Spec first** — Write a new spec in `spec/` (next available number, e.g. `11-feature-name.md`) describing the feature: motivation, design, API surface, data model changes, and affected components. Add it to the table in `spec/README.md`.
2. **Implementation plan** — Create a step-by-step plan (can be a section within the spec or a separate document). Get alignment before writing code.
3. **Test Driven Design** - Implement tests first according to the plan and spec.
4. **Implement** — Build according to the plan and spec. Make sure the tests you created previously run smoothly.
5. **Update existing docs** — If the new feature changes behaviour described in other specs, update those specs and `spec/README.md` to stay consistent. Outdated specs that no longer apply should be marked `ARCHIVED` in filename and moved to the Archived table.

Specs in `spec/` are the single source of truth. Code should match specs; when they diverge, update the spec or fix the code — never leave them inconsistent.

The **Use Cases PRD** ([`spec/PRD-Use-Cases.md`](spec/PRD-Use-Cases.md)) is the canonical inventory of all user-facing capabilities, organized by persona and category. When adding a feature, add its use case to the PRD. When writing tests, use the PRD to identify missing E2E coverage.

## Commands

```bash
npm start              # Run the agent
npm run dev            # Run with --watch (auto-restart on changes)
npm test               # Run all tests
node --test test/pipeline-e2e.test.js   # Run a single test file
```

Tests use Node's built-in test runner (`node:test` + `node:assert/strict`). No test framework to install.

## Architecture

See [`spec/ARCHITECTURE.md`](spec/ARCHITECTURE.md) for the full architecture overview, message flow, and subsystem descriptions.

Key source layout: `src/core/` (runtime), `src/brain/` (LLM + context), `src/tools/` (tool system), `src/memory/` (persistence + projects), `src/security/` (pipeline), `src/adapters/` (channels), `src/agents/` (profiles).

The agent supports multiple isolated projects via `ProjectManager` (`src/memory/project-manager.js`). Use `/project <name>` to switch, `/project list` to list, `/project none` to deactivate. The agent can also auto-switch via the `switch_project` tool. See [`spec/31-multi-project.md`](spec/31-multi-project.md).

## Deployment

See [`spec/DEPLOYMENT.md`](spec/DEPLOYMENT.md) for how the agent runs in production: Apple container runtime, `agentcore` CLI commands, launchd boot persistence, and health monitoring.

## Patterns

- ES modules throughout (`"type": "module"` in package.json). Use `import`/`export`, not `require`.
- Abstract base classes with `throw new Error('Not implemented')` for interfaces (`AdapterInterface`, `LLMProvider`, `AgentRunner`).
- Tools are registered via `ToolRegistry.register({ name, description, inputSchema, handler })`. Built-in tools in `src/tools/built-in/`. Schemas follow Anthropic's tool input format.
- EventBus is a standard Node `EventEmitter` subclass. Key events: `message:inbound`, `message:outbound`, `stream:event`, `error`.
- Wiring happens in `src/index.js` — all components are constructed and connected there in numbered phases.
