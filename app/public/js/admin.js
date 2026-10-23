const esc = (v) => String(v ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const dt = (value) => value ? new Date(String(value).replace(' ', 'T') + (String(value).endsWith('Z') ? '' : 'Z')).toLocaleString() : '—';
function ago(minutes) {
  const value = Math.max(0, Number(minutes) || 0);
  if (value < 1) return 'less than 1 min';
  if (value < 60) return `${value} min`;
  const hours = Math.floor(value / 60), mins = value % 60;
  if (hours < 24) return mins ? `${hours}h ${mins}m` : `${hours}h`;
  const days = Math.floor(hours / 24), restHours = hours % 24;
  return restHours ? `${days}d ${restHours}h` : `${days}d`;
}
async function api(url, options = {}) {
  const response = await fetch(url, options); let data = {};
  try { data = await response.json(); } catch {}
  if (response.status === 401) { location.assign('/login'); throw new Error('Please sign in again.'); }
  if (response.status === 403 && url.startsWith('/api/admin/')) { location.assign('/challenges'); throw new Error('Administrator access required.'); }
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}
function showMessage(text, type = '') { const el = document.querySelector('#admin-message'); el.className = `form-message global-message ${type}`; el.textContent = text; }
function renderChallenges(overview) {
  document.querySelector('#admin-challenge-grid').innerHTML = overview.challenges.map(c => {
    const points = (overview.points[c.id] || []).join(', ');
    return `<article class="admin-challenge" data-challenge="${c.id}"><div class="admin-challenge-top"><div><h3>${esc(c.title)}</h3><p class="muted">Challenge ${c.id} · ${c.solved ? `First place: ${esc(c.firstPlace)} · ${dt(c.firstSolvedAt)}` : 'No flags captured yet'}</p></div><span class="status-pill ${c.solved ? 'solved' : ''}">${c.solved ? 'CLAIMED' : 'UNCLAIMED'}</span></div>
    <form class="points-form points-row" data-id="${c.id}"><input name="points" value="${esc(points)}" aria-label="Point schedule for challenge ${c.id}" placeholder="100, 75, 50, 25, 10"><button class="button ghost" type="submit">Save points</button></form>
    <label class="toggle-row"><input class="challenge-toggle" data-id="${c.id}" type="checkbox" ${c.enabled ? 'checked' : ''}> Challenge enabled for teams</label></article>`;
  }).join('');
}
function renderTeamStates(teams) {
  const tbody = document.querySelector('#team-states-body');
  tbody.innerHTML = teams.length ? teams.map(team => {
    const state = team.disqualified
      ? `<span class="status-pill status-disqualified">DISQUALIFIED</span><span class="session-agent">${esc(team.disqualificationReason || 'No reason recorded')}</span>`
      : team.onlinePeople > 0
        ? '<span class="status-pill status-active">ACTIVE · ONLINE</span>'
        : '<span class="status-pill status-offline">ACTIVE · OFFLINE</span>';
    const connectLabel = `${team.onlinePeople} / 3`;
    const connectClass = team.onlinePeople > 3 ? 'warning-text' : 'muted';
    const action = team.disqualified
      ? '<span class="muted small-text">Already disqualified</span>'
      : `<button class="button ghost table-action danger disqualify-team" data-id="${team.teamId}" data-name="${esc(team.team)}" data-points="${team.points}" data-flags="${team.solved}">Disqualify</button>`;
    return `<tr><td>${state}</td><td><strong>${esc(team.team)}</strong></td><td>${team.points}</td><td>${team.solved} / 6</td><td><span class="${connectClass}">${connectLabel}</span>${team.onlinePeople > 3 ? '<span class="session-agent warning-text">Review: over limit</span>' : ''}</td><td>${action}</td></tr>`;
  }).join('') : '<tr><td colspan="6" class="muted">No team accounts have been created yet.</td></tr>';
}
function renderPeople(people) {
  const tbody = document.querySelector('#people-body');
  tbody.innerHTML = people.length ? people.map(person => {
    const status = person.online
      ? `<span class="state-online"><span class="online-dot"></span>Online</span><span class="session-agent">${person.onlineSessions} active session${person.onlineSessions === 1 ? '' : 's'}</span>`
      : `<span class="${person.longDisconnectWarning ? 'warning-text' : 'state-offline'}"><span class="offline-dot"></span>Offline</span><span class="session-agent">${ago(person.disconnectedMinutes)} ago${person.longDisconnectWarning ? ' · prolonged disconnect' : ''}</span>`;
    const labels = [person.newIpAlert ? '<span class="mini-warning">NEW IP REVIEW</span>' : '', person.longDisconnectWarning ? '<span class="mini-warning">OFFLINE 5M+</span>' : ''].filter(Boolean).join(' ');
    return `<tr class="${person.newIpAlert || person.longDisconnectWarning ? 'row-warning' : ''}">
      <td><strong>${esc(person.teamName)}</strong>${person.teamDisqualified ? '<span class="session-agent warning-text">Disqualified team</span>' : ''}</td>
      <td><strong>${esc(person.label)}</strong>${labels ? `<span class="session-agent">${labels}</span>` : ''}</td>
      <td><code>${esc(person.ipAddress)}</code></td><td>${status}</td>
      <td>${dt(person.lastSeenAt)}</td><td>${person.sessionCount}</td>
      <td><span class="session-agent user-agent-cell" title="${esc(person.userAgent)}">${esc(person.userAgent || 'Unknown')}</span></td>
      <td><button class="button ghost table-action view-person-log" data-id="${person.id}" data-name="${esc(person.teamName)} · ${esc(person.label)}">View log</button></td>
    </tr>`;
  }).join('') : '<tr><td colspan="8" class="muted">No team IP identities have been tracked yet. They will appear after a team logs in.</td></tr>';
}
function renderAlerts(teamStates, people) {
  const alerts = [];
  for (const team of teamStates) {
    if (team.onlinePeople > 3) alerts.push({ type: 'warning', text: `${team.team}: ${team.onlinePeople} unique team/IP identities currently online (threshold: 3). Review the connections manually; no automatic action has been taken.` });
  }
  for (const person of people) {
    if (person.newIpAlert) alerts.push({ type: 'warning', text: `${person.teamName} · ${person.label}: a new IP was observed at ${dt(person.newIpAt)}. It could be an IP change or a different person; verify manually. No automatic action was taken.` });
  }
  for (const person of people) {
    if (person.longDisconnectWarning) alerts.push({ type: 'warning', text: `${person.teamName} · ${person.label} has been disconnected/inactive for ${ago(person.disconnectedMinutes)} (IP ${person.ipAddress}).` });
  }
  const el = document.querySelector('#connection-alerts');
  if (!alerts.length) {
    el.innerHTML = '<p class="muted small-text">No current connection warnings. Online status uses activity within the last 90 seconds; prolonged-disconnect warnings start after 5 minutes.</p>';
    return;
  }
  const maxVisible = 24;
  el.innerHTML = alerts.slice(0, maxVisible).map(a => `<div class="notice alert-notice"><strong>ADMIN REVIEW</strong> ${esc(a.text)}</div>`).join('')
    + (alerts.length > maxVisible ? `<p class="muted small-text">Showing ${maxVisible} of ${alerts.length} warnings. Review the tracked identities below for the full list.</p>` : '');
}
function renderSessions(sessions) {
  const tbody = document.querySelector('#sessions-body');
  tbody.innerHTML = sessions.length ? sessions.map(s => `
    <tr><td><span class="${s.online ? 'online-dot' : 'offline-dot'}"></span>${s.revokedAt ? 'Revoked' : s.online ? 'Online' : 'Idle'}</td>
    <td><strong>${esc(s.displayName)}</strong><span class="session-agent">${esc(s.username)} · ${esc(s.role)}</span></td>
    <td>${s.personLabel ? `<strong>${esc(s.personLabel)}</strong>` : '<span class="muted">—</span>'}</td>
    <td><code>${esc(s.ipAddress)}</code></td><td><span class="session-agent user-agent-cell" title="${esc(s.userAgent)}">${esc(s.userAgent || 'Unknown')}</span></td>
    <td>${dt(s.lastSeenAt)}</td><td>${dt(s.createdAt)}</td>
    <td>${s.revokedAt ? '<span class="muted">—</span>' : `<button class="button ghost table-action danger revoke-session" data-id="${s.id}">Disconnect</button> ${s.role === 'team' ? `<button class="button ghost table-action danger revoke-user" data-user-id="${s.userId}" data-name="${esc(s.displayName)}">Revoke team sessions</button>` : ''}`}</td></tr>`).join('') : '<tr><td colspan="8" class="muted">No sessions recorded yet.</td></tr>';
}
function renderLeaderboard(board) {
  const tbody = document.querySelector('#leaderboard-body');
  tbody.innerHTML = board.length ? board.map(row => `<tr><td>${row.rank}</td><td><strong>${esc(row.team)}</strong></td><td>${row.points}</td><td>${row.solved} / 6</td></tr>`).join('') : '<tr><td colspan="4" class="muted">No eligible team accounts have been created yet.</td></tr>';
}
async function loadOverview() {
  const [me, overview, sessions, tracked] = await Promise.all([
    api('/api/me'), api('/api/admin/overview'), api('/api/admin/sessions'), api('/api/admin/people'),
  ]);
  document.querySelector('#admin-name').textContent = me.user.displayName || me.user.username;
  const statGrid = document.querySelector('#stat-grid');
  statGrid.innerHTML = `
    <div class="panel stat-card"><span class="metric-label">ACTIVE SESSIONS</span><strong>${overview.sessions.online}</strong><span class="muted small-text">last 90 seconds</span></div>
    <div class="panel stat-card"><span class="metric-label">TEAMS</span><strong>${overview.teamStates.length}</strong><span class="muted small-text">including disqualified teams</span></div>
    <div class="panel stat-card"><span class="metric-label">FIRST FLAGS CAPTURED</span><strong>${overview.challenges.filter(c => c.solved).length} / 6</strong><span class="muted small-text">eligible teams only</span></div>`;
  const textInput = document.querySelector('#tv-display-text');
  if (textInput && document.activeElement !== textInput && !textInput.dataset.loaded) {
    textInput.value = overview.tvDisplayText || '';
    textInput.dataset.loaded = 'true';
  }
  renderChallenges(overview);
  renderTeamStates(overview.teamStates || []);
  renderPeople(tracked.people || []);
  renderAlerts(overview.teamStates || [], tracked.people || []);
  renderSessions(sessions.sessions || []);
  renderLeaderboard(overview.leaderboard || []);
}
document.querySelector('#tv-display-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = document.querySelector('#tv-display-text');
  const text = input.value.trim();
  try {
    const result = await api('/api/admin/tv-display-text', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
    });
    input.value = result.text; input.dataset.loaded = 'true';
    showMessage('TV display text saved.', 'success');
  } catch (error) { showMessage(error.message, 'error'); }
});
document.querySelector('#admin-challenge-grid')?.addEventListener('submit', async (event) => {
  const form = event.target.closest('.points-form'); if (!form) return;
  event.preventDefault(); const id = form.dataset.id;
  const points = form.elements.points.value.split(',').map(s => s.trim()).filter(Boolean).map(Number);
  try { await api(`/api/admin/challenges/${id}/points`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ points }) }); showMessage(`Point schedule saved for challenge ${id}.`, 'success'); await loadOverview(); }
  catch (error) { showMessage(error.message, 'error'); }
});
document.querySelector('#admin-challenge-grid')?.addEventListener('change', async (event) => {
  const checkbox = event.target.closest('.challenge-toggle'); if (!checkbox) return;
  try { await api(`/api/admin/challenges/${checkbox.dataset.id}/enabled`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: checkbox.checked }) }); showMessage(`Challenge ${checkbox.dataset.id} ${checkbox.checked ? 'enabled' : 'disabled'}.`, 'success'); }
  catch (error) { showMessage(error.message, 'error'); checkbox.checked = !checkbox.checked; }
});
document.querySelector('#team-states-body')?.addEventListener('click', async (event) => {
  const button = event.target.closest('.disqualify-team'); if (!button) return;
  const teamName = button.dataset.name;
  const points = Number(button.dataset.points || 0), flags = Number(button.dataset.flags || 0);
  const confirmed = confirm(`DISQUALIFY ${teamName}?\n\nThis will exclude ${points} points and ${flags} captures, remove the team from the leaderboard and first-capture claims, promote the earliest remaining eligible team for each affected flag, recalculate eligible placements/points, disconnect its sessions, and block future logins. Original capture order remains in audit data.\n\nThis action cannot be undone from this panel.`);
  if (!confirmed) return;
  button.disabled = true;
  try {
    const result = await api(`/api/admin/teams/${button.dataset.id}/disqualify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'Disqualified by administrator.' }),
    });
    showMessage(`${result.team} disqualified. ${result.pointsRemoved} points excluded; ${result.capturesExcluded} captures excluded; ${result.placementsAdjusted || 0} remaining capture result(s) re-ranked/re-scored.`, 'success');
    await loadOverview();
  } catch (error) { button.disabled = false; showMessage(error.message, 'error'); }
});
document.querySelector('#people-body')?.addEventListener('click', async (event) => {
  const button = event.target.closest('.view-person-log'); if (!button) return;
  const dialog = document.querySelector('#person-log-dialog');
  const tbody = document.querySelector('#person-log-body');
  document.querySelector('#person-log-title').textContent = `${button.dataset.name} — activity log`;
  document.querySelector('#person-log-meta').textContent = 'Loading activity…';
  tbody.innerHTML = '<tr><td colspan="5" class="muted">Loading activity…</td></tr>';
  if (!dialog.open) dialog.showModal();
  try {
    const data = await api(`/api/admin/people/${button.dataset.id}/logs`);
    document.querySelector('#person-log-meta').textContent = `${data.person.teamName} · ${data.person.label} · IP ${data.person.ipAddress} · first seen ${dt(data.person.firstSeenAt)}`;
    tbody.innerHTML = data.logs.length ? data.logs.map(log => `<tr><td>${dt(log.createdAt)}</td><td><strong>${esc(log.eventType.replaceAll('_', ' '))}</strong><span class="session-agent">Session ${log.sessionId ?? '—'}</span></td><td class="log-details">${esc(log.details)}</td><td><code>${esc(log.ipAddress)}</code></td><td><span class="session-agent user-agent-cell" title="${esc(log.userAgent)}">${esc(log.userAgent || 'Unknown')}</span></td></tr>`).join('') : '<tr><td colspan="5" class="muted">No actions have been recorded for this identity yet.</td></tr>';
  } catch (error) {
    document.querySelector('#person-log-meta').textContent = error.message;
    tbody.innerHTML = '<tr><td colspan="5" class="muted">Unable to load activity.</td></tr>';
  }
});
document.querySelector('#close-person-log')?.addEventListener('click', () => document.querySelector('#person-log-dialog')?.close());
document.querySelector('#sessions-body')?.addEventListener('click', async (event) => {
  const one = event.target.closest('.revoke-session'); const all = event.target.closest('.revoke-user');
  try {
    if (one) { await api(`/api/admin/sessions/${one.dataset.id}/revoke`, { method: 'POST' }); showMessage('Login session disconnected.', 'success'); }
    else if (all) { if (!confirm(`Revoke all active sessions for ${all.dataset.name}?`)) return; const result = await api(`/api/admin/users/${all.dataset.userId}/revoke-sessions`, { method: 'POST' }); showMessage(`Revoked ${result.revoked} session(s) for ${all.dataset.name}.`, 'success'); }
    else return;
    await loadOverview();
  } catch (error) { showMessage(error.message, 'error'); }
});
document.querySelector('#refresh-button')?.addEventListener('click', () => loadOverview().catch(e => showMessage(e.message, 'error')));
document.querySelector('#logout-button')?.addEventListener('click', async () => { await fetch('/api/logout', { method: 'POST' }); location.assign('/login'); });
(async () => { try { await loadOverview(); } catch (e) { showMessage(e.message, 'error'); } })();
setInterval(() => { if (!document.hidden) loadOverview().catch(() => {}); }, 15000);
