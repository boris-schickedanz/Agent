# Spec 28 — Lean System Prompt & Dynamic Tool Resolution

> Status: **Draft** | Owner: — | Last updated: 2026-03-28

## 1. Purpose

All tool schemas (name + description + full inputSchema) are sent to the LLM on every request, regardless of whether the user's message needs them. As the tool count grows, this wastes context tokens and reduces the effective window for conversation history. Additionally, meta-queries ("what can you do?", "what tools are available?") are answered from information baked into `SOUL.md`, adding to every system prompt even though these questions arise infrequently.

This spec introduces **two-tier tool resolution**: a small set of core tools get full schemas on every request; all other tools are listed as one-line summaries in the system prompt. The LLM calls a `get_tool_details` meta-tool to fetch full schemas on demand. A `get_agent_info` meta-tool handles identity and capability questions, replacing static content in `SOUL.md`.

**Design basis:** Anthropic's `defer_loading` pattern (85% context reduction), Spring AI's dynamic tool discovery (34–64% token savings verified across providers including Ollama), and the "active subset" research pattern (3–5 tools per query).

## 2. Design

### 2.1 Tool Resolution Modes

| Mode | Behavior | Default For |
|------|----------|-------------|
| `dynamic` | Core tools get full schemas; deferred tools get one-line summaries in system prompt. LLM calls `get_tool_details` before using a deferred tool. | Both providers |
| `full` | All tools get full schemas (current behavior). No deferred tools, no summaries in prompt. Backward-compatible fallback. | — |

**Configuration:**

| Variable | Config Key | Type | Default | Description |
|----------|-----------|------|---------|-------------|
| `TOOL_RESOLUTION_MODE` | `toolResolutionMode` | string | `'dynamic'` | `dynamic` or `full` |
| `CORE_TOOLS` | `coreTools` | string[] | `'save_memory,search_memory,get_tool_details,get_agent_info'` | Comma-separated tool names that always get full schemas |

### 2.2 Core Tools (Always Full Schema)

The default core set (4 tools):

| Tool | Rationale |
|------|-----------|
| `save_memory` | Cross-session context; used implicitly by memory flush |
| `search_memory` | Cross-session context retrieval |
| `get_tool_details` | Meta-tool for resolving deferred tool schemas |
| `get_agent_info` | Meta-tool for identity/capability queries |

All other registered tools (currently 14+) are deferred.

The core set is overridable via `CORE_TOOLS` env var. The `get_tool_details` and `get_agent_info` tools are always included in the core set regardless of the override (they are required for dynamic mode to function).

### 2.3 ToolResolver

**New file:** `src/tools/tool-resolver.js`
**Class:** `ToolResolver`

Splits the effective tool set into core (full schema) and deferred (summary only).

**Interface:**

```js
class ToolResolver {
  constructor(toolRegistry, config)

  resolve(effectiveToolNames: Set<string> | null): {
    coreSchemas: AnthropicToolSchema[],      // Full schemas for core tools
    deferredSummaries: { name, description }[] // Name + description only
  }
}
```

**Behavior:**
- In `full` mode: returns all tools as `coreSchemas`, empty `deferredSummaries`
- In `dynamic` mode: splits tools based on `coreToolNames` set
- `effectiveToolNames` filtering (from tool policy) is applied before the split
- Meta-tools (`get_tool_details`, `get_agent_info`) are always included in `coreSchemas` in dynamic mode, even if not in `effectiveToolNames`

### 2.4 Meta-Tools

**New file:** `src/tools/built-in/meta-tools.js`
**Registration:** `registerMetaTools(registry, toolRegistry, skillLoader, config)`

#### 2.4.1 `get_tool_details`

Returns full parameter schemas for one or more tools. The LLM calls this before using any deferred tool.

| Property | Value |
|----------|-------|
| Name | `get_tool_details` |
| Class | `runtime` |
| Description | `Get full parameter schemas for tools before using them. Call this first when you need a tool not in your function definitions.` |
| Permissions | None |
| Timeout | 5,000ms |

**Input schema:**

```json
{
  "type": "object",
  "properties": {
    "tools": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Tool name(s) to look up"
    }
  },
  "required": ["tools"]
}
```

**Handler behavior:**
1. For each requested tool name, call `toolRegistry.getSchema(name)`.
2. Return a JSON-formatted string with `{ name, description, parameters }` for each found tool.
3. For unknown tool names, include `{ name, error: "Unknown tool" }`.

**Output example:**

```json
[
  {
    "name": "grep_search",
    "description": "Search file contents for a text pattern.",
    "parameters": {
      "type": "object",
      "properties": {
        "pattern": { "type": "string", "description": "Search string or regex pattern" },
        "path": { "type": "string", "description": "File or directory to search" },
        "glob": { "type": "string", "description": "Glob filter for files" },
        "max_results": { "type": "integer", "minimum": 1, "maximum": 50, "description": "Max matches" }
      },
      "required": ["pattern"]
    }
  }
]
```

#### 2.4.2 `get_agent_info`

Returns identity, capabilities, full tool catalog, and loaded skills. The LLM calls this when the user asks "who are you?", "what can you do?", "what tools are available?", etc.

| Property | Value |
|----------|-------|
| Name | `get_agent_info` |
| Class | `runtime` |
| Description | `Get information about this agent: identity, capabilities, available tools and commands. Use when user asks who you are or what you can do.` |
| Permissions | None |
| Timeout | 5,000ms |

**Input schema:**

```json
{
  "type": "object",
  "properties": {}
}
```

**Handler behavior:**
1. Read `AGENT_INFO.md` from project root (cached after first read, like `SOUL.md`). Falls back to hardcoded capabilities text if file missing.
2. Append a "## Available Tools" section listing all registered tools with name and description.
3. Append a "## Loaded Skills" section listing all loaded skill names and triggers (if `skillLoader` is available).
4. Return the combined string.

### 2.5 AGENT_INFO.md

**New file:** project root, alongside `SOUL.md`.

Contains the capabilities text previously in `SOUL.md`'s "What You're Good At" section, plus any additional reference content the `get_agent_info` tool should surface:

```markdown
## Capabilities

- Writing, reviewing, and explaining code across languages
- Running shell commands, navigating filesystems, editing files
- Executing multi-step tasks with tools in a ReAct loop
- Remembering context across conversations via memory tools
- Breaking down complex requests into clear steps
```

This file is read-once and cached (same pattern as `SOUL.md` caching in `PromptBuilder`).

### 2.6 ToolRegistry Changes

**File:** `src/tools/tool-registry.js`

Two new methods:

```js
/**
 * Return tool summaries (name + description only, no inputSchema).
 * Used by ToolResolver for deferred tool listings.
 */
getSummaries(filterNames: Set<string> | null): { name: string, description: string }[]

/**
 * Return full schema for a single tool in Anthropic API format.
 * Used by get_tool_details handler.
 * Returns null if tool not found.
 */
getSchema(name: string): { name: string, description: string, input_schema: JSONSchema } | null
```

### 2.7 PromptBuilder Changes

**File:** `src/brain/prompt-builder.js`

The `build()` signature gains a `deferredToolSummaries` parameter:

```js
async build(
  session: Session,
  availableTools: ToolSchema[],
  skillInstructions?: string,
  memorySnippets?: MemorySnippet[],
  deferredToolSummaries?: { name, description }[]
): Promise<string>
```

When `deferredToolSummaries` is non-empty, a new section is appended to the system prompt after skill instructions:

```
## Available Tools (call get_tool_details before using)
- **read_file**: Read the contents of a file, optionally with offset/limit
- **grep_search**: Search file contents for a text pattern
- **run_command**: Execute a shell command and return output
...
```

### 2.8 SOUL.md Changes

Remove the "What You're Good At" section (moved to `AGENT_INFO.md` and served via `get_agent_info`). The remaining sections are kept:

- Identity paragraph (first line)
- Personality and Tone
- Handling Uncertainty
- Handling Tool Failures
- Response Style
- Language

### 2.9 ExecutionRequest Changes

**File:** `src/core/runner/execution-request.js`

Add `deferredToolSummaries` field:

```js
{
  // ... existing fields ...
  deferredToolSummaries: { name: string, description: string }[],  // Default: []
}
```

### 2.10 Pipeline Changes

The data flows through the existing pipeline with these modifications:

1. **HostDispatcher.buildRequest()** — uses `ToolResolver.resolve()` instead of `ToolRegistry.getSchemas()`. Passes `coreSchemas` as `toolSchemas` and `deferredSummaries` as `deferredToolSummaries` in the `ExecutionRequest`.

2. **LocalRunner.execute()** — passes `request.deferredToolSummaries` through to `AgentLoop.processMessage()` as a new `deferredToolSummaries` param.

3. **AgentLoop.processMessage()** — accepts `deferredToolSummaries` param, passes it to `PromptBuilder.build()`.

4. **PromptBuilder.build()** — renders the deferred tool summary section in the system prompt.

5. **LLM providers** — unchanged. They receive only core tool schemas in the `tools` parameter. Deferred tools exist only as text in the system prompt.

### 2.11 HostDispatcher Constructor Changes

`HostDispatcher` gains `toolResolver` as a constructor dependency (alongside existing `toolRegistry`):

```js
new HostDispatcher({
  // ... existing deps ...
  toolResolver,   // NEW
})
```

`toolRegistry` is still needed for other purposes (tool executor uses it). `toolResolver` wraps it for the schema-splitting concern.

### 2.12 Wiring (index.js)

```js
// After ToolRegistry is populated with all tools:
import { ToolResolver } from './tools/tool-resolver.js';
import { registerMetaTools } from './tools/built-in/meta-tools.js';

registerMetaTools(toolRegistry, toolRegistry, skillLoader, config);
const toolResolver = new ToolResolver(toolRegistry, config);

// Pass to HostDispatcher:
const hostDispatcher = new HostDispatcher({
  // ... existing deps ...
  toolResolver,
});
```

## 3. Affected Components

| Component | Change | Spec |
|-----------|--------|------|
| `ToolRegistry` | Add `getSummaries()`, `getSchema()` methods | Spec 03 |
| `PromptBuilder` | New `deferredToolSummaries` parameter, new prompt section | Spec 02 |
| `HostDispatcher` | Use `ToolResolver` instead of direct `getSchemas()` call | Spec 10 |
| `ExecutionRequest` | New `deferredToolSummaries` field | Spec 10 |
| `LocalRunner` | Pass-through of `deferredToolSummaries` | Spec 10 |
| `AgentLoop` | Accept and forward `deferredToolSummaries` | Spec 01 |
| `config.js` | Two new env vars | Spec 09 |
| `SOUL.md` | Remove "What You're Good At" section | Spec 02 |

**LLM providers are NOT modified** — they continue to receive tool schemas in the same format. The only change is that fewer schemas are sent in dynamic mode.

## 4. Open Questions

1. **Memory flush compatibility** — `MemoryFlusher` filters `toolSchemas` to only `save_memory`. In dynamic mode, `save_memory` is a core tool so it's always in `toolSchemas`. No issue expected, but needs verification in tests.

2. **Skill pseudo-tools** — Skills register pseudo-tools via `ToolRegistry`. These should be classified as deferred by default (they are infrequently used). The `ToolResolver` handles them like any other tool — if the skill name isn't in `CORE_TOOLS`, it's deferred.

3. **Agent profiles with restricted tool sets** — Agent profiles can restrict tools via `agentProfile.tools`. The `ToolResolver` operates on the already-filtered `effectiveToolNames`, so profile restrictions are respected.
