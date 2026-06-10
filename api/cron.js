// GET /api/cron — called by Vercel Cron every 15 minutes
// Fires due push notifications + re-syncs iCal once per day
export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const { kv } = await import('@vercel/kv');

    // ── Daily iCal re-sync (once per day, checks for new bookings) ──
    const lastSync = await kv.get('ical_synced_at');
    const icalUrl  = await kv.get('ical_url');
    const now      = Date.now();
    const oneDayMs = 24 * 3600 * 1000;

    if (icalUrl && (!lastSync || now - new Date(lastSync).getTime() > oneDayMs)) {
      try {
        const base = process.env.NEXT_PUBLIC_BASE_URL || 'https://laluna-notify.vercel.app';
        // Fetch iCal directly here to detect new bookings
        const icalResp = await fetch(icalUrl);
        const icalText = await icalResp.text();
        const events = parseIcal(icalText);

        // Check for new events vs stored
        const storedRaw = await kv.get('ical_events');
        const stored = storedRaw ? (typeof storedRaw === 'string' ? JSON.parse(storedRaw) : storedRaw) : [];
        const storedUids = new Set(stored.map(e => e.uid));
        const newEvents = events.filter(e => e.uid && !storedUids.has(e.uid));

        // Re-build schedule
        const schedule = await buildSchedule(events, now);
        await kv.set('ical_events', JSON.stringify(events));
        await kv.set('notif_schedule', JSON.stringify(schedule));
        await kv.set('ical_synced_at', new Date().toISOString());

        // Notify about new bookings
        if (newEvents.length > 0) {
          const subRaw = await kv.get('push_sub');
          if (subRaw) {
            const sub = typeof subRaw === 'string' ? JSON.parse(subRaw) : subRaw;
            for (const ev of newEvents) {
              const dep = new Date(ev.end);
              const depStr = `${pad(dep.getDate())}.${pad(dep.getMonth()+1)}.${dep.getFullYear()}`;
              await sendPush(sub, {
                type: 'new_booking',
                title: '📅 Nowa rezerwacja!',
                body: `${ev.summary || 'Nowy gość'} — wyjazd ${depStr}. Wyślij tabelę Marghericie!`
              });
            }
          }
        }
      } catch(e) {
        console.error('Daily sync error:', e.message);
      }
    }

    // ── Fire due notifications ──
    const subRaw = await kv.get('push_sub');
    if (!subRaw) return res.status(200).json({ ok: true, msg: 'No subscription' });
    const sub = typeof subRaw === 'string' ? JSON.parse(subRaw) : subRaw;

    const schedRaw = await kv.get('notif_schedule');
    if (!schedRaw) return res.status(200).json({ ok: true, msg: 'No schedule' });
    const schedule = typeof schedRaw === 'string' ? JSON.parse(schedRaw) : schedRaw;

    const window15 = 15 * 60 * 1000;
    const due = schedule.filter(n => n.fireAt <= now + window15 && n.fireAt > now - window15);
    const remaining = schedule.filter(n => n.fireAt > now + window15);

    const fired = [];
    for (const notif of due) {
      try {
        await sendPush(sub, { type: notif.type, title: notif.title, body: notif.body });
        fired.push(notif.type);
      } catch(e) {
        console.error('Push failed:', notif.type, e.message);
      }
    }

    // Monthly water meter — 25th of every month at 09:00
    const d = new Date();
    if (d.getDate() === 25) {
      const meterKey = `meter_sent_${d.getFullYear()}_${d.getMonth()}`;
      const alreadySent = await kv.get(meterKey);
      if (!alreadySent && d.getHours() >= 9 && d.getHours() < 10) {
        try {
          await sendPush(sub, {
            type: 'licznik',
            title: '💧 Licznik wody',
            body: 'Pamiętaj o odczycie licznika wody — 25. dzień miesiąca.'
          });
          await kv.set(meterKey, '1');
          fired.push('licznik');
        } catch(e) { console.error('Meter push failed:', e.message); }
      }
    }


    // Zeznanie podatkowe — 15 maja co roku
    if (d.getMonth() === 4 && d.getDate() === 15) {
      const taxKey = `tax_sent_${d.getFullYear()}`;
      const taxSent = await kv.get(taxKey);
      if (!taxSent && d.getHours() >= 9 && d.getHours() < 10) {
        try {
          await sendPush(sub, {
            type: 'podatek',
            title: '📋 Zeznanie podatkowe',
            body: 'Zeznanie podatkowe - pliki CU'
          });
          await kv.set(taxKey, '1');
          fired.push('podatek');
        } catch(e) { console.error('Tax push failed:', e.message); }
      }
    }
    await kv.set('notif_schedule', JSON.stringify(remaining));
    return res.status(200).json({ ok: true, fired, remaining: remaining.length });
  } catch(e) {
    console.error('cron error:', e);
    return res.status(500).json({ error: e.message });
  }
}

function pad(n) { return String(n).padStart(2, '0'); }

function buildSchedule(events, now) {
  const schedule = [];
  for (const ev of events) {
    const start = new Date(ev.start).getTime();
    const end   = new Date(ev.end).getTime();
    if (isNaN(start) || isNaN(end)) continue;

    // 1. Check-in day at 17:00 local
    const checkinDay = new Date(ev.start);
    checkinDay.setHours(17, 0, 0, 0);
    if (checkinDay.getTime() > now) schedule.push({
      type: 'checkin', fireAt: checkinDay.getTime(), uid: ev.uid,
      title: '🏠 Zameldowanie dzisiaj!',
      body: `${ev.summary || 'Goście'} przyjeżdżają dziś. Przygotuj dom i klucze.`
    });

    // 2. Check-in day at 10:00 — harmonogram + ciepła woda
    const harmIn = new Date(ev.start);
    harmIn.setHours(10, 0, 0, 0);
    if (harmIn.getTime() > now) schedule.push({
      type: 'harmonogram_in', fireAt: harmIn.getTime(), uid: ev.uid,
      title: '💡 Harmonogram + ciepła woda',
      body: `Dziś przyjeżdżają ${ev.summary || 'goście'}. Ustaw pompę, ledy i podgrzewacz wody.`
    });

    // 3. Check-out day at 10:00 — harmonogram + ciepła woda
    const harmOut = new Date(ev.end);
    harmOut.setHours(10, 0, 0, 0);
    if (harmOut.getTime() > now) schedule.push({
      type: 'harmonogram_out', fireAt: harmOut.getTime(), uid: ev.uid,
      title: '💡 Harmonogram + ciepła woda',
      body: `Dziś wyjeżdżają ${ev.summary || 'goście'}. Przestaw pompę, ledy i podgrzewacz.`
    });

    // 4. Rozliczenie — 2 days after checkout at 18:00
    const settle = new Date(ev.end);
    settle.setDate(settle.getDate() + 2);
    settle.setHours(18, 0, 0, 0);
    if (settle.getTime() > now) schedule.push({
      type: 'rozliczenie', fireAt: settle.getTime(), uid: ev.uid,
      title: '💰 Czas na rozliczenie!',
      body: `Goście ${ev.summary || ''} wyjechali 2 dni temu. Otwórz zakładkę Rozlicz.`
    });
  }
  return schedule;
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
      const key = line.slice(0, ci).split(';')[0].toUpperCase();
      const val = line.slice(ci + 1);
      if (key === 'DTSTART') cur.start = icalToISO(val);
      else if (key === 'DTEND')   cur.end   = icalToISO(val);
      else if (key === 'SUMMARY') cur.summary = val;
      else if (key === 'UID')     cur.uid = val;
    }
  }
  return events.filter(e => new Date(e.end).getTime() > Date.now() - 7*86400000);
}

function icalToISO(s) {
  s = (s||'').trim();
  if (s.length === 8) return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T12:00:00Z`;
  return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T${s.slice(9,11)}:${s.slice(11,13)}:${s.slice(13,15)}${s.endsWith('Z')?'Z':''}`;
}

// ── Web Push (no external deps) ──
async function sendPush(subscription, payload) {
  const pub  = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const mail = process.env.VAPID_EMAIL || 'mailto:admin@laluna.app';
  const url  = new URL(subscription.endpoint);
  const jwt  = await buildJWT(`${url.protocol}//${url.host}`, pub, priv, mail);
  const enc  = await encryptPayload(JSON.stringify(payload), subscription);
  const resp = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: { 'Authorization': `vapid t=${jwt},k=${pub}`, 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'aes128gcm', 'TTL': '86400', 'Content-Length': String(enc.length) },
    body: enc
  });
  if (resp.status !== 200 && resp.status !== 201) throw new Error(`Push ${resp.status}: ${await resp.text()}`);
}

function b64u(buf){ return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,''); }
function fromb64u(s){ s=s.replace(/-/g,'+').replace(/_/g,'/'); while(s.length%4)s+='='; return Uint8Array.from(atob(s),c=>c.charCodeAt(0)); }

async function buildJWT(aud, pub, priv, email) {
  const now = Math.floor(Date.now()/1000);
  const enc = o => btoa(JSON.stringify(o)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
  const unsigned = `${enc({typ:'JWT',alg:'ES256'})}.${enc({aud,exp:now+43200,sub:email})}`;
  const hdr = new Uint8Array([0x30,0x41,0x02,0x01,0x00,0x30,0x13,0x06,0x07,0x2a,0x86,0x48,0xce,0x3d,0x02,0x01,0x06,0x08,0x2a,0x86,0x48,0xce,0x3d,0x03,0x01,0x07,0x04,0x27,0x30,0x25,0x02,0x01,0x01,0x04,0x20]);
  const pk = new Uint8Array(hdr.length+32); pk.set(hdr); pk.set(fromb64u(priv).slice(-32), hdr.length);
  const key = await crypto.subtle.importKey('pkcs8', pk.buffer, {name:'ECDSA',namedCurve:'P-256'}, false, ['sign']);
  const sig = await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'}, key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${b64u(sig)}`;
}

async function encryptPayload(payload, sub) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const srv = await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'}, true, ['deriveBits']);
  const srvPub = new Uint8Array(await crypto.subtle.exportKey('raw', srv.publicKey));
  const cliKey = await crypto.subtle.importKey('raw', fromb64u(sub.keys.p256dh), {name:'ECDH',namedCurve:'P-256'}, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({name:'ECDH',public:cliKey}, srv.privateKey, 256));
  const auth = fromb64u(sub.keys.auth);
  const enc = new TextEncoder();
  async function hkdf(ikm,salt,info,len){ const k=await crypto.subtle.importKey('raw',ikm,'HKDF',false,['deriveBits']); return new Uint8Array(await crypto.subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt,info},k,len*8)); }
  function cat(...a){ const t=a.reduce((n,x)=>n+x.length,0),o=new Uint8Array(t);let p=0;for(const x of a){o.set(x,p);p+=x.length;}return o; }
  const ikm = await hkdf(shared, auth, enc.encode('Content-Encoding: auth\0'), 32);
  const ck  = await hkdf(ikm, salt, cat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([0]), srvPub, fromb64u(sub.keys.p256dh)), 16);
  const iv  = await hkdf(ikm, salt, cat(enc.encode('Content-Encoding: nonce\0'),     new Uint8Array([0]), srvPub, fromb64u(sub.keys.p256dh)), 12);
  const aes = await crypto.subtle.importKey('raw', ck, 'AES-GCM', false, ['encrypt']);
  const pt  = enc.encode(payload);
  const rec = new Uint8Array(pt.length+1); rec.set(pt); rec[pt.length]=0x02;
  const cipher = new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv}, aes, rec));
  const rs=4096, out=new Uint8Array(21+srvPub.length+cipher.length);
  let o=0; out.set(salt,o);o+=16; out[o++]=(rs>>24)&0xff;out[o++]=(rs>>16)&0xff;out[o++]=(rs>>8)&0xff;out[o++]=rs&0xff;
  out[o++]=srvPub.length; out.set(srvPub,o);o+=srvPub.length; out.set(cipher,o);
  return out;
}
