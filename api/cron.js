// GET /api/cron — wywoływany co 15 min przez GitHub Actions
// (.github/workflows/cron.yml), bo Vercel Hobby pozwala na cron
// najwyżej raz dziennie. Wpis w vercel.json to tylko zapasowy tick.
export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const { kv } = await import('@vercel/kv');

    // Daily iCal re-sync
    const lastSync = await kv.get('ical_synced_at');
    const icalUrl  = await kv.get('ical_url');
    const now      = Date.now();
    if (icalUrl && (!lastSync || now - new Date(lastSync).getTime() > 24*3600000)) {
      try {
        const txt = await (await fetch(icalUrl)).text();
        const events = parseIcal(txt);
        const stored = await kv.get('ical_events');
        const storedArr = stored ? (typeof stored==='string'?JSON.parse(stored):stored) : [];
        const storedUids = new Set(storedArr.map(e=>e.uid));
        const newEvs = events.filter(e=>e.uid&&!storedUids.has(e.uid));
        await kv.set('ical_events', JSON.stringify(events));
        await kv.set('notif_schedule', JSON.stringify(buildSchedule(events, now)));
        await kv.set('ical_synced_at', new Date().toISOString());
        if (newEvs.length) {
          const sub = await getSub(kv);
          if (sub) for (const ev of newEvs)
            await sendPush(sub, { type:'new_booking', title:'\uD83D\uDCC5 Nowa rezerwacja! \u2014 Margherita', body:`${ev.summary||'Nowy go\u015b\u0107'} \u2014 wy\u015blij tabel\u0119 Marghericie!` }).catch(e=>console.error('sendPush failed:', e.message));
        }
      } catch(e){ console.error('Daily sync:', e.message); }
    }

    // Fire due notifications
    const sub = await getSub(kv);
    if (!sub) return res.status(200).json({ ok:true, msg:'No subscription' });

    const schedRaw = await kv.get('notif_schedule');
    const schedule = schedRaw ? (typeof schedRaw==='string'?JSON.parse(schedRaw):schedRaw) : [];
    // UWAGA: poprzednio okno było symetryczne (now-15min..now+15min), co
    // pozwalało wystrzelić powiadomienie do 15 min PRZED właściwą godziną
    // (np. 09:45 zamiast 10:00) — usunięte. Teraz: leci, gdy czas minął,
    // niezależnie jak późno cron zdążył odpalić (nigdy nie "zgubimy" po cichu
    // powiadomienia, gdyby cron-job.org akurat nie strzelił na czas).
    const due = schedule.filter(n=>n.fireAt<=now);
    const remaining = schedule.filter(n=>n.fireAt>now);
    const fired = [];

    for (const n of due) {
      await sendPush(sub, {type:n.type,title:n.title,body:n.body}).catch(e=>console.error('sendPush failed:', e.message));
      await addToInbox(kv, {type:n.type,title:n.title,body:n.body});
      fired.push(n.type);
    }
    await kv.set('notif_schedule', JSON.stringify(remaining));

    // Monthly water meter — 25th at 09:00
    const d = new Date();
    if (d.getDate()===25) {
      const mk = `meter_${d.getFullYear()}_${d.getMonth()}`;
      if (!await kv.get(mk)) {
        const entry={type:'licznik',title:'\uD83D\uDCA7 Licznik wody',body:'Odczytaj licznik wody \u2014 25. dzie\u0144 miesi\u0105ca.'};
        await sendPush(sub, entry).catch(e=>console.error('sendPush failed:', e.message));
        await addToInbox(kv, entry);
        await kv.set(mk,'1'); fired.push('licznik');
      }
    }

    // Tax — 15 May at 09:00
    if (d.getMonth()===4 && d.getDate()===15) {
      const tk = `tax_${d.getFullYear()}`;
      if (!await kv.get(tk)) {
        const entry={type:'podatek',title:'\uD83D\uDCCB Zeznanie podatkowe',body:'Zeznanie podatkowe \u2014 pliki CU'};
        await sendPush(sub, entry).catch(e=>console.error('sendPush failed:', e.message));
        await addToInbox(kv, entry);
        await kv.set(tk,'1'); fired.push('podatek');
      }
    }

    // ── Śmieci — TYLKO gdy tryb wakacyjny aktywny, dzień PRZED wywozem o 18:00 czasu włoskiego ──
    // Harmonogram wywozów: pon=Niesegregowane, wt=Ekologiczne, śr=Papier,
    //   czw(1+3 tydzień)=Szkło, pt=Ekologiczne, sob=Plastik i Metale
    // Powiadomienie wysyłamy DZIEŃ PRZED o 18:00 (wystawiasz śmieci wieczorem)
    // Cron odpala co 15 min — sprawdzamy godzinę włoską (UTC+2 letni / UTC+1 zimowy)
    {
      const vacMode = await kv.get('vac_mode');
      // Odporne na typ: KV bywał zapisany jako string '1'/'0', liczba 1/0 lub bool —
      // String(...) normalizuje wszystko przed porównaniem.
      if (String(vacMode) === '1') {
        // Godzina włoska: CEST (lato, UTC+2) trwa ost. niedziela marca → ost. niedziela października.
        // Poza tym okresem jest CET (zima, UTC+1). Liczymy dynamicznie żeby nie przesuwało
        // się o godzinę i nie wysyłało powiadomień w złej godzinie/dniu w okresie zimowym.
        const italyOffset = isItalyDST(d) ? 2 : 1;
        const italyHour = (d.getUTCHours() + italyOffset) % 24;
        if (italyHour === 18) {
          // Jutro = dzień wywozu
          const tomorrow = new Date(d);
          tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
          const tomorrowDay = tomorrow.getUTCDay(); // 0=nd,1=pon...
          const tomorrowDate = tomorrow.getUTCDate();
          const weekNum = Math.ceil(tomorrowDate / 7);

          const wk = `waste_${d.getUTCFullYear()}_${d.getUTCMonth()}_${d.getUTCDate()}`;
          let wasteMsg = null;
          if (!await kv.get(wk)) {
            const dayNames=['niedziela','poniedziałek','wtorek','środa','czwartek','piątek','sobota'];
            if (tomorrowDay===1) wasteMsg={color:'🔴',name:'Niesegregowane'};
            else if (tomorrowDay===2) wasteMsg={color:'♻️',name:'Ekologiczne'};
            else if (tomorrowDay===3) wasteMsg={color:'📄',name:'Papier'};
            else if (tomorrowDay===4&&(weekNum===1||weekNum===3)) wasteMsg={color:'🟢',name:'Szkło'};
            else if (tomorrowDay===5) wasteMsg={color:'♻️',name:'Ekologiczne'};
            else if (tomorrowDay===6) wasteMsg={color:'🟡',name:'Plastik i Metale'};
            if (wasteMsg) {
              const entry={
                type:'waste',
                title:`${wasteMsg.color} Jutro wywóz śmieci`,
                body:`${wasteMsg.name} — wystaw dziś wieczór (jutro: ${dayNames[tomorrowDay]})`
              };
              await sendPush(sub, entry).catch(e=>console.error('sendPush failed:', e.message));
              await addToInbox(kv, entry);
              await kv.set(wk,'1'); fired.push('waste');
            }
          }
        }
      }
    }

    
    // IMU — 1 czerwca (rata 1)
    if (d.getMonth()===5 && d.getDate()===1) {
      const imu1k = `imu1_${d.getFullYear()}`;
      if (!await kv.get(imu1k)) {
        const entry={type:'imu',title:'\uD83C\uDFE0 IMU',body:'IMU z\u0142o\u017cy\u0107 deklaracj\u0119 i op\u0142aci\u0107 (1 rata)'};
        await sendPush(sub, entry).catch(e=>console.error('sendPush failed:', e.message));
        await addToInbox(kv, entry);
        await kv.set(imu1k,'1'); fired.push('imu1');
      }
    }
    // IMU — 1 grudnia (rata 2)
    if (d.getMonth()===11 && d.getDate()===1) {
      const imu2k = `imu2_${d.getFullYear()}`;
      if (!await kv.get(imu2k)) {
        const entry={type:'imu',title:'\uD83C\uDFE0 IMU',body:'IMU z\u0142o\u017cy\u0107 deklaracj\u0119 i op\u0142aci\u0107 (2 rata)'};
        await sendPush(sub, entry).catch(e=>console.error('sendPush failed:', e.message));
        await addToInbox(kv, entry);
        await kv.set(imu2k,'1'); fired.push('imu2');
      }
    }

    // Jednorazowe przypomnienia dla wszystkiego, co wisi nieoznaczone >24h
    await sendReminders(kv, sub);
    
    return res.status(200).json({ ok:true, fired, remaining:remaining.length });
  } catch(e) {
    console.error('cron error:', e);
    return res.status(500).json({ error: e.message });
  }
}

export async function getSub(kv) {
  const raw = await kv.get('push_sub');
  if (!raw) return null;
  const parsed = typeof raw==='string'?JSON.parse(raw):raw;
  // subscribe.js zapisuje { subscription: {...} } — rozpakuj zagnieżdżenie,
  // ale zostaw kompatybilność gdyby kiedyś zapisano płasko.
  return parsed.subscription || parsed;
}

// Dopisuje wysłane powiadomienie do skrzynki (dzwonek w apce) — żeby było
// widać "nieodczytane", aż użytkownik kliknie X (oznacz jako zrobione).
async function addToInbox(kv, entry) {
  try {
    const items = (await kv.get('notif_inbox')) || [];
    items.push({
      id: entry.type + '_' + Date.now() + '_' + Math.random().toString(36).slice(2,7),
      type: entry.type, title: entry.title, body: entry.body,
      firedAt: Date.now(), done: false, reminded: false,
    });
    // Trzymaj rozmiar w ryzach: zrobione starsze niż 30 dni i wszystko starsze niż 90 dni — wywal.
    const cutDone = Date.now() - 30*86400000, cutAll = Date.now() - 90*86400000;
    const trimmed = items.filter(n => n.firedAt > cutAll && !(n.done && n.firedAt < cutDone));
    await kv.set('notif_inbox', trimmed);
  } catch(e) { console.error('addToInbox:', e.message); }
}

// Jeśli powiadomienie wisi nieoznaczone jako zrobione >24h — wysyłamy
// JEDNORAZOWE przypomnienie o tej samej godzinie następnego dnia.
async function sendReminders(kv, sub) {
  try {
    const items = (await kv.get('notif_inbox')) || [];
    const now = Date.now();
    let changed = false;
    for (const n of items) {
      if (!n.done && !n.reminded && (now - n.firedAt) >= 24*3600000) {
        await sendPush(sub, { type:n.type, title:'🔁 Przypomnienie: ' + n.title, body:n.body }).catch(e=>console.error('sendPush failed:', e.message));
        n.reminded = true;
        changed = true;
      }
    }
    if (changed) await kv.set('notif_inbox', items);
  } catch(e) { console.error('sendReminders:', e.message); }
}

function buildSchedule(events, now) {
  const sched = [];
  for (const ev of events) {
    const start = new Date(ev.start).getTime();
    const end   = new Date(ev.end).getTime();
    if (isNaN(start)||isNaN(end)) continue;

    // Check-in day 10:00 (czas włoski) — Harmonogramy + ciepła woda
    const h1 = italyLocalToUTC(new Date(ev.start), 10);
    if (h1.getTime()>now) sched.push({type:'harmonogram_in',fireAt:h1.getTime(),uid:ev.uid,
      title:'\uD83D\uDCA1 Harmonogramy + ciep\u0142a woda',
      body:'Ustaw pomp\u0119, ledy i podgrzewacz wody.'});

    // Check-in day 17:00 (czas włoski) — Zameldowanie
    const h2 = italyLocalToUTC(new Date(ev.start), 17);
    if (h2.getTime()>now) sched.push({type:'checkin',fireAt:h2.getTime(),uid:ev.uid,
      title:'\uD83C\uDFE0 Zameldowanie go\u015bci!!',
      body:'Zg\u0142o\u015b do Ross1000 i Questury.'});

    // Check-out day 10:00 (czas włoski) — Harmonogramy + ciepła woda
    const h3 = italyLocalToUTC(new Date(ev.end), 10);
    if (h3.getTime()>now) sched.push({type:'harmonogram_out',fireAt:h3.getTime(),uid:ev.uid,
      title:'\uD83D\uDCA1 Harmonogramy + ciep\u0142a woda',
      body:'Przestaw pomp\u0119, ledy i podgrzewacz.'});

    // +2 days after checkout 18:00 (czas włoski) — Rozliczenie
    const h4base = new Date(ev.end); h4base.setUTCDate(h4base.getUTCDate()+2);
    const h4 = italyLocalToUTC(h4base, 18);
    if (h4.getTime()>now) sched.push({type:'rozliczenie',fireAt:h4.getTime(),uid:ev.uid,
      title:'\uD83D\uDCB0 Czas na rozliczenie!',
      body:`Go\u015bcie wyjechali 2 dni temu. Otw\u00F3rz zak\u0142adk\u0119 Margherita.`});
  }
  return sched;
}

// Zamienia "dzień kalendarzowy (UTC) z danej daty" + "godzina czasu włoskiego"
// na konkretny moment UTC, uwzględniając czas letni/zimowy we Włoszech.
// Używane przez WSZYSTKIE powiadomienia o konkretnej godzinie (harmonogram,
// zameldowanie, rozliczenie) — ten sam mechanizm co powiadomienie o śmieciach,
// żeby nie powtórzyć błędu "serwer liczy w UTC, a my chcemy czas włoski".
function italyLocalToUTC(dayRef, italyHour) {
  const y = dayRef.getUTCFullYear(), m = dayRef.getUTCMonth(), day = dayRef.getUTCDate();
  const probe = new Date(Date.UTC(y, m, day, 12, 0, 0));
  const offset = isItalyDST(probe) ? 2 : 1;
  return new Date(Date.UTC(y, m, day, italyHour - offset, 0, 0, 0));
}

// --- Also add vac-mode endpoint in same file via route check ---

function parseIcal(text) {
  const events=[];
  const lines=text.replace(/\r\n[ \t]/g,'').replace(/\n[ \t]/g,'').split(/\r\n|\n/);
  let cur=null;
  for (const line of lines) {
    if (line==='BEGIN:VEVENT'){cur={};}
    else if (line==='END:VEVENT'&&cur){if(cur.start&&cur.end)events.push(cur);cur=null;}
    else if (cur){
      const ci=line.indexOf(':');if(ci<0)continue;
      const key=line.slice(0,ci).split(';')[0].toUpperCase();
      const val=line.slice(ci+1);
      if(key==='DTSTART')cur.start=icalToISO(val);
      else if(key==='DTEND')cur.end=icalToISO(val);
      else if(key==='SUMMARY')cur.summary=val;
      else if(key==='UID')cur.uid=val;
    }
  }
  return events.filter(e=>new Date(e.end).getTime()>Date.now()-7*86400000);
}
function icalToISO(s){s=(s||'').trim();if(s.length===8)return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T12:00:00Z`;return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T${s.slice(9,11)}:${s.slice(11,13)}:${s.slice(13,15)}${s.endsWith('Z')?'Z':''}`;}
function pad(n){return String(n).padStart(2,'0');}

// Czy w danej dacie (UTC) obowiązuje czas letni środkowoeuropejski (CEST, UTC+2)?
// DST EU: od ostatniej niedzieli marca 01:00 UTC do ostatniej niedzieli października 01:00 UTC.
function isItalyDST(d) {
  const year = d.getUTCFullYear();
  function lastSunday(month) { // month: 0-indexed
    const last = new Date(Date.UTC(year, month + 1, 0, 1, 0, 0));
    last.setUTCDate(last.getUTCDate() - last.getUTCDay());
    return last;
  }
  const dstStart = lastSunday(2);  // ostatnia niedziela marca
  const dstEnd   = lastSunday(9);  // ostatnia niedziela października
  return d.getTime() >= dstStart.getTime() && d.getTime() < dstEnd.getTime();
}

// Web Push
function b64u(buf){return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');}
function fromb64u(s){s=s.replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';return Uint8Array.from(atob(s),c=>c.charCodeAt(0));}
async function buildJWT(aud,pub,priv,email){
  const now=Math.floor(Date.now()/1000);
  const enc=o=>btoa(JSON.stringify(o)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
  const unsigned=`${enc({typ:'JWT',alg:'ES256'})}.${enc({aud,exp:now+43200,sub:email})}`;
  const hdr=new Uint8Array([0x30,0x41,0x02,0x01,0x00,0x30,0x13,0x06,0x07,0x2a,0x86,0x48,0xce,0x3d,0x02,0x01,0x06,0x08,0x2a,0x86,0x48,0xce,0x3d,0x03,0x01,0x07,0x04,0x27,0x30,0x25,0x02,0x01,0x01,0x04,0x20]);
  // priv może być podany jako: (a) surowy 32-bajtowy scalar 'd' w base64url
  // (to, czego oczekuje ten kod od dawna), albo (b) pełny klucz PKCS8 DER
  // w base64url, jak zwracają niektóre generatory VAPID online. Rozpoznajemy
  // PKCS8 po długości (>32 bajty) i po nagłówku zaczynającym się od 0x30
  // (SEQUENCE) — wtedy scalar 'd' leży po znaczniku OCTET STRING 04 20.
  const privRaw = fromb64u(priv);
  let scalar;
  if (privRaw.length === 32) {
    scalar = privRaw;
  } else {
    // Szukaj sekwencji 04 20 (OCTET STRING, długość 32) — po niej leży scalar.
    let idx = -1;
    for (let i=0; i<privRaw.length-1; i++) {
      if (privRaw[i]===0x04 && privRaw[i+1]===0x20 && i+34<=privRaw.length) { idx = i+2; break; }
    }
    if (idx===-1) throw new Error('VAPID_PRIVATE_KEY: nie rozpoznano formatu klucza (oczekiwano 32 bajtów albo PKCS8 z OCTET STRING)');
    scalar = privRaw.slice(idx, idx+32);
  }
  const pk=new Uint8Array(hdr.length+32);pk.set(hdr);pk.set(scalar,hdr.length);
  const key=await crypto.subtle.importKey('pkcs8',pk.buffer,{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
  const sig=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,new TextEncoder().encode(unsigned));
  return `${unsigned}.${b64u(sig)}`;
}
async function encryptPayload(payload,sub){
  const salt=crypto.getRandomValues(new Uint8Array(16));
  const srv=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  const srvPub=new Uint8Array(await crypto.subtle.exportKey('raw',srv.publicKey));
  const cli=await crypto.subtle.importKey('raw',fromb64u(sub.keys.p256dh),{name:'ECDH',namedCurve:'P-256'},false,[]);
  const shared=new Uint8Array(await crypto.subtle.deriveBits({name:'ECDH',public:cli},srv.privateKey,256));
  const auth=fromb64u(sub.keys.auth);
  const enc=new TextEncoder();
  async function hkdf(ikm,salt,info,len){const k=await crypto.subtle.importKey('raw',ikm,'HKDF',false,['deriveBits']);return new Uint8Array(await crypto.subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt,info},k,len*8));}
  function cat(...a){const t=a.reduce((n,x)=>n+x.length,0),o=new Uint8Array(t);let p=0;for(const x of a){o.set(x,p);p+=x.length;}return o;}
  const cliPub=fromb64u(sub.keys.p256dh);
  // RFC 8291: IKM info = "WebPush: info" || 0x00 || ua_public (65B) || as_public (65B)
  const ikm=await hkdf(shared,auth,cat(enc.encode('WebPush: info\0'),cliPub,srvPub),32);
  // RFC 8291: CEK info = "Content-Encoding: aes128gcm" || 0x00 (brak kluczy publicznych)
  const ck=await hkdf(ikm,salt,enc.encode('Content-Encoding: aes128gcm\0'),16);
  // RFC 8291: nonce info = "Content-Encoding: nonce" || 0x00 (brak kluczy publicznych)
  const iv=await hkdf(ikm,salt,enc.encode('Content-Encoding: nonce\0'),12);
  // cliPub już zdefiniowany powyżej (fromb64u(sub.keys.p256dh))
  const aes=await crypto.subtle.importKey('raw',ck,'AES-GCM',false,['encrypt']);
  const pt=enc.encode(payload);const rec=new Uint8Array(pt.length+1);rec.set(pt);rec[pt.length]=0x02;
  const cipher=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},aes,rec));
  const rs=4096,out=new Uint8Array(21+srvPub.length+cipher.length);
  let o=0;out.set(salt,o);o+=16;out[o++]=(rs>>24)&0xff;out[o++]=(rs>>16)&0xff;out[o++]=(rs>>8)&0xff;out[o++]=rs&0xff;
  out[o++]=srvPub.length;out.set(srvPub,o);o+=srvPub.length;out.set(cipher,o);return out;
}
export async function sendPush(sub,payload){
  const pub=process.env.VAPID_PUBLIC_KEY,priv=process.env.VAPID_PRIVATE_KEY,mail=process.env.VAPID_EMAIL||'mailto:admin@laluna.app';
  const url=new URL(sub.endpoint);
  const jwt=await buildJWT(`${url.protocol}//${url.host}`,pub,priv,mail);
  const enc=await encryptPayload(JSON.stringify(payload),sub);
  const resp=await fetch(sub.endpoint,{method:'POST',headers:{'Authorization':`vapid t=${jwt},k=${pub}`,'Content-Type':'application/octet-stream','Content-Encoding':'aes128gcm','TTL':'86400','Content-Length':String(enc.length)},body:enc});
  if(resp.status!==200&&resp.status!==201)throw new Error(`Push ${resp.status}`);
}
