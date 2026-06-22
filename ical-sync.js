// POST /api/ical-sync  { icalUrl }
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { icalUrl } = req.body;
    if (!icalUrl) return res.status(400).json({ error: 'Missing icalUrl' });
    const resp = await fetch(icalUrl);
    if (!resp.ok) throw new Error('iCal fetch failed: ' + resp.status);
    const text = await resp.text();
    const events = parseIcal(text);
    const now = Date.now();

    const schedule = [];
    for (const ev of events) {
      const start = new Date(ev.start).getTime();
      const end   = new Date(ev.end).getTime();
      if (isNaN(start)||isNaN(end)) continue;

      // Check-in day 17:00
      const ci = new Date(ev.start); ci.setHours(17,0,0,0);
      if (ci.getTime() > now) schedule.push({ type:'checkin', fireAt:ci.getTime(), uid:ev.uid,
        title:'🏠 Zameldowanie dzisiaj!',
        body:`${ev.summary||'Goście'} przyjeżdżają dziś. Przygotuj dom i klucze.` });

      // Check-in day 10:00 — harmonogram
      const hi = new Date(ev.start); hi.setHours(10,0,0,0);
      if (hi.getTime() > now) schedule.push({ type:'harmonogram_in', fireAt:hi.getTime(), uid:ev.uid,
        title:'💡 Harmonogram + ciepła woda',
        body:`Dziś przyjeżdżają ${ev.summary||'goście'}. Ustaw pompę, ledy i podgrzewacz.` });

      // Check-out day 10:00 — harmonogram
      const ho = new Date(ev.end); ho.setHours(10,0,0,0);
      if (ho.getTime() > now) schedule.push({ type:'harmonogram_out', fireAt:ho.getTime(), uid:ev.uid,
        title:'💡 Harmonogram + ciepła woda',
        body:`Dziś wyjeżdżają ${ev.summary||'goście'}. Przestaw pompę, ledy i podgrzewacz.` });

      // Rozliczenie +2 days at 18:00
      const st = new Date(ev.end); st.setDate(st.getDate()+2); st.setHours(18,0,0,0);
      if (st.getTime() > now) schedule.push({ type:'rozliczenie', fireAt:st.getTime(), uid:ev.uid,
        title:'💰 Czas na rozliczenie!',
        body:`Goście ${ev.summary||''} wyjechali 2 dni temu. Otwórz zakładkę Rozlicz.` });
    }

    const { kv } = await import('@vercel/kv');
    await kv.set('ical_url', icalUrl);
    await kv.set('ical_events', JSON.stringify(events));
    await kv.set('notif_schedule', JSON.stringify(schedule));
    await kv.set('ical_synced_at', new Date().toISOString());

    return res.status(200).json({ ok:true, events:events.length, scheduled:schedule.length,
      upcoming: events.slice(0,5) });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}

function parseIcal(text) {
  const events = [];
  const lines = text.replace(/\r\n[ \t]/g,'').replace(/\n[ \t]/g,'').split(/\r\n|\n/);
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = {}; }
    else if (line === 'END:VEVENT' && cur) { if (cur.start && cur.end) events.push(cur); cur = null; }
    else if (cur) {
      const ci = line.indexOf(':'); if (ci < 0) continue;
      const key = line.slice(0,ci).split(';')[0].toUpperCase();
      const val = line.slice(ci+1);
      if (key==='DTSTART') cur.start = icalToISO(val);
      else if (key==='DTEND')   cur.end   = icalToISO(val);
      else if (key==='SUMMARY') cur.summary = val;
      else if (key==='UID')     cur.uid = val;
    }
  }
  return events.filter(e => new Date(e.end).getTime() > Date.now() - 7*86400000)
               .sort((a,b) => new Date(a.start) - new Date(b.start));
}

function icalToISO(s) {
  s=(s||'').trim();
  if(s.length===8) return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T12:00:00Z`;
  return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T${s.slice(9,11)}:${s.slice(11,13)}:${s.slice(13,15)}${s.endsWith('Z')?'Z':''}`;
}
