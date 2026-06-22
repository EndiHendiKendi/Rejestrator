// GET /api/reservations — returns upcoming reservations as JSON for table display
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).end();
  try {
    const { kv } = await import('@vercel/kv');
    const raw = await kv.get('ical_events');
    const events = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
    // Only future + last 7 days, sorted by start
    const now = Date.now() - 7*86400000;
    const upcoming = events
      .filter(e => new Date(e.end).getTime() > now)
      .sort((a,b) => new Date(a.start) - new Date(b.start));
    return res.status(200).json({ ok:true, reservations: upcoming });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
