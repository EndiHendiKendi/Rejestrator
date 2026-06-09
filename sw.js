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
};

self.addEventListener('push', e => {
  let data = { title:'La Luna', body:'Nowe powiadomienie', type:'general' };
  try { if (e.data) data = e.data.json(); } catch(_) { if (e.data) data.body = e.data.text(); }
  const icon = ICONS[data.type] || '🔔';
  e.waitUntil(self.registration.showNotification(`${icon} ${data.title}`, {
    body: data.body,
    tag: data.type,
    renotify: true,
    requireInteraction: true,
    data: { url: '/' },
    actions: [
      { action:'open', title:'Otwórz' },
      { action:'dismiss', title:'Zamknij' }
    ]
  }));
});

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
