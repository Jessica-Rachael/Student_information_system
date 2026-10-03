// common.js - shared helpers used by every page (API calls, sidebar, top bar, messages).

const MENUS = {
  student: [
    ['/student-dashboard.html', 'Dashboard'],
    ['/student-profile.html', 'My Profile'],
    ['/student-courses.html', 'Courses'],
    ['/student-records.html', 'Attendance & Grades'],
  ],
  faculty: [
    ['/faculty-dashboard.html', 'Dashboard'],
    ['/faculty-attendance.html', 'Mark Attendance'],
    ['/faculty-grades.html', 'Enter Grades'],
  ],
  admin: [
    ['/admin-dashboard.html', 'Dashboard'],
    ['/admin-users.html', 'Manage Users'],
    ['/admin-academics.html', 'Departments & Courses'],
  ],
};

const HOME = {
  student: '/student-dashboard.html',
  faculty: '/faculty-dashboard.html',
  admin: '/admin-dashboard.html',
};

const ROLE_LABEL = { student: 'Student', faculty: 'Faculty', admin: 'Administrator' };

// Sends a request to the backend and returns the JSON response.
async function api(method, url, body) {
  const options = { method, headers: {} };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, options);
  } catch {
    throw new Error('Cannot reach the server. Make sure "npm start" is running in VS Code.');
  }
  let data = {};
  try { data = await res.json(); } catch { /* no JSON body */ }
  if (res.status === 401) {
    location.href = '/index.html';
    throw new Error(data.error || 'Please log in.');
  }
  if (!res.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

// Escapes text before putting it into HTML (prevents broken pages and script injection).
function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Database times are stored in UTC ("YYYY-MM-DD HH:MM:SS").
function fmtDateTime(value) {
  if (!value) return '';
  const d = new Date(value.replace(' ', 'T') + 'Z');
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtDate(value) {
  if (!value) return '';
  const d = new Date(value + 'T00:00:00');
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
function todayISO() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

function badge(status) {
  const text = status.charAt(0).toUpperCase() + status.slice(1);
  return `<span class="badge badge-${esc(status)}">${esc(text)}</span>`;
}

let toastTimer;
function toast(message, isError = false) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

// Reads all named fields of a form into an object.
function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

// Fills a <select> with options. items = [{ id, name }]
function fillSelect(select, items, placeholder) {
  select.innerHTML = (placeholder !== undefined ? `<option value="">${esc(placeholder)}</option>` : '') +
    items.map((i) => `<option value="${esc(i.id)}">${esc(i.name)}</option>`).join('');
}

// Makes tab buttons show / hide their panels.
function setupTabs(onChange) {
  const tabs = document.querySelectorAll('.tab');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => {
        const active = t === tab;
        t.classList.toggle('active', active);
        t.setAttribute('aria-selected', active);
        document.getElementById(t.dataset.panel).hidden = !active;
      });
      if (onChange) onChange(tab.dataset.panel);
    });
  });
}

const BELL_ICON = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>';

// Checks the login, builds the sidebar and top bar, and returns the logged-in user.
// If the user has a different role, they are sent to their own dashboard.
async function initPage(role, title) {
  let me;
  try {
    me = await api('GET', '/api/me');
  } catch {
    return new Promise(() => {}); // redirected to login
  }
  if (me.role !== role) {
    location.href = HOME[me.role];
    return new Promise(() => {});
  }

  const links = MENUS[role].map(([href, label]) => {
    const active = location.pathname === href ? ' class="active" aria-current="page"' : '';
    return `<a href="${href}"${active}>${esc(label)}</a>`;
  }).join('');

  document.getElementById('sidebar').className = 'sidebar';
  document.getElementById('sidebar').innerHTML = `
    <div class="brand"><strong>SIS</strong><span>Student Information System</span></div>
    <nav class="nav" aria-label="Main menu">${links}</nav>
    <button class="btn logout" id="logoutBtn">Log out</button>`;

  const bell = role === 'admin' ? '' : `
    <a class="bell" href="${HOME[role]}#notifications" title="Notifications" aria-label="${me.unread} unread notifications">
      ${BELL_ICON}${me.unread > 0 ? `<span class="count">${me.unread}</span>` : ''}
    </a>`;

  document.getElementById('topbar').className = 'topbar';
  document.getElementById('topbar').innerHTML = `
    <h1>${esc(title)}</h1>
    <div class="who">${bell}
      <span>${esc(me.name)}<br><span class="small">${ROLE_LABEL[role]}</span></span>
      <span class="avatar">${esc(me.name.trim().charAt(0).toUpperCase())}</span>
    </div>`;

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    try { await api('POST', '/api/logout'); } catch { /* ignore */ }
    location.href = '/index.html';
  });

  return me;
}

// Shows notifications inside an element (used on student and faculty dashboards).
async function loadNotifications(listEl, emptyText) {
  const items = await api('GET', '/api/notifications');
  if (items.length === 0) {
    listEl.innerHTML = `<li class="empty">${esc(emptyText)}</li>`;
    return;
  }
  listEl.innerHTML = items.map((n) => `
    <li class="${n.is_read ? '' : 'unread'}">
      <span>${esc(n.message)}</span>
      <span class="muted small">${fmtDateTime(n.created_at)}</span>
    </li>`).join('');
}
