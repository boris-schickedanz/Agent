const API_KEY = localStorage.getItem('agentcore_key') || prompt('Enter master key:');
if (API_KEY) localStorage.setItem('agentcore_key', API_KEY);

const content = document.getElementById('content');
const navLinks = document.querySelectorAll('nav a[data-page]');

async function api(path) {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${API_KEY}` } });
  if (res.status === 401) { localStorage.removeItem('agentcore_key'); location.reload(); }
  if (res.status === 404) return null;
  return res.json();
}

function esc(str) {
  if (str == null) return '';
  const d = document.createElement('div');
  d.textContent = String(str);
  return d.innerHTML;
}

function badge(status) {
  const cls = status === 'healthy' || status === 'ok' || status === 'admin' ? 'badge-ok'
    : status === 'degraded' || status === 'user' ? 'badge-warn' : 'badge-err';
  return `<span class="badge ${cls}">${esc(status)}</span>`;
}

function roleBadge(role) {
  const colors = { user: 'badge-role-user', assistant: 'badge-role-assistant', system: 'badge-role-system' };
  return `<span class="badge ${colors[role] || 'badge-warn'}">${esc(role)}</span>`;
}

function formatDate(ts) {
  if (!ts) return '—';
  const d = typeof ts === 'number' && ts < 1e12 ? new Date(ts * 1000) : new Date(ts);
  return d.toLocaleString();
}

function formatContent(content) {
  if (typeof content === 'string') return esc(content);
  if (Array.isArray(content)) {
    return content.map(block => {
      if (block.type === 'text') return esc(block.text);
      if (block.type === 'tool_use') return `<div class="tool-call"><strong>${esc(block.name)}</strong><pre>${esc(JSON.stringify(block.input, null, 2))}</pre></div>`;
      if (block.type === 'tool_result') {
        const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content, null, 2);
        return `<div class="tool-result"><pre>${esc(text.substring(0, 2000))}${text.length > 2000 ? '\n...[truncated]' : ''}</pre></div>`;
      }
      return `<pre>${esc(JSON.stringify(block, null, 2))}</pre>`;
    }).join('');
  }
  return `<pre>${esc(JSON.stringify(content, null, 2))}</pre>`;
}

// Navigate to a page (used by clickable elements)
function navigate(page, ...args) {
  navLinks.forEach(l => l.classList.remove('active'));
  const link = document.querySelector(`nav a[data-page="${page}"]`);
  if (link) link.classList.add('active');
  if (pages[page]) pages[page](...args).catch(err => {
    content.innerHTML = `<h2>Error</h2><p>${esc(err.message)}</p>`;
  });
}

// Pages
const pages = {
  async status() {
    const data = await api('/api/status');
    const h = data.health || {};
    content.innerHTML = `
      <h2>Status</h2>
      <div class="stats">
        <div class="stat"><div class="value">${badge(h.status || 'unknown')}</div><div class="label">Health</div></div>
        <div class="stat"><div class="value">${esc(h.uptime || 0)}s</div><div class="label">Uptime</div></div>
        <div class="stat"><div class="value">${esc(h.version || '?')}</div><div class="label">Version</div></div>
        <div class="stat"><div class="value">${esc(h.database || '?')}</div><div class="label">Database</div></div>
      </div>
      <div class="card">
        <h3>Configuration</h3>
        <table>
          ${Object.entries(data.config || {}).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}
        </table>
      </div>`;
  },

  async project() {
    const data = await api('/api/workspace-state');
    const renderCard = (title, key, content) => {
      if (!content) return `<div class="card"><h3>${esc(title)}</h3><p class="muted">Not initialized</p></div>`;
      return `<div class="card"><h3>${esc(title)}</h3><pre class="memory-content">${esc(content)}</pre></div>`;
    };
    content.innerHTML = `
      <h2>Project State</h2>
      ${renderCard('Project State', 'project_state', data.project_state)}
      ${renderCard('Decision Journal', 'decision_journal', data.decision_journal)}
      ${renderCard('Session Log', 'session_log', data.session_log)}`;
  },

  async sessions() {
    const data = await api('/api/sessions');
    content.innerHTML = `
      <h2>Sessions</h2>
      <table>
        <thead><tr><th>ID</th><th>User</th><th>Channel</th><th>Last Activity</th></tr></thead>
        <tbody>
          ${data.map(s => `<tr class="clickable-row" onclick="navigate('sessionDetail', '${esc(s.id)}')"><td>${esc(s.id)}</td><td>${esc(s.user_id)}</td><td>${esc(s.channel_id)}</td><td>${formatDate(s.updated_at)}</td></tr>`).join('')}
        </tbody>
      </table>`;
  },

  async sessionDetail(sessionId) {
    const messages = await api(`/api/sessions/${encodeURIComponent(sessionId)}/messages`);
    const msgHtml = (messages || []).map(m => `
      <div class="message message-${esc(m.role)}">
        <div class="message-header">
          ${roleBadge(m.role)}
          <span class="message-time">${formatDate(m.created_at)}</span>
          ${m.token_estimate ? `<span class="muted">${m.token_estimate} tokens</span>` : ''}
        </div>
        <div class="message-body">${formatContent(m.content)}</div>
      </div>
    `).join('');

    content.innerHTML = `
      <a href="#" class="back-link" onclick="event.preventDefault(); navigate('sessions')">← Back to Sessions</a>
      <h2>Session: ${esc(sessionId)}</h2>
      <p class="muted">${(messages || []).length} messages</p>
      <div class="message-list">${msgHtml || '<p class="muted">No messages in this session.</p>'}</div>`;
  },

  async users() {
    const data = await api('/api/users');
    content.innerHTML = `
      <h2>Users</h2>
      <table>
        <thead><tr><th>ID</th><th>Channel</th><th>Name</th><th>Role</th><th>Created</th></tr></thead>
        <tbody>
          ${data.map(u => `<tr class="clickable-row" onclick="navigate('userDetail', '${esc(u.id)}', '${esc(u.display_name || u.id)}')"><td>${esc(u.id)}</td><td>${esc(u.channel_id)}</td><td>${esc(u.display_name || '—')}</td><td>${badge(u.role)}</td><td>${formatDate(u.created_at)}</td></tr>`).join('')}
        </tbody>
      </table>`;
  },

  async userDetail(userId, displayName) {
    const allSessions = await api('/api/sessions');
    const userSessions = (allSessions || []).filter(s => s.user_id === userId);
    content.innerHTML = `
      <a href="#" class="back-link" onclick="event.preventDefault(); navigate('users')">← Back to Users</a>
      <h2>User: ${esc(displayName || userId)}</h2>
      <p class="muted">${userSessions.length} sessions</p>
      <table>
        <thead><tr><th>Session ID</th><th>Channel</th><th>Last Activity</th></tr></thead>
        <tbody>
          ${userSessions.map(s => `<tr class="clickable-row" onclick="navigate('sessionDetail', '${esc(s.id)}')"><td>${esc(s.id)}</td><td>${esc(s.channel_id)}</td><td>${formatDate(s.updated_at)}</td></tr>`).join('')}
        </tbody>
      </table>`;
  },

  async memory() {
    const keys = await api('/api/memory');
    const wsKeys = ['project_state', 'decision_journal', 'session_log'];
    content.innerHTML = `
      <h2>Memory (${(keys || []).length} keys)</h2>
      ${(!keys || keys.length === 0) ? '<p class="muted">No memories stored yet.</p>' : ''}
      <div class="memory-list">
        ${(keys || []).map(k => `
          <div class="memory-item clickable-row" onclick="navigate('memoryDetail', '${esc(k)}')">
            <span class="memory-key">${esc(k)}</span>
            ${wsKeys.includes(k) ? '<span class="badge badge-ok">workspace</span>' : ''}
          </div>
        `).join('')}
      </div>`;
  },

  async memoryDetail(key) {
    const data = await api(`/api/memory/${encodeURIComponent(key)}`);
    content.innerHTML = `
      <a href="#" class="back-link" onclick="event.preventDefault(); navigate('memory')">← Back to Memory</a>
      <h2>Memory: ${esc(key)}</h2>
      <div class="card">
        ${data ? `<pre class="memory-content">${esc(data.content)}</pre>` : '<p class="muted">Memory key not found.</p>'}
      </div>`;
  },

  async tools() {
    const data = await api('/api/tools');
    content.innerHTML = `
      <h2>Tools (${data.length})</h2>
      <table>
        <thead><tr><th>Name</th><th>Class</th><th>Description</th></tr></thead>
        <tbody>
          ${data.map(t => `<tr><td><strong>${esc(t.name)}</strong></td><td>${esc(t.class)}</td><td>${esc(t.description)}</td></tr>`).join('')}
        </tbody>
      </table>`;
  },

  async skills() {
    const data = await api('/api/skills');
    content.innerHTML = `
      <h2>Skills (${data.length})</h2>
      ${data.length === 0 ? '<p>No skills loaded.</p>' : ''}
      <table>
        <thead><tr><th>Name</th><th>Trigger</th><th>Description</th></tr></thead>
        <tbody>
          ${data.map(s => `<tr><td><strong>${esc(s.name)}</strong></td><td>${esc(s.trigger || '—')}</td><td>${esc(s.description || '')}</td></tr>`).join('')}
        </tbody>
      </table>`;
  },

  async audit() {
    const data = await api('/api/audit');
    content.innerHTML = `
      <h2>Audit Log (${data.length})</h2>
      <table>
        <thead><tr><th>Time</th><th>Type</th><th>Tool</th><th>User</th><th>Success</th></tr></thead>
        <tbody>
          ${data.map(e => `<tr><td>${formatDate(e.timestamp)}</td><td>${esc(e.event_type)}</td><td>${esc(e.tool_name || '—')}</td><td>${esc(e.user_id || '—')}</td><td>${e.success === 1 ? '✓' : e.success === 0 ? '✗' : '—'}</td></tr>`).join('')}
        </tbody>
      </table>`;
  },

  async config() {
    const data = await api('/api/config');
    content.innerHTML = `
      <h2>Configuration</h2>
      <div class="card">
        <table>
          ${Object.entries(data).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(JSON.stringify(v))}</td></tr>`).join('')}
        </table>
      </div>`;
  },
};

// Navigation
navLinks.forEach(link => {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    navigate(link.dataset.page);
  });
});

// Initial load
pages.status().catch(() => {
  content.innerHTML = '<h2>Error</h2><p>Failed to load status. Check your master key.</p>';
});
