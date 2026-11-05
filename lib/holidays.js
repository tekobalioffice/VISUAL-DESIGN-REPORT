// Indonesian national holidays (incl. cuti bersama) from Google's public holiday calendar.
// Used by the local server and by the Vercel function api/holidays.js.
const https = require('https');
const crypto = require('crypto');

const ICS = 'https://calendar.google.com/calendar/ical/id.indonesian%23holiday%40group.v.calendar.google.com/public/basic.ics';
const md5 = s => crypto.createHash('md5').update(s).digest('hex');

function fetchText(url, hops = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && hops < 5) { r.resume(); return fetchText(r.headers.location, hops + 1).then(resolve, reject); }
      if (r.statusCode !== 200) { r.resume(); return reject(new Error('HTTP ' + r.statusCode)); }
      let d = ''; r.setEncoding('utf8'); r.on('data', c => d += c); r.on('end', () => resolve(d));
    }).on('error', reject).setTimeout(20000, function () { this.destroy(new Error('timeout')); });
  });
}

// -> { events:[{id,date,title}], years:[...], tasks:[{baseId,date,base,tentative,due,nice}] }
async function getHolidays() {
  const ics = (await fetchText(ICS)).replace(/\r?\n[ \t]/g, '');
  const events = [], years = new Set();
  for (const b of ics.split('BEGIN:VEVENT').slice(1)) {
    const d = b.match(/DTSTART;VALUE=DATE:(\d{4})(\d{2})(\d{2})/), t = (b.match(/SUMMARY:(.*)/) || [])[1];
    if (!d || !t || !/Hari libur nasional/.test(b)) continue;
    const title = t.trim().replace(/\\([,;\\])/g, '$1')
      .replace(/^Joint Holiday for Good Friday$/i, 'Cuti Bersama Wafat Isa Almasih').replace(/^Joint Holiday for /i, 'Cuti Bersama ');
    events.push({ id: `gh-${d[1]}${d[2]}${d[3]}-${md5(title).slice(0, 6)}`, date: `${d[1]}-${d[2]}-${d[3]}`, title });
    years.add(d[1]);
  }
  if (!events.length) throw new Error('kalender kosong');

  // one story task per upcoming holiday (not cuti bersama), deadline H-7
  const today = new Date().toISOString().slice(0, 10), first = {};
  for (const e of events) {
    if (e.date < today || /^cuti bersama/i.test(e.title)) continue;
    const base = e.title.replace(/\s*\(belum pasti\)\s*/i, '').trim(), key = e.date.slice(0, 4) + '|' + base;
    if (!first[key] || e.date < first[key].date) first[key] = { date: e.date, base, tentative: /belum pasti/i.test(e.title) };
  }
  const tasks = Object.entries(first).map(([key, h]) => {
    const due = new Date(h.date + 'T00:00:00Z'); due.setUTCDate(due.getUTCDate() - 7);
    return { ...h, baseId: `tk-hol-${h.date.slice(0, 4)}-${md5(key).slice(0, 8)}`, due: due.toISOString().slice(0, 10),
      nice: new Date(h.date + 'T00:00:00Z').toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) };
  });
  return { events, years: [...years], tasks };
}

// task document for a holiday (Instagram story only)
function storyTask(h) {
  return { kind: 'story', title: `Design story Instagram ${h.base}`, due: h.due, forMonth: h.date.slice(0, 7), holidayDate: h.date, need: 1,
    desc: `Hari libur nasional: ${h.base}, ${h.nice}${h.tentative ? ' (tanggal belum pasti)' : ''}.\nSiapkan design ucapan untuk story Instagram (1080 × 1920 px).`,
    files: [], status: 'open', auto: true, createdAt: Date.now() };
}

module.exports = { getHolidays, storyTask };
