# Spec 05 — Skill System

> Status: **Implemented** | Owner: — | Last updated: 2026-03-25

## 1. Purpose

Skills are higher-level capabilities defined as markdown files with YAML frontmatter. They bundle instructions, tool requirements, and metadata. Skills allow extending the agent's behavior without writing JavaScript code.

## 2. Skill File Format

Skills are defined in `SKILL.md` files located anywhere under the `skills/` directory (recursive scan).

### 2.1 Frontmatter Schema

```yaml
---
name: string           # Required. Unique skill identifier (kebab-case)
description: string    # Required. Human-readable description
version: string        # Optional. Semver. Default: "1.0.0"
trigger: string        # Optional. Command trigger (e.g., "/weather")
tools: string[]        # Optional. Tools this skill requires. Default: []
permissions: string[]  # Optional. Permission scopes required. Default: []
env: string[]          # Optional. Environment variables required. Default: []
always: boolean        # Optional. If true, skill is always active. Default: false
---
```

**Validation:** Frontmatter is validated at load time using Zod (`src/skills/skill-schema.js`). Invalid skills are skipped with an error log.

### 2.2 Body (Instructions)

The markdown body below the frontmatter contains the skill's instructions. These are injected into the system prompt when the skill is activated.

**Example:**

```markdown
---
name: weather-lookup
description: Get current weather for any city worldwide
version: 1.0.0
trigger: /weather
tools:
  - http_get
permissions:
  - network:outbound
env:
  - OPENWEATHER_API_KEY
---

# Weather Lookup

When the user asks about weather:

1. Extract the city name from their message
2. Use http_get to call the weather API
3. Parse the JSON response
4. Format a friendly response with temperature, conditions, and humidity
```

## 3. Skill Loading

**File:** `src/skills/skill-loader.js`
**Class:** `SkillLoader`

**Interface:**

```js
async loadAll(skillsDir: string): void
async loadOne(filePath: string): Skill
getLoadedSkills(): Skill[]
getSkill(name: string): Skill | null
```

**Loading process:**

1. Recursively scan `skillsDir` for files named `SKILL.md`.
2. For each file: parse YAML frontmatter with `gray-matter`, validate with Zod schema.
3. If `trigger` is defined, register a pseudo-tool named `skill_{name}` in the tool registry.
4. Store the parsed skill in an internal `Map<name, Skill>`.

**Pseudo-tool behavior:** When the LLM invokes `skill_{name}`, the handler returns the skill's instructions as a string. This allows the LLM to discover and activate skills via tool use.

## 4. Skill Activation

Skills can be activated in two ways:

| Mechanism | When | Behavior |
|-----------|------|----------|
| **Explicit trigger** | User message starts with the trigger (e.g., `/weather`) | Skill instructions injected into system prompt via `promptBuilder` |
| **Tool invocation** | LLM calls the `skill_{name}` pseudo-tool | Skill instructions returned as tool result |

**Note:** The `always: true` flag is reserved for future use where skills would always be included in the system prompt.

## 5. Skill Object Shape

```js
{
  name: string,
  description: string,
  version: string,
  trigger: string | undefined,
  tools: string[],
  permissions: string[],
  env: string[],
  always: boolean,
  instructions: string,    // Markdown body (trimmed)
  filePath: string         // Absolute path to SKILL.md
}
```

## 6. Adding a New Skill

1. Create `skills/<skill-name>/SKILL.md` with valid YAML frontmatter.
2. Write instructions in the markdown body.
3. Restart the agent. Skills are auto-discovered on startup.
4. No code changes required.

## 7. Design Decisions

| Decision | Rationale |
|----------|-----------|
| Markdown with YAML frontmatter | Human-readable, easy to edit, version-controllable. Same format used by OpenClaw. |
| Skills as pseudo-tools | Leverages the existing tool system. The LLM can discover skills just like any other tool. |
| Recursive directory scan | Allows organizing skills into subdirectories without configuration. |
| `gray-matter` for parsing | De facto standard for frontmatter parsing in the Node.js ecosystem. |
| Invalid skills are skipped, not fatal | One bad skill file should not prevent the agent from starting. |

## 8. Extension Points

- **Skill marketplace:** Load skills from a remote registry (similar to OpenClaw's ClaHub).
- **Skill chaining:** Allow skills to declare dependencies on other skills.
- **Dynamic skill activation:** Use the `always` flag to inject skill instructions into every prompt.
- **Skill-scoped tools:** Register tools that only exist when a skill is active.
