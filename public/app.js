async function loadStats(){
  try {
    const res = await fetch('/api/stats');
    if (!res.ok) throw new Error('nope');
    const j = await res.json();
    document.getElementById('total').textContent = j.total ?? '0';
    document.getElementById('pending').textContent = j.pending ?? '0';
    document.getElementById('approved').textContent = j.approved ?? '0';
  } catch (e) {
    console.warn('Could not fetch stats', e);
  }
}
document.addEventListener('DOMContentLoaded', () => {
  loadStats();
  setInterval(loadStats, 30000);
});
