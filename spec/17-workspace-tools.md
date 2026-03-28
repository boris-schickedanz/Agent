# Spec 17 — Workspace Tools (File System)

> Status: **Implemented** | Owner: — | Last updated: 2026-03-25

## 1. Purpose

Give the agent direct read/write access to files in the workspace, transforming it from a chat assistant into a coding companion that can read code, write files, apply edits, and search codebases.

## 2. Components

### 2.1 File System Tools

**File:** `src/tools/built-in/fs-tools.js`
**Registration:** `registerFsTools(registry, sandbox)`

All tools use the `Sandbox` (Spec 16) for path validation and are class `brokered`. Audit logging is handled by `ToolExecutor` (not passed to individual tools).

### 2.2 Tool Definitions

#### `read_file`

Read the contents of a file, optionally with offset/limit for large files.

| Field | Value |
|-------|-------|
| Class | `brokered` |
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
2. Read file as buffer. If binary (contains null byte in first 1KB), return `"Binary file: {size} bytes"`.
3. Split into lines. If total lines > limit, return slice `[offset, offset+limit]` with header `"Lines {offset+1}-{end} of {total}:"`.
4. Prepend line numbers (1-indexed, right-padded to 5 chars): `"    1 | const foo = ..."`
5. Truncate total output to 50KB.

#### `write_file`

Create or overwrite a file.

| Field | Value |
|-------|-------|
| Class | `brokered` |
| Timeout | 10,000 ms |

**Input:** `{ path, content }` (both required).
**Handler:** `sandbox.assertWritable(path)`, create parent dirs, write atomically (`.tmp` + rename). Returns `"Written {bytes} bytes to {relativePath}"`.

#### `edit_file`

Apply a targeted edit to an existing file using search-and-replace.

| Field | Value |
|-------|-------|
| Class | `brokered` |
| Timeout | 10,000 ms |

**Input:** `{ path, old_text, new_text }` (all required).
**Handler:** `sandbox.assertWritable(path)`, read file, count occurrences of `old_text`. If 0 → error. If >1 → error with count. Replace single occurrence, write atomically. Returns edit confirmation with preview.

#### `list_directory`

List files and directories at a path.

| Field | Value |
|-------|-------|
| Class | `brokered` |
| Timeout | 10,000 ms |

**Input:** `{ path?, recursive? }`.
**Handler:** `sandbox.assertReadable(path || '.')`. Lists entries as `[F] name (size)` / `[D] name`. Recursive walks up to depth 3. Capped at 200 entries.

#### `file_search`

Find files by name pattern (glob).

| Field | Value |
|-------|-------|
| Class | `brokered` |
| Timeout | 15,000 ms |

**Input:** `{ pattern, path? }` (pattern required).
**Handler:** Resolve root via sandbox. Manual recursive walk with glob-to-regex conversion. Skips `node_modules`, `.git`, `.hg`, `.svn`, `__pycache__`, `.next`, `dist`, `build`. Returns matching paths relative to workspace, sorted, capped at 100.

#### `grep_search`

Search file contents for a pattern.

| Field | Value |
|-------|-------|
| Class | `brokered` |
| Timeout | 20,000 ms |

**Input:** `{ pattern, path?, glob?, max_results? }` (pattern required).
**Handler:** Resolve root via sandbox. Walk directory (skipping same dirs as `file_search` + binary files + files >1MB). If pattern matches `/regex/flags` syntax, use RegExp; otherwise case-insensitive literal match. Returns `{file}:{line}: {content}` (content truncated to 200 chars). Default 20 results, max 50.

## 3. Tool Policy Updates

**File:** `src/security/tool-policy.js`

All workspace tools are available in the single-user model ([Spec 32](32-single-user-migration.md)). Write tools require approval via the approval workflow ([Spec 19](19-approval-workflow.md)):
- **Read tools (no approval):** `read_file`, `list_directory`, `file_search`, `grep_search`
- **Write tools (approval required):** `write_file`, `edit_file`

## 4. Design Decisions

| Decision | Rationale |
|----------|-----------|
| Search-and-replace for `edit_file` (not line numbers) | More robust with concurrent edits and LLM context drift. Requires unique match to prevent wrong-location edits. |
| Atomic writes (write-then-rename) | Prevents partial writes on crash or timeout. |
| Output cap at 50KB | Prevents blowing up LLM context window. |
| Line numbers in `read_file` output | Helps the LLM reference specific locations for `edit_file`. |
| Skip `node_modules`/`.git` etc. in search | These are almost never what the user wants and would dominate results. |
| No `delete_file` tool initially | Destructive operations should be added cautiously, gated behind approval workflow (Spec 19). |
| Glob implementation via regex conversion | Avoids dependency on external glob library. Handles `**/*.js` patterns correctly. |

## 5. Extension Points

- **`apply_patch` tool:** Apply unified diff format for multi-site edits.
- **`delete_file` / `move_file`:** Add with mandatory approval.
- **File watching:** Notify agent when files change (for CI integration).
- **Diff view:** Return structured diffs after `edit_file` for user review.
