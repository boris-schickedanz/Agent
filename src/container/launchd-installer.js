import { writeFileSync, rmSync, existsSync, mkdirSync } from 'fs';
import { resolve, join } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';

const PLIST_LABEL = 'com.boris.agentcore';
const PLIST_PATH = join(homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);

export class LaunchdInstaller {
  constructor({ projectRoot, logger } = {}) {
    this.projectRoot = projectRoot || process.cwd();
    this.logger = logger;
  }

  isInstalled() {
    return existsSync(PLIST_PATH);
  }

  install({ nodeExecPath = process.execPath } = {}) {
    const logsDir = resolve(this.projectRoot, 'logs');
    mkdirSync(logsDir, { recursive: true });

    // Capture current PATH so launchd can find the `container` CLI
    const currentPath = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';

    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodeExecPath}</string>
        <string>${resolve(this.projectRoot, 'bin', 'agentcore.js')}</string>
        <string>start</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${this.projectRoot}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${currentPath}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${logsDir}/out.log</string>
    <key>StandardErrorPath</key>
    <string>${logsDir}/error.log</string>
</dict>
</plist>
`;

    writeFileSync(PLIST_PATH, plist, 'utf-8');
    this.logger?.info({ plist: PLIST_PATH }, 'Wrote launchd plist');

    // Load into launchd
    execSync(`launchctl load -w "${PLIST_PATH}"`, { stdio: 'inherit' });
  }

  uninstall() {
    if (!this.isInstalled()) {
      throw new Error('Not installed (plist not found).');
    }

    try {
      execSync(`launchctl unload -w "${PLIST_PATH}"`, { stdio: 'inherit' });
    } catch {
      // May already be unloaded — continue to remove file
    }

    rmSync(PLIST_PATH, { force: true });
  }

  plistPath() {
    return PLIST_PATH;
  }
}
