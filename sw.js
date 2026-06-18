// Service Worker — La Luna push notifications
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));

const ICONS = {
  checkin:        '🏠',
  harmonogram_in: '💡',
  harmonogram_out:'💡',
  rozliczenie:    '💰',
  licznik:        '💧',
  new_booking:    '📅',
  podatek:        '📋',
  imu:            '🏠',
  waste:          '🗑️',
};

// ── Serwer push (z Vercel cron) — działa zawsze, apka zamknięta ✓ ──
self.addEventListener('push', e => {
  let data = { title:'La Luna', body:'Nowe powiadomienie', type:'general' };
  try { if (e.data) data = e.data.json(); } catch(_) { if (e.data) data.body = e.data.text(); }
  const icon = ICONS[data.type] || '🔔';

  // Dla powiadomień o śmieciach — deep link do zakładki harmonogramu
  const notifUrl = data.type === 'waste' ? '/?tab=harmonogram' : '/';

  e.waitUntil(self.registration.showNotification(`${icon} ${data.title}`, {
    body: data.body,
    tag: data.type,
    renotify: true,
    requireInteraction: true,
    icon: '/icon.png',
    badge: '/icon.png',
    vibrate: [200, 100, 200],
    data: { url: notifUrl },
    actions: [
      { action:'open', title:'Otwórz' },
      { action:'dismiss', title:'Zamknij' }
    ]
  }));
});

// ── Periodic Background Sync (Android Chrome) — śmieci bez otwartej apki ──
self.addEventListener('periodicsync', e => {
  if (e.tag === 'waste-check') {
    e.waitUntil(checkWasteAndNotify());
  }
});

// Harmonogram śmieci
// pon=Niesegregowane, wt=Ekologiczne, śr=Papier, czw=Szkło(1+3 tydzień), pt=Ekologiczne, sob=Plastik i Metale
const WASTE_SCHEDULE = {
  1: { color:'🔴', name:'Niesegregowane' },
  2: { color:'♻️', name:'Ekologiczne'    },
  3: { color:'📄', name:'Papier'         },
  5: { color:'♻️', name:'Ekologiczne'    },
  6: { color:'🟡', name:'Plastik i Metale' },
};

function isGlassWeek(d) {
  const w = Math.ceil(d.getDate() / 7);
  return w === 1 || w === 3;
}

// Sprawdza czy vac_mode jest aktywny (zapisany przez apkę w IndexedDB / localStorage)
// SW nie ma dostępu do localStorage — pobieramy przez clients lub sprawdzamy cache
async function isVacModeActive() {
  try {
    // Próbuj odczytać z cache (apka zapisuje vac_mode do cache przy zmianie)
    const cache = await caches.open('vac-mode-v1');
    const resp = await cache.match('/vac-mode');
    if (resp) {
      const text = await resp.text();
      return text === '1';
    }
  } catch(_) {}
  // Fallback: sprawdź przez postMessage do aktywnych klientów
  try {
    const allClients = await clients.matchAll({type:'window', includeUncontrolled:true});
    if (allClients.length > 0) {
      // Apka jest otwarta — zapytaj ją
      return new Promise(resolve => {
        const ch = new MessageChannel();
        ch.port1.onmessage = e => resolve(e.data === true || e.data === '1' || e.data === 1);
        allClients[0].postMessage({type:'GET_VAC_MODE'}, [ch.port2]);
        setTimeout(() => resolve(false), 500);
      });
    }
  } catch(_) {}
  return false;
}

async function checkWasteAndNotify() {
  // Powiadomienia o śmieciach TYLKO gdy tryb wakacyjny aktywny
  const vacActive = await isVacModeActive();
  if (!vacActive) return;

  const now = new Date();
  const h = now.getHours();

  // Wysyłamy o 18:00 (sprawdzamy między 18:00 a 18:59)
  if (h !== 18) return;

  // Jutrzejszy dzień tygodnia
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dow = tomorrow.getDay(); // 0=nd,1=pon,...

  const todayKey = now.toDateString();
  const cache = await caches.open('notif-sent-v1');
  try {
    const sent = await cache.match('/waste-sent/' + todayKey);
    if (sent) return;
  } catch(_) {}

  let notif = null;

  if (dow === 4 && isGlassWeek(tomorrow)) {
    notif = { color:'🟢', name:'Szkło' };
  } else if (WASTE_SCHEDULE[dow]) {
    notif = WASTE_SCHEDULE[dow];
  }

  if (notif) {
    const dayNames = ['niedziela','poniedziałek','wtorek','środa','czwartek','piątek','sobota'];
    const tomorrowName = dayNames[dow];
    await self.registration.showNotification(`${notif.color} Jutro wywóz śmieci`, {
      body: `${notif.name} — wystaw dziś wieczór (${tomorrowName})`,
      tag: 'waste_' + todayKey,
      icon: '/icon.png',
      badge: '/icon.png',
      requireInteraction: true,
      vibrate: [200, 100, 200],
      data: { url: '/?tab=harmonogram' },
    });
    try { await cache.put('/waste-sent/' + todayKey, new Response('1')); } catch(_) {}
  }
}

self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'dismiss') return;
  const targetUrl = (e.notification.data && e.notification.data.url) ? e.notification.data.url : '/';
  e.waitUntil(
    clients.matchAll({type:'window', includeUncontrolled:true}).then(list => {
      for (const c of list) {
        if (c.url.includes(self.location.origin) && 'focus' in c) {
          c.focus();
          // Powiedz apce żeby otworzyła właściwą zakładkę
          if (targetUrl.includes('tab=')) {
            const tab = new URL(targetUrl, self.location.origin).searchParams.get('tab');
            c.postMessage({type:'OPEN_TAB', tab});
          }
          return;
        }
      }
      return clients.openWindow(targetUrl);
    })
  );
});

// Odpowiedź na zapytanie o vac_mode od SW
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'VAC_MODE_UPDATE') {
    // Apka informuje SW o zmianie trybu wakacyjnego — zapisz do cache
    caches.open('vac-mode-v1').then(cache => {
      cache.put('/vac-mode', new Response(e.data.active ? '1' : '0'));
    });
  }
});
