# Spec 22 — CLI, Skill Marketplace & Dashboard

> Status: **Draft** | Owner: — | Last updated: 2026-03-25

## 1. Purpose

Provide a command-line interface for managing the agent, a mechanism for installing/managing skills from external sources, and a web dashboard for monitoring and configuration. These are platform features that improve the developer experience around the core agent.

## 2. CLI

### 2.1 Entry Point

**File:** `bin/agentcore.js`

Registered in `package.json`:

```json
{
  "bin": {
    "agentcore": "./bin/agentcore.js"
  }
}
```

### 2.2 Commands

```
agentcore start              Start the agent (foreground)
agentcore start --daemon     Start via PM2 (background)
agentcore stop               Stop PM2 process
agentcore status             Show agent status (queries health endpoint)
agentcore onboard            Interactive setup wizard
agentcore config list        Show current config (env vars)
agentcore config set K V     Set an env var in .env
agentcore skill list         List installed skills
agentcore skill install URL  Install a skill from URL
agentcore skill remove NAME  Remove an installed skill
agentcore agent list         List agent profiles
agentcore logs               Tail agent logs (PM2 or stdout)
```

**Implementation:** Simple subcommand routing in `bin/agentcore.js` using `process.argv`. No CLI framework needed initially.

### 2.3 Onboarding Wizard

**File:** `src/cli/onboard-wizard.js`

Interactive step-by-step setup using Node.js `readline`:

```
Welcome to AgentCore!

Step 1/5: LLM Provider
  Choose: [1] Anthropic (recommended) [2] Ollama (local)
  > 1
  Enter your Anthropic API key: sk-ant-...

Step 2/5: Model
  Choose: [1] Claude Sonnet 4 (recommended) [2] Claude Opus 4 [3] Claude Haiku 4.5
  > 1

Step 3/5: Messaging Channel
  Set up Telegram? (y/n): y
  Enter Telegram Bot Token: ...

Step 4/5: Workspace
  Workspace directory [./workspace]: ~/projects

Step 5/5: Security
  Auto-approve all users? (y/n): n
  Master key for dashboard (leave blank to auto-generate): ...

Configuration saved to .env
Run 'agentcore start' to begin!
```

The wizard writes/updates the `.env` file and ensures `data/` and `workspace/` directories exist.

## 3. Skill Marketplace

### 3.1 Skill Installer

**File:** `src/skills/skill-installer.js`
**Class:** `SkillInstaller`

**Interface:**

```js
constructor({ skillsDir, logger })

async installFromUrl(url: string): InstalledSkill
async installFromDir(sourcePath: string): InstalledSkill
uninstall(name: string): boolean
listInstalled(): InstalledSkill[]
getManifest(): SkillManifest
```

**InstalledSkill shape:**

```js
{
  name: string,
  version: string,
  source: string,           // URL or local path
  installedAt: number,
  path: string,             // Local directory
}
```

### 3.2 Installation Sources

| Source | Method | Example |
|--------|--------|---------|
| GitHub URL | Clone repo or download raw file | `https://github.com/user/repo/tree/main/skills/my-skill` |
| GitHub raw URL | Download SKILL.md directly | `https://raw.githubusercontent.com/...` |
| Local directory | Copy files | `./my-local-skill/` |
| Tar/zip archive | Extract to skills dir | `https://example.com/skill.tar.gz` |

**URL resolution heuristic:**

1. If URL ends in `SKILL.md` → download single file, create directory.
2. If URL is a GitHub tree URL → use GitHub API to list files, download each.
3. If URL is a `.tar.gz` or `.zip` → download and extract.
4. Otherwise → attempt `git clone` into a temp dir, copy the skill.

### 3.3 Skill Manifest

**File:** `data/skills-manifest.json`

Tracks installed skills with their source for updates and uninstallation:

```json
{
  "installed": {
    "github": {
      "source": "https://github.com/user/agent-skills/tree/main/github",
      "version": "1.2.0",
      "installedAt": 1711324800000,
      "path": "skills/github"
    }
  }
}
```

### 3.4 Skill Install as Chat Command

The agent itself can install skills when asked:

```
User: "Install the GitHub skill from https://github.com/..."
Agent: [uses run_command tool to run: agentcore skill install <url>]
Agent: "Done! The github skill is now installed. Try /gh to use it."
```

This requires shell tools (Spec 18) to be available.

### 3.5 Security Considerations

- Skills are markdown instructions — they cannot execute code directly.
- However, a malicious skill could instruct the LLM to run dangerous commands.
- **Mitigation:** Log a warning during install: `"Review SKILL.md before enabling. Skills from untrusted sources may instruct the agent to perform harmful actions."`
- Future: Skill signing/verification.

## 4. Dashboard

### 4.1 Web Server Extension

**File:** `src/web/server.js`
**Class:** `DashboardServer` (extends `HealthServer` from Spec 20)

Adds REST API endpoints and static file serving on top of the health endpoint.

**Configuration:**

| Env var | Default | Description |
|---------|---------|-------------|
| `DASHBOARD_ENABLED` | `false` | Enable the dashboard |
| `DASHBOARD_PORT` | (shares `HEALTH_PORT`) | Port (same server) |

### 4.2 REST API Endpoints

All endpoints require `Authorization: Bearer {MASTER_KEY}` header.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/sessions` | List sessions with last activity |
| `GET` | `/api/sessions/:id/messages` | Session message history |
| `GET` | `/api/status` | Extended agent status |
| `GET` | `/api/tools` | Registered tools with schemas |
| `GET` | `/api/skills` | Loaded skills |
| `GET` | `/api/users` | User list with roles |
| `PUT` | `/api/users/:id/role` | Change user role |
| `GET` | `/api/audit` | Audit log (paginated) |
| `GET` | `/api/config` | Current config (secrets redacted) |
| `GET` | `/api/tasks` | Scheduled tasks and status |
| `GET` | `/api/agents` | Agent profiles |

### 4.3 Frontend

**Directory:** `src/web/public/`

Minimal single-page application:

- **`index.html`** — Shell with navigation
- **`app.js`** — Vanilla JS (no framework) for API calls and rendering
- **`style.css`** — Clean, minimal styling

**Pages:**

1. **Status** — Agent health, uptime, active sessions, adapter status
2. **Sessions** — List of recent sessions with message preview
3. **Users** — User list with role management
4. **Tools** — Registered tools with descriptions
5. **Skills** — Installed skills with enable/disable
6. **Audit** — Searchable audit log
7. **Config** — View/edit configuration (with restart prompt)

**Design principles:**
- No build step (vanilla JS, served as static files)
- Works in any modern browser
- Responsive (usable on mobile)
- Dark theme by default

### 4.4 Authentication

All API routes (except `/health`) require the `MASTER_KEY`:

```js
function requireAuth(req, res) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token !== config.masterKey) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return false;
  }
  return true;
}
```

## 5. Design Decisions

| Decision | Rationale |
|----------|-----------|
| No CLI framework | Keeps dependencies minimal. Subcommand routing is trivial with a switch/case. |
| Wizard writes .env file | Consistent with existing config approach. No new config mechanism needed. |
| Manifest in JSON (not DB) | Skills are a file-system concern. JSON is human-readable and git-friendly. |
| URL-based skill install | Simplest distribution mechanism. No registry infrastructure needed. |
| Vanilla JS dashboard | No build step, no framework dependencies. The dashboard is an admin tool, not a user-facing app. |
| Auth via MASTER_KEY | Already exists in config. No new auth mechanism needed. |

## 6. Extension Points

- **Central skill registry:** A hosted API that indexes skills, tracks versions, and verifies authors.
- **Skill auto-update:** Check source URLs for new versions periodically.
- **Dashboard WebSocket:** Real-time updates via EventBus → WebSocket bridge.
- **Remote management:** Dashboard accessible via SSH tunnel or Tailscale for remote agent management.
- **Plugin system:** Beyond skills (markdown), support JS plugins that register tools programmatically.
