import { readFileSync, writeFileSync, renameSync, readdirSync, statSync, mkdirSync, existsSync } from 'fs';
import { join, relative, resolve, dirname, extname } from 'path';
import { globSync } from 'fs';

const MAX_OUTPUT_SIZE = 50 * 1024; // 50KB

export function registerFsTools(registry, sandbox) {
  // ── read_file ──
  registry.register({
    name: 'read_file',
    class: 'brokered',
    description: 'Read the contents of a file, optionally with offset/limit for large files. Returns content with line numbers.',
    timeout: 10_000,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (relative to workspace or absolute)' },
        offset: { type: 'integer', minimum: 0, description: 'Start line (0-indexed). Default: 0' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Max lines to return. Default: 200' },
      },
      required: ['path'],
    },
    handler: async (input) => {
      const resolved = sandbox.assertReadable(input.path);
      const buffer = readFileSync(resolved);

      // Check for binary content
      const sample = buffer.slice(0, 1024);
      if (sample.includes(0)) {
        return `Binary file: ${buffer.length} bytes`;
      }

      const content = buffer.toString('utf-8');
      const lines = content.split('\n');
      const offset = input.offset || 0;
      const limit = input.limit || 200;
      const end = Math.min(offset + limit, lines.length);
      const slice = lines.slice(offset, end);

      const numbered = slice.map((line, i) => {
        const lineNum = String(offset + i + 1).padStart(5);
        return `${lineNum} | ${line}`;
      });

      let result = '';
      if (offset > 0 || end < lines.length) {
        result = `Lines ${offset + 1}-${end} of ${lines.length}:\n`;
      }
      result += numbered.join('\n');

      if (result.length > MAX_OUTPUT_SIZE) {
        result = result.slice(0, MAX_OUTPUT_SIZE) + '\n... [output truncated to 50KB]';
      }

      return result;
    },
  });

  // ── write_file ──
  registry.register({
    name: 'write_file',
    class: 'brokered',
    description: 'Create or overwrite a file with the given content.',
    timeout: 10_000,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (relative to workspace or absolute)' },
        content: { type: 'string', description: 'Full file content to write' },
      },
      required: ['path', 'content'],
    },
    handler: async (input) => {
      const resolved = sandbox.assertWritable(input.path);
      mkdirSync(dirname(resolved), { recursive: true });

      // Atomic write: write to temp, then rename
      const tmpPath = resolved + '.tmp';
      writeFileSync(tmpPath, input.content, 'utf-8');
      renameSync(tmpPath, resolved);

      const relativePath = relative(sandbox.workspaceDir, resolved);
      return `Written ${Buffer.byteLength(input.content, 'utf-8')} bytes to ${relativePath}`;
    },
  });

  // ── edit_file ──
  registry.register({
    name: 'edit_file',
    class: 'brokered',
    description: 'Apply a targeted edit to an existing file using search-and-replace. The old_text must match exactly one location.',
    timeout: 10_000,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        old_text: { type: 'string', description: 'Exact text to find (must match uniquely)' },
        new_text: { type: 'string', description: 'Replacement text' },
      },
      required: ['path', 'old_text', 'new_text'],
    },
    handler: async (input) => {
      const resolved = sandbox.assertWritable(input.path);
      const content = readFileSync(resolved, 'utf-8');

      // Count occurrences
      let count = 0;
      let idx = -1;
      let searchFrom = 0;
      while ((idx = content.indexOf(input.old_text, searchFrom)) !== -1) {
        count++;
        searchFrom = idx + 1;
      }

      if (count === 0) {
        throw new Error('old_text not found in file');
      }
      if (count > 1) {
        throw new Error(`old_text matches ${count} locations — provide more context to match uniquely`);
      }

      const newContent = content.replace(input.old_text, input.new_text);

      // Atomic write
      const tmpPath = resolved + '.tmp';
      writeFileSync(tmpPath, newContent, 'utf-8');
      renameSync(tmpPath, resolved);

      const relativePath = relative(sandbox.workspaceDir, resolved);
      const preview = (s) => s.length > 50 ? s.slice(0, 50) + '...' : s;
      return `Edited ${relativePath}: replaced "${preview(input.old_text)}" with "${preview(input.new_text)}"`;
    },
  });

  // ── list_directory ──
  registry.register({
    name: 'list_directory',
    class: 'brokered',
    description: 'List files and directories at a path.',
    timeout: 10_000,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path. Default: workspace root' },
        recursive: { type: 'boolean', description: 'List recursively (max depth 3). Default: false' },
      },
    },
    handler: async (input) => {
      const resolved = sandbox.assertReadable(input.path || '.');
      const recursive = input.recursive || false;
      const maxEntries = 200;

      const entries = [];
      _listDir(resolved, '', recursive ? 3 : 0, entries, maxEntries);

      let result = entries.join('\n');
      if (entries.length >= maxEntries) {
        result += `\n...and more entries (capped at ${maxEntries})`;
      }
      return result || '(empty directory)';
    },
  });

  // ── file_search ──
  registry.register({
    name: 'file_search',
    class: 'brokered',
    description: 'Find files by name pattern (glob).',
    timeout: 15_000,
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: "Glob pattern (e.g., '**/*.js', 'src/**/*.test.ts')" },
        path: { type: 'string', description: 'Search root. Default: workspace root' },
      },
      required: ['pattern'],
    },
    handler: async (input) => {
      const searchRoot = sandbox.assertReadable(input.path || '.');

      // Use manual recursive walk with glob-like matching
      const matches = [];
      _globWalk(searchRoot, input.pattern, '', matches, 100);

      if (matches.length === 0) return 'No files found matching pattern.';
      let result = matches.sort().join('\n');
      if (matches.length >= 100) result += '\n...(capped at 100 results)';
      return result;
    },
  });

  // ── grep_search ──
  registry.register({
    name: 'grep_search',
    class: 'brokered',
    description: 'Search file contents for a text pattern.',
    timeout: 20_000,
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Search string or regex pattern' },
        path: { type: 'string', description: 'File or directory to search. Default: workspace root' },
        glob: { type: 'string', description: "Glob filter for files (e.g., '*.js')" },
        max_results: { type: 'integer', minimum: 1, maximum: 50, description: 'Max matches. Default: 20' },
      },
      required: ['pattern'],
    },
    handler: async (input) => {
      const searchRoot = sandbox.assertReadable(input.path || '.');
      const maxResults = input.max_results || 20;

      // Build regex from pattern
      let regex;
      const regexMatch = input.pattern.match(/^\/(.+)\/([gimsuy]*)$/);
      if (regexMatch) {
        regex = new RegExp(regexMatch[1], regexMatch[2]);
      } else {
        regex = new RegExp(escapeRegex(input.pattern), 'i');
      }

      const globFilter = input.glob || null;
      const results = [];
      _grepWalk(searchRoot, regex, globFilter, '', results, maxResults);

      if (results.length === 0) return 'No matches found.';
      let output = results.join('\n');
      if (results.length >= maxResults) output += `\n...(capped at ${maxResults} results)`;
      return output;
    },
  });
}

// ── Helpers ──

function _listDir(dir, prefix, depth, entries, max) {
  if (entries.length >= max) return;

  let items;
  try {
    items = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  items.sort((a, b) => a.name.localeCompare(b.name));

  for (const item of items) {
    if (entries.length >= max) return;
    const type = item.isDirectory() ? '[D]' : '[F]';
    let size = '';
    try {
      if (item.isFile()) {
        const s = statSync(join(dir, item.name)).size;
        size = `  (${formatSize(s)})`;
      }
    } catch { /* ignore */ }

    entries.push(`${prefix}${type} ${item.name}${size}`);

    if (item.isDirectory() && depth > 0) {
      _listDir(join(dir, item.name), prefix + '  ', depth - 1, entries, max);
    }
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', '__pycache__', '.next', 'dist', 'build']);

function _globWalk(root, pattern, relativePath, matches, max) {
  if (matches.length >= max) return;

  const fullPath = relativePath ? join(root, relativePath) : root;
  let items;
  try {
    items = readdirSync(fullPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const item of items) {
    if (matches.length >= max) return;
    const itemRelative = relativePath ? `${relativePath}/${item.name}` : item.name;

    if (item.isDirectory()) {
      if (SKIP_DIRS.has(item.name)) continue;
      _globWalk(root, pattern, itemRelative, matches, max);
    } else {
      if (_matchGlob(pattern, itemRelative)) {
        matches.push(itemRelative);
      }
    }
  }
}

function _matchGlob(pattern, path) {
  // Convert glob to regex
  let re = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '§§')
    .replace(/\*/g, '[^/]*')
    .replace(/§§/g, '.*')
    .replace(/\?/g, '.');
  re = `^${re}$`;
  return new RegExp(re).test(path);
}

function _grepWalk(dir, regex, globFilter, relativePath, results, max) {
  if (results.length >= max) return;

  let items;
  try {
    items = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const item of items) {
    if (results.length >= max) return;
    const itemPath = join(dir, item.name);
    const itemRelative = relativePath ? `${relativePath}/${item.name}` : item.name;

    if (item.isDirectory()) {
      if (SKIP_DIRS.has(item.name)) continue;
      _grepWalk(itemPath, regex, globFilter, itemRelative, results, max);
    } else {
      if (globFilter && !_matchGlob(globFilter, item.name)) continue;

      // Skip binary / very large files
      try {
        const stat = statSync(itemPath);
        if (stat.size > 1024 * 1024) continue; // skip >1MB
      } catch { continue; }

      let content;
      try {
        content = readFileSync(itemPath, 'utf-8');
      } catch { continue; }

      // Check for binary
      if (content.includes('\0')) continue;

      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (results.length >= max) return;
        if (regex.test(lines[i])) {
          const lineContent = lines[i].length > 200 ? lines[i].slice(0, 200) + '...' : lines[i];
          results.push(`${itemRelative}:${i + 1}: ${lineContent}`);
        }
      }
    }
  }
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
