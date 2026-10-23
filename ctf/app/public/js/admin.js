const esc = (v) => String(v ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const dt = (value) => value ? new Date(String(value).replace(' ', 'T') + (String(value).endsWith('Z') ? '' : 'Z')).toLocaleString() : '—';
async function api(url, options = {}) {
  const response = await fetch(url, options); let data = {};
  try { data = await response.json(); } catch {}
  if (response.status === 401) { location.assign('/login'); throw new Error('Please sign in again.'); }
  if (response.status === 403) { location.assign('/challenges'); throw new Error('Administrator access required.'); }
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}
function showMessage(text, type = '') { const el = document.querySelector('#admin-message'); el.className = `form-message global-message ${type}`; el.textContent = text; }
async function loadOverview() {
  const [me, overview, sessions] = await Promise.all([api('/api/me'), api('/api/admin/overview'), api('/api/admin/sessions')]);
  document.querySelector('#admin-name').textContent = me.user.displayName || me.user.username;
  const statGrid = document.querySelector('#stat-grid');
  statGrid.innerHTML = `
    <div class="panel stat-card"><span class="metric-label">ACTIVE SESSIONS</span><strong>${overview.sessions.online}</strong><span class="muted small-text">seen within 90 seconds</span></div>
    <div class="panel stat-card"><span class="metric-label">TEAMS</span><strong>${overview.leaderboard.length}</strong><span class="muted small-text">configured team accounts</span></div>
    <div class="panel stat-card"><span class="metric-label">FIRST PLACES CLAIMED</span><strong>${overview.challenges.filter(c => c.solved).length} / 6</strong><span class="muted small-text">of 6 challenges claimed</span></div>
    <div class="panel stat-card"><span class="metric-label">CTFd CONNECTION</span><strong>${overview.ctfdConfigured ? 'Configured' : 'Off'}</strong><span class="muted small-text">scoreboard fetch only</span></div>`;
  document.querySelector('#admin-challenge-grid').innerHTML = overview.challenges.map(c => {
    const points = (overview.points[c.id] || []).join(', ');
    return `<article class="admin-challenge" data-challenge="${c.id}"><div class="admin-challenge-top"><div><h3>${esc(c.title)}</h3><p class="muted">Challenge ${c.id} · ${c.solved ? `First place: ${esc(c.firstPlace)} · ${dt(c.firstSolvedAt)}` : 'No flags captured yet'}</p></div><span class="status-pill ${c.solved ? 'solved' : ''}">${c.solved ? 'CLAIMED' : 'UNCLAIMED'}</span></div>
    <form class="points-form points-row" data-id="${c.id}"><input name="points" value="${esc(points)}" aria-label="Point schedule for challenge ${c.id}" placeholder="100, 75, 50, 25, 10"><button class="button ghost" type="submit">Save points</button></form>
    <label class="toggle-row"><input class="challenge-toggle" data-id="${c.id}" type="checkbox" ${c.enabled ? 'checked' : ''}> Challenge enabled for teams</label></article>`;
  }).join('');
  const tbody = document.querySelector('#sessions-body');
  tbody.innerHTML = sessions.sessions.length ? sessions.sessions.map(s => `
    <tr><td><span class="${s.online ? 'online-dot' : 'offline-dot'}"></span>${s.revokedAt ? 'Revoked' : s.online ? 'Online' : 'Idle'}</td>
    <td><strong>${esc(s.displayName)}</strong><span class="session-agent">${esc(s.username)} · ${esc(s.role)}</span></td>
    <td>${esc(s.ipAddress)}</td><td><span class="session-agent" title="${esc(s.userAgent)}">${esc(s.userAgent || 'Unknown')}</span></td>
    <td>${dt(s.lastSeenAt)}</td><td>${dt(s.createdAt)}</td>
    <td>${s.revokedAt ? '<span class="muted">—</span>' : `<button class="button ghost table-action danger revoke-session" data-id="${s.id}">Disconnect</button> <button class="button ghost table-action danger revoke-user" data-user-id="${s.userId}" data-name="${esc(s.displayName)}">Revoke team sessions</button>`}</td></tr>`).join('') : '<tr><td colspan="7" class="muted">No sessions recorded yet.</td></tr>';
  const board = document.querySelector('#leaderboard-body');
  board.innerHTML = overview.leaderboard.length ? overview.leaderboard.map(row => `<tr><td>${row.rank}</td><td><strong>${esc(row.team)}</strong></td><td>${row.points}</td><td>${row.solved} / 6</td></tr>`).join('') : '<tr><td colspan="4" class="muted">No team accounts have been created yet.</td></tr>';
}
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
document.querySelector('#load-ctfd-button')?.addEventListener('click', async () => {
  const message = document.querySelector('#ctfd-message'), output = document.querySelector('#ctfd-output'); message.className = 'form-message'; message.textContent = 'Fetching CTFd scoreboard…';
  try { const result = await api('/api/admin/ctfd/scoreboard'); output.textContent = JSON.stringify(result.data, null, 2); output.classList.remove('hidden'); message.className = 'form-message success'; message.textContent = 'CTFd scoreboard loaded. This is a read-only snapshot.'; }
  catch (error) { message.className = 'form-message error'; message.textContent = error.message; }
});
(async () => { try { await loadOverview(); } catch (e) { showMessage(e.message, 'error'); } })();
setInterval(() => { if (!document.hidden) loadOverview().catch(() => {}); }, 15000);
