// GET  /api/notifications        — lista powiadomień (do dzwonka w apce)
// POST /api/notifications {action:'done', id}  — oznacz jako zrobione
//
// Dane trzymane w Vercel KV pod kluczem 'notif_inbox' (tablica wpisów).
// Wpisy dodaje api/cron.js przy każdym wysłanym powiadomieniu push.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { kv } = await import('@vercel/kv');

    if (req.method === 'GET') {
      const items = (await kv.get('notif_inbox')) || [];
      return res.status(200).json({ items });
    }

    if (req.method === 'POST') {
      const { action, id } = req.body || {};
      if (action === 'done' && id) {
        const items = (await kv.get('notif_inbox')) || [];
        const updated = items.map(n => n.id === id ? { ...n, done: true, doneAt: Date.now() } : n);
        await kv.set('notif_inbox', updated);
        return res.status(200).json({ ok: true });
      }
      return res.status(400).json({ error: 'Bad request' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
}
