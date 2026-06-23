// GET /api/test-push — wysyła JEDNO testowe powiadomienie natychmiast,
// niezależnie od harmonogramu. Zwraca wprost sukces albo dokładny błąd
// (bez wyciszania), żeby raz na zawsze potwierdzić czy push działa.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const { kv } = await import('@vercel/kv');
    const { getSub, sendPush } = await import('./cron.js');

    const sub = await getSub(kv);
    if (!sub || !sub.endpoint) {
      return res.status(200).json({ ok:false, step:'getSub', error:'Brak poprawnej subskrypcji w KV (push_sub puste albo bez endpoint). Włącz powiadomienia w apce.', sub });
    }
    await sendPush(sub, { type:'general', title:'✅ Test push', body:'Jeśli to widzisz — wysyłka działa od A do Z!' });
    return res.status(200).json({ ok:true, msg:'Wysłano. Sprawdź telefon.' });
  } catch (e) {
    return res.status(200).json({ ok:false, step:'send', error: e.message, stack: e.stack });
  }
}
