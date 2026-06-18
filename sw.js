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
  e.waitUntil(self.registration.showNotification(`${icon} ${data.title}`, {
    body: data.body,
    tag: data.type,
    renotify: true,
    requireInteraction: true,
    icon: '/icon.png',
    badge: '/icon.png',
    vibrate: [200, 100, 200],
    data: { url: '/' },
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
// Format: { title: 'KOLOR ŚMIECIE', name: 'nazwa do body' }
const WASTE_SCHEDULE = {
  1: { color:'🔴', name:'Niesegregowane' },
  2: { color:'♻️', name:'Ekologiczne'    },
  3: { color:'📄', name:'Papier'         },
  5: { color:'🟡', name:'Plastik i Metale' },
  0: { color:'🔴', name:'Niesegregowane' },
};

function isGlassWeek(d) {
  const w = Math.ceil(d.getDate() / 7);
  return w === 1 || w === 3;
}

async function checkWasteAndNotify() {
  const now = new Date();
  const h = now.getHours();
  if (h < 18) return;

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dow = tomorrow.getDay();

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
    await self.registration.showNotification(`${notif.color} ŚMIECI`, {
      body: `Jutro wywóz: ${notif.name} (${tomorrowName})`,
      tag: 'waste_' + todayKey,
      icon: '/icon.png',
      badge: '/icon.png',
      requireInteraction: true,
      vibrate: [200, 100, 200],
    });
    try { await cache.put('/waste-sent/' + todayKey, new Response('1')); } catch(_) {}
  }
}

self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'dismiss') return;
  e.waitUntil(
    clients.matchAll({type:'window',includeUncontrolled:true}).then(list => {
      for (const c of list) if (c.url.includes(self.location.origin) && 'focus' in c) return c.focus();
      return clients.openWindow('/');
    })
  );
});
