const API_KEY = localStorage.getItem('agentcore_key') || prompt('Enter master key:');
if (API_KEY) localStorage.setItem('agentcore_key', API_KEY);

const content = document.getElementById('content');
const navLinks = document.querySelectorAll('nav a[data-page]');

async function api(path) {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${API_KEY}` } });
  if (res.status === 401) { localStorage.removeItem('agentcore_key'); location.reload(); }
  return res.json();
}

function html(strings, ...values) {
  return strings.reduce((r, s, i) => r + s + (values[i] != null ? values[i] : ''), '');
}

function badge(status) {
  const cls = status === 'healthy' || status === 'ok' || status === 'admin' ? 'badge-ok'
    : status === 'degraded' || status === 'user' ? 'badge-warn' : 'badge-err';
  return `<span class="badge ${cls}">${status}</span>`;
}

function formatDate(ts) {
  if (!ts) return '—';
  const d = typeof ts === 'number' && ts < 1e12 ? new Date(ts * 1000) : new Date(ts);
  return d.toLocaleString();
}

// Pages
const pages = {
  async status() {
    const data = await api('/api/status');
    const h = data.health || {};
    content.innerHTML = html`
      <h2>Status</h2>
      <div class="stats">
        <div class="stat"><div class="value">${badge(h.status || 'unknown')}</div><div class="label">Health</div></div>
        <div class="stat"><div class="value">${h.uptime || 0}s</div><div class="label">Uptime</div></div>
        <div class="stat"><div class="value">${h.version || '?'}</div><div class="label">Version</div></div>
        <div class="stat"><div class="value">${h.database || '?'}</div><div class="label">Database</div></div>
      </div>
      <div class="card">
        <h3>Configuration</h3>
        <table>
          ${Object.entries(data.config || {}).map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}
        </table>
      </div>`;
  },

  async sessions() {
    const data = await api('/api/sessions');
    content.innerHTML = html`
      <h2>Sessions</h2>
      <table>
        <thead><tr><th>ID</th><th>User</th><th>Channel</th><th>Last Activity</th></tr></thead>
        <tbody>
          ${data.map(s => `<tr><td>${s.id}</td><td>${s.user_id}</td><td>${s.channel_id}</td><td>${formatDate(s.updated_at)}</td></tr>`).join('')}
        </tbody>
      </table>`;
  },

  async users() {
    const data = await api('/api/users');
    content.innerHTML = html`
      <h2>Users</h2>
      <table>
        <thead><tr><th>ID</th><th>Channel</th><th>Name</th><th>Role</th><th>Created</th></tr></thead>
        <tbody>
          ${data.map(u => `<tr><td>${u.id}</td><td>${u.channel_id}</td><td>${u.display_name || '—'}</td><td>${badge(u.role)}</td><td>${formatDate(u.created_at)}</td></tr>`).join('')}
        </tbody>
      </table>`;
  },

  async tools() {
    const data = await api('/api/tools');
    content.innerHTML = html`
      <h2>Tools (${data.length})</h2>
      <table>
        <thead><tr><th>Name</th><th>Class</th><th>Description</th></tr></thead>
        <tbody>
          ${data.map(t => `<tr><td><strong>${t.name}</strong></td><td>${t.class}</td><td>${t.description}</td></tr>`).join('')}
        </tbody>
      </table>`;
  },

  async skills() {
    const data = await api('/api/skills');
    content.innerHTML = html`
      <h2>Skills (${data.length})</h2>
      ${data.length === 0 ? '<p>No skills loaded.</p>' : ''}
      <table>
        <thead><tr><th>Name</th><th>Trigger</th><th>Description</th></tr></thead>
        <tbody>
          ${data.map(s => `<tr><td><strong>${s.name}</strong></td><td>${s.trigger || '—'}</td><td>${s.description || ''}</td></tr>`).join('')}
        </tbody>
      </table>`;
  },

  async audit() {
    const data = await api('/api/audit');
    content.innerHTML = html`
      <h2>Audit Log (${data.length})</h2>
      <table>
        <thead><tr><th>Time</th><th>Type</th><th>Tool</th><th>User</th><th>Success</th></tr></thead>
        <tbody>
          ${data.map(e => `<tr><td>${formatDate(e.timestamp)}</td><td>${e.event_type}</td><td>${e.tool_name || '—'}</td><td>${e.user_id || '—'}</td><td>${e.success === 1 ? '✓' : e.success === 0 ? '✗' : '—'}</td></tr>`).join('')}
        </tbody>
      </table>`;
  },

  async config() {
    const data = await api('/api/config');
    content.innerHTML = html`
      <h2>Configuration</h2>
      <div class="card">
        <table>
          ${Object.entries(data).map(([k, v]) => `<tr><td>${k}</td><td>${JSON.stringify(v)}</td></tr>`).join('')}
        </table>
      </div>`;
  },
};

// Navigation
navLinks.forEach(link => {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    navLinks.forEach(l => l.classList.remove('active'));
    link.classList.add('active');
    const page = link.dataset.page;
    if (pages[page]) pages[page]().catch(err => {
      content.innerHTML = `<h2>Error</h2><p>${err.message}</p>`;
    });
  });
});

// Initial load
pages.status().catch(() => {
  content.innerHTML = '<h2>Error</h2><p>Failed to load status. Check your master key.</p>';
});
