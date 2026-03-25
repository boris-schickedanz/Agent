import { resolve, sep, normalize } from 'path';
import { realpathSync } from 'fs';

export class SandboxViolationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SandboxViolationError';
  }
}

export class Sandbox {
  constructor({ workspaceDir, readOnlyDirs = [], logger }) {
    this.workspaceDir = resolve(workspaceDir);
    this.workspacePrefix = this.workspaceDir + sep;
    this.readOnlyDirs = readOnlyDirs.map(d =>
      resolve(this.workspaceDir, d)
    );
    this.logger = logger || null;
  }

  /**
   * Resolve inputPath to an absolute path within the workspace.
   * Throws SandboxViolationError if the path escapes the workspace.
   */
  resolve(inputPath) {
    // Block UNC paths (Windows)
    if (inputPath.startsWith('\\\\')) {
      throw new SandboxViolationError('UNC paths are not allowed');
    }

    // Strip null bytes
    let cleaned = inputPath.replace(/\0/g, '');

    // Normalize unicode (e.g., fullwidth solidus ／ → /)
    cleaned = cleaned.normalize('NFC');

    // Resolve relative to workspace
    const absolute = resolve(this.workspaceDir, cleaned);

    // Attempt realpath (follows symlinks). If the path doesn't exist yet,
    // walk up to the nearest existing ancestor and check that.
    let resolved;
    try {
      resolved = realpathSync.native(absolute);
    } catch {
      // Path doesn't exist — resolve the nearest existing parent
      resolved = this._resolveNearestParent(absolute);
    }

    // Prefix check
    if (resolved !== this.workspaceDir && !resolved.startsWith(this.workspacePrefix)) {
      throw new SandboxViolationError('Path is outside the workspace');
    }

    return absolute;
  }

  /**
   * Check if a path is within the workspace without throwing.
   */
  isAllowed(inputPath) {
    try {
      this.resolve(inputPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Resolve and ensure the path is readable (exists within workspace).
   */
  assertReadable(inputPath) {
    return this.resolve(inputPath);
  }

  /**
   * Resolve and ensure the path is writable (not in a read-only zone).
   */
  assertWritable(inputPath) {
    const resolved = this.resolve(inputPath);

    for (const roDir of this.readOnlyDirs) {
      const roPrefix = roDir + sep;
      if (resolved === roDir || resolved.startsWith(roPrefix)) {
        throw new SandboxViolationError('Path is in a read-only zone');
      }
    }

    return resolved;
  }

  /**
   * Walk up from a non-existent path to find the nearest existing ancestor,
   * then realpath that ancestor and verify it's within the workspace.
   */
  _resolveNearestParent(absolutePath) {
    let current = normalize(absolutePath);
    const root = resolve('/');

    while (current !== root) {
      const parent = resolve(current, '..');
      if (parent === current) break; // reached filesystem root
      try {
        const realParent = realpathSync.native(parent);
        // Build the resolved path: realParent + remaining segments
        const remaining = absolutePath.slice(parent.length);
        return realParent + remaining;
      } catch {
        current = parent;
      }
    }

    return absolutePath;
  }
}
