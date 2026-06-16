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

async function checkWasteAndNotify() {
  const now = new Date();
  const h = now.getHours();
  if (h < 18) return; // tylko wieczorem

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dow = tomorrow.getDay();

  const todayKey = now.toDateString();
  // Sprawdź czy już dziś wysłano (używamy Cache API jako mini-storage)
  const cache = await caches.open('notif-sent-v1');
  const sent = await cache.match('/waste-sent/' + todayKey);
  if (sent) return;

  const WASTE = {
    1: {title:'🔴 Wystaw Niesegregowane!', body:'Jutro rano wywóz.'},
    2: {title:'♻️ Wystaw Ekologiczne!',    body:'Jutro rano wywóz.'},
    3: {title:'📄 Wystaw Papier!',          body:'Jutro rano wywóz.'},
    5: {title:'🟡 Wystaw Plastiki & Metale!', body:'Jutro rano wywóz.'},
    0: {title:'🔴 Wystaw Niesegregowane!', body:'Jutro poniedziałek — wywóz rano.'},
  };

  // Szkło: 1. i 3. czwartek
  let notif = null;
  if (dow === 4) {
    const week = Math.ceil(tomorrow.getDate() / 7);
    if (week === 1 || week === 3) notif = {title:'🟢 Wystaw Szkło!', body:'Jutro rano wywóz (1. lub 3. czwartek).'};
  } else {
    notif = WASTE[dow] || null;
  }

  if (notif) {
    await self.registration.showNotification(notif.title, {
      body: notif.body,
      tag: 'waste_' + todayKey,
      icon: '/icon.png',
      badge: '/icon.png',
      requireInteraction: true,
      vibrate: [200, 100, 200],
    });
    // Zapamiętaj że wysłano
    await cache.put('/waste-sent/' + todayKey, new Response('1'));
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
