const esc = (v) => String(v ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const fmt = (value) => { try { return value ? new Date(String(value).replace(' ', 'T') + (String(value).endsWith('Z') ? '' : 'Z')).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''; } catch { return ''; } };
async function refreshBoard() {
  try {
    const response = await fetch('/api/tv', { cache: 'no-store' }); if (!response.ok) throw new Error('Board unavailable');
    const data = await response.json();
    const leaderboard = data.leaderboard.slice(0, 15);
    document.querySelector('.tv-ip').textContent = data.displayText || 'ip';
    document.querySelector('#last-updated').textContent = `Updated ${new Date(data.updatedAt).toLocaleTimeString()}`;
    document.querySelector('#tv-challenges').innerHTML = data.challenges.map(c => `
      <article class="tv-challenge ${c.solved ? 'solved' : ''}"><div class="card-top"><span class="challenge-number">CHALLENGE ${String(c.id).padStart(2,'0')}</span><span class="status-pill ${c.solved ? 'solved' : ''}">${c.solved ? 'FIRST PLACE CLAIMED' : 'STILL OPEN'}</span></div>
      <h2>${esc(c.title)}</h2><div>${c.solved ? '' : '<span class="tv-open">Waiting for the first flag…</span>'}</div></article>`).join('');
    
    document.querySelector('#tv-leaderboard').innerHTML =
        leaderboard.length
            ? leaderboard.map(r => `
        <div class="tv-player">
          <span class="tv-rank">${r.rank === 1 ? '★' : r.rank}</span>
          <strong class="tv-team">${esc(r.team)}</strong>
          <span class="tv-points">${r.points}</span>
        </div>
      `).join('')
            : '<div class="muted">Standings appear when teams are configured.</div>';
  } catch (error) { document.querySelector('#last-updated').textContent = 'Waiting for server…'; }
}
refreshBoard(); setInterval(refreshBoard, 5000);
