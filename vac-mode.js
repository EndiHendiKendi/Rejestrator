// POST /api/vac-mode { enabled: true/false }
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if (req.method==='OPTIONS') return res.status(200).end();
  if (req.method!=='POST') return res.status(405).end();
  try {
    const { enabled } = req.body;
    const { kv } = await import('@vercel/kv');
    await kv.set('vac_mode', enabled?'1':'0');
    return res.status(200).json({ ok:true, vac_mode: enabled });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
