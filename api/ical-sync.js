// POST /api/ical-sync  { icalUrl }
import { buildSchedule } from './cron.js';

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

    // Ta sama logika co w api/cron.js i w index.html (filterRealReservations) —
    // odsiewamy blokady kalendarza i bufory "preparation time", żeby nie
    // budować dla nich fałszywych powiadomień o zameldowaniu/wymeldowaniu.
    const BLOCK_PATTERN = /not.?avail|closed|blocked|unavailable|buffer|preparation|turnover|prep.?time|lodgify/i;
    const withDates = events.filter(e => e.start && e.end);
    const startsByDay = {}, endsByDay = {};
    withDates.forEach(e => {
      const sk = (e.start||'').slice(0,10), ek = (e.end||'').slice(0,10);
      (startsByDay[sk] = startsByDay[sk]||[]).push(e);
      (endsByDay[ek] = endsByDay[ek]||[]).push(e);
    });
    const realEvs = withDates.filter(e => {
      if (!e.summary || BLOCK_PATTERN.test(e.summary)) return false;
      const s = new Date(e.start), en = new Date(e.end);
      const nights = Math.round((en - s) / 86400000);
      if (nights < 1) return false;
      if (nights > 1) return true;
      const sk = (e.start||'').slice(0,10), ek = (e.end||'').slice(0,10);
      const touchesBefore = (endsByDay[sk]||[]).some(o => o !== e);
      const touchesAfter  = (startsByDay[ek]||[]).some(o => o !== e);
      return !(touchesBefore || touchesAfter);
    });

    // WAŻNE: harmonogram budujemy DOKŁADNIE tą samą funkcją co api/cron.js
    // (buildSchedule — liczy godziny w czasie włoskim przez italyLocalToUTC).
    // Wcześniej ten plik miał własną, osobną wersję liczącą godziny w
    // "lokalnym" czasie serwera (czyli UTC na Vercelu) — to przesuwało
    // godziny o 1-2h, a przy odświeżeniu/zmianie linku iCal z apki
    // (przyciski w Ustawieniach) CAŁKOWICIE nadpisywało poprawny
    // harmonogram zbudowany wcześniej przez cron.js tym przesuniętym.
    const schedule = buildSchedule(realEvs, now);

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
