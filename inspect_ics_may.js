(async () => {
  const url = 'https://calendar.google.com/calendar/ical/ko.south_korea%23holiday%40group.v.calendar.google.com/public/basic.ics';
  const text = await fetch(url, { headers: { 'User-Agent': 'work-log-automation/1.0' } }).then(r => r.text());

  const year = '2026';
  const month = '05';

  const blocks = text.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || [];
  const rows = [];

  for (const b of blocks) {
    const dt = (b.match(/DTSTART(?:;VALUE=DATE)?:?(\d{8})/) || [])[1] || '';
    if (!dt.startsWith(year) || dt.slice(4, 6) !== month) continue;

    const summaryRaw = (b.match(/SUMMARY:(.*)/) || [])[1] || '';
    const summary = summaryRaw.replace(/\\,/g, ',').replace(/\\n/g, ' ').trim();
    rows.push({ dt, summary });
  }

  rows.sort((a, b) => a.dt.localeCompare(b.dt));
  console.log(rows);
})();
