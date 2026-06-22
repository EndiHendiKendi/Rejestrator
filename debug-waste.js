// GET /api/debug-waste — TYMCZASOWY endpoint diagnostyczny.
// Pokazuje surowy stan vac_mode i kluczy idempotencji 'waste_*' z ostatnich dni,
// żeby ustalić czemu powiadomienie o śmieciach nie wyszło.
// USUNĄĆ po zdiagnozowaniu problemu.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const { kv } = await import('@vercel/kv');
    const vacModeRaw = await kv.get('vac_mode');

    const now = new Date();
    const days = [];
    for (let i = 0; i <= 2; i++) {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - i);
      const key = `waste_${d.getUTCFullYear()}_${d.getUTCMonth()}_${d.getUTCDate()}`;
      const val = await kv.get(key);
      days.push({ key, value: val, valueType: typeof val });
    }

    // Policz co cron.js policzyłby SAM teraz, dla porównania
    function isItalyDST(d) {
      const year = d.getUTCFullYear();
      function lastSunday(month) {
        const last = new Date(Date.UTC(year, month + 1, 0, 1, 0, 0));
        last.setUTCDate(last.getUTCDate() - last.getUTCDay());
        return last;
      }
      const dstStart = lastSunday(2);
      const dstEnd = lastSunday(9);
      return d.getTime() >= dstStart.getTime() && d.getTime() < dstEnd.getTime();
    }
    const italyOffset = isItalyDST(now) ? 2 : 1;
    const italyHour = (now.getUTCHours() + italyOffset) % 24;

    return res.status(200).json({
      serverNowUTC: now.toISOString(),
      vacModeRaw,
      vacModeType: typeof vacModeRaw,
      vacModeStrictEqual1: vacModeRaw === '1',
      computedItalyHour: italyHour,
      wasteKeysLastDays: days,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message, stack: e.stack });
  }
}
