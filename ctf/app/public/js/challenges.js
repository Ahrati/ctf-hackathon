const grid = document.querySelector('#challenge-grid');
const detail = document.querySelector('#challenge-detail');
const userLabel = document.querySelector('#current-user');
const progress = document.querySelector('#progress-count');
const pathMatch = location.pathname.match(/^\/challenges\/([1-6])$/);
const selectedId = pathMatch ? Number(pathMatch[1]) : null;
let activeChallenge = null;
let ownSolves = new Map();

function esc(value) { return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }
function message(text, type = '') { const el = document.querySelector('#flag-message'); el.className = `form-message ${type}`; el.textContent = text; }
async function api(url, options = {}) {
  const response = await fetch(url, options);
  let data = {};
  try { data = await response.json(); } catch {}
  if (response.status === 401) { location.assign('/login'); throw new Error('Please sign in again.'); }
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}
async function loadMe() {
  const data = await api('/api/me');
  userLabel.textContent = data.user.displayName || data.user.username;
  if (data.user.role !== 'team') location.assign('/admin');
}
async function loadGrid() {
  const data = await api('/api/challenges');
  const challenges = data.challenges || [];
  ownSolves = new Map(challenges.filter(c => c.solve).map(c => [c.id, c.solve]));
  progress.textContent = `${ownSolves.size} / 6`;
  grid.innerHTML = challenges.map(c => `
    <a class="challenge-card ${c.solve ? 'solved' : ''}" href="/challenges/${c.id}">
      <div class="card-top"><span class="challenge-number">CHALLENGE ${String(c.id).padStart(2,'0')}</span><span class="status-pill ${c.solve ? 'solved' : ''}">${c.solve ? 'CAPTURED' : (c.enabled ? 'OPEN' : 'PAUSED')}</span></div>
      <h3>${esc(c.title)}</h3>
      <div class="card-footer"><span>${c.solve ? `Place #${c.solve.placement}` : 'Flag capture required'}</span><span>${c.solve ? `+${c.solve.points} pts` : 'Open task →'}</span></div>
    </a>`).join('');
  if (selectedId) await loadChallenge(selectedId);
}
async function loadChallenge(id) {
  const data = await api(`/api/challenges/${id}`);
  activeChallenge = data.challenge;
  detail.classList.remove('hidden');
  document.querySelector('#challenge-label').textContent = `CHALLENGE ${String(id).padStart(2,'0')}`;
  document.querySelector('#challenge-title').textContent = activeChallenge.title;
  document.querySelector('#challenge-data').textContent = activeChallenge.data;
  const file = document.querySelector('#challenge-file');
  if (activeChallenge.file) { file.href = activeChallenge.file; file.classList.remove('hidden'); }
  else file.classList.add('hidden');
  const solve = data.solve || ownSolves.get(id);
  const status = document.querySelector('#challenge-status');
  const submitButton = document.querySelector('#submit-flag');
  const flagInput = document.querySelector('#flag-input');
  const summary = document.querySelector('#solve-summary');
  if (solve) {
    status.textContent = 'CAPTURED'; status.className = 'status-pill solved';
    summary.textContent = `Team captured this flag in place #${solve.placement}, earning ${solve.points} points.`;
    summary.classList.remove('hidden'); flagInput.disabled = true; submitButton.disabled = true; message('This challenge is already solved by your team.', 'success');
  } else {
    status.textContent = 'OPEN'; status.className = 'status-pill';
    summary.classList.add('hidden'); flagInput.disabled = false; submitButton.disabled = false; message('');
  }
}
document.querySelector('#flag-form')?.addEventListener('submit', async (event) => {
  event.preventDefault(); if (!activeChallenge) return;
  const flagInput = document.querySelector('#flag-input'); const button = document.querySelector('#submit-flag');
  button.disabled = true; message('Checking flag…');
  try {
    const result = await api(`/api/challenges/${activeChallenge.id}/submit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ flag: flagInput.value.trim() }) });
    if (!result.correct) { message(result.error || 'Incorrect flag. Try again.', 'error'); return; }
    let statusMessage = result.alreadySolved ? 'Your team has already captured this flag.' : (result.message || 'Correct flag.');
    if (result.ctfdSync?.configured) {
      statusMessage += result.ctfdSync.ok ? ` ${result.ctfdSync.message}` : ` CTFd sync warning: ${result.ctfdSync.message}`;
    }
    await loadGrid(); await loadChallenge(activeChallenge.id);
    message(statusMessage, 'success');
  } catch (error) { message(error.message || 'Unable to submit flag.', 'error'); }
  finally { if (!ownSolves.has(activeChallenge?.id)) button.disabled = false; }
});
document.querySelector('#logout-button')?.addEventListener('click', async () => { await fetch('/api/logout', { method: 'POST' }); location.assign('/login'); });
(async () => { try { await loadMe(); await loadGrid(); } catch (error) { if (error.message) console.error(error); } })();
setInterval(() => { if (!document.hidden) loadMe().catch(() => {}); }, 30000);
