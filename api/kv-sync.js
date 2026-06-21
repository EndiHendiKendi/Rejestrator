// POST /api/kv-sync { action: 'push', data: {...} }
// GET  /api/kv-sync?action=pull
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if (req.method==='OPTIONS') return res.status(200).end();
  try {
    const { kv } = await import('@vercel/kv');
    if (req.method==='POST') {
      const { action, data } = req.body;
      if (action==='push' && data) {
        await kv.set('app_data', JSON.stringify(data));
        return res.status(200).json({ ok:true });
      }
    }
    if (req.method==='GET') {
      const raw = await kv.get('app_data');
      const data = raw ? (typeof raw==='string' ? JSON.parse(raw) : raw) : null;
      return res.status(200).json({ ok:true, data });
    }
    return res.status(400).json({ error:'Invalid request' });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
