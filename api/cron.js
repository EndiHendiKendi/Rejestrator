// GET /api/cron — Vercel Cron every 15 minutes
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
            await sendPush(sub, { type:'new_booking', title:'\uD83D\uDCC5 Nowa rezerwacja! \u2014 Margherita', body:`${ev.summary||'Nowy go\u015b\u0107'} \u2014 wy\u015blij tabel\u0119 Marghericie!` }).catch(()=>{});
        }
      } catch(e){ console.error('Daily sync:', e.message); }
    }

    // Fire due notifications
    const sub = await getSub(kv);
    if (!sub) return res.status(200).json({ ok:true, msg:'No subscription' });

    const schedRaw = await kv.get('notif_schedule');
    const schedule = schedRaw ? (typeof schedRaw==='string'?JSON.parse(schedRaw):schedRaw) : [];
    const win = 15*60*1000;
    const due = schedule.filter(n=>n.fireAt<=now+win&&n.fireAt>now-win);
    const remaining = schedule.filter(n=>n.fireAt>now+win);
    const fired = [];

    for (const n of due) {
      await sendPush(sub, {type:n.type,title:n.title,body:n.body}).catch(()=>{});
      fired.push(n.type);
    }
    await kv.set('notif_schedule', JSON.stringify(remaining));

    // Monthly water meter — 25th at 09:00
    const d = new Date();
    if (d.getDate()===25 && d.getHours()>=9 && d.getHours()<10) {
      const mk = `meter_${d.getFullYear()}_${d.getMonth()}`;
      if (!await kv.get(mk)) {
        await sendPush(sub, {type:'licznik',title:'\uD83D\uDCA7 Licznik wody',body:'Odczytaj licznik wody \u2014 25. dzie\u0144 miesi\u0105ca.'}).catch(()=>{});
        await kv.set(mk,'1'); fired.push('licznik');
      }
    }

    // Tax — 15 May at 09:00
    if (d.getMonth()===4 && d.getDate()===15 && d.getHours()>=9 && d.getHours()<10) {
      const tk = `tax_${d.getFullYear()}`;
      if (!await kv.get(tk)) {
        await sendPush(sub, {type:'podatek',title:'\uD83D\uDCCB Zeznanie podatkowe',body:'Zeznanie podatkowe \u2014 pliki CU'}).catch(()=>{});
        await kv.set(tk,'1'); fired.push('podatek');
      }
    }

    // Vacation mode — waste reminders at 18:00
    const vacMode = await kv.get('vac_mode');
    if (vacMode==='1' && d.getHours()>=18 && d.getHours()<19) {
      const day = d.getDay(); // 0=Sun,1=Mon,2=Tue,3=Wed,4=Thu,5=Fri,6=Sat
      const wk = `waste_${d.getFullYear()}_${d.getMonth()}_${d.getDate()}`;
      if (!await kv.get(wk)) {
        let wasteMsg = null;
        if (day===1) wasteMsg='Wystaw Ekologiczne';
        else if (day===2) wasteMsg='Wystaw Papier';
        else if (day===3) {
          // 1st and 3rd Wednesday of month
          const weekNum = Math.ceil(d.getDate()/7);
          if (weekNum===1||weekNum===3) wasteMsg='Wystaw Szk\u0142o';
        }
        else if (day===4) wasteMsg='Wystaw Ekologiczne';
        else if (day===5) wasteMsg='Wystaw Plastiki & Metale';
        else if (day===0) wasteMsg='Wystaw Niesegregowane';
        if (wasteMsg) {
          await sendPush(sub, {type:'waste',title:'\uD83D\uDDD1\uFE0F Wywóz \u015bmieci',body:wasteMsg}).catch(()=>{});
          await kv.set(wk,'1'); fired.push('waste');
        }
      }
    }

    
    // IMU — 1 czerwca (rata 1)
    if (d.getMonth()===5 && d.getDate()===1 && d.getHours()>=9 && d.getHours()<10) {
      const imu1k = `imu1_${d.getFullYear()}`;
      if (!await kv.get(imu1k)) {
        await sendPush(sub, {type:'imu',title:'\uD83C\uDFE0 IMU',body:'IMU z\u0142o\u017cy\u0107 deklaracj\u0119 i op\u0142aci\u0107 (1 rata)'}).catch(()=>{});
        await kv.set(imu1k,'1'); fired.push('imu1');
      }
    }
    // IMU — 1 grudnia (rata 2)
    if (d.getMonth()===11 && d.getDate()===1 && d.getHours()>=9 && d.getHours()<10) {
      const imu2k = `imu2_${d.getFullYear()}`;
      if (!await kv.get(imu2k)) {
        await sendPush(sub, {type:'imu',title:'\uD83C\uDFE0 IMU',body:'IMU z\u0142o\u017cy\u0107 deklaracj\u0119 i op\u0142aci\u0107 (2 rata)'}).catch(()=>{});
        await kv.set(imu2k,'1'); fired.push('imu2');
      }
    }
    
    return res.status(200).json({ ok:true, fired, remaining:remaining.length });
  } catch(e) {
    console.error('cron error:', e);
    return res.status(500).json({ error: e.message });
  }
}

async function getSub(kv) {
  const raw = await kv.get('push_sub');
  if (!raw) return null;
  return typeof raw==='string'?JSON.parse(raw):raw;
}

function buildSchedule(events, now) {
  const sched = [];
  for (const ev of events) {
    const start = new Date(ev.start).getTime();
    const end   = new Date(ev.end).getTime();
    if (isNaN(start)||isNaN(end)) continue;

    // Check-in day 10:00 — Harmonogramy + ciepła woda
    const h1 = new Date(ev.start); h1.setHours(10,0,0,0);
    if (h1.getTime()>now) sched.push({type:'harmonogram_in',fireAt:h1.getTime(),uid:ev.uid,
      title:'\uD83D\uDCA1 Harmonogramy + ciep\u0142a woda',
      body:'Ustaw pomp\u0119, ledy i podgrzewacz wody.'});

    // Check-in day 17:00 — Zameldowanie
    const h2 = new Date(ev.start); h2.setHours(17,0,0,0);
    if (h2.getTime()>now) sched.push({type:'checkin',fireAt:h2.getTime(),uid:ev.uid,
      title:'\uD83C\uDFE0 Zameldowanie go\u015bci!!',
      body:'Zg\u0142o\u015b do Ross1000 i Questury.'});

    // Check-out day 10:00 — Harmonogramy + ciepła woda
    const h3 = new Date(ev.end); h3.setHours(10,0,0,0);
    if (h3.getTime()>now) sched.push({type:'harmonogram_out',fireAt:h3.getTime(),uid:ev.uid,
      title:'\uD83D\uDCA1 Harmonogramy + ciep\u0142a woda',
      body:'Przestaw pomp\u0119, ledy i podgrzewacz.'});

    // +2 days after checkout 18:00 — Rozliczenie
    const h4 = new Date(ev.end); h4.setDate(h4.getDate()+2); h4.setHours(18,0,0,0);
    if (h4.getTime()>now) sched.push({type:'rozliczenie',fireAt:h4.getTime(),uid:ev.uid,
      title:'\uD83D\uDCB0 Czas na rozliczenie!',
      body:`Go\u015bcie wyjechali 2 dni temu. Otw\u00F3rz zak\u0142adk\u0119 Margherita.`});
  }
  return sched;
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

// Web Push
function b64u(buf){return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');}
function fromb64u(s){s=s.replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';return Uint8Array.from(atob(s),c=>c.charCodeAt(0));}
async function buildJWT(aud,pub,priv,email){
  const now=Math.floor(Date.now()/1000);
  const enc=o=>btoa(JSON.stringify(o)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
  const unsigned=`${enc({typ:'JWT',alg:'ES256'})}.${enc({aud,exp:now+43200,sub:email})}`;
  const hdr=new Uint8Array([0x30,0x41,0x02,0x01,0x00,0x30,0x13,0x06,0x07,0x2a,0x86,0x48,0xce,0x3d,0x02,0x01,0x06,0x08,0x2a,0x86,0x48,0xce,0x3d,0x03,0x01,0x07,0x04,0x27,0x30,0x25,0x02,0x01,0x01,0x04,0x20]);
  const pk=new Uint8Array(hdr.length+32);pk.set(hdr);pk.set(fromb64u(priv).slice(-32),hdr.length);
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
  const ikm=await hkdf(shared,auth,enc.encode('Content-Encoding: auth\0'),32);
  const ck=await hkdf(ikm,salt,cat(enc.encode('Content-Encoding: aes128gcm\0'),new Uint8Array([0]),srvPub,fromb64u(sub.keys.p256dh)),16);
  const iv=await hkdf(ikm,salt,cat(enc.encode('Content-Encoding: nonce\0'),new Uint8Array([0]),srvPub,fromb64u(sub.keys.p256dh)),12);
  const aes=await crypto.subtle.importKey('raw',ck,'AES-GCM',false,['encrypt']);
  const pt=enc.encode(payload);const rec=new Uint8Array(pt.length+1);rec.set(pt);rec[pt.length]=0x02;
  const cipher=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},aes,rec));
  const rs=4096,out=new Uint8Array(21+srvPub.length+cipher.length);
  let o=0;out.set(salt,o);o+=16;out[o++]=(rs>>24)&0xff;out[o++]=(rs>>16)&0xff;out[o++]=(rs>>8)&0xff;out[o++]=rs&0xff;
  out[o++]=srvPub.length;out.set(srvPub,o);o+=srvPub.length;out.set(cipher,o);return out;
}
async function sendPush(sub,payload){
  const pub=process.env.VAPID_PUBLIC_KEY,priv=process.env.VAPID_PRIVATE_KEY,mail=process.env.VAPID_EMAIL||'mailto:admin@laluna.app';
  const url=new URL(sub.endpoint);
  const jwt=await buildJWT(`${url.protocol}//${url.host}`,pub,priv,mail);
  const enc=await encryptPayload(JSON.stringify(payload),sub);
  const resp=await fetch(sub.endpoint,{method:'POST',headers:{'Authorization':`vapid t=${jwt},k=${pub}`,'Content-Type':'application/octet-stream','Content-Encoding':'aes128gcm','TTL':'86400','Content-Length':String(enc.length)},body:enc});
  if(resp.status!==200&&resp.status!==201)throw new Error(`Push ${resp.status}`);
}
