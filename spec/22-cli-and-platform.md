# Spec 22 — CLI, Skill Marketplace & Dashboard

> Status: **Implemented** | Owner: — | Last updated: 2026-03-25

## 1. Purpose

Provide a command-line interface for managing the agent, a mechanism for installing/managing skills from external sources, and a web dashboard for monitoring and configuration.

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
agentcore config list        Show current config (secrets redacted)
agentcore config set K V     Set an env var in .env
agentcore skill list         List installed skills
agentcore skill install URL  Install a skill from URL
agentcore skill remove NAME  Remove an installed skill
agentcore agent list         List agent profiles
agentcore logs               Tail agent logs (PM2)
agentcore help               Show help
```

**Implementation:** Simple `switch`/`case` routing on `process.argv`. No CLI framework.

### 2.3 Onboarding Wizard

**File:** `src/cli/onboard-wizard.js`
**Class:** `OnboardWizard`

Interactive 5-step setup using Node.js `readline`:

1. **LLM Provider** — Anthropic or Ollama (with API key / host prompt)
2. **Model** — Claude Sonnet 4, Opus 4, or Haiku 4.5 (or Ollama model name)
3. **Messaging** — Optional Telegram bot token
4. **Workspace** — Workspace directory path
5. **Security** — Auto-approve toggle, master key (auto-generated if blank)

Writes/updates `.env` file and ensures `data/`, `workspace/`, `logs/` directories exist.

## 3. Skill Marketplace

### 3.1 Skill Installer

**File:** `src/skills/skill-installer.js`
**Class:** `SkillInstaller`

```js
constructor({ skillsDir, logger })

async installFromUrl(url: string): InstalledSkill
async installFromDir(sourcePath: string): InstalledSkill
uninstall(name: string): boolean
listInstalled(): InstalledSkill[]
getManifest(): SkillManifest
```

### 3.2 Installation Sources

| Source | Method | Status |
|--------|--------|--------|
| GitHub raw URL / URL ending in `SKILL.md` | Download single file, create directory | Implemented |
| Local directory | Copy files | Implemented |
| Git-cloneable URL | `git clone --depth 1`, find SKILL.md | Implemented |
| Tar/zip archive | — | Not yet implemented (throws error) |

**URL resolution:** If URL ends in `SKILL.md` or contains `raw.githubusercontent.com` → raw download. If local path exists → copy. Otherwise → git clone into temp dir.

**Security warning:** On install from URL, logs a warning that skills from untrusted sources may instruct the agent to perform harmful actions.

### 3.3 Skill Manifest

**File:** `data/skills-manifest.json`

Tracks installed skills for updates and uninstallation:

```json
{
  "installed": {
    "github": {
      "source": "https://github.com/user/agent-skills/tree/main/github",
      "version": "1.0.0",
      "installedAt": 1711324800000,
      "path": "skills/github"
    }
  }
}
```

## 4. Dashboard

### 4.1 Web Server

**File:** `src/web/server.js`
**Class:** `DashboardServer` (extends `HealthServer` from Spec 20)

Adds REST API endpoints and static file serving. Enabled via `DASHBOARD_ENABLED=true`. Shares port with the health endpoint.

| Env var | Default | Description |
|---------|---------|-------------|
| `DASHBOARD_ENABLED` | `false` | Enable the dashboard |

### 4.2 REST API Endpoints

All require `Authorization: Bearer {MASTER_KEY}` header.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/status` | Extended agent status with health + config |
| `GET` | `/api/sessions` | List sessions (last 50, from DB) |
| `GET` | `/api/tools` | Registered tools with name, description, class |
| `GET` | `/api/skills` | Loaded skills with name, trigger, description |
| `GET` | `/api/users` | User list with roles (last 100) |
| `GET` | `/api/audit` | Audit log (last 100 entries) |
| `GET` | `/api/config` | Current config (secrets redacted) |
| `GET` | `/api/tasks` | Scheduled tasks and running status |
| `GET` | `/api/agents` | Agent profiles with name, description, model |

### 4.3 Frontend

**Directory:** `src/web/public/`

Minimal single-page application:

- **`index.html`** — Shell with navigation
- **`app.js`** — Vanilla JS for API calls and rendering. Stores master key in `localStorage`.
- **`style.css`** — Dark theme, responsive grid layout

**Pages:** Status, Sessions, Users, Tools, Skills, Audit, Config.

**Design:** No build step, no framework, works in any modern browser, responsive for mobile.

### 4.4 Authentication

All API routes (except `/health`) require the `MASTER_KEY`. The frontend prompts for it on first visit and stores in `localStorage`. 401 responses clear the stored key and reload.

## 5. Design Decisions

| Decision | Rationale |
|----------|-----------|
| No CLI framework | Keeps dependencies minimal. Subcommand routing is trivial. |
| Wizard writes .env file | Consistent with existing config approach. |
| Manifest in JSON (not DB) | Skills are a file-system concern. JSON is human-readable and git-friendly. |
| URL-based skill install | Simplest distribution mechanism. No registry infrastructure needed. |
| Vanilla JS dashboard | No build step, no framework dependencies. Admin tool, not user-facing. |
| Auth via MASTER_KEY | Already exists in config. No new auth mechanism needed. |
| DashboardServer extends HealthServer | Reuses health endpoint infrastructure. Single port. |

## 6. Extension Points

- **`/api/sessions/:id/messages`** — Session message history endpoint (not yet implemented).
- **`PUT /api/users/:id/role`** — Role management via API (not yet implemented).
- **Central skill registry:** A hosted API that indexes skills, tracks versions, and verifies authors.
- **Skill auto-update:** Check source URLs for new versions periodically.
- **Dashboard WebSocket:** Real-time updates via EventBus → WebSocket bridge.
- **Archive install:** Support `.tar.gz` and `.zip` skill archives.
- **Plugin system:** Beyond skills (markdown), support JS plugins that register tools programmatically.
