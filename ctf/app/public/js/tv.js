const esc = (v) => String(v ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const fmt = (value) => { try { return value ? new Date(String(value).replace(' ', 'T') + (String(value).endsWith('Z') ? '' : 'Z')).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''; } catch { return ''; } };
async function refreshBoard() {
  try {
    const response = await fetch('/api/tv', { cache: 'no-store' }); if (!response.ok) throw new Error('Board unavailable');
    const data = await response.json();
    document.querySelector('#last-updated').textContent = `Updated ${new Date(data.updatedAt).toLocaleTimeString()}`;
    document.querySelector('#tv-challenges').innerHTML = data.challenges.map(c => `
      <article class="tv-challenge ${c.solved ? 'solved' : ''}"><div class="card-top"><span class="challenge-number">CHALLENGE ${String(c.id).padStart(2,'0')}</span><span class="status-pill ${c.solved ? 'solved' : ''}">${c.solved ? 'FIRST PLACE CLAIMED' : 'STILL OPEN'}</span></div>
      <h3>${esc(c.title)}</h3><div>${c.solved ? `<span class="tv-first">★ First: ${esc(c.firstPlace)}</span><span class="muted small-text"> · ${fmt(c.firstSolvedAt)}</span>` : '<span class="tv-open">Waiting for the first flag…</span>'}</div></article>`).join('');
    document.querySelector('#tv-leaderboard').innerHTML = data.leaderboard.length ? data.leaderboard.slice(0, 15).map(r => `<tr><td>${r.rank === 1 ? '★' : r.rank}</td><td><strong>${esc(r.team)}</strong></td><td>${r.solved}/6</td><td>${r.points}</td></tr>`).join('') : '<tr><td colspan="4" class="muted">Standings appear when teams are configured.</td></tr>';
    const ctfdSection = document.querySelector('#ctfd-section');
    if (data.ctfd.configured) {
      ctfdSection.classList.remove('hidden'); const status = document.querySelector('#ctfd-status');
      status.textContent = data.ctfd.ok ? 'CONNECTED' : 'UNAVAILABLE'; status.className = `status-pill ${data.ctfd.ok ? 'solved' : ''}`;
      const raw = data.ctfd.data; const list = Array.isArray(raw) ? raw : (raw?.standings || raw?.scoreboard || raw?.data || []);
      document.querySelector('#ctfd-leaderboard').innerHTML = Array.isArray(list) && list.length ? list.slice(0, 10).map((r, i) => `<tr><td>${esc(r.pos ?? r.rank ?? i + 1)}</td><td>${esc(r.name ?? r.team ?? r.user ?? '—')}</td><td>${esc(r.score ?? r.points ?? '—')}</td></tr>`).join('') : `<tr><td colspan="3" class="muted">${data.ctfd.ok ? 'CTFd returned no visible teams.' : esc(data.ctfd.error || 'Unable to connect.')}</td></tr>`;
    } else { ctfdSection.classList.add('hidden'); }
  } catch (error) { document.querySelector('#last-updated').textContent = 'Waiting for server…'; }
}
refreshBoard(); setInterval(refreshBoard, 5000);
