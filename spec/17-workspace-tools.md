# Spec 17 — Workspace Tools (File System)

> Status: **Draft** | Owner: — | Last updated: 2026-03-25

## 1. Purpose

Give the agent direct read/write access to files in the workspace, transforming it from a chat assistant into a coding companion that can read code, write files, apply edits, and search codebases.

## 2. Components

### 2.1 File System Tools

**File:** `src/tools/built-in/fs-tools.js`
**Registration:** `registerFsTools(registry, sandbox, auditLogger)`

All tools use the `Sandbox` (Spec 16) for path validation and are class `brokered`.

### 2.2 Tool Definitions

#### `read_file`

Read the contents of a file, optionally with offset/limit for large files.

| Field | Value |
|-------|-------|
| Class | `brokered` |
| Permissions | `fs:read` |
| Timeout | 10,000 ms |

**Input schema:**

```json
{
  "type": "object",
  "properties": {
    "path": { "type": "string", "description": "File path (relative to workspace or absolute)" },
    "offset": { "type": "integer", "minimum": 0, "description": "Start line (0-indexed). Default: 0" },
    "limit": { "type": "integer", "minimum": 1, "maximum": 500, "description": "Max lines to return. Default: 200" }
  },
  "required": ["path"]
}
```

**Handler behavior:**

1. `sandbox.assertReadable(path)` → resolved path.
2. Read file. If binary (contains null bytes in first 1KB), return `"Binary file: {size} bytes"`.
3. Split into lines. If total lines > limit, return slice `[offset, offset+limit]` with header `"Lines {offset+1}-{end} of {total}:"`.
4. Prepend line numbers (1-indexed): `"  1 | const foo = ..."`
5. Truncate total output to 50KB.

#### `write_file`

Create or overwrite a file.

| Field | Value |
|-------|-------|
| Class | `brokered` |
| Permissions | `fs:write` |
| Timeout | 10,000 ms |

**Input schema:**

```json
{
  "type": "object",
  "properties": {
    "path": { "type": "string", "description": "File path (relative to workspace or absolute)" },
    "content": { "type": "string", "description": "Full file content to write" }
  },
  "required": ["path", "content"]
}
```

**Handler behavior:**

1. `sandbox.assertWritable(path)` → resolved path.
2. Create parent directories if they don't exist (`fs.mkdirSync({ recursive: true })`).
3. Write file atomically: write to `path.tmp`, then rename.
4. Return `"Written {bytes} bytes to {relativePath}"`.

#### `edit_file`

Apply a targeted edit to an existing file using search-and-replace.

| Field | Value |
|-------|-------|
| Class | `brokered` |
| Permissions | `fs:write` |
| Timeout | 10,000 ms |

**Input schema:**

```json
{
  "type": "object",
  "properties": {
    "path": { "type": "string", "description": "File path" },
    "old_text": { "type": "string", "description": "Exact text to find (must match uniquely)" },
    "new_text": { "type": "string", "description": "Replacement text" }
  },
  "required": ["path", "old_text", "new_text"]
}
```

**Handler behavior:**

1. `sandbox.assertWritable(path)` → resolved path.
2. Read current content.
3. Count occurrences of `old_text`. If 0 → error `"old_text not found in file"`. If >1 → error `"old_text matches {n} locations — provide more context to match uniquely"`.
4. Replace the single occurrence.
5. Write atomically.
6. Return `"Edited {relativePath}: replaced {old_text_preview} with {new_text_preview}"`.

#### `list_directory`

List files and directories at a path.

| Field | Value |
|-------|-------|
| Class | `brokered` |
| Permissions | `fs:read` |
| Timeout | 10,000 ms |

**Input schema:**

```json
{
  "type": "object",
  "properties": {
    "path": { "type": "string", "description": "Directory path. Default: workspace root" },
    "recursive": { "type": "boolean", "description": "List recursively (max depth 3). Default: false" }
  }
}
```

**Handler behavior:**

1. `sandbox.assertReadable(path || '.')` → resolved path.
2. Read directory entries with `fs.readdirSync({ withFileTypes: true })`.
3. For each entry: `[type] name  (size)` where type is `[F]` file or `[D]` dir.
4. If recursive: walk up to depth 3, indent children.
5. Cap output at 200 entries: `"...and {n} more entries"`.

#### `file_search`

Find files by name pattern (glob).

| Field | Value |
|-------|-------|
| Class | `brokered` |
| Permissions | `fs:read` |
| Timeout | 15,000 ms |

**Input schema:**

```json
{
  "type": "object",
  "properties": {
    "pattern": { "type": "string", "description": "Glob pattern (e.g., '**/*.js', 'src/**/*.test.ts')" },
    "path": { "type": "string", "description": "Search root. Default: workspace root" }
  },
  "required": ["pattern"]
}
```

**Handler behavior:**

1. Resolve search root via sandbox.
2. Use `fs.globSync` (Node 22+) or a lightweight glob implementation.
3. Return matching paths relative to workspace, sorted, capped at 100 results.

#### `grep_search`

Search file contents for a pattern.

| Field | Value |
|-------|-------|
| Class | `brokered` |
| Permissions | `fs:read` |
| Timeout | 20,000 ms |

**Input schema:**

```json
{
  "type": "object",
  "properties": {
    "pattern": { "type": "string", "description": "Search string or regex pattern" },
    "path": { "type": "string", "description": "File or directory to search. Default: workspace root" },
    "glob": { "type": "string", "description": "Glob filter for files (e.g., '*.js')" },
    "max_results": { "type": "integer", "minimum": 1, "maximum": 50, "description": "Max matches. Default: 20" }
  },
  "required": ["pattern"]
}
```

**Handler behavior:**

1. Resolve search root via sandbox.
2. Walk directory tree (skip `node_modules`, `.git`, binary files).
3. For each file, search lines for pattern. If pattern looks like regex (`/pattern/flags`), use RegExp; otherwise literal match.
4. Return matches as: `{file}:{line}: {content}` (content truncated to 200 chars per line).
5. Cap at `max_results`.

## 3. Tool Policy Updates

**File:** `src/security/tool-policy.js`

Add new permission scopes and update profiles:

```js
const DEFAULT_PROFILES = {
  minimal: {
    allow: ['get_current_time'],
    deny: ['*'],
  },
  standard: {
    allow: [
      'get_current_time', 'search_memory', 'list_memories',
      'http_get', 'save_memory', 'wait',
      'read_file', 'list_directory', 'file_search', 'grep_search',  // fs:read tools
    ],
    deny: ['http_post', 'write_file', 'edit_file'],  // fs:write denied for standard users
  },
  full: {
    allow: ['*'],
    deny: [],
  },
};
```

Standard users get read-only workspace access. Admin users get full access.

## 4. Design Decisions

| Decision | Rationale |
|----------|-----------|
| Search-and-replace for `edit_file` (not line numbers) | More robust with concurrent edits and LLM context drift. Requires unique match to prevent wrong-location edits. |
| Atomic writes (write-then-rename) | Prevents partial writes on crash or timeout. |
| Output cap at 50KB | Prevents blowing up LLM context window. Matches existing pattern (HTTP tools cap at 10KB). |
| Line numbers in `read_file` output | Helps the LLM reference specific locations for `edit_file`. |
| Skip `node_modules`/`.git` in search | These are almost never what the user wants and would dominate results. |
| No `delete_file` tool initially | Destructive operations should be added cautiously, gated behind approval workflow (Spec 19). |

## 5. Extension Points

- **`apply_patch` tool:** Apply unified diff format. More complex than search-and-replace but handles multi-site edits.
- **`delete_file` / `move_file`:** Add with mandatory approval.
- **File watching:** Notify agent when files change (for CI integration).
- **Diff view:** Return structured diffs after `edit_file` for user review.
