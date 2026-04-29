(async () => {
  const url = 'https://calendar.google.com/calendar/ical/ko.south_korea%23holiday%40group.v.calendar.google.com/public/basic.ics';
  const ics = await fetch(url, { headers: { 'User-Agent': 'work-log-automation/1.0' } }).then(r => r.text());
  const blocks = ics.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || [];
  for (const b of blocks) {
    const d = (b.match(/DTSTART(?:;VALUE=DATE)?:?(\d{8})/) || [])[1] || '';
    if (!d.startsWith('202605')) continue;
    const summary = (b.match(/SUMMARY:(.*)/) || [])[1] || '';
    console.log('-----', d, summary, '-----');
    const lines = b.split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      if (/^(UID|DTSTART|DTEND|SUMMARY|DESCRIPTION|CATEGORIES|X-|TRANSP|CLASS|STATUS|SEQUENCE|LOCATION|URL)/.test(line)) {
        console.log(line);
      }
    }
  }
})();
