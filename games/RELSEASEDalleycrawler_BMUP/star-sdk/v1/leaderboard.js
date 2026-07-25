const STORAGE_KEY = 'goon-local-leaderboard';
const MAX_ENTRIES = 10;

function loadEntries() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    return [];
  }
}

function saveEntries(entries) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch (err) {
    // ignore
  }
}

function formatEntries(entries) {
  return entries.map((entry, idx) => {
    const date = new Date(entry.date);
    const dateStr = Number.isNaN(date.getTime()) ? entry.date : date.toLocaleDateString();
    return `${idx + 1}. ${entry.score} — ${dateStr}`;
  }).join('\n');
}

export function createLeaderboard() {
  return {
    submit(score) {
      if (typeof score !== 'number' || score <= 0) return;
      const entries = loadEntries();
      entries.push({ score, date: new Date().toISOString() });
      entries.sort((a, b) => b.score - a.score);
      saveEntries(entries);
    },
    show() {
      const entries = loadEntries();
      if (!entries.length) {
        alert('No leaderboard entries yet.');
        return;
      }
      alert(`LOCAL LEADERBOARD\n\n${formatEntries(entries)}`);
    },
  };
}
