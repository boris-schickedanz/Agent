import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, copyFileSync } from 'fs';
import { join, resolve, basename } from 'path';
import { execSync } from 'child_process';

const MANIFEST_FILE = 'data/skills-manifest.json';

export class SkillInstaller {
  constructor({ skillsDir, logger }) {
    this.skillsDir = resolve(skillsDir || 'skills');
    this.logger = logger;
    mkdirSync(this.skillsDir, { recursive: true });
  }

  async installFromUrl(url) {
    this.logger.info?.({ url }, 'Installing skill');

    // Determine installation method
    if (url.endsWith('SKILL.md') || url.includes('raw.githubusercontent.com')) {
      return this._installFromRawUrl(url);
    }

    if (url.endsWith('.tar.gz') || url.endsWith('.zip')) {
      throw new Error('Archive installation not yet supported. Use a GitHub URL or local path.');
    }

    if (existsSync(url)) {
      return this.installFromDir(url);
    }

    // Assume it's a GitHub tree URL or clone-able repo
    return this._installFromGitUrl(url);
  }

  async installFromDir(sourcePath) {
    const absSource = resolve(sourcePath);
    if (!existsSync(absSource)) {
      throw new Error(`Source path does not exist: ${sourcePath}`);
    }

    // Find SKILL.md
    const skillMd = join(absSource, 'SKILL.md');
    if (!existsSync(skillMd)) {
      throw new Error(`No SKILL.md found in ${sourcePath}`);
    }

    // Parse skill name from frontmatter
    const content = readFileSync(skillMd, 'utf-8');
    const nameMatch = content.match(/^name:\s*(.+)$/m);
    const name = nameMatch ? nameMatch[1].trim() : basename(absSource);

    // Copy to skills directory
    const destDir = join(this.skillsDir, name);
    mkdirSync(destDir, { recursive: true });

    const files = readdirSync(absSource);
    for (const file of files) {
      copyFileSync(join(absSource, file), join(destDir, file));
    }

    const result = {
      name,
      version: '1.0.0',
      source: sourcePath,
      installedAt: Date.now(),
      path: destDir,
    };

    this._updateManifest(name, result);
    this.logger.info?.({ name }, 'Skill installed');

    return result;
  }

  uninstall(name) {
    const destDir = join(this.skillsDir, name);
    if (!existsSync(destDir)) return false;

    rmSync(destDir, { recursive: true, force: true });
    this._removeFromManifest(name);
    this.logger.info?.({ name }, 'Skill uninstalled');
    return true;
  }

  listInstalled() {
    if (!existsSync(this.skillsDir)) return [];

    return readdirSync(this.skillsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && existsSync(join(this.skillsDir, d.name, 'SKILL.md')))
      .map(d => ({
        name: d.name,
        path: join(this.skillsDir, d.name),
      }));
  }

  getManifest() {
    const manifestPath = resolve(MANIFEST_FILE);
    if (!existsSync(manifestPath)) return { installed: {} };
    try {
      return JSON.parse(readFileSync(manifestPath, 'utf-8'));
    } catch {
      return { installed: {} };
    }
  }

  async _installFromRawUrl(url) {
    const http = url.startsWith('https') ? await import('https') : await import('http');

    const content = await new Promise((resolve, reject) => {
      http.get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // Follow redirect
          http.get(res.headers.location, (res2) => {
            let body = '';
            res2.on('data', chunk => body += chunk);
            res2.on('end', () => resolve(body));
          }).on('error', reject);
          return;
        }
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => resolve(body));
      }).on('error', reject);
    });

    // Parse name from content
    const nameMatch = content.match(/^name:\s*(.+)$/m);
    const name = nameMatch ? nameMatch[1].trim() : 'downloaded-skill';

    const destDir = join(this.skillsDir, name);
    mkdirSync(destDir, { recursive: true });
    writeFileSync(join(destDir, 'SKILL.md'), content);

    const result = {
      name,
      version: '1.0.0',
      source: url,
      installedAt: Date.now(),
      path: destDir,
    };

    this._updateManifest(name, result);
    console.warn(`⚠ Review ${destDir}/SKILL.md before enabling. Skills from untrusted sources may instruct the agent to perform harmful actions.`);

    return result;
  }

  async _installFromGitUrl(url) {
    const tmpDir = resolve('.tmp-skill-install-' + Date.now());
    try {
      mkdirSync(tmpDir, { recursive: true });
      execSync(`git clone --depth 1 "${url}" "${tmpDir}"`, { timeout: 30_000, stdio: 'pipe' });

      // Look for SKILL.md in the root or subdirectories
      if (existsSync(join(tmpDir, 'SKILL.md'))) {
        return this.installFromDir(tmpDir);
      }

      // Check subdirectories
      const dirs = readdirSync(tmpDir, { withFileTypes: true }).filter(d => d.isDirectory());
      for (const dir of dirs) {
        if (existsSync(join(tmpDir, dir.name, 'SKILL.md'))) {
          return this.installFromDir(join(tmpDir, dir.name));
        }
      }

      throw new Error('No SKILL.md found in cloned repository');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  _updateManifest(name, entry) {
    const manifest = this.getManifest();
    manifest.installed[name] = {
      source: entry.source,
      version: entry.version,
      installedAt: entry.installedAt,
      path: entry.path,
    };

    const manifestPath = resolve(MANIFEST_FILE);
    mkdirSync(resolve('data'), { recursive: true });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }

  _removeFromManifest(name) {
    const manifest = this.getManifest();
    delete manifest.installed[name];

    const manifestPath = resolve(MANIFEST_FILE);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }
}
