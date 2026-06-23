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
  const notifUrl = data.type === 'waste' ? './?tab=harmonogram' : './';

  e.waitUntil(Promise.all([
    self.registration.showNotification(`${icon} ${data.title}`, {
      body: data.body,
      tag: data.type,
      renotify: true,
      requireInteraction: true,
      icon: './icon-192.png',
      badge: './badge.png',
      vibrate: [200, 100, 200],
      data: { url: notifUrl },
      actions: [
        { action:'open', title:'Otwórz' },
        { action:'dismiss', title:'Zamknij' }
      ]
    }),
    updateAppBadgeFromServer(),
  ]));
});

// Plakietka z liczbą na ikonie apki — aktualizowana też tutaj (nie tylko z
// otwartej apki), żeby było widać nieprzeczytane nawet gdy apka jest zamknięta.
async function updateAppBadgeFromServer() {
  try {
    const cache = await caches.open('vac-mode-v1');
    const resp = await cache.match('/push-server');
    const server = resp ? await resp.text() : '';
    if (!server || !('setAppBadge' in self.navigator)) return;
    const r = await fetch(server + '/api/notifications');
    const dd = await r.json();
    const unread = ((dd && dd.items) || []).filter(n => !n.done).length;
    if (unread > 0) self.navigator.setAppBadge(unread);
    else self.navigator.clearAppBadge();
  } catch(_) {}
}

// UWAGA: periodicsync USUNIĘTY — był niedeterministyczny (Chrome odpalał go
// w przypadkowych momentach, nie gwarantowanej godzinie), co powodowało
// powiadomienia o śmieciach wysyłane w złym dniu (np. 2 dni za wcześnie).
// Powiadomienia o wywozie śmieci są teraz wysyłane WYŁĄCZNIE przez serwerowy
// cron (Vercel, co 15 min, sprawdza godzinę włoską) — patrz api/cron.js.

self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'dismiss') return;

  // Budujemy absolutny URL — Chrome otwiera PWA TYLKO gdy URL dokładnie
  // pasuje do scope zdefiniowanego w manifest.json. Relatywne './' tego
  // nie gwarantuje, stąd zawsze używamy pełnego origin + ścieżki.
  const base = self.registration.scope; // np. https://laluna.app/
  const rawUrl = (e.notification.data && e.notification.data.url) ? e.notification.data.url : './';
  const targetUrl = new URL(rawUrl, base).href;

  e.waitUntil(
    clients.matchAll({type:'window', includeUncontrolled:true}).then(list => {
      // 1. Szukaj już otwartego okna PWA w scope apki
      for (const c of list) {
        if (c.url.startsWith(base)) {
          // Fokus na istniejące okno PWA i ewentualnie przełącz zakładkę
          return c.focus().then(() => {
            if (targetUrl.includes('tab=')) {
              const tab = new URL(targetUrl).searchParams.get('tab');
              c.postMessage({type:'OPEN_TAB', tab});
            }
          });
        }
      }
      // 2. Brak otwartego okna — otwórz nowe. Absolutny URL = Chrome
      //    rozpoznaje scope PWA i otwiera w oknie aplikacji, nie w karcie.
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
  if (e.data && e.data.type === 'SERVER_URL_UPDATE' && e.data.server) {
    caches.open('vac-mode-v1').then(cache => {
      cache.put('/push-server', new Response(e.data.server));
    });
  }
});
