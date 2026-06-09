// GET /api/status — returns sync status, next notifications, subscription state
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).end();

  try {
    const { kv } = await import('@vercel/kv');
    const [subRaw, schedRaw, syncedAt, icalUrl, eventsRaw] = await Promise.all([
      kv.get('push_sub'),
      kv.get('notif_schedule'),
      kv.get('ical_synced_at'),
      kv.get('ical_url'),
      kv.get('ical_events'),
    ]);

    const schedule = schedRaw ? (typeof schedRaw === 'string' ? JSON.parse(schedRaw) : schedRaw) : [];
    const events   = eventsRaw ? (typeof eventsRaw === 'string' ? JSON.parse(eventsRaw) : eventsRaw) : [];

    return res.status(200).json({
      hasSubscription: !!subRaw,
      icalConfigured: !!icalUrl,
      lastSync: syncedAt || null,
      upcomingEvents: events.length,
      scheduledNotifs: schedule.length,
      next3: schedule.sort((a,b) => a.fireAt - b.fireAt).slice(0,3).map(n => ({
        type: n.type,
        title: n.title,
        fireAt: new Date(n.fireAt).toISOString()
      }))
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
